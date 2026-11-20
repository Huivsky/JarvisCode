import { useEffect, useRef, useState } from "react";
import { cx, Modal } from "./common";
import { Check, Copy, External, FileText, Paperclip, Plug } from "./icons";
import { connectNotion, importPrompt, importText, onImported, set, toast, useStore } from "./store";

type Way = "notion" | "text";

/** Перенос чата в Jarvis Code: из чата Notion (агент сам передаёт переписку) или из текста/файла. */
export function ImportModal() {
  const bridge = useStore((s) => s.state?.bridge);
  const [way, setWay] = useState<Way>("notion");
  const close = () => set({ modal: null });
  return (
    <Modal title="Перенести чат в Jarvis Code" onClose={close} wide className="import-modal">
      <p className="muted">
        Перенесённый чат хранится на этом ПК — его можно продолжить здесь, даже из другого рабочего пространства Notion. Агент получит всю
        переписку и краткую выжимку как контекст.
      </p>
      <div className="seg import-tabs">
        <button className={cx(way === "notion" && "active")} onClick={() => setWay("notion")}>
          Из чата Notion
        </button>
        <button className={cx(way === "text" && "active")} onClick={() => setWay("text")}>
          Из текста или файла
        </button>
      </div>
      {way === "notion" ? <FromNotion connected={!!bridge?.connected} /> : <FromText />}
    </Modal>
  );
}

function FromNotion({ connected }: { connected: boolean }) {
  const [copied, setCopied] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [got, setGot] = useState<{ title: string; count: number } | null>(null);
  useEffect(() => onImported((e) => setGot({ title: e.title, count: e.count })), []);
  const copy = async (open: boolean) => {
    const ok = await importPrompt(open);
    setCopied(ok);
    if (ok) setWaiting(true);
    toast(ok ? (open ? "Команда в буфере. Откройте нужный чат Notion, вставьте (Ctrl+V) и отправьте" : "Команда скопирована") : "Скопировать не удалось", ok ? "success" : "error");
  };
  return (
    <div className="import-way">
      {!connected && (
        <div className="import-warn">
          <Plug size={16} />
          <span>
            Jarvis Code ещё не подключён к Notion AI в этом рабочем пространстве. Сначала подключите — один раз на каждое пространство.
          </span>
          <button className="btn small" onClick={() => connectNotion()}>
            Подключить
          </button>
        </div>
      )}
      <ol className="import-steps">
        <li>
          <b>Скопируйте команду переноса.</b>
          <div className="import-actions">
            <button className="btn primary" onClick={() => copy(false)}>
              {copied ? <Check size={15} /> : <Copy size={15} />} Скопировать команду
            </button>
            <button className="btn" onClick={() => copy(true)}>
              <External size={15} /> Скопировать и открыть Notion
            </button>
          </div>
        </li>
        <li>
          <b>Откройте в Notion тот чат, который нужно перенести,</b> вставьте команду (Ctrl+V) и отправьте. Агент передаст переписку и выжимку в
          Jarvis Code.
        </li>
        <li>
          <b>Готово</b> — чат появится здесь и откроется сам. Дальше этот же чат Notion можно использовать как связь с ПК.
        </li>
      </ol>
      {got ? (
        <div className="import-done">
          <Check size={16} /> Перенесён «{got.title}» — {got.count} сообщ.
        </div>
      ) : (
        waiting && (
          <div className="import-wait muted small">
            <span className="tool-spin" /> Жду, пока агент в Notion передаст чат…
          </div>
        )
      )}
    </div>
  );
}

function FromText() {
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const pick = (f?: File | null) => {
    if (!f) return;
    if (f.size > 20 * 1024 * 1024) return toast("Файл больше 20 МБ", "error");
    const r = new FileReader();
    r.onload = () => {
      setText(String(r.result ?? ""));
      if (!title) setTitle(f.name.replace(/\.(md|txt|markdown)$/i, ""));
    };
    r.onerror = () => toast("Не удалось прочитать файл", "error");
    r.readAsText(f);
  };
  const go = async () => {
    if (!text.trim()) return;
    setBusy(true);
    const r = await importText(text, title.trim() || undefined);
    setBusy(false);
    if (r) set({ modal: null });
  };
  return (
    <div
      className="import-way"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        pick(e.dataTransfer.files?.[0]);
      }}
    >
      <p className="muted small">
        Вставьте переписку (например, скопированную из чата Notion или экспорт в Markdown). Реплики вида «Вы:» / «Notion AI:» или «## User» / «##
        Assistant» распознаются как сообщения; иначе весь текст станет контекстом нового чата.
      </p>
      <div className="field">
        <input placeholder="Название чата (необязательно)" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="field import-text">
        <textarea placeholder="Текст переписки…" value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      <div className="import-actions">
        <button className="btn" onClick={() => file.current?.click()}>
          <Paperclip size={15} /> Выбрать файл…
        </button>
        <input ref={file} type="file" accept=".md,.txt,.markdown,text/plain,text/markdown" hidden onChange={(e) => pick(e.target.files?.[0])} />
        <span className="muted small import-grow">
          <FileText size={13} /> {text ? `${text.length.toLocaleString("ru")} символов` : ".md или .txt"}
        </span>
        <button className="btn primary" disabled={!text.trim() || busy} onClick={go}>
          {busy ? "Переношу…" : "Перенести"}
        </button>
      </div>
    </div>
  );
}
