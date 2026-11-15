import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { dailyBackup, writeBackup } from "../src/db/backup.js";
import { openDatabase } from "../src/db/database.js";
import { acquireLock } from "../src/lock.js";

it("keeps seven daily backups and preserves manual copies after rotation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "predlog-backup-"));
  const store = openDatabase(":memory:");
  try {
    store.migrate();
    await writeBackup(store, directory, "manual.sqlite");
    for (let day = 1; day <= 7; day++)
      await dailyBackup(store, directory, new Date(Date.UTC(2026, 10, day)));
    const before = readdirSync(directory);
    const failure = vi
      .spyOn(store.sqlite, "backup")
      .mockRejectedValueOnce(new Error("disk"));
    const eighthDay = new Date("2026-11-08T00:00:00Z");
    await expect(dailyBackup(store, directory, eighthDay)).rejects.toThrow(
      "disk",
    );
    expect(readdirSync(directory)).toEqual(before);
    failure.mockRestore();
    expect(await dailyBackup(store, directory, eighthDay)).toBe(true);
    expect(await dailyBackup(store, directory, eighthDay)).toBe(false);
    const after = readdirSync(directory);
    expect(after).toHaveLength(8);
    expect(after).toContain("manual.sqlite");
    expect(after).toContain("bot-auto-2026-11-08.sqlite");
    expect(after).not.toContain("bot-auto-2026-11-01.sqlite");
  } finally {
    store.sqlite.close();
    rmSync(directory, { recursive: true });
  }
});

it("excludes a second instance and permits restart after release", () => {
  const directory = mkdtempSync(join(tmpdir(), "predlog-lock-"));
  try {
    const path = join(directory, "instance.sqlite");
    const release = acquireLock(path);
    try {
      expect(() => acquireLock(path)).toThrow("Другой экземпляр");
    } finally {
      release();
    }
    acquireLock(path)();
  } finally {
    rmSync(directory, { recursive: true });
  }
});
