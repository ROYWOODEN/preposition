import { loadEnvFile } from "node:process";
import { mkdirSync } from "node:fs";
import { openDatabase } from "../src/db/database.js";
try {
  loadEnvFile();
} catch {
  /* Environment can be supplied externally. */
}
mkdirSync("backups", { recursive: true });
const store = openDatabase(process.env.DATABASE_PATH ?? "./data/bot.sqlite");
const target = `backups/bot-${Date.now()}.sqlite`;
await store.sqlite.backup(target);
store.sqlite.close();
console.log(target);
