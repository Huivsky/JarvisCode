import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Composer, KindIcon, kindOf, useProjectSetter } from "./Composer";
import { cx, openLightbox, useElapsed } from "./common";
import {
  Alert,
  ArrowDown,
  Book,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Cpu,
  External,
  File as FileIcon,
  Folder,
  Image as ImageIcon,
  Info,
  ListChecks,
  Monitor,
  Paperclip,
  Pencil,
  Play,
  Plug,
  Refresh,
  Search,
  Shield,
  Spark,
  Sparkles,
  Swap,
  Terminal,
  Trash,
  Undo,
  X,
  Zap,
} from "./icons";
import { renderMarkdown } from "./markdown";
import { api, BRIDGE_ID, fileUrl, flushQueue, get, openChat, openExternal, retryChat, send, startRelay, toast, unqueue, useStore, type ChatItem, type QueuedMsg, type Todo, NONE } from "./store";

type Block =
  | { kind: "item"; it: ChatItem }
  | { kind: "steps"; id: string; items: ChatItem[] }
  /** Переписка, перенесённая из Notion: одним сворачиваемым блоком. */
  | { kind: "imported"; id: string; items: ChatItem[] }
  /** Итог правок одного ответа агента: файлы, +/−, «Откатить все». tail — ответ, который ещё может идти. */
  | { kind: "changes"; id: string; edits: ChatItem[]; tail: boolean };

const EDIT_TOOL = /^nc_(write_file|edit_file|multi_edit)$/;

/** Подряд идущие вызовы инструментов — одной лентой шагов, как в Claude Code; в конце ответа — итог правок. */
function toBlocks(items: ChatItem[]): Block[] {
  const out: Block[] = [];
  let edits: ChatItem[] = [];
  const flush = (tail: boolean) => {
    if (edits.length > 1) out.push({ kind: "changes", id: "ch-" + edits[0].id, edits, tail });
    edits = [];
  };
  for (const it of items) {
    if (it.imported && (it.kind === "user" || it.kind === "assistant")) {
      const last = out[out.length - 1];
      if (last?.kind === "imported") last.items.push(it);
      else out.push({ kind: "imported", id: "im-" + it.id, items: [it] });
      continue;
    }
    // сообщение, переданное по ходу работы, — часть того же ответа
    if (it.kind === "user" && it.queue !== "steer") flush(false);
    const last = out[out.length - 1];
    if (it.kind === "tool") {
      if (EDIT_TOOL.test(it.tool ?? "") && it.undo && it.status === "ok") edits.push(it);
      if (last?.kind === "steps") last.items.push(it);
      else out.push({ kind: "steps", id: it.id, items: [it] });
    } else out.push({ kind: "item", it });
  }
  flush(true);
  return out;
}

export function ChatView({ id }: { id: string }) {
  const chat = useStore((s) => (s.chat?.id === id ? s.chat : null));
  const live = useStore((s) => s.live[id] ?? null);
  const status = useStore((s) => s.status[id]);
  const queue = useStore((s) => s.queue[id] ?? NONE);
  const setProject = useProjectSetter();
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  const busy = !!status?.busy;

  // автопрокрутка, пока пользователь сам не прокрутил вверх
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [chat?.items, live, busy, chat?.todos]);

  useEffect(() => {
    stick.current = true;
    setAway(false);
  }, [id]);

  // высота меняется и без новых сообщений (догрузились картинки, раскрылся блок) — держимся низа
  const loaded = !!chat;
  useEffect(() => {
    const el = scroller.current;
    const inner = el?.firstElementChild;
    if (!el || !inner || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [id, loaded]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && get().status[id]?.busy && !get().modal && !document.querySelector(".menu, .lightbox, .slash-pop")) {
        e.preventDefault();
        api(`chats/${id}/stop`, { body: {} }).catch(() => {});
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [id]);

  const onClick = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    const copy = t.closest("[data-copy]") as HTMLElement | null;
    if (copy) {
      const code = copy.closest(".codeblock")?.querySelector("code")?.textContent ?? "";
      navigator.clipboard.writeText(code).then(() => {
        copy.textContent = "Скопировано";
        copy.classList.add("done");
        setTimeout(() => {
          copy.textContent = "Копировать";
          copy.classList.remove("done");
        }, 1500);
      });
      return;
    }
    const p = t.closest("[data-path]") as HTMLElement | null;
    if (p?.dataset.path) openExternal(p.dataset.path);
  };

  const blocks = useMemo(() => toBlocks(chat?.items ?? []), [chat?.items]);

  if (!chat)
    return (
      <div className="chat-loading">
        <Spark size={30} spin className="accent" />
      </div>
    );

  const pending = chat.items.filter((i) => i.kind === "approval" && !i.approval?.answer);
  const toBottom = () => {
    const el = scroller.current;
    if (!el) return;
    stick.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  return (
    <div className="chat">
      <div
        className="thread"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          stick.current = near;
          if (away === near) setAway(!near);
        }}
        onClick={onClick}
      >
        <div className="thread-inner">
          {blocks.map((b, i) =>
            b.kind === "steps" ? (
              <Steps key={b.id} items={b.items} last={i === blocks.length - 1} busy={busy} />
            ) : b.kind === "imported" ? (
              <ImportedBlock key={b.id} items={b.items} from={chat.imported?.from} />
            ) : b.kind === "changes" ? (
              b.tail && busy ? null : <TurnChanges key={b.id} chatId={id} edits={b.edits} />
            ) : (
              <Item key={b.it.id} it={b.it} />
            ),
          )}
          {live && (
            <div className="msg assistant streaming">
              <Markdown text={live} />
            </div>
          )}
          {busy && <BusyLine phase={status.phase} since={status.since} iteration={status.iteration} max={status.maxIterations} waiting={pending.length > 0} />}
          <div className="thread-end" />
        </div>
      </div>
      <div className="chat-bottom">
        {away && (
          <button className="to-bottom" onClick={toBottom} aria-label="К последнему сообщению">
            <ArrowDown size={16} />
          </button>
        )}
        {chat.todos && chat.todos.length > 0 && <TodoPanel todos={chat.todos} busy={busy} />}
        {busy && queue.length > 0 && <QueueStrip chatId={id} items={queue} />}
        <Composer
          variant="chat"
          chatId={id}
          effort={chat.effort}
          busy={busy}
          mode={chat.mode}
          project={chat.project}
          onMode={(m) => api(`chats/${id}/mode`, { body: { mode: m } }).catch((e) => toast(e.message, "error"))}
          onProject={setProject}
          onSend={async (t, a) => {
            stick.current = true;
            await send(t, a);
          }}
          onStop={() => api(`chats/${id}/stop`, { body: {} }).catch(() => {})}
        />
        <div className="disclaimer">
          Отвечает агент в чате Notion · он работает с вашим ПК — проверяйте важные действия.
        </div>
      </div>
    </div>
  );
}

/** Сообщения, написанные во время работы: агент прочитает их после текущего шага. */
function QueueStrip({ chatId, items }: { chatId: string; items: QueuedMsg[] }) {
  return (
    <div className="queue" role="status">
      <div className="queue-head">
        <Clock size={13} />
        <span className="queue-title">{items.length > 1 ? `В очереди: ${items.length}` : "В очереди"}</span>
        <span className="queue-hint">агент прочитает после текущего шага</span>
        <button className="queue-now" onClick={() => flushQueue(chatId)} title="Прервать текущий шаг агента и сразу передать сообщение">
          <Zap size={12} /> Отправить сейчас
        </button>
      </div>
      {items.map((q) => (
        <div key={q.id} className="queue-item">
          <span className="queue-text">{q.text || "Файлы без текста"}</span>
          {q.attachments.length > 0 && (
            <span className="queue-files" title={q.attachments.map((a) => a.name).join("\n")}>
              <Paperclip size={11} />
              {q.attachments.length}
            </span>
          )}
          <button className="icon-btn small" title="Убрать из очереди — текст вернётся в поле ввода" aria-label="Убрать из очереди" onClick={() => unqueue(chatId, q.id)}>
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

const Markdown = memo(function Markdown({ text }: { text: string }) {
  return <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
});

// ───── План задачи (nc_todo) ─────

function TodoPanel({ todos, busy }: { todos: Todo[]; busy: boolean }) {
  const done = todos.filter((t) => t.status === "done").length;
  const all = done === todos.length;
  const [open, setOpen] = useState(!all);
  const cur = todos.find((t) => t.status === "in_progress");
  useEffect(() => {
    if (all && !busy) setOpen(false);
  }, [all, busy]);
  return (
    <div className={cx("todo-panel", open && "open", all && "all-done")}>
      <button className="todo-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <ListChecks size={15} />
        <span className="todo-title">План</span>
        <span className="todo-count">
          {done}/{todos.length}
        </span>
        {!open && cur && <span className="todo-cur">{cur.text}</span>}
        <span className="todo-bar" aria-hidden="true">
          <span style={{ width: `${(done / todos.length) * 100}%` }} />
        </span>
        <ChevronDown size={14} className={cx("chev", open && "rot180")} />
      </button>
      {open && (
        <ol className="todo-list">
          {todos.map((t, i) => (
            <li key={i} className={t.status}>
              <span className="todo-box">{t.status === "done" ? <Check size={11} /> : t.status === "in_progress" ? <span className="todo-pulse" /> : null}</span>
              <span className="todo-text">{t.text}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// ───── Сообщения ─────

export const Item = memo(function Item({ it }: { it: ChatItem }) {
  switch (it.kind) {
    case "user":
      return <UserMsg it={it} />;
    case "assistant":
      return <AssistantMsg it={it} />;
    case "tool":
      return <ToolCard it={it} />;
    case "approval":
      return <ApprovalCard it={it} />;
    case "notice":
      if (it.hint === "listen") return <RelayCard lost={it.text === "lost"} />;
      if (it.hint === "failover")
        return (
          <div className="notice failover">
            <Swap size={14} />
            <span>{it.text}</span>
          </div>
        );
      return (
        <div className="notice">
          {it.link ? (
            <a href={it.link} onClick={(e) => (e.preventDefault(), openExternal(it.link!))}>
              {it.text} <External size={12} />
            </a>
          ) : (
            it.text
          )}
        </div>
      );
    case "error":
      return <ErrorCard it={it} />;
  }
  return null;
});

function UserMsg({ it }: { it: ChatItem }) {
  const atts = it.attachments ?? [];
  const media = atts.filter((a) => a.path && /^(image|video)$/.test(kindOf(a.name)));
  const files = atts.filter((a) => !media.includes(a));
  const [openText, setOpenText] = useState<number | null>(null);
  return (
    <div className="msg user">
      {media.length > 0 && (
        <div className="msg-media">
          {media.map((a, i) => {
            const video = kindOf(a.name) === "video";
            const src = fileUrl(a.path!);
            return (
              <button key={i} className={cx("msg-thumb", video && "video")} title={a.path} onClick={() => openLightbox({ src, kind: video ? "video" : "image", name: a.name, path: a.path })}>
                {video ? <video src={src} preload="metadata" muted /> : <img src={src} alt={a.name} loading="lazy" />}
                {video && (
                  <span className="att-video-badge">
                    <Play size={10} />
                    видео
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
      {(files.length > 0 || it.text) && (
        <div className="bubble">
          {files.length > 0 && (
            <div className="bubble-atts">
              {files.map((a, i) =>
                a.text !== undefined && !a.path ? (
                  <button key={i} className={cx("att-chip static paste", openText === i && "open")} onClick={() => setOpenText(openText === i ? null : i)} title="Показать текст">
                    <span className="att-ico">
                      <KindIcon kind="paste" size={14} />
                    </span>
                    <span className="att-name">Вставленный текст</span>
                    <span className="att-meta">{a.text.split("\n").length} строк</span>
                  </button>
                ) : (
                  <button key={i} className="att-chip static" title={a.path ?? a.name} onClick={() => a.path && openExternal(a.path)}>
                    <span className="att-ico">
                      <KindIcon kind={/[\\/]$/.test(a.name) ? "folder" : kindOf(a.name)} size={14} />
                    </span>
                    <span className="att-name">{a.name.replace(/[\\/]$/, "")}</span>
                  </button>
                ),
              )}
            </div>
          )}
          {openText !== null && files[openText]?.text !== undefined && <pre className="bubble-paste">{files[openText].text}</pre>}
          {it.text && <div className="bubble-text">{it.text}</div>}
        </div>
      )}
      {it.queue === "steer" && (
        <div className="msg-steer" title="Написано во время работы — агент получил сообщение вместе с результатами шага">
          <Zap size={11} /> прочитано по ходу работы
        </div>
      )}
    </div>
  );
}

function AssistantMsg({ it }: { it: ChatItem }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="msg assistant">
      <Markdown text={it.text ?? ""} />
      <div className="msg-actions">
        {it.agentStatus === "NEED_INPUT" && <span className="tag blue">Ждёт вашего ответа</span>}
        {it.agentStatus === "BLOCKED" && <span className="tag red">Заблокировано</span>}
        <button
          className={cx("icon-btn small", copied && "done")}
          title="Копировать ответ"
          aria-label="Копировать ответ"
          onClick={() =>
            navigator.clipboard.writeText(it.text ?? "").then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          {copied ? <Check size={15} /> : <Copy size={15} />}
        </button>
      </div>
    </div>
  );
}

/** Ошибка: текст и «Повторить» (если это последнее, что случилось в чате). */
function ErrorCard({ it }: { it: ChatItem }) {
  const chatId = useStore((s) => s.currentId);
  const last = useStore((s) => {
    const items = s.chat?.items ?? NONE;
    for (let i = items.length - 1; i >= 0; i--) if (items[i].kind !== "notice") return items[i].id === it.id;
    return false;
  });
  const busy = useStore((s) => !!(chatId && s.status[chatId]?.busy));
  return (
    <div className="error-box">
      <Alert size={16} />
      <span className="error-text">{it.text}</span>
      {last && !busy && chatId && chatId !== BRIDGE_ID && (
        <button className="btn small" onClick={() => retryChat(chatId)}>
          <Refresh size={13} /> Повторить
        </button>
      )}
    </div>
  );
}

/** Перенесённая из Notion переписка: свёрнута, видны последние реплики. */
function ImportedBlock({ items, from }: { items: ChatItem[]; from?: "notion" | "text" }) {
  const [open, setOpen] = useState(items.length <= 4);
  const shown = open ? items : items.slice(-2);
  const n = items.length;
  return (
    <div className={cx("imported-block", open && "open")}>
      <button className="imported-head" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span>
          {from === "text" ? "Перенесённая переписка" : "История из Notion"} · {n} {plural(n, "сообщение", "сообщения", "сообщений")}
        </span>
        {!open && n > 2 && <span className="muted small">показать все</span>}
      </button>
      <div className="imported-items">
        {shown.map((it) => (
          <Item key={it.id} it={it} />
        ))}
      </div>
    </div>
  );
}


/** Агент в чате Notion не на связи — запустить пересылку одной кнопкой. */
function RelayCard({ lost }: { lost: boolean }) {
  const b = useStore((s) => s.state?.bridge);
  const [busy, setBusy] = useState(false);
  const connected = !!b?.enabled && !!b?.connected;
  const live = !!b?.relay?.listening;
  const go = async () => {
    setBusy(true);
    await startRelay();
    setBusy(false);
  };
  return (
    <div className={cx("credits-card relay-card", live && "ok")}>
      <div className="credits-head">
        <span className={cx("relay-dot", live && "on")} />
        <span>{live ? "Агент в чате Notion на связи" : lost ? "Агент в чате Notion перестал отвечать" : "Запустите агента в чате Notion"}</span>
      </div>
      {!live && (
        <div className="muted small">
          {!connected
            ? "Сначала подключите мост к Notion AI (один раз) — потом запустите пересылку."
            : lost
              ? "Похоже, ход агента закончился. Нажмите кнопку — команда снова окажется в буфере: вставьте её в чат пересылки — Notion или Retool (Ctrl+V) — и отправьте. Сообщение отсюда агент заберёт сам."
              : "Нажмите кнопку: откроется чат пересылки (Notion или Retool), а в буфере будет команда запуска. Вставьте её (Ctrl+V) и отправьте — агент заберёт сообщение отсюда, а ответ придёт сюда же. Пока он на связи, пишите только здесь."}
        </div>
      )}
      {!live && (
        <div className="credits-actions">
          {connected ? (
            <button className="btn primary small" disabled={busy} onClick={go}>
              <External size={14} /> {lost ? "Перезапустить в Notion" : "Запустить в Notion"}
            </button>
          ) : (
            <button className="btn primary small" onClick={() => openChat(BRIDGE_ID)}>
              <Plug size={14} /> Подключить мост
            </button>
          )}
          {connected && (
            <button className="btn small ghost" onClick={() => openChat(BRIDGE_ID)}>
              <Plug size={14} /> Мост
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ───── Шаги (инструменты) ─────

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms} мс`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0).replace(".", ",")} с`;
  return `${Math.floor(ms / 60_000)} мин ${Math.round((ms % 60_000) / 1000)} с`;
}

function toolIcon(tool = "", remote?: boolean) {
  if (remote) return <Sparkles size={14} />;
  if (/run|start|job|kill/.test(tool)) return <Terminal size={14} />;
  if (/list_dir|find_files/.test(tool)) return <Folder size={14} />;
  if (/read_file/.test(tool)) return <FileIcon size={14} />;
  if (/write|edit/.test(tool)) return <Pencil size={14} />;
  if (/search/.test(tool)) return <Search size={14} />;
  if (/system/.test(tool)) return <Cpu size={14} />;
  if (/todo/.test(tool)) return <ListChecks size={14} />;
  if (/screenshot/.test(tool)) return <Monitor size={14} />;
  if (/clipboard/.test(tool)) return <Copy size={14} />;
  if (/trash/.test(tool)) return <Trash size={14} />;
  if (/view_image/.test(tool)) return <ImageIcon size={14} />;
  if (/open/.test(tool)) return <External size={14} />;
  return <Book size={14} />;
}

const STATUS_TEXT: Record<string, string> = { waiting: "ждёт разрешения", running: "", ok: "", error: "ошибка", denied: "отклонено" };
const VISIBLE_TAIL = 3;

function Steps({ items, last, busy }: { items: ChatItem[]; last: boolean; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const collapsible = items.length > VISIBLE_TAIL + 2;
  const hidden = collapsible && !open ? items.slice(0, items.length - VISIBLE_TAIL) : [];
  const shown = hidden.length ? items.slice(-VISIBLE_TAIL) : items;
  const edits = items.filter((i) => /write|edit/.test(i.tool ?? "") && i.status === "ok").length;
  const cmds = items.filter((i) => /run|start/.test(i.tool ?? "")).length;
  const working = last && busy;
  return (
    <div className={cx("steps", working && "working")}>
      {hidden.length > 0 && (
        <button className="steps-more" onClick={() => setOpen(true)}>
          <span className="steps-more-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span>
            Ещё {hidden.length} {plural(hidden.length, "шаг", "шага", "шагов")}
            {edits ? ` · правок: ${edits}` : ""}
            {cmds ? ` · команд: ${cmds}` : ""}
          </span>
          <ChevronDown size={14} />
        </button>
      )}
      {open && collapsible && (
        <button className="steps-more less" onClick={() => setOpen(false)}>
          <span>Свернуть шаги</span>
          <ChevronDown size={14} className="rot180" />
        </button>
      )}
      {shown.map((it) => (
        <ToolCard key={it.id} it={it} />
      ))}
    </div>
  );
}

/** Итог правок ответа агента: какие файлы изменены и «Откатить все» одним нажатием. */
function TurnChanges({ chatId, edits }: { chatId: string; edits: ChatItem[] }) {
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const files = useMemo(() => {
    const m = new Map<string, { name: string; add: number; del: number; undone: boolean; n: number }>();
    for (const e of edits) {
      const name = (e.summary ?? "").replace(/ \(\d+ правок\)$/, "");
      const key = name.toLowerCase().replace(/\\/g, "/");
      const st = e.diff?.length ? diffStat(e.diff) : { add: 0, del: 0 };
      const cur = m.get(key) ?? { name, add: 0, del: 0, undone: true, n: 0 };
      cur.add += st.add;
      cur.del += st.del;
      cur.n++;
      cur.undone = cur.undone && !!e.undone;
      m.set(key, cur);
    }
    return [...m.values()];
  }, [edits]);
  const live = files.filter((f) => !f.undone);
  const add = live.reduce((a, f) => a + f.add, 0);
  const del = live.reduce((a, f) => a + f.del, 0);
  const done = live.length === 0;

  const rollback = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (working) return;
    const n = live.length;
    if (!confirm(`Откатить все правки этого ответа? ${n} ${plural(n, "файл вернётся", "файла вернутся", "файлов вернутся")} к состоянию до ответа агента.`)) return;
    setWorking(true);
    const itemIds = edits.map((x) => x.id);
    try {
      type R = { ok: boolean; changed?: boolean; message?: string };
      let r = await api<R>("undo/turn", { body: { chatId, itemIds } }).catch((err): R => ({ ok: false, message: (err as Error).message }));
      if (!r.ok && r.changed) {
        if (!confirm(`${r.message ?? "Файлы изменились после правок агента."}\n\nВсё равно откатить?`)) return;
        r = await api<R>("undo/turn", { body: { chatId, itemIds, force: true } }).catch((err): R => ({ ok: false, message: (err as Error).message }));
      }
      toast(r.message || (r.ok ? "Правки откачены" : "Не удалось откатить правки"), r.ok ? "success" : "error");
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className={cx("turn-changes", done && "undone", open && "open")}>
      <button className="tc-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="tc-ico">
          <FileIcon size={14} />
        </span>
        <span className="tc-title">
          {done ? "Правки этого ответа откачены" : `Изменено: ${live.length} ${plural(live.length, "файл", "файла", "файлов")}`}
        </span>
        {!done && (add > 0 || del > 0) && (
          <span className="tool-stat">
            {add > 0 && <span className="add">+{add}</span>}
            {del > 0 && <span className="del">−{del}</span>}
          </span>
        )}
        <ChevronRight size={14} className={cx("chev", open && "rot")} />
      </button>
      {!done && (
        <button className="tc-undo" disabled={working} onClick={rollback} title="Вернуть все файлы этого ответа к состоянию до правок агента">
          <Undo size={13} /> {working ? "Откатываю…" : "Откатить все"}
        </button>
      )}
      {open && (
        <div className="tc-list">
          {files.map((f) => (
            <div key={f.name} className={cx("tc-file", f.undone && "undone")}>
              <span className="tc-name" data-path={f.name} title="Открыть файл">
                {f.name}
              </span>
              {f.n > 1 && <span className="tc-n">{f.n} {plural(f.n, "правка", "правки", "правок")}</span>}
              <span className="tool-stat">
                {f.add > 0 && <span className="add">+{f.add}</span>}
                {f.del > 0 && <span className="del">−{f.del}</span>}
              </span>
              {f.undone && <span className="tag">отменено</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function diffStat(lines: string[]): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const l of lines) {
    if (/^\+ \d+ /.test(l) || (/^\+/.test(l) && !/^\+\+\+/.test(l))) add++;
    else if (/^- \d+ /.test(l) || (/^-/.test(l) && !/^---/.test(l))) del++;
  }
  return { add, del };
}

function ToolCard({ it }: { it: ChatItem }) {
  const [open, setOpen] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const chatId = useStore((s) => s.chat?.id);
  const expandable = !!(it.output || (it.diff && it.diff.length));
  const st = it.status ?? "ok";
  const stat = useMemo(() => (it.diff?.length ? diffStat(it.diff) : null), [it.diff]);

  const undo = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!chatId || undoing) return;
    setUndoing(true);
    try {
      let r = await api<{ ok: boolean; changed?: boolean; message?: string }>("undo", { body: { chatId, itemId: it.id } }).catch((err) => ({ ok: false, message: (err as Error).message, changed: false }));
      if (!r.ok && r.changed) {
        if (!confirm(`${r.message ?? "Файл изменился после правки агента."}\n\nВсё равно вернуть версию до правки?`)) return;
        r = await api("undo", { body: { chatId, itemId: it.id, force: true } });
      }
      if (r.ok) toast(r.message || "Правка отменена — файл возвращён", "success");
      else toast(r.message || "Не удалось отменить правку", "error");
    } finally {
      setUndoing(false);
    }
  };

  return (
    <div className={cx("tool", `st-${st}`, open && "open", it.undone && "undone")}>
      <button className="tool-head" onClick={() => expandable && setOpen(!open)} disabled={!expandable} aria-expanded={expandable ? open : undefined}>
        <span className="tool-ico">{st === "running" ? <span className="tool-spin" /> : toolIcon(it.tool, it.remote)}</span>
        <span className={cx("tool-label", st === "running" && "shimmer")}>{it.label || it.tool}</span>
        {it.summary && <span className="tool-sum">{it.summary}</span>}
        {stat && (stat.add > 0 || stat.del > 0) && (
          <span className="tool-stat">
            {stat.add > 0 && <span className="add">+{stat.add}</span>}
            {stat.del > 0 && <span className="del">−{stat.del}</span>}
          </span>
        )}
        <span className="tool-state">
          {st === "ok" && !it.undone && <Check size={13} className="ok" />}
          {(st === "error" || st === "denied") && <X size={13} className="bad" />}
          {st === "waiting" && <Shield size={13} className="warn" />}
          {it.undone && <span className="tag">отменено</span>}
          {STATUS_TEXT[st] && <span>{STATUS_TEXT[st]}</span>}
          {it.ms != null && st !== "running" && st !== "waiting" && <span className="tool-ms">{fmtMs(it.ms)}</span>}
        </span>
        {expandable && <ChevronRight size={14} className={cx("chev", open && "rot")} />}
      </button>
      {!open && it.result && st !== "running" && <div className={cx("tool-result", (st === "error" || st === "denied") && "bad")}>{it.result}</div>}
      {it.preview && st === "ok" && <ToolShot path={it.preview} label={it.label || "Картинка"} />}
      {open && <div className="tool-body">{it.diff && it.diff.length ? <Diff lines={it.diff} /> : <pre className="tool-output">{it.output}</pre>}</div>}
      {it.undo && !it.undone && st === "ok" && (
        <button className="tool-undo" disabled={undoing} onClick={undo} title="Вернуть файл к состоянию до этой правки">
          <Undo size={13} /> {undoing ? "Отменяю…" : "Отменить правку"}
        </button>
      )}
    </div>
  );
}

/** Миниатюра картинки-результата (снимок экрана, буфер обмена); старые снимки удаляются — тогда скрывается. */
function ToolShot({ path, label }: { path: string; label: string }) {
  const [gone, setGone] = useState(false);
  if (gone) return null;
  const src = fileUrl(path);
  return (
    <button className="tool-shot" title={path} onClick={() => openLightbox({ src, kind: "image", name: label, path })}>
      <img src={src} alt={label} loading="lazy" draggable={false} onError={() => setGone(true)} />
    </button>
  );
}

function Diff({ lines }: { lines: string[] }) {
  return (
    <div className="diff" role="table" aria-label="Изменения">
      {lines.map((l, i) => {
        if (l.startsWith("@@"))
          return (
            <div key={i} className="dl hunk">
              {l.replace(/^@@\s*|\s*@@$/g, "")}
            </div>
          );
        const m = l.match(/^([+\- ]) (\d+) ?(.*)$/);
        if (!m) {
          const t = l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : l.startsWith("…") ? "more" : "";
          return (
            <div key={i} className={cx("dl", t)}>
              <span className="ln" />
              <span className="sg">{t === "add" ? "+" : t === "del" ? "−" : ""}</span>
              <span className="tx">{t === "add" || t === "del" ? l.slice(1) : l || " "}</span>
            </div>
          );
        }
        const [, sg, ln, tx] = m;
        const t = sg === "+" ? "add" : sg === "-" ? "del" : "";
        return (
          <div key={i} className={cx("dl", t)}>
            <span className="ln">{ln}</span>
            <span className="sg">{sg === "-" ? "−" : sg === "+" ? "+" : ""}</span>
            <span className="tx">{tx || " "}</span>
          </div>
        );
      })}
    </div>
  );
}

// ───── Разрешения ─────

const RISK: Record<string, string> = { low: "низкий риск", medium: "средний риск", high: "высокий риск" };

function ApprovalCard({ it }: { it: ChatItem }) {
  const a = it.approval!;
  const [fb, setFb] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const answered = !!a.answer;
  const ref = useRef<HTMLDivElement>(null);
  const filePattern = a.pattern?.startsWith("path:");
  const chatPattern = a.pattern?.startsWith("observe:");
  const answerText: Record<string, string> = {
    yes: "Разрешено",
    always: filePattern ? "Разрешено для этого файла до конца чата" : chatPattern ? "Разрешено до конца чата" : "Разрешено для похожих команд до конца чата",
    no: "Отклонено",
    timeout: "Нет ответа — отклонено",
  };

  const answer = async (ans: "yes" | "always" | "no", feedback?: string) => {
    if (sending) return;
    setSending(true);
    try {
      const r = await api<{ ok: boolean }>(`approvals/${it.id}`, { body: { answer: ans, feedback } });
      if (!r.ok) toast("Этот запрос уже неактуален.", "info");
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setSending(false);
    }
  };

  // Горячие клавиши, когда фокус не в поле ввода: Y — разрешить, A — всегда, N — отклонить.
  useEffect(() => {
    if (answered) return;
    const key = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName ?? "").toLowerCase();
      if (tag === "textarea" || tag === "input" || e.ctrlKey || e.metaKey || e.altKey || get().modal) return;
      const k = e.key.toLowerCase();
      if (k === "y" || k === "н") answer("yes");
      else if ((k === "a" || k === "ф") && a.pattern) answer("always");
      else if (k === "n" || k === "т") setFb("");
    };
    window.addEventListener("keydown", key);
    ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    return () => window.removeEventListener("keydown", key);
  }, [answered]);

  const rejected = a.answer === "no" || a.answer === "timeout";
  return (
    <div ref={ref} className={cx("approval", answered && "answered", rejected ? "rejected" : a.answer ? "approved" : "", a.risk && `risk-${a.risk}`)} role={answered ? undefined : "alertdialog"} aria-label={answered ? undefined : "Нужно разрешение"}>
      <div className="approval-head">
        <span className="approval-ico">
          <Shield size={15} />
        </span>
        <span className="approval-title">{a.source === "notion" ? "Действие в Notion" : answered ? "Разрешение" : "Нужно разрешение"}</span>
        <span className="approval-tool">{a.heading}</span>
        {a.risk && !answered && <span className={cx("risk-badge", a.risk)}>{RISK[a.risk]}</span>}
      </div>
      <div className="approval-sum">{a.summary}</div>
      {a.detail && a.detail !== a.summary && <pre className="approval-detail">{a.detail}</pre>}
      {a.cwd && !answered && (
        <div className="approval-cwd" title={a.cwd}>
          <Folder size={13} /> {a.cwd}
        </div>
      )}
      {a.reason && !answered && (
        <div className="approval-reason">
          <Info size={13} /> <span>{a.reason}</span>
        </div>
      )}
      {answered ? (
        <div className="approval-answer">
          {rejected ? <X size={14} /> : <Check size={14} />}
          <span>
            {answerText[a.answer!]}
            {a.feedback ? ` · «${a.feedback}»` : ""}
          </span>
        </div>
      ) : fb === null ? (
        <div className="approval-actions">
          <button className="btn primary" disabled={sending} onClick={() => answer("yes")} autoFocus>
            Разрешить <kbd>Y</kbd>
          </button>
          {a.pattern && (
            <button
              className="btn"
              disabled={sending}
              onClick={() => answer("always")}
              title={filePattern ? `Не спрашивать про ${a.pattern.slice(5)} до конца этого чата` : chatPattern ? "Не спрашивать снова до конца этого чата" : "Не спрашивать о похожих командах до конца этого чата"}
            >
              {filePattern ? (
                <>Всегда для этого файла</>
              ) : chatPattern ? (
                <>Всегда в этом чате</>
              ) : (
                <>
                  Всегда для <code>{a.pattern}</code>
                </>
              )}{" "}
              <kbd>A</kbd>
            </button>
          )}
          <button className="btn ghost" disabled={sending} onClick={() => setFb("")}>
            Отклонить <kbd>N</kbd>
          </button>
        </div>
      ) : (
        <div className="approval-feedback">
          <input
            autoFocus
            value={fb}
            placeholder="Что сделать иначе? (необязательно)"
            onChange={(e) => setFb(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") answer("no", fb.trim() || undefined);
              if (e.key === "Escape") (e.stopPropagation(), setFb(null));
            }}
          />
          <button className="btn danger" disabled={sending} onClick={() => answer("no", fb.trim() || undefined)}>
            Отклонить
          </button>
          <button className="btn ghost" onClick={() => setFb(null)}>
            Назад
          </button>
        </div>
      )}
    </div>
  );
}

function BusyLine({ phase, since, iteration, max, waiting }: { phase: string; since: number; iteration: number; max: number; waiting: boolean }) {
  const elapsed = useElapsed(since);
  return (
    <div className={cx("busy-line", waiting && "waiting")} aria-live="polite">
      <Spark size={20} spin={!waiting} className="accent" />
      <span className={cx("busy-phase", !waiting && "shimmer")}>{waiting ? "Ждёт вашего решения" : phase || "Думает…"}</span>
      {max > 0 && iteration > 0 && (
        <span className="muted">
          · итерация {iteration}/{max}
        </span>
      )}
      {elapsed && <span className="muted">· {elapsed}</span>}
      <span className="busy-hint">
        <kbd>Esc</kbd> остановить
      </span>
    </div>
  );
}
