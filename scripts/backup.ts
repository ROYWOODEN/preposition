import { loadEnvFile } from "node:process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { openDatabase } from "../src/db/database.js";
import { writeBackup } from "../src/db/backup.js";
try {
  loadEnvFile();
} catch {
  /* Environment can be supplied externally. */
}
const databasePath = process.env.DATABASE_PATH ?? "./data/bot.sqlite";
if (!existsSync(databasePath)) throw new Error("Файл базы данных не найден.");
const store = openDatabase(databasePath);
try {
  const target = await writeBackup(
    store,
    process.env.BACKUP_DIR ?? "./backups",
    `bot-${Date.now()}-${randomUUID()}.sqlite`,
  );
  console.log(target);
} finally {
  store.sqlite.close();
}
