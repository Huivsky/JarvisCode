/**
 * Туннель до моста: ngrok (основной вариант), cloudflared (быстрый туннель) или свой адрес.
 * Процессы запускаются скрыто (windowsHide) — никаких окон консоли.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config, TunnelProvider } from "./config";
import { downloadNgrok, type NgrokDownloadProgress } from "./ngrok-download";
import { DATA_DIR, IS_WIN, LOCAL_APPDATA } from "./paths";

export type TunnelHint = "ngrok-missing" | "ngrok-auth" | "ngrok-busy" | "cloudflared-missing" | "manual-url";

export interface TunnelState {
  provider: TunnelProvider;
  status: "off" | "starting" | "online" | "error";
  url?: string;
  error?: string;
  hint?: TunnelHint;
  /** Туннель уже был запущен кем-то другим — используем его. */
  external?: boolean;
  exe?: string;
  log: string[];
  /** Самопроверка: доходит ли запрос из интернета до этого Jarvis Code. */
  check?: { ok: boolean; at: number; error?: string };
  /** Идёт автоматическая загрузка ngrok. */
  download?: NgrokDownloadProgress;
}

/** Метка этого процесса: /health моста отвечает ею — так самопроверка отличает нас от чужого сервера. */
export const INSTANCE_ID = crypto.randomBytes(8).toString("hex");

export type ProbeResult = { kind: "ok" } | { kind: "bad" | "unknown"; error: string };

function ngrokCodeText(code: string): string {
  if (code === "ERR_NGROK_3200") return "адрес ngrok не в сети (ERR_NGROK_3200) — туннель не запущен";
  if (code === "ERR_NGROK_8012") return "ngrok не достучался до Jarvis Code на этом ПК (ERR_NGROK_8012)";
  if (code === "ERR_NGROK_3004") return "ngrok получил неверный ответ от сервера на ПК (ERR_NGROK_3004)";
  return `ngrok вернул ошибку ${code}`;
}

/** Запрос к своему публичному адресу — так же, как его сделает Notion. */
export async function probePublic(url: string, timeoutMs = 12_000): Promise<ProbeResult> {
  try {
    const r = await fetch(`${url.replace(/\/+$/, "")}/health`, {
      headers: { "user-agent": "JarvisCode-selfcheck", "ngrok-skip-browser-warning": "1" },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
    });
    const t = (await r.text()).slice(0, 50_000);
    if (r.ok && t.includes(INSTANCE_ID)) return { kind: "ok" };
    const code = t.match(/ERR_NGROK_\d+/)?.[0];
    if (code) return { kind: "bad", error: ngrokCodeText(code) };
    if (r.ok) return { kind: "bad", error: "по адресу отвечает другая программа (старый сервер или другая копия Jarvis Code)" };
    if (r.status >= 500 || r.status === 404) return { kind: "bad", error: `адрес ответил ошибкой ${r.status}` };
    return { kind: "unknown", error: `адрес ответил ${r.status}` };
  } catch {
    return { kind: "unknown", error: "не удалось проверить адрес из интернета (нет сети?)" };
  }
}

function which(name: string): string | null {
  try {
    const r = spawnSync(IS_WIN ? "where" : "which", [name], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
    const first = (r.stdout ?? "").split(/\r?\n/).map((s) => s.trim()).find((s) => s && fs.existsSync(s));
    return first ?? null;
  } catch {
    return null;
  }
}

export function findNgrok(cfg: Config): string | null {
  const home = os.homedir();
  const exe = IS_WIN ? "ngrok.exe" : "ngrok";
  const list = [
    cfg.bridge.ngrokPath,
    which("ngrok"),
    path.join(LOCAL_APPDATA, "Microsoft", "WinGet", "Links", exe),
    path.join(LOCAL_APPDATA, "Microsoft", "WindowsApps", exe),
    path.join(LOCAL_APPDATA, "ngrok", exe),
    path.join(DATA_DIR, "bin", exe),
    path.join(path.dirname(process.execPath), exe),
    path.join(home, exe),
    path.join(home, "ngrok", exe),
    path.join(home, "Downloads", exe),
    path.join(home, "Desktop", exe),
    path.join(home, "scoop", "shims", exe),
    path.join(process.env.ProgramData ?? "C:\\ProgramData", "chocolatey", "bin", exe),
    "C:\\ngrok\\" + exe,
    path.join(process.env.ProgramFiles ?? "C:\\Program Files", "ngrok", exe),
  ];
  return list.find((p) => !!p && fs.existsSync(p)) ?? null;
}

export function findCloudflared(): string | null {
  const exe = IS_WIN ? "cloudflared.exe" : "cloudflared";
  const list = [
    which("cloudflared"),
    path.join(DATA_DIR, "bin", exe),
    path.join(path.dirname(process.execPath), exe),
    path.join(process.env.ProgramFiles ?? "C:\\Program Files", "cloudflared", exe),
    path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "cloudflared", exe),
    path.join(LOCAL_APPDATA, "Microsoft", "WinGet", "Links", exe),
  ];
  return list.find((p) => !!p && fs.existsSync(p)) ?? null;
}

/** Файлы конфигурации ngrok: есть ли authtoken и закреплённый домен. */
export function ngrokConfigInfo(): { hasAuthtoken: boolean; domain?: string; file?: string } {
  const home = os.homedir();
  const files = [
    path.join(LOCAL_APPDATA, "ngrok", "ngrok.yml"),
    path.join(home, "AppData", "Local", "ngrok", "ngrok.yml"),
    path.join(home, ".config", "ngrok", "ngrok.yml"),
    path.join(home, "Library", "Application Support", "ngrok", "ngrok.yml"),
    path.join(home, ".ngrok2", "ngrok.yml"),
  ];
  for (const f of files) {
    try {
      const t = fs.readFileSync(f, "utf8");
      const hasAuthtoken = /^\s*authtoken\s*:\s*\S+/m.test(t);
      const domain = t.match(/^\s*(?:domain|hostname|url)\s*:\s*["']?(?:https?:\/\/)?([a-z0-9.-]+\.[a-z]{2,})/im)?.[1];
      return { hasAuthtoken, domain, file: f };
    } catch {}
  }
  return { hasAuthtoken: false };
}

interface NgrokAgent {
  apiPort: number;
  tunnels: { url: string; addr: string }[];
}

/** Агенты ngrok на этом ПК (их локальные API на 4040…4045). */
async function localNgrokAgents(): Promise<NgrokAgent[]> {
  const out: NgrokAgent[] = [];
  await Promise.all(
    [4040, 4041, 4042, 4043, 4044, 4045].map(async (p) => {
      try {
        const r = await fetch(`http://127.0.0.1:${p}/api/tunnels`, { signal: AbortSignal.timeout(800) });
        if (!r.ok) return;
        const j: any = await r.json();
        const tunnels = (j?.tunnels ?? []).map((t: any) => ({ url: String(t?.public_url ?? ""), addr: String(t?.config?.addr ?? t?.forwards_to ?? "") }));
        out.push({ apiPort: p, tunnels });
      } catch {}
    }),
  );
  return out.sort((a, b) => a.apiPort - b.apiPort);
}

const servesPort = (addr: string, port: number) => new RegExp(`[:/]${port}\\b`).test(addr);
const hostOf = (u: string) => u.replace(/^https?:\/\//, "").replace(/[/:].*$/, "").toLowerCase();

/** Уже запущенный агент ngrok (например, старым скриптом) с туннелем на наш порт. */
async function existingNgrokTunnel(port: number): Promise<string | null> {
  for (const a of await localNgrokAgents()) {
    const t = a.tunnels.find((t) => servesPort(t.addr, port) && /^https:/.test(t.url));
    if (t) return t.url;
  }
  return null;
}

/** PID процесса ngrok, слушающего локальный порт API (только Windows; проверяем, что это именно ngrok). */
function ngrokPidOnPort(apiPort: number): number | null {
  if (!IS_WIN) return null;
  try {
    const r = spawnSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8", windowsHide: true, timeout: 8000 });
    const line = (r.stdout ?? "").split(/\r?\n/).find((l) => new RegExp(`(127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1?\\]):${apiPort}\\s.*LISTEN`, "i").test(l));
    const pid = Number(line?.trim().split(/\s+/).pop());
    if (!pid) return null;
    const t = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true, timeout: 8000 });
    return /ngrok/i.test(t.stdout ?? "") ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Закрывает только те процессы ngrok на этом ПК, чьи туннели ведут на порт моста или держат наш домен.
 * Другие туннели ngrok пользователя не трогаем.
 */
async function killConflictingNgrok(port: number, domain: string, keepPid?: number): Promise<number> {
  let killed = 0;
  for (const a of await localNgrokAgents()) {
    const conflict = a.tunnels.some((t) => servesPort(t.addr, port) || (!!domain && hostOf(t.url) === domain.toLowerCase()));
    if (!conflict) continue;
    const pid = ngrokPidOnPort(a.apiPort);
    if (!pid || pid === keepPid) continue;
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 8000 });
    killed++;
  }
  return killed;
}

function killTree(child: ChildProcess | null, sync = false) {
  if (!child?.pid || child.exitCode !== null) return;
  if (IS_WIN) {
    const args = ["/pid", String(child.pid), "/T", "/F"];
    try {
      if (sync) spawnSync("taskkill", args, { stdio: "ignore", windowsHide: true, timeout: 5000 });
      else spawn("taskkill", args, { stdio: "ignore", windowsHide: true }).on("error", () => {});
    } catch {}
  } else {
    try {
      child.kill("SIGTERM");
    } catch {}
  }
}

export class Tunnel {
  state: TunnelState = { provider: "ngrok", status: "off", log: [] };
  private child: ChildProcess | null = null;
  private stopping = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private useDomainFlag = false;
  private gen = 0;
  private watchTimer: ReturnType<typeof setTimeout> | null = null;
  private badChecks = 0;
  private lastRecover = 0;
  private skipExternal = false;
  private conflictFixes = 0;
  private cfgRef: Config | null = null;
  private portRef = 0;
  /** Когда автоматическая загрузка ngrok последний раз не удалась (повтор сам — не чаще раза в 10 минут). */
  private dlFailedAt = 0;
  /** Вызывается после успешной загрузки ngrok (сохранить путь в настройках). */
  onNgrokInstalled: ((exe: string) => void) | null = null;

  constructor(private onChange: () => void) {}

  private set(p: Partial<TunnelState>) {
    this.state = { ...this.state, ...p };
    this.onChange();
  }

  private log(line: string) {
    const l = line.trim();
    if (!l) return;
    this.state.log = [...this.state.log.slice(-40), l.slice(0, 400)];
  }

  async start(cfg: Config, port: number): Promise<void> {
    await this.stop();
    this.stopping = false;
    const gen = ++this.gen;
    const provider = cfg.bridge.provider;
    this.cfgRef = cfg;
    this.portRef = port;
    this.badChecks = 0;
    this.state = { provider, status: "starting", log: [] };
    this.onChange();
    this.watch(gen, 5000);

    if (provider === "manual") {
      const u = cfg.bridge.publicUrl.trim().replace(/\/+$/, "");
      if (!/^https:\/\//i.test(u)) this.set({ status: "error", error: "Укажите публичный https-адрес, который ведёт на порт моста.", hint: "manual-url" });
      else this.set({ status: "online", url: u.replace(/\/mcp(\/.*)?$/, "") });
      return;
    }

    if (provider === "ngrok") {
      const existing = this.skipExternal ? null : await existingNgrokTunnel(port);
      if (gen !== this.gen) return;
      if (existing) {
        // Туннель уже держит другой ngrok (например, старый скрипт). Берём его, только если он реально доходит до нас.
        const r = await probePublic(existing);
        if (gen !== this.gen) return;
        if (r.kind !== "bad") {
          this.set({ status: "online", url: existing, external: true, check: r.kind === "ok" ? { ok: true, at: Date.now() } : undefined });
          return;
        }
        this.log(`Уже запущенный ngrok не работает: ${r.error} — запускаю свой.`);
      }
      const exe = findNgrok(cfg);
      if (!exe) {
        if (Date.now() - this.dlFailedAt > 10 * 60_000) return void this.installNgrok(cfg, port, gen);
        this.set({ status: "error", hint: "ngrok-missing", error: "Не найден ngrok.exe. Нажмите «Скачать ngrok автоматически» или укажите путь к нему." });
        return;
      }
      this.launchNgrok(cfg, exe, port, gen);
      return;
    }

    const exe = findCloudflared();
    if (!exe) {
      this.set({ status: "error", hint: "cloudflared-missing", error: "Не найден cloudflared.exe (winget install Cloudflare.cloudflared) — или выберите ngrok." });
      return;
    }
    this.spawnCloudflared(exe, port, gen);
  }

  /** Скачивает ngrok с официального сайта и продолжает запуск туннеля. */
  private async installNgrok(cfg: Config, port: number, gen: number) {
    this.log("ngrok не найден — скачиваю с официального сайта ngrok…");
    this.set({ status: "starting", error: undefined, hint: undefined, download: { got: 0, total: 0 } });
    try {
      const exe = await downloadNgrok(
        (p) => gen === this.gen && this.set({ download: p }),
        (l) => this.log(l),
      );
      this.dlFailedAt = 0;
      try {
        this.onNgrokInstalled?.(exe);
      } catch {}
      if (gen !== this.gen) return;
      this.set({ download: undefined });
      this.launchNgrok(cfg, exe, port, gen, true);
    } catch (e) {
      this.dlFailedAt = Date.now();
      const msg = (e as Error).message;
      this.log(`Загрузка ngrok не удалась: ${msg}`);
      if (gen !== this.gen) return;
      this.set({ status: "error", hint: "ngrok-missing", download: undefined, error: `Не удалось скачать ngrok: ${msg}. Повторите или укажите путь к ngrok.exe.` });
    }
  }

  /** Кнопка «Скачать ngrok автоматически»: загрузка без ожидания 10 минут после неудачи. */
  async downloadAndStart(cfg: Config, port: number): Promise<void> {
    this.dlFailedAt = 0;
    await this.start(cfg, port);
  }

  private launchNgrok(cfg: Config, exe: string, port: number, gen: number, fresh = false) {
    const info = ngrokConfigInfo();
    if (!info.hasAuthtoken && !cfg.bridge.ngrokAuthtoken && !process.env.NGROK_AUTHTOKEN) {
      const error = fresh
        ? "ngrok скачан. Остался authtoken: войдите (бесплатно) на dashboard.ngrok.com, скопируйте Your Authtoken и вставьте его ниже."
        : "У ngrok не настроен authtoken. Вставьте его в настройках моста (dashboard.ngrok.com → Your Authtoken).";
      this.set({ status: "error", hint: "ngrok-auth", exe, error });
      return;
    }
    this.spawnNgrok(cfg, exe, port, gen);
  }

  private spawnNgrok(cfg: Config, exe: string, port: number, gen: number) {
    const domain = cfg.bridge.ngrokDomain.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    const args = ["http", `http://127.0.0.1:${port}`, "--log", "stdout", "--log-format", "json"];
    if (domain) args.push(this.useDomainFlag ? `--domain=${domain}` : `--url=https://${domain}`);
    const env = { ...process.env };
    if (cfg.bridge.ngrokAuthtoken.trim()) env.NGROK_AUTHTOKEN = cfg.bridge.ngrokAuthtoken.trim();
    let child: ChildProcess;
    try {
      child = spawn(exe, args, { windowsHide: true, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e: any) {
      this.set({ status: "error", error: `ngrok не запустился: ${e?.message ?? e}`, exe });
      return;
    }
    this.child = child;
    this.set({ exe });
    let lastErr = "";
    let buf = "";
    const onLine = (line: string) => {
      this.log(line);
      let j: any = null;
      try {
        j = JSON.parse(line);
      } catch {}
      if (j) {
        if (j.url && /^https:/.test(j.url) && (/started tunnel/i.test(j.msg ?? "") || j.obj === "tunnels")) {
          this.failures = 0;
          this.set({ status: "online", url: j.url, error: undefined, hint: undefined });
        }
        if (j.lvl === "eror" || j.lvl === "crit" || j.err) {
          const e = String(j.err ?? j.msg ?? "");
          if (e && e !== "<nil>") lastErr = e;
        }
      } else if (/ERR_NGROK|ERROR:|error/i.test(line)) lastErr = line.replace(/^.*?ERROR:\s*/, "");
    };
    const onData = (d: Buffer) => {
      buf += d.toString("utf8");
      const parts = buf.split(/\r?\n/);
      buf = parts.pop() ?? "";
      parts.forEach(onLine);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    // запасной способ узнать адрес — локальный API ngrok
    const poll = setInterval(async () => {
      if (gen !== this.gen || this.state.status === "online" || child.exitCode !== null) return clearInterval(poll);
      const u = await existingNgrokTunnel(port);
      if (u && gen === this.gen) this.set({ status: "online", url: u });
    }, 1500);
    setTimeout(() => clearInterval(poll), 30_000);
    child.on("error", (e) => {
      lastErr = e.message;
    });
    child.on("close", (code) => {
      clearInterval(poll);
      if (gen !== this.gen || this.stopping) return;
      this.child = null;
      const err = lastErr || `ngrok завершился (код ${code})`;
      if (/unknown flag.*--url|flag provided but not defined: -url/i.test(err) && !this.useDomainFlag) {
        this.useDomainFlag = true;
        this.spawnNgrok(cfg, exe, port, gen);
        return;
      }
      const auth = /ERR_NGROK_(4018|105|107)|authtoken|authentication failed/i.test(err);
      const busy = /ERR_NGROK_(334|108|18017)|already online|simultaneous/i.test(err);
      if (busy && this.conflictFixes < 3) {
        // Адрес держит ngrok, запущенный на этом ПК для того же моста (старый скрипт) — закрываем только его.
        this.conflictFixes++;
        void killConflictingNgrok(port, domain).then((n) => {
          if (gen !== this.gen || this.stopping) return;
          if (n > 0) {
            this.log(`Закрыт старый ngrok, который держал адрес моста (${n}) — запускаю заново.`);
            setTimeout(() => gen === this.gen && !this.stopping && this.spawnNgrok(cfg, exe, port, gen), 1500);
          } else this.set({ status: "error", url: undefined, error: "Этот адрес ngrok занят другим запущенным ngrok (возможно, на другом компьютере или в другой программе). Закройте его — кнопка «Закрыть другие ngrok» — и перезапустите мост.", hint: "ngrok-busy" });
        });
        return;
      }
      const human = auth
        ? "ngrok не принял authtoken. Вставьте верный токен из dashboard.ngrok.com в настройках моста."
        : busy
          ? "Этот адрес ngrok уже занят другим запущенным ngrok (например, старым скриптом). Закройте его — кнопка «Закрыть другие ngrok» — и перезапустите мост."
          : /ERR_NGROK_(320|319|313|15002)|domain|reserved/i.test(err)
            ? `ngrok не дал этот домен: ${err}. Проверьте домен в настройках моста (Domains в dashboard.ngrok.com) или очистите поле.`
            : `ngrok: ${err}`;
      this.set({ status: "error", url: undefined, error: human, hint: auth ? "ngrok-auth" : busy ? "ngrok-busy" : undefined });
      if (!auth && !busy) this.scheduleRestart(cfg, port);
    });
  }

  private spawnCloudflared(exe: string, port: number, gen: number) {
    let child: ChildProcess;
    try {
      child = spawn(exe, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e: any) {
      this.set({ status: "error", error: `cloudflared не запустился: ${e?.message ?? e}` });
      return;
    }
    this.child = child;
    this.set({ exe });
    let lastErr = "";
    const onData = (d: Buffer) => {
      for (const line of d.toString("utf8").split(/\r?\n/)) {
        this.log(line);
        const m = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (m) {
          this.failures = 0;
          this.set({ status: "online", url: m[0], error: undefined });
        }
        if (/\bERR\b|error/i.test(line)) lastErr = line;
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("close", (code) => {
      if (gen !== this.gen || this.stopping) return;
      this.child = null;
      this.set({ status: "error", url: undefined, error: `cloudflared завершился (код ${code}). ${lastErr}`.trim() });
      this.scheduleRestart(null, port, exe);
    });
  }

  private scheduleRestart(cfg: Config | null, port: number, cloudflared?: string) {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const delay = [3, 10, 30, 60][Math.min(this.failures++, 3)] * 1000;
    const gen = this.gen;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (gen !== this.gen || this.stopping) return;
      this.set({ status: "starting", error: undefined });
      if (cloudflared) this.spawnCloudflared(cloudflared, port, gen);
      else if (cfg) {
        const exe = findNgrok(cfg);
        if (exe) this.spawnNgrok(cfg, exe, port, gen);
      }
    }, delay);
  }

  // ───── самопроверка и самовосстановление ─────

  private watch(gen: number, delay: number) {
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => void this.runCheck(gen), delay);
  }

  /** Немедленная проверка (кнопка «Проверить»). */
  checkNow() {
    this.watch(this.gen, 0);
  }

  private async runCheck(gen: number) {
    this.watchTimer = null;
    if (gen !== this.gen || this.stopping) return;
    const url = this.state.url;
    if (this.state.status !== "online" || !url) return this.watch(gen, 5000);
    const r = await probePublic(url);
    if (gen !== this.gen || this.stopping) return;
    if (r.kind === "ok") {
      this.badChecks = 0;
      this.set({ check: { ok: true, at: Date.now() } });
      return this.watch(gen, 30_000);
    }
    this.set({ check: { ok: false, at: Date.now(), error: r.error } });
    if (r.kind === "bad" && ++this.badChecks >= 2 && this.state.provider !== "manual") {
      const wait = 60_000 - (Date.now() - this.lastRecover);
      if (wait <= 0) {
        this.badChecks = 0;
        this.lastRecover = Date.now();
        this.log(`Самопроверка: ${r.error} — перезапускаю туннель.`);
        return void this.recover();
      }
      return this.watch(gen, wait);
    }
    this.watch(gen, 10_000);
  }

  /** Перезапуск туннеля своим ngrok (чужой «уже запущенный» больше не используем). */
  private async recover() {
    const cfg = this.cfgRef;
    if (!cfg) return;
    const log = this.state.log;
    this.skipExternal = true;
    await this.start(cfg, this.portRef);
    this.state.log = [...log.slice(-20), ...this.state.log];
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.gen++;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = null;
    const c = this.child;
    this.child = null;
    killTree(c);
    if (this.state.status !== "off") this.set({ status: "off", url: undefined, error: undefined, hint: undefined, external: false, download: undefined });
  }

  stopSync() {
    this.stopping = true;
    this.gen++;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.watchTimer) clearTimeout(this.watchTimer);
    killTree(this.child, true);
    this.child = null;
  }
}

/** Закрывает все процессы ngrok (например, запущенные старыми скриптами). */
export function killAllNgrok(): void {
  if (IS_WIN) spawnSync("taskkill", ["/IM", "ngrok.exe", "/F", "/T"], { stdio: "ignore", windowsHide: true, timeout: 8000 });
  else spawnSync("pkill", ["-f", "ngrok"], { stdio: "ignore" });
}
