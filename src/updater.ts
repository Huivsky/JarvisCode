import { controls } from "./control-center";
import { signaturePermitted } from "./update-health";
/**
 * Обновления: проверка релиза (GitHub или свой latest.json), фоновая загрузка с проверкой SHA-256
 * и установка по кнопке. Установку делает новая версия сама (`JarvisCodeSetup.exe update`):
 * ждёт выхода старой, заменяет exe и запускает приложение снова — ключ моста, адрес и чаты не меняются.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config";
import { DATA_DIR, DEFAULT_INSTALL_DIR, EXE_NAME, IS_WIN } from "./paths";
import { APP_NAME, BUILTIN_UPDATE_REPO, BUILTIN_UPDATE_URL, VERSION } from "./version";
import { authenticode, isCompiled } from "./win";

export const UPDATES_DIR = path.join(DATA_DIR, "updates");
const CHECK_EVERY_MS = 6 * 3600_000;
const TICK_MS = 30 * 60_000;

export interface Release {
  version: string;
  url: string;
  sha256?: string;
  notes?: string;
  size?: number;
  date?: string;
}

export type UpdateStatus = "idle" | "checking" | "uptodate" | "available" | "downloading" | "ready" | "installing" | "error";
export interface UpdateInfo {
  status: UpdateStatus;
  current: string;
  latest?: { version: string; notes?: string; url?: string; size?: number; date?: string };
  progress?: number;
  error?: string;
  lastCheck?: number;
  source?: string;
  /** Пользователь пропустил эту версию — не напоминать. */
  skipped?: boolean;
}

// ───── версии ─────

const parts = (v: string) =>
  v
    .trim()
    .replace(/^v/i, "")
    .split(/[-+]/)[0]
    .split(".")
    .map((n) => parseInt(n, 10) || 0);

/** Сравнение версий: 1 — a новее, -1 — b новее, 0 — равны. 3.0.0-beta старше 3.0.0. */
export function cmpVersion(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  const pre = (version: string) => version.replace(/^v/i, "").split("+")[0].split("-").slice(1).join("-");
  const ra = pre(a), rb = pre(b);
  if (!ra || !rb) return ra === rb ? 0 : ra ? -1 : 1;
  const aa = ra.split("."), bb = rb.split(".");
  for (let i=0;i<Math.max(aa.length,bb.length);i++) {
    if (aa[i] === undefined || bb[i] === undefined) return aa[i] === undefined ? -1 : 1;
    if (aa[i] === bb[i]) continue;
    const na = /^\d+$/.test(aa[i]), nb = /^\d+$/.test(bb[i]);
    if (na && nb) return Math.sign(Number(aa[i])-Number(bb[i]));
    if (na !== nb) return na ? -1 : 1;
    return aa[i] < bb[i] ? -1 : 1;
  }
  return 0;
}

/** Только HTTPS (локальный адрес — для тестов и своего сервера на этом ПК). */
export const allowedUrl = (u: string) => /^https:\/\/[^\s/]+/i.test(u) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(u);
const isSha = (s: unknown): s is string => typeof s === "string" && /^[a-f0-9]{64}$/i.test(s.trim());
const UA = { "user-agent": `${APP_NAME.replace(/\s+/g, "")}/${VERSION}` };

export async function sha256File(file: string): Promise<string> {
  const h = crypto.createHash("sha256");
  const rd = fs.createReadStream(file);
  for await (const chunk of rd) h.update(chunk as Buffer);
  return h.digest("hex");
}

// ───── источники ─────

/** Последний релиз GitHub: установщик *Setup*.exe и его SHA-256 (digest ассета, latest.json или *.sha256). */
export async function releaseFromGitHub(repo: string, signal?: AbortSignal, api = "https://api.github.com", channel: "stable"|"beta" = "stable"): Promise<Release> {
  if (!/^[A-Za-z0-9-]+\/(?!\.\.?$)[\w.-]+$/.test(repo)) throw new Error("репозиторий указывается как owner/repo");
  const r = await fetch(`${api}/repos/${repo}/releases${channel === "beta" ? "?per_page=30" : "/latest"}`, { headers: { accept: "application/vnd.github+json", ...UA }, signal });
  if (r.status === 404) throw new Error("в репозитории нет опубликованных релизов");
  if (r.status === 403 || r.status === 429) throw new Error("GitHub временно ограничил запросы — проверю позже");
  if (!r.ok) throw new Error(`GitHub ответил ${r.status}`);
  const data = (await r.json()) as any;
  const j = channel === "beta" ? (Array.isArray(data) ? data.filter(x=>!x.draft).sort((a,b)=>cmpVersion(String(b.tag_name),String(a.tag_name)))[0] : null) : data;
  if(!j) throw new Error("В выбранном канале нет релизов");
  const assets: any[] = Array.isArray(j.assets) ? j.assets : [];
  const exe = assets.find((a) => /setup[^/]*\.exe$/i.test(a.name)) ?? assets.find((a) => /\.exe$/i.test(a.name));
  if (!exe) throw new Error("в релизе нет файла JarvisCodeSetup.exe");
  let sha = typeof exe.digest === "string" && /^sha256:/i.test(exe.digest) ? exe.digest.slice(7) : "";
  const text = async (name: RegExp) => {
    const a = assets.find((x) => name.test(x.name));
    if (!a) return "";
    try {
      const t = await fetch(a.browser_download_url, { headers: UA, signal });
      return t.ok ? await t.text() : "";
    } catch {
      return "";
    }
  };
  if (!isSha(sha)) {
    try {
      const m = JSON.parse((await text(/^latest\.json$/i)) || "{}");
      if (isSha(m.sha256)) sha = m.sha256;
    } catch {}
  }
  if (!isSha(sha)) {
    const sums = await text(/(\.sha256|sha256sums(\.txt)?)$/i);
    const esc = String(exe.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = sums.match(new RegExp(`([a-f0-9]{64})\\s+\\*?${esc}`, "i")) ?? sums.match(/^\s*([a-f0-9]{64})\s*$/im);
    if (m) sha = m[1];
  }
  return {
    version: String(j.tag_name || j.name || "").replace(/^v/i, ""),
    url: String(exe.browser_download_url),
    sha256: isSha(sha) ? sha.toLowerCase() : undefined,
    notes: String(j.body ?? "").slice(0, 4000) || undefined,
    size: Number(exe.size) || undefined,
    date: j.published_at || undefined,
  };
}

/** Свой сервер: latest.json вида {version, url, sha256, notes?, size?, date?}; url может быть относительным. */
export async function releaseFromManifest(url: string, signal?: AbortSignal, channel: "stable"|"beta" = "stable"): Promise<Release> {
  if (!allowedUrl(url)) throw new Error("адрес latest.json должен начинаться с https://");
  const r = await fetch(url, { headers: { "cache-control": "no-cache", ...UA }, signal });
  if (!r.ok) throw new Error(`сервер обновлений ответил ${r.status}`);
  let m: any;
  try {
    m = await r.json();
  } catch {
    throw new Error("latest.json повреждён");
  }
  m = m.channels?.[channel] ?? m;
  const win = m.windows ?? m.win32 ?? m["win-x64"] ?? m;
  const dl = new URL(String(win.url ?? m.url ?? ""), url).toString();
  return {
    version: String(m.version ?? "").replace(/^v/i, ""),
    url: dl,
    sha256: isSha(win.sha256 ?? m.sha256) ? String(win.sha256 ?? m.sha256).toLowerCase() : undefined,
    notes: m.notes ? String(m.notes).slice(0, 4000) : undefined,
    size: Number(win.size ?? m.size) || undefined,
    date: m.date ? String(m.date) : undefined,
  };
}

/** Папка установленного приложения: рядом с запущенным JarvisCode.exe или из реестра. */
export function installDir(fromRegistry: () => string | null): string {
  if (isCompiled() && path.basename(process.execPath).toLowerCase() === EXE_NAME.toLowerCase()) return path.dirname(process.execPath);
  return fromRegistry() ?? DEFAULT_INSTALL_DIR;
}

// ───── обновлятор ─────

/** Откуда брать обновления: из настроек, иначе — вшитый при сборке источник. */
export function updateSource(
  c: { repo: string; manifestUrl: string },
  builtin = { repo: BUILTIN_UPDATE_REPO, manifestUrl: BUILTIN_UPDATE_URL },
): { repo: string; manifestUrl: string; builtin: boolean } {
  if (c.manifestUrl || c.repo) return { repo: c.manifestUrl ? "" : c.repo, manifestUrl: c.manifestUrl, builtin: false };
  return { repo: builtin.manifestUrl ? "" : builtin.repo, manifestUrl: builtin.manifestUrl, builtin: !!(builtin.repo || builtin.manifestUrl) };
}

/** Короткая подпись источника для окна настроек. */
export function sourceLabel(s: { repo: string; manifestUrl: string }): string {
  return s.manifestUrl ? s.manifestUrl : s.repo ? `github.com/${s.repo}` : "";
}

export interface UpdaterOptions {
  cfg: () => Config;
  save: () => void;
  emit: (u: UpdateInfo) => void;
  /** Закрыть приложение (после запуска установщика). */
  quit: () => void;
  /** Открыто ли окно — после обновления открыть его снова. */
  hasWindow: () => boolean;
  installDir: () => string;
  /** Для тестов: другой адрес API GitHub. */
  githubApi?: string;
}

export class Updater {
  info: UpdateInfo = { status: "idle", current: VERSION };
  private release: Release | null = null;
  private file: string | null = null;
  private checking: Promise<UpdateInfo> | null = null;
  private downloading: Promise<void> | null = null;
  private dlAbort: AbortController | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];

  constructor(private o: UpdaterOptions) {
    const c = o.cfg().update;
    if (c.lastCheck) this.info.lastCheck = c.lastCheck;
  }

  get configured(): boolean {
    const c = updateSource(this.o.cfg().update);
    return !!(c.repo || c.manifestUrl);
  }

  private set(p: Partial<UpdateInfo>) {
    this.info = { ...this.info, ...p, current: VERSION };
    if (p.status && p.status !== "error") delete this.info.error;
    if (p.status && p.status !== "downloading") delete this.info.progress;
    this.o.emit(this.info);
  }

  /** Проверка через 20 секунд после запуска и затем раз в 6 часов. */
  start() {
    const tick = () => {
      const c = this.o.cfg().update;
      if (!this.configured) return;
      if (Date.now() - (c.lastCheck || 0) >= CHECK_EVERY_MS || this.info.status === "idle" || this.info.status === "error") void this.check(true);
    };
    const t1 = setTimeout(tick, 20_000);
    const t2 = setInterval(tick, TICK_MS);
    (t1 as any).unref?.();
    (t2 as any).unref?.();
    this.timers.push(t1, t2);
    this.cleanup();
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.dlAbort?.abort();
  }

  /** Источник поменялся — забываем найденный релиз. */
  reset() {
    this.release = null;
    this.file = null;
    this.dlAbort?.abort();
    this.set({ status: "idle", latest: undefined, skipped: undefined, source: undefined });
  }

  check(background = false): Promise<UpdateInfo> {
    if (this.checking) return this.checking;
    if (this.info.status === "downloading" || this.info.status === "installing") return Promise.resolve(this.info);
    this.checking = this.doCheck(background).finally(() => (this.checking = null));
    return this.checking;
  }

  private async doCheck(background: boolean): Promise<UpdateInfo> {
    const c = this.o.cfg().update;
    const src = updateSource(c);
    if (!src.repo && !src.manifestUrl) {
      this.set({ status: "error", error: "не задан источник обновлений" });
      return this.info;
    }
    const source = sourceLabel(src);
    this.set({ status: "checking", source });
    try {
      const signal = AbortSignal.timeout(20_000);
      const channel = controls.updatePolicy().channel;
      const rel = src.manifestUrl ? await releaseFromManifest(src.manifestUrl, signal, channel) : await releaseFromGitHub(src.repo, signal, this.o.githubApi, channel);
      if(channel === "stable" && /-/.test(rel.version)) throw new Error("Stable-канал отклонил предварительный релиз");
      c.lastCheck = Date.now();
      this.o.save();
      if (!rel.version || !/^\d+(\.\d+)*/.test(rel.version)) throw new Error("не удалось определить версию релиза");
      if (!allowedUrl(rel.url)) throw new Error("файл обновления доступен только не по HTTPS — отклонено");
      const latest = { version: rel.version, notes: rel.notes, url: rel.url, size: rel.size, date: rel.date };
      if (cmpVersion(rel.version, VERSION) <= 0) {
        this.release = null;
        this.set({ status: "uptodate", latest, lastCheck: c.lastCheck, skipped: undefined });
        return this.info;
      }
      if (this.release?.version !== rel.version || this.release.sha256 !== rel.sha256) this.file = null;
      this.release = rel;
      const skipped = c.skipped === rel.version;
      const ready = this.file ?? (await this.verifiedCopy(rel));
      if (ready) {
        this.file = ready;
        this.set({ status: "ready", latest, lastCheck: c.lastCheck, skipped });
      } else {
        this.set({ status: "available", latest, lastCheck: c.lastCheck, skipped });
        if (c.auto && rel.sha256 && !(background && skipped)) void this.download().catch(() => {});
      }
    } catch (e) {
      const msg = (e as Error).name === "TimeoutError" ? "сервер обновлений не ответил за 20 секунд" : (e as Error).message;
      this.set({ status: "error", error: msg });
    }
    return this.info;
  }

  private target(rel: Release) {
    return path.join(UPDATES_DIR, `JarvisCodeSetup-${rel.version.replace(/[^\w.-]/g, "_")}.exe`);
  }

  /** Уже скачанный и проверенный файл этой версии (после перезапуска не качаем заново). */
  private async verifiedCopy(rel: Release): Promise<string | null> {
    const f = this.target(rel);
    if (!rel.sha256 || !fs.existsSync(f)) return null;
    try {
      return (await sha256File(f)) === rel.sha256 ? f : null;
    } catch {
      return null;
    }
  }

  /** Потоковая загрузка во временный файл с проверкой SHA-256; затем — атомарное переименование. */
  download(): Promise<void> {
    if (this.downloading) return this.downloading;
    this.downloading = this.doDownload().finally(() => (this.downloading = null));
    return this.downloading;
  }

  private async doDownload(): Promise<void> {
    const rel = this.release;
    if (!rel) throw new Error("сначала проверьте обновления");
    if (!rel.sha256) {
      const err = "у релиза нет контрольной суммы SHA-256 — безопасно установить нельзя. Скачайте установщик вручную";
      this.set({ status: "error", error: err });
      throw new Error(err);
    }
    const f = this.target(rel);
    const tmp = f + ".part";
    fs.mkdirSync(UPDATES_DIR, { recursive: true });
    this.dlAbort = new AbortController();
    this.set({ status: "downloading", progress: 0 });
    const h = crypto.createHash("sha256");
    let got = 0;
    try {
      const r = await fetch(rel.url, { headers: UA, signal: this.dlAbort.signal, redirect: "follow" });
      if (!r.ok || !r.body) throw new Error(`загрузка не удалась (${r.status})`);
      if (r.url && !allowedUrl(r.url)) throw new Error("загрузку перенаправили не на HTTPS — отклонено");
      const total = Number(r.headers.get("content-length")) || rel.size || 0;
      const w = fs.createWriteStream(tmp);
      let last = 0;
      try {
        for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
          h.update(chunk);
          got += chunk.byteLength;
          if (!w.write(chunk)) await new Promise<void>((res) => w.once("drain", () => res()));
          const now = Date.now();
          if (total && now - last > 250) {
            last = now;
            this.set({ status: "downloading", progress: Math.min(0.99, got / total) });
          }
        }
      } finally {
        await new Promise<void>((res) => w.end(() => res()));
      }
      const sum = h.digest("hex");
      if (sum !== rel.sha256) throw new Error("контрольная сумма не совпала — файл повреждён или подменён, удалён");
      fs.renameSync(tmp, f);
      this.file = f;
      this.cleanup(f);
      this.set({ status: "ready" });
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      const aborted = this.dlAbort?.signal.aborted;
      this.set(aborted ? { status: this.release ? "available" : "idle" } : { status: "error", error: (e as Error).message });
      throw e;
    } finally {
      this.dlAbort = null;
    }
  }

  /** Недокачанные файлы и установщики уже установленных версий; с keep — всё, кроме него. */
  private cleanup(keep?: string) {
    try {
      for (const n of fs.readdirSync(UPDATES_DIR)) {
        const p = path.join(UPDATES_DIR, n);
        if (p === keep || n === "update.log") continue;
        const m = n.match(/^JarvisCodeSetup-(.+)\.exe$/i);
        if (n.endsWith(".part") || (m && (keep || cmpVersion(m[1], VERSION) <= 0))) fs.rmSync(p, { force: true });
      }
    } catch {}
  }

  skip() {
    const rel = this.release ?? (this.info.latest ? { version: this.info.latest.version } : null);
    if (!rel) return this.info;
    const c = this.o.cfg().update;
    c.skipped = rel.version;
    this.o.save();
    this.dlAbort?.abort();
    this.set({ skipped: true });
    return this.info;
  }

  /** Запуск установщика новой версии и выход. Перед запуском файл проверяется ещё раз (хеш и подпись). */
  async install(): Promise<UpdateInfo> {
    if (!this.release) throw new Error("сначала проверьте обновления");
    if (!this.file) await this.download();
    const file = this.file!;
    const rel = this.release;
    if ((await sha256File(file)) !== rel.sha256) {
      this.file = null;
      fs.rmSync(file, { force: true });
      this.set({ status: "available" });
      throw new Error("файл обновления изменился на диске — скачаю заново");
    }
    if (!IS_WIN) throw new Error("установка обновлений работает в Windows; файл скачан и проверен: " + file);
    const signaturePolicy = controls.updatePolicy();
    const currentSignature = isCompiled() ? authenticode(process.execPath) : { status: "NotSigned", subject: "" };
    if (!signaturePermitted(signaturePolicy,currentSignature,authenticode(file))) {
      this.set({ status: "error", error: "Подпись/издатель обновления не соответствуют политике — установка отменена" });
      throw new Error(this.info.error);
    }
    this.set({ status: "installing" });
    const args = ["update", "--dir", this.o.installDir(), "--pid", String(process.pid), ...(this.o.hasWindow() ? [] : ["--background"])];
    const child = spawn(file, args, { detached: true, stdio: "ignore", windowsHide: true, cwd: UPDATES_DIR });
    child.on("error", (e) => this.set({ status: "error", error: `не удалось запустить установщик: ${e.message}` }));
    child.unref();
    setTimeout(() => this.o.quit(), 600);
    return this.info;
  }
}
