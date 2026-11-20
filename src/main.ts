import fs from "node:fs";
import path from "node:path";
import { loadConfig, rememberProject, saveConfig } from "./config";
import { installCrashHandlers, recordCrash, setCrashConfig } from "./crash";
import { runSelfUpdate, runUninstall } from "./installer";
import { DATA_DIR, IS_WIN, LOCK_FILE } from "./paths";
import { startServer } from "./server";
import { killAllJobs } from "./tools";
import { Tray, type TrayCommand } from "./tray";
import { VERSION } from "./version";
import { SETUP_USER_MODEL_ID } from "./appid";
import { messageBox, openAppWindow, openNotionApp } from "./win";

const PREFERRED_PORT = 47821;
const INSTALLER_PORT = 47822;

/** В собранном exe нет консоли — пишем вывод в файл. */
function setupLogging() {
  const compiled = !process.execPath.toLowerCase().match(/[\\/]bun(\.exe)?$/);
  if (!compiled || process.env.NC_CONSOLE) return;
  const logFile = path.join(DATA_DIR, "app.log");
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 2_000_000) fs.renameSync(logFile, logFile + ".old");
  } catch {}
  const write = (level: string, args: unknown[]) => {
    try {
      fs.appendFileSync(logFile, `${new Date().toISOString()} ${level} ${args.map((a) => (a instanceof Error ? a.stack : typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`);
    } catch {}
  };
  console.log = (...a: unknown[]) => write("INFO", a);
  console.info = console.log;
  console.warn = (...a: unknown[]) => write("WARN", a);
  console.error = (...a: unknown[]) => write("ERROR", a);
}

interface Lock {
  port: number;
  token: string;
  pid: number;
}

async function existingInstance(): Promise<Lock | null> {
  try {
    const lock = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8")) as Lock;
    const ctl = AbortSignal.timeout(1500);
    const r = await fetch(`http://127.0.0.1:${lock.port}/api/ping`, { headers: { "x-nc-token": lock.token }, signal: ctl });
    const info = r.ok ? ((await r.json()) as { mode?: string; version?: string }) : null;
    if (info?.mode !== "app") return null;
    // запущен Notion Code 1.x (прежнее название) — просим его закрыться, дальше работает Jarvis Code
    if (Number(String(info.version ?? "0").split(".")[0]) < 2) {
      await fetch(`http://127.0.0.1:${lock.port}/api/quit`, { method: "POST", headers: { "x-nc-token": lock.token }, signal: AbortSignal.timeout(2000) }).catch(() => {});
      await new Promise((res) => setTimeout(res, 1800));
      return null;
    }
    return lock;
  } catch {}
  return null;
}

function parseArgs(argv: string[]) {
  const a: {
    cmd?: string;
    project?: string;
    headless?: boolean;
    port?: number;
    quiet?: boolean;
    noWindow?: boolean;
    background?: boolean;
    notion?: boolean;
    dir?: string;
    pid?: number;
  } = {};
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "install" || v === "uninstall" || v === "run" || v === "update") a.cmd = v;
    else if (v === "--version" || v === "-v") a.cmd = "version";
    else if (v === "--headless") a.headless = true;
    else if (v === "--no-window") a.noWindow = true;
    else if (v === "--background" || v === "--tray") a.background = true;
    else if (v === "--notion") a.notion = true;
    else if (v === "--quiet") a.quiet = true;
    else if (v === "--port") a.port = Number(argv[++i]);
    else if (v === "--dir") a.dir = argv[++i];
    else if (v === "--pid") a.pid = Number(argv[++i]) || undefined;
    else if (v === "--project" || v === "-p") a.project = argv[++i];
    else if (!v.startsWith("-")) a.project = v;
  }
  return a;
}

function tryStart(opts: Parameters<typeof startServer>[0], preferred: number) {
  try {
    return startServer({ ...opts, port: preferred });
  } catch {
    return startServer({ ...opts, port: 0 });
  }
}

async function main() {
  setupLogging();
  installCrashHandlers(() => killAllJobs());
  const args = parseArgs(process.argv.slice(2));
  const exeName = path.basename(process.execPath).toLowerCase();

  if (args.cmd === "version") {
    console.log(VERSION);
    return;
  }
  if (args.cmd === "uninstall") {
    await runUninstall(!!args.quiet);
    process.exit(0);
  }
  if (args.cmd === "update") {
    const ok = await runSelfUpdate({ dir: args.dir, pid: args.pid, background: args.background });
    process.exit(ok ? 0 : 1);
  }

  const cfg = loadConfig();
  setCrashConfig(() => cfg);
  const isInstaller = args.cmd === "install" || (/setup/.test(exeName) && args.cmd !== "run");

  if (isInstaller) {
    const srv = tryStart({ cfg, mode: "installer", onIdle: () => shutdown(0) }, INSTALLER_PORT);
    const shutdown = (code: number) => {
      srv.stop();
      process.exit(code);
    };
    const url = `${srv.url}#t=${srv.token}&view=install`;
    if (args.headless || args.noWindow) console.log(url);
    else openAppWindow(url, { w: 980, h: 700 }, { appId: SETUP_USER_MODEL_ID, pinnable: false });
    return;
  }

  const project = args.project ? path.resolve(args.project) : undefined;
  if (project && !fs.existsSync(project)) {
    messageBox(`Папка не найдена: ${project}`, "OK", "Warning");
  }
  const validProject = project && fs.existsSync(project) ? project : undefined;

  // Одна копия приложения: повторный запуск открывает ещё одно окно.
  if (!args.headless) {
    const lock = await existingInstance();
    if (lock) {
      const call = (p: string, body: unknown) =>
        fetch(`http://127.0.0.1:${lock.port}/api/${p}`, {
          method: "POST",
          headers: { "x-nc-token": lock.token, "content-type": "application/json" },
          body: JSON.stringify(body),
        }).catch(() => {});
      if (args.notion) await call("notion/open", {});
      else if (!args.background) await call("window", { project: validProject });
      process.exit(0);
    }
  }

  if (validProject) {
    rememberProject(cfg, validProject);
    saveConfig(cfg);
  }

  const background = !!(args.background || args.notion);
  let exiting = false;
  let tray: Tray | null = null;
  let hintShown = false;
  let attentionChat = "";
  /** Оставаться в трее без окна: запуск в фоне или включён мост. */
  const keepAlive = () => !args.headless && !!tray && (background || cfg.bridge.enabled);
  const shutdown = (code: number) => {
    if (exiting) return;
    exiting = true;
    try {
      tray?.stop();
    } catch {}
    try {
      srv.stop();
    } catch {}
    killAllJobs();
    try {
      const lock = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8")) as Lock;
      if (lock.pid === process.pid) fs.rmSync(LOCK_FILE, { force: true });
    } catch {}
    process.exit(code);
  };

  const open = (hash = "") => openAppWindow(`${srv.url}#t=${srv.token}${hash ? "&" + hash.replace(/^#/, "") : ""}`);
  const srv = tryStart(
    {
      cfg,
      mode: "app",
      port: args.port,
      initialProject: validProject,
      onIdle: args.headless
        ? undefined
        : () => {
            if (keepAlive()) {
              if (!hintShown && !background) {
                hintShown = true;
                tray?.balloon("Jarvis Code работает в фоне", "Мост для агента в Notion включён. Открыть или выйти — через значок в трее.");
              }
              return;
            }
            shutdown(0);
          },
      onOpenWindow: (hash) => open(hash),
      onQuit: () => shutdown(0),
      onBackgroundChange: () => {
        updateTray();
        if (srv.clients() === 0 && !keepAlive() && !args.headless) setTimeout(() => srv.clients() === 0 && !keepAlive() && shutdown(0), 4000);
      },
    },
    args.port ?? PREFERRED_PORT,
  );
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ port: srv.port ?? 0, token: srv.token, pid: process.pid } satisfies Lock));

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  // ── значок в трее ──
  const updateTray = () => {
    if (!tray) return;
    const b = srv.bridge.state();
    const t = b.tunnel;
    const st = !b.enabled
      ? "выключен"
      : b.error
        ? "ошибка порта"
        : t.status === "online"
          ? t.check && !t.check.ok
            ? "адрес не отвечает"
            : b.connected
              ? "работает"
              : "ждёт подключения в Notion"
          : t.status === "starting"
            ? "запускается…"
            : t.status === "error"
              ? "ошибка туннеля"
              : "выключен";
    tray.tip(`Jarvis Code — мост: ${st}`);
    tray.text("status", `Мост: ${st}${b.calls ? ` · вызовов: ${b.calls}` : ""}`);
    tray.check("bridge", b.enabled);
    tray.enable("copy", !!b.mcpUrl);
    tray.check("autostart", srv.autostart);
  };
  const onTray = (c: TrayCommand) => {
    switch (c) {
      case "open":
        if (srv.clients() === 0) open();
        else srv.bus.emit({ type: "focus" });
        break;
      case "balloon":
        open(attentionChat ? `chat=${attentionChat}` : "");
        break;
      case "notion":
        openNotionApp();
        break;
      case "bridge":
        cfg.bridge.enabled = !cfg.bridge.enabled;
        saveConfig(cfg);
        srv.bridge.apply().finally(() => {
          srv.pushState();
          updateTray();
          if (srv.clients() === 0 && !keepAlive()) shutdown(0);
        });
        break;
      case "copy": {
        const u = srv.bridge.state().mcpUrl;
        if (u) {
          tray?.copy(u);
          tray?.balloon("Адрес MCP скопирован", "Вставьте его в Notion: настройки агента → Tools & Access → Add connection → Custom MCP server.");
        }
        break;
      }
      case "autostart":
        srv.setAutostart(!srv.autostart);
        updateTray();
        break;
      case "exit":
        shutdown(0);
        break;
    }
  };
  if (IS_WIN && !args.headless) {
    tray = new Tray(onTray);
    tray.start();
    srv.bridge.onChange = () => updateTray();
    updateTray();
    srv.bus.tap((e) => {
      if (srv.clients() > 0 || !tray) return;
      if (e.type === "attention") {
        attentionChat = String(e.chatId ?? "");
        tray.balloon(String(e.title ?? "Нужно подтверждение"), String(e.body ?? ""));
      } else if (e.type === "done" && e.chatId !== "bridge") {
        attentionChat = String(e.chatId ?? "");
        tray.balloon("Агент ответил", String(e.title ?? ""));
      }
    });
  }

  if (args.notion) openNotionApp();

  if (args.headless || args.noWindow || background) {
    if (args.headless || args.noWindow) console.log(`Jarvis Code ${VERSION}: ${srv.url}#t=${srv.token}`);
  } else {
    open();
    // если окно так и не подключилось (нет браузера) — не висим в фоне вечно
    setTimeout(() => {
      if (srv.clients() === 0 && !keepAlive()) {
        if (IS_WIN) messageBox("Не удалось открыть окно Jarvis Code. Установите Microsoft Edge или Google Chrome и запустите программу снова.", "OK", "Warning");
        shutdown(1);
      }
    }, 60_000);
  }
}

main().catch((e) => {
  console.error(e);
  recordCrash(e, "fatal");
  if (IS_WIN) messageBox(`Jarvis Code не запустился:\n${e?.message ?? e}`, "OK", "Error");
  process.exit(1);
});