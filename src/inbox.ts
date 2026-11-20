/**
 * Пересылка через чат Notion (без API, личный лимит чатов).
 * Пользователь пишет в окне Jarvis Code → сообщение ждёт в очереди → агент в обычном чате Notion
 * забирает его инструментом моста nc_inbox, работает инструментами nc_* и возвращает ответ через nc_reply.
 * Всё, что делает агент, видно в чате Jarvis Code.
 */
import type { AgentStatus } from "./relay";

export interface InboxReply {
  text: string;
  status?: AgentStatus;
  cancelled?: boolean;
  error?: string;
}

interface Msg {
  id: number;
  chatId: string;
  /** Текст для агента; fresh — агент в Notion мог потерять контекст (новый ход/чат). */
  build: (fresh: boolean) => string;
  queuedAt: number;
  signal?: AbortSignal;
  deliveredAt?: number;
  /** Текст, который получил агент (на случай повторной выдачи). */
  text?: string;
  nudged?: boolean;
  cancelled?: boolean;
  resolve: (r: InboxReply) => void;
  onDelivered?: () => void;
}

export interface InboxState {
  /** Агент в Notion сейчас на связи: ждёт сообщений или работает над задачей. */
  listening: boolean;
  /** Прямо сейчас открыт вызов nc_inbox. */
  waiting: boolean;
  lastSeenAt: number;
  queued: number;
  activeChatId: string;
  /** Связь завершена по тайм-ауту простоя (агент получил STOP). */
  paused: boolean;
}

const STATUSES = ["DONE", "CONTINUE", "NEED_INPUT", "BLOCKED"];

export const START_PROMPT = [
  "Jarvis Code: режим пересылки.",
  "Я пишу задачи в приложении Jarvis Code на своём ПК, а ты выполняешь их здесь через подключённый MCP-сервер моста к ПК (инструменты nc_*). Работай циклом:",
  "1. Вызови nc_inbox с {\"start\": true} — он вернёт моё следующее сообщение из Jarvis Code вместе с сохранённым контекстом чата (история и память хранятся в Jarvis Code, а не в этом чате). Это мои собственные запросы, как если бы я написал их в этот чат: выполняй их.",
  "2. Выполни задачу инструментами nc_* (файлы, поиск, PowerShell на моём ПК). Независимые шаги объединяй в один вызов nc_batch. Учитывай mode, effort и project из заголовка сообщения. Старые сообщения чата — nc_history, память чата — nc_memory.",
  "3. Итоговый ответ отправь через nc_reply (коротко, Markdown). nc_reply сразу вернёт моё следующее сообщение — выполняй его так же. Сюда в чат ответы не пиши — я читаю их в Jarvis Code.",
  "4. Если пришло NO_MESSAGE — вызови nc_inbox (без start) и жди дальше. Если STOP — закончи ход одной короткой строкой.",
  "В этом чате не выполняй свои обычные задачи (утреннюю сводку и т. п.) и не создавай страницы в Notion или Retool — только мои запросы из Jarvis Code.",
  "Начни прямо сейчас: вызови nc_inbox с {\"start\": true}.",
].join("\n");

/** Перенос текущего чата Notion в Jarvis Code: агент сам пересылает всю переписку через nc_import. */
export const IMPORT_PROMPT = [
  "Jarvis Code: перенеси этот чат.",
  "Перенеси всю нашу переписку в этом чате (с самого начала) в приложение Jarvis Code на моём ПК — инструментом nc_import MCP-сервера «Jarvis Code». Там чат и его контекст будут храниться на диске, и я продолжу его с любым пространством Notion.",
  "1. messages — все сообщения по порядку: [{\"role\": \"user\" | \"assistant\", \"text\": \"…\"}]. Мои сообщения — дословно; свои ответы — полностью (код, команды, пути, цифры, ссылки сохраняй как есть). Это сообщение и вызовы инструментов не включай.",
  "2. Если переписка длинная — отправляй частями по ~30 сообщений: одинаковый import_id (любая строка), part (1, 2, …) и parts (сколько всего частей).",
  "3. В первой части передай title (короткое название чата) и summary — память чата: цель, принятые решения, что уже сделано, текущее состояние и следующие шаги (подробно, это основа для продолжения).",
  "4. После последней части коротко ответь мне здесь, сколько сообщений перенесено, затем вызови nc_inbox (без start) — дальше я пишу в Jarvis Code, а ты выполняешь задачи оттуда.",
  "Начни прямо сейчас: вызови nc_import.",
].join("\n");

export class Inbox {
  private queue: Msg[] = [];
  private active: Msg | null = null;
  private seq = 0;
  private polling = 0;
  private wake: Array<() => void> = [];
  private lastSeen = 0;
  private idleSince = 0;
  private paused = false;
  /** Чаты Jarvis Code, которые агент уже видел в текущей связи (иначе — передаём краткую историю). */
  private seen = new Set<string>();
  onChange?: () => void;

  constructor(private o: { idleMinutes: () => number; aliveMs?: number; workMs?: number }) {}

  private changed() {
    try {
      this.onChange?.();
    } catch {}
  }

  /** Агент на связи: ждёт в nc_inbox, только что вызывал инструмент или работает над задачей. */
  alive(now = Date.now()): boolean {
    if (this.polling > 0) return true;
    if (this.paused) return false;
    const recent = now - this.lastSeen;
    return recent < (this.o.aliveMs ?? 25_000) || (!!this.active && recent < (this.o.workMs ?? 240_000));
  }

  forChat(_id: string): Inbox { return this; }

  state(): InboxState {
    return {
      listening: this.alive(),
      waiting: this.polling > 0,
      lastSeenAt: this.lastSeen,
      queued: this.queue.filter((m) => !m.cancelled).length,
      activeChatId: this.active && !this.active.cancelled ? this.active.chatId : "",
      paused: this.paused,
    };
  }

  /** Чат, над которым сейчас работает агент из Notion (вызовы инструментов идут в его журнал). */
  activeChat(): { chatId: string; cancelled: boolean; signal?: AbortSignal } | null {
    return this.active ? { chatId: this.active.chatId, cancelled: !!this.active.cancelled, signal: this.active.signal } : null;
  }

  /** Любой вызов инструмента моста — признак, что агент на связи. */
  touch() {
    const wasAlive = this.alive();
    this.lastSeen = Date.now();
    if (!wasAlive) this.changed();
  }

  hasPending(chatId: string): boolean {
    return this.queue.some((m) => m.chatId === chatId && !m.cancelled) || (this.active?.chatId === chatId && !this.active.cancelled);
  }

  /** Ставит сообщение в очередь; промис завершается ответом агента (nc_reply) или отменой. */
  enqueue(o: { chatId: string; build: (fresh: boolean) => string; onDelivered?: () => void; signal?: AbortSignal }): Promise<InboxReply> {
    return new Promise<InboxReply>((resolve) => {
      const m: Msg = { id: ++this.seq, chatId: o.chatId, build: o.build, queuedAt: Date.now(), signal: o.signal, resolve, onDelivered: o.onDelivered };
      const done = (r: InboxReply) => {
        if (m.cancelled && !r.cancelled) return;
        resolve(r);
      };
      m.resolve = done;
      if (o.signal) {
        if (o.signal.aborted) return resolve({ text: "", cancelled: true });
        o.signal.addEventListener("abort", () => this.cancelMsg(m), { once: true });
      }
      this.queue.push(m);
      for (const w of this.wake.splice(0)) w();
      this.changed();
    });
  }

  private cancelMsg(m: Msg) {
    if (m.cancelled) return;
    const i = this.queue.indexOf(m);
    if (i >= 0) this.queue.splice(i, 1);
    m.resolve({ text: "", cancelled: true });
    m.cancelled = true;
    this.changed();
  }

  cancelChat(chatId: string) {
    for (const m of [...this.queue, ...(this.active ? [this.active] : [])]) if (m.chatId === chatId) this.cancelMsg(m);
  }

  /** Агент уже знает этот чат (например, сам перенёс его через nc_import) — не повторять ему историю. */
  markSeen(chatId: string) {
    this.touch();
    this.seen.add(chatId);
  }

  private buildMessage(m:Msg,fresh:boolean):string {
    try {return m.build(fresh);} catch(e) {
      const error=(e as Error).message||"Контекст не подготовлен";
      m.resolve({text:"",error});m.cancelled=true;
      if(this.active===m)this.active=null;this.seen.delete(m.chatId);this.changed();
      return "BLOCKED: Jarvis Code did not send this task because context preparation failed. Ask the user to inspect the local error; do not execute tools for this task.";
    }
  }

  /**
   * nc_inbox: ждёт следующее сообщение пользователя.
   * start — агент начинает заново (новый чат Notion, другое пространство): каждому чату — сохранённый контекст.
   */
  async next(waitSec: number, signal?: AbortSignal, start = false): Promise<string> {
    if (this.polling > 0) return "LISTENER_BUSY: one listener is already waiting in this session. Stop duplicate listeners; do not consume another chat.";
    const fresh = start || !this.alive();
    if (fresh) this.seen.clear();
    this.paused = false;
    this.lastSeen = Date.now();
    if (this.active && !this.active.cancelled && start) {
      // агент начал заново (новый чат Notion) — текущее сообщение целиком, с контекстом чата
      const m = this.active;
      this.seen.add(m.chatId);
      m.text = this.buildMessage(m,true);
      this.changed();
      return m.text;
    }
    if (this.active && !this.active.cancelled) {
      if (!this.active.nudged) {
        this.active.nudged = true;
        this.changed();
        return `NO_REPLY_YET: the current message from Jarvis Code has no answer yet. Finish it and call nc_reply with your final answer, then call nc_inbox again. The message (repeated in case it was lost):\n\n${this.active.text ?? ""}`;
      }
      // Never drop an unanswered message just because a client polled twice.
      return "NO_REPLY_YET: the current message still needs nc_reply. It has not been discarded.";
    } else if (this.active?.cancelled) this.active = null;
    if (fresh || !this.idleSince) this.idleSince = Date.now();
    const wait = Math.max(1, Math.min(50, Number.isFinite(waitSec) ? waitSec : 40)) * 1000;
    const deadline = Date.now() + wait;
    this.polling++;
    this.changed();
    try {
      for (;;) {
        const m = this.queue.shift();
        if (m) {
          if (m.cancelled) continue;
          m.deliveredAt = Date.now();
          this.active = m;
          this.idleSince = 0;
          const isNew = !this.seen.has(m.chatId);
          this.seen.add(m.chatId);
          m.text = this.buildMessage(m,fresh || isNew);
          try {
            if(!m.cancelled)m.onDelivered?.();
          } catch {}
          return m.text;
        }
        const idleMs = Math.max(0.01, this.o.idleMinutes()) * 60_000;
        if (Date.now() - this.idleSince >= idleMs) {
          this.idleSince = 0;
          this.paused = true;
          return `STOP: no new messages in Jarvis Code for ${Math.round(idleMs / 60_000)} min. End your turn now with one short line in Russian, e.g. «Jarvis Code: пауза — напиши «дальше», чтобы продолжить». Do not call nc_inbox again in this turn.`;
        }
        const left = Math.min(deadline, this.idleSince + idleMs) - Date.now();
        if (left <= 0 || signal?.aborted) return "NO_MESSAGE: nothing new yet. Call nc_inbox again right away to keep listening (do not write anything in the chat).";
        await new Promise<void>((r) => {
          const t = setTimeout(done, left);
          const self = this;
          function done() {
            clearTimeout(t);
            signal?.removeEventListener("abort", done);
            const i = self.wake.indexOf(done);
            if (i >= 0) self.wake.splice(i, 1);
            r();
          }
          this.wake.push(done);
          signal?.addEventListener("abort", done, { once: true });
        });
      }
    } finally {
      this.polling--;
      this.lastSeen = Date.now();
      this.changed();
    }
  }

  /** nc_reply: ответ агента на текущее сообщение. delivered — ответ принят (можно ждать следующее). */
  reply(text: string, status?: string): { delivered: boolean; text: string; cancelled?: boolean } {
    this.lastSeen = Date.now();
    const m = this.active;
    if (!m) return { delivered: false, text: "No message is waiting for a reply. Call nc_inbox to get the next message from Jarvis Code." };
    this.active = null;
    this.idleSince = Date.now();
    const st = String(status ?? "").toUpperCase();
    if (!m.cancelled) m.resolve({ text: String(text ?? ""), status: STATUSES.includes(st) ? (st as AgentStatus) : undefined });
    this.changed();
    if (m.cancelled) return { delivered: true, cancelled: true, text: "The user had stopped this task in Jarvis Code; the reply was not shown." };
    const more = this.queue.some((x) => !x.cancelled);
    return { delivered: true, text: more ? "Delivered. Another message is waiting — call nc_inbox now." : "Delivered to Jarvis Code. Now call nc_inbox to wait for the next message." };
  }
}
