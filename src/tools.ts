import { harness } from "./harness";
import { gateTool, redactTransfer } from "./transfer-gate";
import { controls, projectDecision } from "./control-center";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config, Mode } from "./config";
import { audit } from "./log";
import { IS_WIN } from "./paths";
import { moveToTrash, ocrImage, readClipboard, screenshot } from "./desktop";
import { decide, type Risk, type ToolKind } from "./permissions";
import type { ToolCall } from "./relay";
import { redactSecrets } from "./secrets";
import { atomicWrite, decodeBuffer, diffStat, encodeText, ENCODING_LABEL, isBinary, lineDiff, markWritten, snapshot, withEol } from "./textfile";
import { VERSION } from "./version";
import { setClipboard } from "./win";

const OUT_LIMIT = 30_000;
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "bin", "obj", "__pycache__", ".venv", "venv", "target",
  "$Recycle.Bin", "System Volume Information", "WinSxS",
]);

/** Русское склонение: 1 строка, 2 строки, 5 строк. */
export function plural(n: number, one: string, few: string, many: string): string {
  const d = n % 10;
  const h = n % 100;
  return d === 1 && h !== 11 ? one : d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many;
}

export function truncate(s: string, limit = OUT_LIMIT): string {
  if (s.length <= limit) return s;
  const head = s.slice(0, Math.floor(limit * 0.4));
  const tail = s.slice(-Math.floor(limit * 0.6));
  return `${head}\n… [обрезано ${s.length - limit} символов] …\n${tail}`;
}

export function resolvePath(project: string, p?: unknown): string {
  if (p === undefined || p === null || p === "" || p === ".") return path.resolve(project);
  let s = String(p).trim();
  s = s.replace(/%([^%\\/]+)%/g, (m, v) => process.env[v] ?? process.env[v.toUpperCase()] ?? m);
  s = s.replace(/^\$env:(\w+)/i, (m, v) => process.env[v] ?? m);
  if (s === "~" || s.startsWith("~/") || s.startsWith("~\\")) s = path.join(os.homedir(), s.slice(1));
  return path.resolve(project, s);
}

// ───────────── реализация инструментов ─────────────

export function listDir(dir: string, recursive = false, max = 400): string {
  const lines: string[] = [];
  const walk = (d: string, depth: number) => {
    if (lines.length >= max) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      lines.push(`${"  ".repeat(depth)}[нет доступа] ${path.basename(d)}`);
      return;
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of entries) {
      if (lines.length >= max) break;
      const isDir = e.isDirectory();
      let size = "";
      if (!isDir && depth === 0 && !recursive) {
        try {
          size = `  (${formatSize(fs.statSync(path.join(d, e.name)).size)})`;
        } catch {}
      }
      lines.push(`${"  ".repeat(depth)}${e.name}${isDir ? "/" : ""}${size}`);
      if (recursive && isDir && !SKIP_DIRS.has(e.name) && depth < 6) walk(path.join(d, e.name), depth + 1);
    }
  };
  walk(dir, 0);
  if (lines.length >= max) lines.push(`… показано ${max} элементов`);
  return `${dir}\n${lines.join("\n") || "(пусто)"}`;
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} Б`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} КБ`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} МБ`;
  return `${(n / 1024 ** 3).toFixed(2)} ГБ`;
}

export function readFile(file: string, offset = 1, limit = 2000): string {
  const buf = fs.readFileSync(file);
  if (isBinary(buf)) return `[двоичный файл, ${formatSize(buf.length)}]`;
  const { text, enc, eol } = decodeBuffer(buf);
  const lines = text.split(/\r?\n/);
  const start = Math.max(1, offset);
  const slice = lines.slice(start - 1, start - 1 + limit);
  const w = String(start + slice.length).length;
  const body = slice.map((l, i) => `${String(start + i).padStart(w)}\t${l.length > 2000 ? l.slice(0, 2000) + "…" : l}`).join("\n");
  const more = start - 1 + slice.length < lines.length ? `\n… ещё ${lines.length - (start - 1 + slice.length)} строк (используйте offset)` : "";
  const note = enc !== "utf8" ? `\n(кодировка файла: ${ENCODING_LABEL[enc]}${eol === "\r\n" ? ", CRLF" : ""} — при правках сохраняется)` : "";
  return truncate(body + more + note);
}

export { lineDiff };

export interface WriteResult {
  message: string;
  diff: string[];
  /** id резервной копии для «Отменить». */
  undo?: string;
}

/** Создаёт или перезаписывает файл, сохраняя кодировку, BOM и переводы строк существующего файла. */
export function writeFile(file: string, content: string): WriteResult {
  const existed = fs.existsSync(file);
  if (existed && fs.statSync(file).isDirectory()) throw new Error("по этому пути папка, а не файл");
  const prevBuf = existed ? fs.readFileSync(file) : null;
  const prev = prevBuf && !isBinary(prevBuf) ? decodeBuffer(prevBuf) : null;
  let text = content;
  let note = "";
  let buf: Buffer;
  if (prev) {
    text = withEol(content, prev.eol);
    const e = encodeText(text, prev.enc);
    buf = e.buf;
    if (e.note) note = ` (${e.note})`;
    else if (prev.enc !== "utf8") note = ` (кодировка ${ENCODING_LABEL[prev.enc]} сохранена)`;
  } else buf = Buffer.from(text, "utf8");
  const undo = snapshot(file);
  atomicWrite(file, buf);
  markWritten(undo, buf);
  const n = text.split(/\r?\n/).length;
  const diff = prev ? lineDiff(prev.text, text) : text.split(/\r?\n/).slice(0, 80).map((l, i) => `+ ${i + 1} ${l}`);
  const st = prev ? diffStat(diff) : { add: n, del: 0 };
  return {
    message: `${existed ? "Перезаписан" : "Создан"} ${file} (${n} ${plural(n, "строка", "строки", "строк")}${prev ? `, +${st.add} −${st.del}` : ""})${note}`,
    diff,
    undo,
  };
}

export interface Edit {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

/** Строки без хвостовых пробелов совпадают — запасной вариант, если агент «съел» пробелы в конце строк. */
function looseReplace(text: string, oldStr: string, newStr: string, eol: string): string | null {
  const T = text.split(eol);
  const O = oldStr.split(eol);
  while (O.length > 1 && O[O.length - 1] === "") O.pop();
  if (O.length < 2) return null;
  const hits: number[] = [];
  for (let i = 0; i + O.length <= T.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length && ok; j++) ok = T[i + j].trimEnd() === O[j].trimEnd();
    if (ok) hits.push(i);
    if (hits.length > 1) return null;
  }
  if (hits.length !== 1) return null;
  const N = newStr.split(eol);
  if (N.length > 1 && N[N.length - 1] === "" && oldStr.endsWith(eol)) N.pop();
  T.splice(hits[0], O.length, ...N);
  return T.join(eol);
}

function applyEdits(text: string, eol: string, edits: Edit[]): { next: string; replaced: number } {
  const norm = (v: string) => (eol === "\r\n" ? v.replace(/\r?\n/g, "\r\n") : v.replace(/\r\n/g, "\n"));
  let next = text;
  let replaced = 0;
  edits.forEach((ed, k) => {
    const label = edits.length > 1 ? `Правка ${k + 1}: ` : "";
    const o = norm(ed.old_string);
    const n = norm(ed.new_string);
    if (!o) throw new Error(`${label}old_string пустой. Для нового файла используйте nc_write_file.`);
    if (o === n) throw new Error(`${label}old_string и new_string совпадают.`);
    const count = next.split(o).length - 1;
    if (count === 0) {
      const loose = looseReplace(next, o, n, eol);
      if (loose === null) throw new Error(`${label}old_string не найден в файле. Прочитайте файл (nc_read_file) и скопируйте фрагмент точно, с отступами.`);
      next = loose;
      replaced++;
      return;
    }
    if (count > 1 && !ed.replace_all) throw new Error(`${label}old_string встречается ${count} раз. Добавьте контекст или передайте replace_all=true.`);
    next = ed.replace_all ? next.split(o).join(n) : next.replace(o, () => n);
    replaced += ed.replace_all ? count : 1;
  });
  return { next, replaced };
}

/** Одна или несколько замен в файле за одну запись (всё или ничего). Кодировка и переводы строк сохраняются. */
export function editFile(file: string, oldStr: string | Edit[], newStr = "", all = false): WriteResult {
  const edits: Edit[] = Array.isArray(oldStr) ? oldStr : [{ old_string: oldStr, new_string: newStr, replace_all: all }];
  if (!edits.length) throw new Error("Нет правок.");
  const buf = fs.readFileSync(file);
  if (isBinary(buf)) throw new Error("Двоичный файл — правка невозможна.");
  const { text, enc, eol } = decodeBuffer(buf);
  const { next, replaced } = applyEdits(text, eol, edits);
  const e = encodeText(next, enc);
  const undo = snapshot(file);
  atomicWrite(file, e.buf);
  markWritten(undo, e.buf);
  const diff = lineDiff(text, next);
  const st = diffStat(diff);
  return { message: `Изменён ${file} (${replaced} ${replaced === 1 ? "замена" : "замен"}, +${st.add} −${st.del})${e.note ? ` (${e.note})` : ""}`, diff, undo };
}

let rgAvailable: boolean | undefined;
function hasRg(): boolean {
  if (rgAvailable === undefined) {
    try {
      rgAvailable = spawnSync(IS_WIN ? "where" : "which", ["rg"], { stdio: "ignore", windowsHide: true }).status === 0;
    } catch {
      rgAvailable = false;
    }
  }
  return rgAvailable;
}

function globToRegex(g: string): RegExp {
  return new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
}

const tick = () => new Promise<void>((r) => setImmediate(r));

/**
 * Параллельный обход папок (несколько readdir одновременно — заметно быстрее на Windows)
 * без блокировки сервера: интерфейс и другие чаты не «замирают» во время поиска по диску.
 */
async function walkTree(
  root: string,
  o: {
    deadline: number;
    maxDepth: number;
    signal?: AbortSignal;
    stop: () => boolean;
    onEntry: (full: string, e: fs.Dirent) => void;
    concurrency?: number;
  },
): Promise<{ timedOut: boolean }> {
  const queue: [string, number][] = [[root, 0]];
  const conc = o.concurrency ?? 24;
  let active = 0;
  let timedOut = false;
  let finished = false;
  await new Promise<void>((resolve) => {
    const finish = () => {
      if (!finished && active === 0) {
        finished = true;
        resolve();
      }
    };
    const pump = () => {
      if (finished) return;
      if (o.stop() || o.signal?.aborted) queue.length = 0;
      else if (Date.now() > o.deadline) {
        if (queue.length) timedOut = true;
        queue.length = 0;
      }
      while (active < conc && queue.length) {
        const [dir, depth] = queue.shift()!;
        active++;
        fs.promises
          .readdir(dir, { withFileTypes: true })
          .then(
            (entries) => {
              for (const e of entries) {
                if (o.stop()) break;
                const full = path.join(dir, e.name);
                o.onEntry(full, e);
                if (e.isDirectory() && !e.isSymbolicLink() && !SKIP_DIRS.has(e.name) && depth < o.maxDepth) queue.push([full, depth + 1]);
              }
            },
            () => {},
          )
          .finally(() => {
            active--;
            pump();
          });
      }
      if (!queue.length) finish();
    };
    pump();
  });
  return { timedOut };
}

function searchRg(root: string, pattern: string, glob: string | undefined, ignoreCase: boolean, max: number, signal?: AbortSignal): Promise<string> {
  const args = ["-n", "--no-heading", "--color", "never", "-m", "20", "--max-columns", "300"];
  if (ignoreCase) args.push("-i");
  if (glob) args.push("-g", glob);
  args.push("-e", pattern, root);
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn("rg", args, { windowsHide: true });
    } catch {
      return resolve("");
    }
    let buf = "";
    const lines: string[] = [];
    let more = 0;
    const stop = () => killTree(child);
    const timer = setTimeout(stop, 50_000);
    signal?.addEventListener("abort", stop, { once: true });
    child.stdout?.setEncoding("utf8"); // буква на границе кусков вывода не ломается
    child.stdout?.on("data", (d: string) => {
      buf += d;
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      for (const l of parts) {
        if (!l) continue;
        if (lines.length < max) lines.push(l);
        else more++;
      }
      if (more > 2000) stop();
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve("");
    });
    child.on("close", () => {
      clearTimeout(timer);
      if (buf && lines.length < max) lines.push(buf);
      if (!lines.length) return resolve("Совпадений нет.");
      resolve(truncate(lines.join("\n") + (more ? `\n… ещё ${more}+` : "")));
    });
  });
}

export async function search(root: string, pattern: string, glob?: string, ignoreCase = true, max = 200, signal?: AbortSignal): Promise<string> {
  if (hasRg()) {
    const r = await searchRg(root, pattern, glob, ignoreCase, max, signal);
    if (r) return r;
  }
  const re = new RegExp(pattern, ignoreCase ? "i" : "");
  const gre = glob ? globToRegex(glob) : null;
  const out: string[] = [];
  const deadline = Date.now() + 40_000;
  const scanFile = async (f: string) => {
    try {
      const st = await fs.promises.stat(f);
      if (st.size > 2_000_000) return;
      const t = await fs.promises.readFile(f, "utf8");
      if (t.includes("\u0000")) return;
      const lines = t.split(/\r?\n/);
      for (let i = 0; i < lines.length && out.length < max; i++) if (re.test(lines[i])) out.push(`${f}:${i + 1}:${lines[i].slice(0, 300)}`);
    } catch {}
  };
  let timedOut = false;
  if ((await fs.promises.stat(root)).isFile()) await scanFile(root);
  else {
    const files: string[] = [];
    timedOut = (
      await walkTree(root, {
        deadline: deadline - 15_000,
        maxDepth: 20,
        signal,
        stop: () => files.length >= 50_000,
        onEntry: (full, e) => {
          if (e.isFile() && (!gre || gre.test(e.name))) files.push(full);
        },
      })
    ).timedOut;
    // читаем файлы пачками по 16 параллельно
    for (let i = 0; i < files.length && out.length < max; i += 16) {
      if (signal?.aborted || Date.now() > deadline) {
        timedOut = true;
        break;
      }
      await Promise.all(files.slice(i, i + 16).map(scanFile));
    }
  }
  await tick();
  if (!out.length) return timedOut ? "Совпадений нет (поиск остановлен по времени — сузьте папку)." : "Совпадений нет.";
  return truncate(out.join("\n") + (timedOut ? "\n(поиск остановлен по времени — сузьте папку)" : ""));
}

/** Поиск файлов по имени (маска или часть имени) — например по всему диску. */
export async function findFiles(root: string, name: string, max = 200, signal?: AbortSignal): Promise<string> {
  const mask = /[*?]/.test(name) ? name : `*${name}*`;
  const re = globToRegex(mask);
  const out: string[] = [];
  const { timedOut } = await walkTree(root, {
    deadline: Date.now() + 45_000,
    maxDepth: 14,
    signal,
    stop: () => out.length >= max,
    onEntry: (full, e) => {
      if (out.length < max && re.test(e.name)) out.push(e.isDirectory() ? full + path.sep : full);
    },
  });
  if (!out.length) return timedOut ? "Ничего не найдено за 45 с — сузьте папку поиска." : "Ничего не найдено.";
  return truncate(out.join("\n") + (out.length >= max ? `\n… показано ${max}` : "") + (timedOut ? "\n(поиск остановлен по времени)" : ""));
}

// ───────────── процессы ─────────────

function shellCommand(cfg: Config, command: string): [string, string[]] {
  if (!IS_WIN) return ["bash", ["-lc", command]];
  if (cfg.shell === "cmd") return ["cmd.exe", ["/d", "/s", "/c", `chcp 65001>nul & ${command}`]];
  return [
    cfg.shell === "pwsh" ? "pwsh.exe" : "powershell.exe",
    [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
      "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$OutputEncoding=[System.Text.Encoding]::UTF8;$ProgressPreference='SilentlyContinue';" + command,
    ],
  ];
}

export function killTree(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) return;
  if (IS_WIN) {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
    } catch {}
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

/** Окружение для команд агента: без токенов Jarvis Code. */
export function childEnv(cfg: Config): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const secrets = new Set([cfg.bridge?.ngrokAuthtoken, cfg.mcp?.token].filter(Boolean));
  for (const [k, v] of Object.entries(env)) if (v && secrets.has(v)) delete env[k];
  return env;
}

function spawnShell(cfg: Config, command: string, cwd: string): ChildProcess {
  const [cmd, args] = shellCommand(cfg, command);
  if (!fs.existsSync(cwd)) throw new Error(`папка не существует: ${cwd}`);
  return spawn(cmd, args, { cwd, env: childEnv(cfg), detached: !IS_WIN, windowsHide: true });
}


export function runCommand(cfg: Config, command: string, cwd: string, timeoutSec?: number, signal?: AbortSignal): Promise<string> {
  const limit = Math.max(1, Math.min(timeoutSec ?? cfg.commandTimeoutSec, 55));
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnShell(cfg, command, cwd);
    } catch (e: any) {
      resolve(`Ошибка запуска: ${e.message}`);
      return;
    }
    let out = "";
    const onData = (d: string) => {
      out += d;
      if (out.length > OUT_LIMIT * 3) out = out.slice(-OUT_LIMIT * 2);
    };
    // setEncoding — свой декодер у каждого потока: русские буквы на границе кусков вывода не превращаются в «�»
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, limit * 1000);
    signal?.addEventListener("abort", () => killTree(child), { once: true });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve(`Ошибка запуска: ${e.message}`);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const head = timedOut ? `⏱ Превышен лимит ${limit} с — процесс остановлен. Для долгих команд используйте nc_job_start.` : `exit code: ${code}`;
      resolve(`${head}\n${truncate(out.trim()) || "(нет вывода)"}`);
    });
  });
}

interface Job {
  id: string;
  command: string;
  owner: string;
  child: ChildProcess;
  output: string;
  startedAt: number;
  exitCode: number | null;
  done: boolean;
}
const jobs = new Map<string, Job>();
let jobSeq = 0;

export function startJob(cfg: Config, command: string, cwd: string, owner = ""): Job {
  const child = spawnShell(cfg, command, cwd);
  const job: Job = { id: `job${++jobSeq}`, command, owner, child, output: "", startedAt: Date.now(), exitCode: null, done: false };
  const onData = (d: string) => {
    job.output += d;
    if (job.output.length > 500_000) job.output = job.output.slice(-400_000);
  };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.on("close", (code) => {
    job.exitCode = code;
    job.done = true;
  });
  child.on("error", (e) => {
    job.output += `\nОшибка запуска: ${e.message}`;
    job.done = true;
  });
  jobs.set(job.id, job);
  return job;
}

export async function jobStatus(id: string, tail = 80, waitSec = 0, owner = ""): Promise<string> {
  const job = jobs.get(id);
  if (!job || job.owner !== owner) return `Задача ${id} не найдена в этой сессии.`;
  const until = Date.now() + Math.min(waitSec, 25) * 1000;
  while (!job.done && Date.now() < until) await new Promise((r) => setTimeout(r, 300));
  const lines = job.output.trim().split(/\r?\n/).slice(-tail).join("\n");
  const secs = Math.round((Date.now() - job.startedAt) / 1000);
  const st = job.done ? `завершена, exit code: ${job.exitCode}` : `выполняется (${secs} с)`;
  return `${job.id}: ${st}\n$ ${job.command}\n${truncate(lines) || "(пока нет вывода)"}`;
}

export function killJob(id?: string, owner = ""): string {
  if (!id) {
    if (!jobs.size) return "Фоновых задач нет.";
    return [...jobs.values()].filter(j => j.owner === owner).map((j) => `${j.id}  ${j.done ? `exit ${j.exitCode}` : "running"}  ${j.command}`).join("\n");
  }
  const job = jobs.get(id);
  if (!job || job.owner !== owner) return `Задача ${id} не найдена в этой сессии.`;
  killTree(job.child);
  return `Задача ${id} остановлена.`;
}

export function stopSessionJobs(owner: string): void { for (const j of jobs.values()) if (j.owner === owner && !j.done) killTree(j.child); }
export function sessionJobsSafe(owner: string, since: number): boolean { return [...jobs.values()].filter(j => j.owner === owner && j.startedAt >= since).every(j => j.done && j.exitCode === 0); }

export function killAllJobs(): void {
  for (const j of jobs.values()) if (!j.done) killTree(j.child);
}

export function openTarget(target: string): string {
  const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(target) || /^mailto:/i.test(target);
  if (isUrl && !/^(https?|mailto|ftp|file):/i.test(target)) throw new Error("Открываются только ссылки http(s), mailto, ftp и file.");
  if (!isUrl && !fs.existsSync(target)) throw new Error(`не найдено: ${target}`);
  if (IS_WIN) {
    // без cmd.exe: символы & | ^ в пути или ссылке не превращаются в команды
    const dir = !isUrl && fs.statSync(target).isDirectory();
    const [exe, args] = dir ? ["explorer.exe", [target]] : ["rundll32.exe", ["url.dll,FileProtocolHandler", target]];
    spawn(exe, args, { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
  } else spawn("xdg-open", [target], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
  return `Открыто: ${target}`;
}

export function drives(): string[] {
  if (!IS_WIN) return ["/"];
  const out: string[] = [];
  for (let c = 67; c <= 90; c++) {
    const d = `${String.fromCharCode(c)}:\\`;
    try {
      if (fs.existsSync(d)) out.push(d);
    } catch {}
  }
  return out;
}

// ───────────── картинки ─────────────

export const IMAGE_MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const IMAGE_CONVERTIBLE = new Set([".bmp", ".tif", ".tiff", ".ico", ".jfif"]);
const IMAGE_MAX = 3_500_000;

export function isImagePath(p: string): boolean {
  const e = path.extname(p).toLowerCase();
  return e in IMAGE_MIME || IMAGE_CONVERTIBLE.has(e);
}

/** Читает картинку для агента; большие и редкие форматы — уменьшает до 1600px JPEG через System.Drawing. */
export function loadImage(file: string): ToolResult {
  const st = fs.statSync(file);
  if (st.isDirectory()) throw new Error("это папка, а не картинка");
  const ext = path.extname(file).toLowerCase();
  let mime = IMAGE_MIME[ext];
  let buf: Buffer;
  let note = "";
  if (mime && st.size <= IMAGE_MAX) {
    buf = fs.readFileSync(file);
  } else {
    if (!mime && !IMAGE_CONVERTIBLE.has(ext)) throw new Error(`не картинка (${ext || "без расширения"}): поддерживаются png, jpg, gif, webp, bmp, tiff`);
    if (!IS_WIN) throw new Error("картинка слишком большая");
    const out = path.join(os.tmpdir(), `jc-img-${process.pid}-${Date.now()}.jpg`);
    const esc = (s: string) => `'${s.replace(/'/g, "''")}'`;
    const script =
      `Add-Type -AssemblyName System.Drawing; $s=[System.Drawing.Image]::FromFile(${esc(file)}); try { ` +
      `$k=[Math]::Min(1.0, 1600/[Math]::Max($s.Width,$s.Height)); $w=[int][Math]::Max(1,$s.Width*$k); $h=[int][Math]::Max(1,$s.Height*$k); ` +
      `$b=New-Object System.Drawing.Bitmap $w,$h; $g=[System.Drawing.Graphics]::FromImage($b); $g.InterpolationMode='HighQualityBicubic'; ` +
      `$g.Clear([System.Drawing.Color]::White); $g.DrawImage($s,0,0,$w,$h); $g.Dispose(); ` +
      `$c=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }; ` +
      `$p=New-Object System.Drawing.Imaging.EncoderParameters 1; $p.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, [long]85); ` +
      `$b.Save(${esc(out)}, $c, $p); $b.Dispose(); "$($s.Width)x$($s.Height)" } finally { $s.Dispose() }`;
    const enc = Buffer.from(script, "utf16le").toString("base64");
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", enc], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
    if (r.status !== 0 || !fs.existsSync(out)) throw new Error(`не удалось открыть картинку: ${String(r.stderr || r.stdout || "").trim().slice(0, 300)}`);
    buf = fs.readFileSync(out);
    try {
      fs.unlinkSync(out);
    } catch {}
    mime = "image/jpeg";
    note = `, уменьшено до JPEG ≤1600px (оригинал ${String(r.stdout ?? "").trim()})`;
  }
  return { text: `Картинка ${path.basename(file)}, ${formatSize(st.size)}${note}`, image: { data: buf.toString("base64"), mimeType: mime } };
}

// ───────────── описание инструментов ─────────────

export interface ToolResult {
  text: string;
  diff?: string[];
  /** id резервной копии файла до правки — для кнопки «Отменить». */
  undo?: string;
  /** Картинка для агента (MCP image content), base64 без префикса data:. */
  image?: { data: string; mimeType: string };
  /** Картинка на диске — миниатюра в карточке инструмента (снимок экрана, буфер обмена). */
  preview?: string;
}
export interface ToolItemPatch {
  status: "waiting" | "running" | "ok" | "error" | "denied";
  ms?: number;
  result?: string;
  output?: string;
  diff?: string[];
  undo?: string;
  preview?: string;
}
export interface ApprovalRequest {
  tool: string;
  heading: string;
  summary: string;
  detail?: string;
  pattern?: string;
  reason: string;
  risk?: Risk;
  cwd?: string;
}
export interface TodoItem {
  text: string;
  status: "pending" | "in_progress" | "done";
}

export interface ToolContext {
  cfg: Config;
  mode: Mode;
  project: string;
  sessionAllow: string[];
  signal: AbortSignal;
  ask(req: ApprovalRequest): Promise<{ answer: "yes" | "always" | "no"; feedback?: string }>;
  /** Создаёт элемент «инструмент» в чате и возвращает функцию его обновления. */
  track(tool: string, label: string, summary: string): (patch: ToolItemPatch) => void;
  /** План задачи (nc_todo) — показывается над полем ввода. */
  setTodos?(items: TodoItem[]): void;
  /** Добавлять к картинкам распознанный текст (настройка OCR): снимки экрана, буфер, nc_view_image. */
  textOnly?: boolean;
  sessionId?: string;
}

// ───────────── единый реестр: реализация + описание для relay-протокола и MCP ─────────────

type ParamType = "string" | "number" | "boolean" | "array" | "object";
export interface ParamSpec {
  type: ParamType;
  description: string;
  items?: Record<string, unknown>;
  enum?: string[];
}
export interface ToolSpec {
  /** Описание для агента (английский — агенты лучше следуют). */
  description: string;
  params: Record<string, ParamSpec>;
  required?: string[];
  readOnly?: boolean;
  destructive?: boolean;
}

interface ToolDef {
  label: string;
  kind: ToolKind | ((a: any) => ToolKind);
  spec: ToolSpec;
  /** Дополнительная проверка аргументов сверх типов. */
  check?: (a: any) => string | null;
  summary: (a: any) => string;
  paths?: (a: any, r: (p?: unknown) => string) => string[];
  command?: (a: any) => string | undefined;
  run: (a: any, ctx: ToolContext, r: (p?: unknown) => string) => ToolResult | Promise<ToolResult>;
  short?: (text: string) => string;
  /** Видит только имена файлов — секретные зоны не проверяются. */
  namesOnly?: boolean;
}

const P = {
  str: (description: string): ParamSpec => ({ type: "string", description }),
  num: (description: string): ParamSpec => ({ type: "number", description }),
  bool: (description: string): ParamSpec => ({ type: "boolean", description }),
};
const oneLine = (s: string, n = 90) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};
const firstLines = (t: string, n = 3) => {
  const l = t.split(/\r?\n/);
  return l.slice(0, n).join("\n") + (l.length > n ? `\n… +${l.length - n} строк` : "");
};

const typeOk = (t: ParamType, v: unknown) =>
  t === "array" ? Array.isArray(v) : t === "object" ? !!v && typeof v === "object" && !Array.isArray(v) : typeof v === t;

/** Подпись для relay-протокола: «nc_read_file {path, offset?, limit?}». */
export function signature(name: string, spec: ToolSpec): string {
  const req = new Set(spec.required ?? []);
  return `${name} {${Object.keys(spec.params)
    .map((k) => (req.has(k) ? k : `${k}?`))
    .join(", ")}}`;
}

/** Проверка аргументов по описанию инструмента. */
export function validateArgs(name: string, spec: ToolSpec, a: Record<string, unknown>): string | null {
  for (const k of spec.required ?? []) if (a[k] === undefined || a[k] === null) return `${signature(name, spec)} — нет «${k}»`;
  for (const [k, p] of Object.entries(spec.params)) {
    const v = a[k];
    if (v === undefined || v === null) continue;
    if (!typeOk(p.type, v)) return `${signature(name, spec)} — «${k}» должен быть ${p.type}`;
    if (p.enum && !p.enum.includes(String(v))) return `«${k}»: одно из ${p.enum.join(" | ")}`;
  }
  return null;
}

/** JSON Schema для MCP tools/list. */
export function jsonSchema(spec: ToolSpec) {
  const properties: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(spec.params))
    properties[k] = { type: p.type, description: p.description, ...(p.items ? { items: p.items } : {}), ...(p.enum ? { enum: p.enum } : {}) };
  return { type: "object" as const, properties, required: spec.required ?? [], additionalProperties: false };
}

const EDIT_ITEM = {
  type: "object",
  properties: {
    old_string: { type: "string", description: "Exact text to replace" },
    new_string: { type: "string", description: "Replacement" },
    replace_all: { type: "boolean", description: "Replace every occurrence" },
  },
  required: ["old_string", "new_string"],
};
const TODO_ITEM = {
  type: "object",
  properties: {
    text: { type: "string", description: "Step, imperative (e.g. «Add tests»)" },
    status: { type: "string", enum: ["pending", "in_progress", "done"] },
  },
  required: ["text", "status"],
};

export const TOOLS: Record<string, ToolDef> = {
  nc_status: {
    label: "Состояние ПК",
    kind: "read",
    spec: { description: "PC facts: OS, user, home, drives, shell, mode, base folder.", params: {}, readOnly: true },
    summary: () => "",
    run: (_a, ctx, r) => ({
      text: [
        `app: Jarvis Code ${VERSION} desktop`,
        `mode: ${ctx.mode}`,
        `project: ${ctx.project}`,
        `fileScope: ${ctx.cfg.fileScope}`,
        `os: ${os.type()} ${os.release()} (${process.platform}, ${os.arch()})`,
        `shell: ${IS_WIN ? ctx.cfg.shell : "bash"}`,
        `user: ${os.userInfo().username}`,
        `home: ${os.homedir()}`,
        `drives: ${drives().join(" ")}`,
        `NOTION.md: ${fs.existsSync(r("NOTION.md")) ? "yes" : "no"}`,
      ].join("\n"),
    }),
    short: () => "ok",
  },
  nc_list_dir: {
    label: "Просмотр папки",
    kind: "read",
    spec: {
      description: "List a folder on the user's PC (any absolute path, ~ and %ENV% expanded).",
      params: { path: P.str("Folder path. Default: base folder"), recursive: P.bool("Recurse (skips node_modules, .git, …)") },
      readOnly: true,
    },
    summary: (a) => `${a.path ?? "."}${a.recursive ? " (рекурсивно)" : ""}`,
    paths: (a, r) => [r(a.path)],
    namesOnly: true,
    run: (a, _c, r) => ({ text: listDir(r(a.path), !!a.recursive) }),
    short: (t) => `Элементов: ${Math.max(0, t.split("\n").length - 1)}`,
  },
  nc_read_file: {
    label: "Чтение файла",
    kind: "read",
    spec: {
      description: "Read a text file with line numbers (any encoding: UTF-8/16, windows-1251).",
      params: { path: P.str("File path"), offset: P.num("First line (1-based)"), limit: P.num("Max lines (default 2000)") },
      required: ["path"],
      readOnly: true,
    },
    summary: (a) => String(a.path),
    paths: (a, r) => [r(a.path)],
    run: (a, _c, r) => ({ text: readFile(r(a.path), a.offset ?? 1, a.limit ?? 2000) }),
    short: (t) => `Прочитано строк: ${t.split("\n").filter((l) => /^\s*\d+\t/.test(l)).length}`,
  },
  nc_search: {
    label: "Поиск в файлах",
    kind: "read",
    spec: {
      description: "Search file contents by regex (ripgrep when available).",
      params: { pattern: P.str("Regex"), path: P.str("Folder or file"), glob: P.str("File mask, e.g. *.ts"), ignore_case: P.bool("Default true") },
      required: ["pattern"],
      readOnly: true,
    },
    summary: (a) => `«${a.pattern}» в ${a.path ?? "."}${a.glob ? ` (${a.glob})` : ""}`,
    paths: (a, r) => [r(a.path)],
    run: async (a, c, r) => ({ text: await search(r(a.path), a.pattern, a.glob ?? undefined, a.ignore_case ?? true, 200, c.signal) }),
    short: (t) => (/^Совпадений нет/.test(t) ? "Совпадений нет" : `Найдено строк: ${t.split("\n").length}`),
  },
  nc_find_files: {
    label: "Поиск файлов",
    kind: "read",
    spec: {
      description: "Find files/folders by name or mask, e.g. across a whole drive.",
      params: { name: P.str("Name part or mask (*.pdf)"), path: P.str("Where to search, e.g. C:\\ or ~") },
      required: ["name"],
      readOnly: true,
    },
    summary: (a) => `${a.name} в ${a.path ?? "."}`,
    paths: (a, r) => [r(a.path)],
    namesOnly: true,
    run: async (a, c, r) => ({ text: await findFiles(r(a.path), a.name, 200, c.signal) }),
    short: (t) => (/^Ничего/.test(t) ? "Ничего не найдено" : `Найдено: ${t.split("\n").filter((l) => !l.startsWith("…") && !l.startsWith("(")).length}`),
  },
  nc_write_file: {
    label: "Создание файла",
    kind: "write",
    spec: {
      description: "Create or overwrite a text file. Existing files keep their encoding, BOM and line endings.",
      params: { path: P.str("File path"), content: P.str("Full content") },
      required: ["path", "content"],
    },
    summary: (a) => String(a.path),
    paths: (a, r) => [r(a.path)],
    run: (a, _c, r) => {
      const res = writeFile(r(a.path), a.content);
      return { text: res.message, diff: res.diff, undo: res.undo };
    },
  },
  nc_edit_file: {
    label: "Изменение файла",
    kind: "write",
    spec: {
      description: "Replace an exact fragment in a file. Read the file first; old_string must match exactly (indentation included).",
      params: {
        path: P.str("File path"),
        old_string: P.str("Exact text to replace"),
        new_string: P.str("Replacement"),
        replace_all: P.bool("Replace every occurrence"),
      },
      required: ["path", "old_string", "new_string"],
    },
    summary: (a) => String(a.path),
    paths: (a, r) => [r(a.path)],
    run: (a, _c, r) => {
      const res = editFile(r(a.path), a.old_string, a.new_string, !!a.replace_all);
      return { text: res.message, diff: res.diff, undo: res.undo };
    },
  },
  nc_multi_edit: {
    label: "Изменение файла",
    kind: "write",
    spec: {
      description: "Several exact replacements in ONE file in one call, applied in order (all or nothing). Faster than many nc_edit_file calls.",
      params: { path: P.str("File path"), edits: { type: "array", description: "List of {old_string, new_string, replace_all?}", items: EDIT_ITEM } },
      required: ["path", "edits"],
    },
    check: (a) =>
      a.edits.length && a.edits.every((e: any) => e && typeof e.old_string === "string" && typeof e.new_string === "string")
        ? null
        : "edits: [{old_string: string, new_string: string, replace_all?: boolean}]",
    summary: (a) => `${a.path} (${a.edits?.length ?? 0} правок)`,
    paths: (a, r) => [r(a.path)],
    run: (a, _c, r) => {
      const res = editFile(r(a.path), a.edits as Edit[]);
      return { text: res.message, diff: res.diff, undo: res.undo };
    },
  },
  nc_run: {
    label: IS_WIN ? "Команда PowerShell" : "Команда bash",
    kind: "exec",
    spec: {
      description:
        "Run a PowerShell command/script on the PC (up to 55 s) and return output + exit code. Prefer ONE complete script for multi-step work. Use nc_job_start for long tasks.",
      params: { command: P.str("PowerShell code"), cwd: P.str("Working folder"), timeout_sec: P.num("1–55, default 25") },
      required: ["command"],
      destructive: true,
    },
    summary: (a) => oneLine(a.command),
    command: (a) => a.command,
    paths: (a, r) => [r(a.cwd)],
    run: async (a, ctx, r) => ({ text: await runCommand(ctx.cfg, a.command, r(a.cwd), a.timeout_sec ?? undefined, ctx.signal) }),
    short: (t) => firstLines(t, 3),
  },
  nc_job_start: {
    label: "Фоновая команда",
    kind: "exec",
    spec: {
      description: "Start a long-running command in the background (dev server, build, tests); poll with nc_job_status.",
      params: { command: P.str("PowerShell code"), cwd: P.str("Working folder") },
      required: ["command"],
    },
    summary: (a) => oneLine(a.command),
    command: (a) => a.command,
    paths: (a, r) => [r(a.cwd)],
    run: (a, ctx, r) => {
      const j = startJob(ctx.cfg, a.command, r(a.cwd), ctx.sessionId || "");
      const stop = () => killTree(j.child);
      ctx.signal.addEventListener("abort", stop, { once: true });
      j.child.once("close", () => ctx.signal.removeEventListener("abort", stop));
      return { text: `Запущена ${j.id}. Проверяйте nc_job_status(id="${j.id}", wait_sec=20).` };
    },
  },
  nc_job_status: {
    label: "Статус задачи",
    kind: "read",
    spec: {
      description: "Status and output tail of a background job.",
      params: { id: P.str("Job id, e.g. job1"), tail_lines: P.num("Lines of output (default 80)"), wait_sec: P.num("Wait up to N s (max 25) for completion") },
      required: ["id"],
      readOnly: true,
    },
    summary: (a) => String(a.id),
    run: async (a, ctx) => ({ text: await jobStatus(a.id, a.tail_lines ?? 80, a.wait_sec ?? 0, ctx.sessionId || "") }),
    short: (t) => t.split("\n")[0],
  },
  nc_job_kill: {
    label: "Остановка задачи",
    kind: (a) => (a.id ? "exec" : "read"),
    spec: { description: "Stop a background job (or list jobs when id is omitted).", params: { id: P.str("Job id") } },
    summary: (a) => a.id ?? "список",
    command: (a) => (a.id ? `kill ${a.id}` : undefined),
    run: (a, ctx) => ({ text: killJob(a.id ?? undefined, ctx.sessionId || "") }),
  },
  nc_open: {
    label: "Открытие",
    kind: "exec",
    spec: {
      description: "Open a file, folder, program or URL on the PC (like double-click). URLs: http(s), mailto, ftp, file.",
      params: { target: P.str("Path or URL") },
      required: ["target"],
    },
    summary: (a) => String(a.target),
    command: (a) => `open ${a.target}`,
    run: (a, _c, r) => ({ text: openTarget(/^[a-z][a-z0-9+.-]*:/i.test(a.target) && !/^[a-z]:[\\/]/i.test(a.target) ? a.target : r(a.target)) }),
  },
  nc_view_image: {
    label: "Просмотр картинки",
    kind: "read",
    spec: {
      description:
        "Look at an image file on the PC (png, jpg, gif, webp, bmp, tiff; big ones are downscaled). Use it for screenshots/photos the user attached in Jarvis Code (<attached_image> paths) and video frame sheets.",
      params: { path: P.str("Image file path") },
      required: ["path"],
      readOnly: true,
    },
    summary: (a) => String(a.path),
    paths: (a, r) => [r(a.path)],
    run: async (a, ctx, r) => {
      const file = r(a.path);
      const res = loadImage(file);
      return ctx.textOnly ? { ...res, text: `${res.text}\n${ocrNote(await ocrImage(file, ctx.signal))}` } : res;
    },
    short: (t) => t.split("\n")[0],
  },
  nc_screenshot: {
    label: "Снимок экрана",
    kind: "observe",
    spec: {
      description:
        "Screenshot of the user's screen (primary monitor; all=true — every monitor) to see open windows, errors, dialogs, UI state. Asks the user first. The Jarvis Code window is hidden for the shot; the PNG is saved on the PC. ocr=true also returns the recognized text.",
      params: { all: P.bool("All monitors (default: primary only)"), ocr: P.bool("Also return recognized text (Windows OCR)") },
      readOnly: true,
    },
    summary: (a) => (a.all ? "все мониторы" : "основной монитор") + (a.ocr ? " + текст" : ""),
    run: async (a, ctx) => {
      const shot = await screenshot({ all: !!a.all, signal: ctx.signal });
      const img = loadImage(shot.preview);
      const lines = [`Снимок экрана ${shot.width}×${shot.height}: ${shot.file}`];
      if (ctx.textOnly || a.ocr) lines.push(ocrNote(await ocrImage(shot.file, ctx.signal), !ctx.textOnly));
      return { text: lines.join("\n"), image: img.image, preview: shot.preview };
    },
    short: (t) => t.split("\n")[0].replace(/:.*$/, ""),
  },
  nc_clipboard: {
    label: "Буфер обмена",
    kind: (a) => (a.action === "set" ? "write" : "observe"),
    spec: {
      description:
        "Read the Windows clipboard — text, copied files or an image (asks the user first) — or put text into it (action=set) so the user can paste it.",
      params: { action: { type: "string", description: "get (default) | set", enum: ["get", "set"] }, text: P.str("Text to copy (action=set)") },
    },
    check: (a) => (a.action === "set" && typeof a.text !== "string" ? "text: string (для action=set)" : null),
    summary: (a) => (a.action === "set" ? `копировать: ${oneLine(String(a.text ?? ""), 60)}` : "прочитать"),
    run: async (a, ctx) => {
      if (a.action === "set") {
        if (!(await setClipboard(String(a.text)))) throw new Error("не удалось записать в буфер обмена");
        return { text: `Скопировано в буфер обмена: ${String(a.text).length} симв.` };
      }
      const c = await readClipboard(ctx.signal);
      const lines: string[] = [];
      if (c.text) lines.push(`Текст (${c.text.length} симв.):\n${truncate(c.text, 30_000)}`);
      if (c.files.length) lines.push(`Скопированные файлы (${c.files.length}):\n${c.files.slice(0, 100).join("\n")}${c.files.length > 100 ? "\n…" : ""}`);
      let image: ToolResult["image"];
      if (c.image) {
        image = loadImage(c.image.preview).image;
        lines.push(`Картинка ${c.image.width}×${c.image.height}: ${c.image.file}`);
        if (ctx.textOnly) lines.push(ocrNote(await ocrImage(c.image.file, ctx.signal)));
      }
      return { text: lines.join("\n\n") || "Буфер обмена пуст.", image, preview: c.image?.preview };
    },
    short: (t) => (t.startsWith("Текст") ? t.split("\n")[0].replace(/:$/, "") : t.split("\n")[0]),
  },
  nc_trash: {
    label: "В корзину",
    kind: "delete",
    spec: {
      description:
        "Delete files/folders by moving them to the Recycle Bin (the user can restore them). Use it instead of Remove-Item/del in nc_run. Drive roots, system and main user folders are refused.",
      params: { paths: { type: "array", description: "Files or folders to delete", items: { type: "string" } } },
      required: ["paths"],
      destructive: true,
    },
    check: (a) => (a.paths.length && a.paths.length <= 200 && a.paths.every((p: unknown) => typeof p === "string" && p.trim()) ? null : "paths: [string] (1–200 путей)"),
    summary: (a) =>
      a.paths.length === 1
        ? String(a.paths[0])
        : `${a.paths.length} ${plural(a.paths.length, "объект", "объекта", "объектов")}: ${a.paths.slice(0, 3).map((p: string) => path.basename(p)).join(", ")}${a.paths.length > 3 ? ", …" : ""}`,
    paths: (a, r) => a.paths.map((p: string) => r(p)),
    run: async (a, ctx, r) => {
      const res = await moveToTrash(a.paths.map((p: string) => r(p)), ctx.signal);
      const failed = res.failed.map((f) => `  ${f.path} — ${f.error}`);
      if (!res.done.length) throw new Error(`ничего не удалено:\n${failed.join("\n")}`);
      return {
        text: [
          `В корзину (можно восстановить): ${res.done.length}`,
          ...res.done.map((p) => `  ${p}`),
          ...(failed.length ? [`Не удалось: ${failed.length}`, ...failed] : []),
        ].join("\n"),
      };
    },
    short: (t) => t.split("\n")[0].replace(" (можно восстановить)", "") + (/\nНе удалось: (\d+)/.test(t) ? ` · не удалось: ${t.match(/\nНе удалось: (\d+)/)![1]}` : ""),
  },
  nc_todo: {
    label: "План",
    kind: "read",
    spec: {
      description:
        "Show/update the task checklist in Jarvis Code (the user sees it live above the input). Use for tasks with 3+ steps: send the FULL list each time, exactly one item in_progress.",
      params: { items: { type: "array", description: "Full list of {text, status: pending|in_progress|done}", items: TODO_ITEM } },
      required: ["items"],
      readOnly: true,
    },
    check: (a) =>
      a.items.every((x: any) => x && typeof x.text === "string" && ["pending", "in_progress", "done"].includes(x.status))
        ? null
        : "items: [{text: string, status: pending|in_progress|done}]",
    summary: (a) => {
      const done = a.items.filter((x: TodoItem) => x.status === "done").length;
      const cur = a.items.find((x: TodoItem) => x.status === "in_progress");
      return `${done}/${a.items.length}${cur ? ` · ${oneLine(cur.text, 60)}` : ""}`;
    },
    run: (a, ctx) => {
      const items: TodoItem[] = a.items.slice(0, 30).map((x: TodoItem) => ({ text: oneLine(String(x.text), 200), status: x.status }));
      ctx.setTodos?.(items);
      return { text: `Checklist updated (${items.filter((x) => x.status === "done").length}/${items.length} done).` };
    },
    short: () => "обновлён",
  },
};

export const TOOL_NAMES = Object.keys(TOOLS);

/** Распознанный текст картинки — для режима, где агенту нельзя передать изображение. */
function ocrNote(text: string | null, extra = false): string {
  const head = extra ? "Текст на картинке (Windows OCR)" : "В этом режиме картинку агенту не передать — текст на ней (Windows OCR)";
  if (text === null) return extra ? "Распознать текст не удалось (нужна Windows 10/11)." : "В этом режиме картинку агенту не передать, а распознать текст не удалось — попросите пользователя описать её.";
  return text.trim() ? `${head}:\n${text.trim()}` : `${head}: текста не найдено.`;
}

/** Строка инструментов для relay-протокола. */
export const TOOL_SIGNATURES = Object.entries(TOOLS)
  .map(([name, d]) => signature(name, d.spec) + (name === "nc_run" ? " (PowerShell, up to 55 s)" : ""))
  .join("; ");


/** Выполняет один вызов с проверкой прав и отображением в чате. */
export async function executeCall(call: ToolCall, ctx: ToolContext): Promise<{ ok: boolean; text: string; image?: ToolResult["image"] }> {
  if (call.error) return { ok: false, text: call.error };
  const def = TOOLS[call.tool];
  if (!def) return { ok: false, text: `Unknown tool ${call.tool}. Available: ${TOOL_NAMES.join(", ")}` };
  const args = (call.args && typeof call.args === "object" ? call.args : {}) as Record<string, unknown>;
  const bad = validateArgs(call.tool, def.spec, args) ?? def.check?.(args) ?? null;
  if (bad) return { ok: false, text: `Invalid arguments for ${call.tool}: expected ${bad}` };

  const r = (p?: unknown) => resolvePath(ctx.project, p);
  const kind = typeof def.kind === "function" ? def.kind(args) : def.kind;
  const summary = def.summary(args);
  const command = def.command?.(args);
  const paths = def.paths?.(args, r) ?? [];
  const update = ctx.track(call.tool, def.label, summary);
  const transfer=harness.policy(ctx.project);
  const blocked=gateTool(transfer,ctx.project,call.tool,paths);
  if(blocked){update({status:"denied",result:blocked});harness.tool(ctx.sessionId||"",call.tool,args,false,"TRANSFER_POLICY_DENIED");return {ok:false,text:blocked};}

  let d = decide({ cfg: ctx.cfg, mode: ctx.mode, kind, project: ctx.project, paths, command, sessionAllow: ctx.sessionAllow, namesOnly: def.namesOnly, tool: call.tool });
  const restriction = projectDecision(controls.policy(ctx.project), kind, paths, command);
  if (restriction.action === "deny" || (restriction.action === "ask" && d.action !== "deny")) d = { ...restriction, risk: "high" };
  // Secrets and global hard-denies remain enforced by decide; project rules never relax them.
  if (d.action === "deny") {
    update({ status: "denied", result: d.reason });
    audit({ tool: call.tool, summary, result: "denied", reason: d.reason });
    harness.tool(ctx.sessionId||"",call.tool,args,false,"POLICY_DENIED");
    return { ok: false, text: `Denied by Jarvis Code policy: ${d.reason}` };
  }
  if (d.action === "ask") {
    update({ status: "waiting" });
    const pattern = call.tool === "nc_open" ? undefined : d.remember;
    const { answer, feedback } = await ctx.ask({
      tool: call.tool,
      heading: def.label,
      summary,
      detail: command ?? (paths.length ? paths.join("\n") : undefined),
      pattern,
      reason: d.reason,
      risk: d.risk,
      cwd: command ? paths[0] : undefined,
    });
    if (answer === "no") {
      update({ status: "denied", result: feedback ? `Отклонено: ${feedback}` : "Отклонено пользователем" });
      audit({ tool: call.tool, summary, result: "user_rejected", feedback });
      harness.approval(ctx.sessionId||"","denied");
      harness.tool(ctx.sessionId||"",call.tool,args,false,"USER_DENIED");
      return {
        ok: false,
        text: feedback
          ? `The user rejected this action and says: ${feedback}`
          : "The user rejected this action. Ask how to proceed or suggest another approach.",
      };
    }
    harness.approval(ctx.sessionId||"",answer);
    if (answer === "always" && pattern) ctx.sessionAllow.push(pattern);
  }
  update({ status: "running" });
  const t0 = performance.now();
  try {
    if (ctx.signal.aborted) throw new Error("Задача остановлена пользователем");
    const res = await def.run(args, ctx, r);
    if ((call.tool === "nc_run" || call.tool === "nc_job_status") && (/exit code:\s*(?!0\b)(?:-?\d+|null)/i.test(res.text) || /^(Ошибка запуска|⏱)/.test(res.text))) throw new Error(res.text);
    const ms = Math.round(performance.now() - t0);
    const rawText = redactSecrets(res.text, ctx.cfg);
    const text = transfer.scanSecrets ? redactTransfer(rawText) : rawText;
    harness.tool(ctx.sessionId||"",call.tool,args,true,text,ms);
    update({ status: "ok", ms, result: def.short ? def.short(text) : firstLines(text, 2), output: truncate(text, 20_000), diff: res.diff, undo: res.undo, preview: res.preview });
    audit({ tool: call.tool, summary, result: "ok" });
    return { ok: true, text, image: transfer.images ? res.image : undefined };
  } catch (e: any) {
    const msg = redactTransfer(redactSecrets(e?.message ?? String(e), ctx.cfg));
    harness.tool(ctx.sessionId||"",call.tool,args,false,msg,Math.round(performance.now()-t0));
    update({ status: "error", ms: Math.round(performance.now() - t0), result: msg });
    audit({ tool: call.tool, summary, result: "error", error: msg });
    return { ok: false, text: `Error: ${msg}` };
  }
}

/** Только чтение: такие вызовы можно выполнять параллельно. */
export function isReadOnly(call: ToolCall): boolean {
  const def = TOOLS[call.tool];
  if (!def || call.error) return false;
  const args = (call.args && typeof call.args === "object" ? call.args : {}) as Record<string, unknown>;
  return (typeof def.kind === "function" ? def.kind(args) : def.kind) === "read";
}

const SPECULATIVE = new Set(["nc_status", "nc_list_dir", "nc_read_file", "nc_search", "nc_find_files"]);

/** Можно ли начать вызов заранее, пока агент ещё дописывает ответ (чтение без подтверждений). */
export function canStartEarly(call: ToolCall, o: { cfg: Config; mode: Mode; project: string; sessionAllow: string[] }): boolean {
  if (call.error || !SPECULATIVE.has(call.tool)) return false;
  const def = TOOLS[call.tool];
  const args = (call.args && typeof call.args === "object" ? call.args : {}) as Record<string, unknown>;
  if (!def || validateArgs(call.tool, def.spec, args) || def.check?.(args)) return false;
  const r = (p?: unknown) => resolvePath(o.project, p);
  return decide({ cfg: o.cfg, mode: o.mode, kind: "read", project: o.project, paths: def.paths?.(args, r) ?? [], sessionAllow: o.sessionAllow, namesOnly: def.namesOnly }).action === "allow";
}

export function callKey(call: ToolCall): string {
  return call.tool + " " + JSON.stringify(call.args ?? {});
}

let knownFolders: Record<string, string> = {};
export function setKnownFolders(f: Record<string, string>) {
  knownFolders = f;
}
/** Известная папка Windows (desktop, documents, downloads) — если уже определена. */
export function knownFolder(key: string): string | undefined {
  return knownFolders[key] || undefined;
}

/** Основные сведения о ПК — отправляются агенту сразу, без лишнего круга nc_status. */
export function pcSummary(cfg: Config): string[] {
  const folders = Object.entries(knownFolders)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  return [
    `os: ${os.type()} ${os.release()} (${process.platform}, ${os.arch()}); shell for nc_run: ${IS_WIN ? cfg.shell : "bash"}`,
    `user: ${os.userInfo().username}; home: ${os.homedir()}; drives: ${drives().join(" ")}`,
    ...(folders ? [`folders: ${folders}`] : []),
  ];
}

export function pcInfo(cfg: Config, project: string): string {
  let listing = "";
  try {
    const entries = fs
      .readdirSync(project, { withFileTypes: true })
      .filter((e) => !e.name.startsWith("$") && !/^(desktop\.ini|NTUSER\.DAT.*|ntuser\..*)$/i.test(e.name))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    listing = entries
      .slice(0, 50)
      .map((e) => e.name + (e.isDirectory() ? "/" : ""))
      .join(", ");
    if (entries.length > 50) listing += `, … (${entries.length} total)`;
  } catch {}
  const memo = projectMemory(project);
  const git = gitBrief(project);
  return [
    "<pc_info>",
    ...pcSummary(cfg),
    `project (base for relative paths): ${project}`,
    ...(listing ? [`project top level: ${listing}`] : []),
    ...(git ? [`git: ${git}`] : []),
    "</pc_info>",
    ...(memo ? [`<project_notes file="${memo.file}" note="Project memory written by the user/agent — follow it.">\n${memo.text}\n</project_notes>`] : []),
  ].join("\n");
}

/** NOTION.md (или AGENTS.md / CLAUDE.md) — память проекта, сразу в контекст: агенту не нужен отдельный шаг чтения. */
export function projectMemory(project: string, limit = 6000): { file: string; text: string } | null {
  for (const name of ["NOTION.md", "JARVIS.md", "AGENTS.md", "CLAUDE.md"]) {
    const f = path.join(project, name);
    try {
      const st = fs.statSync(f);
      if (!st.isFile()) continue;
      const { text } = decodeBuffer(fs.readFileSync(f));
      return { file: name, text: text.length > limit ? text.slice(0, limit) + `\n… (${text.length} chars total — read the rest with nc_read_file)` : text };
    } catch {}
  }
  return null;
}

/** Ветка и изменённые файлы git (быстро, с тайм-аутом) — меньше разведки у агента. */
export function gitBrief(project: string): string {
  try {
    let d = path.resolve(project);
    let found = false;
    for (let i = 0; i < 6; i++) {
      if (fs.existsSync(path.join(d, ".git"))) {
        found = true;
        break;
      }
      const up = path.dirname(d);
      if (up === d) break;
      d = up;
    }
    if (!found || d === path.resolve(os.homedir())) return "";
    const r = spawnSync("git", ["-C", project, "status", "--short", "--branch", "--untracked-files=normal"], { encoding: "utf8", timeout: 1500, windowsHide: true });
    if (r.status !== 0 || !r.stdout) return "";
    const lines = r.stdout.trim().split(/\r?\n/);
    const branch = (lines.shift() ?? "").replace(/^## /, "");
    const changed = lines.slice(0, 15).map((l) => l.trim()).join(", ");
    return `branch ${branch}${lines.length ? `; changed (${lines.length}): ${changed}${lines.length > 15 ? ", …" : ""}` : "; clean"}`;
  } catch {
    return "";
  }
}
