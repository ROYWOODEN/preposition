import { createHash, randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Api } from "grammy";
import type { Service } from "./service.js";
import * as t from "./db/schema.js";
import { UserError } from "./errors.js";
import { enqueue } from "./notifications.js";

export function html(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
export function person(user: {
  id: number;
  name: string;
  username: string | null;
}) {
  return `<a href="tg://user?id=${user.id}">${html(user.name)}</a>${user.username ? ` · <a href="tg://user?id=${user.id}">@${html(user.username)}</a>` : ""}`;
}
export async function refreshPerson(
  s: Service,
  api: Api,
  id: number,
  channel?: string,
) {
  try {
    const chat = await api.getChat(id);
    if (chat.type !== "private" || chat.id !== id) return false;
    s.touch(
      id,
      [chat.first_name, chat.last_name].filter(Boolean).join(" "),
      chat.username,
    );
    return true;
  } catch {
    /* A channel member may be visible even when the private chat is unavailable. */
  }
  if (channel) {
    try {
      const member = await api.getChatMember(channel, id);
      if (member.user.id !== id) return false;
      s.touch(
        id,
        [member.user.first_name, member.user.last_name]
          .filter(Boolean)
          .join(" "),
        member.user.username,
      );
      return true;
    } catch {
      /* Keep the last known profile. */
    }
  }
  return false;
}
export async function resolvePerson(
  s: Service,
  api: Api,
  input: string,
  channel?: string,
) {
  const value = input.trim();
  if (/^\d+$/.test(value)) {
    const id = Number(value);
    if (!Number.isSafeInteger(id))
      throw new UserError("Не удалось определить пользователя.");
    s.user(id);
    return id;
  }
  const match = /^(?:@|(?:https?:\/\/)?t\.me\/)([a-zA-Z0-9_]{5,32})\/?$/.exec(
    value,
  );
  if (!match?.[1])
    throw new UserError(
      "Пришлите @username или ссылку t.me/username. Или используйте приглашение.",
    );
  const username = match[1].toLowerCase();
  const candidates = s.store.db
    .select()
    .from(t.users)
    .where(sql`lower(${t.users.username}) = ${username}`)
    .all();
  for (const candidate of candidates) {
    const fresh = await refreshPerson(s, api, candidate.id, channel);
    if (fresh && s.user(candidate.id).username?.toLowerCase() === username)
      return candidate.id;
  }
  throw new UserError(
    "Telegram не даёт боту найти участника канала по одному @username или ссылке. Нажмите «Выбрать в Telegram» — Telegram передаст его ID под капотом — либо используйте приглашение.",
  );
}
export function grantModerator(s: Service, actor: number, id: number) {
  s.admin(actor);
  s.user(id);
  if (id === s.owner) throw new UserError("У владельца уже есть все права.");
  s.store.db.insert(t.moderators).values({ id }).onConflictDoNothing().run();
  s.audit(actor, null, `mod:add:${id}`);
}
export function removeModerator(s: Service, actor: number, id: number) {
  s.admin(actor);
  if (id === s.owner) throw new UserError("Права владельца неизменяемы.");
  s.store.db.delete(t.moderators).where(eq(t.moderators.id, id)).run();
  s.audit(actor, null, `mod:remove:${id}`);
}
function digest(token: string) {
  return createHash("sha256").update(token).digest("hex").slice(0, 32);
}
export function createInvitation(s: Service, actor: number) {
  s.admin(actor);
  const token = randomBytes(24).toString("base64url");
  s.store.db
    .insert(t.invitations)
    .values({ hash: digest(token), expiresAt: Date.now() + 86400000 })
    .run();
  return token;
}
export function acceptInvitation(s: Service, actor: number, token: string) {
  s.access(actor);
  const hash = digest(token);
  s.store.sqlite.transaction(() => {
    const row = s.store.db
      .select()
      .from(t.invitations)
      .where(eq(t.invitations.hash, hash))
      .get();
    if (!row || row.expiresAt < Date.now() || row.status !== "open")
      throw new UserError(
        "Приглашение уже использовано или истекло. Попросите владельца прислать новое.",
      );
    s.store.db
      .update(t.invitations)
      .set({ candidateId: actor, status: "pending" })
      .where(eq(t.invitations.hash, hash))
      .run();
    enqueue(
      s.store,
      s.owner,
      `👋 ${s.user(actor).name} открыл приглашение в модераторы.\nПроверьте профиль и подтвердите назначение.`,
      { text: "👤 Проверить кандидата", callback: `candidate:${hash}` },
    );
  })();
}
export function invitationCandidate(s: Service, actor: number, hash: string) {
  s.admin(actor);
  const row = s.store.db
    .select()
    .from(t.invitations)
    .where(eq(t.invitations.hash, hash))
    .get();
  if (
    !row ||
    row.status !== "pending" ||
    !row.candidateId ||
    row.expiresAt < Date.now()
  )
    throw new UserError("Это приглашение уже обработано или истекло.");
  return row.candidateId;
}
export function confirmInvitation(
  s: Service,
  actor: number,
  hash: string,
  approve: boolean,
) {
  s.store.sqlite.transaction(() => {
    const candidate = invitationCandidate(s, actor, hash);
    if (approve) grantModerator(s, actor, candidate);
    s.store.db
      .update(t.invitations)
      .set({ status: approve ? "approved" : "rejected" })
      .where(
        and(eq(t.invitations.hash, hash), eq(t.invitations.status, "pending")),
      )
      .run();
    enqueue(
      s.store,
      candidate,
      approve
        ? "🛡 Вы назначены модератором. Добро пожаловать в команду!"
        : "Назначение модератором не подтверждено.",
      { text: "🏠 Главное меню", callback: "home" },
    );
  })();
}
