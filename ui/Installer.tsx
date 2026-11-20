import { useEffect, useState } from "react";
import { Toggle } from "./common";
import { pickPaths, FolderBrowserHost } from "./FolderBrowser";
import { Alert, Check, FolderOpen, Spark } from "./icons";
import { api, set, toast, useStore } from "./store";
import { Toasts } from "./Toasts";

interface Defaults {
  dir: string;
  desktop: boolean;
  startMenu: boolean;
  path: boolean;
  autostart: boolean;
  notionShortcut: boolean;
  existing: string | null;
  /** Установлен Notion Code (прежнее название) — его заменит Jarvis Code. */
  legacy: string | null;
  version: string;
}

export function Installer() {
  const install = useStore((s) => s.install);
  const [d, setD] = useState<Defaults | null>(null);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    document.title = "Установка Jarvis Code";
    api<Defaults>("install/defaults")
      .then(setD)
      .catch((e) => toast(e.message, "error"));
  }, []);

  const run = async () => {
    if (!d) return;
    setStarted(true);
    try {
      await api("install/run", { body: { dir: d.dir, desktop: d.desktop, startMenu: d.startMenu, path: d.path, autostart: d.autostart, notionShortcut: d.notionShortcut } });
    } catch (e) {
      setStarted(false);
      toast((e as Error).message, "error");
    }
  };
  const browse = async () => {
    const [p] = await pickPaths("folder", d?.dir);
    if (p && d) setD({ ...d, dir: /jarvis ?code$/i.test(p) ? p : `${p.replace(/[\\/]+$/, "")}\\Jarvis Code` });
  };
  const launch = async () => {
    try {
      await api("install/launch", { body: { dir: install?.dir ?? d?.dir } });
      setTimeout(() => window.close(), 300);
    } catch (e) { toast((e as Error).message, "error"); }
  };

  const steps = install?.steps ?? [];
  const done = install?.done;

  return (
    <div className="installer">
      <div className="inst-side">
        <div className="inst-mark">
          <Spark size={88} spin={!!started && !done} intro={!started} className="accent" />
        </div>
        <div className="inst-brand">
          Jarvis <span>Code</span>
        </div>
        <div className="inst-ver">версия {d?.version ?? ""}</div>
        <div className="inst-tag">ИИ-агент Notion с доступом к вашему ПК: файлы, код, команды</div>
        <ul className="inst-points">
          <li>Работает с вашими файлами и кодом — с вашего разрешения</li>
          <li>Чаты с Notion AI и Custom Agents прямо в окне</li>
          <li>Мост для агента в самом Notion</li>
        </ul>
      </div>
      <div className="inst-main">
        {!started && d && (
          <>
            <h1 className="serif">{d.existing ? "Обновление Jarvis Code" : d.legacy ? "Переход на Jarvis Code" : "Установка Jarvis Code"}</h1>
            <p className="muted">
              {d.existing
                ? "Найдена установленная версия — она будет обновлена. Настройки, вход и история чатов сохранятся."
                : d.legacy
                ? "Найден Notion Code — Jarvis Code заменит его: старая программа, её ярлыки и автозапуск будут удалены, а вход, ключ моста, настройки и история чатов сохранятся."
                : "ИИ-агент Notion на вашем ПК: читает и правит файлы, ищет, запускает команды и код — с вашего разрешения. Чаты с Notion AI или вашими Custom Agents, а также мост для агента в самом Notion."}
            </p>
            <label className="inst-label">Папка установки</label>
            <div className="field">
              <input value={d.dir} spellCheck={false} onChange={(e) => setD({ ...d, dir: e.target.value })} />
              <button className="btn small" onClick={browse}>
                <FolderOpen size={14} /> Обзор…
              </button>
            </div>
            <div className="inst-opts">
              <Toggle checked={d.desktop} onChange={(v) => setD({ ...d, desktop: v })} label="Ярлык на рабочем столе" />
              <Toggle checked={d.startMenu} onChange={(v) => setD({ ...d, startMenu: v })} label="Ярлык в меню «Пуск»" />
              <Toggle checked={d.path} onChange={(v) => setD({ ...d, path: v })} label="Команда jarvis в терминале" hint="Открыть приложение из любой папки: jarvis ." />
              <Toggle checked={d.autostart} onChange={(v) => setD({ ...d, autostart: v })} label="Запускать вместе с Windows" hint="В трее, без окна: мост для агента в Notion включается сам" />
              <Toggle checked={d.notionShortcut} onChange={(v) => setD({ ...d, notionShortcut: v })} label="Ярлык «Notion (с мостом)»" hint="Открывает Notion и заодно запускает мост в фоне — один значок вместо скриптов" />
            </div>
            <div className="inst-actions">
              <span className="muted small">Права администратора не нужны</span>
              <button className="btn primary" onClick={run}>
                {d.existing ? "Обновить" : "Установить"}
              </button>
            </div>
          </>
        )}
        {started && (
          <>
            <h1 className="serif">{done ? (install?.ok ? "Готово!" : "Не получилось") : "Устанавливаю…"}</h1>
            <div className="inst-steps">
              {steps.map((s) => (
                <div key={s.id} className={`inst-step ${s.status}`}>
                  <span className="inst-step-ico">
                    {s.status === "ok" && <Check size={15} />}
                    {s.status === "running" && <Spark size={15} spin className="accent" />}
                    {s.status === "error" && <Alert size={15} />}
                    {s.status === "pending" && <span className="pending-dot" />}
                  </span>
                  <span>
                    {s.label}
                    {s.error && <div className="inst-err">{s.error}</div>}
                  </span>
                </div>
              ))}
            </div>
            {done && !install?.ok && install?.error && <div className="field-error">{install.error}</div>}
            {done && (
              <div className="inst-actions">
                {install?.ok ? (
                  <>
                    <span className="muted small">Jarvis Code установлен в {install.dir}</span>
                    <button className="btn primary" onClick={launch}>
                      Запустить Jarvis Code
                    </button>
                  </>
                ) : (
                  <>
                    <button className="btn" onClick={() => window.close()}>
                      Закрыть
                    </button>
                    <button className="btn primary" onClick={() => (set({ install: null }), setStarted(false))}>
                      Повторить
                    </button>
                  </>
                )}
              </div>
            )}
          </>
        )}
        {!d && (
          <div className="splash inline">
            <Spark size={36} spin className="accent" />
          </div>
        )}
      </div>
      <FolderBrowserHost />
      <Toasts />
    </div>
  );
}
