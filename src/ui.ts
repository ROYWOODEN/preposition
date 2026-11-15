import { InlineKeyboard, Keyboard, type Bot, type Context } from "grammy";
import { eq, desc } from "drizzle-orm";
import type { Service } from "./service.js";
import { UserError } from "./errors.js";
import { sendContent } from "./telegram.js";
import * as t from "./db/schema.js";
import { defaults, template, templateLabels } from "./templates.js";
import { html, person, refreshPerson } from "./people.js";
import { reasons as getReasons } from "./reasons.js";
import {
  statusNames,
  deliveryNames,
  date,
  title,
  snippet,
  historyAction,
  helpText,
} from "./presentation.js";
export const uid = (ctx: Context) => {
  if (!ctx.from) throw new UserError("Не удалось определить пользователя.");
  return ctx.from.id;
};
export function back(callback = "home") {
  const keys = new InlineKeyboard();
  if (callback !== "home") keys.text("⬅️ Назад", callback);
  return keys.text("🏠 Главное меню", "home");
}
export function listOrigin(value?: string) {
  const match = /^([hqdm])(\d{1,12})$/.exec(value ?? "");
  if (!match) return undefined;
  const screens: Record<string, string> = {
    h: "history",
    q: "queuepage",
    d: "drafts",
    m: "minepage",
  };
  return `${screens[match[1] ?? ""]}:${match[2]}`;
}
export const draftActions = (id: number, origin = "") =>
  new InlineKeyboard()
    .text("👁 Предпросмотр", `view:${id}:${origin}`)
    .text("✏️ Редактировать текст", `edit:${id}::${origin}`)
    .row()
    .text("📎 Добавить медиа", `resume:${id}:${origin}`)
    .text("🗂 Черновики", listOrigin(origin) ?? "drafts:0")
    .row()
    .text("📝 Новый пост", "new");

export function createUI(bot: Bot, s: Service, channel?: string) {
  function menu(id: number) {
    const k = new Keyboard()
      .text("📝 Предложить пост")
      .text("🗂 Черновики")
      .row()
      .text("📋 Мои заявки")
      .text("ℹ️ Помощь");
    k.row();
    if (s.isMod(id)) k.text("🛠 Управление");
    k.text("⌨️ Скрыть меню");
    return k.resized();
  }
  async function management(ctx: Context) {
    s.mod(uid(ctx));
    s.state(uid(ctx), "");
    const k = new InlineKeyboard()
      .text("🛡 Очередь", "queuepage:0")
      .text("📚 История", "history:0");
    if (s.isAdmin(uid(ctx)))
      k.row()
        .text("⚙️ Настройки", "settings")
        .text("👥 Команда", "moderators")
        .row()
        .text("📊 Статистика", "statistics")
        .text("🚫 Блокировки", "blocked")
        .row()
        .text("🔎 Проверка постов", "review");
    k.row().text("🏠 Главное меню", "home");
    await ctx.reply("🛠 Управление", { reply_markup: k });
  }
  async function hideMenu(ctx: Context) {
    await ctx.reply("⌨️ Клавиатура скрыта.", {
      reply_markup: { remove_keyboard: true },
    });
    await ctx.reply("Вернуть кнопки можно в любой момент 👇", {
      reply_markup: new InlineKeyboard().text("Показать меню", "home"),
    });
  }
  async function home(ctx: Context) {
    s.state(uid(ctx), "");
    await ctx.reply(template(s.store, "welcome"), {
      reply_markup: menu(uid(ctx)),
    });
  }
  async function fresh(ctx: Context) {
    s.state(uid(ctx), "");
    await ctx.reply(template(s.store, "instruction"), {
      reply_markup: new InlineKeyboard()
        .text("🗂 Черновики", "drafts:0")
        .text("🏠 Главное меню", "home"),
    });
  }
  async function card(
    ctx: Context,
    id: number,
    moderation = false,
    origin = "",
  ) {
    const actor = uid(ctx),
      sub = s.get(id);
    const own = sub.authorId === actor;
    moderation = moderation || !own;
    if (moderation) s.mod(actor);
    // Opening a card leaves any text-entry prompt; later messages cannot accidentally edit an old selection.
    s.state(actor, "");
    const hasContent = !!sub.body || s.files(id).length > 0;
    if (hasContent) {
      try {
        await sendContent(bot.api, actor, s.content(id));
      } catch (error) {
        if (!(error instanceof UserError)) throw error;
        await ctx.reply(error.message);
      }
    }
    const k = new InlineKeyboard();
    if (
      own &&
      !moderation &&
      (sub.status === "draft" || sub.status === "pending")
    ) {
      k.text("✏️ Редактировать текст", `edit:${id}::${origin}`);
      if (sub.status === "draft")
        k.text("📎 Добавить медиа", `resume:${id}:${origin}`);
      if (s.setting("anonymous", "true") === "true" || sub.anonymous)
        k.row().text(
          sub.anonymous ? "👤 Показать моё имя" : "🙈 Сделать анонимным",
          `anon:${id}:${origin}`,
        );
      if (sub.status === "draft" && hasContent)
        k.row().text(
          "📬 Отправить на модерацию",
          `submit:${id}:${sub.version}`,
        );
      if (sub.status === "draft" && s.files(id).length)
        k.row().text("🧹 Удалить вложения", `clear:${id}:${origin}`);
      k.row().text(
        sub.status === "draft" ? "🗑 Удалить черновик" : "Отменить заявку",
        `cancel:${id}`,
      );
    }
    if (moderation && sub.status === "pending") {
      k.text("✅ Одобрить", `approve:${id}:${sub.version}:${origin}`).text(
        "❌ Отклонить",
        `reject:${id}:${sub.version}:${origin}`,
      );
      if (s.setting("editing", "true") === "true")
        k.row().text("✏️ Редактировать текст", `edit:${id}:m:${origin}`);
    }
    k.row()
      .text(
        "⬅️ К списку",
        listOrigin(origin) ??
          (moderation
            ? "queuepage:0"
            : sub.status === "draft"
              ? "drafts:0"
              : "minepage:0"),
      )
      .text("🏠 Меню", "home");
    const lines = [
      `<b>${sub.status === "draft" ? "🗂 Черновик" : "📋 Заявка"} ${title(s, id, !moderation)}</b>`,
      statusNames[sub.status],
    ];
    if (sub.status === "approved") lines.push(deliveryNames[sub.delivery]);
    lines.push(`🕒 Создана: ${date(sub.createdAt)} (МСК)`);
    if (sub.submittedAt) lines.push(`📬 Отправлена: ${date(sub.submittedAt)}`);
    if (sub.publishedAt)
      lines.push(`📢 Опубликована: ${date(sub.publishedAt)}`);
    if (sub.reason) lines.push(`\n💬 Причина отклонения: ${html(sub.reason)}`);
    if (moderation) {
      await refreshPerson(s, bot.api, sub.authorId, channel);
      lines.push(`\n👤 Автор: ${person(s.user(sub.authorId))}`);
    }
    lines.push(
      sub.anonymous
        ? "🙈 Анонимная публикация ✓ — имя автора не появится в канале"
        : "👤 Публикация с подписью автора",
    );
    if (!hasContent) lines.push("\nПока пусто. Добавьте текст или медиа.");
    await ctx.reply(lines.join("\n"), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: k,
    });
  }
  async function list(
    ctx: Context,
    kind: "mine" | "queue" | "drafts",
    offset = 0,
  ) {
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new UserError("Некорректная страница.");
    const actor = uid(ctx);
    if (kind === "queue") s.mod(actor);
    s.state(actor, "");
    const rows = s.list(
        kind === "queue" ? undefined : actor,
        offset,
        kind === "drafts",
      ),
      shown = rows.slice(0, 10),
      prefix =
        kind === "queue"
          ? "queuepage"
          : kind === "mine"
            ? "minepage"
            : "drafts";
    const k = new InlineKeyboard();
    for (const row of shown) {
      const stamp = row.publishedAt ?? row.submittedAt ?? row.createdAt;
      const status =
        row.delivery === "published"
          ? "📢"
          : statusNames[row.status].split(" ")[0];
      k.text(
        `${status} ${title(s, row.id, kind !== "queue")} · ${date(stamp)} · ${snippet(row.body)}`,
        `${kind === "queue" ? "moderate" : "view"}:${row.id}:${kind[0]}${offset}`,
      ).row();
    }
    if (offset > 0) k.text("← Назад", `${prefix}:${Math.max(0, offset - 10)}`);
    if (rows.length > 10) k.text("Далее →", `${prefix}:${offset + 10}`);
    k.row();
    if (kind === "drafts") {
      k.text("📝 Новый пост", "new");
      if (shown.length) k.text("🧹 Очистить", "cleardrafts");
      k.row();
    }
    if (kind === "queue") k.text("⬅️ Управление", "manage");
    k.text("🏠 Главное меню", "home");
    const heading =
      kind === "queue"
        ? "🛡 На рассмотрении"
        : kind === "drafts"
          ? "🗂 Ваши черновики"
          : "📋 Ваши заявки";
    await ctx.reply(
      `${heading}\n\n${shown.length ? `Страница ${Math.floor(offset / 10) + 1} · до 10 постов\nНажмите на пост, чтобы открыть его. Дата — публикации, а до неё — отправки или создания. Время по Москве.` : kind === "drafts" ? "Здесь будут незавершённые посты. Создайте новый, а вернуться к нему сможете в любое время." : "На этой странице пока нет заявок."}`,
      { reply_markup: k },
    );
  }
  async function settings(ctx: Context) {
    s.admin(uid(ctx));
    s.state(uid(ctx), "");
    const k = new InlineKeyboard();
    for (const [key, label] of [
      ["accepting", "Приём новых заявок"],
      ["anonymous", "Анонимные посты"],
      ["editing", "Правка модераторами"],
    ])
      if (key && label)
        k.text(
          `${s.setting(key, "true") === "true" ? "✅" : "⏸"} ${label}`,
          `setting:${key}`,
        ).row();
    k.text(`📋 Лимит заявок: ${s.setting("limit", "10")}`, "limit")
      .row()
      .text("💬 Сообщения бота", "templates")
      .row()
      .text("❌ Причины отклонения", "reasons")
      .row()
      .text("↩️ Сбросить настройки", "resetsettings")
      .row()
      .text("⬅️ Управление", "manage")
      .text("🏠 Главное меню", "home");
    await ctx.reply(
      "⚙️ Настройки\n\n✅ — включено, ⏸ — выключено. Нажмите переключатель, чтобы изменить.\n\nПриём — разрешает отправлять новые заявки.\nАнонимность — позволяет автору скрыть своё имя от читателей.\nРедактирование — разрешает модераторам менять текст перед публикацией.\n\nЛимит относится к заявкам, которые ещё ждут решения.",
      { reply_markup: k },
    );
  }
  async function templateList(ctx: Context, reasons = false) {
    s.admin(uid(ctx));
    s.state(uid(ctx), "");
    const k = new InlineKeyboard();
    if (reasons) {
      for (const r of getReasons(s))
        k.text(
          r.text.slice(0, 32) + (r.text.length > 32 ? "…" : ""),
          `showtemplate:${r.key}`,
        ).row();
      k.text("➕ Добавить причину", "addreason").row();
    } else
      for (const key of Object.keys(defaults).filter(
        (key) => !key.startsWith("reason"),
      ))
        k.text(templateLabels[key] ?? key, `showtemplate:${key}`).row();
    k.text("⬅️ Настройки", "settings");
    await ctx.reply(
      reasons
        ? "❌ Причины отклонения\n\nЭто готовые ответы для модераторов. Выбранную причину получит автор поста. Нажмите на вариант, чтобы изменить его."
        : "💬 Сообщения бота\n\nВыберите сообщение: можно посмотреть пример, изменить текст или вернуть стандартный вариант.",
      { reply_markup: k },
    );
  }
  async function moderators(ctx: Context) {
    s.admin(uid(ctx));
    s.state(uid(ctx), "");
    const mods = s.store.db
      .select()
      .from(t.moderators)
      .all()
      .filter((m) => m.id !== s.owner);
    const lines = ["👥 Команда модераторов", ""];
    await refreshPerson(s, bot.api, s.owner, channel);
    lines.push(`👑 Владелец: ${person(s.user(s.owner))}`);
    const k = new InlineKeyboard();
    const ordered = mods
      .filter((m) => m.role === "head")
      .concat(mods.filter((m) => m.role === "moderator"));
    let previousRole: (typeof mods)[number]["role"] | undefined;
    for (const m of ordered) {
      await refreshPerson(s, bot.api, m.id, channel);
      const user = s.user(m.id);
      if (m.role !== previousRole) {
        lines.push(
          "",
          m.role === "head"
            ? "<b>⭐ Главные модераторы</b>"
            : "<b>🛡 Модераторы</b>",
        );
        previousRole = m.role;
      }
      lines.push(person(user));
      if (uid(ctx) === s.owner || m.role === "moderator")
        k.text(`Убрать: ${user.name.slice(0, 30)}`, `removeask:${m.id}`).row();
      if (uid(ctx) === s.owner && m.role === "moderator")
        k.text(
          `Повысить: ${user.name.slice(0, 25)}`,
          `promoteask:${m.id}`,
        ).row();
    }
    if (!mods.length) lines.push("\nМодераторы пока не назначены.");
    k.text("➕ Добавить модератора", "mod:add")
      .row()
      .text("⬅️ Управление", "manage")
      .text("🏠 Главное меню", "home");
    await ctx.reply(lines.join("\n"), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: k,
    });
  }
  async function addModerator(ctx: Context) {
    s.admin(uid(ctx));
    s.state(uid(ctx), "mod:add");
    await ctx.reply(
      "➕ Добавить модератора\n\nПришлите @username или ссылку на профиль. Если бот ещё не знает человека, выберите его через Telegram или получите приглашение.\n\nПриглашение — отдельная ссылка на этого бота: человек открывает её, а вы подтверждаете назначение. ID копировать не нужно.",
      {
        reply_markup: new InlineKeyboard()
          .text("👤 Выбрать в Telegram", "pickmoderator")
          .row()
          .text("🔗 Получить приглашение", "invite")
          .row()
          .text("⬅️ Модераторы", "moderators"),
      },
    );
  }
  async function candidate(ctx: Context, id: number, inviteHash?: string) {
    s.admin(uid(ctx));
    await refreshPerson(s, bot.api, id, channel);
    if (!inviteHash) s.state(uid(ctx), `confirmmod:${id}`);
    await ctx.reply(
      `🛡 Назначить модератором?\n\n${person(s.user(id))}\n\nОн сможет рассматривать заявки, публиковать и отклонять посты.`,
      {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: new InlineKeyboard()
          .text(
            "✅ Назначить",
            inviteHash ? `grantinvite:${inviteHash}` : `grant:${id}`,
          )
          .text(
            "Отмена",
            inviteHash ? `denyinvite:${inviteHash}` : "moderators",
          ),
      },
    );
  }
  async function statistics(ctx: Context) {
    s.admin(uid(ctx));
    s.state(uid(ctx), "");
    const rows = s.store.db.select().from(t.submissions).all();
    await ctx.reply(
      [
        "📊 Статистика",
        "",
        `Всего постов: ${rows.length}`,
        ...Object.entries(statusNames).map(
          ([key, label]) =>
            `${label}: ${rows.filter((r) => r.status === key).length}`,
        ),
        `📢 Опубликовано: ${rows.filter((r) => r.delivery === "published").length}`,
        `🔎 Требуют проверки: ${rows.filter((r) => ["needs_review", "failed"].includes(r.delivery)).length}`,
      ].join("\n"),
      { reply_markup: back("manage") },
    );
  }
  async function history(ctx: Context, offset = 0) {
    s.mod(uid(ctx));
    s.state(uid(ctx), "");
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new UserError("Некорректная страница.");
    const rows = s.store.db
      .select()
      .from(t.history)
      .where(s.isAdmin(uid(ctx)) ? undefined : eq(t.history.actorId, uid(ctx)))
      .orderBy(desc(t.history.id))
      .limit(11)
      .offset(offset)
      .all();
    const k = new InlineKeyboard(),
      lines = ["📚 История действий", ""];
    for (const r of rows.slice(0, 10)) {
      lines.push(
        `${date(r.at)} · ${r.submissionId ? "Заявка №" + r.submissionId : "Управление ботом"}\n${historyAction(s, r.action)}\n👤 ${s.user(r.actorId).name}\n`,
      );
      if (r.submissionId)
        k.text(
          `№${r.submissionId} · ${date(r.at)}`,
          `moderate:${r.submissionId}:h${offset}`,
        ).row();
    }
    if (!rows.length) lines.push("Действий пока нет.");
    if (offset > 0) k.text("← Назад", `history:${Math.max(0, offset - 10)}`);
    if (rows.length > 10) k.text("Далее →", `history:${offset + 10}`);
    k.row().text("⬅️ Управление", "manage").text("🏠 Главное меню", "home");
    await ctx.reply(lines.join("\n").slice(0, 4000), { reply_markup: k });
  }
  async function blocked(ctx: Context) {
    s.admin(uid(ctx));
    s.state(uid(ctx), "");
    const users = s.store.db
      .select()
      .from(t.users)
      .where(eq(t.users.blocked, true))
      .all();
    await ctx.reply(
      "🚫 Заблокированные\n\n" +
        (users.map(person).join("\n") || "Список пуст."),
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("Заблокировать", "block:yes")
          .text("Разблокировать", "block:no")
          .row()
          .text("⬅️ Управление", "manage")
          .text("🏠 Меню", "home"),
      },
    );
  }
  async function review(ctx: Context) {
    s.admin(uid(ctx));
    s.state(uid(ctx), "");
    const rows = s.store.db
      .select()
      .from(t.submissions)
      .all()
      .filter((r) => ["failed", "needs_review"].includes(r.delivery));
    const k = new InlineKeyboard();
    for (const r of rows)
      k.text(`№${r.id} — уже в канале`, `resolve:${r.id}:published`)
        .text("Вернуть в очередь", `resolve:${r.id}:retry`)
        .row();
    k.text("⬅️ Управление", "manage").text("🏠 Меню", "home");
    await ctx.reply(
      "🔎 Проверка публикаций\n\n" +
        (rows.length
          ? "Сначала проверьте канал. Возвращайте пост в очередь только если его там нет."
          : "Все публикации обработаны, проверять ничего не нужно."),
      { reply_markup: k },
    );
  }
  async function help(ctx: Context) {
    s.state(uid(ctx), "");
    await ctx.reply(
      helpText +
        (s.isMod(uid(ctx))
          ? "\n\n🛡 Модерация\nОткройте очередь, проверьте автора и желание публиковаться анонимно. Кнопка «Отклонить» предлагает готовые причины или собственный ответ."
          : "") +
        (s.isAdmin(uid(ctx))
          ? "\n\n👥 Команда\nДобавляйте модераторов по имени пользователя или через приглашение. В настройках отдельно находятся сообщения бота и причины отклонения."
          : ""),
      { reply_markup: back() },
    );
  }
  return {
    management,
    hideMenu,
    menu,
    home,
    fresh,
    card,
    list,
    settings,
    templateList,
    moderators,
    addModerator,
    candidate,
    statistics,
    history,
    blocked,
    review,
    help,
  };
}
