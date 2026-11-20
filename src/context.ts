/**
 * Контекст чатов хранит сам Jarvis Code (в папке хранилища), а не пространство Notion:
 * любой агент — в другом пространстве, в новом чате Notion — сразу продолжает с того же места.
 *   context/<id>/memory.md — память чата (цель, решения, состояние), её ведёт агент (nc_memory / nc_reply.memory);
 *   context/<id>/chat.md   — вся переписка в Markdown (зеркало чата, обновляется само);
 *   nc_history — агент читает и ищет старые сообщения, которые не поместились в начальный контекст.
 */
import fs from "node:fs";
import path from "node:path";
import type { Chat, ChatItem } from "./chats";
import { chatMarkdown } from "./export";
import { CONTEXT_DIR } from "./paths";

export const MEMORY_MAX = 12_000;

export function contextDir(chatId: string): string {
  return path.join(CONTEXT_DIR, chatId.replace(/[^a-z0-9_-]/gi, ""));
}

export function readMemory(chatId: string): string {
  try {
    return fs.readFileSync(path.join(contextDir(chatId), "memory.md"), "utf8").trim();
  } catch {
    return "";
  }
}

export function writeMemory(chatId: string, text: string): string {
  const t = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  const body = t.length > MEMORY_MAX ? t.slice(0, MEMORY_MAX) + "\n…" : t;
  const dir = contextDir(chatId);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "memory.md");
  fs.writeFileSync(f + ".tmp", body + "\n", "utf8");
  fs.renameSync(f + ".tmp", f);
  return body;
}

/** Зеркало чата в Markdown — можно открыть, переслать, сохранить в Notion. */
export function mirrorChat(chat: Chat) {
  if (chat.bridge) return;
  try {
    const dir = contextDir(chat.id);
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, "chat.md");
    fs.writeFileSync(f + ".tmp", chatMarkdown(chat), "utf8");
    fs.renameSync(f + ".tmp", f);
  } catch {}
}

export function deleteContext(chatId: string) {
  try {
    fs.rmSync(contextDir(chatId), { recursive: true, force: true });
  } catch {}
}

/** Сообщения чата (вопросы и ответы) — то, что нужно агенту из истории. */
export function chatMessages(chat: Chat): ChatItem[] {
  return chat.items.filter((i) => (i.kind === "user" || i.kind === "assistant") && (i.text?.trim() || i.attachments?.length));
}

const role = (i: ChatItem) => (i.kind === "user" ? "User" : "Assistant");
const when = (t: number) => new Date(t).toISOString().slice(0, 16).replace("T", " ");

function render(i: ChatItem, n: number, max: number): string {
  let t = (i.text ?? "").trim();
  if (t.length > max) t = t.slice(0, Math.floor(max * 0.75)) + `\n… (${t.length - max} chars omitted — nc_history {"from": ${n}, "full": true}) …\n` + t.slice(-Math.floor(max * 0.25));
  const atts = i.attachments?.length ? `\n[attachments: ${i.attachments.map((a) => a.path ?? a.name).join("; ")}]` : "";
  return `#${n} ${role(i)}${i.imported ? " (imported)" : ""} · ${when(i.at)}:\n${t}${atts}`;
}

export interface HistoryQuery {
  /** Слова для поиска (все должны встретиться в сообщении). */
  query?: string;
  /** С какого номера сообщения (#n, с 1). */
  from?: number;
  /** До какого номера (не включая). */
  before?: number;
  limit?: number;
  /** Сообщения целиком, без сокращений. */
  full?: boolean;
}

/** nc_history: старые сообщения чата — по номерам или поиском. */
export function chatHistory(chat: Chat, q: HistoryQuery = {}): string {
  const msgs = chatMessages(chat);
  const total = msgs.length;
  if (!total) return `Chat «${chat.title}» has no messages yet.`;
  const limit = Math.max(1, Math.min(60, Math.floor(Number(q.limit) || (q.query ? 12 : 20))));
  const max = q.full ? 60_000 : 3_000;
  const numbered = msgs.map((m, k) => ({ m, n: k + 1 }));
  let picked: { m: ChatItem; n: number }[];
  let what: string;
  if (q.query && String(q.query).trim()) {
    const words = String(q.query).toLowerCase().split(/\s+/).filter(Boolean);
    const hits = numbered.filter(({ m }) => {
      const t = `${m.text ?? ""} ${(m.attachments ?? []).map((a) => a.path ?? a.name).join(" ")}`.toLowerCase();
      return words.every((w) => t.includes(w));
    });
    picked = hits.slice(-limit);
    what = `search «${q.query}»: ${hits.length} match${hits.length === 1 ? "" : "es"}${hits.length > picked.length ? `, showing the last ${picked.length}` : ""}`;
  } else {
    const before = Math.max(1, Math.min(total + 1, Math.floor(Number(q.before) || total + 1)));
    const from = q.from ? Math.max(1, Math.floor(Number(q.from))) : Math.max(1, before - limit);
    picked = numbered.filter(({ n }) => n >= from && n < before).slice(0, limit);
    what = picked.length ? `messages #${picked[0].n}–#${picked[picked.length - 1].n}` : "no messages in this range";
  }
  const head = `Chat «${chat.title}» — ${total} messages (#1–#${total}); ${what}.`;
  let budget = 60_000;
  const body: string[] = [];
  for (const p of picked) {
    const r = render(p.m, p.n, max);
    if (r.length > budget) {
      body.push(`… (more: nc_history {"from": ${p.n}})`);
      break;
    }
    budget -= r.length;
    body.push(r);
  }
  return [head, ...body].join("\n\n");
}

/**
 * Начало переписки для нового агента: последние сообщения целиком (в пределах бюджета),
 * более старые — только счётчик (их можно прочитать через nc_history).
 */
export function recentTranscript(chat: Chat, budget = 24_000, skipLast = true): { text: string; omitted: number } {
  const msgs = chatMessages(chat);
  if (skipLast && msgs.length && msgs[msgs.length - 1].kind === "user" && !msgs[msgs.length - 1].imported) msgs.pop(); // текущее сообщение уйдёт отдельно
  const out: string[] = [];
  let total = 0;
  const per = Math.max(800, Math.min(4000, Math.floor(budget / 6)));
  for (let k = msgs.length - 1; k >= 0 && out.length < 40; k--) {
    const line = render(msgs[k], k + 1, per);
    if (total + line.length > budget && out.length) break;
    total += line.length;
    out.unshift(line);
  }
  return { text: out.join("\n\n"), omitted: msgs.length - out.length };
}

// ───────────── перенос переписки из текста ─────────────

const USER_RE = /^(?:#{1,4}\s*)?\**(вы|я|user|you|me|пользователь|human|человек)\**(?:\s*\([^)]*\))?\s*[:：]?\s*(.*)$/i;
const AI_RE = /^(?:#{1,4}\s*)?\**(агент|ассистент|assistant|ai|ии|notion ai|notion|jarvis|jarvis code|claude|chatgpt|gpt|gemini|бот|bot)\**(?:\s*\([^)]*\))?\s*[:：]?\s*(.*)$/i;

/** Переписка из вставленного текста (копия чата Notion, экспорт Jarvis Code «## Вы / ## Агент» и т. п.). */
export function parseTranscript(raw: string): { role: "user" | "assistant"; text: string }[] {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const out: { role: "user" | "assistant"; text: string }[] = [];
  let cur: { role: "user" | "assistant"; lines: string[] } | null = null;
  let markers = 0;
  let inCode = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) inCode = !inCode;
    const short = line.trim().length <= 120;
    const u = !inCode && short ? line.trim().match(USER_RE) : null;
    const a = !inCode && short && !u ? line.trim().match(AI_RE) : null;
    // «Я: текст» или заголовок «## Вы» — новый блок; обычная фраза «Я думаю…» без двоеточия — нет
    const isMarker = (m: RegExpMatchArray | null) => !!m && (/[:：]/.test(line) || /^\s*#{1,4}\s/.test(line) || !m[2]);
    if (isMarker(u) || isMarker(a)) {
      const m = (u ?? a)!;
      if (cur && cur.lines.join("\n").trim()) out.push({ role: cur.role, text: cur.lines.join("\n").trim() });
      cur = { role: u ? "user" : "assistant", lines: m[2] ? [m[2]] : [] };
      markers++;
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  if (cur && cur.lines.join("\n").trim()) out.push({ role: cur.role, text: cur.lines.join("\n").trim() });
  // меньше двух реплик — это не переписка, а просто текст (заметки, выжимка)
  if (markers < 2 || out.length < 2) return [];
  return out;
}
