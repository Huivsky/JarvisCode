import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const IS_WIN = process.platform === "win32";

/** ~/.notion-code — та же папка данных, что и у Notion Code (настройки, ключ моста и чаты переходят в Jarvis Code). */
export const DATA_DIR = process.env.JARVIS_CODE_HOME || process.env.NOTION_CODE_HOME || path.join(os.homedir(), ".notion-code");
export const CONFIG_FILE = path.join(DATA_DIR, "config.json");
export const AUDIT_LOG = path.join(DATA_DIR, "audit.log");
export const LOCK_FILE = path.join(DATA_DIR, "desktop.lock");

/**
 * Хранилище — всё объёмное: чаты, контекст, вложения, снимки экрана, копии файлов до правок.
 * По умолчанию — папка данных; в «Настройки → Хранилище» можно выбрать любую (например, большой диск).
 * Настройки, журналы и ключ моста всегда остаются в папке данных.
 */
export const STORE_SUBDIRS = ["chats", "context", "uploads", "screenshots", "history"] as const;

/** Папка хранилища из config.json (читается до загрузки настроек: пути нужны модулям сразу). */
function savedStore(): { dir: string; problem: string } {
  let want = "";
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    if (typeof c?.storageDir === "string") want = c.storageDir.trim();
  } catch {}
  if (!want || !path.isAbsolute(want)) return { dir: DATA_DIR, problem: "" };
  try {
    fs.mkdirSync(want, { recursive: true });
    return { dir: want, problem: "" };
  } catch (e: any) {
    // диск отключён или нет доступа — работаем во временной папке данных и показываем предупреждение
    return { dir: DATA_DIR, problem: `Папка хранилища недоступна: ${want} (${e?.code ?? e?.message ?? e}). Подключите диск и перезапустите Jarvis Code.` };
  }
}

const initial = savedStore();
export let STORE_DIR = initial.dir;
/** Почему не удалось открыть выбранную папку хранилища ("" — всё в порядке). */
export let STORE_PROBLEM = initial.problem;
export let CHATS_DIR = path.join(STORE_DIR, "chats");
export let CONTEXT_DIR = path.join(STORE_DIR, "context");
export let UPLOADS_DIR = path.join(STORE_DIR, "uploads");
export let SHOTS_DIR = path.join(STORE_DIR, "screenshots");
export let HISTORY_DIR = path.join(STORE_DIR, "history");

/** Переключает хранилище (после переноса данных). Модули читают пути при каждом обращении. */
export function setStoreDir(dir: string) {
  STORE_DIR = dir;
  STORE_PROBLEM = "";
  CHATS_DIR = path.join(dir, "chats");
  CONTEXT_DIR = path.join(dir, "context");
  UPLOADS_DIR = path.join(dir, "uploads");
  SHOTS_DIR = path.join(dir, "screenshots");
  HISTORY_DIR = path.join(dir, "history");
}

export const LOCAL_APPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
export const DEFAULT_INSTALL_DIR = path.join(LOCAL_APPDATA, "Programs", "JarvisCode");
/** Отдельный профиль браузера для окна приложения. */
export const WEBVIEW_DIR = path.join(LOCAL_APPDATA, "JarvisCode", "WebView");
export const EXE_NAME = "JarvisCode.exe";

/** Прежнее название приложения (до 2.0) — для переноса установки. */
export const LEGACY = {
  installDir: path.join(LOCAL_APPDATA, "Programs", "NotionCode"),
  appDataDir: path.join(LOCAL_APPDATA, "NotionCode"),
  exe: "NotionCode.exe",
  uninstallKey: "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\NotionCode",
  runValue: "NotionCode",
  lnk: "Notion Code.lnk",
};
