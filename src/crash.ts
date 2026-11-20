/**
 * Отчёты о сбоях: необработанные ошибки сохраняются в ~/.notion-code/crashes/*.json — обезличенными
 * (без токенов, ключа моста, имени пользователя, путей профиля и содержимого чатов).
 * Отправка — только если пользователь указал адрес и согласился (вручную или автоматически).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config } from "./config";
import { DATA_DIR } from "./paths";
import { redactSecrets } from "./secrets";
import { allowedUrl } from "./updater";
import { APP_NAME, VERSION } from "./version";

export const CRASH_DIR = path.join(DATA_DIR, "crashes");
const KEEP = 30;
const MAX_PER_RUN = 10;
/** Время запуска: отчёты раньше него — «с прошлого запуска». */
export const STARTED_AT = Date.now();

export type CrashKind = "uncaughtException" | "unhandledRejection" | "fatal";
export interface CrashReport {
  id: string;
  at: number;
  kind: CrashKind;
  version: string;
  message: string;
  stack?: string;
  os: { platform: string; release: string; arch: string };
  runtime: string;
  uptimeSec: number;
  memoryMb: number;
  seen?: boolean;
  sent?: boolean;
}
export interface CrashInfo {
  id: string;
  at: number;
  kind: CrashKind;
  message: string;
  sent?: boolean;
}

let cfgRef: (() => Config | undefined) | null = null;
/** Конфиг нужен, чтобы вырезать из отчётов именно ваши токены. */
export function setCrashConfig(get: () => Config | undefined) {
  cfgRef = get;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Обезличивание текста ошибки. */
export function scrub(text: string): string {
  let t = redactSecrets(String(text ?? ""), cfgRef?.() ?? undefined);
  const home = os.homedir();
  if (home && home.length > 3) {
    for (const v of new Set([home, home.replace(/\\/g, "/"), home.replace(/\//g, "\\")])) t = t.replace(new RegExp(esc(v), "gi"), "~");
  }
  let user = "";
  try {
    user = os.userInfo().username;
  } catch {}
  if (user && user.length > 2) t = t.replace(new RegExp(`(^|[^\\p{L}\\d])${esc(user)}(?=$|[^\\p{L}\\d])`, "giu"), "$1<user>");
  return t
    .replace(/\/mcp\/[a-f0-9]{16,}/gi, "/mcp/<key>")
    .replace(/[?&#](t|token|key)=[\w-]{12,}/gi, (m) => m.slice(0, m.indexOf("=") + 1) + "<key>")
    .replace(/https?:\/\/[\w.-]*(ngrok|trycloudflare)[\w.-]*[^\s"')]*/gi, "<tunnel>")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<email>")
    .replace(/\b[a-f0-9]{40,}\b/gi, "<hex>");
}

let perRun = 0;
const seenSig = new Set<string>();

/** Сохраняет отчёт; одинаковые ошибки за один запуск — один раз. */
export function recordCrash(err: unknown, kind: CrashKind): CrashReport | null {
  try {
    const e = err instanceof Error ? err : new Error(typeof err === "string" ? err : safeJson(err));
    const message = scrub(`${e.name || "Error"}: ${e.message}`).slice(0, 2000);
    const stack = e.stack ? scrub(e.stack).slice(0, 12_000) : undefined;
    const sig = crypto.createHash("sha1").update(kind + message + (stack ?? "")).digest("hex");
    if (seenSig.has(sig) || perRun >= MAX_PER_RUN) return null;
    seenSig.add(sig);
    perRun++;
    const rep: CrashReport = {
      id: `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`,
      at: Date.now(),
      kind,
      version: VERSION,
      message,
      stack,
      os: { platform: process.platform, release: os.release(), arch: process.arch },
      runtime: typeof Bun !== "undefined" ? `bun ${Bun.version}` : `node ${process.version}`,
      uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
      memoryMb: Math.round(process.memoryUsage().rss / 1048576),
    };
    fs.mkdirSync(CRASH_DIR, { recursive: true });
    fs.writeFileSync(path.join(CRASH_DIR, `${rep.id}.json`), JSON.stringify(rep, null, 2));
    prune();
    return rep;
  } catch {
    return null;
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

function prune() {
  const all = listCrashes();
  for (const r of all.slice(0, Math.max(0, all.length - KEEP))) fs.rmSync(path.join(CRASH_DIR, `${r.id}.json`), { force: true });
}

export function listCrashes(): CrashReport[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(CRASH_DIR).filter((n) => /^[\w-]+\.json$/.test(n));
  } catch {
    return [];
  }
  const out: CrashReport[] = [];
  for (const n of names) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(CRASH_DIR, n), "utf8")) as CrashReport;
      if (r && typeof r.id === "string" && typeof r.at === "number") out.push(r);
    } catch {}
  }
  return out.sort((a, b) => a.at - b.at);
}

const info = (r: CrashReport): CrashInfo => ({ id: r.id, at: r.at, kind: r.kind, message: r.message, sent: r.sent });
export const crashInfos = (): CrashInfo[] => listCrashes().map(info);

/** Для подсказки в окне: настоящие сбои с прошлых запусков, ещё не просмотренные. */
export function pendingCrashes(): CrashInfo[] {
  return listCrashes()
    .filter((r) => !r.seen && r.at < STARTED_AT && r.kind !== "unhandledRejection")
    .map(info);
}

export function markCrashes(ids: string[] | undefined, patch: { seen?: boolean; sent?: boolean }) {
  for (const r of listCrashes()) {
    if (ids?.length && !ids.includes(r.id)) continue;
    try {
      fs.writeFileSync(path.join(CRASH_DIR, `${r.id}.json`), JSON.stringify({ ...r, ...patch }, null, 2));
    } catch {}
  }
}

export function crashFile(id: string): string | null {
  const f = path.join(CRASH_DIR, `${path.basename(id)}.json`);
  return fs.existsSync(f) ? f : null;
}

/** Отправка отчётов на адрес пользователя (POST JSON). Отправленные помечаются. */
export async function sendCrashes(ids: string[] | undefined, endpoint: string): Promise<{ ok: boolean; error?: string; sent: number }> {
  if (!endpoint) return { ok: false, error: "не указан адрес для отчётов (Настройки → О программе)", sent: 0 };
  if (!allowedUrl(endpoint)) return { ok: false, error: "адрес для отчётов должен начинаться с https://", sent: 0 };
  const reports = listCrashes().filter((r) => (ids?.length ? ids.includes(r.id) : !r.sent));
  if (!reports.length) return { ok: true, sent: 0 };
  try {
    const r = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": `${APP_NAME.replace(/\s+/g, "")}/${VERSION}` },
      body: JSON.stringify({ app: APP_NAME, version: VERSION, reports: reports.map(({ seen, sent, ...x }) => x) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return { ok: false, error: `сервер ответил ${r.status}`, sent: 0 };
    markCrashes(
      reports.map((x) => x.id),
      { sent: true, seen: true },
    );
    return { ok: true, sent: reports.length };
  } catch (e) {
    return { ok: false, error: (e as Error).name === "TimeoutError" ? "сервер не ответил за 15 секунд" : (e as Error).message, sent: 0 };
  }
}

let installed = false;
/**
 * Перехват необработанных ошибок. Приложение продолжает работать (мост не рвётся);
 * если ошибки сыплются лавиной (5 за минуту) — честно завершаемся, чтобы не зависнуть в плохом состоянии.
 */
export function installCrashHandlers(onFatal?: () => void) {
  if (installed) return;
  installed = true;
  let burst: number[] = [];
  process.on("uncaughtException", (e) => {
    console.error("uncaughtException", e);
    recordCrash(e, "uncaughtException");
    const now = Date.now();
    burst = [...burst.filter((t) => now - t < 60_000), now];
    if (burst.length >= 5) {
      try {
        onFatal?.();
      } finally {
        process.exit(1);
      }
    }
  });
  process.on("unhandledRejection", (e) => {
    console.error("unhandledRejection", e);
    recordCrash(e, "unhandledRejection");
  });
}
