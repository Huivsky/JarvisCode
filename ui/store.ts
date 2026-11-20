import { useSyncExternalStore } from "react";
import type { ChatItem, ChatSummary } from "../src/chats";
import type { Effort, Mode, TunnelProvider } from "../src/config";
import type { StorageInfo, MoveProgress } from "../src/storage";
import type { BridgeState } from "../src/bridge";
import type { LegacyStartup } from "../src/win";

export type { BridgeState, ChatItem, ChatSummary, Effort, LegacyStartup, Mode, MoveProgress, StorageInfo, TunnelProvider };

export const EFFORTS: { key: Effort; label: string; hint: string }[] = [
  { key: "fast", label: "Быстро", hint: "Коротко, без лишних проверок" },
  { key: "normal", label: "Обычно", hint: "Как обычно" },
  { key: "deep", label: "Глубоко", hint: "Изучить код, проверить результат" },
  { key: "max", label: "Максимум", hint: "План, тщательная проверка, тесты" },
];
export const effortLabel = (e?: string) => EFFORTS.find((x) => x.key === e)?.label ?? "Обычно";

export interface BridgeSettings {
  enabled: boolean;
  mode: Mode;
  project: string;
  provider: TunnelProvider;
  ngrokPath: string;
  ngrokDomain: string;
  ngrokAuthtokenSet: boolean;
  publicUrl: string;
  approvalTimeoutSec: number;
  chatUrl: string;
  listenIdleMin: number;
  port: number;
}

export interface Settings {
  defaultMode: Mode;
  project: string;
  recentProjects: string[];
  fileScope: "any" | "project";
  shell: "powershell" | "pwsh" | "cmd";
  commandTimeoutSec: number;
  approvalTimeoutSec: number;
  maxIterations: number;
  maxMinutes: number;
  allow: string[];
  deny: string[];
  theme: "dark" | "light" | "system";
  sendOnEnter: boolean;
  /** Уровень размышления для новых чатов. */
  effort: Effort;
  /** Распознанный текст к картинкам для агента. */
  ocr: boolean;
  userName: string;
  storageDir: string;
  accent: string;
  /** builtin — источник, вшитый при сборке (используется, если в настройках пусто). */
  update: { auto: boolean; repo: string; manifestUrl: string; skipped: string; lastCheck: number; builtin?: string };
  crash: { send: boolean; endpoint: string };
}
export interface UpdateInfo {
  status: "idle" | "checking" | "uptodate" | "available" | "downloading" | "ready" | "installing" | "error";
  current: string;
  latest?: { version: string; notes?: string; url?: string; size?: number; date?: string };
  progress?: number;
  error?: string;
  lastCheck?: number;
  source?: string;
  /** Эту версию пропустили — без напоминаний. */
  skipped?: boolean;
}
export interface CrashInfo {
  id: string;
  at: number;
  message: string;
}
export interface AppState {
  version: string;
  mode: "app" | "installer";
  user: { name: string; custom: boolean };
  storage: StorageInfo;
  bridgeSettings: BridgeSettings;
  bridge: BridgeState;
  autostart: { enabled: boolean; available: boolean };
  settings: Settings;
  chats: ChatSummary[];
  busy: Record<string, { phase: string; since: number; iteration?: number; maxIterations?: number; queued?: number }>;
  system: { home: string; drives: string[]; platform: string; user: string; dataDir: string };
  initialProject: string | null;
  update?: UpdateInfo;
  /** Отчёты о сбоях с прошлых запусков, ещё не просмотренные. */
  crashes?: CrashInfo[];
}
export interface ChatFull {
  id: string;
  title: string;
  mode: Mode;
  project: string;
  items: ChatItem[];
  effort?: Effort;
  relayChatUrl?: string;
  bridge?: boolean;
  imported?: { from: "notion" | "text"; at: number; count: number; source?: string };
  todos?: Todo[];
}
export interface Todo {
  text: string;
  status: "pending" | "in_progress" | "done";
}
/** Сообщение, написанное во время работы агента: ждёт, пока агент закончит текущий шаг. */
export interface QueuedMsg {
  id: string;
  text: string;
  at: number;
  attachments: { name: string; path?: string; text?: string }[];
}

export const BRIDGE_ID = "bridge";
export interface ChatStatus {
  busy: boolean;
  phase: string;
  since: number;
  iteration: number;
  maxIterations: number;
}
export interface Toast {
  id: number;
  level: "info" | "error" | "success";
  text: string;
}

interface Store {
  ready: boolean;
  connected: boolean;
  state: AppState | null;
  currentId: string | null;
  chat: ChatFull | null;
  live: Record<string, string | null>;
  status: Record<string, ChatStatus>;
  attention: Record<string, boolean>;
  toasts: Toast[];
  sidebar: boolean;
  modal: null | "settings" | "search" | "folders" | "import";
  settingsTab: string;
  draftProject: string | null;
  draftMode: Mode | null;
  /** Уровень мышления для нового (ещё не созданного) чата. */
  draftEffort: Effort | null;
  /** Очередь сообщений по чатам (агент прочитает их после текущего шага). */
  queue: Record<string, QueuedMsg[]>;
  /** Вернуть текст в поле ввода (после «Стоп» сообщения из очереди не теряются). */
  restore: { chatId: string; items: QueuedMsg[]; n: number } | null;
  /** Перенос хранилища: ход копирования. */
  storageMove: MoveProgress | null;
  install: { steps: { id: string; label: string; status: string; error?: string }[]; done?: boolean; ok?: boolean; dir?: string; error?: string } | null;
}

const params = new URLSearchParams(location.hash.slice(1));
const hashToken = params.get("t");
if (hashToken) sessionStorage.setItem("nc-token", hashToken);
const TOKEN = hashToken ?? sessionStorage.getItem("nc-token") ?? "";

/** Адрес файла с диска для превью в окне (картинки, видео, аудио, PDF). */
export function fileUrl(p: string): string {
  return `/file?path=${encodeURIComponent(p)}&t=${encodeURIComponent(TOKEN)}`;
}

export interface Uploaded {
  path: string;
  name: string;
  size: number;
  kind: string;
}
/** Потоковая загрузка файла в ~/.notion-code/uploads (до 4 ГБ) с прогрессом. */
export function uploadFile(file: Blob, name: string, onProgress?: (p: number) => void, signal?: AbortSignal): Promise<Uploaded> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("POST", `/api/upload?name=${encodeURIComponent(name)}`);
    x.setRequestHeader("x-nc-token", TOKEN);
    x.setRequestHeader("content-type", "application/octet-stream");
    x.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    x.onload = () => {
      let data: any = {};
      try {
        data = JSON.parse(x.responseText);
      } catch {}
      if (x.status >= 200 && x.status < 300 && data.path) resolve(data as Uploaded);
      else reject(new Error(data?.error ?? `HTTP ${x.status}`));
    };
    x.onerror = () => reject(new Error("Нет связи с Jarvis Code"));
    x.onabort = () => reject(new Error("Отменено"));
    signal?.addEventListener("abort", () => x.abort());
    x.send(file);
  });
}
export const VIEW = params.get("view") ?? sessionStorage.getItem("nc-view") ?? "app";
sessionStorage.setItem("nc-view", VIEW);
const hashProject = params.get("project");
const hashChat = params.get("chat");
if (location.hash) history.replaceState(null, "", location.pathname);

let s: Store = {
  ready: false,
  connected: false,
  state: null,
  currentId: hashChat && /^[a-z0-9]+$/.test(hashChat) ? hashChat : null,
  chat: null,
  live: {},
  status: {},
  attention: {},
  toasts: [],
  sidebar: localStorage.getItem("nc-sidebar") !== "0",
  modal: null,
  settingsTab: "general",
  draftProject: hashProject,
  draftMode: null,
  draftEffort: null,
  queue: {},
  restore: null,
  storageMove: null,
  install: null,
};
const listeners = new Set<() => void>();

export function get(): Store {
  return s;
}
export function set(patch: Partial<Store> | ((s: Store) => Partial<Store>)) {
  const p = typeof patch === "function" ? patch(s) : patch;
  s = { ...s, ...p };
  for (const l of listeners) l();
}
/** Стабильные «пустые» значения для селекторов: новый [] или {} на каждый вызов зациклил бы useSyncExternalStore. */
export const NONE: never[] = [];
export const NONE_MAP: Record<string, never> = {};

export function useStore<T>(sel: (s: Store) => T): T {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => sel(s),
  );
}

// ───── API ─────

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const r = await fetch(`/api/${path}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers: { "x-nc-token": TOKEN, "content-type": "application/json" },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error ?? `HTTP ${r.status}`);
  return data as T;
}

let toastSeq = 0;
export function toast(text: string, level: Toast["level"] = "info") {
  const id = ++toastSeq;
  set((st) => ({ toasts: [...st.toasts, { id, level, text }] }));
  setTimeout(() => set((st) => ({ toasts: st.toasts.filter((t) => t.id !== id) })), level === "error" ? 7000 : 3500);
}

export function openExternal(target: string) {
  const base = get().chat?.project;
  api<{ ok: boolean; error?: string }>("open", { body: { target, base } })
    .then((r) => r.ok === false && r.error && toast(r.error, "error"))
    .catch(() => {});
}

// ───── WebSocket ─────

let ws: WebSocket | null = null;
let retry = 0;

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws?t=${encodeURIComponent(TOKEN)}`);
  ws.onopen = () => {
    retry = 0;
    set({ connected: true });
    refreshState();
    const id = get().currentId;
    if (id) loadChat(id);
  };
  ws.onclose = () => {
    set({ connected: false });
    setTimeout(connect, Math.min(5000, 300 * 2 ** retry++));
  };
  ws.onmessage = (m) => {
    try {
      onEvent(JSON.parse(m.data));
    } catch (e) {
      console.error(e);
    }
  };
}

function onEvent(ev: any) {
  const st = get();
  switch (ev.type) {
    case "state":
      set({ state: ev.state });
      break;
    case "chats":
      if (st.state) set({ state: { ...st.state, chats: ev.chats } });
      break;
    case "storage":
      if (st.state) set({ state: { ...st.state, storage: ev.storage } });
      break;
    case "storage.move":
      set({ storageMove: ev.progress?.phase === "done" ? null : ev.progress });
      break;
    case "chat.reload":
      if (st.currentId === ev.chatId) loadChat(ev.chatId);
      break;
    case "imported":
      importedListeners.forEach((f) => f(ev));
      break;
    case "bridge":
      if (st.state) set({ state: { ...st.state, bridge: ev.bridge } });
      break;
    case "focus":
      window.focus();
      break;
    case "chat.item": {
      const chat = st.chat;
      if (chat && chat.id === ev.chatId) {
        const items = chat.items.slice();
        const i = items.findIndex((x) => x.id === ev.item.id);
        if (i >= 0) items[i] = ev.item;
        else items.push(ev.item);
        set({ chat: { ...chat, items } });
      }
      if (ev.item.kind === "approval" && !ev.item.approval?.answer && st.currentId !== ev.chatId) set((x) => ({ attention: { ...x.attention, [ev.chatId]: true } }));
      break;
    }
    case "chat.live":
      set((x) => ({ live: { ...x.live, [ev.chatId]: ev.text } }));
      break;
    case "chat.status": {
      set((x) => ({
        status: { ...x.status, [ev.chatId]: { busy: ev.busy, phase: ev.phase, since: ev.since, iteration: ev.iteration, maxIterations: ev.maxIterations } },
      }));
      break;
    }
    case "chat.meta":
      if (st.chat && st.chat.id === ev.chatId)
        set({
          chat: {
            ...st.chat,
            mode: ev.mode,
            project: ev.project,
            title: ev.title ?? st.chat.title,
            effort: ev.effort ?? st.chat.effort,
          },
        });
      break;
    case "attention":
      notify(ev.title ? `Нужно подтверждение: ${ev.title}` : "Нужно подтверждение", ev.body ?? "", ev.chatId);
      break;
    case "done":
      if (document.hidden) notify("Агент ответил", ev.title ?? "", ev.chatId);
      break;
    case "toast":
      toast(ev.text, ev.level ?? "info");
      break;
    case "chat.queue":
      set((x) => ({ queue: { ...x.queue, [ev.chatId]: ev.queue ?? [] } }));
      break;
    case "chat.unqueue":
      if (ev.items?.length) {
        set((x) => ({ restore: { chatId: ev.chatId, items: ev.items, n: (x.restore?.n ?? 0) + 1 } }));
        if (st.currentId === ev.chatId) toast(ev.items.length > 1 ? "Сообщения из очереди вернулись в поле ввода" : "Сообщение из очереди вернулось в поле ввода");
      }
      break;
    case "chat.todos":
      if (st.chat && st.chat.id === ev.chatId) set({ chat: { ...st.chat, todos: ev.todos } });
      break;
    case "update":
      if (st.state) set({ state: { ...st.state, update: ev.update } });
      break;
    case "settings":
      if (st.state) {
        set({ state: { ...st.state, settings: { ...st.state.settings, ...ev.settings } } });
        if (ev.settings?.accent) applyAccent(ev.settings.accent);
      }
      break;
    case "install.steps":
      set((x) => ({ install: { ...(x.install ?? {}), steps: ev.steps } }));
      break;
    case "install.done":
      set((x) => ({ install: { steps: x.install?.steps ?? [], done: true, ok: ev.ok, dir: ev.dir, error: ev.error } }));
      break;
  }
}

let baseTitle = "Jarvis Code";
let flash: ReturnType<typeof setInterval> | null = null;
function notify(title: string, body: string, chatId: string) {
  if (!document.hidden && get().currentId === chatId) return;
  if (document.hidden) {
    if (!flash) {
      let on = false;
      flash = setInterval(() => {
        on = !on;
        document.title = on ? `● ${title}` : baseTitle;
      }, 1000);
    }
    if ("Notification" in window && Notification.permission === "granted") {
      const n = new Notification(title, { body, icon: "/icon.png", tag: chatId });
      n.onclick = () => {
        window.focus();
        openChat(chatId);
        n.close();
      };
    }
  }
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && flash) {
    clearInterval(flash);
    flash = null;
    document.title = baseTitle;
  }
});

export async function refreshState() {
  try {
    const state = await api<AppState>("state");
    const patch: Partial<Store> = { state, ready: true };
    if (state.initialProject) patch.draftProject = state.initialProject;
    const status: Record<string, ChatStatus> = {};
    for (const [id, b] of Object.entries(state.busy)) status[id] = { busy: true, phase: b.phase, since: b.since, iteration: b.iteration ?? 0, maxIterations: b.maxIterations ?? 0 };
    patch.status = status;
    set(patch);
    applyTheme(state.settings.theme);
    applyAccent(state.settings.accent);
  } catch (e) {
    set({ ready: true });
    toast(`Нет связи с Jarvis Code: ${(e as Error).message}`, "error");
  }
}

let themePref: Settings["theme"] = "dark";
export function applyTheme(theme: Settings["theme"]) {
  themePref = theme;
  const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  localStorage.setItem("nc-theme", dark ? "dark" : "light");
}
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => themePref === "system" && applyTheme("system"));

export const ACCENTS: { key: string; label: string }[] = [
  { key: "ember", label: "Янтарь" },
  { key: "arc", label: "Лазурь" },
  { key: "jade", label: "Нефрит" },
  { key: "violet", label: "Аметист" },
  { key: "graphite", label: "Графит" },
];
export function applyAccent(accent: string | undefined) {
  const a = ACCENTS.some((x) => x.key === accent) ? accent! : "ember";
  document.documentElement.dataset.accent = a;
  localStorage.setItem("nc-accent", a);
}
// без вспышки при запуске: тема и акцент из прошлого сеанса — до ответа сервера
document.documentElement.dataset.theme = localStorage.getItem("nc-theme") ?? "dark";
document.documentElement.dataset.accent = localStorage.getItem("nc-accent") ?? "ember";

export async function loadChat(id: string) {
  try {
    const c = await api<ChatFull & { busy: any; queue?: QueuedMsg[] }>(`chats/${id}`);
    if (get().currentId === id) set((x) => ({ chat: c, queue: { ...x.queue, [id]: c.queue ?? [] } }));
  } catch (e) {
    toast((e as Error).message, "error");
    set({ currentId: null, chat: null });
  }
}

export function openChat(id: string | null) {
  set((x) => ({ currentId: id, chat: id && x.chat?.id === id ? x.chat : null, attention: id ? { ...x.attention, [id]: false } : x.attention, modal: null }));
  if (id) loadChat(id);
}

export function newChat(project?: string) {
  set({ currentId: null, chat: null, modal: null, draftProject: project ?? get().draftProject });
  setTimeout(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus(), 30);
}

export interface OutAttachment {
  name: string;
  path?: string;
  content?: string;
  /** Двоичный файл (картинка, PDF…) в base64 — сервер сохранит его в ~/.notion-code/uploads. */
  data?: string;
  /** Раскадровка видео (JPEG-лист кадров) — путь на диске. */
  frames?: string;
  /** Превью для чипа (только в окне, на сервер не уходит). */
  preview?: string;
}

export async function send(text: string, attachments: OutAttachment[]) {
  const st = get();
  let id = st.currentId;
  if (id === BRIDGE_ID) throw new Error("Это журнал моста — пишите агенту в Notion.");
  if (!id) {
    const c = await api<ChatFull>("chats", {
      body: { mode: st.draftMode ?? st.state?.settings.defaultMode, project: st.draftProject ?? st.state?.settings.project, effort: st.draftEffort ?? st.state?.settings.effort },
    });
    id = c.id;
    set({ currentId: id, chat: c, draftMode: null, draftEffort: null });
  }
  const r = await api<{ ok: boolean; queued?: QueuedMsg }>(`chats/${id}/send`, {
    body: { text, attachments: attachments.map((a) => ({ name: a.name, path: a.path, content: a.content, data: a.data, frames: a.frames })) },
  });
  if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
  return r;
}

/** Убрать сообщение из очереди — оно вернётся в поле ввода. */
export async function unqueue(chatId: string, qid: string): Promise<void> {
  try {
    const r = await api<{ ok: boolean; item: QueuedMsg }>(`chats/${chatId}/unqueue`, { body: { id: qid } });
    set((x) => ({ restore: { chatId, items: [r.item], n: (x.restore?.n ?? 0) + 1 } }));
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

/** «Отправить сейчас»: прервать текущий шаг агента и сразу передать очередь. */
export function flushQueue(chatId: string) {
  api(`chats/${chatId}/flush`, { body: {} }).catch((e) => toast((e as Error).message, "error"));
}

export function setTitle(t: string) {
  baseTitle = t;
  if (!flash) document.title = t;
}

export function start() {
  connect();
}

/** «Подключить» мост в Notion AI: текст с адресом моста — в буфер, чат Notion AI — в браузере. */
export async function connectNotion(): Promise<void> {
  try {
    const r = await api<{ prompt: string; copied: boolean; hasUrl: boolean }>("bridge/connect", { body: {} });
    const copied = r.copied || (await copyText(r.prompt));
    if (!r.hasUrl) toast("Мост ещё запускается — адреса пока нет. Подождите пару секунд и нажмите ещё раз.", "error");
    else toast(copied ? "Открываю Notion AI — текст в буфере: вставьте (Ctrl+V) и отправьте" : "Открываю Notion AI — скопировать текст не удалось", copied ? "success" : "error");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

async function copyText(t: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(t);
    return true;
  } catch {
    return false;
  }
}

/** Куда ведёт ссылка пересылки: Notion AI (по умолчанию) или Retool. */
export function relayServiceName(url?: string): "Notion" | "Retool" {
  try { return /(^|\.)retool\.(com|app)$/.test(new URL(url || "").hostname.toLowerCase()) ? "Retool" : "Notion"; }
  catch { return "Notion"; }
}

/** Пересылка через чат Notion или Retool: команда запуска — в буфер, чат — в браузере. */
export async function startRelay(): Promise<void> {
  try {
    const r = await api<{ prompt: string; copied: boolean; connected: boolean; chatId?: string }>("relay/start", { body: { chatId: get().currentId && get().currentId !== BRIDGE_ID ? get().currentId : undefined } });
    if (r.chatId && r.chatId !== get().currentId) await openChat(r.chatId);
    let copied = r.copied;
    if (!copied) {
      try {
        await navigator.clipboard.writeText(r.prompt);
        copied = true;
      } catch {}
    }
    const where = relayServiceName(get().chat?.relayChatUrl || get().state?.bridgeSettings.chatUrl);
    toast(
      copied ? `Открываю чат ${where} — команда в буфере: вставьте (Ctrl+V) и отправьте. Дальше пишите здесь` : `Открываю чат ${where} — скопировать команду не удалось`,
      copied ? "success" : "error",
    );
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

/** Уровень мышления: чата или (без чата) — для нового чата. */
export async function setEffort(chatId: string | null | undefined, effort: Effort): Promise<void> {
  try {
    if (chatId && chatId !== BRIDGE_ID) {
      await api(`chats/${chatId}/effort`, { body: { effort } });
      set((x) => ({ chat: x.chat && x.chat.id === chatId ? { ...x.chat, effort } : x.chat }));
    } else set({ draftEffort: effort });
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

/** Перенос чата из Notion: команда для агента — в буфер обмена (вставить в нужный чат Notion). */
export async function importPrompt(open = true): Promise<boolean> {
  try {
    const r = await api<{ prompt: string; copied: boolean }>("import/prompt", { body: { open } });
    return r.copied || (await copyText(r.prompt));
  } catch (e) {
    toast((e as Error).message, "error");
    return false;
  }
}

/** Перенос переписки из вставленного текста или файла. */
export async function importText(text: string, title?: string): Promise<{ chatId: string; count: number; parsed: boolean } | null> {
  try {
    const r = await api<{ chatId: string; count: number; parsed: boolean; title: string }>("chats/import", { body: { text, title } });
    toast(r.parsed ? `Чат «${r.title}» перенесён: ${r.count} сообщ.` : `Создан чат «${r.title}» с этим контекстом`, "success");
    openChat(r.chatId);
    return r;
  } catch (e) {
    toast((e as Error).message, "error");
    return null;
  }
}

type ImportedEvent = { chatId: string; title: string; count: number };
const importedListeners = new Set<(e: ImportedEvent) => void>();
/** Агент перенёс чат из Notion (nc_import) — окно может сразу открыть его. */
export function onImported(f: (e: ImportedEvent) => void): () => void {
  importedListeners.add(f);
  return () => importedListeners.delete(f);
}

/** Повторить последнее сообщение (после ошибки или если агент не ответил). */
export function retryChat(chatId: string) {
  api(`chats/${chatId}/retry`, { body: {} }).catch((e) => toast((e as Error).message, "error"));
}
