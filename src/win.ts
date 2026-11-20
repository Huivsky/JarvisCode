import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { APP_USER_MODEL_ID, appIconFile, resetIconCache, windowTagScript } from "./appid";
import { EXE_NAME, IS_WIN, LOCAL_APPDATA, WEBVIEW_DIR } from "./paths";
import { ICON_ICO_BASE64 } from "./ui-assets.gen";

/** PowerShell через -EncodedCommand (без проблем с кавычками и кодировкой). */
export function ps(script: string, timeoutMs = 60_000): { ok: boolean; out: string; err: string } {
  if (!IS_WIN) return { ok: false, out: "", err: "not windows" };
  const enc = Buffer.from(
    `$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;${script}`,
    "utf16le",
  ).toString("base64");
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", enc], {
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

/** Асинхронный вариант — для диалогов, чтобы не блокировать сервер. */
export function psAsync(script: string, sta = false): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    if (!IS_WIN) return resolve({ ok: false, out: "" });
    const enc = Buffer.from(`[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;${script}`, "utf16le").toString("base64");
    const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...(sta ? ["-STA"] : []), "-EncodedCommand", enc];
    const child = spawn("powershell.exe", args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (out += d));
    child.on("close", (code) => resolve({ ok: code === 0, out: out.trim() }));
    child.on("error", () => resolve({ ok: false, out: "" }));
  });
}

export const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Текст в буфер обмена Windows (через временный файл — без ограничений на длину и кодировку). */
export async function setClipboard(text: string): Promise<boolean> {
  if (!IS_WIN) return false;
  const f = path.join(os.tmpdir(), `nc-clip-${process.pid}-${Date.now()}.txt`);
  try {
    fs.writeFileSync(f, text, "utf8");
    const r = await psAsync(`Set-Clipboard -Value ([IO.File]::ReadAllText(${q(f)}, [Text.Encoding]::UTF8))`, true);
    return r.ok;
  } catch {
    return false;
  } finally {
    try {
      fs.unlinkSync(f);
    } catch {}
  }
}

export function messageBox(text: string, buttons: "OK" | "YesNo" = "OK", icon: "Information" | "Warning" | "Error" | "Question" = "Information"): string {
  if (!IS_WIN) {
    console.log(text);
    return "OK";
  }
  const r = ps(
    `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show(${q(text)}, 'Jarvis Code', '${buttons}', '${icon}')`,
    0,
  );
  return r.out;
}

/** Скрипт PowerShell для диалога выбора (отдельно — чтобы тест мог проверить синтаксис). */
export function pickScript(kind: "folder" | "files", init: string): string {
  // Диалог без видимого владельца открывался ПОД окном Jarvis Code. Владелец — невидимое окно поверх всех
  // (TopMost, прозрачное, 1×1 в центре экрана), показанное и активированное: диалог сверху и в фокусе.
  const owner =
    "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; [System.Windows.Forms.Application]::EnableVisualStyles(); " +
    "$f=New-Object System.Windows.Forms.Form; $f.TopMost=$true; $f.ShowInTaskbar=$false; $f.FormBorderStyle='None'; $f.Opacity=0; $f.StartPosition='Manual'; " +
    "$wa=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea; $f.Size=New-Object System.Drawing.Size(1,1); " +
    "$f.Location=New-Object System.Drawing.Point([int]($wa.X+$wa.Width/2),[int]($wa.Y+$wa.Height/3)); $f.Show(); $f.Activate(); [System.Windows.Forms.Application]::DoEvents(); ";
  const script =
    kind === "folder"
      ? `${owner}$d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description='Выберите папку'; $d.ShowNewFolderButton=$true; ${init ? `$d.SelectedPath=${q(init)};` : ""} $r=$d.ShowDialog($f); $f.Close(); if($r -eq 'OK'){ $d.SelectedPath }`
      : `${owner}$d=New-Object System.Windows.Forms.OpenFileDialog; $d.Multiselect=$true; $d.Title='Прикрепить файлы'; ${init ? `$d.InitialDirectory=${q(init)};` : ""} $r=$d.ShowDialog($f); $f.Close(); if($r -eq 'OK'){ $d.FileNames -join [char]10 }`;
  return script;
}

/** Нативный диалог выбора папки или файлов. */
export async function pickDialog(kind: "folder" | "files", start?: string): Promise<string[]> {
  if (!IS_WIN) return [];
  const init = start && fs.existsSync(start) ? start : "";
  const script = pickScript(kind, init);
  const r = await psAsync(script, true);
  return r.out ? r.out.split(/\r?\n/).filter(Boolean) : [];
}

export function openExternal(target: string): void {
  try {
    const c = IS_WIN
      ? spawn("cmd.exe", ["/c", "start", "", target.replace(/&/g, "^&")], { detached: true, stdio: "ignore", windowsHide: true })
      : spawn("xdg-open", [target], { detached: true, stdio: "ignore" });
    c.on("error", () => {});
    c.unref();
  } catch {}
}

export function revealInExplorer(p: string): void {
  if (IS_WIN) spawn("explorer.exe", [fs.existsSync(p) && fs.statSync(p).isFile() ? `/select,${p}` : p], { detached: true, stdio: "ignore" }).unref();
  else openExternal(p);
}

function regDefault(key: string): string | null {
  try {
    const r = spawnSync("reg", ["query", key, "/ve"], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const m = (r.stdout ?? "").match(/REG_SZ\s+(.+)/);
    return m ? m[1].trim().replace(/^"|"$/g, "") : null;
  } catch {
    return null;
  }
}

/** Edge есть в каждой Windows 10/11; Chrome и Brave — запасные варианты. */
export function findBrowser(): string | null {
  if (process.env.NC_BROWSER && fs.existsSync(process.env.NC_BROWSER)) return process.env.NC_BROWSER;
  if (!IS_WIN) return null;
  const pf = process.env["ProgramFiles"] ?? "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const candidates = [
    path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(LOCAL_APPDATA, "Microsoft", "Edge", "Application", "msedge.exe"),
    regDefault("HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe"),
    path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(LOCAL_APPDATA, "Google", "Chrome", "Application", "chrome.exe"),
    regDefault("HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe"),
    path.join(pf, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
  ];
  return candidates.find((c) => !!c && fs.existsSync(c)) ?? null;
}

export interface AppWindowOptions {
  /** AppUserModelID окна (по умолчанию — JarvisCode.App, как у ярлыков). */
  appId?: string;
  /** Можно ли закрепить окно на панели задач (у окна установщика — нет). */
  pinnable?: boolean;
}

/** Команда перезапуска для закреплённого значка: установленный JarvisCode.exe (или bun + main.ts при разработке). */
function relaunchCommand(): string {
  if (isCompiled()) return path.basename(process.execPath).toLowerCase() === EXE_NAME.toLowerCase() ? `"${process.execPath}"` : "";
  const main = process.argv[1];
  return main ? `"${process.execPath}" "${path.resolve(main)}"` : "";
}

/**
 * Открывает интерфейс отдельным окном приложения (Edge/Chrome в режиме --app,
 * собственный профиль — без вкладок, адресной строки и расширений).
 * Окну задаётся свой AppUserModelID (см. appid.ts): на панели задач — «Jarvis Code» со своим значком,
 * а не «Microsoft Edge» с закэшированным favicon.
 */
export function openAppWindow(url: string, size = { w: 1280, h: 840 }, o: AppWindowOptions = {}): "app" | "browser" {
  const browser = findBrowser();
  if (browser) {
    try {
      fs.mkdirSync(WEBVIEW_DIR, { recursive: true });
      // старый значок (2.0) лежит в профиле окна — сбрасываем кэш один раз на версию, до запуска браузера
      resetIconCache(WEBVIEW_DIR);
      spawn(
        browser,
        [
          `--app=${url}`,
          `--user-data-dir=${WEBVIEW_DIR}`,
          `--window-size=${size.w},${size.h}`,
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-sync",
          "--disable-extensions",
          "--disable-component-update",
          "--hide-crash-restore-bubble",
          "--disable-features=Translate,msEdgeSidebarV2,msHubApps,msImplicitSignin,msEdgeShoppingAssistant,EdgeCollections,msUndersideButton",
        ],
        { detached: true, stdio: "ignore", windowsHide: false },
      ).unref();
      if (IS_WIN) {
        const icon = appIconFile(path.dirname(WEBVIEW_DIR), ICON_ICO_BASE64);
        void psAsync(
          windowTagScript({
            profileDir: WEBVIEW_DIR,
            browserExe: path.basename(browser),
            appId: o.appId ?? APP_USER_MODEL_ID,
            relaunch: o.pinnable === false ? "" : relaunchCommand(),
            name: "Jarvis Code",
            icon,
          }),
        );
      }
      return "app";
    } catch {
      /* запасной вариант ниже */
    }
  }
  openExternal(url);
  return "browser";
}
// ───── автозапуск ─────

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE = "JarvisCode";

/** Подпись Authenticode файла: статус (Valid, NotSigned, HashMismatch…) и издатель. */
export function authenticode(file: string): { status: string; subject: string } {
  if (!IS_WIN) return { status: "NotSupported", subject: "" };
  const r = ps(
    `$s=Get-AuthenticodeSignature -LiteralPath ${q(file)}; [pscustomobject]@{status=[string]$s.Status; subject=[string]$s.SignerCertificate.Subject} | ConvertTo-Json -Compress`,
    30_000,
  );
  try {
    const j = JSON.parse(r.out);
    return { status: String(j.status ?? ""), subject: String(j.subject ?? "") };
  } catch {
    return { status: "Unknown", subject: "" };
  }
}

/** Запуск из собранного exe (а не bun src/main.ts). */
export function isCompiled(): boolean {
  return !/[\\/]bun(\.exe)?$/i.test(process.execPath);
}

export function getAutostart(): boolean {
  if (!IS_WIN) return false;
  try {
    const r = spawnSync("reg", ["query", RUN_KEY, "/v", RUN_VALUE], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
    return r.status === 0 && (r.stdout ?? "").includes(RUN_VALUE);
  } catch {
    return false;
  }
}

export function setAutostart(on: boolean, exe = process.execPath): boolean {
  if (!IS_WIN) return false;
  const args = on ? ["add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", `"${exe}" --background`, "/f"] : ["delete", RUN_KEY, "/v", RUN_VALUE, "/f"];
  const r = spawnSync("reg", args, { windowsHide: true, stdio: "ignore", timeout: 5000 });
  return r.status === 0 || !on;
}

// ───── старые скрипты автозапуска (ngrok, консольная версия) ─────

export interface LegacyStartup {
  id: string;
  kind: "startup" | "run";
  name: string;
  detail: string;
  path?: string;
}

const LEGACY_RE = /ngrok|notion[-_ ]?code|cloudflared|mcp/i;

export function findLegacyStartup(): LegacyStartup[] {
  if (!IS_WIN) return [];
  const out: LegacyStartup[] = [];
  const r = ps(
    `$o=@(); $dir=[Environment]::GetFolderPath('Startup'); $w=New-Object -ComObject WScript.Shell;
     Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue | ForEach-Object {
       $d=''; try { if ($_.Extension -eq '.lnk') { $s=$w.CreateShortcut($_.FullName); $d=($s.TargetPath+' '+$s.Arguments) } elseif ($_.Length -lt 200000) { $d=[IO.File]::ReadAllText($_.FullName) } } catch {}
       $o += [pscustomobject]@{k='startup'; n=$_.Name; p=$_.FullName; d=$d} };
     $key='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'; $props=Get-ItemProperty -Path $key -ErrorAction SilentlyContinue;
     if ($props) { $props.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' } | ForEach-Object { $o += [pscustomobject]@{k='run'; n=$_.Name; p=''; d=[string]$_.Value} } };
     ConvertTo-Json -InputObject @($o) -Compress -Depth 3`,
    20_000,
  );
  try {
    const list = JSON.parse(r.out || "[]") as { k: "startup" | "run"; n: string; p: string; d: string }[];
    for (const x of list) {
      if (x.k === "run" && x.n === RUN_VALUE) continue;
      if (!LEGACY_RE.test(`${x.n} ${x.d}`)) continue;
      out.push({ id: `${x.k}:${x.n}`, kind: x.k, name: x.n, detail: (x.d || "").replace(/\s+/g, " ").trim().slice(0, 300), path: x.p || undefined });
    }
  } catch {}
  return out;
}

/** Отключает найденные автозапуски: файлы переносятся в резервную папку, значения реестра сохраняются в файл. */
export function disableLegacyStartup(items: LegacyStartup[], backupDir: string): string[] {
  const done: string[] = [];
  fs.mkdirSync(backupDir, { recursive: true });
  for (const it of items) {
    try {
      if (it.kind === "startup" && it.path && fs.existsSync(it.path)) {
        fs.renameSync(it.path, path.join(backupDir, `${Date.now()}-${path.basename(it.path)}`));
        done.push(it.id);
      } else if (it.kind === "run") {
        fs.appendFileSync(path.join(backupDir, "run-values.txt"), `${new Date().toISOString()}  ${it.name} = ${it.detail}\r\n`);
        spawnSync("reg", ["delete", RUN_KEY, "/v", it.name, "/f"], { windowsHide: true, stdio: "ignore", timeout: 5000 });
        done.push(it.id);
      }
    } catch {}
  }
  return done;
}

/** Ссылка на ngrok и домен из старых скриптов (чтобы мост заработал без настройки). */
export function ngrokFromLegacy(items: LegacyStartup[]): { exe?: string; domain?: string } {
  for (const it of items) {
    const exe = it.detail.match(/"([^"]*ngrok[^"]*\.exe)"/i)?.[1] ?? it.detail.match(/([a-z]:\\[^\s"']*ngrok[^\s"']*\.exe)/i)?.[1];
    const domain = it.detail.match(/--(?:domain|url|hostname)[= ]+["']?(?:https?:\/\/)?([a-z0-9.-]+\.[a-z]{2,})/i)?.[1];
    if (exe || domain) return { exe: exe && fs.existsSync(exe) ? exe : undefined, domain };
  }
  return {};
}

// ───── приложение Notion ─────

export function findNotionApp(): string | null {
  if (!IS_WIN) return null;
  const list = [
    path.join(LOCAL_APPDATA, "Programs", "Notion", "Notion.exe"),
    path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Notion", "Notion.exe"),
  ];
  return list.find((p) => fs.existsSync(p)) ?? null;
}

export function openNotionApp(): void {
  const exe = findNotionApp();
  if (exe) spawn(exe, [], { detached: true, stdio: "ignore" }).unref();
  else openExternal(IS_WIN ? "notion://www.notion.so" : "https://www.notion.so");
}
