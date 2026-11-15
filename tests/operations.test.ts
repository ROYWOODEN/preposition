import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  dailyBackup,
  restoreMissingDatabase,
  snapshotBackup,
  writeBackup,
} from "../src/db/backup.js";
import { openDatabase } from "../src/db/database.js";
import { acquireLock } from "../src/lock.js";
import { Service } from "../src/service.js";

it("restores a missing database and refuses to overwrite it or accept a broken backup", async () => {
  const directory = mkdtempSync(join(tmpdir(), "predlog-restore-"));
  const store = openDatabase(":memory:");
  try {
    store.migrate();
    new Service(store, 1).touch(2, "Backup author");
    const path = join(directory, "bot.sqlite");
    const backups = join(directory, "backups");
    const backup = await snapshotBackup(store, backups);
    expect(await restoreMissingDatabase(path, backups)).toBe(backup);
    const restored = openDatabase(path);
    try {
      restored.assertReady();
      expect(new Service(restored, 1).user(2).name).toBe("Backup author");
      expect(await restoreMissingDatabase(path, backups)).toBeUndefined();
    } finally {
      restored.sqlite.close();
    }
    const missing = join(directory, "missing.sqlite");
    writeFileSync(backup, "broken");
    await expect(restoreMissingDatabase(missing, backups)).rejects.toThrow();
    expect(existsSync(missing)).toBe(false);
  } finally {
    store.sqlite.close();
    rmSync(directory, { recursive: true });
  }
});

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
