import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Update } from "grammy/types";
import { openDatabase } from "../src/db/database.js";
import { Service } from "../src/service.js";
import { createBot } from "../src/bot.js";
import * as t from "../src/db/schema.js";
import { reasons } from "../src/reasons.js";
import {
  createInvitation,
  acceptInvitation,
  invitationCandidate,
  confirmInvitation,
  resolvePerson,
  refreshPerson,
} from "../src/people.js";

let store: ReturnType<typeof openDatabase>,
  s: Service,
  bot: ReturnType<typeof createBot>;
let sequence = 1000;
let sent: { method: string; payload: Record<string, unknown> }[] = [];
const profiles = new Map<number, { name: string; username?: string }>();
const memberships = new Map<number, string>();
beforeEach(async () => {
  vi.useFakeTimers();
  store = openDatabase(":memory:");
  store.migrate();
  s = new Service(store, 1);
  s.touch(1, "Owner", "owner_name");
  s.touch(2, "Author", "author_name");
  s.touch(3, "Moderator", "moderator_name");
  store.db.insert(t.moderators).values({ id: 3 }).run();
  sent = [];
  profiles.clear();
  memberships.clear();
  bot = createBot(
    "123456:mock",
    "-100123",
    s,
    () => {},
    async (input, init) => {
      const method = String(input).split("/").at(-1) ?? "";
      const payload = z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(typeof init?.body === "string" ? init.body : "{}"));
      sent.push({ method, payload });
      const msg = {
        message_id: ++sequence,
        date: 1,
        chat: {
          id: payload.chat_id ?? 2,
          type: "private",
          first_name: "Author",
        },
        text: payload.text ?? "",
      };
      const profile = profiles.get(Number(payload.chat_id));
      if (method === "getChat" && !profile)
        return new Response(
          JSON.stringify({
            ok: false,
            error_code: 400,
            description: "Unavailable",
          }),
        );
      const memberId = Number(payload.user_id);
      if (method === "getChatMember" && memberships.get(memberId) === "error")
        return new Response(
          JSON.stringify({
            ok: false,
            error_code: 400,
            description: "Unavailable",
          }),
        );
      const memberProfile = profiles.get(memberId);
      const result =
        method === "getChatMember"
          ? {
              status: memberships.get(memberId) ?? "member",
              user: {
                id: memberId,
                is_bot: false,
                first_name: memberProfile?.name ?? "User",
                username: memberProfile?.username,
              },
            }
          : method === "getMe"
            ? { id: 100, is_bot: true, first_name: "Bot", username: "test_bot" }
            : method === "getChat"
              ? {
                  id: payload.chat_id,
                  type: "private",
                  first_name: profile?.name,
                  username: profile?.username,
                }
              : method === "answerCallbackQuery"
                ? true
                : method === "sendMediaGroup"
                  ? [msg, { ...msg, message_id: sequence + 1 }]
                  : msg;
      return new Response(JSON.stringify({ ok: true, result }));
    },
  );
  await bot.init();
  sent = [];
});
afterEach(() => {
  store.sqlite.close();
  vi.useRealTimers();
});
function message(text: string, id = 2): Update {
  return {
    update_id: ++sequence,
    message: {
      message_id: sequence,
      date: 1,
      chat: { id, type: "private", first_name: "User" },
      from: {
        id,
        is_bot: false,
        first_name: id === 1 ? "Owner" : id === 3 ? "Moderator" : "Author",
        username:
          id === 1 ? "owner_name" : id === 3 ? "moderator_name" : "author_name",
      },
      text,
    },
  };
}
function callback(data: string, id = 2): Update {
  return {
    update_id: ++sequence,
    callback_query: {
      id: String(sequence),
      from: {
        id,
        is_bot: false,
        first_name: id === 1 ? "Owner" : id === 3 ? "Moderator" : "Author",
      },
      chat_instance: "test",
      data,
      message: {
        message_id: sequence,
        date: 1,
        chat: { id, type: "private", first_name: "User" },
        text: "card",
      },
    },
  };
}
function photo(group?: string, caption?: string): Update {
  const u = message("", 2);
  if (u.message) {
    delete u.message.text;
    u.message.photo = [
      {
        file_id: "photo" + sequence,
        file_unique_id: "u" + sequence,
        width: 100,
        height: 100,
      },
    ];
    if (group) u.message.media_group_id = group;
    if (caption) u.message.caption = caption;
  }
  return u;
}
function lastText() {
  return sent.filter((x) => x.method === "sendMessage").at(-1)?.payload;
}
function json() {
  return JSON.stringify(sent);
}
function pending(author = 2) {
  const d = s.newDraft(author);
  s.edit(author, d.id, "Новость");
  vi.advanceTimersByTime(3000);
  s.submit(author, d.id, s.get(d.id).version);
  return s.get(d.id);
}

it("opens the composer without creating a draft until content arrives", async () => {
  s.newDraft(2); // A legacy empty draft remains in the database.
  await bot.handleUpdate(message("📝 Предложить пост"));
  await bot.handleUpdate(message("📝 Предложить пост"));
  expect(store.db.select().from(t.submissions).all()).toHaveLength(1);
  expect(s.list(2, 0, true)).toEqual([]);
  expect(JSON.stringify(lastText()?.reply_markup)).not.toContain("view:");
  expect(json()).not.toContain("clear:");
  await bot.handleUpdate(message("Пост"));
  expect(s.list(2, 0, true)).toHaveLength(1);
  expect(JSON.stringify(lastText()?.reply_markup)).toContain("view:");
});
it("keeps two independent drafts and resumes only the chosen one", async () => {
  await bot.handleUpdate(message("📝 Предложить пост"));
  await bot.handleUpdate(message("Первый"));
  const first = s.draft(2);
  await bot.handleUpdate(message("Второй"));
  const second = s.draft(2);
  expect(second.id).not.toBe(first.id);
  expect(s.get(first.id).body).toBe("Первый");
  await bot.handleUpdate(callback(`resume:${first.id}`));
  await bot.handleUpdate(photo());
  expect(s.files(first.id)).toHaveLength(1);
  expect(s.files(second.id)).toHaveLength(0);
  await bot.handleUpdate(callback(`edit:${first.id}`));
  await bot.handleUpdate(message("Исправленный"));
  expect(s.get(first.id).body).toBe("Исправленный");
  expect(s.get(second.id).body).toBe("Второй");
});
it("does not overwrite text when adding media with a conflicting caption", async () => {
  const d = s.newDraft(2);
  s.edit(2, d.id, "Исходный");
  await bot.handleUpdate(callback(`resume:${d.id}`));
  await bot.handleUpdate(photo(undefined, "Новый"));
  expect(s.get(d.id).body).toBe("Исходный");
  expect(s.files(d.id)).toHaveLength(0);
  expect(lastText()?.text).toContain("Редактировать текст");
});
it("routes delayed album parts to their draft without changing another active draft", async () => {
  await bot.handleUpdate(photo("album"));
  const first = s.draft(2);
  await bot.handleUpdate(message("📝 Предложить пост"));
  await bot.handleUpdate(message("Другой пост"));
  const second = s.draft(2);
  await bot.handleUpdate(photo("album"));
  expect(s.files(first.id)).toHaveLength(2);
  expect(s.files(second.id)).toHaveLength(0);
  expect(s.state(2)).toBe(`saved:${second.id}`);
  expect(s.get(second.id).body).toBe("Другой пост");
});
it("does not create a new draft for repeated delivery after switching editors", async () => {
  const update = photo("album");
  await bot.handleUpdate(update);
  await bot.handleUpdate(message("📝 Предложить пост"));
  const before = store.db.select().from(t.submissions).all().length;
  await bot.handleUpdate(update);
  expect(store.db.select().from(t.submissions).all()).toHaveLength(before);
});
it("paginates exactly ten entries and uses author-local numbers with dates", async () => {
  s.newDraft(3);
  for (let i = 0; i < 11; i++) {
    const d = s.newDraft(2);
    s.edit(2, d.id, "Текст " + i);
    store.db
      .update(t.submissions)
      .set({ status: "rejected" })
      .where(eq(t.submissions.id, d.id))
      .run();
  }
  await bot.handleUpdate(callback("minepage:0"));
  const markup = z
    .object({
      inline_keyboard: z.array(
        z.array(z.object({ text: z.string(), callback_data: z.string() })),
      ),
    })
    .parse(lastText()?.reply_markup);
  const items = markup.inline_keyboard
    .flat()
    .filter((b) => b.callback_data.startsWith("view:"));
  expect(items).toHaveLength(10);
  expect(items[0]?.text).toContain("№11");
  expect(items[0]?.text).toMatch(/\d{2}\.\d{2}\.\d{2}/);
  expect(JSON.stringify(markup)).toContain("minepage:10");
  await bot.handleUpdate(callback("minepage:10"));
  expect(JSON.stringify(lastText()?.reply_markup)).not.toContain("minepage:20");
});
it("shows author to moderator for an anonymous post and hides anonymity controls there", async () => {
  const d = pending();
  s.anonymous(2, d.id);
  await bot.handleUpdate(callback(`moderate:${d.id}`, 3));
  expect(lastText()?.text).toContain("tg://user?id=2");
  expect(lastText()?.text).toContain("Анонимная публикация ✓");
  expect(JSON.stringify(lastText()?.reply_markup)).not.toContain("anon:");
  await bot.handleUpdate(callback(`anon:${d.id}`, 3));
  expect(s.get(d.id).anonymous).toBe(true);
});
it("labels anonymity as an action for the author only", async () => {
  const d = s.newDraft(2);
  s.edit(2, d.id, "Пост");
  await bot.handleUpdate(callback(`view:${d.id}`));
  expect(json()).toContain("Сделать анонимным");
  await bot.handleUpdate(callback(`anon:${d.id}`));
  expect(JSON.stringify(lastText()?.reply_markup)).toContain(
    "Показать моё имя",
  );
});
it("sends rejection notification immediately with personal number and a button", async () => {
  s.newDraft(3);
  const d = pending();
  sent = [];
  await bot.handleUpdate(callback(`reason:${d.id}:${d.version}:0`, 3));
  const notification = sent.find(
    (x) =>
      x.method === "sendMessage" &&
      x.payload.chat_id === 2 &&
      String(x.payload.text).includes("отклонена"),
  );
  expect(notification?.payload.text).toContain("№1");
  expect(JSON.stringify(notification?.payload.reply_markup)).toContain(
    `view:${d.id}`,
  );
  expect(
    store.db
      .select()
      .from(t.notifications)
      .all()
      .every((n) => n.status === "sent"),
  ).toBe(true);
});
it("sends publication notification immediately without advancing the fallback timer", async () => {
  const d = pending();
  sent = [];
  await bot.handleUpdate(callback(`approve:${d.id}:${d.version}`, 3));
  expect(s.get(d.id).delivery).toBe("published");
  expect(
    sent.some(
      (x) =>
        x.payload.chat_id === 2 &&
        String(x.payload.text).includes("Ваш пост опубликован"),
    ),
  ).toBe(true);
});
it("uses Russian labels for settings, statistics and history without slash prompts", async () => {
  pending();
  await bot.handleUpdate(message("⚙️ Настройки", 1));
  expect(json()).toContain("Причины отклонения");
  await bot.handleUpdate(callback("templates", 1));
  expect(json()).toContain("Приветствие");
  expect(String(lastText()?.text)).not.toContain("причину отклонения");
  await bot.handleUpdate(message("📊 Статистика", 1));
  expect(String(lastText()?.text)).not.toContain("pending");
  await bot.handleUpdate(message("📚 История", 1));
  expect(String(lastText()?.text)).toContain("Отправлена на модерацию");
  await bot.handleUpdate(message("ℹ️ Помощь"));
  expect(String(lastText()?.text)).not.toMatch(/\/(start|done|cancel|queue)/);
});
it("requires owner confirmation after a one-use invitation and keeps ID-based role", () => {
  const token = createInvitation(s, 1);
  acceptInvitation(s, 2, token);
  expect(s.isMod(2)).toBe(false);
  const row = store.db.select().from(t.invitations).get();
  if (!row) throw new Error("Missing invitation");
  expect(() => invitationCandidate(s, 3, row.hash)).toThrow();
  confirmInvitation(s, 1, row.hash, true);
  expect(s.isMod(2)).toBe(true);
  s.touch(2, "Changed", "new_handle");
  expect(s.isMod(2)).toBe(true);
  expect(() => acceptInvitation(s, 3, token)).toThrow();
  expect(() => confirmInvitation(s, 1, row.hash, true)).toThrow();
});
it("expires invitations and prevents non-owner creation", () => {
  expect(() => createInvitation(s, 2)).toThrow();
  const token = createInvitation(s, 1);
  vi.advanceTimersByTime(86400001);
  expect(() => acceptInvitation(s, 2, token)).toThrow();
});
it("refreshes username via stable ID and rejects a stale username lookup", async () => {
  profiles.set(2, { name: "New Name", username: "new_handle" });
  await expect(resolvePerson(s, bot.api, "@author_name")).rejects.toThrow(
    "приглашение",
  );
  expect(s.user(2).username).toBe("new_handle");
  await expect(
    resolvePerson(s, bot.api, "https://t.me/new_handle"),
  ).resolves.toBe(2);
  profiles.set(2, { name: "No Username" });
  await refreshPerson(s, bot.api, 2);
  expect(s.user(2).username).toBe(null);
});
it("renders moderator profiles as escaped links, not bare IDs", async () => {
  profiles.set(3, { name: "<Mod>", username: "updated_mod" });
  s.touch(4, "Head");
  store.db.insert(t.moderators).values({ id: 4, role: "head" }).run();
  await bot.handleUpdate(message("👥 Модераторы", 1));
  const team = String(lastText()?.text);
  expect(team.indexOf("Владелец")).toBeLessThan(
    team.indexOf("Главные модераторы"),
  );
  expect(team.indexOf("Главные модераторы")).toBeLessThan(
    team.indexOf("🛡 Модераторы"),
  );
  expect(team.indexOf("tg://user?id=4")).toBeLessThan(
    team.indexOf("tg://user?id=3"),
  );
  expect(lastText()?.text).toContain("tg://user?id=3");
  expect(lastText()?.text).toContain("&lt;Mod&gt;");
  expect(lastText()?.text).toContain("@updated_mod");
  expect(lastText()?.text).not.toContain("/start");
});
it("preserves all drafts when the draft limit is reached", () => {
  for (let i = 0; i < 20; i++) s.edit(2, s.newDraft(2).id, "Текст");
  expect(() => s.newDraft(2)).toThrow("20 черновиков");
  expect(store.db.select().from(t.submissions).all()).toHaveLength(20);
});
it("returns from statistics to management and from a card to the original history page", async () => {
  const post = pending();
  for (let i = 0; i < 11; i++) s.audit(1, post.id, "approve");
  await bot.handleUpdate(callback("statistics", 1));
  expect(JSON.stringify(lastText()?.reply_markup)).toContain(
    '"callback_data":"manage"',
  );
  await bot.handleUpdate(callback("manage", 1));
  expect(lastText()?.text).toBe("🛠 Управление");
  await bot.handleUpdate(callback("history:10", 1));
  expect(JSON.stringify(lastText()?.reply_markup)).toContain(
    `moderate:${post.id}:h10`,
  );
  await bot.handleUpdate(callback(`moderate:${post.id}:h10`, 1));
  expect(JSON.stringify(lastText()?.reply_markup)).toContain(
    '"callback_data":"history:10"',
  );
});
it("blocks non-subscribers and rechecks before accepting a submission", async () => {
  memberships.set(2, "left");
  await bot.handleUpdate(message("📝 Предложить пост"));
  expect(store.db.select().from(t.submissions).all()).toHaveLength(0);
  expect(lastText()?.text).toContain("подписчикам");
  memberships.set(2, "member");
  await bot.handleUpdate(callback("joincheck"));
  await bot.handleUpdate(message("Пост"));
  const d = s.draft(2);
  vi.advanceTimersByTime(3000);
  memberships.set(2, "left");
  await bot.handleUpdate(callback(`submit:${d.id}:${d.version}`));
  expect(s.get(d.id).status).toBe("draft");
  memberships.set(2, "member");
  await bot.handleUpdate(callback(`submit:${d.id}:${d.version}`));
  expect(s.get(d.id).status).toBe("pending");
});
it("clears only the requesting user drafts after confirmation", async () => {
  const waiting = pending(2);
  const draft = s.newDraft(2),
    other = s.newDraft(3);
  await bot.handleUpdate(callback("confirmcleardrafts"));
  expect(s.get(draft.id).status).toBe("draft");
  await bot.handleUpdate(callback("cleardrafts"));
  await bot.handleUpdate(callback("confirmcleardrafts"));
  expect(s.get(draft.id).status).toBe("cancelled");
  expect(s.get(waiting.id).status).toBe("pending");
  expect(s.get(other.id).status).toBe("draft");
});
it("adds, edits and deletes a custom reason and safely resets settings", async () => {
  const post = pending();
  await bot.handleUpdate(callback("addreason", 1));
  await bot.handleUpdate(message("Новая причина", 1));
  const custom = reasons(s).find((r) => r.text === "Новая причина");
  if (!custom) throw new Error("Missing custom reason");
  await bot.handleUpdate(callback(`template:${custom.key}`, 1));
  await bot.handleUpdate(message("Изменённая причина", 1));
  expect(reasons(s).find((r) => r.key === custom.key)?.text).toBe(
    "Изменённая причина",
  );
  await bot.handleUpdate(callback(`reject:${post.id}:${post.version}`, 3));
  expect(JSON.stringify(lastText()?.reply_markup)).toContain(
    "Изменённая причина",
  );
  await bot.handleUpdate(callback(`deletereason:${custom.key}`, 1));
  await bot.handleUpdate(callback(`confirmdeletereason:${custom.key}`, 1));
  expect(reasons(s).some((r) => r.key === custom.key)).toBe(false);
  await bot.handleUpdate(
    callback(`reason:${post.id}:${post.version}:${custom.key.slice(6)}`, 3),
  );
  expect(s.get(post.id).status).toBe("pending");
  s.set("limit", "77");
  await bot.handleUpdate(callback("confirmresetsettings", 1));
  expect(s.setting("limit", "10")).toBe("77");
  await bot.handleUpdate(callback("resetsettings", 1));
  await bot.handleUpdate(callback("confirmresetsettings", 1));
  expect(s.setting("limit", "10")).toBe("10");
  expect(reasons(s)).toHaveLength(4);
  expect(s.get(post.id).status).toBe("pending");
  expect(s.isMod(3)).toBe(true);
});
it("uses a compact nonpersistent keyboard with explicit hide and restore actions", async () => {
  await bot.handleUpdate(callback("home", 1));
  const keyboard = z
    .object({
      keyboard: z.array(z.array(z.unknown())),
      is_persistent: z.boolean().optional(),
    })
    .parse(lastText()?.reply_markup);
  expect(keyboard.keyboard.length).toBeLessThanOrEqual(3);
  expect(keyboard.is_persistent).not.toBe(true);
  expect(JSON.stringify(keyboard)).toContain("Управление");
  await bot.handleUpdate(message("⌨️ Скрыть меню", 1));
  expect(
    sent.some((x) =>
      (JSON.stringify(x.payload.reply_markup) ?? "").includes(
        "remove_keyboard",
      ),
    ),
  ).toBe(true);
  expect(JSON.stringify(lastText()?.reply_markup)).toContain("Показать меню");
});
it("can select a previously unknown channel member with Telegram user picker", async () => {
  profiles.set(4, { name: "Chosen Member", username: "chosen_member" });
  await bot.handleUpdate(callback("pickmoderator", 1));
  const update = message("", 1);
  if (update.message) {
    delete update.message.text;
    update.message.users_shared = {
      request_id: 703,
      users: [
        { user_id: 4, first_name: "Chosen Member", username: "chosen_member" },
      ],
    };
  }
  await bot.handleUpdate(update);
  expect(s.isMod(4)).toBe(false);
  expect(lastText()?.text).toContain("Chosen Member");
  await bot.handleUpdate(callback("grant:4", 1));
  expect(s.isMod(4)).toBe(true);
});
it("keeps setting button captions short", async () => {
  await bot.handleUpdate(message("⚙️ Настройки", 1));
  const markup = z
    .object({
      inline_keyboard: z.array(z.array(z.object({ text: z.string() }))),
    })
    .parse(lastText()?.reply_markup);
  expect(markup.inline_keyboard.flat().every((b) => b.text.length <= 30)).toBe(
    true,
  );
});
it("does not accept new posts when subscription verification fails", async () => {
  memberships.set(2, "error");
  await bot.handleUpdate(message("Текст поста"));
  expect(store.db.select().from(t.submissions).all()).toHaveLength(0);
  expect(lastText()?.text).toContain("Не удалось проверить подписку");
});
it("creates an invitation and completes the real button flow without granting rights on open", async () => {
  await bot.handleUpdate(callback("invite", 1));
  const token = /start=mod_([\w-]+)/.exec(String(lastText()?.text))?.[1];
  if (!token) throw new Error("Missing invite link");
  const update = message("/start mod_" + token, 2);
  if (update.message)
    update.message.entities = [{ type: "bot_command", offset: 0, length: 6 }];
  await bot.handleUpdate(update);
  expect(s.isMod(2)).toBe(false);
  const row = store.db.select().from(t.invitations).get();
  if (!row) throw new Error("Missing invitation row");
  expect(
    sent.some((x) =>
      JSON.stringify(x.payload.reply_markup)?.includes(`candidate:${row.hash}`),
    ),
  ).toBe(true);
  await bot.handleUpdate(callback(`candidate:${row.hash}`, 1));
  await bot.handleUpdate(callback(`grantinvite:${row.hash}`, 1));
  expect(s.isMod(2)).toBe(true);
  expect(row.status).toBe("pending");
});
it("does not show discarded unsent drafts among submitted requests", () => {
  const d = s.newDraft(2);
  s.cancel(2, d.id);
  expect(s.list(2)).toEqual([]);
  expect(s.list(2, 0, true)).toEqual([]);
  expect(s.get(d.id).status).toBe("cancelled");
});
it("does not let a delayed album part interrupt an open text editor", async () => {
  await bot.handleUpdate(photo("late"));
  const original = s.draft(2);
  const other = s.newDraft(2);
  s.edit(2, other.id, "Другой текст");
  await bot.handleUpdate(callback(`edit:${other.id}`));
  await bot.handleUpdate(photo("late"));
  expect(s.files(original.id)).toHaveLength(2);
  expect(s.state(2)).toBe(`edit:${other.id}::`);
  await bot.handleUpdate(message("Исправлено"));
  expect(s.get(other.id).body).toBe("Исправлено");
});
it("routes a known username through owner confirmation before granting the role", async () => {
  s.touch(4, "Candidate", "candidate_name");
  profiles.set(4, { name: "Candidate", username: "candidate_name" });
  await bot.handleUpdate(callback("mod:add", 1));
  await bot.handleUpdate(message("@candidate_name", 1));
  expect(s.isMod(4)).toBe(false);
  expect(lastText()?.text).toContain("Назначить модератором");
  await bot.handleUpdate(callback("grant:4", 2));
  expect(s.isMod(4)).toBe(false);
  await bot.handleUpdate(callback("grant:4", 1));
  expect(s.isMod(4)).toBe(true);
});
it("lets an author turn anonymity off even after the owner disabled anonymous posts", async () => {
  const d = s.newDraft(2);
  s.anonymous(2, d.id);
  s.set("anonymous", "false");
  await bot.handleUpdate(callback(`anon:${d.id}`));
  expect(s.get(d.id).anonymous).toBe(false);
  await bot.handleUpdate(callback(`anon:${d.id}`));
  expect(s.get(d.id).anonymous).toBe(false);
});
