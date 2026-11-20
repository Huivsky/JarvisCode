import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function validateInstallDir(dir: string, windows = process.platform === "win32"): string {
  const p = windows ? path.win32 : path;
  if (!dir.trim() || /[\x00-\x1f]/.test(dir) || !p.isAbsolute(dir)) throw new Error("Выберите абсолютный путь к отдельной папке программы");
  const resolved = p.resolve(dir);
  if (resolved.toLowerCase() === p.parse(resolved).root.toLowerCase()) throw new Error("Нельзя устанавливать программу в корень диска");
  if (windows && (/[<>"|?*]/.test(resolved) || resolved.slice(2).includes(":"))) throw new Error("Недопустимые символы в пути установки");
  return resolved;
}

/** Stage and verify the new executable before replacing a working installation. */
export function atomicInstallFile(source: string, target: string): void {
  if (path.resolve(source).toLowerCase() === path.resolve(target).toLowerCase()) return;
  const suffix = crypto.randomBytes(8).toString("hex");
  const stage = `${target}.${suffix}.tmp`, backup = `${target}.${suffix}.bak`;
  let moved = false, committed = false;
  try {
    fs.copyFileSync(source, stage, fs.constants.COPYFILE_EXCL);
    const hash = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    if (hash(source) !== hash(stage)) throw new Error("Проверка скопированного файла не пройдена");
    if (fs.existsSync(target)) { fs.renameSync(target, backup); moved = true; }
    fs.renameSync(stage, target); committed = true;
  } catch (e) {
    if (moved && !committed) fs.renameSync(backup, target);
    throw e;
  } finally {
    fs.rmSync(stage, { force: true });
    // Backup cleanup must never turn a successful replacement into a failed install.
    if (committed) { try { fs.rmSync(backup, { force: true }); } catch {} }
  }
}

export const OWNED_INSTALL_FILES = ["JarvisCode.exe", "jarvis.cmd", "jarvis-code.cmd"] as const;
/** Only remove known application files; never recursively erase the selected directory. */
export function ownedInstallFiles(dir: string): string[] {
  const own = new Set<string>(OWNED_INSTALL_FILES);
  return fs.readdirSync(dir).filter((name) => own.has(name) || /^jarvis-code(-[\w.-]+)?\.ico$/i.test(name));
}
