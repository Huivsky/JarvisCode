import { useEffect, useState } from "react";
import { Item } from "./Chat";
import { ago, cx, MODE_INFO, shortPath, Toggle } from "./common";
import { pickPaths } from "./FolderBrowser";
import { Alert, Check, ChevronRight, Copy, Download, External, Folder, Globe, Key, Plug, Power, Refresh, Trash } from "./icons";
import { api, BRIDGE_ID, connectNotion, loadChat, newChat, openExternal, startRelay, toast, useStore, type BridgeSettings, type BridgeState, type LegacyStartup, type Mode } from "./store";

export type BridgeTone = "off" | "starting" | "online" | "error";

export function bridgeStatus(b?: BridgeState | null): { tone: BridgeTone; text: string } {
  if (!b || !b.enabled) return { tone: "off", text: "Выключен" };
  if (b.error) return { tone: "error", text: "Ошибка сервера" };
  const t = b.tunnel.status;
  if (t === "online") return b.tunnel.check && !b.tunnel.check.ok ? { tone: "starting", text: "Адрес не отвечает" } : { tone: "online", text: "Работает" };
  if (t === "starting") return { tone: "starting", text: b.tunnel.download ? "Скачиваю ngrok…" : "Запускается…" };
  if (t === "error") return { tone: "error", text: "Ошибка туннеля" };
  return { tone: b.listening ? "starting" : "off", text: b.listening ? "Сервер запущен" : "Выключен" };
}

/** Связь с агентом в чате Notion (пересылка) — главное состояние приложения. */
export function relayStatus(b?: BridgeState | null): { tone: BridgeTone; text: string; hint: string } {
  if (!b || !b.enabled) return { tone: "off", text: "Мост выключен", hint: "Включите мост, чтобы агент в Notion работал на этом ПК" };
  if (b.error || b.tunnel.status === "error") return { tone: "error", text: "Ошибка моста", hint: "Откройте «Мост», чтобы исправить" };
  if (!b.connected) return { tone: "starting", text: "Подключите в Notion", hint: "Мост ещё не подключён к Notion AI" };
  const r = b.relay;
  if (r?.listening) return { tone: "online", text: r.activeChatId ? "Агент работает" : "Агент на связи", hint: "Агент в чате Notion получает сообщения отсюда" };
  if (r?.paused) return { tone: "off", text: "Агент на паузе", hint: "Нажмите, чтобы снова запустить агента в чате Notion" };
  return { tone: "off", text: "Агент не на связи", hint: "Нажмите, чтобы запустить агента в чате Notion" };
}

export function StatusDot({ tone, className }: { tone: BridgeTone; className?: string }) {
  return <span className={cx("status-dot", `s-${tone}`, className)} />;
}

export async function saveBridge(patch: Partial<BridgeSettings> & { ngrokAuthtoken?: string }): Promise<boolean> {
  try {
    await api("bridge", { body: patch });
    return true;
  } catch (e) {
    toast((e as Error).message, "error");
    return false;
  }
}

async function copy(text: string, what = "Адрес скопирован") {
  try {
    await navigator.clipboard.writeText(text);
    toast(what, "success");
  } catch {
    toast("Не удалось скопировать — выделите адрес и нажмите Ctrl+C", "error");
  }
}

const BRIDGE_MODES: Mode[] = ["plan", "ask", "auto-edit", "full"];

// ───── Экран моста ─────

export function BridgeView() {
  const b = useStore((s) => s.state!.bridge);
  const bs = useStore((s) => s.state!.bridgeSettings);
  const chat = useStore((s) => (s.chat?.id === BRIDGE_ID ? s.chat : null));
  const [showSettings, setShowSettings] = useState(false);
  const st = bridgeStatus(b);

  useEffect(() => {
    if (b.tunnel.hint || b.error) setShowSettings(true);
  }, [b.tunnel.hint, b.error]);

  return (
    <div className="bridge-view">
      <div className="bridge-inner">
        <div className="bridge-hero">
          <span className={cx("bridge-ico", `s-${st.tone}`)}>
            <Plug size={22} />
          </span>
          <div className="bridge-hero-text">
            <h1 className="serif">Мост для агента в Notion</h1>
            <p className="muted">
              Агент в обычном чате Notion работает с этим ПК за ваш личный лимит: пишите ему в Notion или прямо здесь, в окне Jarvis Code (пересылка). Команды на ПК (файлы, поиск, PowerShell) — по вашим правилам доступа. Сервер и ngrok работают в фоне без окон консоли, сами проверяются и перезапускаются.
            </p>
          </div>
        </div>

        <StatusCard b={b} bs={bs} />
        {b.enabled && <FixCard b={b} bs={bs} />}
        <LegacyCard />
        {b.enabled && <ConnectCard b={b} />}
        {b.enabled && <RelayPanel b={b} />}

        <div className="bridge-card">
          <button className="bridge-section-head" onClick={() => setShowSettings(!showSettings)}>
            <span>Настройки моста</span>
            <span className="muted small">
              {MODE_INFO[bs.mode].label} · {bs.provider === "manual" ? "свой адрес" : bs.provider} · {shortPath(bs.project, 30)}
            </span>
            <ChevronRight size={16} className={cx("chev", showSettings && "rot")} />
          </button>
          {showSettings && <BridgeSettingsForm />}
        </div>

        <Journal chat={chat} />
      </div>
    </div>
  );
}

function StatusCard({ b, bs }: { b: BridgeState; bs: BridgeSettings }) {
  const st = bridgeStatus(b);
  const [busy, setBusy] = useState(false);
  const toggle = async (v: boolean) => {
    setBusy(true);
    await saveBridge({ enabled: v });
    setBusy(false);
  };
  const restart = async () => {
    setBusy(true);
    await api("bridge/restart", { body: {} }).catch((e) => toast(e.message, "error"));
    setBusy(false);
  };
  const newKey = async () => {
    if (!confirm("Создать новый ключ? Старый адрес MCP перестанет работать — его нужно будет заменить в настройках агента в Notion.")) return;
    await api("bridge/token", { body: {} }).catch((e) => toast(e.message, "error"));
  };
  const t = b.tunnel;
  const providerText =
    t.provider === "manual"
      ? "свой адрес"
      : t.provider === "cloudflared"
        ? "cloudflared · быстрый туннель"
        : `ngrok${bs.ngrokDomain ? ` · ${bs.ngrokDomain}` : " · временный адрес"}${t.external ? " · уже запущенный" : ""}`;

  return (
    <div className={cx("bridge-card status-card", `s-${st.tone}`)}>
      <div className="status-row">
        <StatusDot tone={st.tone} />
        <div className="status-text">
          <div className="status-title">{st.text}</div>
          <div className="muted small">
            {b.enabled ? providerText : "Включите — Jarvis Code запустит локальный MCP-сервер и туннель сам"}
            {b.calls > 0 && ` · вызовов: ${b.calls}${b.lastCallAt ? `, последний ${ago(b.lastCallAt)}` : ""}`}
          </div>
          {b.enabled && t.status === "online" && <CheckLine b={b} />}
          {b.enabled && t.download && <NgrokProgress d={t.download} />}
        </div>
        <button type="button" role="switch" aria-checked={b.enabled} disabled={busy} className={cx("switch", b.enabled && "on")} onClick={() => toggle(!b.enabled)} title={b.enabled ? "Выключить мост" : "Включить мост"}>
          <span />
        </button>
      </div>
      {!b.enabled && (
        <div className="status-actions">
          <button className="btn primary" disabled={busy} onClick={() => toggle(true)}>
            <Power size={15} /> Включить мост
          </button>
          <span className="muted small">ngrok найдётся на ПК или скачается сам; домен и authtoken подхватятся из его настроек</span>
        </div>
      )}
      {b.enabled && b.mcpUrl && (
        <>
          <div className="mcp-url">
            <Globe size={15} className="muted" />
            <input readOnly value={b.mcpUrl} onFocus={(e) => e.currentTarget.select()} spellCheck={false} />
            <button className="btn small primary" onClick={() => copy(b.mcpUrl, "Адрес MCP скопирован — вставьте его в Notion")}>
              <Copy size={14} /> Копировать
            </button>
          </div>
          {t.provider === "ngrok" && !bs.ngrokDomain && t.status === "online" && (
            <div className="bridge-hint">
              Адрес временный: после перезапуска ngrok он сменится, и его придётся заново вставлять в Notion. Закрепите бесплатный статический домен в{" "}
              <a href="https://dashboard.ngrok.com/domains" onClick={(e) => (e.preventDefault(), openExternal("https://dashboard.ngrok.com/domains"))}>
                dashboard.ngrok.com → Domains <External size={11} />
              </a>{" "}
              и укажите его в настройках ниже.
            </div>
          )}
        </>
      )}
      {b.enabled && !b.mcpUrl && b.listening && (
        <div className="muted small">
          Локально сервер доступен: <code>{b.localUrl.replace(/\/mcp\/.*/, "/mcp/…")}</code> — ждём публичный адрес от туннеля.
        </div>
      )}
      {b.enabled && (
        <div className="status-actions">
          <button className="btn small" disabled={busy} onClick={restart}>
            <Refresh size={14} /> Перезапустить
          </button>
          {t.status === "online" && (
            <button className="btn small ghost" onClick={() => api("bridge/check", { body: {} }).catch(() => {})} title="Проверить адрес из интернета — так, как его видит Notion">
              <Check size={14} /> Проверить
            </button>
          )}
          <button className="btn small ghost" onClick={newKey} title="Сменить секретный ключ в адресе">
            <Key size={14} /> Новый ключ
          </button>
          <button className="btn small ghost" onClick={() => api("notion/open", { body: {} }).catch(() => {})}>
            <External size={14} /> Открыть Notion
          </button>
        </div>
      )}
    </div>
  );
}

function mb(n: number) {
  return (n / 1048576).toFixed(n >= 10 * 1048576 ? 0 : 1);
}

/** Прогресс автоматической загрузки ngrok. */
function NgrokProgress({ d }: { d: { got: number; total: number } }) {
  const pct = d.total ? Math.min(100, Math.round((d.got / d.total) * 100)) : 0;
  return (
    <div className="ngrok-dl">
      <div className="muted small">
        Скачиваю ngrok с официального сайта{d.got ? ` · ${mb(d.got)}${d.total ? ` из ${mb(d.total)}` : ""} МБ` : "…"}
        {d.total ? ` · ${pct}%` : ""}
      </div>
      <div className={cx("update-bar", !d.total && "indeterminate")}>
        <span style={{ width: d.total ? `${pct}%` : "30%" }} />
      </div>
    </div>
  );
}

/** Подсказки и кнопки для типичных проблем запуска. */
function FixCard({ b, bs }: { b: BridgeState; bs: BridgeSettings }) {
  const t = b.tunnel;
  const [token, setToken] = useState("");
  const [url, setUrl] = useState(bs.publicUrl);
  const [port, setPort] = useState(String(bs.port));
  const [busy, setBusy] = useState(false);
  const [logOpen, setLogOpen] = useState(false);

  if (!b.error && t.status !== "error") return null;

  const pickNgrok = async () => {
    const [p] = await pickPaths("files");
    if (p) await saveBridge({ ngrokPath: p });
  };
  const detect = async () => {
    setBusy(true);
    try {
      const r = await api<{ ngrokPath: string; ngrokDomain: string }>("bridge/detect", { body: {} });
      if (r.ngrokPath) {
        toast(`Найден ngrok: ${r.ngrokPath}`, "success");
        await api("bridge/restart", { body: {} });
      } else toast("ngrok не найден — укажите путь к ngrok.exe вручную", "error");
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  const download = async () => {
    setBusy(true);
    await api("bridge/ngrok-download", { body: {} }).catch((e) => toast((e as Error).message, "error"));
    setBusy(false);
  };
  const killOthers = async () => {
    if (!confirm("Остановить все процессы ngrok на этом ПК и перезапустить мост?")) return;
    setBusy(true);
    await api("bridge/kill-ngrok", { body: {} }).catch((e) => toast(e.message, "error"));
    setBusy(false);
  };

  return (
    <div className="bridge-card fix-card">
      <div className="fix-head">
        <Alert size={16} />
        <span>{b.error || t.error || "Туннель не запустился"}</span>
      </div>
      {b.error && (
        <>
          <p className="muted small">Скорее всего, порт занят старым мостом (консольная версия) или другой программой. Закройте её — или выберите другой порт.</p>
          <div className="fix-row">
            <div className="field compact">
              <input value={port} inputMode="numeric" onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} />
            </div>
            <button className="btn small primary" disabled={!port || Number(port) < 1024} onClick={() => saveBridge({ port: Number(port) })}>
              Сменить порт
            </button>
            <button className="btn small" onClick={() => api("bridge/restart", { body: {} }).catch(() => {})}>
              Повторить
            </button>
          </div>
        </>
      )}
      {t.hint === "ngrok-missing" && (
        <>
          <p className="muted small">Jarvis Code скачает ngrok с официального сайта (около 10 МБ) в свою папку и сразу запустит туннель. Если ngrok уже есть на ПК — найдите или укажите его.</p>
          <div className="fix-row">
            <button className="btn small primary" disabled={busy} onClick={download}>
              <Download size={14} /> Скачать ngrok автоматически
            </button>
            <button className="btn small" disabled={busy} onClick={detect}>
              Найти на ПК
            </button>
            <button className="btn small" onClick={pickNgrok}>
              <Folder size={14} /> Указать ngrok.exe…
            </button>
            <button className="btn small ghost" onClick={() => openExternal("https://ngrok.com/download")}>
              Вручную <External size={12} />
            </button>
          </div>
        </>
      )}
      {t.hint === "ngrok-auth" && (
        <>
          <p className="muted small">
            Authtoken —{" "}
            <a href="https://dashboard.ngrok.com/get-started/your-authtoken" onClick={(e) => (e.preventDefault(), openExternal("https://dashboard.ngrok.com/get-started/your-authtoken"))}>
              dashboard.ngrok.com → Your Authtoken <External size={11} />
            </a>
          </p>
          <div className="fix-row">
            <div className="field compact grow">
              <Key size={15} className="muted" />
              <input type="password" value={token} placeholder="Вставьте authtoken ngrok" spellCheck={false} autoComplete="off" onChange={(e) => setToken(e.target.value)} />
            </div>
            <button className="btn small primary" disabled={!token.trim()} onClick={() => saveBridge({ ngrokAuthtoken: token.trim() }).then((ok) => ok && setToken(""))}>
              Сохранить
            </button>
          </div>
        </>
      )}
      {t.hint === "ngrok-busy" && (
        <>
          <p className="muted small">На бесплатном тарифе ngrok разрешена одна сессия. Скорее всего, ngrok уже запущен старым скриптом или в другом окне.</p>
          <div className="fix-row">
            <button className="btn small primary" disabled={busy} onClick={killOthers}>
              <Power size={14} /> Остановить другие ngrok и перезапустить
            </button>
          </div>
        </>
      )}
      {t.hint === "cloudflared-missing" && (
        <div className="fix-row">
          <button className="btn small primary" onClick={() => saveBridge({ provider: "ngrok" })}>
            Использовать ngrok
          </button>
        </div>
      )}
      {t.hint === "manual-url" && (
        <div className="fix-row">
          <div className="field compact grow">
            <input value={url} placeholder="https://…" spellCheck={false} onChange={(e) => setUrl(e.target.value)} />
          </div>
          <button className="btn small primary" disabled={!/^https:\/\//i.test(url.trim())} onClick={() => saveBridge({ publicUrl: url.trim() })}>
            Сохранить
          </button>
        </div>
      )}
      {t.log.length > 0 && (
        <>
          <button className="link-btn small" onClick={() => setLogOpen(!logOpen)}>
            {logOpen ? "Скрыть журнал туннеля" : "Показать журнал туннеля"}
          </button>
          {logOpen && <pre className="tool-output tunnel-log">{t.log.slice(-20).join("\n")}</pre>}
        </>
      )}
    </div>
  );
}

/** Старые .bat/.vbs консольного моста в автозагрузке. */
function LegacyCard() {
  const [items, setItems] = useState<LegacyStartup[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ items: LegacyStartup[] }>("bridge/legacy")
      .then((r) => setItems(r.items))
      .catch(() => setItems([]));
  }, []);
  if (!items?.length) return null;
  const disable = async () => {
    setBusy(true);
    try {
      const r = await api<{ done: number; items: LegacyStartup[]; backup: string }>("bridge/legacy/disable", { body: { ids: items.map((i) => i.id) } });
      setItems(r.items);
      toast(`Отключено: ${r.done}. Копии сохранены в ${r.backup}`, "success");
      await api("bridge/restart", { body: {} }).catch(() => {});
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="bridge-card legacy-card">
      <div className="fix-head warn">
        <Alert size={16} />
        <span>Найдены старые скрипты автозапуска моста</span>
      </div>
      <p className="muted small">
        Они открывают окна консоли и занимают порт или сессию ngrok. Теперь мост запускает сам Jarvis Code — старые можно отключить (файлы переносятся в резервную папку, не удаляются).
      </p>
      <div className="legacy-list">
        {items.map((i) => (
          <div key={i.id} className="legacy-item" title={i.detail}>
            <span className="tag">{i.kind === "startup" ? "Автозагрузка" : "Реестр Run"}</span>
            <span className="legacy-name">{i.name}</span>
            <span className="muted small legacy-detail">{i.detail}</span>
          </div>
        ))}
      </div>
      <div className="fix-row">
        <button className="btn small primary" disabled={busy} onClick={disable}>
          Отключить старые
        </button>
      </div>
    </div>
  );
}

/** Самопроверка адреса из интернета. */
function CheckLine({ b }: { b: BridgeState }) {
  const c = b.tunnel.check;
  if (!c) return <div className="check-line muted small">Проверяю адрес из интернета…</div>;
  if (c.ok) return <div className="check-line ok small">Адрес доступен из интернета · проверено {ago(c.at)}</div>;
  return (
    <div className="check-line bad small">
      Проверка из интернета: {c.error}.{" "}
      {b.tunnel.provider === "manual" ? "Проверьте, что адрес ведёт на порт моста." : "Jarvis Code перезапустит туннель сам."}
    </div>
  );
}

/** Подключение моста к Notion AI: одной кнопкой (запрос в буфере) или вручную. */
function ConnectCard({ b }: { b: BridgeState }) {
  const [manual, setManual] = useState(false);
  const [busy, setBusy] = useState(false);
  const connect = async () => {
    setBusy(true);
    await connectNotion();
    setBusy(false);
  };
  if (b.connected)
    return (
      <div className="bridge-card connect-card ok">
        <div className="connect-row">
          <span className="connect-ico ok">
            <Check size={16} />
          </span>
          <div className="connect-text">
            <div className="bridge-section-title">Подключено к Notion</div>
            <div className="muted small">
              Notion обращался к мосту {ago(b.connectedAt)}. Пишите в окне Jarvis Code — агент в чате Notion выполнит задачу (пересылка ниже). В другом пространстве Notion подключение добавляется заново — чаты и их память остаются здесь.
            </div>
          </div>
          <button className="btn small" onClick={() => openExternal("https://app.notion.com/chat")}>
            Открыть Notion AI <External size={12} />
          </button>
        </div>
      </div>
    );
  return (
    <div className="bridge-card connect-card">
      <div className="connect-row">
        <span className="connect-ico">
          <Plug size={16} />
        </span>
        <div className="connect-text">
          <div className="bridge-section-title">Остался один шаг — подключить мост к Notion AI</div>
          <div className="muted small">
            Notion к мосту ещё не обращался. Нажмите кнопку: откроется чат Notion AI, а в буфере обмена будет готовый запрос с адресом моста. Вставьте его (Ctrl+V) и отправьте — Notion AI сам добавит подключение. Делается один раз.
          </div>
        </div>
      </div>
      <div className="status-actions">
        <button className="btn primary" disabled={busy || !b.mcpUrl} onClick={connect}>
          <Plug size={15} /> Подключить в Notion AI
        </button>
        <button className="btn small ghost" onClick={() => setManual(!manual)}>
          Вручную или для своего агента <ChevronRight size={13} className={cx("chev", manual && "rot")} />
        </button>
      </div>
      <p className="muted small">
        В адресе — секретный ключ к этому ПК: вставляйте его только в свой чат Notion AI или в настройки подключения. Если Notion ответит, что свои MCP-серверы запрещены, владелец пространства включает их в Settings → Notion AI → AI connectors → Enable Custom MCP servers.
      </p>
      {manual && <ConnectSteps b={b} />}
    </div>
  );
}

/** Пересылка: пишете в окне Jarvis Code, отвечает агент в обычном чате Notion (личный лимит, без API). */
function RelayPanel({ b }: { b: BridgeState }) {
  const bs = useStore((s) => s.state!.bridgeSettings);
  const r = b.relay;
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    await startRelay();
    setBusy(false);
  };
  const live = !!r?.listening;
  return (
    <div className="bridge-card relay-panel">
      <div className="relay-row">
        <span className={cx("relay-dot", live && "on")} />
        <div className="grow">
          <div className="bridge-section-title">Пересылка из окна Jarvis Code</div>
          <div className="muted small">
            {live
              ? `Агент в чате Notion на связи${r.activeChatId ? " — работает над задачей" : r.waiting ? " — ждёт сообщений" : ""}${r.queued ? ` · в очереди: ${r.queued}` : ""}. Пишите в любом чате Jarvis Code.`
              : r?.paused
                ? "Агент в Notion сделал паузу — новых сообщений долго не было. Нажмите «Запустить в Notion», когда снова понадобится."
                : "Пишете здесь, в окне Jarvis Code, а работает агент в обычном чате Notion — за ваш личный лимит. Один раз за сеанс отправьте в чат Notion команду запуска. История и память чатов хранятся в Jarvis Code — подходит любой чат и любое пространство."}
          </div>
        </div>
      </div>
      <div className="status-actions">
        <button className={cx("btn", !live && "primary")} disabled={busy || !b.connected} onClick={go} title={b.connected ? "" : "Сначала подключите мост к Notion AI"}>
          <External size={15} /> {live ? "Ещё раз в Notion" : "Запустить в Notion"}
        </button>
        <button className="btn small" onClick={() => newChat()}>
          Новый чат
        </button>
      </div>
      <div className="bf-row">
        <div className="bf-label">
          Агент для пересылки
          <div className="muted small">Ссылка на чат Notion или Retool (retool.com), где подключён мост. Пусто — Notion AI</div>
        </div>
        <TextSetting value={bs.chatUrl} placeholder="https://app.notion.com/chat" onSave={(v) => saveBridge({ chatUrl: v })} mono />
      </div>
    </div>
  );
}

function ConnectSteps({ b }: { b: BridgeState }) {
  return (
    <div className="connect-manual">
      <div className="bridge-section-title">Вручную: свой агент в Notion</div>
      <ol className="connect-steps">
        <li>
          <span>Скопируйте адрес MCP</span>
          <button className="btn small" disabled={!b.mcpUrl} onClick={() => copy(b.mcpUrl, "Адрес MCP скопирован")}>
            <Copy size={13} /> Копировать
          </button>
        </li>
        <li>
          <span>
            В Notion откройте агента → <b>Settings</b> → <b>Tools &amp; Access</b> → <b>Add connection</b> → <b>Custom MCP server</b>
          </span>
          <button className="btn small ghost" onClick={() => api("notion/open", { body: {} }).catch(() => {})}>
            Открыть Notion <External size={12} />
          </button>
        </li>
        <li>
          <span>
            Вставьте адрес, название — <b>Jarvis Code</b>. Авторизацию не настраивайте: секретный ключ уже в адресе.
          </span>
        </li>
        <li>
          <span>
            Напишите агенту в Notion, например: <i>«Покажи, что лежит в Загрузках»</i>. Вызовы появятся в журнале ниже, опасные действия Jarvis Code спросит здесь.
          </span>
        </li>
      </ol>
      <p className="muted small">
        Для своего Notion AI (не отдельного агента) подключение добавляется так же — в настройках подключений Notion AI.{" "}
        <a
          href="https://www.notion.so/help/connect-mcp-servers-to-your-notion-agent"
          onClick={(e) => (e.preventDefault(), openExternal("https://www.notion.so/help/connect-mcp-servers-to-your-notion-agent"))}
        >
          Справка Notion <External size={11} />
        </a>
      </p>
    </div>
  );
}

function Journal({ chat }: { chat: { items: import("./store").ChatItem[] } | null }) {
  const items = chat?.items ?? [];
  const clear = async () => {
    if (!confirm("Очистить журнал моста?")) return;
    await api(`chats/${BRIDGE_ID}/clear`, { body: {} }).catch((e) => toast(e.message, "error"));
    loadChat(BRIDGE_ID);
  };
  return (
    <div className="bridge-journal">
      <div className="journal-head">
        <span className="bridge-section-title">Журнал действий</span>
        {items.length > 0 && <span className="muted small">{items.filter((i) => i.kind === "tool").length} вызовов</span>}
        {items.length > 0 && (
          <button className="btn small ghost" onClick={clear}>
            <Trash size={13} /> Очистить
          </button>
        )}
      </div>
      {!chat ? (
        <div className="muted small pad">Загрузка…</div>
      ) : items.length === 0 ? (
        <div className="journal-empty muted small">Пока пусто — здесь появятся действия агента из Notion.</div>
      ) : (
        <div className="journal-items">
          {items.slice(-200).map((it) => (
            <Item key={it.id} it={it} />
          ))}
        </div>
      )}
    </div>
  );
}

// ───── Форма настроек (экран моста и окно настроек) ─────

function TextSetting({
  value,
  placeholder,
  onSave,
  type = "text",
  icon,
  mono,
  narrow,
}: {
  value: string;
  placeholder?: string;
  onSave: (v: string) => void;
  type?: string;
  icon?: React.ReactNode;
  mono?: boolean;
  narrow?: boolean;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => v.trim() !== value && onSave(v.trim());
  return (
    <div className={cx("field compact", narrow ? "narrow" : "grow", mono && "mono")}>
      {icon}
      <input type={type} value={v} placeholder={placeholder} spellCheck={false} autoComplete="off" onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} />
    </div>
  );
}

export function BridgeSettingsForm() {
  const bs = useStore((s) => s.state!.bridgeSettings);
  const autostart = useStore((s) => s.state!.autostart);
  const [token, setToken] = useState("");

  const pickProject = async () => {
    const [p] = await pickPaths("folder", bs.project);
    if (p) saveBridge({ project: p });
  };
  const pickNgrok = async () => {
    const [p] = await pickPaths("files");
    if (p) saveBridge({ ngrokPath: p });
  };

  return (
    <div className="bridge-form">
      <div className="bf-label">Что агенту из Notion можно без подтверждения</div>
      <div className="mode-list compact">
        {BRIDGE_MODES.map((m) => (
          <button key={m} className={cx("mode-card", bs.mode === m && "active")} onClick={() => saveBridge({ mode: m })}>
            <span className={cx("mode-label", `tone-${MODE_INFO[m].tone}`)}>{MODE_INFO[m].label}</span>
            <span className="muted small">{MODE_INFO[m].hint}</span>
          </button>
        ))}
      </div>
      <div className="bf-row">
        <div className="bf-label">
          Рабочая папка
          <div className="muted small">Для относительных путей</div>
        </div>
        <button className="btn small" onClick={pickProject} title={bs.project}>
          <Folder size={14} /> {shortPath(bs.project, 34)}
        </button>
      </div>
      <div className="bf-row">
        <div className="bf-label">Туннель</div>
        <div className="seg">
          {(
            [
              ["ngrok", "ngrok"],
              ["cloudflared", "cloudflared"],
              ["manual", "Свой адрес"],
            ] as const
          ).map(([k, l]) => (
            <button key={k} className={cx(bs.provider === k && "active")} onClick={() => saveBridge({ provider: k })}>
              {l}
            </button>
          ))}
        </div>
      </div>
      {bs.provider === "ngrok" && (
        <>
          <div className="bf-row">
            <div className="bf-label">
              ngrok.exe
              <div className="muted small">Пусто — найти автоматически</div>
            </div>
            <div className="bf-inline">
              <TextSetting value={bs.ngrokPath} placeholder="C:\…\ngrok.exe" onSave={(v) => saveBridge({ ngrokPath: v })} mono />
              <button className="btn small" onClick={pickNgrok} title="Выбрать файл">
                <Folder size={14} />
              </button>
            </div>
          </div>
          <div className="bf-row">
            <div className="bf-label">
              Статический домен
              <div className="muted small">Чтобы адрес не менялся. Бесплатно: dashboard.ngrok.com → Domains</div>
            </div>
            <TextSetting value={bs.ngrokDomain} placeholder="name.ngrok-free.app" onSave={(v) => saveBridge({ ngrokDomain: v })} mono />
          </div>
          <div className="bf-row">
            <div className="bf-label">
              Authtoken
              <div className="muted small">{bs.ngrokAuthtokenSet ? "Сохранён в Jarvis Code" : "Не задан — берётся из ngrok.yml, если ngrok уже настроен"}</div>
            </div>
            <div className="bf-inline">
              <div className="field compact grow">
                <Key size={14} className="muted" />
                <input type="password" value={token} placeholder={bs.ngrokAuthtokenSet ? "•••••••• (заменить)" : "authtoken"} spellCheck={false} autoComplete="off" onChange={(e) => setToken(e.target.value)} />
              </div>
              <button className="btn small" disabled={!token.trim()} onClick={() => saveBridge({ ngrokAuthtoken: token.trim() }).then((ok) => ok && (setToken(""), toast("Authtoken сохранён", "success")))}>
                Сохранить
              </button>
              {bs.ngrokAuthtokenSet && (
                <button className="btn small ghost" title="Удалить сохранённый authtoken" onClick={() => saveBridge({ ngrokAuthtoken: "" })}>
                  <Trash size={14} />
                </button>
              )}
            </div>
          </div>
        </>
      )}
      {bs.provider === "cloudflared" && <p className="muted small">Быстрый туннель cloudflared без аккаунта: адрес новый при каждом запуске. Установка: winget install Cloudflare.cloudflared</p>}
      {bs.provider === "manual" && (
        <div className="bf-row">
          <div className="bf-label">
            Публичный адрес
            <div className="muted small">https-адрес, который ведёт на порт {bs.port}</div>
          </div>
          <TextSetting value={bs.publicUrl} placeholder="https://…" onSave={(v) => saveBridge({ publicUrl: v })} mono />
        </div>
      )}
      <div className="bf-row">
        <div className="bf-label">
          Ждать подтверждения, с
          <div className="muted small">Потом действие отклоняется</div>
        </div>
        <TextSetting value={String(bs.approvalTimeoutSec)} onSave={(v) => Number(v) >= 10 && saveBridge({ approvalTimeoutSec: Number(v) })} narrow />
      </div>
      <div className="bf-row">
        <div className="bf-label">
          Локальный порт
          <div className="muted small">Обычно менять не нужно</div>
        </div>
        <TextSetting value={String(bs.port)} onSave={(v) => Number(v) >= 1024 && Number(v) <= 65535 && saveBridge({ port: Number(v) })} narrow />
      </div>
      <div className="bf-row">
        <div className="bf-label">
          Чат для пересылки
          <div className="muted small">Где подключён мост. Пусто — Notion AI (app.notion.com/chat)</div>
        </div>
        <TextSetting value={bs.chatUrl} placeholder="https://app.notion.com/chat" onSave={(v) => saveBridge({ chatUrl: v })} mono />
      </div>
      <div className="bf-row">
        <div className="bf-label">
          Ждать сообщений, мин
          <div className="muted small">Потом агент в Notion делает паузу, чтобы не тратить лимит впустую</div>
        </div>
        <TextSetting value={String(bs.listenIdleMin)} onSave={(v) => Number(v) >= 1 && Number(v) <= 120 && saveBridge({ listenIdleMin: Number(v) })} narrow />
      </div>
      {autostart.available && (
        <Toggle
          checked={autostart.enabled}
          onChange={(v) => api("autostart", { body: { enabled: v } }).catch((e) => toast(e.message, "error"))}
          label="Запускать вместе с Windows"
          hint="Jarvis Code стартует в трее без окна, мост включается сам"
        />
      )}
    </div>
  );
}
