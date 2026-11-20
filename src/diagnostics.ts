import { VERSION } from "./version";

export interface DiagnosticCheck { id: string; ok: boolean; title: string; detail: string; action: string; }
/** Deliberately allowlisted: never include tokens, URLs with credentials, chat text, memory or log bodies. */
export function diagnosticChecks(bridge: { enabled: boolean; listening: boolean; connected: boolean; tunnel: { url?: string; status?: string }; error?: string }, session?: { listening: boolean; waiting: boolean; queued: number; activeChatId: string }, storageProblem = ""): DiagnosticCheck[] {
  return [
    { id: "enabled", ok: bridge.enabled, title: "Мост включён", detail: bridge.enabled ? "Включён" : "Выключен в настройках", action: "Откройте настройки моста и включите его" },
    { id: "listener", ok: bridge.listening, title: "Локальный MCP-сервер", detail: bridge.listening ? "Слушает порт" : "Сервер не запущен или порт занят", action: "Проверьте порт и закройте старую копию Jarvis Code" },
    { id: "tunnel", ok: !!bridge.tunnel.url, title: "Публичный адрес", detail: bridge.tunnel.url ? "Адрес получен; удалённая доступность здесь не доказана" : "Туннель ещё не дал адрес", action: "Проверьте настройку ngrok/cloudflared или ручного адреса" },
    { id: "connection", ok: bridge.connected, title: "Обращение Notion к мосту", detail: bridge.connected ? "Обращение по текущему адресу уже было" : "Обращение по текущему адресу не зарегистрировано", action: "Переподключите интеграцию к текущему адресу" },
    { id: "session", ok: !!session?.listening, title: "Слушатель этого чата", detail: session?.listening ? (session.waiting ? "Ждёт сообщение" : "Недавно был на связи / работает") : "В этой сессии нет живого слушателя", action: "Нажмите «Запустить» в этом локальном чате и отправьте команду в Notion" },
    { id: "storage", ok: !storageProblem, title: "Хранилище", detail: storageProblem ? "Выбранное хранилище недоступно" : "Предупреждений пути нет; это не проверка свободного места", action: "Подключите диск и проверьте права папки в настройках хранилища" },
  ];
}
export function diagnosticReport(checks: DiagnosticCheck[], options: { channel: string; sessions: number; busy: number; queued: number }) {
  const safe = checks.map(check => ({ id: check.id, ok: !!check.ok }));
  return JSON.stringify({ schema: 1, app: "Jarvis Code", version: VERSION, createdAt: new Date().toISOString(), platform: process.platform, runtime: process.versions.node, checks: safe, channel: options.channel === "beta" ? "beta" : "stable", sessions: options.sessions, busy: options.busy, queued: options.queued, excluded: ["tokens", "addresses", "paths", "user", "chat history", "memory", "command output", "raw logs"] },null,2);
}
