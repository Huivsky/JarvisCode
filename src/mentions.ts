/**
 * @-упоминания в поле ввода: быстрый список файлов проекта и нечёткий поиск по нему
 * (как @ в Claude Code / Cursor). git ls-files, если это репозиторий, иначе — ограниченный обход папок.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const IS_WIN = process.platform === "win32";
const SKIP = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", ".turbo", ".cache", "coverage", "bin", "obj",
  "__pycache__", ".venv", "venv", "target", ".idea", ".vs", ".gradle", "$Recycle.Bin", "System Volume Information", "AppData",
]);
const MAX_ENTRIES = 40_000;
const TTL = 15_000;

interface FileIndex {
  root: string;
  at: number;
  /** Пути относительно root, через «/»; папки — с «/» на конце. */
  entries: string[];
  truncated: boolean;
  source: "git" | "walk";
}

const cache = new Map<string, FileIndex>();
const building = new Map<string, Promise<FileIndex>>();

function gitList(root: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (v: string[] | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("git", ["-c", "core.quotepath=off", "ls-files", "-co", "--exclude-standard", "-z"], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return resolve(null);
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish(null);
    }, 4000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => {
      out += d;
      if (out.length > 16_000_000) {
        try {
          child.kill();
        } catch {}
      }
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code === 0 ? out.split("\0").filter(Boolean) : null));
  });
}

async function walkList(root: string): Promise<{ entries: string[]; truncated: boolean }> {
  const entries: string[] = [];
  const queue: [string, string, number][] = [[root, "", 0]];
  const deadline = Date.now() + 3000;
  let truncated = false;
  while (queue.length) {
    if (entries.length >= MAX_ENTRIES || Date.now() > deadline) {
      truncated = true;
      break;
    }
    const batch = queue.splice(0, 16);
    await Promise.all(
      batch.map(async ([dir, rel, depth]) => {
        let list: fs.Dirent[] = [];
        try {
          list = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of list) {
          if (entries.length >= MAX_ENTRIES) return;
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory() && !e.isSymbolicLink()) {
            if (SKIP.has(e.name) || (e.name.startsWith(".") && e.name !== ".github" && e.name !== ".vscode")) continue;
            entries.push(r + "/");
            if (depth < 10) queue.push([path.join(dir, e.name), r, depth + 1]);
          } else entries.push(r);
        }
      }),
    );
  }
  return { entries, truncated };
}

async function buildIndex(root: string): Promise<FileIndex> {
  const git = fs.existsSync(path.join(root, ".git")) || isInsideGit(root) ? await gitList(root) : null;
  if (git) {
    const dirs = new Set<string>();
    for (const f of git) {
      let i = f.lastIndexOf("/");
      while (i > 0) {
        const d = f.slice(0, i + 1);
        if (dirs.has(d)) break;
        dirs.add(d);
        i = f.lastIndexOf("/", i - 1);
      }
    }
    const entries = [...dirs, ...git].slice(0, MAX_ENTRIES);
    return { root, at: Date.now(), entries, truncated: git.length + dirs.size > MAX_ENTRIES, source: "git" };
  }
  const w = await walkList(root);
  return { root, at: Date.now(), entries: w.entries, truncated: w.truncated, source: "walk" };
}

function isInsideGit(root: string): boolean {
  let d = path.resolve(root);
  for (let i = 0; i < 12; i++) {
    const up = path.dirname(d);
    if (up === d) return false;
    d = up;
    if (fs.existsSync(path.join(d, ".git"))) return true;
  }
  return false;
}

export async function fileIndex(root: string): Promise<FileIndex> {
  const key = IS_WIN ? root.toLowerCase() : root;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit;
  let p = building.get(key);
  if (!p) {
    p = buildIndex(root).finally(() => building.delete(key));
    building.set(key, p);
  }
  // устаревший список отдаём сразу, свежий соберётся к следующему запросу
  if (hit) {
    p.then((ix) => cache.set(key, ix)).catch(() => {});
    return hit;
  }
  const ix = await p;
  cache.set(key, ix);
  if (cache.size > 12) cache.delete(cache.keys().next().value!);
  return ix;
}

/** Оценка совпадения: выше — лучше; null — не подходит. Имя файла важнее пути. */
export function matchScore(query: string, rel: string): number | null {
  const q = query.toLowerCase().replace(/\\/g, "/");
  if (!q) return 0;
  const isDir = rel.endsWith("/");
  const r = rel.toLowerCase();
  const clean = isDir ? r.slice(0, -1) : r;
  const base = clean.slice(clean.lastIndexOf("/") + 1);
  const depth = (clean.match(/\//g) ?? []).length;
  const penalty = depth * 3 + clean.length * 0.05;
  if (!q.includes("/")) {
    if (base === q) return 1000 - penalty;
    if (base.startsWith(q)) return 900 - penalty;
    const bi = base.indexOf(q);
    if (bi >= 0) return 760 - bi - penalty;
  }
  const ri = clean.indexOf(q);
  if (ri >= 0) {
    const boundary = ri === 0 || "/._-".includes(clean[ri - 1]) ? 60 : 0;
    return 620 + boundary - ri * 0.5 - penalty;
  }
  // подпоследовательность (как в fzf): буквы по порядку, бонус за начала слов и подряд идущие буквы;
  // сначала в имени файла, потом во всём пути — без слишком «размазанных» совпадений
  const inBase = subseq(q, base);
  if (inBase !== null) return 300 + inBase - penalty;
  const inPath = subseq(q, clean);
  return inPath === null ? null : 200 + inPath - penalty - (clean.length - q.length) * 0.2;
}

function subseq(q: string, s: string): number | null {
  let qi = 0;
  let score = 0;
  let run = 0;
  let last = -2;
  let first = -1;
  for (let i = 0; i < s.length && qi < q.length; i++) {
    if (s[i] !== q[qi]) continue;
    if (first < 0) first = i;
    const start = i === 0 || "/._- ".includes(s[i - 1]);
    run = i === last + 1 ? run + 1 : 0;
    score += 10 + (start ? 14 : 0) + run * 6;
    last = i;
    qi++;
  }
  if (qi < q.length || last - first > q.length * 3 + 3) return null;
  return score;
}

export interface Suggestion {
  /** Путь относительно рабочей папки (через «/»), у папок — с «/» на конце. */
  rel: string;
  path: string;
  dir: boolean;
}

export async function suggestFiles(root: string, query: string, limit = 12): Promise<{ items: Suggestion[]; truncated: boolean; source: string }> {
  const ix = await fileIndex(root);
  const q = query.trim().replace(/^[\\/]+/, "");
  let ranked: { rel: string; s: number }[];
  if (!q) {
    // пустой запрос: верхний уровень папки — сначала папки
    ranked = ix.entries
      .filter((e) => !e.slice(0, -1).includes("/"))
      .map((rel) => ({ rel, s: rel.endsWith("/") ? 1 : 0 }))
      .sort((a, b) => b.s - a.s || a.rel.localeCompare(b.rel));
  } else {
    ranked = [];
    for (const rel of ix.entries) {
      const s = matchScore(q, rel);
      if (s !== null) ranked.push({ rel, s });
    }
    ranked.sort((a, b) => b.s - a.s || a.rel.length - b.rel.length);
  }
  const items = ranked.slice(0, limit).map(({ rel }) => {
    const dir = rel.endsWith("/");
    const abs = path.join(root, ...rel.split("/").filter(Boolean));
    return { rel, path: dir ? abs + path.sep : abs, dir };
  });
  return { items, truncated: ix.truncated, source: ix.source };
}
