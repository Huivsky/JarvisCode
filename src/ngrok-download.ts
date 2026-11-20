/**
 * Автоматическая загрузка ngrok с официального сайта (bin.equinox.io — CDN ngrok) в папку данных Jarvis Code.
 * Архив скачивается по HTTPS, ngrok.exe извлекается встроенным распаковщиком zip, затем проверяется:
 * размер, подпись Authenticode (в Windows: подменённый файл отклоняется) и ответ `ngrok version`.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { DATA_DIR, IS_WIN } from "./paths";

const BASE = "https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable";
const MAX_ZIP = 200 * 1024 * 1024;

export interface NgrokDownloadProgress {
  got: number;
  total: number;
}

export function ngrokDownloadUrl(arch = process.arch): string {
  if (process.env.NC_NGROK_URL) return process.env.NC_NGROK_URL;
  const a = arch === "arm64" ? "arm64" : arch === "ia32" ? "386" : "amd64";
  const os = IS_WIN ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
  return `${BASE}-${os}-${a}.zip`;
}

export function ngrokTarget(): string {
  return path.join(DATA_DIR, "bin", IS_WIN ? "ngrok.exe" : "ngrok");
}

// ───── zip ─────

let crcTable: Uint32Array | null = null;
function crc32(buf: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Достаёт из zip один файл по имени (без учёта регистра и папок). Поддерживает store и deflate. */
export function extractFromZip(zip: Buffer, want: (name: string) => boolean): { name: string; data: Buffer } | null {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65_535); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("архив повреждён (нет каталога zip)");
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (p + 46 > zip.length || zip.readUInt32LE(p) !== 0x02014b50) throw new Error("архив повреждён (каталог zip)");
    const method = zip.readUInt16LE(p + 10);
    const crc = zip.readUInt32LE(p + 16);
    const csize = zip.readUInt32LE(p + 20);
    const usize = zip.readUInt32LE(p + 24);
    const nlen = zip.readUInt16LE(p + 28);
    const elen = zip.readUInt16LE(p + 30);
    const clen = zip.readUInt16LE(p + 32);
    const lho = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nlen).toString("utf8");
    p += 46 + nlen + elen + clen;
    if (name.endsWith("/") || !want(name.split(/[\\/]/).pop() ?? "")) continue;
    if (zip.readUInt32LE(lho) !== 0x04034b50) throw new Error("архив повреждён (заголовок файла)");
    const start = lho + 30 + zip.readUInt16LE(lho + 26) + zip.readUInt16LE(lho + 28);
    const raw = zip.subarray(start, start + csize);
    if (raw.length !== csize) throw new Error("архив обрезан");
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? zlib.inflateRawSync(raw) : null;
    if (!data) throw new Error(`неподдерживаемое сжатие zip (${method})`);
    if (data.length !== usize || crc32(data) !== crc) throw new Error("архив повреждён (контрольная сумма)");
    return { name, data };
  }
  return null;
}

// ───── проверки ─────

/** Подпись Authenticode. bad — файл подменён/подписан не ngrok; unknown — подписи нет или проверить не удалось. */
export function checkSignature(file: string): { kind: "ok" | "bad" | "unknown"; detail: string } {
  if (!IS_WIN) return { kind: "unknown", detail: "не Windows" };
  const lit = file.replace(/'/g, "''");
  const ps = `$ErrorActionPreference='Stop'; $s = Get-AuthenticodeSignature -LiteralPath '${lit}'; $subj = ''; if ($s.SignerCertificate) { $subj = $s.SignerCertificate.Subject }; Write-Output ("" + $s.Status + "|" + $subj)`;
  try {
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
    const line = (r.stdout ?? "").trim().split(/\r?\n/).pop() ?? "";
    const [status, subject = ""] = line.split("|");
    if (status === "Valid") return /ngrok/i.test(subject) ? { kind: "ok", detail: subject } : { kind: "bad", detail: `подписан не ngrok: ${subject}` };
    if (status === "HashMismatch" || status === "NotTrusted") return { kind: "bad", detail: `подпись недействительна (${status})` };
    return { kind: "unknown", detail: status || "проверка подписи недоступна" };
  } catch (e) {
    return { kind: "unknown", detail: (e as Error).message };
  }
}

export function ngrokVersion(exe: string): string | null {
  try {
    const r = spawnSync(exe, ["version"], { encoding: "utf8", windowsHide: true, timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] });
    const m = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.match(/ngrok version\s+(\d+[\w.\-]*)/i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// ───── загрузка ─────

let running: Promise<string> | null = null;

/** Скачивает ngrok (одна загрузка на процесс одновременно) и возвращает путь к исполняемому файлу. */
export function downloadNgrok(onProgress?: (p: NgrokDownloadProgress) => void, log?: (line: string) => void): Promise<string> {
  if (running) return running;
  running = doDownload(onProgress, log).finally(() => (running = null));
  return running;
}

export function ngrokDownloading(): boolean {
  return running !== null;
}

async function doDownload(onProgress?: (p: NgrokDownloadProgress) => void, log?: (line: string) => void): Promise<string> {
  const url = ngrokDownloadUrl();
  if (!/^https:\/\//i.test(url) && !process.env.NC_NGROK_URL) throw new Error("адрес загрузки не HTTPS");
  const target = ngrokTarget();
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  log?.(`Скачиваю ngrok: ${url}`);
  const ctrl = new AbortController();
  let idle: ReturnType<typeof setTimeout> | undefined;
  const bump = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => ctrl.abort(), 60_000);
  };
  bump();
  const parts: Buffer[] = [];
  let got = 0;
  let total = 0;
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: "follow", headers: { "user-agent": "JarvisCode" } });
    if (!r.ok || !r.body) throw new Error(`сервер ответил ${r.status}`);
    if (r.url && !process.env.NC_NGROK_URL && !/^https:\/\//i.test(r.url)) throw new Error("загрузку перенаправили не на HTTPS — отклонено");
    total = Number(r.headers.get("content-length")) || 0;
    if (total > MAX_ZIP) throw new Error("слишком большой архив");
    onProgress?.({ got: 0, total });
    let last = 0;
    for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
      bump();
      got += chunk.byteLength;
      if (got > MAX_ZIP) throw new Error("слишком большой архив");
      parts.push(Buffer.from(chunk));
      const now = Date.now();
      if (now - last > 200) {
        last = now;
        onProgress?.({ got, total });
      }
    }
  } catch (e) {
    throw new Error(ctrl.signal.aborted ? "загрузка зависла — нет ответа от сервера ngrok 60 с" : `нет связи с сервером ngrok (${(e as Error).message})`);
  } finally {
    if (idle) clearTimeout(idle);
  }
  if (total && got !== total) throw new Error("загрузка прервалась");
  onProgress?.({ got, total: total || got });
  const exeName = IS_WIN ? "ngrok.exe" : "ngrok";
  const entry = extractFromZip(Buffer.concat(parts), (n) => n.toLowerCase() === exeName);
  if (!entry) throw new Error(`в архиве нет ${exeName}`);
  if (entry.data.length < 1024 * 1024) throw new Error("в архиве подозрительно маленький ngrok — отклонено");
  if (IS_WIN && entry.data.subarray(0, 2).toString("latin1") !== "MZ") throw new Error("в архиве не программа Windows — отклонено");

  const tmp = `${target}.part`;
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, entry.data, { mode: 0o755 });
  try {
    const sig = checkSignature(tmp);
    if (sig.kind === "bad") throw new Error(`проверка подписи не пройдена: ${sig.detail} — файл удалён`);
    log?.(sig.kind === "ok" ? `Подпись ngrok в порядке: ${sig.detail}` : `Подпись ngrok не проверена (${sig.detail}) — файл скачан с официального сайта по HTTPS`);
    try {
      fs.rmSync(target, { force: true });
    } catch {}
    fs.renameSync(tmp, target);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  await new Promise((r) => setTimeout(r, 300));
  if (!fs.existsSync(target)) throw new Error("ngrok.exe исчез сразу после загрузки — вероятно, его удалил антивирус. Разрешите ngrok в антивирусе или скачайте вручную");
  const ver = ngrokVersion(target);
  if (!ver) {
    if (!fs.existsSync(target)) throw new Error("ngrok.exe удалён антивирусом после запуска. Разрешите ngrok в антивирусе или скачайте вручную");
    fs.rmSync(target, { force: true });
    throw new Error("скачанный ngrok не запускается — файл удалён");
  }
  log?.(`ngrok ${ver} установлен: ${target}`);
  return target;
}
