import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Effort, Mode } from "./config";
import { CHATS_DIR } from "./paths";
import type { AgentStatus } from "./relay";

export type ItemKind = "user" | "assistant" | "tool" | "approval" | "notice" | "error";
export type ToolStatus = "waiting" | "running" | "ok" | "error" | "denied";

export interface Approval {
  source: "local" | "notion";
  heading: string;
  summary: string;
  detail?: string;
  pattern?: string;
  reason?: string;
  risk?: "low" | "medium" | "high";
  cwd?: string;
  answer?: "yes" | "always" | "no" | "timeout";
  feedback?: string;
}

export interface ChatItem {
  id: string;
  taskId?: string;
  kind: ItemKind;
  at: number;
  text?: string;
  /** Вложения сообщения: путь на диске; frames — раскадровка видео; text — вставленный текст без файла. */
  attachments?: { name: string; path?: string; frames?: string; text?: string }[];
  agentStatus?: AgentStatus;
  // инструмент
  tool?: string;
  label?: string;
  summary?: string;
  status?: ToolStatus;
  result?: string;
  output?: string;
  diff?: string[];
  /** id резервной копии файла до правки агента (кнопка «Отменить»). */
  undo?: string;
  /** Картинка-результат инструмента на диске (снимок экрана, буфер обмена) — миниатюра в карточке. */
  preview?: string;
  undone?: boolean;
  remote?: boolean;
  /** Длительность выполнения инструмента, мс. */
  ms?: number;
  /** listen — карточка «агент в чате Notion не на связи» с кнопкой запуска. */
  hint?: "listen";
  /** Сообщение перенесено из другого чата (Notion или текст) — часть контекста, а не новая переписка. */
  imported?: boolean;
  /** Источник: bridge — вызов из чата в Notion через мост MCP. */
  via?: "bridge";
  // подтверждение
  approval?: Approval;
  link?: string;
  /** steer — сообщение написано во время работы агента и передано ему по ходу (вместе с результатами шага). */
  queue?: "steer";
}

export interface Chat {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Журнал моста: действия агента из чата в Notion. */
  bridge?: boolean;
  mode: Mode;
  project: string;
  /** Уровень размышления агента в этом чате. */
  effort?: Effort;
  /** Индивидуальная ссылка на чат Notion; пусто — общая настройка. */
  relayChatUrl?: string;
  relaySessionId?: string;
  /** Чат перенесён из Notion или из текста: откуда, когда, сколько сообщений. */
  imported?: { from: "notion" | "text"; at: number; count: number; importId?: string; source?: string };
  items: ChatItem[];
  /** План задачи от агента (nc_todo). */
  todos?: { text: string; status: "pending" | "in_progress" | "done" }[];
}

export interface ChatSummary {
  id: string;
  title: string;
  updatedAt: number;
  project: string;
  preview: string;
  relayChatUrl?: string;
  bridge?: boolean;
  imported?: boolean;
}

export const BRIDGE_CHAT_ID = "bridge";

export function newId(prefix = ""): string {
  return prefix + crypto.randomBytes(6).toString("hex");
}

export function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 60 ? t.slice(0, 59) + "…" : t || "Новый чат";
}

function summarize(c: Chat): ChatSummary {
  const lastAssistant = [...c.items].reverse().find((i) => i.kind === "assistant" && i.text);
  return {
    id: c.id,
    title: c.title,
    updatedAt: c.updatedAt,
    project: c.project,
    preview: plainPreview(lastAssistant?.text ?? ""),
    bridge: c.bridge,
    imported: !!c.imported,
    relayChatUrl: c.relayChatUrl || "",
  };
}

export class ChatStore {
  private cache = new Map<string, Chat>();
  private index = new Map<string, ChatSummary>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Сохранили чат на диск (для зеркала в Markdown и контекста). */
  onWrite?: (c: Chat) => void;

  constructor(private dir = CHATS_DIR) {
    fs.mkdirSync(dir, { recursive: true });
    this.loadIndex();
  }

  get folder() {
    return this.dir;
  }

  /** Хранилище перенесено: чаты читаются из новой папки (несохранённое записывается до переноса — flush()). */
  relocate(dir: string) {
    this.flush();
    this.cache.clear();
    this.index.clear();
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.loadIndex();
  }

  private file(id: string) {
    return path.join(this.dir, `${id}.json`);
  }

  private loadIndex() {
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const c = JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8")) as Chat;
        if (c?.id) this.index.set(c.id, summarize(c));
      } catch {}
    }
  }

  list(): ChatSummary[] {
    return [...this.index.values()].filter((c) => !c.bridge).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Журнал моста (создаётся при первом обращении). */
  bridgeChat(project: string, mode: Mode): Chat {
    const existing = this.get(BRIDGE_CHAT_ID);
    if (existing) return existing;
    const now = Date.now();
    const c: Chat = {
      id: BRIDGE_CHAT_ID,
      title: "Мост · агент в Notion",
      createdAt: now,
      updatedAt: now,
      bridge: true,
      mode,
      project,
      items: [],
    };
    this.cache.set(c.id, c);
    this.index.set(c.id, summarize(c));
    this.save(c, true);
    return c;
  }

  get(id: string): Chat | undefined {
    if (this.cache.has(id)) return this.cache.get(id);
    try {
      const c = upgradeChat(JSON.parse(fs.readFileSync(this.file(id), "utf8")) as Chat);
      // незавершённые элементы после перезапуска
      for (const it of c.items) {
        if (it.kind === "tool" && (it.status === "running" || it.status === "waiting")) it.status = "error";
        if (it.kind === "approval" && !it.approval?.answer && it.approval) it.approval.answer = "timeout";
      }
      this.cache.set(id, c);
      return c;
    } catch {
      return undefined;
    }
  }

  create(o: { mode: Mode; project: string; title: string; effort?: Effort; imported?: Chat["imported"] }): Chat {
    const now = Date.now();
    const c: Chat = {
      id: newId("c"),
      title: o.title,
      createdAt: now,
      updatedAt: now,
      mode: o.mode,
      project: o.project,
      ...(o.effort ? { effort: o.effort } : {}),
      ...(o.imported ? { imported: o.imported } : {}),
      items: [],
    };
    this.cache.set(c.id, c);
    this.index.set(c.id, summarize(c));
    this.save(c, true);
    return c;
  }

  /** Сохраняет чат (с задержкой, чтобы не писать на диск на каждый токен). */
  save(c: Chat, now = false) {
    c.updatedAt = Date.now();
    if (c.bridge && c.items.length > 600) c.items.splice(0, c.items.length - 400);
    this.index.set(c.id, summarize(c));
    const write = () => {
      this.timers.delete(c.id);
      try {
        const tmp = this.file(c.id) + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(c), "utf8");
        fs.renameSync(tmp, this.file(c.id));
        this.onWrite?.(c);
      } catch {}
    };
    const t = this.timers.get(c.id);
    if (t) clearTimeout(t);
    if (now) write();
    else this.timers.set(c.id, setTimeout(write, 400));
  }

  flush() {
    for (const [id, t] of this.timers) {
      clearTimeout(t);
      const c = this.cache.get(id);
      if (c) this.save(c, true);
    }
  }

  rename(id: string, title: string) {
    const c = this.get(id);
    if (!c) return;
    c.title = title.trim() || c.title;
    this.save(c, true);
  }

  delete(id: string) {
    this.cache.delete(id);
    this.index.delete(id);
    try {
      fs.rmSync(this.file(id), { force: true });
    } catch {}
  }
}

/** Чаты до 4.0 (режим API): поля аккаунта, агента и сессии больше не нужны — чат не привязан к пространству. */
export function upgradeChat(c: Chat): Chat {
  const x = c as Chat & Record<string, unknown>;
  for (const k of ["accountId", "agentId", "agentName", "via", "handoff", "sessionId", "briefedSessionId", "tokens"]) delete x[k];
  for (const it of c.items ?? []) {
    const i = it as ChatItem & Record<string, unknown>;
    if (i.hint && i.hint !== "listen") delete i.hint;
    delete i.handoff;
  }
  c.items ??= [];
  return c;
}

/** Заменяет префикс пути во всех строках чата (вложения, снимки, вывод) — после переноса хранилища. */
export function rewritePaths<T>(value: T, from: string, to: string): T {
  if (!from || from === to) return value;
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pairs: [RegExp, string][] = [[new RegExp(esc(from) + "(?=[\\\\/]|$)", "g"), to]];
  const fwd = from.replace(/\\/g, "/");
  if (fwd !== from) pairs.push([new RegExp(esc(fwd) + "(?=/|$)", "g"), to.replace(/\\/g, "/")]);
  const fix = (s: string) => pairs.reduce((acc, [re, rep]) => acc.replace(re, () => rep), s);
  const walk = (v: any): any => {
    if (typeof v === "string") return fix(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      for (const k of Object.keys(v)) v[k] = walk(v[k]);
      return v;
    }
    return v;
  };
  return walk(value);
}

/** Короткий текст для списка/поиска: без markdown-разметки, таблиц и кода. */
export function plainPreview(md: string, max = 120): string {
  return md
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/^\s*\|?\s*:?-{3,}.*$/gm, " ")
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[|*_`~]+/g, " ")
    .replace(/^-{3,}$/gm, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

