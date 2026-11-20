/**
 * Рабочий стол Windows для агента: снимок экрана, буфер обмена, корзина, распознавание текста (OCR).
 * Всё через встроенные средства Windows (PowerShell 5.1, System.Drawing, WinRT OCR, shell32) — без установки.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA_DIR, IS_WIN, SHOTS_DIR, STORE_DIR } from "./paths";

export { SHOTS_DIR };

/** Старые снимки и картинки из буфера (старше 14 дней, сверх 300 штук) удаляются. */
export function pruneShots(maxAgeDays = 14, keep = 300) {
  try {
    const files = fs
      .readdirSync(SHOTS_DIR)
      .map((n) => {
        const f = path.join(SHOTS_DIR, n);
        try {
          return { f, t: fs.statSync(f).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((x): x is { f: string; t: number } => !!x)
      .sort((a, b) => b.t - a.t);
    const old = Date.now() - maxAgeDays * 86_400_000;
    files.forEach((x, i) => {
      if (i >= keep || x.t < old)
        try {
          fs.unlinkSync(x.f);
        } catch {}
    });
  } catch {}
}
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const stamp = () => new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);

/** PowerShell 5.1 с тайм-аутом и отменой; вывод — UTF-8. */
export function runPs(script: string, o: { timeoutMs?: number; sta?: boolean; signal?: AbortSignal } = {}): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    if (!IS_WIN) return resolve({ ok: false, out: "", err: "Доступно только в Windows" });
    const enc = Buffer.from(
      `$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;${script}`,
      "utf16le",
    ).toString("base64");
    const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...(o.sta ? ["-STA"] : []), "-EncodedCommand", enc];
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("powershell.exe", args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e: any) {
      return resolve({ ok: false, out: "", err: String(e?.message ?? e) });
    }
    let out = "";
    let err = "";
    let done = false;
    const finish = (r: { ok: boolean; out: string; err: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };
    const kill = () => {
      try {
        child.kill();
      } catch {}
    };
    const onAbort = () => (kill(), finish({ ok: false, out, err: "Отменено" }));
    const timer = setTimeout(() => (kill(), finish({ ok: false, out, err: "PowerShell не ответил вовремя" })), o.timeoutMs ?? 30_000);
    o.signal?.addEventListener("abort", onAbort, { once: true });
    // setEncoding: русская буква на границе двух кусков вывода не превратится в «�»
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => (out += d));
    child.stderr?.on("data", (d: string) => (err += d));
    child.on("error", (e) => finish({ ok: false, out, err: e.message }));
    child.on("close", (code) => finish({ ok: code === 0, out: out.trim(), err: cleanPsError(err) }));
  });
}

/** Ошибка PowerShell без служебных строк (CategoryInfo, FullyQualifiedErrorId…). */
function cleanPsError(err: string): string {
  const lines = err
    .replace(/#< CLIXML[\s\S]*$/m, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^(\+|At line|CategoryInfo|FullyQualifiedErrorId|строка:|знак:)/i.test(l));
  return lines.slice(0, 3).join(" ").slice(0, 400);
}

// ───────────── снимок экрана ─────────────

const SHOT_TYPES = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
if (-not ('JcShot' -as [type])) {
Add-Type -TypeDefinition @"
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
public static class JcShot {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public static List<IntPtr> Find(string part) {
    var r = new List<IntPtr>();
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (IsWindowVisible(h) && !IsIconic(h)) {
        var sb = new StringBuilder(512);
        GetWindowText(h, sb, 512);
        var t = sb.ToString();
        if (t == part || t.StartsWith(part + " ")) r.Add(h);
      }
      return true;
    }, IntPtr.Zero);
    return r;
  }
}
"@
}`;

/** Сохраняет картинку: PNG в полном размере и JPEG ≤1600 px для агента. Возвращает «ШxВ». */
const SAVE_BITMAP = `
function Save-JcBitmap($bmp, $png, $jpg) {
  $bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
  $k = [Math]::Min(1.0, 1600 / [Math]::Max($bmp.Width, $bmp.Height))
  $w = [int][Math]::Max(1, $bmp.Width * $k); $hh = [int][Math]::Max(1, $bmp.Height * $k)
  $s = New-Object System.Drawing.Bitmap $w, $hh
  $g2 = [System.Drawing.Graphics]::FromImage($s); $g2.InterpolationMode = 'HighQualityBicubic'; $g2.DrawImage($bmp, 0, 0, $w, $hh); $g2.Dispose()
  $c = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
  $p = New-Object System.Drawing.Imaging.EncoderParameters 1
  $p.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, [long]82)
  $s.Save($jpg, $c, $p); $s.Dispose()
  "$($bmp.Width)x$($bmp.Height)"
}`;

export interface Shot {
  /** Полноразмерный PNG (для пользователя). */
  file: string;
  /** Уменьшенный JPEG (для агента). */
  preview: string;
  width: number;
  height: number;
}

/** Снимок экрана: основной монитор или все; окно Jarvis Code на мгновение сворачивается, чтобы не загораживать. */
export async function screenshot(o: { all?: boolean; hideApp?: boolean; signal?: AbortSignal } = {}): Promise<Shot> {
  if (!IS_WIN) throw new Error("Снимок экрана доступен только в Windows.");
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  pruneShots();
  const base = path.join(SHOTS_DIR, `screen-${stamp()}-${Math.random().toString(36).slice(2, 6)}`);
  const png = base + ".png";
  const jpg = base + ".jpg";
  const script = `${SHOT_TYPES}
${SAVE_BITMAP}
[JcShot]::SetProcessDPIAware() | Out-Null
$hidden = @()
if (${o.hideApp !== false ? "$true" : "$false"}) { $hidden = @([JcShot]::Find('Jarvis Code')); foreach ($x in $hidden) { [JcShot]::ShowWindow($x, 6) | Out-Null }; if ($hidden.Count) { Start-Sleep -Milliseconds 500 } }
try {
  $b = ${o.all ? "[System.Windows.Forms.SystemInformation]::VirtualScreen" : "[System.Windows.Forms.Screen]::PrimaryScreen.Bounds"}
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
  $g.Dispose()
} finally {
  foreach ($x in $hidden) { [JcShot]::ShowWindow($x, 9) | Out-Null }
}
Save-JcBitmap $bmp ${q(png)} ${q(jpg)}
$bmp.Dispose()`;
  const r = await runPs(script, { timeoutMs: 40_000, signal: o.signal });
  const m = r.out.match(/(\d+)x(\d+)\s*$/);
  if (!r.ok || !m || !fs.existsSync(png)) throw new Error(`не удалось снять экран: ${r.err || r.out || "нет ответа PowerShell"}`);
  return { file: png, preview: fs.existsSync(jpg) ? jpg : png, width: Number(m[1]), height: Number(m[2]) };
}

// ───────────── распознавание текста (Windows OCR) ─────────────

/** Текст с картинки встроенным распознаванием Windows 10/11 (языки профиля пользователя). null — недоступно. */
export async function ocrImage(file: string, signal?: AbortSignal): Promise<string | null> {
  if (!IS_WIN) return null;
  // как в известных рабочих примерах Windows OCR для PowerShell 5.1: типы WinRT подгружаются по имени
  const script = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Foundation.IAsyncOperation\`1, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.RandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (-not $engine) {
  try { $null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]; $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language 'en-US')) } catch {}
}
if (-not $engine) { throw "no ocr engine" }
$src = ${q(path.resolve(file))}
$tmp = $null
$max = [int][Windows.Media.Ocr.OcrEngine]::MaxImageDimension
# больше, чем берёт распознавание (несколько мониторов, длинный скриншот), — уменьшенная копия
try {
  Add-Type -AssemblyName System.Drawing
  $img = [System.Drawing.Image]::FromFile($src)
  try {
    if ($max -gt 0 -and ($img.Width -gt $max -or $img.Height -gt $max)) {
      $k = [Math]::Min($max / $img.Width, $max / $img.Height)
      $w = [int][Math]::Max(1, [Math]::Floor($img.Width * $k)); $hh = [int][Math]::Max(1, [Math]::Floor($img.Height * $k))
      $s = New-Object System.Drawing.Bitmap $w, $hh
      $g = [System.Drawing.Graphics]::FromImage($s); $g.InterpolationMode = 'HighQualityBicubic'; $g.DrawImage($img, 0, 0, $w, $hh); $g.Dispose()
      $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('jc-ocr-' + [guid]::NewGuid().ToString('N') + '.png')
      $s.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png); $s.Dispose()
      $src = $tmp
    }
  } finally { $img.Dispose() }
} catch {}
try {
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($src)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  try {
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    if ($max -gt 0 -and ($decoder.PixelWidth -gt $max -or $decoder.PixelHeight -gt $max)) { throw "too big" }
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $res = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    "@@OCR@@"
    $res.Lines | ForEach-Object { $_.Text }
  } finally { $stream.Dispose() }
} finally { if ($tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue } }`;
  const r = await runPs(script, { timeoutMs: 45_000, signal });
  if (!r.ok || !r.out.includes("@@OCR@@")) return null;
  return r.out.slice(r.out.indexOf("@@OCR@@") + 7).trim();
}

// ───────────── буфер обмена ─────────────

export interface ClipboardContent {
  text: string;
  files: string[];
  /** Картинка из буфера, сохранённая в PNG (и уменьшенная копия для агента). */
  image?: { file: string; preview: string; width: number; height: number };
}

export async function readClipboard(signal?: AbortSignal): Promise<ClipboardContent> {
  if (!IS_WIN) throw new Error("Буфер обмена доступен только в Windows.");
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const base = path.join(SHOTS_DIR, `clipboard-${stamp()}-${Math.random().toString(36).slice(2, 6)}`);
  const script = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
${SAVE_BITMAP}
$files = @([System.Windows.Forms.Clipboard]::GetFileDropList())
$text = [System.Windows.Forms.Clipboard]::GetText()
$size = ''
if ([System.Windows.Forms.Clipboard]::ContainsImage()) { $img = [System.Windows.Forms.Clipboard]::GetImage(); if ($img) { $size = Save-JcBitmap $img ${q(base + ".png")} ${q(base + ".jpg")}; $img.Dispose() } }
@{ text = $text; files = $files; image = $size } | ConvertTo-Json -Compress`;
  const r = await runPs(script, { timeoutMs: 20_000, sta: true, signal });
  if (!r.ok) throw new Error(`не удалось прочитать буфер обмена: ${r.err || "нет ответа"}`);
  let data: { text?: string; files?: string[] | string; image?: string } = {};
  try {
    data = JSON.parse(r.out.slice(r.out.indexOf("{")));
  } catch {
    throw new Error("не удалось разобрать содержимое буфера обмена");
  }
  const files = (Array.isArray(data.files) ? data.files : data.files ? [data.files] : []).map(String).filter(Boolean);
  const m = String(data.image ?? "").match(/(\d+)x(\d+)/);
  const image = m && fs.existsSync(base + ".png") ? { file: base + ".png", preview: fs.existsSync(base + ".jpg") ? base + ".jpg" : base + ".png", width: Number(m[1]), height: Number(m[2]) } : undefined;
  return { text: String(data.text ?? ""), files, image };
}

// ───────────── корзина ─────────────

/** Папки, которые нельзя удалить целиком даже в корзину (сами папки; файлы внутри — можно). */
export function trashGuard(p: string): string | null {
  const abs = path.resolve(p);
  if (/[*?]/.test(p)) return "маски (* ?) не поддерживаются — перечислите пути";
  if (path.parse(abs).root === abs || /^[a-z]:\\?$/i.test(abs)) return "это корень диска";
  if (/^\\\\/.test(abs)) return "сетевая папка: в корзину не попадёт, удаление было бы безвозвратным";
  const norm = (x: string) => path.resolve(x).replace(/[\\/]+$/, "").toLowerCase();
  const n = norm(abs);
  const home = os.homedir();
  const blocked = [
    home,
    ...["Desktop", "Documents", "Downloads", "Pictures", "Videos", "Music", "AppData", "OneDrive", "Рабочий стол", "Документы", "Загрузки"].map((d) => path.join(home, d)),
    process.env.SystemRoot || "C:\\Windows",
    process.env.ProgramFiles || "C:\\Program Files",
    process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
    process.env.ProgramData || "C:\\ProgramData",
    path.join(path.parse(home).root, "Users"),
    DATA_DIR,
    STORE_DIR,
    ...(IS_WIN ? [path.dirname(process.execPath)] : []),
  ];
  if (blocked.some((b) => norm(b) === n)) return "это системная или основная папка пользователя";
  if (n.startsWith(norm(process.env.SystemRoot || "C:\\Windows") + path.sep)) return "это системная папка Windows";
  return null;
}

/** Перемещает файлы и папки в корзину (их можно восстановить). */
export async function moveToTrash(paths: string[], signal?: AbortSignal): Promise<{ done: string[]; failed: { path: string; error: string }[] }> {
  const done: string[] = [];
  const failed: { path: string; error: string }[] = [];
  const todo: string[] = [];
  for (const p of paths) {
    const abs = path.resolve(p);
    const why = trashGuard(p);
    if (why) failed.push({ path: abs, error: why });
    else if (!fs.existsSync(abs)) failed.push({ path: abs, error: "не найден" });
    else todo.push(abs);
  }
  if (!todo.length) return { done, failed };
  if (!IS_WIN) {
    for (const abs of todo) {
      try {
        freedesktopTrash(abs);
        done.push(abs);
      } catch (e: any) {
        failed.push({ path: abs, error: String(e?.message ?? e) });
      }
    }
    return { done, failed };
  }
  const list = Buffer.from(JSON.stringify(todo), "utf8").toString("base64");
  const script = `
if (-not ('JcTrash' -as [type])) {
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class JcTrash {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct SHFILEOPSTRUCT { public IntPtr hwnd; public uint wFunc; public string pFrom; public string pTo; public ushort fFlags; public bool fAnyOperationsAborted; public IntPtr hNameMappings; public string lpszProgressTitle; }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern int SHFileOperation(ref SHFILEOPSTRUCT op);
  public static int Recycle(string path) {
    var op = new SHFILEOPSTRUCT();
    op.wFunc = 3; op.pFrom = path + "\\0\\0"; op.fFlags = 0x40 | 0x10 | 0x400 | 0x4 | 0x4000;
    return SHFileOperation(ref op);
  }
}
"@
}
$items = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${list}')) | ConvertFrom-Json
foreach ($p in $items) {
  try {
    $drive = [System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($p))
    if ($drive.DriveType -ne 'Fixed') { "ERR\`t$p\`tна этом диске ($($drive.DriveType)) нет корзины — удаление было бы безвозвратным"; continue }
    $code = [JcTrash]::Recycle($p)
    if ($code -eq 0 -and -not (Test-Path -LiteralPath $p)) { "OK\`t$p" } else { "ERR\`t$p\`tкод $code" }
  } catch { "ERR\`t$p\`t$($_.Exception.Message)" }
}`;
  const r = await runPs(script, { timeoutMs: 120_000, signal });
  const seen = new Set<string>();
  for (const line of r.out.split(/\r?\n/)) {
    const [st, p, err] = line.split("\t");
    if (!p) continue;
    seen.add(p);
    if (st === "OK") done.push(p);
    else failed.push({ path: p, error: err || "ошибка" });
  }
  for (const p of todo) if (!seen.has(p)) failed.push({ path: p, error: r.err || "нет ответа PowerShell" });
  return { done, failed };
}

/** Linux/macOS (для разработки и тестов): корзина по стандарту freedesktop. */
function freedesktopTrash(abs: string) {
  const root = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "Trash");
  fs.mkdirSync(path.join(root, "files"), { recursive: true });
  fs.mkdirSync(path.join(root, "info"), { recursive: true });
  let name = path.basename(abs);
  for (let i = 2; fs.existsSync(path.join(root, "files", name)); i++) name = `${path.basename(abs)}.${i}`;
  fs.writeFileSync(path.join(root, "info", name + ".trashinfo"), `[Trash Info]\nPath=${encodeURI(abs)}\nDeletionDate=${new Date().toISOString().slice(0, 19)}\n`);
  try {
    fs.renameSync(abs, path.join(root, "files", name));
  } catch (e: any) {
    if (e?.code !== "EXDEV") throw e;
    fs.cpSync(abs, path.join(root, "files", name), { recursive: true });
    fs.rmSync(abs, { recursive: true, force: true });
  }
}
