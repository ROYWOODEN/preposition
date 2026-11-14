import { loadEnvFile } from "node:process";
import { openDatabase } from "../src/db/database.js";
try {
  loadEnvFile();
} catch {
  /* Environment can be supplied externally. */
}
const store = openDatabase(process.env.DATABASE_PATH ?? "./data/bot.sqlite");
store.migrate();
store.sqlite.close();
console.log("Миграции применены.");
