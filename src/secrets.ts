import type { Config } from "./config";

// ───────────── скрытие токенов в выводе инструментов ─────────────

const GENERIC: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\bntn_[A-Za-z0-9]{30,}\b/g,
  /\bsecret_[A-Za-z0-9]{40,}\b/g,
];

/** Убирает из текста токены Jarvis Code (ngrok, ключ моста), токены Notion и закрытые ключи — агенту они не нужны. */
export function redactSecrets(text: string, cfg?: Config): string {
  if (!text) return text;
  let out = text;
  if (cfg) {
    const known = new Set<string>();
    if (cfg.bridge?.ngrokAuthtoken) known.add(cfg.bridge.ngrokAuthtoken);
    if (cfg.mcp?.token) known.add(cfg.mcp.token);
    for (const k of known) if (k.length >= 12 && out.includes(k)) out = out.split(k).join("[скрыто Jarvis Code]");
  }
  for (const re of GENERIC) out = out.replace(re, (m) => (m.startsWith("-----") ? "-----[закрытый ключ скрыт Jarvis Code]-----" : "[скрыто Jarvis Code]"));
  return out;
}

// ───────────── DPAPI: шифрование токенов ключом пользователя Windows ─────────────

const PREFIX = "dpapi:";
type Dpapi = { protect(b: Buffer): Buffer; unprotect(b: Buffer): Buffer };
let dpapi: Dpapi | null | undefined;

function loadDpapi(): Dpapi | null {
  if (dpapi !== undefined) return dpapi;
  dpapi = null;
  if (process.platform !== "win32" || process.env.JARVIS_NO_DPAPI) return dpapi;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ffi = require("bun:ffi");
    const { dlopen, ptr, toArrayBuffer } = ffi;
    const sig = { args: ["ptr", "ptr", "ptr", "ptr", "ptr", "u32", "ptr"], returns: "i32" };
    const crypt = dlopen("crypt32.dll", { CryptProtectData: sig, CryptUnprotectData: sig });
    const k32 = dlopen("kernel32.dll", { LocalFree: { args: ["ptr"], returns: "ptr" } });
    const call = (fn: (...a: unknown[]) => number, input: Buffer): Buffer => {
      const data = Buffer.alloc(Math.max(1, input.length));
      input.copy(data);
      const inBlob = Buffer.alloc(16);
      inBlob.writeUInt32LE(input.length, 0);
      inBlob.writeBigUInt64LE(BigInt(ptr(data)), 8);
      const outBlob = Buffer.alloc(16);
      // CRYPTPROTECT_UI_FORBIDDEN = 1
      const ok = fn(inBlob, null, null, null, null, 1, outBlob);
      if (!ok) throw new Error("DPAPI: ошибка");
      const len = outBlob.readUInt32LE(0);
      const p = Number(outBlob.readBigUInt64LE(8));
      if (!p) throw new Error("DPAPI: пустой результат");
      const out = Buffer.from(new Uint8Array(toArrayBuffer(p, 0, len)));
      k32.symbols.LocalFree(p);
      void data;
      return out;
    };
    const api: Dpapi = {
      protect: (b) => call(crypt.symbols.CryptProtectData, b),
      unprotect: (b) => call(crypt.symbols.CryptUnprotectData, b),
    };
    // самопроверка: шифруем и расшифровываем — только если всё сходится, включаем
    const probe = Buffer.from(`jarvis-selftest-${Date.now()}`);
    if (!api.unprotect(api.protect(probe)).equals(probe)) throw new Error("DPAPI: самопроверка не прошла");
    dpapi = api;
  } catch {
    dpapi = null;
  }
  return dpapi;
}

export function dpapiAvailable(): boolean {
  return !!loadDpapi();
}

/** Шифрует строку для config.json (если DPAPI недоступен — оставляет как есть). */
const cache = new Map<string, string>();
export function protectString(s: string): string {
  if (!s || s.startsWith(PREFIX)) return s;
  const hit = cache.get(s);
  if (hit) return hit;
  const api = loadDpapi();
  if (!api) return s;
  try {
    const enc = PREFIX + api.protect(Buffer.from(s, "utf8")).toString("base64");
    // проверяем, что расшифровывается обратно, — иначе храним как было
    if (unprotectString(enc) !== s) return s;
    cache.set(s, enc);
    return enc;
  } catch {
    return s;
  }
}

/** Расшифровывает строку из config.json; при неудаче возвращает исходное значение (ничего не теряется). */
export function unprotectString(s: string): string {
  if (!s || !s.startsWith(PREFIX)) return s;
  const api = loadDpapi();
  if (!api) return s;
  try {
    return api.unprotect(Buffer.from(s.slice(PREFIX.length), "base64")).toString("utf8");
  } catch {
    return s;
  }
}

export const isProtected = (s: string) => typeof s === "string" && s.startsWith(PREFIX);
