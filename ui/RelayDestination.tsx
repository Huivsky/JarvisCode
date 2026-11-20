import { useState } from "react";
import { Modal } from "./common";
import { api, relayServiceName, set, startRelay, toast, type ChatFull } from "./store";

export function RelayDestination({ chat }: { chat: ChatFull }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const service = relayServiceName(chat.relayChatUrl);
  const save = async (value: string) => {
    setSaving(true); setError("");
    try {
      const result = await api<{ chatUrl: string }>(`chats/${chat.id}/relay`, { body: { chatUrl: value } });
      set((s) => ({ chat: s.chat?.id === chat.id ? { ...s.chat, relayChatUrl: result.chatUrl } : s.chat }));
      setOpen(false);
      toast(result.chatUrl ? `Чат пересылки (${relayServiceName(result.chatUrl)}) сохранён` : "Используется общая ссылка", "success");
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };
  return <>
    <button className="tb-btn" title="Назначить свой чат Notion или Retool для пересылки" onClick={() => { setUrl(chat.relayChatUrl || ""); setError(""); setOpen(true); }}>Пересылка</button>
    <button className="tb-btn relay-launch" title={`Открыть чат ${service} и скопировать команду пересылки`} onClick={() => void startRelay()}>Запустить</button>
    {open && <Modal title="Чат пересылки" onClose={() => !saving && setOpen(false)} className="relay-destination">
      <form onSubmit={(e) => { e.preventDefault(); void save(url); }}>
        <p className="muted">Для чата «{chat.title}». Пустое поле — общая ссылка из настроек.</p>
        <label htmlFor="relay-chat-url">Ссылка на чат Notion или Retool</label>
        <div className="field"><input id="relay-chat-url" autoFocus inputMode="url" value={url} disabled={saving} onChange={(e) => setUrl(e.target.value)} placeholder="https://app.notion.com/chat или https://<org>.retool.com/…" aria-describedby="relay-help" /></div>
        <p id="relay-help" className="muted small">Подходит чат Notion AI или Retool (ваш retool.com — например, чат AI-ассистента или приложение с подключённым ресурсом Jarvis Code). После сохранения нажмите «Запустить», вставьте и отправьте команду в открывшемся чате. У каждого локального чата отдельная сессия. Не запускайте два слушателя одной сессии; после сброса сессии отправьте новую команду.</p>
        {error && <p className="field-error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn" disabled={saving} onClick={() => void save("")}>Общая ссылка</button>
          <button type="button" className="btn" disabled={saving} onClick={() => setOpen(false)}>Отмена</button>
          <button className="btn primary" type="submit" disabled={saving}>{saving ? "Сохраняю…" : "Сохранить"}</button>
        </div>
      </form>
    </Modal>}
  </>;
}
