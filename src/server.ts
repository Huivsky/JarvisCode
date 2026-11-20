import { controlApi } from "./control-api";
import { RelayHub, sessionPrompt } from "./relay-hub";
import { normalizeRelayUrl, relayDestination } from "./relay-links";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerWebSocket } from "bun";
import { Bridge } from "./bridge";
import { Bus } from "./bus";
import { BRIDGE_CHAT_ID, ChatStore, type ChatItem } from "./chats";
import { IMPORT_PROMPT, START_PROMPT } from "./inbox";
import { EFFORTS, MODES, NOTION_CHAT_URL, rememberProject, saveConfig, type Config, type Effort, type Mode, type TunnelProvider } from "./config";
import { mirrorChat, parseTranscript, readMemory, writeMemory, contextDir } from "./context";
import { Engine, readAttachment, type Attachment } from "./engine";
import { crashFile, crashInfos, CRASH_DIR, markCrashes, pendingCrashes, sendCrashes } from "./crash";
import { existingInstallDir, installDefaults, launchInstalled, runInstall, type InstallOptions } from "./installer";
import { describeError } from "./log";
import { DATA_DIR, STORE_DIR, STORE_PROBLEM, UPLOADS_DIR } from "./paths";
import { inspectTarget, moveStorage, storageInfo, type MoveProgress } from "./storage";
import { drives, knownFolder, resolvePath, setKnownFolders } from "./tools";
import { saveChatMarkdown } from "./export";
import { suggestFiles } from "./mentions";
import { ensureUserCommands, listCommands } from "./commands";
import { pruneHistory, restoreSnapshot, rollbackFiles, snapshotFile } from "./textfile";
import { findNgrok, killAllNgrok, ngrokConfigInfo } from "./tunnel";
import { UI_FILES } from "./ui-assets.gen";
import { installDir, sourceLabel, Updater, updateSource } from "./updater";
import { VERSION } from "./version";
import {
  disableLegacyStartup,
  findLegacyStartup,
  getAutostart,
  isCompiled,
  ngrokFromLegacy,
  openExternal,
  openNotionApp,
  setClipboard,
  pickDialog,
  psAsync,
  revealInExplorer,
  setAutostart,
  type LegacyStartup,
} from "./win";

const UPLOAD_MAX = 50 * 1024 * 1024;

/** Сохраняет файл, перетащенный или вставленный в окно (base64), и возвращает путь. */
function saveUpload(name: string, data: string): string {
  const b64 = data.replace(/^data:[^,]*,/, "");
  const buf = Buffer.from(b64, "base64");
  if (!buf.length) throw new Error("пустой файл");
  if (buf.length > UPLOAD_MAX) throw new Error("больше 50 МБ — прикрепите через «+»");
  const safe = path.basename(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(-120) || "file";
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const file = path.join(UPLOADS_DIR, `${stamp}-${crypto.randomBytes(2).toString("hex")}-${safe}`);
  fs.writeFileSync(file, buf);
  return file;
}

const STREAM_MAX = 4 * 1024 ** 3;
const safeName = (name: string) => path.basename(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(-120) || "file";
const uploadPath = (name: string) => {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  return path.join(UPLOADS_DIR, `${stamp}-${crypto.randomBytes(2).toString("hex")}-${safeName(name)}`);
};

/** Потоковая загрузка вставленного/перетащенного файла на диск (без base64 и без копии в памяти). */
async function streamUpload(req: Request, name: string): Promise<{ path: string; size: number }> {
  const file = uploadPath(name);
  const w = Bun.file(file).writer();
  let size = 0;
  try {
    if (!req.body) throw new Error("пустой файл");
    for await (const chunk of req.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > STREAM_MAX) throw new Error("файл больше 4 ГБ");
      w.write(chunk);
    }
    await w.end();
    if (!size) throw new Error("пустой файл");
  } catch (e) {
    try {
      await w.end();
    } catch {}
    fs.rmSync(file, { force: true });
    throw e;
  }
  return { path: file, size };
}

export const ATTACH_KIND: [RegExp, string][] = [
  [/\.(png|jpe?g|gif|webp|bmp|ico|tiff?|jfif|heic|avif|svg)$/i, "image"],
  [/\.(mp4|m4v|mov|webm|mkv|avi|wmv|flv|3gp|mpe?g)$/i, "video"],
  [/\.(mp3|wav|m4a|ogg|oga|flac|aac|opus|wma)$/i, "audio"],
  [/\.pdf$/i, "pdf"],
  [/\.(zip|rar|7z|tar|gz|tgz|bz2|xz)$/i, "archive"],
  [/\.(docx?|rtf|odt|xlsx?|csv|ods|pptx?|odp)$/i, "doc"],
  [/\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|cs|cpp|cc|c|h|hpp|php|swift|sh|ps1|bat|cmd|sql|json|ya?ml|toml|xml|html?|css|scss|md|txt|log|ini|cfg|conf|env)$/i, "code"],
];
export const attachKind = (p: string, dir = false) => (dir ? "folder" : (ATTACH_KIND.find(([re]) => re.test(p))?.[1] ?? "file"));

const MEDIA_MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".jfif": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".bmp": "image/bmp", ".ico": "image/x-icon", ".avif": "image/avif", ".svg": "image/svg+xml",
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska", ".ogv": "video/ogg",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".flac": "audio/flac", ".aac": "audio/aac", ".opus": "audio/ogg",
  ".pdf": "application/pdf",
};

/** Отдаёт картинку/видео/аудио с диска для превью в окне (с поддержкой Range для перемотки видео). */
function serveMedia(req: Request, file: string): Response {
  const ext = path.extname(file).toLowerCase();
  const type = MEDIA_MIME[ext];
  if (!type) return new Response("unsupported", { status: 415 });
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return new Response("not found", { status: 404 });
  }
  if (!st.isFile()) return new Response("not a file", { status: 400 });
  const f = Bun.file(file);
  const base = {
    "content-type": type,
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=300",
    "x-content-type-options": "nosniff",
    // svg и pdf открываются как документ — без скриптов
    "content-security-policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
  };
  const range = req.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
    let end = range[1] && range[2] ? Number(range[2]) : st.size - 1;
    end = Math.min(end, st.size - 1);
    if (start > end || start >= st.size) return new Response(null, { status: 416, headers: { "content-range": `bytes */${st.size}` } });
    return new Response(f.slice(start, end + 1), {
      status: 206,
      headers: { ...base, "content-range": `bytes ${start}-${end}/${st.size}`, "content-length": String(end - start + 1) },
    });
  }
  return new Response(f, { headers: { ...base, "content-length": String(st.size) } });
}

/** Файлы, скопированные в Проводнике (Ctrl+C), — сразу по путям, без копирования. */
function clipboardFiles(): string[] {
  if (process.platform !== "win32") return [];
  try {
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    const ps =
      "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; " +
      "$f=[System.Windows.Forms.Clipboard]::GetFileDropList(); foreach($x in $f){ $x }";
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", ps], { encoding: "utf8", windowsHide: true, timeout: 5000 });
    return String(r.stdout ?? "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && fs.existsSync(l));
  } catch {
    return [];
  }
}

export interface ServerOptions {
  cfg: Config;
  mode: "app" | "installer";
  port?: number;
  token?: string;
  initialProject?: string;
  onIdle?: () => void;
  onOpenWindow?: (hash: string) => void;
  /** Изменилась настройка «держать в трее» (мост включён/выключен). */
  onBackgroundChange?: () => void;
  /** Запрос на выход (например, от установщика новой версии). */
  onQuit?: () => void;
}

interface WsData {
  id: number;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

export function startServer(o: ServerOptions) {
  const cfg = o.cfg;
  const token = o.token ?? crypto.randomBytes(24).toString("hex");
  const bus = new Bus();
  const store = new ChatStore();
  setTimeout(() => pruneHistory(14), 5000);
  // зеркало чата в Markdown рядом с памятью (context/<id>/chat.md) — не чаще раза в 3 с на чат
  const mirrorTimers = new Map<string, ReturnType<typeof setTimeout>>();
  store.onWrite = (c) => {
    if (c.bridge || mirrorTimers.has(c.id)) return;
    mirrorTimers.set(
      c.id,
      setTimeout(() => {
        mirrorTimers.delete(c.id);
        const fresh = store.get(c.id);
        if (fresh) mirrorChat(fresh);
      }, 3000),
    );
  };
  // Пересылка через чат Notion: окно Jarvis Code ↔ агент в обычном чате Notion (личный лимит, без API).
  const inbox = new RelayHub({ idleMinutes: () => cfg.bridge.listenIdleMin });
  for (const summary of store.list()) { const chat = store.get(summary.id); if (chat?.relaySessionId) inbox.bind(chat.relaySessionId, chat.id); }
  /** Включает мост, если он выключен (для пересылки через чат Notion). */
  const ensureBridge = async () => {
    if (cfg.bridge.enabled) return;
    cfg.bridge.enabled = true;
    if (cfg.bridge.provider === "ngrok") detectNgrok();
    saveConfig(cfg);
    await bridge.apply();
    o.onBackgroundChange?.();
    pushState();
  };
  const engine = new Engine({ cfg: () => cfg, store, bus, inbox, relayPrepare: ensureBridge });
  const bridge = new Bridge({ cfg: () => cfg, engine, store, bus, save: () => saveConfig(cfg), inbox });
  const sockets = new Set<ServerWebSocket<WsData>>();
  let wsSeq = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let installing = false;
  let pendingProject = o.initialProject;
  let autostart = o.mode === "app" ? getAutostart() : false;
  let legacyCache: LegacyStartup[] | null = null;
  const updater = new Updater({
    cfg: () => cfg,
    save: () => saveConfig(cfg),
    emit: (update) => bus.emit({ type: "update", update }),
    quit: () => (o.onQuit ?? o.onIdle)?.(),
    hasWindow: () => sockets.size > 0,
    installDir: () => installDir(() => existingInstallDir()),
    githubApi: process.env.NC_GITHUB_API || undefined,
  });

  const bridgeSettings = () => ({
    enabled: cfg.bridge.enabled,
    mode: cfg.bridge.mode,
    project: cfg.bridge.project,
    provider: cfg.bridge.provider,
    ngrokPath: cfg.bridge.ngrokPath,
    ngrokDomain: cfg.bridge.ngrokDomain,
    ngrokAuthtokenSet: !!cfg.bridge.ngrokAuthtoken,
    publicUrl: cfg.bridge.publicUrl,
    approvalTimeoutSec: cfg.bridge.approvalTimeoutSec,
    chatUrl: cfg.bridge.chatUrl,
    listenIdleMin: cfg.bridge.listenIdleMin,
    port: cfg.mcp.port,
  });

  /** Хранилище для интерфейса (размер — из кэша, пересчитывается в фоне). */
  let storageCache: Awaited<ReturnType<typeof storageInfo>> | null = null;
  const refreshStorage = (fresh = false) =>
    storageInfo(fresh)
      .then((s) => {
        storageCache = s;
        bus.emit({ type: "storage", storage: s });
        return s;
      })
      .catch(() => storageCache);
  const userName = () => cfg.userName || os.userInfo().username;

  const state = () => {
    return {
      version: VERSION,
      mode: o.mode,
      user: { name: userName(), custom: !!cfg.userName },
      storage: {
        ...(storageCache && storageCache.dir === STORE_DIR ? storageCache : { bytes: -1, files: -1, free: -1, parts: [] }),
        dir: STORE_DIR,
        defaultDir: DATA_DIR,
        custom: STORE_DIR !== DATA_DIR,
        problem: STORE_PROBLEM,
      },
      settings: {
        defaultMode: cfg.defaultMode,
        project: cfg.project,
        recentProjects: cfg.recentProjects,
        fileScope: cfg.fileScope,
        shell: cfg.shell,
        commandTimeoutSec: cfg.commandTimeoutSec,
        approvalTimeoutSec: cfg.approvalTimeoutSec,
        maxIterations: cfg.autonomous.maxIterations,
        maxMinutes: cfg.autonomous.maxMinutes,
        allow: cfg.allow,
        deny: cfg.deny,
        theme: cfg.theme,
        sendOnEnter: cfg.sendOnEnter,
        effort: cfg.effort,
        ocr: cfg.ocr,
        userName: cfg.userName,
        storageDir: cfg.storageDir,
        accent: cfg.accent,
        update: { ...cfg.update, builtin: sourceLabel(updateSource({ repo: "", manifestUrl: "" })) },
        crash: cfg.crash,
      },
      bridgeSettings: bridgeSettings(),
      bridge: bridge.state(),
      update: updater.info,
      crashes: o.mode === "app" ? pendingCrashes() : [],
      autostart: { enabled: autostart, available: process.platform === "win32" && isCompiled() },
      chats: store.list(),
      busy: engine.busyChats(),
      system: { home: os.homedir(), drives: drives(), platform: process.platform, user: os.userInfo().username, dataDir: DATA_DIR },
      initialProject: pendingProject ?? null,
    };
  };
  const pushState = () => bus.emit({ type: "state", state: state() });

  /** Автоматически находит ngrok, его домен и старые скрипты автозапуска. */
  const detectNgrok = () => {
    legacyCache = findLegacyStartup();
    const fromLegacy = ngrokFromLegacy(legacyCache);
    const info = ngrokConfigInfo();
    let changed = false;
    if (!cfg.bridge.ngrokPath) {
      const exe = fromLegacy.exe ?? findNgrok(cfg);
      if (exe) {
        cfg.bridge.ngrokPath = exe;
        changed = true;
      }
    }
    if (!cfg.bridge.ngrokDomain && (fromLegacy.domain || info.domain)) {
      cfg.bridge.ngrokDomain = (fromLegacy.domain || info.domain)!;
      changed = true;
    }
    if (changed) saveConfig(cfg);
    return { ngrokPath: cfg.bridge.ngrokPath, ngrokDomain: cfg.bridge.ngrokDomain, hasAuthtoken: info.hasAuthtoken || !!cfg.bridge.ngrokAuthtoken, legacy: legacyCache };
  };

  /** «Подключить» в настройке моста: текст для Notion AI с адресом моста — в буфер, чат Notion — в браузере. */
  const connectPrompt = async () => {
    await ensureBridge();
    for (let i = 0; i < 40 && !bridge.state().mcpUrl; i++) await new Promise((r) => setTimeout(r, 500));
    const prompt = bridge.connectPrompt();
    const copied = await setClipboard(prompt);
    openExternal(NOTION_CHAT_URL);
    const st = bridge.state();
    return { prompt, copied, url: NOTION_CHAT_URL, connected: st.connected, hasUrl: !!st.mcpUrl };
  };

  const chatUrl = (id?: string) => relayDestination(id ? store.get(id)?.relayChatUrl : undefined, cfg.bridge.chatUrl, NOTION_CHAT_URL);

  /** Запуск пересылки: команда для агента — в буфер, чат Notion — в браузере. Адреса моста в тексте нет. */
  const relayStart = async (id?: string, open = true) => {
    await ensureBridge();
    const chat = id ? store.get(id) : undefined;
    if (!chat) throw new Error("Откройте обычный локальный чат перед запуском пересылки");
    if (!chat.relaySessionId) { chat.relaySessionId = crypto.randomBytes(24).toString("hex"); store.save(chat, true); }
    inbox.bind(chat.relaySessionId, chat.id);
    const prompt = sessionPrompt(START_PROMPT, chat.relaySessionId);
    const copied = open ? await setClipboard(prompt) : false;
    const url = chatUrl(id);
    if (open) openExternal(url);
    const st = bridge.state();
    return { prompt, copied, url, connected: st.connected, hasUrl: !!st.mcpUrl };
  };

  /** Перенос чата из Notion: команда для агента — в буфер; пользователь вставляет её в нужный чат Notion. */
  const importStart = async (open: boolean) => {
    await ensureBridge();
    const copied = await setClipboard(IMPORT_PROMPT);
    if (open) openExternal(NOTION_CHAT_URL);
    const st = bridge.state();
    return { prompt: IMPORT_PROMPT, copied, connected: st.connected, hasUrl: !!st.mcpUrl };
  };

  let moving: Promise<unknown> | null = null;

  const scheduleIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (sockets.size === 0 && o.onIdle && !installing) {
      // окно закрыто — приложение может остаться в трее (решает onIdle)
      idleTimer = setTimeout(() => {
        if (sockets.size === 0) o.onIdle?.();
      }, 4000);
    }
  };

  const body = async (req: Request): Promise<any> => {
    try {
      return await req.json();
    } catch {
      return {};
    }
  };

  const route = async (req: Request, url: URL): Promise<Response> => {
    const p = url.pathname;
    const m = req.method;
    const controlResponse = await controlApi(req, { store, engine, bridge, inbox, onUpdatePolicy: () => { updater.reset(); cfg.update.lastCheck = 0; cfg.update.skipped = ""; saveConfig(cfg); } });
    if (controlResponse) return controlResponse;
    // ── общее ──
    if (p === "/api/ping") return json({ ok: true, version: VERSION, mode: o.mode });
    if (p === "/api/quit" && m === "POST") {
      setTimeout(() => (o.onQuit ?? o.onIdle)?.(), 100);
      return json({ ok: true });
    }
    if (p === "/api/state") {
      const s = state();
      pendingProject = undefined;
      return json(s);
    }
    if (p === "/api/window" && m === "POST") {
      const b = await body(req);
      if (b.project) pendingProject = b.project;
      o.onOpenWindow?.(b.project ? `#project=${encodeURIComponent(b.project)}` : "");
      return json({ ok: true });
    }
    if (p === "/api/open" && m === "POST") {
      const b = await body(req);
      const t = String(b.target ?? "");
      if (/^https?:\/\//i.test(t) || /^mailto:/i.test(t)) openExternal(t);
      else if (t) {
        const full = resolvePath(String(b.base || os.homedir()), t);
        if (fs.existsSync(full)) revealInExplorer(full);
        else return json({ ok: false, error: `Не найдено: ${full}` });
      }
      return json({ ok: true });
    }
    if (p === "/api/pick" && m === "POST") {
      const b = await body(req);
      const paths = await pickDialog(b.kind === "files" ? "files" : "folder", b.start);
      return json({ paths, native: process.platform === "win32" });
    }
    // @-упоминания: файлы рабочей папки для подсказок в поле ввода
    if (p === "/api/files/suggest" && m === "GET") {
      const dir = url.searchParams.get("dir") || cfg.project;
      try {
        if (!fs.statSync(dir).isDirectory()) return json({ items: [] });
      } catch {
        return json({ items: [] });
      }
      return json(await suggestFiles(path.resolve(dir), (url.searchParams.get("q") ?? "").slice(0, 200)));
    }
    // свои «/»-команды: .jarvis/commands/*.md проекта и личные
    if (p === "/api/commands" && m === "GET") {
      const dir = url.searchParams.get("dir") || cfg.project;
      return json({ items: listCommands(dir).map(({ name, description, source, args }) => ({ name, description, source, args })) });
    }
    if (p === "/api/commands/folder" && m === "POST") {
      const dir = ensureUserCommands();
      revealInExplorer(dir);
      return json({ ok: true, dir });
    }
    if (p === "/api/fs" && m === "GET") {
      const dir = url.searchParams.get("path") || os.homedir();
      try {
        const entries = fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((e) => !e.name.startsWith("$"))
          .map((e) => ({ name: e.name, dir: e.isDirectory() }))
          .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
          .slice(0, 500);
        return json({ path: path.resolve(dir), parent: path.dirname(path.resolve(dir)), entries });
      } catch (e) {
        return json({ error: describeError(e) }, 400);
      }
    }

    // ── установщик ──
    if (p.startsWith("/api/install/") && o.mode !== "installer") return json({ error: "Откройте установщик для управления установкой" }, 403);
    if (p === "/api/install/defaults" && m === "GET") return json(installDefaults());
    if (p === "/api/install/run" && m === "POST") {
      const b = (await body(req)) as InstallOptions;
      if (installing) return json({ error: "already" }, 409);
      installing = true;
      const opts: InstallOptions = {
        dir: String(b.dir || installDefaults().dir),
        desktop: !!b.desktop,
        startMenu: !!b.startMenu,
        path: !!b.path,
        autostart: !!b.autostart,
        notionShortcut: !!b.notionShortcut,
      };
      runInstall(opts, (steps) => bus.emit({ type: "install.steps", steps }))
        .then((ok) => bus.emit({ type: "install.done", ok, dir: opts.dir }))
        .catch((e) => bus.emit({ type: "install.done", ok: false, error: describeError(e) }))
        .finally(() => {
          installing = false;
        });
      return json({ ok: true });
    }
    if (p === "/api/install/launch" && m === "POST") {
      const b = await body(req);
      launchInstalled(String(b.dir || installDefaults().dir));
      setTimeout(() => o.onIdle?.(), 600);
      return json({ ok: true });
    }

    // ── хранилище: папка для чатов, контекста, вложений и снимков ──
    if (p === "/api/storage" && m === "GET") {
      return json(await refreshStorage(url.searchParams.get("fresh") === "1"));
    }
    if (p === "/api/storage/inspect" && m === "POST") {
      const b = await body(req);
      return json(inspectTarget(String(b.dir ?? "")));
    }
    if (p === "/api/storage/open" && m === "POST") {
      fs.mkdirSync(STORE_DIR, { recursive: true });
      revealInExplorer(STORE_DIR);
      return json({ ok: true, dir: STORE_DIR });
    }
    if (p === "/api/storage/move" && m === "POST") {
      const b = await body(req);
      if (moving) return json({ error: "Перенос уже идёт" }, 409);
      if (Object.keys(engine.busyChats()).length || bridge.state().running) return json({ error: "Агент сейчас работает — дождитесь ответа или остановите его, затем перенесите хранилище." }, 409);
      const dir = String(b.dir ?? "").trim().replace(/^"|"$/g, "");
      const mode = b.mode === "use" ? "use" : "move";
      const run = moveStorage(dir, { store, mode, onProgress: (pr: MoveProgress) => bus.emit({ type: "storage.move", progress: pr }) });
      moving = run;
      try {
        const r = await run;
        if (!r.ok) return json({ error: r.error }, 400);
        cfg.storageDir = STORE_DIR === DATA_DIR ? "" : STORE_DIR;
        saveConfig(cfg);
        bus.emit({ type: "chats", chats: store.list() });
        void refreshStorage(true).then(() => pushState());
        pushState();
        return json(r);
      } finally {
        moving = null;
      }
    }

    // ── перенос чата из Notion или из текста ──
    if (p === "/api/import/prompt" && m === "POST") {
      const b = await body(req);
      return json(await importStart(b.open !== false));
    }
    if (p === "/api/chats/import" && m === "POST") {
      const b = await body(req);
      const raw = String(b.text ?? "").slice(0, 20_000_000);
      if (!raw.trim()) return json({ error: "Вставьте текст переписки или выберите файл" }, 400);
      const parsed = parseTranscript(raw);
      const title = typeof b.title === "string" && b.title.trim() ? b.title.trim() : undefined;
      const messages = parsed.length ? parsed : [{ role: "user" as const, text: `Контекст (вставленный текст):\n\n${raw.trim()}` }];
      const r = engine.importChat({
        from: "text",
        messages,
        title: title ?? (parsed.length ? undefined : "Перенесённый контекст"),
        summary: typeof b.summary === "string" ? b.summary : undefined,
        project: typeof b.project === "string" ? b.project : undefined,
        source: typeof b.source === "string" ? b.source.slice(0, 300) : undefined,
      });
      return json({ ok: true, chatId: r.chat.id, title: r.chat.title, count: r.total, parsed: parsed.length > 0 });
    }

    if (p === "/api/settings" && m === "POST") {
      const b = await body(req);
      if (MODES.includes(b.defaultMode)) cfg.defaultMode = b.defaultMode;
      if (b.project && fs.existsSync(b.project)) rememberProject(cfg, b.project);
      if (b.fileScope === "any" || b.fileScope === "project") cfg.fileScope = b.fileScope;
      if (["powershell", "pwsh", "cmd"].includes(b.shell)) cfg.shell = b.shell;
      const num = (v: unknown, lo: number, hi: number) => (typeof v === "number" && v >= lo && v <= hi ? Math.round(v) : undefined);
      cfg.commandTimeoutSec = num(b.commandTimeoutSec, 5, 55) ?? cfg.commandTimeoutSec;
      cfg.approvalTimeoutSec = num(b.approvalTimeoutSec, 0, 3600) ?? cfg.approvalTimeoutSec;
      cfg.autonomous.maxIterations = num(b.maxIterations, 1, 200) ?? cfg.autonomous.maxIterations;
      cfg.autonomous.maxMinutes = num(b.maxMinutes, 1, 1440) ?? cfg.autonomous.maxMinutes;
      if (Array.isArray(b.allow)) cfg.allow = b.allow.map(String).filter(Boolean);
      if (Array.isArray(b.deny)) cfg.deny = b.deny.map(String).filter(Boolean);
      if (["dark", "light", "system"].includes(b.theme)) cfg.theme = b.theme;
      if (typeof b.sendOnEnter === "boolean") cfg.sendOnEnter = b.sendOnEnter;
      if (EFFORTS.includes(b.effort)) cfg.effort = b.effort as Effort;
      if (typeof b.ocr === "boolean") cfg.ocr = b.ocr;
      if (typeof b.userName === "string") cfg.userName = b.userName.trim().slice(0, 60);
      if (typeof b.accent === "string" && /^[a-z-]{2,20}$/.test(b.accent)) cfg.accent = b.accent;
      const src0 = cfg.update.repo + "|" + cfg.update.manifestUrl;
      if (b.update && typeof b.update === "object") {
        if (typeof b.update.auto === "boolean") cfg.update.auto = b.update.auto;
        if (typeof b.update.repo === "string") cfg.update.repo = b.update.repo.trim().replace(/^https:\/\/github\.com\//, "").replace(/\/$/, "");
        if (typeof b.update.manifestUrl === "string") cfg.update.manifestUrl = b.update.manifestUrl.trim();
      }
      if (b.crash && typeof b.crash === "object") {
        if (typeof b.crash.send === "boolean") cfg.crash.send = b.crash.send;
        if (typeof b.crash.endpoint === "string") cfg.crash.endpoint = b.crash.endpoint.trim();
      }
      // сменился источник обновлений — проверяем заново
      if (src0 !== cfg.update.repo + "|" + cfg.update.manifestUrl) {
        cfg.update.lastCheck = 0;
        cfg.update.skipped = "";
        updater.reset();
        if (updater.configured && o.mode === "app") void updater.check(true);
      }
      saveConfig(cfg);
      pushState();
      return json({ ok: true });
    }

    // ── мост MCP и автозапуск ──
    if (p === "/api/bridge" && m === "POST") {
      const b = await body(req);
      const br = cfg.bridge;
      const before = JSON.stringify([br.enabled, br.provider, br.ngrokPath, br.ngrokDomain, br.ngrokAuthtoken, br.publicUrl, cfg.mcp.port]);
      if (typeof b.enabled === "boolean") br.enabled = b.enabled;
      if (MODES.includes(b.mode)) br.mode = b.mode;
      if (typeof b.project === "string" && b.project && fs.existsSync(b.project)) br.project = b.project;
      if (["ngrok", "cloudflared", "manual"].includes(b.provider)) br.provider = b.provider as TunnelProvider;
      if (typeof b.ngrokPath === "string") br.ngrokPath = b.ngrokPath.trim().replace(/^"|"$/g, "");
      if (typeof b.ngrokDomain === "string") br.ngrokDomain = b.ngrokDomain.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      if (typeof b.ngrokAuthtoken === "string") br.ngrokAuthtoken = b.ngrokAuthtoken.trim();
      if (typeof b.publicUrl === "string") br.publicUrl = b.publicUrl.trim();
      if (b.chatUrl !== undefined) {
        try { br.chatUrl = normalizeRelayUrl(b.chatUrl); }
        catch (e) { return json({ error: (e as Error).message }, 400); }
      }
      if (typeof b.listenIdleMin === "number" && b.listenIdleMin >= 1 && b.listenIdleMin <= 120) br.listenIdleMin = Math.round(b.listenIdleMin);
      if (typeof b.approvalTimeoutSec === "number" && b.approvalTimeoutSec >= 10 && b.approvalTimeoutSec <= 3600) br.approvalTimeoutSec = Math.round(b.approvalTimeoutSec);
      if (typeof b.port === "number" && Number.isInteger(b.port) && b.port >= 1024 && b.port <= 65535) cfg.mcp.port = b.port;
      if (b.enabled === true && !br.ngrokPath && br.provider === "ngrok") detectNgrok();
      saveConfig(cfg);
      const after = JSON.stringify([br.enabled, br.provider, br.ngrokPath, br.ngrokDomain, br.ngrokAuthtoken, br.publicUrl, cfg.mcp.port]);
      if (before !== after) await bridge.apply();
      if (typeof b.enabled === "boolean") o.onBackgroundChange?.();
      pushState();
      return json({ ok: true, bridge: bridge.state() });
    }
    if (p === "/api/bridge/connect" && m === "POST") {
      return json({ ok: true, ...(await connectPrompt()) });
    }
    if (p === "/api/relay/start" && m === "POST") {
      const b = await body(req);
      const id = typeof b.chatId === "string" && b.chatId ? b.chatId : engine.createChat({ title: "Пересылка Notion" }).id;
      if (!store.get(id)) return json({ error: "Чат не найден" }, 404);
      return json({ ...(await relayStart(id, b.open !== false)), chatId: id });
    }
    if (p === "/api/bridge/check" && m === "POST") {
      bridge.checkNow();
      return json({ ok: true });
    }
    if (p === "/api/bridge/restart" && m === "POST") {
      await bridge.apply();
      await bridge.restartTunnel();
      return json({ ok: true, bridge: bridge.state() });
    }
    if (p === "/api/bridge/token" && m === "POST") {
      bridge.regenerateToken();
      pushState();
      return json({ ok: true, bridge: bridge.state() });
    }
    if (p === "/api/bridge/detect" && m === "POST") {
      const r = detectNgrok();
      pushState();
      return json(r);
    }
    if (p === "/api/bridge/ngrok-download" && m === "POST") {
      await bridge.downloadNgrok();
      return json({ ok: true, bridge: bridge.state() });
    }
    if (p === "/api/bridge/legacy" && m === "GET") {
      legacyCache = findLegacyStartup();
      return json({ items: legacyCache });
    }
    if (p === "/api/bridge/legacy/disable" && m === "POST") {
      const b = await body(req);
      const ids: string[] = Array.isArray(b.ids) ? b.ids.map(String) : [];
      const list = (legacyCache ?? findLegacyStartup()).filter((x) => !ids.length || ids.includes(x.id));
      const done = disableLegacyStartup(list, path.join(DATA_DIR, "legacy-autostart"));
      legacyCache = findLegacyStartup();
      return json({ ok: true, done, items: legacyCache, backup: path.join(DATA_DIR, "legacy-autostart") });
    }
    if (p === "/api/bridge/kill-ngrok" && m === "POST") {
      await bridge.stop();
      killAllNgrok();
      await new Promise((r) => setTimeout(r, 600));
      await bridge.apply();
      return json({ ok: true, bridge: bridge.state() });
    }
    if (p === "/api/autostart" && m === "POST") {
      const b = await body(req);
      setAutostart(!!b.enabled);
      autostart = getAutostart();
      pushState();
      return json({ ok: true, enabled: autostart });
    }
    if (p === "/api/notion/open" && m === "POST") {
      openNotionApp();
      return json({ ok: true });
    }

    // ── вложения: потоковая загрузка, файлы из буфера Проводника, сведения о путях ──
    if (p === "/api/upload" && m === "POST") {
      const name = url.searchParams.get("name") || "file";
      try {
        const r = await streamUpload(req, name);
        return json({ ok: true, path: r.path, name: safeName(name), size: r.size, kind: attachKind(name) });
      } catch (e: any) {
        return json({ error: `Не удалось сохранить ${name}: ${e?.message ?? e}` }, 400);
      }
    }
    if (p === "/api/clipboard/files" && m === "GET") {
      return json({ paths: clipboardFiles() });
    }
    if (p === "/api/attachments/info" && m === "POST") {
      const b = await body(req);
      const out = (Array.isArray(b.paths) ? b.paths : []).slice(0, 50).map((raw: unknown) => {
        const file = resolvePath(cfg.project, String(raw));
        try {
          const st = fs.statSync(file);
          return { path: file, name: path.basename(file) + (st.isDirectory() ? "/" : ""), size: st.isDirectory() ? 0 : st.size, kind: attachKind(file, st.isDirectory()) };
        } catch {
          return { path: file, name: path.basename(file), size: 0, kind: "missing" };
        }
      });
      return json({ items: out });
    }

    // ── чаты ──
    if (p === "/api/chats" && m === "POST") {
      const b = await body(req);
      if (b.project && fs.existsSync(b.project)) {
        rememberProject(cfg, b.project);
        saveConfig(cfg);
      }
      const chat = engine.createChat({ mode: b.mode as Mode, project: b.project, effort: EFFORTS.includes(b.effort) ? (b.effort as Effort) : undefined });
      return json(chat);
    }
    const cm = p.match(/^\/api\/chats\/([a-z0-9]+)(?:\/([a-z]+))?$/);
    if (cm) {
      const [, id, action] = cm;
      const chat = id === BRIDGE_CHAT_ID ? store.bridgeChat(cfg.bridge.project, cfg.bridge.mode) : store.get(id);
      if (!chat) return json({ error: "Чат не найден" }, 404);
      if (!action && m === "GET") return json({ ...chat, busy: engine.busyChats()[id] ?? null, queue: engine.queueOf(id) });
      if (id === BRIDGE_CHAT_ID && action !== "clear" && m !== "GET") return json({ error: "Это журнал моста — пишите агенту в Notion." }, 400);
      if (!action && m === "DELETE") {
        inbox.revoke(id);
        engine.deleteChat(id);
        return json({ ok: true });
      }
      const b = await body(req);
      if (action === "relay" && m !== "POST") return json({ error: "Method not allowed" }, 405);
      switch (action) {
        case "relay": {
          if (engine.isBusy(id)) return json({ error: "Остановите задачу перед сменой чата пересылки" }, 409);
          try { chat.relayChatUrl = normalizeRelayUrl(b.chatUrl); }
          catch (e) { return json({ error: (e as Error).message }, 400); }
          store.save(chat, true);
          bus.emit({ type: "chats", chats: store.list() });
          return json({ ok: true, chatUrl: chat.relayChatUrl, effectiveChatUrl: chatUrl(id) });
        }
        case "export": {
          // «Сохранить в Markdown» — в «Загрузки», файл выделяется в Проводнике
          const file = saveChatMarkdown(chat, knownFolder("downloads") || path.join(os.homedir(), "Downloads"));
          if (b.reveal !== false) revealInExplorer(file);
          return json({ ok: true, path: file });
        }
        case "send": {
          const atts: Attachment[] = [];
          for (const a of Array.isArray(b.attachments) ? b.attachments : []) {
            if (a?.path) atts.push(readAttachment(String(a.path), { frames: typeof a.frames === "string" && fs.existsSync(a.frames) ? a.frames : undefined }));
            else if (a?.name && typeof a.data === "string") {
              // перетащено/вставлено в окно: сохраняем в ~/.notion-code/uploads, дальше как обычный файл
              try {
                atts.push(readAttachment(saveUpload(String(a.name), a.data)));
              } catch (e: any) {
                return json({ error: `Не удалось сохранить ${a.name}: ${e?.message ?? e}` }, 400);
              }
            } else if (a?.name && typeof a.content === "string") atts.push({ name: String(a.name), content: a.content });
          }
          const text = String(b.text ?? "").trim();
          if (!text && !atts.length) return json({ error: "Пустое сообщение" }, 400);
          if (engine.isBusy(id)) {
            // агент работает — сообщение в очередь: он прочитает его после текущего шага
            try {
              return json({ ok: true, queued: engine.enqueue(id, text, atts) });
            } catch (e) {
              return json({ error: describeError(e) }, 409);
            }
          }
          engine.send(id, text, atts).catch((e) => bus.emit({ type: "toast", level: "error", text: describeError(e) }));
          return json({ ok: true });
        }
        case "stop":
          engine.stop(id);
          return json({ ok: true });
        case "unqueue": {
          const q = engine.unqueue(id, String(b.id ?? ""));
          return q ? json({ ok: true, item: q }) : json({ error: "Сообщение уже передано агенту" }, 409);
        }
        case "flush":
          return engine.interrupt(id) ? json({ ok: true }) : json({ error: "Очередь пуста" }, 409);
        case "mode":
          engine.setMode(id, b.mode);
          return json({ ok: true });
        case "project":
          if (!b.project || !fs.existsSync(b.project)) return json({ error: "Папка не найдена" }, 400);
          engine.setProject(id, b.project);
          rememberProject(cfg, b.project);
          saveConfig(cfg);
          return json({ ok: true });
        case "rename":
          engine.rename(id, String(b.title ?? ""));
          return json({ ok: true });
        case "effort":
          if (!EFFORTS.includes(b.effort)) return json({ error: "effort: fast | normal | deep | max" }, 400);
          engine.setEffort(id, b.effort as Effort);
          return json({ ok: true });
        case "retry":
          if (engine.isBusy(id)) return json({ error: "Агент ещё отвечает" }, 409);
          engine.resend(id).catch((e) => bus.emit({ type: "toast", level: "error", text: describeError(e) }));
          return json({ ok: true });
        case "memory":
          // память чата: её получает любой агент, который продолжает чат
          if (m === "POST" && typeof b.text === "string") return json({ ok: true, memory: writeMemory(id, b.text) });
          return json({ memory: readMemory(id), dir: contextDir(id) });
        case "context": {
          mirrorChat(chat);
          revealInExplorer(path.join(contextDir(id), "chat.md"));
          return json({ ok: true, dir: contextDir(id) });
        }
        case "clear":
          if (engine.isBusy(id)) return json({ error: "Агент ещё отвечает" }, 409);
          chat.items = [];
          store.save(chat, true);
          return json({ ok: true });
      }
    }
    if (p === "/api/undo" && m === "POST") {
      const b = await body(req);
      const cid = String(b.chatId ?? "");
      const chat = cid === BRIDGE_CHAT_ID ? store.bridgeChat(cfg.bridge.project, cfg.bridge.mode) : store.get(cid);
      const item = chat?.items.find((i) => i.id === String(b.itemId ?? ""));
      if (!chat || !item?.undo) return json({ error: "Правка не найдена" }, 404);
      if (item.undone) return json({ ok: true, message: "Уже отменено" });
      const r = restoreSnapshot(item.undo, b.force === true);
      if (r.ok) {
        engine.patch(chat, item, { undone: true });
        store.save(chat);
      }
      return json(r, r.ok || r.changed ? 200 : 400);
    }
    // «Откатить все правки» ответа агента: каждый файл — к состоянию до первой правки в этом ответе
    if (p === "/api/undo/turn" && m === "POST") {
      const b = await body(req);
      const cid = String(b.chatId ?? "");
      const chat = cid === BRIDGE_CHAT_ID ? store.bridgeChat(cfg.bridge.project, cfg.bridge.mode) : store.get(cid);
      if (!chat) return json({ error: "Чат не найден" }, 404);
      if (engine.isBusy(chat.id)) return json({ error: "Дождитесь, пока агент закончит, или остановите его." }, 409);
      const ids = new Set((Array.isArray(b.itemIds) ? b.itemIds : []).map(String));
      const edits = chat.items.filter((i) => ids.has(i.id) && i.kind === "tool" && i.undo && i.status === "ok");
      if (!edits.length) return json({ error: "Правки не найдены" }, 404);
      const byFile = new Map<string, ChatItem[]>();
      for (const it of edits) {
        const f = snapshotFile(it.undo!) ?? `?${it.id}`;
        const key = process.platform === "win32" ? f.toLowerCase() : f;
        byFile.set(key, [...(byFile.get(key) ?? []), it]);
      }
      const groups = [...byFile.values()]
        .filter((list) => list.some((i) => !i.undone))
        .map((list) => ({ first: list[0].undo!, last: [...list].reverse().find((i) => !i.undone)?.undo, items: list }));
      if (!groups.length) return json({ ok: true, message: "Уже откачено" });
      const r = rollbackFiles(groups, b.force === true);
      if (r.ok) {
        for (const g of groups) for (const it of g.items) if (!it.undone) engine.patch(chat, it, { undone: true });
        store.save(chat);
      }
      return json(r, r.ok || r.changed ? 200 : 400);
    }
    // ── обновления ──
    if (p === "/api/update/check" && m === "POST") return json({ update: await updater.check(false) });
    if (p === "/api/update/install" && m === "POST") {
      if (Object.keys(engine.busyChats()).length) return json({error:"Остановите задачи перед обновлением"},409);
      try {
        return json({ update: await updater.install() });
      } catch (e) {
        return json({ error: (e as Error).message, update: updater.info }, 400);
      }
    }
    if (p === "/api/update/skip" && m === "POST") return json({ update: updater.skip() });

    // ── отчёты о сбоях ──
    if (p === "/api/crashes" && m === "GET") return json({ items: crashInfos(), dir: CRASH_DIR });
    const crm = p.match(/^\/api\/crashes\/(send|dismiss|open)$/);
    if (crm && m === "POST") {
      const b = await body(req);
      const ids = Array.isArray(b.ids) ? b.ids.map(String) : undefined;
      if (crm[1] === "dismiss") {
        markCrashes(ids?.length ? ids : pendingCrashes().map((c) => c.id), { seen: true });
        pushState();
        return json({ ok: true });
      }
      if (crm[1] === "open") {
        const last = ids?.length ? crashFile(ids[ids.length - 1]) : null;
        fs.mkdirSync(CRASH_DIR, { recursive: true });
        revealInExplorer(last ?? CRASH_DIR);
        return json({ ok: true, dir: CRASH_DIR });
      }
      const r = await sendCrashes(ids, cfg.crash.endpoint);
      pushState();
      return json(r);
    }

    const am = p.match(/^\/api\/approvals\/([a-z0-9]+)$/);
    if (am && m === "POST") {
      const b = await body(req);
      const ans = b.answer === "always" ? "always" : b.answer === "yes" ? "yes" : "no";
      return json({ ok: engine.answer(am[1], ans, b.feedback ? String(b.feedback) : undefined) });
    }
    return json({ error: "not found" }, 404);
  };

  const server = Bun.serve<WsData, never>({
    hostname: "127.0.0.1",
    port: o.port ?? 0,
    idleTimeout: 0,
    maxRequestBodySize: STREAM_MAX,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const origin = req.headers.get("origin");
      const selfOrigin = `http://${url.host}`;
      // Защита от сайтов в браузере: API только со своего origin и с токеном.
      if (url.pathname === "/ws") {
        if ((origin && origin !== selfOrigin) || url.searchParams.get("t") !== token) return new Response("forbidden", { status: 403 });
        return srv.upgrade(req, { data: { id: ++wsSeq } }) ? undefined : new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname === "/file" && req.method === "GET") {
        if ((origin && origin !== selfOrigin) || url.searchParams.get("t") !== token) return new Response("forbidden", { status: 403 });
        return serveMedia(req, path.resolve(String(url.searchParams.get("path") ?? "")));
      }
      if (url.pathname.startsWith("/api/")) {
        if (origin && origin !== selfOrigin) return new Response("forbidden", { status: 403 });
        if (req.headers.get("x-nc-token") !== token) return json({ error: "unauthorized" }, 401);
        try {
          return await route(req, url);
        } catch (e) {
          return json({ error: describeError(e) }, 500);
        }
      }
      const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const asset = UI_FILES[file];
      if (!asset) return new Response("not found", { status: 404 });
      const ext = path.extname(file);
      const content = asset.base64 ? Buffer.from(asset.data, "base64") : asset.data;
      return new Response(content, {
        headers: {
          "content-type": MIME[ext] ?? "application/octet-stream",
          "cache-control": file === "index.html" ? "no-store" : "max-age=31536000, immutable",
          "x-content-type-options": "nosniff",
          ...(file === "index.html"
            ? {
                "content-security-policy":
                  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws://127.0.0.1:*; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
              }
            : {}),
        },
      });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
        const off = bus.add((d) => ws.send(d));
        (ws as any).__off = off;
        scheduleIdle();
      },
      message() {},
      close(ws) {
        sockets.delete(ws);
        (ws as any).__off?.();
        scheduleIdle();
      },
    },
  });

  if (o.mode === "app") {
    setTimeout(() => void refreshStorage(), 1500);
    // известные папки Windows (Рабочий стол, Документы, Загрузки) — для pc_info
    if (process.platform === "win32")
      psAsync(
        "$o=[ordered]@{desktop=[Environment]::GetFolderPath('Desktop');documents=[Environment]::GetFolderPath('MyDocuments');downloads=(New-Object -ComObject Shell.Application).NameSpace('shell:Downloads').Self.Path}; $o | ConvertTo-Json -Compress",
      ).then((r) => {
        try {
          setKnownFolders(JSON.parse(r.out));
        } catch {}
      });
    if (cfg.bridge.enabled) {
      if (cfg.bridge.provider === "ngrok" && !cfg.bridge.ngrokPath) detectNgrok();
      bridge.apply().catch(() => {});
    }
    updater.start();
    // согласие на автоотправку отчётов — отправляем накопившиеся тихо
    if (cfg.crash.send && cfg.crash.endpoint)
      setTimeout(() => {
        void sendCrashes(undefined, cfg.crash.endpoint).then((r) => r.sent && pushState());
      }, 15_000);
  }

  return {
    server,
    token,
    port: server.port ?? 0,
    url: `http://127.0.0.1:${server.port ?? 0}/`,
    engine,
    store,
    bus,
    bridge,
    cfg,
    pushState,
    setAutostart(on: boolean) {
      setAutostart(on);
      autostart = getAutostart();
      pushState();
      return autostart;
    },
    get autostart() {
      return autostart;
    },
    clients: () => sockets.size,
    updater,
    stop() {
      updater.stop();
      engine.stopAll();
      bridge.stopSync();
      store.flush();
      server.stop(true);
    },
  };
}