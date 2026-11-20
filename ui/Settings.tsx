import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BridgeSettingsForm, bridgeStatus, StatusDot } from "./Bridge";
import { ago, baseName, cx, fmtSize, Modal, MODE_INFO, MODE_ORDER, shortPath, Toggle } from "./common";
import { pickPaths } from "./FolderBrowser";
import { Alert, Bug, Check, Clock, Copy, Download, External, Folder, FolderOpen, Info, Lock, Monitor, Package, Palette, Plug, Plus, Refresh, Search, Shield, Spark, User, X } from "./icons";
import { ACCENTS, api, applyAccent, applyTheme, BRIDGE_ID, EFFORTS, get, newChat, openChat, openExternal, set, toast, useStore, type CrashInfo, type Settings as S, type StorageInfo } from "./store";

async function saveSettings(patch: Partial<Omit<S, "update" | "crash">> & { project?: string; update?: Partial<S["update"]>; crash?: Partial<S["crash"]> }) {
  try {
    await api("settings", { body: patch });
    return true;
  } catch (e) {
    toast((e as Error).message, "error");
    return false;
  }
}

const TABS: { key: string; label: string; icon: ReactNode }[] = [
  { key: "general", label: "Общие", icon: <User size={16} /> },
  { key: "storage", label: "Хранилище", icon: <Package size={16} /> },
  { key: "pc", label: "Доступ к ПК", icon: <Shield size={16} /> },
  { key: "security", label: "Безопасность", icon: <Lock size={16} /> },
  { key: "bridge", label: "Мост и автозапуск", icon: <Plug size={16} /> },
  { key: "look", label: "Оформление", icon: <Palette size={16} /> },
  { key: "about", label: "О программе", icon: <Info size={16} /> },
];

export function SettingsModal() {
  const tab = useStore((s) => s.settingsTab);
  const close = () => set({ modal: null });
  return (
    <Modal onClose={close} wide className="settings">
      <div className="settings-nav">
        <div className="settings-title">Настройки</div>
        {TABS.map((t) => (
          <button key={t.key} className={cx("settings-tab", tab === t.key && "active")} onClick={() => set({ settingsTab: t.key })}>
            {t.icon}
            <span>{t.label}</span>
          </button>
        ))}
      </div>
      <div className="settings-body">
        <button className="icon-btn settings-close" onClick={close} aria-label="Закрыть">
          <X size={17} />
        </button>
        {(tab === "general" || !TABS.some((t) => t.key === tab)) && <GeneralTab />}
        {tab === "storage" && <StorageTab />}
        {tab === "pc" && <PcTab />}
        {tab === "security" && <SecurityTab />}
        {tab === "bridge" && <BridgeTab />}
        {tab === "look" && <LookTab />}
        {tab === "about" && <AboutTab />}
      </div>
    </Modal>
  );
}

function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-label">
        <div>{label}</div>
        {hint && <div className="muted small">{hint}</div>}
      </div>
      <div className="set-control">{children}</div>
    </div>
  );
}

function GeneralTab() {
  const st = useStore((s) => s.state!);
  const s = st.settings;
  const [name, setName] = useState(s.userName);
  const chatUrl = st.bridgeSettings.chatUrl;
  return (
    <>
      <h2>Общие</h2>
      <p className="muted">Jarvis Code работает через чат Notion: вы пишете здесь, отвечает агент в обычном чате Notion — через мост, без API и кредитов пространства.</p>
      <Row label="Как к вам обращаться" hint={s.userName ? "Имя в приветствии и для агента" : `Пусто — «${st.user.name}» (из Windows)`}>
        <div className="field compact">
          <input value={name} placeholder={st.user.name} maxLength={60} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() !== s.userName && saveSettings({ userName: name.trim() })} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
        </div>
      </Row>
      <Row label="Мышление по умолчанию" hint="Для новых чатов. В чате меняется кнопкой у поля ввода">
        <div className="seg">
          {EFFORTS.map((e) => (
            <button key={e.key} className={cx(s.effort === e.key && "active")} title={e.hint} onClick={() => saveSettings({ effort: e.key })}>
              {e.label}
            </button>
          ))}
        </div>
      </Row>
      <Row label="Модель" hint="Выбирается в самом чате Notion (меню модели у поля ввода). Jarvis Code передаёт агенту только уровень мышления">
        <button className="btn" onClick={() => openExternal(/^https:\/\//.test(chatUrl) ? chatUrl : "https://app.notion.com/chat")}>
          <External size={15} /> Открыть чат Notion
        </button>
      </Row>
      <Toggle
        checked={s.ocr}
        onChange={(v) => saveSettings({ ocr: v })}
        label="Текст с картинок для агента"
        hint="Скриншоты и картинки дополнительно распознаются (OCR) — агент поймёт их, даже если чат Notion не принимает изображения от MCP"
      />
      <h3>Чаты</h3>
      <Row label="Перенести чат" hint="Из чата Notion (агент передаст переписку сам) или из текста/файла">
        <button className="btn" onClick={() => set({ modal: "import" })}>
          <Plug size={15} /> Перенести…
        </button>
      </Row>
      <Row label="Хранилище" hint={st.storage.dir}>
        <button className="btn" onClick={() => set({ settingsTab: "storage" })}>
          <Package size={15} /> Настроить
        </button>
      </Row>
    </>
  );
}

const PART_LABEL: Record<string, string> = {
  chats: "Чаты",
  context: "Контекст и память чатов",
  uploads: "Вложения",
  screenshots: "Снимки экрана",
  history: "Копии файлов до правок",
};

function StorageTab() {
  const st = useStore((s) => s.state!);
  const info = st.storage;
  const move = useStore((s) => s.storageMove);
  const [target, setTarget] = useState<{ dir: string; hasStore: boolean; chats: number; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const refresh = async () => {
    setLoading(true);
    await api<StorageInfo>("storage?fresh=1").catch(() => null);
    setLoading(false);
  };
  useEffect(() => {
    void refresh();
  }, []);
  const choose = async (dir?: string) => {
    let d = dir;
    if (!d) [d] = await pickPaths("folder", info.dir);
    if (!d) return;
    try {
      const r = await api<{ exists: boolean; hasStore: boolean; chats: number; error?: string }>("storage/inspect", { body: { dir: d } });
      setTarget({ dir: d, ...r });
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  const run = async (mode: "move" | "use") => {
    if (!target) return;
    setBusy(true);
    try {
      const r = await api<{ moved: number; skipped: number; to: string }>("storage/move", { body: { dir: target.dir, mode } });
      toast(mode === "use" ? `Хранилище: ${r.to}` : `Перенесено в ${r.to}: ${r.moved} файл.${r.skipped ? `, пропущено ${r.skipped}` : ""}`, "success");
      setTarget(null);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
      set({ storageMove: null });
    }
  };
  const pct = move && move.total ? Math.round((move.done / move.total) * 100) : 0;
  return (
    <>
      <h2>Хранилище</h2>
      <p className="muted">
        Здесь лежит всё, что копится со временем: чаты, контекст и память для агента, вложения, снимки экрана и копии файлов до правок. Выберите папку на большом диске — например, D:\JarvisCode. Настройки и мост остаются в папке программы.
      </p>
      {info.problem && (
        <div className="storage-warn">
          <Alert size={16} />
          <span>{info.problem}</span>
        </div>
      )}
      <div className="storage-card">
        <span className="storage-ico">
          <Folder size={20} />
        </span>
        <div className="storage-text">
          <div className="storage-path" title={info.dir}>
            {info.dir}
            {!info.custom && <span className="tag">по умолчанию</span>}
          </div>
          <div className="muted small">
            {info.bytes < 0 ? "Считаю размер…" : `${fmtSize(info.bytes)} · ${info.files.toLocaleString("ru")} файл.`}
            {info.free >= 0 ? ` · свободно на диске ${fmtSize(info.free)}` : ""}
          </div>
        </div>
        <div className="storage-actions">
          <button className="icon-btn" title="Пересчитать" disabled={loading} onClick={refresh}>
            <Refresh size={15} />
          </button>
          <button className="btn small" onClick={() => api("storage/open", { body: {} }).catch((e) => toast(e.message, "error"))}>
            <FolderOpen size={14} /> Открыть
          </button>
        </div>
      </div>
      {info.parts.length > 0 && (
        <div className="storage-parts">
          {info.parts.map((p) => (
            <div key={p.name} className="storage-part">
              <span>{PART_LABEL[p.name] ?? p.name}</span>
              <span className="storage-bar">
                <span style={{ width: `${info.bytes > 0 ? Math.max(1, Math.round((p.bytes / info.bytes) * 100)) : 0}%` }} />
              </span>
              <span className="muted small nowrap">{fmtSize(p.bytes)}</span>
            </div>
          ))}
        </div>
      )}
      {move ? (
        <div className="storage-move">
          <b>{move.phase === "scan" ? "Считаю файлы…" : move.phase === "rewrite" ? "Обновляю ссылки в чатах…" : move.phase === "error" ? `Ошибка: ${move.error}` : `Переношу… ${pct}%`}</b>
          <span className="update-bar">
            <span style={{ width: `${pct}%` }} />
          </span>
          {move.file && <span className="muted small mono-ellipsis">{move.file}</span>}
        </div>
      ) : target ? (
        <div className="storage-confirm">
          <div className="storage-path" title={target.dir}>
            {target.dir}
          </div>
          {target.error ? (
            <div className="field-error">{target.error}</div>
          ) : target.hasStore ? (
            <p className="muted small">В этой папке уже есть хранилище Jarvis Code ({target.chats} чат.). Можно открыть его как есть или перенести туда текущие данные — чаты объединятся.</p>
          ) : (
            <p className="muted small">Все данные хранилища переедут в эту папку, ссылки на вложения в чатах обновятся. Работать можно сразу — без перезапуска.</p>
          )}
          <div className="set-actions">
            {!target.error && (
              <button className="btn primary" disabled={busy} onClick={() => run("move")}>
                {target.hasStore ? "Перенести и объединить" : "Перенести сюда"}
              </button>
            )}
            {!target.error && target.hasStore && (
              <button className="btn" disabled={busy} onClick={() => run("use")}>
                Открыть это хранилище
              </button>
            )}
            <button className="btn ghost" disabled={busy} onClick={() => setTarget(null)}>
              Отмена
            </button>
          </div>
        </div>
      ) : (
        <div className="set-actions">
          <button className="btn primary" onClick={() => choose()}>
            <Folder size={15} /> Изменить папку…
          </button>
          {info.custom && (
            <button className="btn" onClick={() => choose(info.defaultDir)}>
              Вернуть по умолчанию
            </button>
          )}
        </div>
      )}
      <p className="muted small">Переустановили Windows или перешли на другой ПК — укажите ту же папку и выберите «Открыть это хранилище»: все чаты и контекст вернутся.</p>
    </>
  );
}

function BridgeTab() {
  const b = useStore((s) => s.state!.bridge);
  const st = bridgeStatus(b);
  return (
    <>
      <h2>Мост и автозапуск</h2>
      <p className="muted">Мост даёт агенту в Notion доступ к этому ПК через MCP. Сервер и туннель запускаются в фоне — без окон консоли.</p>
      <div className="account-card bridge-mini">
        <StatusDot tone={st.tone} />
        <div className="account-text">
          <div className="account-name">{st.text}</div>
          <div className="muted small mono-ellipsis">{b.mcpUrl || (b.enabled ? "ждём адрес от туннеля…" : "мост выключен")}</div>
        </div>
        <div className="account-actions">
          {b.mcpUrl && (
            <button className="icon-btn" title="Копировать адрес MCP" onClick={() => navigator.clipboard.writeText(b.mcpUrl).then(() => toast("Адрес MCP скопирован", "success"))}>
              <Copy size={15} />
            </button>
          )}
          <button
            className={cx("switch", b.enabled && "on")}
            role="switch"
            aria-checked={b.enabled}
            title={b.enabled ? "Выключить мост" : "Включить мост"}
            onClick={() => api("bridge", { body: { enabled: !b.enabled } }).catch((e) => toast(e.message, "error"))}
          >
            <span />
          </button>
        </div>
      </div>
      <button className="btn small ghost" onClick={() => openChat(BRIDGE_ID)}>
        <Plug size={14} /> Открыть экран моста: подключение к Notion и журнал
      </button>
      <h3>Настройки</h3>
      <BridgeSettingsForm />
    </>
  );
}

function PcTab() {
  const s = useStore((x) => x.state!.settings);
  const base = useMemo(() => ({ ...s, allowText: s.allow.join("\n"), denyText: s.deny.join("\n") }), [s]);
  const [d, setD] = useState(base);
  const dirty = JSON.stringify(base) !== JSON.stringify(d);
  const upd = (p: Partial<typeof d>) => setD((x) => ({ ...x, ...p }));
  const num = (v: string) => (v === "" ? 0 : Number(v));
  const save = async () => {
    const lines = (t: string) => t.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    const ok = await saveSettings({
      defaultMode: d.defaultMode,
      fileScope: d.fileScope,
      shell: d.shell,
      commandTimeoutSec: d.commandTimeoutSec,
      approvalTimeoutSec: d.approvalTimeoutSec,
      maxIterations: d.maxIterations,
      maxMinutes: d.maxMinutes,
      allow: lines(d.allowText),
      deny: lines(d.denyText),
    });
    if (ok) toast("Сохранено", "success");
  };
  return (
    <>
      <h2>Доступ к ПК</h2>
      <p className="muted">Агент работает через Jarvis Code: читает файлы, ищет, запускает команды. Режим определяет, что он может делать без вашего подтверждения.</p>
      <div className="mode-list">
        {MODE_ORDER.map((m) => (
          <button key={m} className={cx("mode-card", d.defaultMode === m && "active")} onClick={() => upd({ defaultMode: m })}>
            <span className={cx("mode-label", `tone-${MODE_INFO[m].tone}`)}>{MODE_INFO[m].label}</span>
            <span className="muted small">{MODE_INFO[m].hint}</span>
          </button>
        ))}
      </div>
      <p className="muted small">Режим по умолчанию для новых чатов. В чате режим меняется кнопкой у поля ввода или Shift+Tab.</p>
      <Row label="Доступ к файлам" hint="Где агент может читать и менять файлы">
        <div className="seg">
          <button className={cx(d.fileScope === "any" && "active")} onClick={() => upd({ fileScope: "any" })}>
            Весь ПК
          </button>
          <button className={cx(d.fileScope === "project" && "active")} onClick={() => upd({ fileScope: "project" })}>
            Только рабочая папка
          </button>
        </div>
      </Row>
      <Row label="Оболочка для команд">
        <select value={d.shell} onChange={(e) => upd({ shell: e.target.value as S["shell"] })}>
          <option value="powershell">Windows PowerShell</option>
          <option value="pwsh">PowerShell 7 (pwsh)</option>
          <option value="cmd">cmd.exe</option>
        </select>
      </Row>
      <Row label="Тайм-аут команды, с" hint="Дольше — агент запустит фоновую задачу">
        <input type="number" min={5} max={55} value={d.commandTimeoutSec} onChange={(e) => upd({ commandTimeoutSec: num(e.target.value) })} />
      </Row>
      <Row label="Ждать подтверждения, с" hint="0 — ждать сколько угодно">
        <input type="number" min={0} max={3600} value={d.approvalTimeoutSec} onChange={(e) => upd({ approvalTimeoutSec: num(e.target.value) })} />
      </Row>
      <Row label="Автономно: итераций / минут">
        <div className="pair">
          <input type="number" min={1} max={200} value={d.maxIterations} onChange={(e) => upd({ maxIterations: num(e.target.value) })} />
          <input type="number" min={1} max={1440} value={d.maxMinutes} onChange={(e) => upd({ maxMinutes: num(e.target.value) })} />
        </div>
      </Row>
      <div className="set-col">
        <div>Всегда разрешать</div>
        <div className="muted small">Шаблоны команд, по одному в строке, например: git status* или npm test*</div>
        <textarea rows={3} value={d.allowText} spellCheck={false} onChange={(e) => upd({ allowText: e.target.value })} />
      </div>
      <div className="set-col">
        <div>Всегда запрещать</div>
        <div className="muted small">Эти команды агент не сможет выполнить ни в каком режиме</div>
        <textarea rows={3} value={d.denyText} spellCheck={false} onChange={(e) => upd({ denyText: e.target.value })} />
      </div>
      <div className="set-footer">
        <button className="btn primary" disabled={!dirty} onClick={save}>
          Сохранить
        </button>
      </div>
    </>
  );
}

function LookTab() {
  const s = useStore((x) => x.state!.settings);
  const [perm, setPerm] = useState<NotificationPermission>(typeof Notification !== "undefined" ? Notification.permission : "denied");
  const theme = (t: S["theme"]) => {
    applyTheme(t);
    saveSettings({ theme: t });
  };
  return (
    <>
      <h2>Оформление</h2>
      <Row label="Акцент" hint="Цвет знака, кнопок и выделения">
        <div className="swatches" role="radiogroup" aria-label="Акцентный цвет">
          {ACCENTS.map((a) => (
            <button
              key={a.key}
              role="radio"
              aria-checked={(s.accent || "ember") === a.key}
              className={cx("swatch", `sw-${a.key}`, (s.accent || "ember") === a.key && "active")}
              title={a.label}
              onClick={() => {
                applyAccent(a.key);
                saveSettings({ accent: a.key });
              }}
            >
              <span />
            </button>
          ))}
        </div>
      </Row>
      <Row label="Тема">
        <div className="seg">
          {(
            [
              ["dark", "Тёмная"],
              ["light", "Светлая"],
              ["system", "Как в системе"],
            ] as const
          ).map(([k, l]) => (
            <button key={k} className={cx(s.theme === k && "active")} onClick={() => theme(k)}>
              {l}
            </button>
          ))}
        </div>
      </Row>
      <Toggle
        checked={s.sendOnEnter}
        onChange={(v) => saveSettings({ sendOnEnter: v })}
        label="Отправлять по Enter"
        hint={s.sendOnEnter ? "Enter — отправить, Shift+Enter — новая строка" : "Ctrl+Enter — отправить, Enter — новая строка"}
      />
      <Toggle
        checked={perm === "granted"}
        onChange={() => (perm === "default" ? Notification.requestPermission().then(setPerm) : toast("Уведомления включаются и выключаются в настройках сайта в браузере (значок замка в адресной строке).", "info"))}
        label="Уведомления"
        hint="Когда агент ответил или ждёт подтверждения, а окно свёрнуто"
      />
    </>
  );
}

const WHATS_NEW: [string, string][] = [
  ["Только чат Notion", "Без API, токенов и кредитов пространства: вы пишете здесь, отвечает агент в обычном чате Notion — через мост."],
  ["Чаты не привязаны к пространству", "История и контекст хранятся на ПК. Подключили мост в другом пространстве — прошлые чаты продолжаются с того же места."],
  ["Перенос чатов", "Любой чат Notion переносится в Jarvis Code целиком — агент сам передаёт переписку и выжимку. Или вставьте текст / файл."],
  ["Своё хранилище", "Чаты, контекст, вложения и снимки — в выбранной папке, например, на большом диске. Перенос — на лету, без перезапуска."],
  ["Мышление", "Быстро, обычно, глубоко или максимум — у поля ввода. Модель выбирается в самом чате Notion."],
  ["Память чата", "Агент ведёт выжимку чата и может перечитать историю (nc_memory, nc_history) — длинные чаты не теряют контекст."],
];


function AboutTab() {
  const st = useStore((s) => s.state!);
  return (
    <>
      <div className="about">
        <Spark size={52} intro className="accent" />
        <div>
          <h2 className="about-name">
            Jarvis <span>Code</span>
          </h2>
          <div className="muted">Версия {st.version}</div>
        </div>
      </div>
      <p className="muted">Ваш ИИ-ассистент на ПК: агент из чата Notion, который видит компьютер и умеет с ним работать — файлы, код, команды.</p>
      <UpdateSection />
      <h3>Что нового в 4.0</h3>
      <div className="whats-new">
        {WHATS_NEW.map(([t, d]) => (
          <div key={t} className="wn-item">
            <b>{t}</b>
            <span>{d}</span>
          </div>
        ))}
      </div>
      <CrashSection />
      <h3>Горячие клавиши</h3>
      <div className="shortcuts">
        {[
          ["Ctrl+Shift+O", "Новый чат"],
          ["Ctrl+K", "Поиск по чатам"],
          ["Ctrl+B", "Показать/скрыть панель"],
          ["Ctrl+V", "Вставить скриншот, файлы или видео"],
          ["/", "Команды: /init, /review, /plan…"],
          ["Shift+Tab", "Сменить режим доступа"],
          ["↑", "Повторить последнее сообщение"],
          ["Esc", "Остановить агента"],
          ["Y / A / N", "Ответ на запрос разрешения"],
          ["Ctrl+,", "Настройки"],
        ].map(([k, l]) => (
          <div key={k} className="shortcut">
            <kbd>{k}</kbd>
            <span>{l}</span>
          </div>
        ))}
      </div>
      <Row label="Журнал действий агента" hint="Все команды и правки файлов">
        <button className="btn" onClick={() => openExternal(st.system.dataDir)}>
          <FolderOpen size={15} /> Открыть
        </button>
      </Row>
      <p className="muted small">Закрыли окно — при включённом мосте Jarvis Code остаётся в трее (значок у часов). Удалить программу: Параметры Windows → Приложения → Jarvis Code.</p>
    </>
  );
}

function UpdateSection() {
  const st = useStore((s) => s.state!);
  const u = st.update;
  const cfg = st.settings.update;
  const [busy, setBusy] = useState(false);
  const [adv, setAdv] = useState(false);
  const [repo, setRepo] = useState(cfg?.repo ?? "");
  const [manifest, setManifest] = useState(cfg?.manifestUrl ?? "");
  const check = async () => {
    setBusy(true);
    try {
      const r = await api<{ update: typeof u }>("update/check", { body: {} });
      if (r.update?.status === "uptodate") toast("Установлена последняя версия", "success");
      if (r.update?.status === "error") toast(r.update.error ?? "Не удалось проверить обновления", "error");
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  const install = async () => {
    setBusy(true);
    try {
      await api("update/install", { body: {} });
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  const skip = () => api("update/skip", { body: {} }).catch((e) => toast((e as Error).message, "error"));
  const configured = !!(cfg?.repo || cfg?.manifestUrl || cfg?.builtin);
  const own = !!(cfg?.repo || cfg?.manifestUrl);
  const status = !configured
    ? "Источник обновлений не задан"
    : u?.status === "checking"
      ? "Проверяю…"
      : u?.status === "available"
        ? `Доступна версия ${u.latest?.version}${u.skipped ? " (пропущена)" : ""}`
        : u?.status === "downloading"
          ? `Загружаю ${u.latest?.version}… ${Math.round((u.progress ?? 0) * 100)}%`
          : u?.status === "ready"
            ? `Версия ${u.latest?.version} загружена и проверена`
            : u?.status === "installing"
              ? "Устанавливаю — приложение перезапустится"
              : u?.status === "error"
                ? `Ошибка: ${u.error}`
                : u?.status === "uptodate"
                  ? "Установлена последняя версия"
                  : "Обновления не проверялись";
  return (
    <>
      <h3>Обновления</h3>
      <div className={cx("update-card", u?.status && `u-${u.status}`)}>
        <span className="update-ico">
          <Download size={18} />
        </span>
        <div className="update-text">
          <b>{status}</b>
          <span className="muted small">
            {u?.lastCheck ? `Проверено ${ago(u.lastCheck)}` : configured ? "Проверка при запуске и раз в 6 часов" : "Укажите репозиторий GitHub или адрес latest.json ниже"}
            {u?.source ? ` · ${u.source.replace(/^https?:\/\//, "")}` : ""}
            {u?.latest?.size ? ` · ${fmtSize(u.latest.size)}` : ""}
          </span>
          {u?.status === "downloading" && (
            <span className="update-bar">
              <span style={{ width: `${Math.round((u.progress ?? 0) * 100)}%` }} />
            </span>
          )}
          {u?.latest?.notes && (u.status === "available" || u.status === "ready") && <div className="update-notes">{u.latest.notes}</div>}
        </div>
        <div className="update-actions">
          {(u?.status === "available" || u?.status === "ready") && (
            <button className="btn primary small" disabled={busy} onClick={install}>
              {u.status === "ready" ? "Перезапустить и обновить" : "Обновить"}
            </button>
          )}
          {(u?.status === "available" || u?.status === "ready") && !u.skipped && (
            <button className="btn ghost small" disabled={busy} onClick={skip} title="Не напоминать об этой версии">
              Пропустить
            </button>
          )}
          <button className="btn small" disabled={busy || !configured || u?.status === "checking" || u?.status === "downloading"} onClick={check}>
            <Refresh size={14} /> Проверить
          </button>
        </div>
      </div>
      <Toggle checked={cfg?.auto ?? true} onChange={(v) => saveSettings({ update: { auto: v } })} label="Скачивать обновления автоматически" hint="Установка — только по вашей кнопке. Файл проверяется по SHA-256 перед запуском" />
      <button className="link-btn small" onClick={() => setAdv(!adv)}>
        {adv ? "Скрыть источник обновлений" : "Источник обновлений…"}
      </button>
      {adv && (
        <div className="set-col">
          <Row label="GitHub-репозиторий" hint={!own && cfg?.builtin ? `Пусто — используется встроенный: ${cfg.builtin}` : "owner/repo — берётся последний релиз с JarvisCodeSetup.exe"}>
            <div className="field compact">
              <input value={repo} placeholder={cfg?.builtin?.startsWith("github.com/") ? cfg.builtin.slice(11) : "owner/jarvis-code"} spellCheck={false} onChange={(e) => setRepo(e.target.value)} onBlur={() => repo !== (cfg?.repo ?? "") && saveSettings({ update: { repo } })} />
            </div>
          </Row>
          <Row label="Или адрес latest.json" hint="Свой сервер: {version, url, sha256, notes}">
            <div className="field compact">
              <input value={manifest} placeholder="https://…/latest.json" spellCheck={false} onChange={(e) => setManifest(e.target.value)} onBlur={() => manifest !== (cfg?.manifestUrl ?? "") && saveSettings({ update: { manifestUrl: manifest } })} />
            </div>
          </Row>
        </div>
      )}
    </>
  );
}

function CrashSection() {
  const st = useStore((s) => s.state!);
  const cfg = st.settings.crash;
  const [items, setItems] = useState<CrashInfo[] | null>(null);
  const [endpoint, setEndpoint] = useState(cfg?.endpoint ?? "");
  useEffect(() => {
    api<{ items: CrashInfo[] }>("crashes")
      .then((r) => setItems(r.items))
      .catch(() => setItems([]));
  }, []);
  return (
    <>
      <h3>Отчёты о сбоях</h3>
      <p className="muted small">Если Jarvis Code упадёт, отчёт (ошибка, версия, Windows — без токенов, путей пользователя и содержимого чатов) сохранится в папке данных. Отправка — только с вашего согласия.</p>
      <Toggle checked={cfg?.send ?? false} onChange={(v) => saveSettings({ crash: { send: v } })} label="Отправлять отчёты автоматически" hint={endpoint ? "На адрес ниже" : "Сначала укажите адрес для отчётов"} />
      <Row label="Адрес для отчётов" hint="HTTPS-адрес, принимающий JSON (POST)">
        <div className="field compact">
          <input value={endpoint} placeholder="https://…/crash" spellCheck={false} onChange={(e) => setEndpoint(e.target.value)} onBlur={() => endpoint !== (cfg?.endpoint ?? "") && saveSettings({ crash: { endpoint } })} />
        </div>
      </Row>
      <Row label="Сохранённые отчёты" hint={items === null ? "…" : items.length ? `${items.length} шт., последний ${ago(items[items.length - 1].at)}` : "Сбоев не было"}>
        <button className="btn small" onClick={() => api("crashes/open", { body: {} }).catch((e) => toast(e.message, "error"))}>
          <Bug size={14} /> Открыть папку
        </button>
      </Row>
    </>
  );
}

function SecurityTab() {
  const st = useStore((s) => s.state!);
  return (
    <>
      <h2>Безопасность</h2>
      <p className="muted">Jarvis Code проверяет каждую команду и правку агента до выполнения. Эти защиты работают в любом режиме доступа.</p>
      <div className="sec-status ok">
        <Shield size={18} />
        <div>
          <b>Токены Notion не нужны и не хранятся</b>
          <span className="muted small">Jarvis Code работает только через чат Notion и мост MCP: вход в Notion остаётся в вашем браузере, а у моста — свой секретный адрес.</span>
        </div>
      </div>
      <h3>Что защищено всегда</h3>
      <div className="sec-list">
        {[
          ["Секреты", "Ключи SSH, .env, пароли и куки браузеров, кошельки, облачные ключи — агент спросит разрешение даже в режиме «Полный доступ», а в «Автономно» не получит."],
          ["Цепочки команд", "Каждая часть «a && b | c» проверяется отдельно: разрешение на git status не пропустит хвост после «;»."],
          ["Скрытые команды", "Закодированный PowerShell, скачать-и-выполнить, отключение защитника, автозагрузка — всегда с вопросом."],
          ["Системные места", "Автозагрузка, хуки git, профили PowerShell, системные папки — правки только с подтверждением."],
          ["Экран и буфер обмена", "Снимок экрана и чтение буфера — только после вашего «Разрешить» (можно один раз на чат), в любом режиме; в «Автономно» недоступны."],
          ["Удаление", "Агент удаляет в корзину — файлы можно восстановить. Без вопроса — только внутри папки проекта в «Полный доступ» и «Автономно»; корни дисков, системные и основные папки — никогда."],
          ["Маскирование", "Токены и ключи вырезаются из вывода команд, прежде чем попасть агенту и в журнал."],
          ["Отмена правок", "Перед каждой правкой файла сохраняется копия на 14 дней — «Отменить правку» в чате."],
        ].map(([t, d]) => (
          <div key={t} className="sec-item">
            <Check size={14} />
            <span>
              <b>{t}.</b> {d}
            </span>
          </div>
        ))}
      </div>
      <Row label="Копии файлов до правок" hint="Хранятся 14 дней в хранилище">
        <button className="btn small" onClick={() => openExternal(`${st.storage.dir}${st.system.platform === "win32" ? "\\" : "/"}history`)}>
          <Clock size={14} /> Открыть
        </button>
      </Row>
    </>
  );
}

// ───── Поиск ─────

export function SearchModal() {
  const chats = useStore((s) => s.state!.chats);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const res = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return chats.slice(0, 30);
    return chats.filter((c) => c.title.toLowerCase().includes(t) || c.preview.toLowerCase().includes(t) || c.project.toLowerCase().includes(t)).slice(0, 50);
  }, [q, chats]);
  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    list.current?.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <Modal onClose={() => set({ modal: null })} className="search-modal">
      <div className="search-field">
        <Search size={18} className="muted" />
        <input
          autoFocus
          value={q}
          placeholder="Поиск по чатам…"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") (e.preventDefault(), setActive((a) => Math.min(res.length, a + 1)));
            if (e.key === "ArrowUp") (e.preventDefault(), setActive((a) => Math.max(0, a - 1)));
            if (e.key === "Enter") {
              if (active === 0) newChat();
              else openChat(res[active - 1].id);
            }
          }}
        />
      </div>
      <div className="search-list" ref={list}>
        <button className={cx("search-item", active === 0 && "active")} onMouseEnter={() => setActive(0)} onClick={() => newChat()}>
          <Plus size={16} />
          <span className="search-title">Новый чат</span>
        </button>
        {res.map((c, i) => (
          <button key={c.id} className={cx("search-item", active === i + 1 && "active")} onMouseEnter={() => setActive(i + 1)} onClick={() => openChat(c.id)}>
            <span className="search-text">
              <span className="search-title">{c.title}</span>
              {c.preview && <span className="search-preview">{c.preview}</span>}
            </span>
            <span className="muted small nowrap">{ago(c.updatedAt)}</span>
          </button>
        ))}
        {q && res.length === 0 && <div className="muted pad">Ничего не найдено</div>}
      </div>
    </Modal>
  );
}

// ───── Папки ─────

export function FoldersModal() {
  const st = useStore((s) => s.state!);
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const c of st.chats) m[c.project] = (m[c.project] ?? 0) + 1;
    return m;
  }, [st.chats]);
  const folders = st.settings.recentProjects.length ? st.settings.recentProjects : [st.settings.project];
  const startIn = async (p: string) => {
    set({ modal: null });
    newChat(p);
  };
  const add = async () => {
    const [p] = await pickPaths("folder", st.settings.project);
    if (!p) return;
    await saveSettings({ project: p });
    startIn(p);
  };
  const recentChats = (p: string) => st.chats.filter((c) => c.project === p).slice(0, 3);
  return (
    <Modal title="Папки" onClose={() => set({ modal: null })} wide className="folders-modal">
      <p className="muted">Рабочая папка — место, относительно которого агент понимает пути вроде «src» или «README.md». Сам агент видит весь ПК.</p>
      <div className="folder-list">
        {folders.map((p) => (
          <div key={p} className="folder-card">
            <div className="folder-main" onClick={() => startIn(p)}>
              <span className="folder-ico">
                <Folder size={20} />
              </span>
              <span className="folder-text">
                <span className="folder-name">{baseName(p)}</span>
                <span className="muted small">{shortPath(p, 60)}</span>
              </span>
              <span className="muted small nowrap">{counts[p] ? `${counts[p]} чат.` : ""}</span>
            </div>
            {recentChats(p).length > 0 && (
              <div className="folder-chats">
                {recentChats(p).map((c) => (
                  <button key={c.id} onClick={() => openChat(c.id)}>
                    {c.title}
                  </button>
                ))}
              </div>
            )}
            <div className="folder-actions">
              <button className="btn small" onClick={() => startIn(p)}>
                <Plus size={14} /> Новый чат
              </button>
              <button className="btn small ghost" onClick={() => openExternal(p)}>
                <FolderOpen size={14} /> Проводник
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={() => startIn(get().state!.system.home)}>
          <Monitor size={15} /> Весь компьютер (домашняя папка)
        </button>
        <button className="btn primary" onClick={add}>
          <Plus size={15} /> Добавить папку…
        </button>
      </div>
    </Modal>
  );
}
