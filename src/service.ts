import { UserError } from "./errors.js";
import { and, eq, desc, sql } from "drizzle-orm";
import type { Store } from "./db/database.js";
import * as t from "./db/schema.js";
import { compose } from "./content.js";
import { template } from "./templates.js";
import { enqueue } from "./notifications.js";
export class Service {
  constructor(
    readonly store: Store,
    readonly owner: number,
  ) {}
  user(id: number) {
    const u = this.store.db
      .select()
      .from(t.users)
      .where(eq(t.users.id, id))
      .get();
    if (!u)
      throw new UserError(
        "Пользователь пока не знаком боту. Пригласите его по ссылке.",
      );
    return u;
  }
  touch(id: number, name: string, username?: string) {
    const now = Date.now();
    this.store.db
      .insert(t.users)
      .values({
        id,
        name,
        username: username ?? null,
        createdAt: now,
        activeAt: now,
      })
      .onConflictDoUpdate({
        target: t.users.id,
        set: { name, username: username ?? null, activeAt: now },
      })
      .run();
  }
  isMod(id: number) {
    return (
      id === this.owner ||
      !!this.store.db
        .select()
        .from(t.moderators)
        .where(eq(t.moderators.id, id))
        .get()
    );
  }
  access(id: number) {
    if (this.user(id).blocked) throw new UserError("Доступ заблокирован.");
  }
  mod(id: number) {
    this.access(id);
    if (!this.isMod(id)) throw new UserError("Нет прав модератора.");
  }
  admin(id: number) {
    if (id !== this.owner) throw new UserError("Только владелец.");
  }
  get(id: number) {
    const s = this.store.db
      .select()
      .from(t.submissions)
      .where(eq(t.submissions.id, id))
      .get();
    if (!s) throw new UserError("Заявка не найдена.");
    return s;
  }
  setting(key: string, fallback: string) {
    return (
      this.store.db
        .select()
        .from(t.settings)
        .where(eq(t.settings.key, key))
        .get()?.value ?? fallback
    );
  }
  set(key: string, value: string) {
    this.store.db
      .insert(t.settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: t.settings.key, set: { value } })
      .run();
  }
  state(userId: number, value?: string) {
    if (value !== undefined)
      this.store.db
        .insert(t.states)
        .values({ userId, value })
        .onConflictDoUpdate({ target: t.states.userId, set: { value } })
        .run();
    return (
      this.store.db
        .select()
        .from(t.states)
        .where(eq(t.states.userId, userId))
        .get()?.value ?? ""
    );
  }
  audit(actorId: number, submissionId: number | null, action: string) {
    this.store.db
      .insert(t.history)
      .values({ actorId, submissionId, action, at: Date.now() })
      .run();
  }
  list(authorId?: number, offset = 0, draftsOnly = false) {
    return this.store.db
      .select()
      .from(t.submissions)
      .where(
        authorId
          ? and(
              eq(t.submissions.authorId, authorId),
              draftsOnly
                ? eq(t.submissions.status, "draft")
                : sql`${t.submissions.status} <> 'draft' AND (${t.submissions.status} <> 'cancelled' OR ${t.submissions.submittedAt} IS NOT NULL)`,
            )
          : eq(t.submissions.status, "pending"),
      )
      .orderBy(desc(t.submissions.id))
      .limit(11)
      .offset(offset)
      .all();
  }
  files(id: number) {
    return this.store.db
      .select()
      .from(t.media)
      .where(eq(t.media.submissionId, id))
      .orderBy(t.media.messageId)
      .all();
  }
  draft(userId: number) {
    this.access(userId);
    const [kind, id] = this.state(userId).split(":");
    if ((kind === "draft" || kind === "saved") && id) {
      const old = this.get(Number(id));
      if (old.authorId === userId && old.status === "draft") return old;
    }
    return this.newDraft(userId);
  }
  newDraft(userId: number) {
    this.access(userId);
    const count =
      this.store.db
        .select({ total: sql<number>`count(*)` })
        .from(t.submissions)
        .where(
          and(
            eq(t.submissions.authorId, userId),
            eq(t.submissions.status, "draft"),
          ),
        )
        .get()?.total ?? 0;
    if (count >= 20)
      throw new UserError(
        "У вас уже 20 черновиков. Завершите или удалите ненужные в разделе «Черновики».",
      );
    const now = Date.now();
    const draft = this.store.db
      .insert(t.submissions)
      .values({ authorId: userId, createdAt: now, updatedAt: now })
      .returning()
      .get();
    this.state(userId, `draft:${draft.id}`);
    return draft;
  }
  localNumber(id: number) {
    const sub = this.get(id);
    return (
      this.store.db
        .select({ total: sql<number>`count(*)` })
        .from(t.submissions)
        .where(
          and(
            eq(t.submissions.authorId, sub.authorId),
            sql`${t.submissions.id} <= ${id}`,
          ),
        )
        .get()?.total ?? 1
    );
  }
  resume(actor: number, id: number) {
    const sub = this.editable(actor, id);
    if (sub.authorId !== actor || sub.status !== "draft")
      throw new UserError("Это не ваш черновик.");
    this.state(actor, `draft:${id}`);
    return sub;
  }
  albumDraft(actor: number, groupId: string) {
    return this.store.db
      .select({ id: t.submissions.id })
      .from(t.media)
      .innerJoin(t.submissions, eq(t.media.submissionId, t.submissions.id))
      .where(
        and(eq(t.submissions.authorId, actor), eq(t.media.groupId, groupId)),
      )
      .get()?.id;
  }
  editable(actor: number, id: number) {
    this.access(actor);
    const s = this.get(id);
    if (s.status !== "draft" && s.status !== "pending")
      throw new UserError("Заявка уже обработана.");
    if (s.authorId !== actor) {
      this.mod(actor);
      if (this.setting("editing", "true") !== "true")
        throw new UserError("Редактирование модераторами выключено.");
    }
    return s;
  }
  edit(actor: number, id: number, body: string, entities = "[]") {
    this.editable(actor, id);
    this.store.db
      .update(t.submissions)
      .set({
        body,
        entities,
        version: sql`${t.submissions.version}+1`,
        updatedAt: Date.now(),
      })
      .where(eq(t.submissions.id, id))
      .run();
    this.audit(actor, id, "edit");
  }
  anonymous(actor: number, id: number) {
    const s = this.editable(actor, id);
    if (s.authorId !== actor) throw new UserError("Только автор.");
    if (!s.anonymous && this.setting("anonymous", "true") !== "true")
      throw new UserError("Анонимность выключена.");
    this.store.db
      .update(t.submissions)
      .set({ anonymous: !s.anonymous, version: s.version + 1 })
      .where(eq(t.submissions.id, id))
      .run();
  }
  addMedia(
    actor: number,
    id: number,
    file: Omit<typeof t.media.$inferInsert, "id" | "submissionId">,
  ) {
    const s = this.editable(actor, id);
    if (s.authorId !== actor || s.status !== "draft")
      throw new UserError("Медиа можно добавлять только в свой черновик.");
    const files = this.files(id);
    if (files.some((f) => f.messageId === file.messageId)) return;
    if (files.length >= 10) throw new UserError("Не больше 10 вложений.");
    if (
      files.length &&
      (!["photo", "video"].includes(file.kind) ||
        files.some((f) => !["photo", "video"].includes(f.kind)))
    )
      throw new UserError(
        "Несколько вложений поддерживаются для фото и видео. Другие форматы отправьте отдельной заявкой.",
      );
    this.store.db
      .insert(t.media)
      .values({ ...file, submissionId: id })
      .run();
    this.store.db
      .update(t.submissions)
      .set({ updatedAt: Date.now(), version: sql`${t.submissions.version}+1` })
      .where(eq(t.submissions.id, id))
      .run();
  }
  content(id: number) {
    const s = this.get(id);
    const files = this.files(id);
    if (!s.body && !files.length)
      throw new UserError("Добавьте текст или медиа.");
    return {
      ...compose(
        s.body,
        s.entities,
        this.user(s.authorId),
        s.anonymous,
        files.length > 0,
      ),
      files,
    };
  }
  submit(actor: number, id: number, version: number) {
    this.store.sqlite.transaction(() => {
      const s = this.editable(actor, id);
      if (s.authorId !== actor || s.status !== "draft")
        throw new UserError("Недоступно.");
      if (s.version !== version)
        throw new UserError("Содержимое изменилось. Повторите предпросмотр.");
      if (Date.now() - s.updatedAt < 2000)
        throw new UserError("Подождите пару секунд, пока придут все вложения.");
      if (this.setting("accepting", "true") !== "true")
        throw new UserError(template(this.store, "closed"));
      if (s.anonymous && this.setting("anonymous", "true") !== "true")
        throw new UserError("Анонимность выключена. Выберите подпись автора.");
      const active =
        this.store.db
          .select({ total: sql<number>`count(*)` })
          .from(t.submissions)
          .where(
            and(
              eq(t.submissions.authorId, actor),
              eq(t.submissions.status, "pending"),
            ),
          )
          .get()?.total ?? 0;
      if (active >= Number(this.setting("limit", "10")))
        throw new UserError("Достигнут лимит ожидающих заявок.");
      const recent = this.store.db
        .select()
        .from(t.submissions)
        .where(eq(t.submissions.authorId, actor))
        .orderBy(desc(t.submissions.submittedAt))
        .get();
      if (recent?.submittedAt && Date.now() - recent.submittedAt < 60000)
        throw new UserError("Между отправками должно пройти 60 секунд.");
      this.content(id);
      this.store.db
        .update(t.submissions)
        .set({
          status: "pending",
          submittedAt: Date.now(),
          version: s.version + 1,
        })
        .where(eq(t.submissions.id, id))
        .run();
      this.audit(actor, id, "submit");
      for (const moderator of new Set([
        this.owner,
        ...this.store.db
          .select()
          .from(t.moderators)
          .all()
          .map((m) => m.id),
      ]))
        enqueue(
          this.store,
          moderator,
          `📬 Новая заявка №${id}\nОткройте пост, чтобы принять решение.`,
          { text: "🛡 Открыть заявку", callback: `moderate:${id}` },
        );
    })();
  }
  cancel(actor: number, id: number) {
    const s = this.editable(actor, id);
    if (s.authorId !== actor) throw new UserError("Только автор.");
    this.store.db
      .update(t.submissions)
      .set({ status: "cancelled", version: s.version + 1 })
      .where(eq(t.submissions.id, id))
      .run();
    this.audit(actor, id, "cancel");
  }
  clearDrafts(actor: number) {
    this.access(actor);
    return this.store.sqlite.transaction(() => {
      const drafts = this.store.db
        .select()
        .from(t.submissions)
        .where(
          and(
            eq(t.submissions.authorId, actor),
            eq(t.submissions.status, "draft"),
          ),
        )
        .all();
      for (const draft of drafts) this.cancel(actor, draft.id);
      this.state(actor, "");
      return drafts.length;
    })();
  }
  reject(actor: number, id: number, version: number, reason: string) {
    this.store.sqlite.transaction(() => {
      this.mod(actor);
      if (!reason.trim() || reason.length > 500)
        throw new UserError("Причина: от 1 до 500 символов.");
      const result = this.store.db
        .update(t.submissions)
        .set({
          status: "rejected",
          reason,
          moderatorId: actor,
          version: version + 1,
        })
        .where(
          and(
            eq(t.submissions.id, id),
            eq(t.submissions.status, "pending"),
            eq(t.submissions.version, version),
          ),
        )
        .run();
      if (!result.changes)
        throw new UserError("Заявка изменилась. Откройте её заново.");
      this.audit(actor, id, "reject: " + reason);
      enqueue(
        this.store,
        this.get(id).authorId,
        template(this.store, "rejected", {
          submission_id: String(this.localNumber(id)),
          reason,
        }),
        { text: "📋 Открыть мою заявку", callback: `view:${id}` },
      );
    })();
  }
  claim(actor: number, id: number, version: number) {
    this.mod(actor);
    return this.store.sqlite.transaction(() => {
      this.content(id);
      const result = this.store.db
        .update(t.submissions)
        .set({
          status: "approved",
          delivery: "publishing",
          moderatorId: actor,
          version: version + 1,
        })
        .where(
          and(
            eq(t.submissions.id, id),
            eq(t.submissions.status, "pending"),
            eq(t.submissions.version, version),
          ),
        )
        .run();
      if (!result.changes)
        throw new UserError("Заявка уже обработана или изменена.");
      this.audit(actor, id, "approve");
      return this.store.db
        .insert(t.attempts)
        .values({
          submissionId: id,
          startedAt: Date.now(),
          result: "publishing",
        })
        .returning()
        .get();
    })();
  }
  recover() {
    this.store.db
      .update(t.submissions)
      .set({ delivery: "needs_review" })
      .where(eq(t.submissions.delivery, "publishing"))
      .run();
    this.store.db
      .update(t.attempts)
      .set({ result: "needs_review" })
      .where(eq(t.attempts.result, "publishing"))
      .run();
  }
}
