import { loadEnvFile } from "node:process";
import { Api } from "grammy";
try {
  loadEnvFile();
} catch {
  /* Report missing token below. */
}
const token = process.env.BOT_TOKEN;
if (!token || token === "REPLACE_WITH_BOT_TOKEN")
  throw new Error("Сначала заполните BOT_TOKEN в локальном .env.");
const api = new Api(token);
try {
  const me = await api.getMe();
  console.log("Бот:", me.username, "ID:", me.id);
  const channel = process.argv[2] ?? process.env.TARGET_CHANNEL_ID;
  if (channel) {
    const chat = await api.getChat(channel);
    console.log("Канал ID:", chat.id);
    const member = await api.getChatMember(chat.id, me.id);
    console.log(
      "Статус бота:",
      member.status,
      "Публикация:",
      member.status === "administrator" && member.can_post_messages,
    );
  }
  const updates = await api.getUpdates({ limit: 100, timeout: 0 });
  const ids = new Set<number>();
  for (const update of updates)
    if (update.message?.chat.type === "private" && update.message.from)
      ids.add(update.message.from.id);
  console.log(
    "ID пользователей, написавших боту:",
    [...ids].join(", ") || "нет — отправьте боту /start и повторите",
  );
  console.log(
    "Содержимое сообщений и токен не выводятся. Публикаций не выполнялось.",
  );
} catch {
  console.error(
    "Не удалось проверить Telegram. Проверьте токен, канал, сеть; остановите другие экземпляры бота.",
  );
  process.exitCode = 1;
}
