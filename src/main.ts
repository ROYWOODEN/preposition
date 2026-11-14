import { loadEnvFile } from "node:process";
import { pino } from "pino";
import { dirname, join } from "node:path";
import { readConfig } from "./config.js";
import { openDatabase } from "./db/database.js";
import { Service } from "./service.js";
import { createBot } from "./bot.js";
import { flushNotifications } from "./notifications.js";
import { eq } from "drizzle-orm";
import { notifications } from "./db/schema.js";
import { acquireLock } from "./lock.js";
try {
  loadEnvFile();
} catch {
  /* Environment can be supplied externally. */
}
const config = readConfig(process.env);
const store = openDatabase(config.DATABASE_PATH);
store.assertReady();
const log = pino(
  { level: config.LOG_LEVEL },
  pino.multistream([
    { stream: process.stdout },
    {
      stream: pino.destination({
        dest: join(dirname(config.DATABASE_PATH), "bot.log"),
        sync: true,
      }),
    },
  ]),
);
const releaseLock = acquireLock(config.DATABASE_PATH + ".lock");
process.once("exit", releaseLock);
// Migrations are explicit: never silently change the production schema at startup.
const service = new Service(store, config.OWNER_TELEGRAM_ID);
service.recover();
store.db
  .update(notifications)
  .set({ status: "needs_review" })
  .where(eq(notifications.status, "sending"))
  .run();
const bot = createBot(
  config.BOT_TOKEN,
  config.TARGET_CHANNEL_ID,
  service,
  (event, details) => log.warn({ event, ...details }),
);
bot.catch(() => log.error({ event: "update_failed" }));
let stopping = false;
let notificationJob: Promise<void> = Promise.resolve();
let notificationBusy = false;
const timer = setInterval(() => {
  if (stopping || notificationBusy) return;
  notificationBusy = true;
  notificationJob = flushNotifications(store, bot.api)
    .catch(() => log.warn({ event: "notification_failed" }))
    .finally(() => {
      notificationBusy = false;
    });
}, 10000);
async function stop() {
  if (stopping) return;
  stopping = true;
  log.info({ event: "stopping" });
  if (bot.isRunning()) await bot.stop();
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
try {
  await bot.init();
  const member = await bot.api.getChatMember(
    config.TARGET_CHANNEL_ID,
    bot.botInfo.id,
  );
  if (member.status !== "administrator" || !member.can_post_messages)
    throw new Error("У бота нет права публикации в канале.");
  await bot.api.setMyCommands([
    { command: "start", description: "Главное меню" },
    { command: "done", description: "Предпросмотр черновика" },
    { command: "mine", description: "Мои заявки" },
    { command: "cancel", description: "Выйти из действия" },
    { command: "id", description: "Мой Telegram ID" },
    { command: "help", description: "Помощь" },
  ]);
  log.info({ event: "started" });
  await bot.start({ allowed_updates: ["message", "callback_query"] });
} catch {
  log.error({
    event: "startup_or_polling_failed",
    hint: "Проверьте конфигурацию, миграции, сеть и права бота.",
  });
  process.exitCode = 1;
} finally {
  clearInterval(timer);
  await notificationJob;
  store.sqlite.close();
  log.info({ event: "stopped" });
}
