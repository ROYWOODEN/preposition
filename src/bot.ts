import { Bot, InlineKeyboard, Keyboard, GrammyError } from "grammy";
import { eq } from "drizzle-orm";
import { UserError } from "./errors.js";
import type { Service } from "./service.js";
import { publish } from "./telegram.js";
import * as t from "./db/schema.js";
import {
  defaults,
  template,
  saveTemplate,
  templateLabels,
} from "./templates.js";
import { flushNotifications } from "./notifications.js";
import {
  person,
  resolvePerson,
  grantModerator,
  removeModerator,
  createInvitation,
  acceptInvitation,
  invitationCandidate,
  confirmInvitation,
  refreshPerson,
} from "./people.js";
import {
  reasons,
  reason,
  isReasonKey,
  addReason,
  deleteReason,
  resetSettings,
} from "./reasons.js";
import { isSubscriber } from "./membership.js";
import { title } from "./presentation.js";
import { createUI, uid, back, draftActions } from "./ui.js";

export function createBot(
  token: string,
  channel: string,
  s: Service,
  onError: (event: string, details?: Record<string, string | number>) => void,
  transport?: typeof fetch,
) {
  const bot = new Bot(token, { client: { fetch: transport } }),
    ui = createUI(bot, s, channel);
  const drain = () =>
    flushNotifications(s.store, bot.api).catch(() =>
      onError("notification_failed"),
    );
  bot.use(async (ctx, next) => {
    if (!ctx.from || ctx.chat?.type !== "private") return;
    s.touch(
      ctx.from.id,
      [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" "),
      ctx.from.username,
    );
    try {
      if (s.user(ctx.from.id).blocked)
        throw new UserError(template(s.store, "blocked"));
      if (!(await isSubscriber(bot.api, channel, ctx.from.id))) {
        const invite = /^\/start(?:@\w+)? mod_([\w-]{32})$/.exec(
          ctx.message?.text ?? "",
        );
        if (invite?.[1]) s.state(ctx.from.id, "joininvite:" + invite[1]);
        if (ctx.callbackQuery) await ctx.answerCallbackQuery();
        const k = new InlineKeyboard();
        try {
          const chat = await bot.api.getChat(channel);
          if (
            (chat.type === "channel" || chat.type === "supergroup") &&
            chat.username
          )
            k.url("📢 Открыть канал", "https://t.me/" + chat.username).row();
        } catch {
          /* The check button remains available. */
        }
        k.text("✅ Я подписался", "joincheck");
        await ctx.reply(
          "📢 Предложка доступна подписчикам канала.\n\nПодпишитесь, затем нажмите «Я подписался».",
          { reply_markup: k },
        );
        return;
      }
      await next();
    } catch (error) {
      if (!(error instanceof UserError))
        onError("operation_failed", {
          updateId: ctx.update.update_id,
          errorName: error instanceof Error ? error.name : "Unknown",
          code:
            error instanceof GrammyError
              ? error.error_code
              : error instanceof Error && "code" in error
                ? String(error.code)
                : "unknown",
        });
      const state = s.state(ctx.from.id);
      await ctx.reply(
        error instanceof UserError
          ? error.message
          : template(s.store, "unavailable"),
        {
          reply_markup:
            state === "mod:add"
              ? new InlineKeyboard()
                    .text("👤 Выбрать в Telegram", "pickmoderator")
                    .row()
                  .text("🔗 Получить приглашение", "invite")
                  .text("⬅️ Модераторы", "moderators")
              : back(),
        },
      );
    }
  });
  bot.command("start", async (ctx) => {
    const arg = ctx.match;
    if (arg.startsWith("mod_")) {
      acceptInvitation(s, uid(ctx), arg.slice(4));
      await ctx.reply(
        "👋 Приглашение принято. Владелец проверит ваш профиль и подтвердит назначение.",
        { reply_markup: ui.menu(uid(ctx)) },
      );
      await drain();
    } else await ui.home(ctx);
  });
  bot.command("id", (ctx) =>
    ctx.reply(`Ваш Telegram ID: ${uid(ctx)}`, { reply_markup: back() }),
  );
  bot.command("cancel", ui.home);
  bot.command("help", ui.help);
  bot.command("done", (ctx) => {
    const [kind, id] = s.state(uid(ctx)).split(":");
    if (!["draft", "saved"].includes(kind ?? "") || !id)
      return ui.list(ctx, "drafts");
    return ui.card(ctx, Number(id));
  });
  bot.command("mine", (ctx) => ui.list(ctx, "mine"));
  bot.command("queue", (ctx) => ui.list(ctx, "queue"));
  bot.command("settings", ui.settings);
  bot.command("review", ui.review);
  bot.hears("🛠 Управление", ui.management);
  bot.hears("⌨️ Скрыть меню", ui.hideMenu);
  bot.hears("↩️ Отмена выбора", ui.home);
  bot.hears("📝 Предложить пост", ui.fresh);
  bot.hears("🗂 Черновики", (ctx) => ui.list(ctx, "drafts"));
  bot.hears("📋 Мои заявки", (ctx) => ui.list(ctx, "mine"));
  bot.hears("ℹ️ Помощь", ui.help);
  bot.hears("🛡 Модерация", (ctx) => ui.list(ctx, "queue"));
  bot.hears("📚 История", (ctx) => ui.history(ctx));
  bot.hears("⚙️ Настройки", ui.settings);
  bot.hears("👥 Модераторы", ui.moderators);
  bot.hears("📊 Статистика", ui.statistics);
  bot.hears("🚫 Заблокированные", ui.blocked);
  bot.hears("🔎 Проверка публикаций", ui.review);
  bot.on("callback_query:data", async (ctx) => {
    await ctx.answerCallbackQuery();
    const actor = uid(ctx);
    const [action, arg, extra] = ctx.callbackQuery.data.split(":");
    const id = Number(arg);
    if (action === "joincheck") {
      const [kind, token] = s.state(actor).split(":");
      if (kind === "joininvite" && token) {
        acceptInvitation(s, actor, token);
        s.state(actor, "");
        await ctx.reply(
          "✅ Подписка подтверждена. Владелец получил ваш запрос на назначение.",
          { reply_markup: ui.menu(actor) },
        );
        await drain();
        return;
      }
      return ui.home(ctx);
    }
    if (action === "manage") return ui.management(ctx);
    if (action === "cleardrafts") {
      s.state(actor, "confirm-clear-drafts");
      await ctx.reply(
        "🧹 Очистить все ваши черновики?\n\nЗаявки на модерации и опубликованные посты останутся. Продолжить редактирование очищенных черновиков будет нельзя.",
        {
          reply_markup: new InlineKeyboard()
            .text("Да, очистить", "confirmcleardrafts")
            .text("Отмена", "drafts:0"),
        },
      );
      return;
    }
    if (action === "confirmcleardrafts") {
      if (s.state(actor) !== "confirm-clear-drafts")
        throw new UserError("Откройте очистку черновиков заново.");
      const count = s.clearDrafts(actor);
      await ctx.reply(`🧹 Очищено черновиков: ${count}.`, {
        reply_markup: new InlineKeyboard()
          .text("📝 Новый пост", "new")
          .text("🏠 Меню", "home"),
      });
      return;
    }
    if (action === "home") return ui.home(ctx);
    if (action === "new") return ui.fresh(ctx);
    if (action === "help") return ui.help(ctx);
    if (action === "minepage" || action === "queuepage" || action === "drafts")
      return ui.list(
        ctx,
        action === "minepage"
          ? "mine"
          : action === "queuepage"
            ? "queue"
            : "drafts",
        id,
      );
    if (action === "view" || action === "moderate")
      return ui.card(ctx, id, action === "moderate");
    if (action === "history") return ui.history(ctx, id);
    if (action === "resume") {
      s.resume(actor, id);
      await ctx.reply(
        `📎 Добавьте медиа в черновик ${title(s, id, true)}.\n\nФайлы попадут только в этот пост. Для замены текста используйте «Редактировать текст».`,
        { reply_markup: draftActions(id) },
      );
      return;
    }
    if (action === "edit") {
      s.editable(actor, id);
      s.state(actor, `edit:${id}:${extra ?? ""}`);
      await ctx.reply(
        "✏️ Редактирование текста\n\nПришлите новый текст с нужным форматированием. Он заменит прежний, вложения останутся.",
        { reply_markup: back(`${extra === "m" ? "moderate" : "view"}:${id}`) },
      );
      return;
    }
    if (action === "clear") {
      const sub = s.editable(actor, id);
      if (sub.authorId !== actor || sub.status !== "draft")
        throw new UserError("Можно менять только свой черновик.");
      s.store.db.delete(t.media).where(eq(t.media.submissionId, id)).run();
      s.edit(actor, id, sub.body, sub.entities);
      await ui.card(ctx, id);
      return;
    }
    if (action === "anon") {
      s.anonymous(actor, id);
      await ui.card(ctx, id);
      return;
    }
    if (action === "cancel") {
      s.cancel(actor, id);
      s.state(actor, "");
      await ctx.reply("🗑 Пост отменён. Остальные черновики сохранены.", {
        reply_markup: new InlineKeyboard()
          .text("🗂 Черновики", "drafts:0")
          .text("📋 Мои заявки", "minepage:0"),
      });
      return;
    }
    if (action === "submit") {
      s.submit(actor, id, Number(extra));
      s.state(actor, "");
      await ctx.reply(
        template(s.store, "submitted", {
          submission_id: String(s.localNumber(id)),
        }),
        {
          reply_markup: new InlineKeyboard()
            .text("📋 Мои заявки", "minepage:0")
            .text("📝 Новый пост", "new"),
        },
      );
      await drain();
      return;
    }
    if (action === "approve") {
      await publish(s, bot.api, channel, actor, id, Number(extra));
      await ctx.reply("✅ Пост опубликован в канале!", {
        reply_markup: new InlineKeyboard()
          .text("🛡 Следующие заявки", "queuepage:0")
          .text("📋 Открыть пост", `moderate:${id}`),
      });
      await drain();
      return;
    }
    if (action === "reject") {
      s.mod(actor);
      const k = new InlineKeyboard();
      for (const r of reasons(s))
        k.text(
          r.text.slice(0, 34) + (r.text.length > 34 ? "…" : ""),
          `reason:${id}:${extra}:${r.key.slice(6)}`,
        ).row();
      k.text("✍️ Своя причина", `custom:${id}:${extra}`)
        .row()
        .text("⬅️ К заявке", `moderate:${id}`);
      await ctx.reply(
        "❌ Почему отклоняем пост?\n\nВыберите готовую причину или напишите свою. Автор получит выбранный ответ.",
        { reply_markup: k },
      );
      return;
    }
    if (action === "reason") {
      const index = Number(ctx.callbackQuery.data.split(":")[3]);
      if (!Number.isInteger(index) || index < 0 || index > 999999)
        throw new UserError("Неизвестная причина.");
      s.reject(actor, id, Number(extra), reason(s, "reason" + index));
      await ctx.reply("❌ Заявка отклонена. Автору отправляется причина.", {
        reply_markup: new InlineKeyboard().text("🛡 К очереди", "queuepage:0"),
      });
      await drain();
      return;
    }
    if (action === "custom") {
      s.mod(actor);
      s.state(actor, `reject:${id}:${extra}`);
      await ctx.reply(
        "✍️ Напишите причину отклонения — до 500 символов. Этот текст получит автор.",
        { reply_markup: back(`moderate:${id}`) },
      );
      return;
    }
    s.admin(actor);
    if (action === "statistics") return ui.statistics(ctx);
    if (action === "blocked") return ui.blocked(ctx);
    if (action === "review") return ui.review(ctx);
    if (action === "pickmoderator") {
      s.state(actor, "pickmoderator");
      await ctx.reply(
        "👤 Выберите человека кнопкой ниже. Telegram передаст его профиль, а назначение вы подтвердите отдельно.",
        {
          reply_markup: new Keyboard()
            .requestUsers("👤 Выбрать человека", 703, {
              user_is_bot: false,
              max_quantity: 1,
              request_name: true,
              request_username: true,
            })
            .row()
            .text("↩️ Отмена выбора")
            .resized()
            .oneTime(),
        },
      );
      return;
    }
    if (action === "resetsettings") {
      s.state(actor, "confirm-reset-settings");
      await ctx.reply(
        "↩️ Вернуть стандартные настройки?\n\nБудут сброшены переключатели, лимит заявок, сообщения бота и список причин отклонения. Ваши добавленные причины будут удалены.\n\nПосты, черновики, модераторы, блокировки и история сохранятся.",
        {
          reply_markup: new InlineKeyboard()
            .text("Да, сбросить", "confirmresetsettings")
            .row()
            .text("Отмена", "settings"),
        },
      );
      return;
    }
    if (action === "confirmresetsettings") {
      if (s.state(actor) !== "confirm-reset-settings")
        throw new UserError("Подтвердите сброс заново.");
      resetSettings(s, actor);
      s.state(actor, "");
      await ctx.reply("✅ Стандартные настройки восстановлены.", {
        reply_markup: back("settings"),
      });
      return;
    }
    if (action === "addreason") {
      s.state(actor, "newreason");
      await ctx.reply(
        "✍️ Напишите новую причину отклонения — до 500 символов. Автор будет получать этот текст целиком.",
        { reply_markup: back("reasons") },
      );
      return;
    }
    if (action === "deletereason" && arg) {
      reason(s, arg);
      s.state(actor, "delete-reason:" + arg);
      await ctx.reply("Удалить эту причину из списка модерации?", {
        reply_markup: new InlineKeyboard()
          .text("Удалить", `confirmdeletereason:${arg}`)
          .text("Отмена", "reasons"),
      });
      return;
    }
    if (action === "confirmdeletereason" && arg) {
      if (s.state(actor) !== "delete-reason:" + arg)
        throw new UserError("Подтвердите удаление заново.");
      deleteReason(s, actor, arg);
      s.state(actor, "");
      await ui.templateList(ctx, true);
      return;
    }
    if (action === "settings") return ui.settings(ctx);
    if (action === "moderators") return ui.moderators(ctx);
    if (action === "mod")
      return arg === "add" ? ui.addModerator(ctx) : ui.moderators(ctx);
    if (action === "invite") {
      const token = createInvitation(s, actor);
      s.state(actor, "");
      const link = `https://t.me/${bot.botInfo.username}?start=mod_${token}`;
      await ctx.reply(
        "🔗 Приглашение в модераторы\n\nОтправьте эту ссылку нужному человеку:\n" +
          link +
          "\n\nСсылка действует 24 часа и используется один раз. После перехода я покажу вам профиль — права появятся только после вашего подтверждения.",
        {
          link_preview_options: { is_disabled: true },
          reply_markup: back("moderators"),
        },
      );
      return;
    }
    if (action === "candidate" && arg)
      return ui.candidate(ctx, invitationCandidate(s, actor, arg), arg);
    if ((action === "grantinvite" || action === "denyinvite") && arg) {
      confirmInvitation(s, actor, arg, action === "grantinvite");
      await ctx.reply(
        action === "grantinvite"
          ? "🛡 Модератор назначен."
          : "Назначение отклонено.",
        { reply_markup: back("moderators") },
      );
      await drain();
      return;
    }
    if (action === "grant") {
      if (s.state(actor) !== `confirmmod:${id}`)
        throw new UserError("Откройте профиль кандидата заново.");
      grantModerator(s, actor, id);
      s.state(actor, "");
      await ui.moderators(ctx);
      return;
    }
    if (action === "removeask") {
      s.state(actor, `confirmremove:${id}`);
      await ctx.reply(`Убрать модератора ${person(s.user(id))}?`, {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("Да, убрать", `remove:${id}`)
          .text("Отмена", "moderators"),
      });
      return;
    }
    if (action === "remove") {
      if (s.state(actor) !== `confirmremove:${id}`)
        throw new UserError("Откройте список модераторов заново.");
      removeModerator(s, actor, id);
      s.state(actor, "");
      await ui.moderators(ctx);
      return;
    }
    if (
      action === "setting" &&
      arg &&
      ["accepting", "anonymous", "editing"].includes(arg)
    ) {
      s.set(arg, s.setting(arg, "true") === "true" ? "false" : "true");
      return ui.settings(ctx);
    }
    if (action === "limit") {
      s.state(actor, "limit");
      await ctx.reply(
        "📋 Сколько заявок одного пользователя могут одновременно ждать модерации?\n\nВведите число от 1 до 100. Черновики в этот лимит не входят.",
        { reply_markup: back("settings") },
      );
      return;
    }
    if (action === "block") {
      s.state(actor, `block:${arg}`);
      await ctx.reply("Пришлите @username или ссылку на пользователя.", {
        reply_markup: back(),
      });
      return;
    }
    if (action === "templates" || action === "reasons")
      return ui.templateList(ctx, action === "reasons");
    if (action === "showtemplate" && arg) {
      s.state(actor, "");
      if (isReasonKey(arg)) reason(s, arg);
      const controls = new InlineKeyboard()
        .text("✏️ Редактировать", `template:${arg}`)
        .row();
      if (Object.hasOwn(defaults, arg))
        controls.text("↩️ Стандартный текст", `reset:${arg}`).row();
      if (isReasonKey(arg))
        controls.text("🗑 Удалить причину", `deletereason:${arg}`).row();
      controls.text("⬅️ К списку", isReasonKey(arg) ? "reasons" : "templates");
      await ctx.reply(
        `${isReasonKey(arg) ? "❌ Причина отклонения" : (templateLabels[arg] ?? "Сообщение")}\n\nПример:\n${template(s.store, arg, { submission_id: "3", reason: "Пример причины" })}`,
        {
          reply_markup: controls,
        },
      );
      return;
    }
    if (action === "template" && arg && (arg in defaults || isReasonKey(arg))) {
      if (isReasonKey(arg)) reason(s, arg);
      s.state(actor, `template:${arg}`);
      const variables =
        arg === "rejected"
          ? "\n\n{reason} — причина отклонения.\n{submission_id} — личный номер заявки автора."
          : ["submitted", "published"].includes(arg)
            ? "\n\n{submission_id} — личный номер заявки автора."
            : "";
      await ctx.reply(
        `✏️ ${isReasonKey(arg) ? "Причина отклонения" : templateLabels[arg]}\n\nПришлите новый текст.${variables}`,
        { reply_markup: back(`showtemplate:${arg}`) },
      );
      return;
    }
    if (action === "reset" && arg) {
      if (!Object.hasOwn(defaults, arg))
        throw new UserError("У этого текста нет стандартного варианта.");
      s.store.db.delete(t.templates).where(eq(t.templates.key, arg)).run();
      await ctx.reply("↩️ Стандартный текст восстановлен.", {
        reply_markup: back(`showtemplate:${arg}`),
      });
      return;
    }
    if (action === "resolve") {
      const sub = s.get(id);
      if (
        !["failed", "needs_review"].includes(sub.delivery) ||
        !["published", "retry"].includes(extra ?? "")
      )
        throw new UserError("Эта публикация уже обработана.");
      s.store.db
        .update(t.submissions)
        .set(
          extra === "published"
            ? { delivery: "published", publishedAt: Date.now() }
            : { status: "pending", delivery: "none", version: sub.version + 1 },
        )
        .where(eq(t.submissions.id, id))
        .run();
      s.audit(actor, id, `resolve:${extra}`);
      await ctx.reply("✅ Результат сохранён.", { reply_markup: back() });
      return;
    }
    throw new UserError("Эта кнопка устарела. Откройте нужный раздел заново.");
  });
  bot.on("message", async (ctx) => {
    const actor = uid(ctx),
      msg = ctx.message;
    if (msg.text?.startsWith("/")) {
      await ctx.reply("Выберите действие кнопками меню 👇", {
        reply_markup: ui.menu(actor),
      });
      return;
    }
    const [stateAction, arg, extra] = s.state(actor).split(":");
    const knownAlbum = msg.media_group_id
      ? s.albumDraft(actor, msg.media_group_id)
      : undefined;
    const action = knownAlbum === undefined ? stateAction : "album";
    if (action === "pickmoderator") {
      s.admin(actor);
      const shared = msg.users_shared;
      if (!shared || shared.request_id !== 703 || shared.users.length !== 1)
        throw new UserError("Нажмите «Выбрать человека» или отмените выбор.");
      const selected = shared.users[0];
      if (!selected) throw new UserError("Пользователь не выбран.");
      if (!(await refreshPerson(s, bot.api, selected.user_id, channel)))
        throw new UserError(
          "Telegram не предоставил доступ к профилю. Используйте приглашение — человек откроет бота и станет доступен.",
        );
      await ctx.reply("👤 Профиль выбран.", { reply_markup: ui.menu(actor) });
      return ui.candidate(ctx, selected.user_id);
    }
    if (action === "newreason") {
      const key = addReason(s, actor, msg.text ?? "");
      s.state(actor, "");
      await ctx.reply("✅ Новая причина добавлена.", {
        reply_markup: back(`showtemplate:${key}`),
      });
      return;
    }
    if (action === "mod") {
      s.admin(actor);
      const target = await resolvePerson(s, bot.api, msg.text ?? "", channel);
      return ui.candidate(ctx, target);
    }
    if (action === "edit") {
      if (!msg.text)
        throw new UserError(
          "Пришлите новый текст. Вложения можно добавить отдельно.",
        );
      s.edit(actor, Number(arg), msg.text, JSON.stringify(msg.entities ?? []));
      s.state(actor, "");
      return ui.card(ctx, Number(arg), extra === "m");
    }
    if (action === "reject") {
      if (!msg.text) throw new UserError("Напишите причину текстом.");
      s.reject(actor, Number(arg), Number(extra), msg.text);
      s.state(actor, "");
      await ctx.reply("❌ Заявка отклонена. Автору отправляется причина.", {
        reply_markup: new InlineKeyboard().text("🛡 К очереди", "queuepage:0"),
      });
      await drain();
      return;
    }
    if (["block", "limit", "template"].includes(action ?? "")) {
      s.admin(actor);
      const value = msg.text ?? "";
      if (action === "template") saveTemplate(s.store, arg ?? "", value);
      else if (action === "limit") {
        const limit = Number(value);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100)
          throw new UserError("Введите целое число от 1 до 100.");
        s.set("limit", String(limit));
      } else {
        const target = await resolvePerson(s, bot.api, value, channel);
        if (target === s.owner)
          throw new UserError("Права владельца неизменяемы.");
        s.store.db
          .update(t.users)
          .set({ blocked: arg === "yes" })
          .where(eq(t.users.id, target))
          .run();
        s.audit(actor, null, `block:${arg}:${target}`);
      }
      s.state(actor, "");
      await ctx.reply("✅ Изменения сохранены.", {
        reply_markup: back(
          action === "template"
            ? `showtemplate:${arg}`
            : action === "limit"
              ? "settings"
              : "home",
        ),
      });
      return;
    }
    const file =
      msg.photo?.at(-1) ??
      msg.video ??
      msg.animation ??
      msg.document ??
      msg.audio ??
      msg.voice;
    if (!file && !msg.text)
      throw new UserError(
        "Поддерживаются текст, фото, видео, документы, GIF, аудио и голосовые.",
      );
    if (
      s.store.db
        .select()
        .from(t.updates)
        .where(eq(t.updates.id, ctx.update.update_id))
        .get()
    )
      return;
    const album = msg.media_group_id
      ? s.albumDraft(actor, msg.media_group_id)
      : undefined;
    let id: number | undefined = album;
    s.store.sqlite.transaction(() => {
      if (id === undefined) {
        if (action === "draft" && arg) {
          s.resume(actor, Number(arg));
          id = Number(arg);
        } else id = s.newDraft(actor).id;
      }
      const sub = s.get(id);
      if (sub.authorId !== actor || sub.status !== "draft")
        throw new UserError(
          "Этот альбом уже отправлен. Откройте черновики или создайте новый пост.",
        );
      const incomingText = msg.text ?? msg.caption;
      if (sub.body && incomingText && incomingText !== sub.body)
        throw new UserError(
          "В этом черновике уже есть текст. Чтобы заменить его, нажмите «Редактировать текст». Для нового поста выберите «Предложить пост».",
        );
      if (file)
        s.addMedia(actor, id, {
          kind: msg.photo
            ? "photo"
            : msg.video
              ? "video"
              : msg.animation
                ? "animation"
                : msg.audio
                  ? "audio"
                  : msg.voice
                    ? "voice"
                    : "document",
          fileId: file.file_id,
          uniqueId: file.file_unique_id,
          messageId: msg.message_id,
          groupId: msg.media_group_id ?? null,
        });
      if (msg.text || msg.caption)
        s.edit(
          actor,
          id,
          msg.text ?? msg.caption ?? "",
          JSON.stringify(msg.entities ?? msg.caption_entities ?? []),
        );
      s.store.db.insert(t.updates).values({ id: ctx.update.update_id }).run();
      // Late album parts stay with their original draft without switching a different active editor.
      if (album === undefined) s.state(actor, `saved:${id}`);
    })();
    if (id !== undefined && album === undefined)
      await ctx.reply(
        `💾 Черновик ${title(s, id, true)} сохранён${msg.media_group_id ? " — собираю альбом" : ""}.\n\nПосмотрите, как будет выглядеть пост, или отредактируйте его. Чтобы дополнить именно этот пост, нажмите «Добавить медиа». Следующее отдельное сообщение создаст новый черновик.`,
        { reply_markup: draftActions(id) },
      );
  });
  return bot;
}
