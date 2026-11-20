import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { CONFIG_FILE, DATA_DIR } from "./paths";

export const MODES = ["plan", "ask", "auto-edit", "full", "autonomous"] as const;
export type Mode = (typeof MODES)[number];
export type Shell = "powershell" | "pwsh" | "cmd";
export type Theme = "dark" | "light" | "system";

export type TunnelProvider = "ngrok" | "cloudflared" | "manual";

/** Мост MCP: агент в самом Notion управляет ПК через инструменты Jarvis Code. */
export interface BridgeConfig {
  enabled: boolean;
  mode: Mode;
  project: string;
  provider: TunnelProvider;
  ngrokPath: string;
  ngrokDomain: string;
  ngrokAuthtoken: string;
  /** Свой публичный адрес (provider = manual). */
  publicUrl: string;
  approvalTimeoutSec: number;
  /** Когда Notion впервые обратился к мосту и по какому адресу. */
  connectedAt: number;
  connectedUrl: string;
  lastClient: string;
  /** Пересылка через чат Notion: где открыт агент с подключённым мостом. */
  chatUrl: string;
  /** Сколько минут агент в Notion ждёт новых сообщений без дела, прежде чем закончить ход. */
  listenIdleMin: number;
}

/** Насколько тщательно агент работает над сообщением (указание в каждом сообщении агенту). */
export const EFFORTS = ["fast", "normal", "deep", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface Config {
  /** Как обращаться к пользователю (приветствие, отчёты). */
  userName: string;
  defaultMode: Mode;
  /** Уровень размышления для новых чатов. */
  effort: Effort;
  /** Папка хранилища (чаты, контекст, вложения, снимки); "" — папка данных ~/.notion-code. */
  storageDir: string;
  /** Добавлять к картинкам для агента распознанный текст (OCR Windows): снимки экрана, буфер, nc_view_image. */
  ocr: boolean;
  /** Папка по умолчанию для относительных путей. Агенту доступен весь ПК. */
  project: string;
  recentProjects: string[];
  fileScope: "any" | "project";
  shell: Shell;
  commandTimeoutSec: number;
  approvalTimeoutSec: number;
  autonomous: { maxIterations: number; maxMinutes: number };
  allow: string[];
  deny: string[];
  theme: Theme;
  sendOnEnter: boolean;
  bridge: BridgeConfig;
  mcp: { host: string; port: number; token: string };
  /** Цветовой акцент интерфейса. */
  accent: string;
  /** Обновления: канал и адрес манифеста (или GitHub-репозиторий owner/name). */
  update: { auto: boolean; repo: string; manifestUrl: string; skipped: string; lastCheck: number };
  /** Отчёты о сбоях: локально всегда; отправка — только если указан адрес и включено. */
  crash: { send: boolean; endpoint: string };
  // Поля консольной версии 0.2.x — сохраняем, чтобы не терять настройки.
  [legacy: string]: unknown;
}

/** Поля режима API (до 4.0): аккаунты и токены Notion, агенты, модели, кредиты — больше не используются и удаляются из config.json. */
const API_FIELDS = ["accounts", "activeAccount", "notionToken", "agentId", "agentName", "workspaceName", "models", "via", "skipLogin", "creditFailover", "encryptTokens", "maxToolRounds"];

export function defaultConfig(): Config {
  return {
    userName: "",
    defaultMode: "ask",
    effort: "normal",
    storageDir: "",
    ocr: true,
    project: os.homedir(),
    recentProjects: [],
    fileScope: "any",
    shell: "powershell",
    commandTimeoutSec: 25,
    approvalTimeoutSec: 0,
    autonomous: { maxIterations: 20, maxMinutes: 120 },
    allow: ["git status", "git diff*", "git log*", "dir*", "ls*", "Get-ChildItem*"],
    deny: [],
    theme: "dark",
    sendOnEnter: true,
    mcp: { host: "127.0.0.1", port: 8765, token: crypto.randomBytes(24).toString("hex") },
    bridge: {
      enabled: false,
      mode: "full",
      project: os.homedir(),
      provider: "ngrok",
      ngrokPath: "",
      ngrokDomain: "",
      ngrokAuthtoken: "",
      publicUrl: "",
      approvalTimeoutSec: 120,
      connectedAt: 0,
      connectedUrl: "",
      lastClient: "",
      chatUrl: "",
      listenIdleMin: 10,
    },
    accent: "ember",
    update: { auto: true, repo: "", manifestUrl: "", skipped: "", lastCheck: 0 },
    crash: { send: false, endpoint: "" },
  };
}

export function loadConfig(): Config {
  const base = defaultConfig();
  let saved: Record<string, any> = {};
  try {
    if (fs.existsSync(CONFIG_FILE)) saved = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    saved = {};
  }
  if (!saved || typeof saved !== "object") saved = {};
  // имя из прежнего входа в Notion (режим API) — для приветствия
  const legacyName = String(saved.userName || (Array.isArray(saved.accounts) ? (saved.accounts.find((a: any) => a?.userName)?.userName ?? "") : "") || "");
  for (const k of API_FIELDS) delete saved[k];
  const cfg: Config = {
    ...base,
    ...saved,
    autonomous: { ...base.autonomous, ...(saved.autonomous ?? {}) },
    mcp: { ...base.mcp, ...(saved.mcp ?? {}) },
    bridge: { ...base.bridge, ...(saved.bridge ?? {}) },
    update: { ...base.update, ...(saved.update ?? {}) },
    crash: { ...base.crash, ...(saved.crash ?? {}) },
  } as Config;
  delete (cfg.bridge as any).autoHandoff;
  cfg.userName = typeof legacyName === "string" ? legacyName.slice(0, 60) : "";
  if (!EFFORTS.includes(cfg.effort)) cfg.effort = "normal";
  if (typeof cfg.storageDir !== "string") cfg.storageDir = "";
  if (typeof cfg.ocr !== "boolean") cfg.ocr = true;
  if (typeof cfg.accent !== "string" || !cfg.accent) cfg.accent = "ember";
  if (!saved.bridge) migrateBridge(cfg, saved);
  if (!MODES.includes(cfg.bridge.mode)) cfg.bridge.mode = "full";
  if (typeof cfg.bridge.project !== "string" || !cfg.bridge.project || !fs.existsSync(cfg.bridge.project)) cfg.bridge.project = os.homedir();
  if (!["ngrok", "cloudflared", "manual"].includes(cfg.bridge.provider)) cfg.bridge.provider = "ngrok";
  if (typeof cfg.bridge.chatUrl !== "string") cfg.bridge.chatUrl = "";
  if (!(cfg.bridge.listenIdleMin >= 1 && cfg.bridge.listenIdleMin <= 120)) cfg.bridge.listenIdleMin = 10;
  if (!cfg.mcp.token || cfg.mcp.token.length < 16) cfg.mcp.token = crypto.randomBytes(24).toString("hex");
  if (!Number.isInteger(cfg.mcp.port) || cfg.mcp.port < 1024 || cfg.mcp.port > 65535) cfg.mcp.port = 8765;
  if (!MODES.includes(cfg.defaultMode)) cfg.defaultMode = "ask";
  if (!Array.isArray(cfg.recentProjects)) cfg.recentProjects = [];
  if (!Array.isArray(cfg.allow)) cfg.allow = [];
  if (!Array.isArray(cfg.deny)) cfg.deny = [];
  if (typeof cfg.project !== "string" || !cfg.project || !fs.existsSync(cfg.project)) cfg.project = os.homedir();
  return cfg;
}

/** Консольная версия 0.2: toolTransport=mcp и tunnelCommand («ngrok http 8765 --domain=…»). */
function migrateBridge(cfg: Config, saved: Record<string, unknown>) {
  const cmd = typeof saved.tunnelCommand === "string" ? saved.tunnelCommand : "";
  if (/ngrok/i.test(cmd)) {
    cfg.bridge.provider = "ngrok";
    const exe = cmd.match(/^\s*"([^"]*ngrok[^"]*\.exe)"/i)?.[1] ?? cmd.match(/^\s*(\S*ngrok\S*\.exe)/i)?.[1];
    if (exe && fs.existsSync(exe)) cfg.bridge.ngrokPath = exe;
    const dom = cmd.match(/--(?:domain|url|hostname)[= ]+(?:https?:\/\/)?([a-z0-9.-]+)/i)?.[1];
    if (dom) cfg.bridge.ngrokDomain = dom;
  } else if (/cloudflared/i.test(cmd)) cfg.bridge.provider = "cloudflared";
  if (saved.toolTransport === "mcp") cfg.bridge.enabled = true;
}

export function saveConfig(cfg: Config): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const out: Record<string, unknown> = { ...cfg };
  for (const k of API_FIELDS) delete out[k];
  const tmp = CONFIG_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2), "utf8");
  fs.renameSync(tmp, CONFIG_FILE);
}

export function rememberProject(cfg: Config, dir: string): void {
  cfg.project = dir;
  cfg.recentProjects = [dir, ...cfg.recentProjects.filter((p) => p.toLowerCase() !== dir.toLowerCase())].slice(0, 8);
}

/** Чат Notion AI — там агент с подключённым мостом забирает сообщения из Jarvis Code. */
export const NOTION_CHAT_URL = "https://app.notion.com/chat";
