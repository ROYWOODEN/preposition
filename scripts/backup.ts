import { loadEnvFile } from "node:process";
import { existsSync } from "node:fs";
import { openDatabase } from "../src/db/database.js";
import { snapshotBackup } from "../src/db/backup.js";
try {
  loadEnvFile();
} catch {
  /* Environment can be supplied externally. */
}
const databasePath = process.env.DATABASE_PATH ?? "./data/bot.sqlite";
if (!existsSync(databasePath)) throw new Error("Файл базы данных не найден.");
const store = openDatabase(databasePath);
try {
  const target = await snapshotBackup(
    store,
    process.env.BACKUP_DIR ?? "./backups",
  );
  console.log(target);
} finally {
  store.sqlite.close();
}
