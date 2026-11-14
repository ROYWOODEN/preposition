import { eq } from "drizzle-orm";
import type { Store } from "./db/database.js";
import { templates } from "./db/schema.js";
import { UserError } from "./errors.js";
export const defaults: Record<string, string> = {
  welcome:
    "👋 Добро пожаловать в предложку!\n\n📝 Поделитесь постом для канала. Вы сможете проверить его перед отправкой, выбрать анонимность и следить за решением модераторов.\n\nВыберите действие кнопками ниже 👇",
  instruction:
    "📝 Новый пост\n\nНапишите текст, прикрепите фото с подписью или отправьте альбом 📎\nЯ сохраню его в отдельный черновик. После этого появится предпросмотр и кнопки редактирования.\n\n🗂 Незавершённые посты доступны в разделе «Черновики».",
  submitted:
    "📬 Заявка №{submission_id} отправлена!\n\nМодераторы посмотрят пост, а я сообщу вам решение. Пока его нет, текст можно изменить в «Мои заявки».",
  published:
    "🎉 Ваш пост опубликован!\n\nЗаявка №{submission_id} принята. Спасибо, что делитесь интересным с каналом!",
  rejected:
    "❌ Заявка №{submission_id} отклонена\n\n💬 Причина: {reason}\n\nВы можете подготовить новый пост с учётом замечаний.",
  unavailable: "Не удалось выполнить действие. Попробуйте позднее.",
  blocked: "Доступ заблокирован.",
  closed: "Приём заявок временно закрыт.",
  reason0: "Не соответствует тематике",
  reason1: "Реклама / спам",
  reason2: "Недостаточно информации",
  reason3: "Повтор публикации",
};
export const templateLabels: Record<string, string> = {
  welcome: "👋 Приветствие",
  instruction: "📝 Создание поста",
  submitted: "📬 Заявка принята на модерацию",
  published: "🎉 Пост опубликован",
  rejected: "❌ Заявка отклонена",
  unavailable: "⚠️ Техническая ошибка",
  blocked: "🚫 Доступ заблокирован",
  closed: "⏸ Приём заявок закрыт",
  reason0: "Не соответствует тематике",
  reason1: "Реклама / спам",
  reason2: "Недостаточно информации",
  reason3: "Повтор публикации",
};
export function template(
  store: Store,
  key: string,
  values: Record<string, string> = {},
) {
  const text =
    store.db.select().from(templates).where(eq(templates.key, key)).get()
      ?.value ?? defaults[key];
  if (text === undefined) throw new UserError("Неизвестный шаблон.");
  return text.replace(
    /\{(\w+)\}/g,
    (original: string, name: string) => values[name] ?? original,
  );
}
export function saveTemplate(store: Store, key: string, value: string) {
  if (
    (!(key in defaults) && !/^reason\d{1,6}$/.test(key)) ||
    !value.trim() ||
    value.length > (key.startsWith("reason") ? 500 : 3000)
  )
    throw new UserError("Недопустимый шаблон или длина текста.");
  const allowed =
    key === "rejected"
      ? ["submission_id", "reason"]
      : ["submitted", "published"].includes(key)
        ? ["submission_id"]
        : [];
  for (const match of value.matchAll(/\{([^{}]*)\}/g))
    if (!allowed.includes(match[1] ?? ""))
      throw new UserError(
        "Неизвестный плейсхолдер. Допустимы: " + allowed.join(", "),
      );
  store.db
    .insert(templates)
    .values({ key, value })
    .onConflictDoUpdate({ target: templates.key, set: { value } })
    .run();
}
