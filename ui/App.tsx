import { ControlCenterButton } from "./ControlCenter";
import { useEffect, useMemo, useRef, useState } from "react";
import { RelayDestination } from "./RelayDestination";
import { BridgeView, bridgeStatus, relayStatus, StatusDot } from "./Bridge";
import { ChatView } from "./Chat";
import { Composer, useProjectSetter } from "./Composer";
import { baseName, cx, dayGroup, LightboxHost, Menu, MODE_INFO, shortPath, type MenuItem } from "./common";
import { FolderBrowserHost } from "./FolderBrowser";
import { ArrowDown, Book, Brand, Bug, Code, Cpu, Download, External, FileText, Folder, FolderOpen, More, Package, PanelLeft, Pencil, Plug, Plus, Search, Shield, Sliders, Spark, Trash, X, Zap } from "./icons";
import { Installer } from "./Installer";
import { ImportModal } from "./Import";
import { Toasts } from "./Toasts";
import { FoldersModal, SearchModal, SettingsModal } from "./Settings";
import { api, BRIDGE_ID, get, newChat, onImported, openChat, openExternal, send, set, relayServiceName, setTitle, startRelay, toast, useStore, type ChatSummary, NONE } from "./store";

export function App() {
  const ready = useStore((s) => s.ready);
  const state = useStore((s) => s.state);
  const connected = useStore((s) => s.connected);
  const sidebar = useStore((s) => s.sidebar);
  const modal = useStore((s) => s.modal);
  const currentId = useStore((s) => s.currentId);
  const chatTitle = useStore((s) => s.chat?.title);

  useEffect(() => {
    setTitle(currentId && chatTitle ? `${chatTitle} — Jarvis Code` : "Jarvis Code");
  }, [currentId, chatTitle]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        set({ modal: get().modal === "search" ? null : "search" });
      } else if (mod && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleSidebar();
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        newChat();
      } else if (mod && e.key === ",") {
        e.preventDefault();
        set({ modal: "settings", settingsTab: "general" });
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  // агент перенёс чат из Notion (nc_import) — сразу открываем его
  useEffect(
    () =>
      onImported((e) => {
        const st = get();
        if (st.modal === "import" || !st.currentId) openChat(e.chatId);
      }),
    [],
  );

  if (!ready || !state) {
    return (
      <div className="splash boot">
        <Spark size={64} spin className="accent" />
        <div className="boot-title">
          Jarvis <span>Code</span>
        </div>
      </div>
    );
  }
  if (state.mode === "installer") return <Installer />;

  return (
    <div className={cx("app", !sidebar && "collapsed")}>
      <Sidebar />
      <main className="main">
        <TopBar />
        {currentId === BRIDGE_ID ? <BridgeView /> : currentId ? <ChatView key={currentId} id={currentId} /> : <Home />}
      </main>
      {modal === "settings" && <SettingsModal />}
      {modal === "import" && <ImportModal />}
      {modal === "search" && <SearchModal />}
      {modal === "folders" && <FoldersModal />}
      <FolderBrowserHost />
      <LightboxHost onOpenPath={(p) => openExternal(p)} />
      <CrashPrompt />
      <Toasts />
      {!connected && (
        <div className="offline-bar" role="status">
          <span className="tool-spin" /> Нет связи с Jarvis Code — переподключаюсь…
        </div>
      )}
    </div>
  );
}

function toggleSidebar() {
  const v = !get().sidebar;
  localStorage.setItem("nc-sidebar", v ? "1" : "0");
  set({ sidebar: v });
}

// ───── Отчёт о сбое с прошлого запуска ─────

function CrashPrompt() {
  const crashes = useStore((s) => s.state?.crashes ?? NONE);
  const endpoint = useStore((s) => s.state?.settings.crash?.endpoint ?? "");
  const [busy, setBusy] = useState(false);
  if (!crashes.length) return null;
  const c = crashes[crashes.length - 1];
  const act = async (action: "send" | "dismiss" | "open") => {
    setBusy(true);
    try {
      const r = await api<{ ok: boolean; error?: string; dir?: string }>(`crashes/${action}`, { body: { ids: crashes.map((x) => x.id) } });
      if (action === "send") toast(r.ok ? "Отчёт отправлен — спасибо!" : `Не отправлено: ${r.error ?? "нет адреса для отчётов"}`, r.ok ? "success" : "error");
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="crash-prompt" role="alert">
      <span className="crash-ico">
        <Bug size={18} />
      </span>
      <div className="crash-text">
        <b>В прошлом запуске произошёл сбой</b>
        <span className="muted small" title={c.message}>
          {c.message.slice(0, 140)}
        </span>
        <div className="crash-actions">
          {endpoint ? (
            <button className="btn small primary" disabled={busy} onClick={() => act("send")}>
              Отправить отчёт
            </button>
          ) : null}
          <button className="btn small" disabled={busy} onClick={() => act("open")}>
            Открыть отчёт
          </button>
          <button className="btn small ghost" disabled={busy} onClick={() => act("dismiss")}>
            Не сейчас
          </button>
        </div>
      </div>
      <button className="icon-btn small" onClick={() => act("dismiss")} aria-label="Закрыть">
        <X size={14} />
      </button>
    </div>
  );
}

// ───── Боковая панель ─────

function Sidebar() {
  const chats = useStore((s) => s.state?.chats ?? NONE);
  const currentId = useStore((s) => s.currentId);
  const status = useStore((s) => s.status);
  const attention = useStore((s) => s.attention);
  const user = useStore((s) => s.state!.user);
  const sysUser = useStore((s) => s.state!.system.user);
  const storageProblem = useStore((s) => s.state!.storage?.problem);
  const bridge = useStore((s) => s.state!.bridge);
  const update = useStore((s) => s.state!.update);
  const [userMenu, setUserMenu] = useState(false);
  const userBtn = useRef<HTMLButtonElement>(null);
  const name = user.name || sysUser || "Вы";
  const bst = bridgeStatus(bridge);
  const rst = relayStatus(bridge);
  const groups = useMemo(() => {
    const out: { label: string; items: ChatSummary[] }[] = [];
    for (const c of chats) {
      const g = dayGroup(c.updatedAt);
      const last = out[out.length - 1];
      if (last?.label === g) last.items.push(c);
      else out.push({ label: g, items: [c] });
    }
    return out;
  }, [chats]);
  const userItems: MenuItem[] = [
    { key: "import", icon: <ArrowDown size={15} />, label: "Перенести чат из Notion…", hint: "С историей и памятью", onSelect: () => set({ modal: "import" }) },
    {
      key: "relay",
      icon: <StatusDot tone={rst.tone} />,
      label: rst.tone === "online" ? "Агент в чате Notion на связи" : "Запустить агента в чате Notion",
      hint: rst.tone === "online" ? "Команда запуска — ещё раз" : rst.hint,
      onSelect: () => (bridge.connected ? void startRelay() : openChat(BRIDGE_ID)),
    },
    { key: "d1", divider: true, label: "" },
    { key: "storage", icon: <Package size={15} />, label: "Хранилище", hint: "Папка для чатов и файлов", onSelect: () => set({ modal: "settings", settingsTab: "storage" }) },
    { key: "settings", icon: <Sliders size={15} />, label: "Настройки", hint: "Ctrl+,", onSelect: () => set({ modal: "settings", settingsTab: "general" }) },
  ];
  const updateReady = update && !update.skipped && (update.status === "available" || update.status === "ready" || update.status === "downloading");

  return (
    <aside className="sidebar" aria-label="Боковая панель">
      <div className="sb-top">
        <Brand size={22} className="sb-brand" />
        <button className="icon-btn" onClick={toggleSidebar} title="Скрыть панель (Ctrl+B)" aria-label="Скрыть панель">
          <PanelLeft size={18} />
        </button>
      </div>
      <nav className="sb-nav">
        <button className="sb-item new" onClick={() => newChat()} title="Новый чат (Ctrl+Shift+O)">
          <span className="sb-new-ico">
            <Plus size={15} />
          </span>
          <span>Новый чат</span>
          <kbd>Ctrl ⇧ O</kbd>
        </button>
        <button className="sb-item" onClick={() => set({ modal: "search" })} title="Поиск по чатам (Ctrl+K)">
          <Search size={17} />
          <span>Поиск</span>
          <kbd>Ctrl K</kbd>
        </button>
        <button className="sb-item" onClick={() => set({ modal: "folders" })}>
          <Folder size={17} />
          <span>Папки</span>
        </button>
        <button className="sb-item" onClick={() => set({ modal: "import" })} title="Перенести чат из Notion или из текста — с историей">
          <ArrowDown size={17} />
          <span>Перенести чат</span>
        </button>
        <button className="sb-item" onClick={() => set({ modal: "settings", settingsTab: "pc" })}>
          <Shield size={17} />
          <span>Доступ к ПК</span>
        </button>
      </nav>
      <div className="sb-pinned">
        <button className={cx("sb-item sb-bridge", currentId === BRIDGE_ID && "active", `s-${bst.tone}`)} onClick={() => openChat(BRIDGE_ID)} title={`Мост MCP: ${bst.text.toLowerCase()}`}>
          <span className="sb-bridge-ico">
            <Plug size={15} />
          </span>
          <span className="sb-bridge-text">
            <span>Мост · агент в Notion</span>
            <span className="sb-bridge-sub">
              {bst.tone === "online" && !bridge.connected ? "Подключите в Notion" : bst.text}
              {bridge.calls ? ` · ${bridge.calls}` : ""}
            </span>
          </span>
          {attention[BRIDGE_ID] ? <span className="attn-dot" /> : bridge.running > 0 ? <Spark size={14} spin className="accent dot-ico" /> : <StatusDot tone={bst.tone} />}
        </button>
      </div>
      <div className="sb-chats">
        {chats.length === 0 && <div className="sb-empty">Здесь появятся ваши чаты</div>}
        {groups.map((g) => (
          <div key={g.label} className="sb-group">
            <div className="sb-section">{g.label}</div>
            {g.items.map((c) => (
              <ChatRow
                key={c.id}
                c={c}
                active={c.id === currentId}
                busy={!!status[c.id]?.busy}
                attention={!!attention[c.id]}
              />
            ))}
          </div>
        ))}
      </div>
      {updateReady && (
        <button className="sb-update" onClick={() => set({ modal: "settings", settingsTab: "about" })}>
          <Download size={15} />
          <span>
            {update!.status === "downloading" ? `Загружаю обновление… ${Math.round((update!.progress ?? 0) * 100)}%` : `Доступна версия ${update!.latest?.version ?? ""}`}
          </span>
          {update!.status !== "downloading" && <b>Обновить</b>}
        </button>
      )}
      {storageProblem && (
        <button className="sb-update warn" onClick={() => set({ modal: "settings", settingsTab: "storage" })} title={storageProblem}>
          <Package size={15} />
          <span>Папка хранилища недоступна</span>
          <b>Открыть</b>
        </button>
      )}
      <button ref={userBtn} className={cx("sb-user", userMenu && "open")} onClick={() => setUserMenu(!userMenu)} title="Перенос чатов, хранилище и настройки">
        <span className="avatar">{name.slice(0, 1).toUpperCase()}</span>
        <span className="sb-user-text">
          <span className="sb-user-name">{name}</span>
          <span className={cx("sb-user-sub", `s-${rst.tone}`)}>
            <StatusDot tone={rst.tone} /> {rst.text}
          </span>
        </span>
        <More size={16} className="muted" />
      </button>
      {userMenu && <Menu anchor={userBtn.current} items={userItems} onClose={() => setUserMenu(false)} placement="above" width={268} />}
    </aside>
  );
}

function ChatRow({ c, active, busy, attention }: { c: ChatSummary; active: boolean; busy: boolean; attention: boolean }) {
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(c.title);
  const more = useRef<HTMLButtonElement>(null);

  const rename = async () => {
    setEditing(false);
    const t = title.trim();
    if (!t || t === c.title) return setTitle(c.title);
    await api(`chats/${c.id}/rename`, { body: { title: t } }).catch((e) => toast(e.message, "error"));
  };
  const remove = async () => {
    if (!confirm(`Удалить чат «${c.title}»?`)) return;
    await api(`chats/${c.id}`, { method: "DELETE" }).catch((e) => toast(e.message, "error"));
    if (get().currentId === c.id) newChat();
  };
  const exportMd = async () => {
    try {
      const r = await api<{ ok: boolean; path: string }>(`chats/${c.id}/export`, { body: {} });
      toast(`Чат сохранён в Markdown: ${r.path}`, "success");
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  const items: MenuItem[] = [
    { key: "rename", icon: <Pencil size={15} />, label: "Переименовать", onSelect: () => (setTitle(c.title), setEditing(true)) },
    ...(c.project ? [{ key: "folder", icon: <FolderOpen size={15} />, label: "Открыть папку", hint: shortPath(c.project, 34), onSelect: () => openExternal(c.project) }] : []),
    { key: "export", icon: <Download size={15} />, label: "Сохранить в Markdown", hint: "в «Загрузки»", onSelect: () => void exportMd() },
    { key: "context", icon: <FileText size={15} />, label: "Контекст на диске", hint: "память и вся переписка", onSelect: () => void api(`chats/${c.id}/context`, { body: {} }).catch((e) => toast(e.message, "error")) },
    { key: "d", divider: true, label: "" },
    { key: "delete", icon: <Trash size={15} />, label: "Удалить", danger: true, onSelect: remove },
  ];

  if (editing)
    return (
      <div className="sb-chat editing">
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={rename}
          onKeyDown={(e) => {
            if (e.key === "Enter") rename();
            if (e.key === "Escape") (setTitle(c.title), setEditing(false));
          }}
        />
      </div>
    );

  return (
    <div className={cx("sb-chat", active && "active", menu && "menu-open")} title={c.preview || c.title}>
      <button className="sb-chat-main" onClick={() => openChat(c.id)} onDoubleClick={() => (setTitle(c.title), setEditing(true))}>
        {busy ? <Spark size={13} spin className="accent dot-ico" /> : attention ? <span className="attn-dot" /> : null}
        <span className="sb-chat-title">{c.title}</span>
        {c.imported && (
          <span className="acc-tag" title="Перенесён из Notion или из текста — с историей">
            <ArrowDown size={10} />
          </span>
        )}
      </button>
      <button ref={more} className="icon-btn sb-chat-more" onClick={() => setMenu(!menu)} aria-label="Действия">
        <More size={16} />
      </button>
      {menu && <Menu anchor={more.current} items={items} onClose={() => setMenu(false)} width={230} />}
    </div>
  );
}

// ───── Верхняя панель ─────

function TopBar() {
  const sidebar = useStore((s) => s.sidebar);
  const chat = useStore((s) => s.chat);
  const currentId = useStore((s) => s.currentId);
  const bridge = useStore((s) => s.state!.bridge);
  const chatUrl = useStore((s) => s.chat?.relayChatUrl || s.state!.bridgeSettings.chatUrl);
  const rst = relayStatus(bridge);
  const [editing, setEditing] = useState(false);
  const [title, setTitleText] = useState("");

  const rename = async () => {
    setEditing(false);
    if (!chat || !title.trim() || title.trim() === chat.title) return;
    await api(`chats/${chat.id}/rename`, { body: { title: title.trim() } }).catch((e) => toast(e.message, "error"));
  };

  return (
    <header className="topbar">
      <div className="tb-left">
        {!sidebar && (
          <>
            <button className="icon-btn" onClick={toggleSidebar} title="Показать панель (Ctrl+B)" aria-label="Показать панель">
              <PanelLeft size={18} />
            </button>
            <button className="icon-btn" onClick={() => newChat()} title="Новый чат" aria-label="Новый чат">
              <Plus size={18} />
            </button>
          </>
        )}
        {currentId === BRIDGE_ID && <span className="tb-title static">Мост · агент в Notion</span>}
        {currentId && currentId !== BRIDGE_ID && chat && !editing && (
          <button className="tb-title" onClick={() => (setTitleText(chat.title), setEditing(true))} title="Переименовать">
            {chat.title}
          </button>
        )}
        {editing && (
          <input
            className="tb-title-input"
            autoFocus
            value={title}
            onChange={(e) => setTitleText(e.target.value)}
            onBlur={rename}
            onKeyDown={(e) => {
              if (e.key === "Enter") rename();
              if (e.key === "Escape") setEditing(false);
            }}
          />
        )}
      </div>
      {currentId ? (
        <div />
      ) : (
        <button
          className={cx("tb-pill", `s-${rst.tone}`)}
          onClick={() => (bridge.connected && rst.tone !== "online" ? void startRelay() : openChat(BRIDGE_ID))}
          title={rst.hint}
        >
          <StatusDot tone={rst.tone} />
          <span>Чат {relayServiceName(chatUrl)}</span>
          <span className="tb-pill-sep">·</span>
          <span className="tb-pill-accent">{rst.text}</span>
        </button>
      )}
      <div className="tb-right">
        {currentId && currentId !== BRIDGE_ID && chat && <ControlCenterButton />}
        {currentId && currentId !== BRIDGE_ID && chat && <RelayDestination key={chat.id} chat={chat} />}
        {currentId && chat?.project && (
          <button className="tb-btn" onClick={() => openExternal(chat.project)} title={`Рабочая папка: ${chat.project}`}>
            <Folder size={15} />
            <span>{baseName(chat.project)}</span>
          </button>
        )}
        {currentId !== BRIDGE_ID && (
          <button className="icon-btn" onClick={() => openExternal(/^https:\/\//.test(chatUrl) ? chatUrl : "https://app.notion.com/chat")} title={`Открыть чат ${relayServiceName(chatUrl)}`} aria-label={`Открыть чат ${relayServiceName(chatUrl)}`}>
            <External size={17} />
          </button>
        )}
      </div>
    </header>
  );
}

// ───── Главный экран ─────

const SUGGESTIONS: { key: string; label: string; icon: JSX.Element; prompts: string[] }[] = [
  {
    key: "code",
    label: "Код",
    icon: <Code size={16} />,
    prompts: [
      "Разберись в проекте в рабочей папке и кратко опиши его архитектуру",
      "Найди и исправь ошибки сборки в этом проекте",
      "Сделай ревью незакоммиченных изменений (git diff) и предложи улучшения",
      "Напиши тесты для самых важных модулей проекта",
    ],
  },
  {
    key: "files",
    label: "Файлы",
    icon: <Folder size={16} />,
    prompts: [
      "Найди 20 самых больших файлов на диске C: и подскажи, что можно удалить",
      "Наведи порядок в папке «Загрузки»: разложи файлы по папкам по типу",
      "Найди дубликаты файлов в папке «Документы»",
      "Найди документ, в котором упоминается ",
    ],
  },
  {
    key: "system",
    label: "Система",
    icon: <Cpu size={16} />,
    prompts: [
      "Что сейчас сильнее всего грузит процессор и память?",
      "Проверь место на дисках и общее состояние системы",
      "Какие программы стоят в автозагрузке? Что из этого можно отключить?",
      "Проверь интернет-подключение, DNS и скорость отклика",
    ],
  },
  {
    key: "auto",
    label: "Автоматизация",
    icon: <Zap size={16} />,
    prompts: [
      "Напиши PowerShell-скрипт для ежедневного бэкапа папки «Документы» и добавь его в Планировщик",
      "Переименуй файлы в папке по шаблону ГГГГ-ММ-ДД_название",
      "Сожми все фотографии в папке до 1920 px по длинной стороне",
      "Создай ярлык на рабочем столе, который ",
    ],
  },
  {
    key: "notion",
    label: "Notion",
    icon: <Book size={16} />,
    prompts: [
      "Собери отчёт о состоянии ПК и сохрани его на новую страницу в Notion",
      "Найди в Notion мои задачи на сегодня и помоги начать с первой",
      "Сделай из README проекта аккуратную страницу в Notion",
      "Составь в Notion план работ по задаче: ",
    ],
  },
];

function greeting(): string {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return "Доброе утро";
  if (h >= 12 && h < 18) return "Добрый день";
  if (h >= 18 && h < 23) return "Добрый вечер";
  return "Доброй ночи";
}

/** Шапка главного экрана: знак и приветствие — спокойно, как в Claude. */
function Hero({ title }: { title: string }) {
  return (
    <div className="hero">
      <Spark size={40} intro className="accent hero-mark" />
      <h1 className="greeting">{title}</h1>
    </div>
  );
}

/** Строка состояния под полем ввода: мост и режим — без «приборной панели». */
function HomeStatus() {
  const st = useStore((s) => s.state!);
  const draftMode = useStore((s) => s.draftMode);
  const rst = relayStatus(st.bridge);
  const mode = MODE_INFO[draftMode ?? st.settings.defaultMode];
  return (
    <div className="home-status">
      <button
        className={cx("hs-item", `s-${rst.tone}`)}
        onClick={() => (st.bridge.connected && rst.tone !== "online" ? void startRelay() : openChat(BRIDGE_ID))}
        title={rst.hint}
      >
        <StatusDot tone={rst.tone} />
        {rst.text}
      </button>
      <span className="hs-sep" />
      <button className="hs-item" onClick={() => set({ modal: "import" })} title="Перенести чат из Notion — с историей">
        <ArrowDown size={13} />
        Перенести чат
      </button>
      <span className="hs-sep" />
      <button className="hs-item" onClick={() => set({ modal: "settings", settingsTab: "pc" })} title="Режим по умолчанию для новых чатов">
        <Shield size={13} />
        {mode.label}
      </button>
    </div>
  );
}

function Home() {
  const st = useStore((s) => s.state!);
  const draftMode = useStore((s) => s.draftMode);
  const draftProject = useStore((s) => s.draftProject);
  const [chip, setChip] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<{ text: string; n: number } | null>(null);
  const setProject = useProjectSetter();
  const name = (st.user.name || st.system.user || "").split(/\s+/)[0];
  const hello = useMemo(greeting, []);
  const mode = draftMode ?? st.settings.defaultMode;
  const project = draftProject ?? st.settings.project;
  const group = SUGGESTIONS.find((g) => g.key === chip);

  return (
    <div className="home-screen">
      <div className="home-inner">
        <Hero title={`${hello}${name ? `, ${name}` : ""}`} />
        {!st.bridge.connected && <SetupCard />}
        <Composer
          variant="home"
          busy={false}
          mode={mode}
          project={project}
          onMode={(m) => set({ draftMode: m })}
          onProject={setProject}
          onSend={send}
          onStop={() => {}}
          prefill={prefill}
        />
        {group ? (
          <div className="suggest" key={group.key}>
            <div className="suggest-head">
              {group.icon}
              <span>{group.label}</span>
              <button className="icon-btn small" onClick={() => setChip(null)} aria-label="Закрыть">
                <X size={14} />
              </button>
            </div>
            {group.prompts.map((p, i) => (
              <button key={p} className="suggest-item" style={{ "--i": i } as React.CSSProperties} onClick={() => (setPrefill({ text: p, n: Date.now() }), setChip(null))}>
                {p.trimEnd()}
                {p.endsWith(" ") ? "…" : ""}
              </button>
            ))}
          </div>
        ) : (
          <div className="chips">
            {SUGGESTIONS.map((g, i) => (
              <button key={g.key} className="chip" style={{ "--i": i } as React.CSSProperties} onClick={() => setChip(g.key)}>
                {g.icon}
                <span>{g.label}</span>
              </button>
            ))}
          </div>
        )}
        <HomeStatus />
      </div>
    </div>
  );
}

/** Первый запуск (или новое пространство): мост ещё не подключён к Notion AI. */
function SetupCard() {
  const bridge = useStore((s) => s.state!.bridge);
  const bst = bridgeStatus(bridge);
  return (
    <button className="setup-card" onClick={() => openChat(BRIDGE_ID)}>
      <span className="noacc-ico">
        <Plug size={18} />
      </span>
      <span className="grow">
        <b>Подключите Jarvis Code к Notion AI</b>
        <span className="muted small">
          Один раз в каждом пространстве: мост к ПК добавляется в Notion AI как MCP-сервер. Чаты, их история и память хранятся здесь — с любым пространством работа продолжится с того же места. Мост: {bst.text.toLowerCase()}.
        </span>
      </span>
      <StatusDot tone={bst.tone} />
    </button>
  );
}
