import fs from "node:fs";
import path from "node:path";
import { VERSION } from "./version";

/**
 * Своё лицо окна на панели задач.
 *
 * Окно Jarvis Code — это Edge/Chrome в режиме --app. Без вмешательства Windows считает его окном браузера
 * («Microsoft Edge» в меню значка, группировка с Edge), а значок берёт из favicon, закэшированного
 * в профиле окна по адресу страницы (127.0.0.1:порт — тот же, что и в прошлых версиях).
 * Поэтому:
 *   • окну задаётся свой AppUserModelID и данные перезапуска (имя, значок, команда) — оно отделяется от Edge;
 *   • тот же AppUserModelID записывается в ярлыки Jarvis Code — панель задач берёт имя и значок из ярлыка;
 *   • при смене версии из профиля окна удаляются закэшированные favicon и значки веб-приложений.
 */
export const APP_USER_MODEL_ID = "JarvisCode.App";
export const SETUP_USER_MODEL_ID = "JarvisCode.Setup";

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** C# для PowerShell 5.1 (компилятор C# 5: без интерполяции строк, out var и т. п.). */
const CS = `
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
namespace JC {
  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  public struct PropKey { public Guid fmtid; public uint pid; }
  [StructLayout(LayoutKind.Explicit)]
  public struct PropVar {
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public IntPtr p;
    [FieldOffset(8)] public short b;
    [FieldOffset(16)] public IntPtr p2;
  }
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPropStore {
    [PreserveSig] int GetCount(out uint c);
    [PreserveSig] int GetAt(uint i, out PropKey k);
    [PreserveSig] int GetValue(ref PropKey k, out PropVar v);
    [PreserveSig] int SetValue(ref PropKey k, ref PropVar v);
    [PreserveSig] int Commit();
  }
  public static class AppId {
    delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr h, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IPropStore s);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern int SHGetPropertyStoreFromParsingName(string path, IntPtr bc, int flags, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IPropStore s);
    [DllImport("shell32.dll")] static extern void SHChangeNotify(int e, uint f, IntPtr a, IntPtr b);

    static readonly Guid AUM = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
    const uint ID = 5, RELAUNCH_CMD = 2, RELAUNCH_ICON = 3, RELAUNCH_NAME = 4, PREVENT_PIN = 9;

    /** Видимые окна верхнего уровня браузера (Chrome_WidgetWin_1) у процессов pids. */
    public static IntPtr[] Windows(int[] pids) {
      // List, а не HashSet: HashSet — в System.Core, которого нет в ссылках Add-Type у PowerShell 5.1
      List<uint> set = new List<uint>();
      foreach (int p in pids) set.Add((uint)p);
      List<IntPtr> list = new List<IntPtr>();
      EnumWindows(delegate (IntPtr h, IntPtr l) {
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        if (!set.Contains(pid) || !IsWindowVisible(h) || GetWindow(h, 4) != IntPtr.Zero || GetWindowTextLength(h) == 0) return true;
        StringBuilder sb = new StringBuilder(64);
        GetClassName(h, sb, sb.Capacity);
        if (sb.ToString() == "Chrome_WidgetWin_1") list.Add(h);
        return true;
      }, IntPtr.Zero);
      return list.ToArray();
    }

    static void Set(IPropStore s, uint id, string val) {
      PropKey k = new PropKey();
      k.fmtid = AUM;
      k.pid = id;
      PropVar v = new PropVar();
      if (!string.IsNullOrEmpty(val)) { v.vt = 31; v.p = Marshal.StringToCoTaskMemUni(val); }
      try { s.SetValue(ref k, ref v); } finally { if (v.p != IntPtr.Zero) Marshal.FreeCoTaskMem(v.p); }
    }

    static void SetBool(IPropStore s, uint id, bool val) {
      PropKey k = new PropKey();
      k.fmtid = AUM;
      k.pid = id;
      PropVar v = new PropVar();
      v.vt = 11;
      v.b = (short)(val ? -1 : 0);
      s.SetValue(ref k, ref v);
    }

    /** Свой AppUserModelID окну. cmd пустая — закрепить окно нельзя (окно установщика). */
    public static bool Tag(IntPtr h, string id, string cmd, string name, string icon) {
      Guid iid = typeof(IPropStore).GUID;
      IPropStore s;
      if (SHGetPropertyStoreForWindow(h, ref iid, out s) != 0 || s == null) return false;
      try {
        bool pin = !string.IsNullOrEmpty(cmd);
        Set(s, RELAUNCH_CMD, pin ? cmd : null);
        Set(s, RELAUNCH_NAME, pin ? name : null);
        Set(s, RELAUNCH_ICON, pin ? icon : null);
        SetBool(s, PREVENT_PIN, !pin);
        Set(s, ID, id);
        s.Commit();
        return true;
      } catch { return false; }
      finally { Marshal.ReleaseComObject(s); }
    }

    /** Тот же AppUserModelID в ярлык: панель задач возьмёт из него имя и значок. */
    public static bool TagShortcut(string lnk, string id) {
      Guid iid = typeof(IPropStore).GUID;
      IPropStore s;
      if (SHGetPropertyStoreFromParsingName(lnk, IntPtr.Zero, 2, ref iid, out s) != 0 || s == null) return false;
      try {
        Set(s, ID, id);
        return s.Commit() == 0;
      } catch { return false; }
      finally { Marshal.ReleaseComObject(s); }
    }

    public static void Notify() { SHChangeNotify(0x08000000, 0, IntPtr.Zero, IntPtr.Zero); }
  }
}
`;

const loadType = `if (-not ('JC.AppId' -as [type])) { Add-Type -TypeDefinition ${q(CS)} -Language CSharp };`;

export interface WindowTag {
  /** Папка профиля браузера (--user-data-dir) — по ней находим процесс окна. */
  profileDir: string;
  /** Имя exe браузера (msedge.exe, chrome.exe…). */
  browserExe: string;
  appId: string;
  /** Команда перезапуска для закрепления на панели задач; "" — закрепление запрещено. */
  relaunch: string;
  name: string;
  /** Значок для закрепления: путь к .ico. */
  icon: string;
  timeoutMs?: number;
}

/**
 * Ждёт окна браузера с профилем profileDir и задаёт им свой AppUserModelID.
 * Окно ищется по процессу (а не по заголовку — заголовок меняется на название чата):
 * основной процесс браузера (без --type=) с нашим --user-data-dir.
 */
export function windowTagScript(o: WindowTag): string {
  const t = Math.max(1000, o.timeoutMs ?? 20000);
  return (
    loadType +
    `$dir=${q(("--user-data-dir=" + o.profileDir).toLowerCase())}; $exe=${q(o.browserExe)}; $id=${q(o.appId)}; $cmd=${q(o.relaunch)}; $name=${q(o.name)}; $icon=${q(o.icon ? o.icon + ",0" : "")};` +
    `$done=@{}; $pids=@(); $first=$null; $end=(Get-Date).AddMilliseconds(${t});` +
    `while ((Get-Date) -lt $end) {` +
    ` if ($pids.Count -eq 0 -or -not $first) { $pids=@(Get-CimInstance Win32_Process -Filter ("Name='" + $exe + "'") -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($dir) -and $_.CommandLine -notmatch '--type=' } | ForEach-Object { [int]$_.ProcessId }) };` +
    ` if ($pids.Count -gt 0) { foreach ($h in [JC.AppId]::Windows([int[]]$pids)) { $k=[string]$h; if (-not $done.ContainsKey($k) -and [JC.AppId]::Tag($h, $id, $cmd, $name, $icon)) { $done[$k]=1; if (-not $first) { $first=Get-Date } } } };` +
    ` if ($first -and ((Get-Date) - $first).TotalMilliseconds -gt 3000) { break };` +
    ` Start-Sleep -Milliseconds 250` +
    `}; $done.Count`
  );
}

/** AppUserModelID в ярлыки Jarvis Code (рабочий стол, «Пуск»). */
export function shortcutTagScript(lnks: string[], appId = APP_USER_MODEL_ID): string {
  if (!lnks.length) return "";
  return loadType + lnks.map((l) => `[void][JC.AppId]::TagShortcut(${q(l)}, ${q(appId)});`).join("") + "[JC.AppId]::Notify()";
}

// ───── кэш значка в профиле окна ─────

const MARKER = "jc-icon-cache.txt";
/** Что хранит значок страницы и веб-приложения в профиле Chromium/Edge. */
const ICON_CACHE = ["Favicons", "Favicons-journal", "Web Applications", "JumpListIconsMostVisited", "JumpListIconsRecentClosed", "JumpListIcons", "JumpListIconsOld"];

/**
 * Один раз на версию удаляет из профиля окна закэшированные favicon и значки веб-приложений
 * (настройки окна — тема, панель — в Local Storage, их не трогаем). Если профиль занят открытым
 * окном и файлы не удалились — повторим при следующем открытии.
 */
export function resetIconCache(profileDir: string, version = VERSION): boolean {
  const marker = path.join(profileDir, MARKER);
  try {
    if (fs.readFileSync(marker, "utf8").trim() === version) return false;
  } catch {}
  let ok = true;
  let profiles: string[] = [];
  try {
    profiles = fs
      .readdirSync(profileDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && (d.name === "Default" || /^Profile \d+$/.test(d.name)))
      .map((d) => path.join(profileDir, d.name));
  } catch {}
  for (const p of profiles)
    for (const f of ICON_CACHE) {
      const t = path.join(p, f);
      try {
        if (fs.existsSync(t)) fs.rmSync(t, { recursive: true, force: true });
      } catch {
        ok = false;
      }
      if (fs.existsSync(t)) ok = false;
    }
  if (ok) {
    try {
      fs.mkdirSync(profileDir, { recursive: true });
      fs.writeFileSync(marker, version);
    } catch {}
  }
  return ok;
}

/** Значок для данных перезапуска окна: файл с версией в имени (старые удаляются). */
export function appIconFile(dir: string, icoBase64: string, version = VERSION): string {
  const name = `jarvis-code-${version}.ico`;
  const file = path.join(dir, name);
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, Buffer.from(icoBase64, "base64"));
    for (const f of fs.readdirSync(dir)) if (/^jarvis-code-[\w.-]+\.ico$/i.test(f) && f !== name) fs.rmSync(path.join(dir, f), { force: true });
  } catch {}
  return file;
}
