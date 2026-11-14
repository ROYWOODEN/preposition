import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as schema from "./schema.js";
export function openDatabase(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  const db = drizzle(sqlite, { schema });
  return {
    db,
    sqlite,
    migrate: () => migrate(db, { migrationsFolder: "./migrations" }),
    assertReady: () => {
      try {
        sqlite
          .prepare(
            "SELECT button_text, button_callback FROM notifications LIMIT 0",
          )
          .all();
        sqlite.prepare("SELECT hash FROM moderator_invitations LIMIT 0").all();
      } catch {
        throw new Error(
          "База данных требует обновления. Остановите бота и выполните npm run db:migrate, затем запустите снова.",
        );
      }
    },
  };
}
export type Store = ReturnType<typeof openDatabase>;
