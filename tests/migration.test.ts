import { expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute, sep } from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { z } from "zod";
import { openDatabase } from "../src/db/database.js";
import * as t from "../src/db/schema.js";
it("upgrades the previous database without losing posts, templates or pending notifications", () => {
  const dir = mkdtempSync(join(tmpdir(), "predlog-migration-"));
  const store = openDatabase(":memory:");
  try {
    mkdirSync(join(dir, "meta"));
    const journal = z
      .object({
        version: z.string(),
        dialect: z.string(),
        entries: z.array(
          z.object({
            idx: z.number(),
            version: z.string(),
            when: z.number(),
            tag: z.string(),
            breakpoints: z.boolean(),
          }),
        ),
      })
      .parse(JSON.parse(readFileSync("migrations/meta/_journal.json", "utf8")));
    const old = { ...journal, entries: journal.entries.slice(0, 2) };
    writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify(old));
    for (const entry of old.entries)
      copyFileSync(
        `migrations/${entry.tag}.sql`,
        join(dir, entry.tag + ".sql"),
      );
    migrate(store.db, { migrationsFolder: dir });
    expect(() => store.assertReady()).toThrow("db:migrate");
    store.sqlite
      .prepare(
        "INSERT INTO users (id,name,created_at,active_at) VALUES (?,?,?,?)",
      )
      .run(2, "Author", 1, 1);
    store.sqlite
      .prepare(
        "INSERT INTO submissions (id,author_id,body,status,created_at,updated_at) VALUES (?,?,?,?,?,?)",
      )
      .run(7, 2, "Existing draft", "draft", 1, 1);
    store.sqlite
      .prepare("INSERT INTO message_templates (key,value) VALUES (?,?)")
      .run("welcome", "Custom greeting");
    store.sqlite
      .prepare(
        "INSERT INTO notifications (user_id,body,next_at) VALUES (?,?,?)",
      )
      .run(2, "Existing notification", 1);
    store.migrate();
    store.migrate();
    expect(() => store.assertReady()).not.toThrow();
    expect(store.db.select().from(t.submissions).get()?.body).toBe(
      "Existing draft",
    );
    expect(store.db.select().from(t.templates).get()?.value).toBe(
      "Custom greeting",
    );
    expect(store.db.select().from(t.notifications).get()).toMatchObject({
      body: "Existing notification",
      buttonText: null,
      buttonCallback: null,
    });
    expect(store.db.select().from(t.invitations).all()).toEqual([]);
  } finally {
    store.sqlite.close();
    const child = relative(tmpdir(), dir);
    if (
      child.startsWith("predlog-migration-") &&
      !child.includes(sep) &&
      !isAbsolute(child)
    )
      rmSync(dir, { recursive: true, force: true });
  }
});
