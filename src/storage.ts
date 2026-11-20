/**
 * Хранилище Jarvis Code: чаты, контекст, вложения, снимки экрана, копии файлов до правок.
 * Папку можно сменить на ходу (например, на большой диск): данные переносятся, пути в чатах обновляются.
 */
import fs from "node:fs";
import path from "node:path";
import { rewritePaths, type ChatStore } from "./chats";
import { DATA_DIR, IS_WIN, setStoreDir, STORE_DIR, STORE_PROBLEM, STORE_SUBDIRS, CHATS_DIR, CONTEXT_DIR } from "./paths";

export interface StorageInfo {
  dir: string;
  defaultDir: string;
  custom: boolean;
  problem: string;
  /** Размер и число файлов (считается в фоне; -1 — ещё не посчитано). */
  bytes: number;
  files: number;
  /** Свободно на диске хранилища, байт (-1 — неизвестно). */
  free: number;
  parts: { name: string; bytes: number; files: number }[];
}

export interface MoveProgress {
  phase: "scan" | "copy" | "rewrite" | "done" | "error";
  done: number;
  total: number;
  bytes?: number;
  file?: string;
  error?: string;
  from?: string;
  to?: string;
}

const same = (a: string, b: string) => (IS_WIN ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
const inside = (child: string, parent: string) => {
  const rel = path.relative(IS_WIN ? parent.toLowerCase() : parent, IS_WIN ? child.toLowerCase() : child);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
};

async function walk(dir: string, onFile: (file: string, size: number) => void | Promise<void>): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) await walk(f, onFile);
    else if (e.isFile()) {
      let size = 0;
      try {
        size = (await fs.promises.stat(f)).size;
      } catch {}
      await onFile(f, size);
    }
  }
}

export function freeSpace(dir: string): number {
  try {
    const s = (fs as any).statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return -1;
  }
}

let sizeCache: { at: number; dir: string; parts: StorageInfo["parts"] } | null = null;

/** Сведения о хранилище; размер считается в фоне и кэшируется на минуту. */
export async function storageInfo(fresh = false): Promise<StorageInfo> {
  const dir = STORE_DIR;
  if (fresh || !sizeCache || sizeCache.dir !== dir || Date.now() - sizeCache.at > 60_000) {
    const parts: StorageInfo["parts"] = [];
    for (const name of STORE_SUBDIRS) {
      let bytes = 0;
      let files = 0;
      await walk(path.join(dir, name), (_f, size) => {
        bytes += size;
        files++;
      });
      parts.push({ name, bytes, files });
    }
    sizeCache = { at: Date.now(), dir, parts };
  }
  const parts = sizeCache.parts;
  return {
    dir,
    defaultDir: DATA_DIR,
    custom: !same(dir, DATA_DIR),
    problem: STORE_PROBLEM,
    bytes: parts.reduce((s, p) => s + p.bytes, 0),
    files: parts.reduce((s, p) => s + p.files, 0),
    free: freeSpace(dir),
    parts,
  };
}

/** Что уже лежит в папке: есть ли там хранилище Jarvis Code (чаты). */
export function inspectTarget(target: string): { exists: boolean; hasStore: boolean; chats: number; error?: string } {
  if (!path.isAbsolute(target)) return { exists: false, hasStore: false, chats: 0, error: "Нужен полный путь к папке (например, D:\\JarvisCode)." };
  const to = path.resolve(target);
  const err = checkTarget(to);
  if (err) return { exists: fs.existsSync(to), hasStore: false, chats: 0, error: err };
  let chats = 0;
  try {
    chats = fs.readdirSync(path.join(to, "chats")).filter((f) => f.endsWith(".json")).length;
  } catch {}
  return { exists: fs.existsSync(to), hasStore: chats > 0, chats };
}

function checkTarget(to: string): string {
  if (!path.isAbsolute(to)) return "Нужен полный путь к папке (например, D:\\JarvisCode).";
  if (same(to, STORE_DIR)) return "Хранилище уже в этой папке.";
  for (const sub of STORE_SUBDIRS) if (same(to, path.join(STORE_DIR, sub)) || inside(to, path.join(STORE_DIR, sub))) return "Нельзя выбрать папку внутри хранилища.";
  if (path.parse(to).root === to && IS_WIN) return "Выберите папку на диске, а не корень диска (например, D:\\JarvisCode).";
  try {
    if (fs.existsSync(to) && !fs.statSync(to).isDirectory()) return "Это файл, а не папка.";
  } catch {}
  return "";
}

/**
 * Перенос хранилища. mode=move — данные переносятся в новую папку (с объединением, если там уже есть хранилище);
 * mode=use — просто открыть хранилище в этой папке (например, с другого ПК или после переустановки), старое остаётся на месте.
 */
export async function moveStorage(
  target: string,
  o: { store: ChatStore; mode?: "move" | "use"; onProgress?: (p: MoveProgress) => void },
): Promise<{ ok: true; from: string; to: string; moved: number; skipped: number } | { ok: false; error: string }> {
  if (!path.isAbsolute(target)) return { ok: false, error: "Нужен полный путь к папке (например, D:\\JarvisCode)." };
  const to = path.resolve(target);
  const from = STORE_DIR;
  const report = (p: MoveProgress) => {
    try {
      o.onProgress?.({ ...p, from, to });
    } catch {}
  };
  const bad = checkTarget(to);
  if (bad) return { ok: false, error: bad };
  try {
    fs.mkdirSync(to, { recursive: true });
    // проверка записи
    const probe = path.join(to, `.jc-write-test-${process.pid}`);
    fs.writeFileSync(probe, "ok");
    fs.rmSync(probe, { force: true });
  } catch (e: any) {
    return { ok: false, error: `Нет доступа к папке ${to}: ${e?.code ?? e?.message ?? e}` };
  }
  o.store.flush();
  let moved = 0;
  let skipped = 0;
  if (o.mode !== "use") {
    report({ phase: "scan", done: 0, total: 0 });
    // 1) быстрый путь: целая папка переименовывается (тот же диск, в новой папке такой ещё нет)
    const copyList: { src: string; dst: string; size: number }[] = [];
    const renamed: string[] = [];
    for (const sub of STORE_SUBDIRS) {
      const src = path.join(from, sub);
      const dst = path.join(to, sub);
      if (!fs.existsSync(src)) continue;
      if (!fs.existsSync(dst)) {
        try {
          fs.renameSync(src, dst);
          renamed.push(sub);
          continue;
        } catch {}
      }
      await walk(src, (f, size) => {
        copyList.push({ src: f, dst: path.join(dst, path.relative(src, f)), size });
      });
    }
    const totalBytes = copyList.reduce((s, x) => s + x.size, 0);
    const free = freeSpace(to);
    if (free >= 0 && totalBytes > free) {
      // откатываем переименования, чтобы всё осталось как было
      for (const sub of renamed) {
        try {
          fs.renameSync(path.join(to, sub), path.join(from, sub));
        } catch {}
      }
      return { ok: false, error: `Мало места: нужно ${fmt(totalBytes)}, свободно ${fmt(free)}.` };
    }
    // 2) копирование между дисками: файл за файлом, исходники удаляются только после полного успеха
    let done = 0;
    let bytes = 0;
    let last = 0;
    try {
      for (const c of copyList) {
        if (fs.existsSync(c.dst)) skipped++;
        else {
          await fs.promises.mkdir(path.dirname(c.dst), { recursive: true });
          await fs.promises.copyFile(c.src, c.dst);
          moved++;
        }
        done++;
        bytes += c.size;
        if (Date.now() - last > 200 || done === copyList.length) {
          last = Date.now();
          report({ phase: "copy", done, total: copyList.length, bytes, file: path.relative(from, c.src) });
        }
      }
    } catch (e: any) {
      report({ phase: "error", done, total: copyList.length, error: String(e?.message ?? e) });
      return { ok: false, error: `Не удалось скопировать: ${e?.message ?? e}. Данные остались в ${from}.` };
    }
    for (const sub of STORE_SUBDIRS) {
      if (renamed.includes(sub)) continue;
      try {
        fs.rmSync(path.join(from, sub), { recursive: true, force: true });
      } catch {}
    }
  }
  // 3) пути в чатах (вложения, снимки экрана) — на новую папку
  setStoreDir(to);
  if (o.mode !== "use") {
    report({ phase: "rewrite", done: 0, total: 0 });
    rewriteStore(from, to);
  }
  o.store.relocate(CHATS_DIR);
  report({ phase: "done", done: 1, total: 1 });
  sizeCache = null;
  return { ok: true, from, to, moved, skipped };
}

/** Абсолютные пути старого хранилища в чатах и файлах контекста → новая папка. */
export function rewriteStore(from: string, to: string) {
  for (const f of safeList(CHATS_DIR)) {
    if (!f.endsWith(".json")) continue;
    const file = path.join(CHATS_DIR, f);
    try {
      const raw = fs.readFileSync(file, "utf8");
      if (!raw.includes(from) && !raw.includes(JSON.stringify(from).slice(1, -1)) && !raw.includes(from.replace(/\\/g, "/"))) continue;
      const fixed = JSON.stringify(rewritePaths(JSON.parse(raw), from, to));
      fs.writeFileSync(file + ".tmp", fixed, "utf8");
      fs.renameSync(file + ".tmp", file);
    } catch {}
  }
  for (const d of safeList(CONTEXT_DIR)) {
    for (const name of ["memory.md", "chat.md"]) {
      const file = path.join(CONTEXT_DIR, d, name);
      try {
        const raw = fs.readFileSync(file, "utf8");
        const fixed = rewritePaths(raw, from, to);
        if (fixed !== raw) fs.writeFileSync(file, fixed, "utf8");
      } catch {}
    }
  }
}

function safeList(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

export function fmt(n: number): string {
  if (n < 1024) return `${n} Б`;
  const u = ["КБ", "МБ", "ГБ", "ТБ"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1).replace(".", ",")} ${u[i]}`;
}
