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
import {
  dailyBackup,
  restoreMissingDatabase,
  snapshotBackup,
} from "./db/backup.js";
try {
  loadEnvFile();
} catch {
  /* Environment can be supplied externally. */
}
const config = readConfig(process.env);
const backupDirectory = process.env.BACKUP_DIR ?? "./backups";
const startupLog = pino({ level: config.LOG_LEVEL }, process.stdout);
async function prepareDatabase() {
  let stage = "lock";
  try {
    startupLog.info(
      { stage, database: config.DATABASE_PATH },
      "Получаем блокировку БД",
    );
    const releaseLock = acquireLock(config.DATABASE_PATH + ".instance.sqlite");
    process.once("exit", releaseLock);
    stage = "restore";
    startupLog.info(
      { stage, backupDirectory },
      "Проверяем резервные копии для отсутствующей БД",
    );
    const restoredFrom = await restoreMissingDatabase(
      config.DATABASE_PATH,
      backupDirectory,
    );
    if (restoredFrom) startupLog.info({ restoredFrom }, "База восстановлена");
    stage = "open";
    const store = openDatabase(config.DATABASE_PATH);
    try {
      stage = "migrate";
      if (process.argv.includes("--migrate")) {
        startupLog.info({ stage }, "Применяем миграции БД");
        store.migrate();
      }
      stage = "schema";
      store.assertReady();
      startupLog.info({ stage }, "База готова");
      return store;
    } catch (error) {
      store.sqlite.close();
      throw error;
    }
  } catch (error) {
    startupLog.error({ stage, err: error }, "Не удалось подготовить базу");
    throw error;
  }
}
const store = await prepareDatabase();
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
let backupJob: Promise<void> | undefined;
let backupTimer: ReturnType<typeof setInterval> | undefined;
function checkBackup() {
  if (stopping || backupJob) return;
  backupJob = dailyBackup(store, backupDirectory)
    .then((created) => {
      if (created)
        log.info({ event: "backup_created" }, "Резервная копия создана");
    })
    .catch((err: unknown) =>
      log.warn(
        { event: "backup_failed", err },
        "Не удалось создать резервную копию",
      ),
    )
    .finally(() => {
      backupJob = undefined;
    });
}
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
  if (bot.isRunning()) {
    try {
      await bot.stop();
    } catch {
      log.warn(
        { event: "polling_stop_failed" },
        "Не удалось сохранить позицию обновлений Telegram",
      );
    }
  }
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
let telegramStage = "init";
try {
  log.info({ stage: telegramStage }, "Подключаемся к Telegram");
  await bot.init();
  telegramStage = "channel_permissions";
  log.info({ stage: telegramStage }, "Проверяем права публикации");
  const member = await bot.api.getChatMember(
    config.TARGET_CHANNEL_ID,
    bot.botInfo.id,
  );
  if (member.status !== "administrator" || !member.can_post_messages)
    throw new Error("У бота нет права публикации в канале.");
  telegramStage = "commands";
  await bot.api.setMyCommands([
    { command: "start", description: "Главное меню" },
    { command: "done", description: "Предпросмотр черновика" },
    { command: "mine", description: "Мои заявки" },
    { command: "cancel", description: "Выйти из действия" },
    { command: "id", description: "Мой Telegram ID" },
    { command: "help", description: "Помощь" },
  ]);
  if (!stopping) {
    checkBackup();
    backupTimer = setInterval(checkBackup, 60000);
    telegramStage = "polling";
    await bot.start({
      allowed_updates: ["message", "callback_query"],
      onStart: () => {
        log.info({ event: "started" }, "Бот запущен");
      },
    });
  }
} catch {
  log.error(
    {
      event: "startup_or_polling_failed",
      stage: telegramStage,
      hint: "Проверьте конфигурацию, миграции, сеть и права бота.",
    },
    "Сбой при запуске или получении обновлений Telegram",
  );
  process.exitCode = 1;
} finally {
  clearInterval(timer);
  clearInterval(backupTimer);
  await notificationJob;
  await backupJob;
  if (stopping) {
    try {
      const file = await snapshotBackup(store, backupDirectory);
      log.info(
        { event: "shutdown_backup_created", file },
        "Копия перед остановкой создана",
      );
    } catch (err) {
      log.error(
        { event: "shutdown_backup_failed", err },
        "Не удалось создать копию перед остановкой",
      );
      process.exitCode = 1;
    }
  }
  store.sqlite.close();
  log.info({ event: "stopped" });
}
