// Инструменты рабочего стола: корзина, снимок экрана, буфер обмена — права и поведение (в Linux корзина — freedesktop).
// Запуск: bun test/desktop.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.JARVIS_CODE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jc-home-"));
process.env.XDG_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jc-xdg-"));
const { executeCall, TOOLS, TOOL_SIGNATURES } = await import("../src/tools");
const { trashGuard } = await import("../src/desktop");
const { defaultConfig } = await import("../src/config");
const { DATA_DIR } = await import("../src/paths");
type Mode = import("../src/config").Mode;

let failed = 0;
let passed = 0;
const check = (name: string, ok: boolean, extra?: unknown) => (ok ? passed++ : (failed++, console.log(`✗ ${name}`, extra ?? "")));

const project = fs.mkdtempSync(path.join(os.tmpdir(), "jc-proj-"));
const cfg = defaultConfig();
function ctx(mode: Mode, answer: "yes" | "always" | "no" = "yes", extra: Partial<Parameters<typeof executeCall>[1]> = {}) {
  const asks: any[] = [];
  const patches: any[] = [];
  const c = {
    cfg,
    mode,
    project,
    sessionAllow: [] as string[],
    signal: new AbortController().signal,
    ask: async (a: any) => (asks.push(a), { answer }),
    track: () => (p: any) => patches.push(p),
    ...extra,
  };
  return { c, asks, patches };
}
const trashDir = path.join(process.env.XDG_DATA_HOME!, "Trash");

// ── корзина
fs.writeFileSync(path.join(project, "a.log"), "a");
fs.mkdirSync(path.join(project, "build", "x"), { recursive: true });
fs.writeFileSync(path.join(project, "build", "x", "b.txt"), "b");
{
  const { c, asks } = ctx("full");
  const r = await executeCall({ tool: "nc_trash", args: { paths: ["a.log", "build", "missing.txt"] } }, c);
  check("корзина: full в проекте — без вопроса", asks.length === 0, asks);
  check("корзина: файлы ушли", r.ok && !fs.existsSync(path.join(project, "a.log")) && !fs.existsSync(path.join(project, "build")), r);
  check("корзина: лежат в Trash/files", fs.existsSync(path.join(trashDir, "files", "a.log")) && fs.existsSync(path.join(trashDir, "files", "build", "x", "b.txt")));
  check("корзина: .trashinfo с путём", fs.readFileSync(path.join(trashDir, "info", "a.log.trashinfo"), "utf8").includes("Path=" + encodeURI(path.join(project, "a.log"))));
  check("корзина: отчёт о ненайденном", /Не удалось: 1/.test(r.text) && /missing\.txt — не найден/.test(r.text), r.text);
}
{
  fs.writeFileSync(path.join(project, "a.log"), "again");
  const { c } = ctx("full");
  await executeCall({ tool: "nc_trash", args: { paths: ["a.log"] } }, c);
  check("корзина: одинаковое имя — не перезаписывает", fs.existsSync(path.join(trashDir, "files", "a.log.2")) && fs.readFileSync(path.join(trashDir, "files", "a.log"), "utf8") === "a");
}
{
  fs.writeFileSync(path.join(project, "keep.txt"), "k");
  const { c, asks } = ctx("ask", "no");
  const r = await executeCall({ tool: "nc_trash", args: { paths: ["keep.txt"] } }, c);
  check("корзина: ask → спросить без «Всегда»", asks.length === 1 && !asks[0].pattern, asks);
  check("корзина: отказ — файл на месте", !r.ok && fs.existsSync(path.join(project, "keep.txt")));
  const p = ctx("plan");
  const r2 = await executeCall({ tool: "nc_trash", args: { paths: ["keep.txt"] } }, p.c);
  check("корзина: план → запрет", !r2.ok && p.asks.length === 0 && /План/.test(r2.text), r2.text);
  const out = ctx("full", "no");
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "jc-other-"));
  fs.writeFileSync(path.join(other, "z.txt"), "z");
  await executeCall({ tool: "nc_trash", args: { paths: [path.join(other, "z.txt")] } }, out.c);
  check("корзина: full вне проекта → спросить", out.asks.length === 1 && out.asks[0].risk === "high", out.asks);
  const au = ctx("autonomous");
  const r3 = await executeCall({ tool: "nc_trash", args: { paths: [path.join(other, "z.txt")] } }, au.c);
  check("корзина: autonomous вне проекта → запрет", !r3.ok && au.asks.length === 0 && fs.existsSync(path.join(other, "z.txt")), r3.text);
  const self = ctx("full", "no");
  await executeCall({ tool: "nc_trash", args: { paths: ["."] } }, self.c);
  check("корзина: саму папку проекта — только с вопросом", self.asks.length === 1, self.asks);
  fs.rmSync(other, { recursive: true, force: true });
}
{
  const { c } = ctx("full", "yes");
  const r = await executeCall({ tool: "nc_trash", args: { paths: [os.homedir()] } }, c);
  check("корзина: домашнюю папку — нельзя", !r.ok && /основная папка/.test(r.text) && fs.existsSync(os.homedir()), r.text);
  const r2 = await executeCall({ tool: "nc_trash", args: { paths: ["*.txt"] } }, c);
  check("корзина: маски не поддерживаются", !r2.ok && /маски/.test(r2.text), r2.text);
  const r3 = await executeCall({ tool: "nc_trash", args: { paths: [] } }, c);
  check("корзина: пустой список — ошибка аргументов", !r3.ok && /Invalid arguments/.test(r3.text), r3.text);
}
check("guard: корень", !!trashGuard("/"));
check("guard: Документы", !!trashGuard(path.join(os.homedir(), "Documents")));
check("guard: данные Jarvis Code", !!trashGuard(DATA_DIR));
check("guard: обычный файл", trashGuard(path.join(project, "x.txt")) === null);

// ── снимок экрана и буфер обмена: только с согласия
{
  const { c, asks } = ctx("full", "always");
  const r = await executeCall({ tool: "nc_screenshot", args: {} }, c);
  check("экран: даже в full — спросить", asks.length === 1 && asks[0].pattern === "observe:nc_screenshot", asks);
  check("экран: «Всегда» запомнено для чата", c.sessionAllow.includes("observe:nc_screenshot"), c.sessionAllow);
  check("экран: в Linux — понятная ошибка", !r.ok && /только в Windows/.test(r.text), r.text);
  await executeCall({ tool: "nc_screenshot", args: { all: true } }, c);
  check("экран: второй раз не спрашивает", asks.length === 1, asks.length);
  await executeCall({ tool: "nc_clipboard", args: {} }, c);
  check("буфер: разрешение экрана не распространяется", asks.length === 2 && asks[1].pattern === "observe:nc_clipboard", asks);
}
{
  const { c, asks } = ctx("autonomous");
  const r = await executeCall({ tool: "nc_screenshot", args: {} }, c);
  check("экран: autonomous → запрет без вопроса", !r.ok && asks.length === 0 && /Denied/.test(r.text), r.text);
  const p = ctx("plan");
  await executeCall({ tool: "nc_clipboard", args: { action: "get" } }, p.c);
  check("буфер: план — чтение с вопросом", p.asks.length === 1, p.asks);
  const r2 = await executeCall({ tool: "nc_clipboard", args: { action: "set", text: "x" } }, p.c);
  check("буфер: план — запись запрещена", !r2.ok && /План/.test(r2.text), r2.text);
  const r3 = await executeCall({ tool: "nc_clipboard", args: { action: "set" } }, p.c);
  check("буфер: set без text — ошибка аргументов", !r3.ok && /text/.test(r3.text), r3.text);
}

// ── картинка в режиме только текста (Agent API): вместо изображения — пометка/распознанный текст
{
  const png = path.join(project, "dot.png");
  fs.writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
  const api = ctx("ask", "yes", { textOnly: true });
  const r = await executeCall({ tool: "nc_view_image", args: { path: "dot.png" } }, api.c);
  check("картинка: API — пометка вместо изображения", r.ok && /картинку агенту не передать/.test(r.text), r.text);
  const mcp = ctx("ask");
  const r2 = await executeCall({ tool: "nc_view_image", args: { path: "dot.png" } }, mcp.c);
  check("картинка: MCP — изображение без пометки", r2.ok && !!r2.image && !/не передать/.test(r2.text), r2.text);
}

check("протокол: новые инструменты в подписи", /nc_screenshot \{all\?, ocr\?\}/.test(TOOL_SIGNATURES) && /nc_trash \{paths\}/.test(TOOL_SIGNATURES) && /nc_clipboard \{action\?, text\?\}/.test(TOOL_SIGNATURES), TOOL_SIGNATURES);
check("MCP: корзина помечена как разрушающая", TOOLS.nc_trash.spec.destructive === true && TOOLS.nc_screenshot.spec.readOnly === true);

fs.rmSync(project, { recursive: true, force: true });
fs.rmSync(process.env.XDG_DATA_HOME!, { recursive: true, force: true });
fs.rmSync(process.env.JARVIS_CODE_HOME!, { recursive: true, force: true });
// трей: подписи меню после минификации (как в exe) — русские буквы, а не «\u041E…»
{
  const out = path.join(os.tmpdir(), `nc-tray-min-${process.pid}`);
  const b = await Bun.build({ entrypoints: [path.join(import.meta.dir, "../src/tray.ts")], target: "bun", minify: true, outdir: out });
  check("трей: сборка с минификацией", b.success, b.logs);
  if (b.success) {
    const mod = await import(b.outputs[0].path);
    const sc: string = mod.trayScript("C:\\x.ico");
    check("трей: подписи меню читаемые после минификации", sc.includes("'Открыть Jarvis Code'") && sc.includes("'Выход'") && !/\\u04[0-9a-f]{2}/i.test(sc), sc.match(/Add '\w+' '[^']*'/g));
  }
  fs.rmSync(out, { recursive: true, force: true });
}

// окно на панели задач: свой AppUserModelID, значок по адресу с версией, сброс кэша значка (4.0.3)
{
  const { windowTagScript, shortcutTagScript, resetIconCache, appIconFile, APP_USER_MODEL_ID } = await import("../src/appid");
  const { UI_FILES, ICON_ICO_BASE64 } = await import("../src/ui-assets.gen");
  const { VERSION } = await import("../src/version");
  const fav = `favicon-${VERSION}.ico`;
  check("значок: favicon по адресу с версией", !!UI_FILES[fav] && UI_FILES[fav].data === ICON_ICO_BASE64, Object.keys(UI_FILES));
  check("значок: index.html ссылается на него", UI_FILES["index.html"].data.includes(`<link rel="icon" type="image/x-icon" href="/${fav}"`));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jc-webview-"));
  const prof = path.join(tmp, "Web'View");
  fs.mkdirSync(path.join(prof, "Default", "Web Applications", "x"), { recursive: true });
  fs.writeFileSync(path.join(prof, "Default", "Web Applications", "x", "Jarvis Code.ico"), "old");
  fs.writeFileSync(path.join(prof, "Default", "Favicons"), "old");
  fs.writeFileSync(path.join(prof, "Default", "Preferences"), "{}");
  fs.mkdirSync(path.join(prof, "Default", "Local Storage"), { recursive: true });
  check("кэш значка: сброс при новой версии", resetIconCache(prof, "9.9.9") === true);
  check(
    "кэш значка: favicon и значки веб-приложений удалены, остальное цело",
    !fs.existsSync(path.join(prof, "Default", "Favicons")) &&
      !fs.existsSync(path.join(prof, "Default", "Web Applications")) &&
      fs.existsSync(path.join(prof, "Default", "Preferences")) &&
      fs.existsSync(path.join(prof, "Default", "Local Storage")),
  );
  fs.writeFileSync(path.join(prof, "Default", "Favicons"), "new");
  check("кэш значка: повторно в той же версии — не трогаем", resetIconCache(prof, "9.9.9") === false && fs.existsSync(path.join(prof, "Default", "Favicons")));

  fs.writeFileSync(path.join(tmp, "jarvis-code-1.0.0.ico"), "old");
  const ico = appIconFile(tmp, ICON_ICO_BASE64, "9.9.9");
  check("значок окна: файл с версией, старые удалены", path.basename(ico) === "jarvis-code-9.9.9.ico" && fs.existsSync(ico) && !fs.existsSync(path.join(tmp, "jarvis-code-1.0.0.ico")));

  const ws = windowTagScript({ profileDir: prof, browserExe: "msedge.exe", appId: APP_USER_MODEL_ID, relaunch: '"C:\\Jarvis\\JarvisCode.exe"', name: "Jarvis Code", icon: ico });
  const ss = shortcutTagScript(["C:\\Users\\O'Brien\\Desktop\\Jarvis Code.lnk"]);
  check("окно: свой AppUserModelID и профиль в скрипте", ws.includes(`$id='${APP_USER_MODEL_ID}'`) && ws.includes("web''view") && ws.includes("[JC.AppId]::Tag("));
  check("ярлык: AppUserModelID, апостроф экранирован", ss.includes("O''Brien") && ss.includes("TagShortcut("));
  check("ярлык: пустой список — без скрипта", shortcutTagScript([]) === "");
  check("скрипт окна помещается в -EncodedCommand", Buffer.from(ws, "utf16le").toString("base64").length < 30000, ws.length);

  // синтаксис PowerShell (Parser::ParseFile) и компиляция C# (Add-Type) — если PowerShell есть на этой машине
  const which = (b: string) => (process.env.PATH ?? "").split(path.delimiter).map((d) => path.join(d, b)).find((f) => fs.existsSync(f));
  const pwsh = process.env.NC_PWSH || which(process.platform === "win32" ? "powershell.exe" : "pwsh");
  if (pwsh) {
    const { spawnSync } = await import("node:child_process");
    for (const [name, sc] of [["окно", ws], ["ярлык", ss]] as const) {
      const f = path.join(tmp, `${name === "окно" ? "window" : "shortcut"}.ps1`);
      fs.writeFileSync(f, "\ufeff" + sc, "utf8");
      const r = spawnSync(pwsh, ["-NoProfile", "-NonInteractive", "-Command", `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${f.replace(/'/g, "''")}', [ref]$null, [ref]$e); $e.Count; $e | ForEach-Object { $_.Message }`], { encoding: "utf8" });
      check(`PowerShell: скрипт «${name}» без синтаксических ошибок`, r.stdout.trim().split(/\r?\n/)[0] === "0", r.stdout + r.stderr);
    }
    const typeOnly = ws.slice(0, ws.indexOf("};") + 2) + " [JC.AppId].FullName";
    const r = spawnSync(pwsh, ["-NoProfile", "-NonInteractive", "-Command", typeOnly], { encoding: "utf8" });
    check("PowerShell: C# для AppUserModelID компилируется", r.stdout.trim() === "JC.AppId", r.stdout + r.stderr);
  } else console.log("  (PowerShell не найден — проверка синтаксиса скриптов окна пропущена)");
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${failed ? "✗" : "✓"} Рабочий стол: ${passed} пройдено, ${failed} с ошибками`);
process.exit(failed ? 1 : 0);
