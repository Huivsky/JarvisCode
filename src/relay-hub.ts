import { AsyncLocalStorage } from "node:async_hooks";
import { Inbox, type InboxState } from "./inbox";

/** Each local chat has its own queue, active reply and context window. */
export class RelayHub extends Inbox {
  private channels = new Map<string, Inbox>();
  private scopes = new Map<string, string>();
  private context = new AsyncLocalStorage<string>();
  constructor(private options: { idleMinutes: () => number }) { super(options); }
  override forChat(id: string): Inbox {
    let channel = this.channels.get(id);
    if (!channel) {
      channel = new Inbox(this.options);
      channel.onChange = () => this.onChange?.();
      this.channels.set(id, channel);
    }
    return channel;
  }
  bind(token: string, chatId: string) {
    if (!/^[a-f0-9]{48}$/.test(token)) throw new Error("Invalid relay session");
    this.scopes.set(token, chatId); this.forChat(chatId);
  }
  revoke(chatId: string) {
    const inbox = this.channels.get(chatId); inbox?.cancelChat(chatId);
    for (const [token, id] of this.scopes) if (id === chatId) this.scopes.delete(token);
    this.channels.delete(chatId);
  }
  hasScopedWork(): boolean { return [...this.channels.values()].some(c => !!c.activeChat() || c.state().queued > 0); }
  async scoped<T>(token: unknown, action: () => Promise<T>): Promise<T> {
    if (token === undefined || token === "") {
      if (this.hasScopedWork()) throw new Error("Relay work is active: pass session_id from the chat's launch prompt on every nc_* call.");
      return this.context.run("", action);
    }
    if (typeof token !== "string" || !this.scopes.has(token)) throw new Error("Unknown relay session. Launch this local chat again; never guess a session.");
    return this.context.run(this.scopes.get(token)!, action);
  }
  current(): Inbox { const id = this.context.getStore(); return id ? this.forChat(id) : this; }
  scopedChat(): string { return this.context.getStore() || ""; }
  matchesCurrent(token: unknown): boolean { return typeof token === "string" && !!this.scopes.get(token) && this.scopes.get(token) === this.scopedChat(); }
  override cancelChat(id: string) { this.channels.get(id)?.cancelChat(id); super.cancelChat(id); }
  override markSeen(id: string) { this.forChat(id).markSeen(id); }
  sessions(): Array<{ chatId: string; state: InboxState }> { return [...this.channels].map(([chatId, inbox]) => ({ chatId, state: inbox.state() })); }
  aggregate(): InboxState {
    const states = [super.state(), ...this.sessions().map(s => s.state)];
    return { listening: states.some(s => s.listening), waiting: states.some(s => s.waiting), lastSeenAt: Math.max(...states.map(s => s.lastSeenAt)), queued: states.reduce((a,s) => a+s.queued,0), activeChatId: states.filter(s => s.activeChatId).length === 1 ? states.find(s => s.activeChatId)!.activeChatId : "", paused: states.every(s => s.paused) };
  }
}

export function sessionPrompt(base: string, sessionId: string): string {
  return base + `\n\nISOLATED SESSION: session_id="${sessionId}". Include this exact session_id argument on EVERY nc_* call (nc_inbox, nc_reply, nc_batch and file/command tools). Never omit it or use another session. First call: nc_inbox {"start":true,"session_id":"${sessionId}"}. A missing/unknown session must be fixed by relaunching the local chat, not by bypassing isolation.`;
}
