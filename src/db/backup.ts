import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import type { Store } from "./database.js";

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
