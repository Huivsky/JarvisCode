import { waitForHealthyUpdate } from "./update-health";
import { atomicInstallFile, ownedInstallFiles, validateInstallDir } from "./install-files";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, DEFAULT_INSTALL_DIR, EXE_NAME, IS_WIN, LEGACY, LOCAL_APPDATA, LOCK_FILE, WEBVIEW_DIR } from "./paths";
import { ICON_ICO_BASE64 } from "./ui-assets.gen";
import { shortcutTagScript } from "./appid";
import { APP_NAME, VERSION } from "./version";
import { findNotionApp, messageBox, ps, q, setAutostart } from "./win";

const UNINSTALL_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\JarvisCode";
/**
 * Иконка ярлыков — файлом с версией в имени: Windows кэширует иконки по пути к файлу, и после обновления
 * ярлыки на рабочем столе и в «Пуске» показывали старый знак, хотя файл уже был новым.
 */
const ICON_FILE = `jarvis-code-${VERSION}.ico`;
const ICON_RE = /^jarvis-code(-[\w.-]+)?\.ico$/i;
const WT_FRAGMENT = path.join(LOCAL_APPDATA, "Microsoft", "Windows Terminal", "Fragments", "NotionCode");

export interface InstallOptions {
  dir: string;
  desktop: boolean;
  startMenu: boolean;
  path: boolean;
  /** Запускать при входе в Windows (в фоне, значок в трее). */
  autostart: boolean;
  /** Ярлык «Notion (с мостом)»: открывает Notion и запускает мост. */
  notionShortcut: boolean;
}

export interface InstallStep {
  id: string;
  label: string;
  status: "pending" | "running" | "ok" | "error";
  error?: string;
}

export function existingInstallDir(key = UNINSTALL_KEY): string | null {
  if (!IS_WIN) return null;
  try {
    const r = spawnSync("reg", ["query", key, "/v", "InstallLocation"], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const m = (r.stdout ?? "").match(/InstallLocation\s+REG_SZ\s+(.+)/);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

/** Установленный Notion Code (прежнее название, до 2.0): его заменяет Jarvis Code. */
export function legacyInstallDir(): string | null {
  if (!IS_WIN) return null;
  const dir = existingInstallDir(LEGACY.uninstallKey);
  if (dir && fs.existsSync(dir)) return dir;
  return fs.existsSync(path.join(LEGACY.installDir, LEGACY.exe)) ? LEGACY.installDir : null;
}

export function installDefaults(): InstallOptions & { existing: string | null; legacy: string | null; version: string } {
  const existing = existingInstallDir();
  const legacy = legacyInstallDir();
  return { dir: existing ?? DEFAULT_INSTALL_DIR, desktop: true, startMenu: true, path: true, autostart: false, notionShortcut: !!findNotionApp(), existing, legacy, version: VERSION };
}

const NOTION_LNK = "Notion (с мостом).lnk";

function shortcutPaths(): { desktop: string; startMenu: string; notionDesktop: string; notionStartMenu: string; legacy: string[] } {
  const r = ps("[Environment]::GetFolderPath('Desktop'); [Environment]::GetFolderPath('Programs')");
  const [d, p] = r.out.trim().split(/\r?\n/);
  if (!r.ok || !d || !p || !path.isAbsolute(d) || !path.isAbsolute(p)) throw new Error("Windows не вернула папки ярлыков: " + (r.err || r.out));
  return {
    desktop: path.join(d || "", `${APP_NAME}.lnk`),
    startMenu: path.join(p || "", `${APP_NAME}.lnk`),
    notionDesktop: path.join(d || "", NOTION_LNK),
    notionStartMenu: path.join(p || "", NOTION_LNK),
    legacy: d || p ? [path.join(d || "", LEGACY.lnk), path.join(p || "", LEGACY.lnk)] : [],
  };
}

function sleep(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Останавливает запущенные копии (Notion Code, старую консоль 0.2.x и приложение) из папок установки. */
async function stopRunning(dir: string, legacyDir: string | null) {
  // сначала просим работающее приложение закрыться само (оно остановит туннель ngrok)
  try {
    const lock = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8")) as { port: number; token: string; pid: number };
    if (lock.pid !== process.pid) {
      await fetch(`http://127.0.0.1:${lock.port}/api/quit`, { method: "POST", headers: { "x-nc-token": lock.token }, signal: AbortSignal.timeout(2000) }).catch(() => {});
      await new Promise((r) => setTimeout(r, 1500));
    }
  } catch {}
  const self = path.resolve(process.execPath).toLowerCase();
  const exes = [dir, legacyDir]
    .filter((d): d is string => !!d)
    .flatMap((d) => ["notion-code.exe", LEGACY.exe, EXE_NAME].map((n) => path.join(d, n)))
    .filter((p) => path.resolve(p).toLowerCase() !== self);
  ps(`$list=@(${exes.map(q).join(",")}); Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and ($list -contains $_.Path) } | Stop-Process -Force -ErrorAction SilentlyContinue`);
}

function copySelf(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, EXE_NAME);
  if (path.resolve(process.execPath).toLowerCase() !== path.resolve(target).toLowerCase()) {
    let err: unknown;
    for (let i = 0; i < 12; i++) {
      try {
        atomicInstallFile(process.execPath, target);
        err = undefined;
        break;
      } catch (e) {
        err = e;
        sleep(500);
      }
    }
    if (err) throw new Error(`Не удалось скопировать ${EXE_NAME} — закройте Jarvis Code и повторите. ${(err as Error).message}`);
  }
  fs.writeFileSync(path.join(dir, ICON_FILE), Buffer.from(ICON_ICO_BASE64, "base64"));
  // команда для терминала: jarvis [папка] (и длинный вариант jarvis-code)
  const cmd = `@echo off\r\nstart "" "%~dp0${EXE_NAME}" %*\r\n`;
  for (const n of ["jarvis.cmd", "jarvis-code.cmd"]) fs.writeFileSync(path.join(dir, n), cmd);
}

/** Убирает остатки консольной версии 0.2.x и Notion Code (прежнее название приложения). */
function cleanupLegacy(dir: string, legacyDir: string | null) {
  for (const f of ["notion-code.exe", "Notion Code.cmd", LEGACY.exe, "notion-code.ico", "notion-code.cmd"]) {
    try {
      fs.rmSync(path.join(dir, f), { force: true });
    } catch {}
  }
  try {
    fs.rmSync(WT_FRAGMENT, { recursive: true, force: true });
  } catch {}
  // Notion Code → Jarvis Code: старая папка, ярлыки, PATH, автозапуск и запись в «Приложениях»
  const oldDir = legacyDir && path.resolve(legacyDir).toLowerCase() !== path.resolve(dir).toLowerCase() ? legacyDir : null;
  if (oldDir) {
    for (const f of [LEGACY.exe, "notion-code.exe", "notion-code.ico", "notion-code.cmd", "Notion Code.cmd"]) {
      try {
        fs.rmSync(path.join(oldDir, f), { force: true });
      } catch {}
    }
    try {
      if (fs.readdirSync(oldDir).length === 0) fs.rmdirSync(oldDir);
    } catch {}
    removeFromPath(oldDir);
  }
  try {
    const sp = shortcutPaths();
    // ярлыки «Notion (с мостом)» вели на старый exe — пересоздаются на шаге «Ярлыки», если выбраны
    for (const p of [...sp.legacy, ...(oldDir ? [sp.notionDesktop, sp.notionStartMenu] : [])]) fs.rmSync(p, { force: true });
  } catch {}
  spawnSync("reg", ["delete", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", LEGACY.runValue, "/f"], { windowsHide: true, stdio: "ignore", timeout: 5000 });
  spawnSync("reg", ["delete", LEGACY.uninstallKey, "/f"], { windowsHide: true, stdio: "ignore", timeout: 5000 });
}

function createShortcuts(o: InstallOptions) {
  if (!o.desktop && !o.startMenu && !o.notionShortcut) return;
  const sp = shortcutPaths();
  const target = path.join(o.dir, EXE_NAME);
  const one = (lnk: string) =>
    `$s=$w.CreateShortcut(${q(lnk)}); $s.TargetPath=${q(target)}; $s.WorkingDirectory=${q(o.dir)}; $s.IconLocation=${q(path.join(o.dir, ICON_FILE) + ",0")}; $s.Description='Jarvis Code — ИИ-агент Notion с доступом к ПК'; $s.Save();`;
  const notionIcon = findNotionApp();
  const notion = (lnk: string) =>
    `$s=$w.CreateShortcut(${q(lnk)}); $s.TargetPath=${q(target)}; $s.Arguments='--notion'; $s.WorkingDirectory=${q(o.dir)}; $s.IconLocation=${q((notionIcon ?? path.join(o.dir, ICON_FILE)) + ",0")}; $s.Description='Notion + мост Jarvis Code к этому ПК (в фоне, без окон консоли)'; $s.Save();`;
  let script = "$w=New-Object -ComObject WScript.Shell;";
  if (o.desktop) script += one(sp.desktop);
  if (o.startMenu) script += one(sp.startMenu);
  if (o.notionShortcut) script += notion(sp.notionDesktop) + notion(sp.notionStartMenu);
  const r = ps(script);
  if (!r.ok) throw new Error(r.err || "PowerShell error");
  refreshIcons(o.dir);
}

export function iconScript(lnks: string[], icon: string): string {
  // свою иконку меняем только там, где она наша (у «Notion (с мостом)» — иконка Notion)
  const script =
    "$w=New-Object -ComObject WScript.Shell;" +
    lnks.map((l) => `$s=$w.CreateShortcut(${q(l)}); if(-not $s.IconLocation -or $s.IconLocation -like '*jarvis-code*.ico*' -or $s.IconLocation -like '*JarvisCode.exe*'){ $s.IconLocation=${q(icon + ",0")}; $s.Save() };`).join("") +
    "try { Add-Type -Namespace JC -Name Shell -MemberDefinition '[DllImport(\"shell32.dll\")] public static extern void SHChangeNotify(int e, uint f, IntPtr a, IntPtr b);'; [JC.Shell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero) } catch {}";
  return script;
}

/**
 * После обновления: ярлыки Jarvis Code — на новую иконку, старые .ico удаляются, кэш иконок Explorer
 * сбрасывается (SHChangeNotify + ie4uinit), чтобы новый знак появился сразу, без перезагрузки.
 */
export function refreshIcons(dir: string) {
  if (!IS_WIN) return;
  const sp = shortcutPaths();
  const icon = path.join(dir, ICON_FILE);
  const lnks = [sp.desktop, sp.startMenu, sp.notionDesktop, sp.notionStartMenu].filter((l) => {
    try {
      return fs.existsSync(l);
    } catch {
      return false;
    }
  });
  ps(iconScript(lnks, icon));
  // ярлыки Jarvis Code (не «Notion с мостом») — с тем же AppUserModelID, что у окна: панель задач берёт значок из них
  const own = [sp.desktop, sp.startMenu].filter((l) => lnks.includes(l));
  if (own.length) ps(shortcutTagScript(own));
  try {
    for (const f of fs.readdirSync(dir)) if (ICON_RE.test(f) && f.toLowerCase() !== ICON_FILE.toLowerCase()) fs.rmSync(path.join(dir, f), { force: true });
  } catch {}
  try {
    spawnSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "ie4uinit.exe"), ["-show"], { windowsHide: true, stdio: "ignore", timeout: 10000 });
  } catch {}
}

function removeShortcuts() {
  try {
    const sp = shortcutPaths();
    for (const p of [sp.desktop, sp.startMenu, sp.notionDesktop, sp.notionStartMenu]) fs.rmSync(p, { force: true });
  } catch {}
}

function addToPath(dir: string) {
  const result = ps(
    `$p=[Environment]::GetEnvironmentVariable('Path','User'); if(-not $p){$p=''}; $parts=$p.Split(';') | Where-Object { $_ -and ($_.TrimEnd('\\') -ne ${q(dir)}.TrimEnd('\\')) }; [Environment]::SetEnvironmentVariable('Path', (($parts + ${q(dir)}) -join ';'), 'User')`,
  );
  if (!result.ok) throw new Error(result.err || "Не удалось изменить PATH пользователя");
}

function removeFromPath(dir: string) {
  const result = ps(
    `$p=[Environment]::GetEnvironmentVariable('Path','User'); if($p){ $parts=$p.Split(';') | Where-Object { $_ -and ($_.TrimEnd('\\') -ne ${q(dir)}.TrimEnd('\\')) }; [Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User') }`,
  );
  if (!result.ok) throw new Error(result.err || "Не удалось изменить PATH пользователя");
}

function registerUninstall(dir: string) {
  const exe = path.join(dir, EXE_NAME);
  let kb = 0;
  try {
    kb = Math.round(fs.statSync(exe).size / 1024);
  } catch {}
  const add = (name: string, type: string, value: string) => {
    const result = spawnSync("reg", ["add", UNINSTALL_KEY, "/v", name, "/t", type, "/d", value, "/f"], { windowsHide: true, stdio: "ignore", timeout: 10000 });
    if (result.error || result.status !== 0) throw new Error(`Не удалось зарегистрировать ${name}: ${result.error?.message || result.status}`);
  };
  add("DisplayName", "REG_SZ", APP_NAME);
  add("DisplayVersion", "REG_SZ", VERSION);
  add("Publisher", "REG_SZ", APP_NAME);
  add("DisplayIcon", "REG_SZ", path.join(dir, ICON_FILE));
  add("InstallLocation", "REG_SZ", dir);
  add("UninstallString", "REG_SZ", `"${exe}" uninstall`);
  add("QuietUninstallString", "REG_SZ", `"${exe}" uninstall --quiet`);
  add("NoModify", "REG_DWORD", "1");
  add("NoRepair", "REG_DWORD", "1");
  add("EstimatedSize", "REG_DWORD", String(kb));
}

export async function runInstall(o: InstallOptions, onStep: (steps: InstallStep[]) => void): Promise<boolean> {
  o.dir = validateInstallDir(o.dir);
  const legacyDir = legacyInstallDir();
  const steps: InstallStep[] = [
    { id: "stop", label: "Закрытие запущенных копий", status: "pending" },
    { id: "copy", label: "Копирование файлов", status: "pending" },
    { id: "legacy", label: legacyDir ? "Перенос с Notion Code: удаление старой версии" : "Удаление старых версий", status: "pending" },
    ...(o.desktop || o.startMenu || o.notionShortcut ? [{ id: "shortcuts", label: "Ярлыки", status: "pending" as const }] : []),
    ...(o.path ? [{ id: "path", label: "Команда jarvis в терминале", status: "pending" as const }] : []),
    { id: "autostart", label: o.autostart ? "Автозапуск при входе в Windows" : "Отключение автозапуска", status: "pending" },
    { id: "register", label: "Запись в «Приложения»", status: "pending" },
  ];
  const actions: Record<string, () => void | Promise<void>> = {
    stop: () => stopRunning(o.dir, legacyDir),
    autostart: () => {
      setAutostart(o.autostart, path.join(o.dir, EXE_NAME));
    },
    copy: () => copySelf(o.dir),
    legacy: () => cleanupLegacy(o.dir, legacyDir),
    shortcuts: () => createShortcuts(o),
    path: () => addToPath(o.dir),
    register: () => registerUninstall(o.dir),
  };
  let ok = true;
  for (const s of steps) {
    s.status = "running";
    onStep(steps.map((x) => ({ ...x })));
    await new Promise((r) => setTimeout(r, 120));
    try {
      if (IS_WIN) await actions[s.id]();
      else await new Promise((r) => setTimeout(r, 250)); // предпросмотр вне Windows
      s.status = "ok";
    } catch (e) {
      s.status = "error";
      s.error = (e as Error).message;
      ok = false; // Never report success when a required installation step failed.
    }
    onStep(steps.map((x) => ({ ...x })));
    if (!ok) break;
  }
  return ok;
}

export function launchInstalled(dir: string) {
  const exe = path.join(dir, EXE_NAME);
  if (!IS_WIN || !fs.existsSync(exe)) return;
  spawn(exe, ["run"], { detached: true, stdio: "ignore", cwd: dir }).unref();
}

export async function runUninstall(quiet: boolean) {
  const dir = existingInstallDir() ?? path.dirname(process.execPath);
  let purge = false;
  if (!quiet) {
    if (messageBox(`Удалить ${APP_NAME}?\n\nПапка: ${dir}`, "YesNo", "Question") !== "Yes") return;
    purge = messageBox(`Удалить также настройки, токен и историю чатов?\n\n${DATA_DIR}`, "YesNo", "Question") === "Yes";
  }
  removeShortcuts();
  try { removeFromPath(dir); } catch {}
  setAutostart(false);
  try {
    fs.rmSync(WT_FRAGMENT, { recursive: true, force: true });
  } catch {}
  spawnSync("reg", ["delete", UNINSTALL_KEY, "/f"], { windowsHide: true, stdio: "ignore" });
  if (purge) {
    for (const p of [DATA_DIR, path.dirname(WEBVIEW_DIR)]) {
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch {}
    }
  }
  const files = ownedInstallFiles(dir).map((name) => path.join(dir, name));
  const cleanup = `Start-Sleep -Seconds 3; $files=@(${files.map(q).join(",")}); foreach($f in $files){ for($i=0;$i -lt 10;$i++){ try { Remove-Item -LiteralPath $f -Force -ErrorAction Stop; break } catch { Start-Sleep -Milliseconds 500 } } }; try { [IO.Directory]::Delete(${q(dir)}, $false) } catch {}`;
  spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(cleanup, "utf16le").toString("base64")], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  if (!quiet) messageBox(`${APP_NAME} удалён.${purge ? "" : `\nНастройки сохранены в ${DATA_DIR}.`}`);
}
// ───── обновление поверх установленной версии (запускается новой версией: `JarvisCodeSetup.exe update`) ─────

function alive(pid: number): boolean {
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EPERM") return true;
  }
  if (!IS_WIN) return false;
  const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
  return new RegExp(`\\b${pid}\\b`).test(r.stdout ?? "");
}

function updateLog(line: string) {
  try {
    const dir = path.join(DATA_DIR, "updates");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "update.log"), `${new Date().toISOString()} ${VERSION} ${line}\n`);
  } catch {}
}

/**
 * Тихое обновление: ждёт выхода старой версии, заменяет JarvisCode.exe (со страховочной копией),
 * обновляет запись в «Приложениях» и запускает приложение снова. Настройки, ключ моста и чаты
 * лежат в папке данных и не трогаются — адрес моста в Notion остаётся прежним.
 */
export async function runSelfUpdate(o: { dir?: string; pid?: number; background?: boolean }): Promise<boolean> {
  const dir = o.dir && path.isAbsolute(o.dir) ? o.dir : (existingInstallDir() ?? DEFAULT_INSTALL_DIR);
  const target = path.join(dir, EXE_NAME);
  const backup = path.join(dir, "JarvisCode.old.exe");
  updateLog(`start dir=${dir} pid=${o.pid ?? 0}`);
  if (o.pid) {
    for (let i = 0; i < 60 && alive(o.pid); i++) await new Promise((r) => setTimeout(r, 500));
    if (alive(o.pid)) {
      try {
        process.kill(o.pid);
      } catch {}
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  let ok = true;
  let moved = false;
  // exe скопирован целиком? (иконка или ярлыки могут не записаться — это не повод откатываться)
  const complete = () => {
    try {
      return fs.statSync(target).size === fs.statSync(process.execPath).size;
    } catch {
      return false;
    }
  };
  try {
    if (!IS_WIN) throw new Error("обновление поверх установки работает только в Windows");
    fs.rmSync(backup, { force: true });
    if (fs.existsSync(target)) {
      fs.renameSync(target, backup);
      moved = true;
    }
    copySelf(dir);
  } catch (e) {
    updateLog(`error ${(e as Error).message}`);
    if (!IS_WIN || !complete()) {
      ok = false;
      // недописанный файл убираем и возвращаем прежнюю версию
      try {
        if (moved && fs.existsSync(backup)) {
          fs.rmSync(target, { force: true });
          fs.renameSync(backup, target);
        }
      } catch {}
      if (IS_WIN) messageBox(`Не удалось обновить ${APP_NAME}: ${(e as Error).message}\n\nЗапускаю прежнюю версию.`, "OK", "Warning");
    }
  }
  if (ok) {
    try {
      registerUninstall(dir);
    } catch (e) {
      updateLog(`uninstall entry ${(e as Error).message}`);
    }
    try {
      refreshIcons(dir);
    } catch (e) {
      updateLog(`icons ${(e as Error).message}`);
    }
    updateLog("ok");
  }
  if (IS_WIN && fs.existsSync(target)) {
    const child = spawn(target, ["run", ...(o.background ? ["--background"] : [])], { detached: true, stdio: "ignore", cwd: dir });
    let launchError = false; child.on("error", () => { launchError = true; }); child.unref();
    if (ok) {
      const healthy = await waitForHealthyUpdate(async () => {
        if (launchError || !child.pid) return false;
        const lock = JSON.parse(fs.readFileSync(LOCK_FILE,"utf8"));
        if (lock.pid !== child.pid || !Number.isInteger(lock.port) || lock.port < 1 || lock.port > 65535 || typeof lock.token !== "string") return false;
        const result = await fetch(`http://127.0.0.1:${lock.port}/api/ping`, { headers: { authorization: `Bearer ${lock.token}` }, signal: AbortSignal.timeout(1200) });
        const info = await result.json() as {version?:string;mode?:string};
        return result.ok && info.version === VERSION && info.mode === "app";
      });
      if (!healthy) {
        ok = false; updateLog("health failed; rolling back executable");
        try {
          if(child.pid && alive(child.pid)) { spawnSync("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore",timeout:5000}); await new Promise(r=>setTimeout(r,700)); }
          if(moved && fs.existsSync(backup)) {
            fs.renameSync(target, target + ".failed-" + Date.now()); fs.renameSync(backup,target);
            spawn(target,["run",...(o.background?["--background"]:[])],{detached:true,stdio:"ignore",cwd:dir}).on("error",()=>{}).unref();
          }
        } catch(e) { updateLog("rollback failed: " + (e as Error).message); }
        messageBox("Новая версия не прошла проверку запуска. Выполнена попытка возврата к прежнему EXE. Данные и внешние действия автоматически не откатываются.","OK","Warning");
      } else updateLog("health ok; previous executable retained for recovery");
    }
  }
  return ok;
}
