import {
  closeSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";

function processExists(pid: number) {
  if (process.platform === "win32") {
    try {
      const output = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], {
        encoding: "utf8",
        windowsHide: true,
      });
      return !output.includes("No tasks are running") && /\b\d+\b/.test(output);
    } catch {
      // Some restricted Windows environments deny tasklist. Fall back to the
      // kernel check instead of assuming that a live process is stale.
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return !(error instanceof Error && "code" in error && error.code === "ESRCH");
      }
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EPERM")
      return true;
    return false;
  }
}
export function acquireLock(path: string) {
  function create() {
    const fd = openSync(path, "wx");
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
  }
  try {
    create();
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "EEXIST"
    )
      throw error;
    const pid = Number(readFileSync(path, "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new Error("Проверьте файл блокировки " + path);
    if (!processExists(pid)) {
      unlinkSync(path);
      create();
      return () => {
        try {
          unlinkSync(path);
        } catch {
          // The lock may already have been removed during shutdown recovery.
        }
      };
    }
    throw new Error("Другой экземпляр бота уже работает.");
  }
  return () => unlinkSync(path);
}
