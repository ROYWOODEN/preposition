import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import type { Store } from "./database.js";

export async function restoreMissingDatabase(path: string, directory: string) {
  if (existsSync(path)) return;
  if (["-wal", "-shm", "-journal"].some((suffix) => existsSync(path + suffix)))
    throw new Error(
      "Файл базы отсутствует, но рядом остались служебные файлы SQLite.",
    );

  let files;
  try {
    files = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const latest = files
    .filter(
      (entry) =>
        entry.isFile() &&
        /^bot-(?:auto-\d{4}-\d{2}-\d{2}|\d+-[a-f0-9-]+)\.sqlite$/.test(
          entry.name,
        ),
    )
    .map((entry) => join(directory, entry.name))
    .map((file) => ({ file, time: statSync(file).mtimeMs }))
    .sort((a, b) => b.time - a.time || b.file.localeCompare(a.file))[0];
  if (!latest) return;

  const temporary = mkdtempSync(join(dirname(path), ".predlog-restore-"));
  const staged = join(temporary, "database.sqlite");
  try {
    const source = new Database(latest.file, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      if (source.pragma("quick_check", { simple: true }) !== "ok")
        throw new Error(`Повреждена резервная копия: ${latest.file}`);
      source.prepare("SELECT id FROM submissions LIMIT 0").all();
      source.prepare("SELECT id FROM users LIMIT 0").all();
      await source.backup(staged);
    } finally {
      source.close();
    }
    linkSync(staged, path);
    return latest.file;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export async function writeBackup(
  store: Store,
  directory: string,
  name: string,
) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = mkdtempSync(join(directory, ".predlog-backup-"));
  const staged = join(temporary, "database.sqlite");
  const target = join(directory, name);
  try {
    await store.sqlite.backup(staged);
    renameSync(staged, target);
    return target;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function snapshotBackup(store: Store, directory: string) {
  return writeBackup(
    store,
    directory,
    `bot-${Date.now()}-${randomUUID()}.sqlite`,
  );
}

const moscowTime = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Moscow",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});

export async function dailyBackup(
  store: Store,
  directory: string,
  now = new Date(),
) {
  const parts = moscowTime.formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  if (Number(value("hour")) < 3) return;
  const name = `bot-auto-${value("year")}-${value("month")}-${value("day")}.sqlite`;
  const dailyFiles = () =>
    readdirSync(directory, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          /^bot-auto-\d{4}-\d{2}-\d{2}\.sqlite$/.test(entry.name),
      )
      .map((entry) => entry.name)
      .sort()
      .reverse();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const created = !dailyFiles().includes(name);
  if (created) await writeBackup(store, directory, name);
  for (const old of dailyFiles().slice(7)) unlinkSync(join(directory, old));
  return created;
}
