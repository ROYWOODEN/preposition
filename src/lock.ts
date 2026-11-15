import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function acquireLock(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  // A separate SQLite connection holds an OS lock without blocking the bot's database.
  const lock = new Database(path, { timeout: 0 });
  try {
    lock.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    lock.close();
    if (error instanceof Database.SqliteError && error.code === "SQLITE_BUSY")
      throw new Error("Другой экземпляр бота уже работает с этой базой.");
    throw error;
  }
  return () => lock.close();
}
