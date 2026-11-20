/**
 * Сборка Jarvis Code.
 *   bun scripts/build.ts            — только интерфейс (src/ui-assets.gen.ts)
 *   bun scripts/build.ts --exe      — + dist/JarvisCode.exe и dist/JarvisCodeSetup.exe (Windows x64)
 *   bun scripts/build.ts --release  — + release/: JarvisCodeSetup.exe/.zip, latest.json, SHA256SUMS.txt, исходники
 *   bun scripts/build.ts --dev      — интерфейс + запуск сервера без окна (для отладки)
 *
 * Подпись exe (необязательно, без неё сборка тоже работает):
 *   JC_SIGN_CERT=cert.pfx JC_SIGN_PASS=…  — signtool (Windows) или osslsigncode (Linux/macOS)
 *   JC_SIGN_CMD="… {file}"                — своя команда (Azure Trusted Signing, HSM, …)
 *   JC_SIGN_TIMESTAMP=http://…            — сервер меток времени (по умолчанию DigiCert)
 *
 * Обновления «из коробки» (необязательно; в настройках приложения можно указать свой источник):
 *   JC_UPDATE_REPO=owner/repo             — откуда приложение берёт обновления (GitHub Releases)
 *   JC_UPDATE_URL=https://…/latest.json   — или свой сервер с latest.json
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as ResEdit from "resedit";
import { VERSION } from "../src/version";
import { listFiles, writeZip } from "./zip";

const ROOT = path.resolve(import.meta.dir, "..");
const args = new Set(process.argv.slice(2));
const wantExe = args.has("--exe") || args.has("--release");
const wantRelease = args.has("--release");
const r = (...p: string[]) => path.join(ROOT, ...p);

function step(name: string) {
  console.log(`\n▸ ${name}`);
}

// ───── 1. Интерфейс ─────
step("Сборка интерфейса");
const ui = await Bun.build({
  entrypoints: [r("ui/main.tsx")],
  target: "browser",
  format: "iife",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
});
if (!ui.success) {
  for (const l of ui.logs) console.error(l);
  process.exit(1);
}
const appJs = await ui.outputs[0].text();
// стили — модули ui/css/*.css по порядку имён; шрифты (Inter, Source Serif 4, JetBrains Mono — OFL)
// встраиваются в CSS: окно работает без интернета
const cssSrc = fs
  .readdirSync(r("ui/css"))
  .filter((f) => f.endsWith(".css"))
  .sort()
  .map((f) => `/* ${f} */\n` + fs.readFileSync(r("ui/css", f), "utf8"))
  .join("\n")
  .replace(/url\(\/fonts\/([\w.-]+)\)/g, (_, f: string) => `url(data:font/woff2;base64,${fs.readFileSync(r("assets/fonts", f)).toString("base64")})`);
const cssTmp = path.join(os.tmpdir(), `nc-styles-${process.pid}.css`);
fs.writeFileSync(cssTmp, cssSrc);
const css = await Bun.build({ entrypoints: [cssTmp], minify: true });
fs.rmSync(cssTmp, { force: true });
if (!css.success) for (const l of css.logs) console.error(l);
const appCss = css.success ? await css.outputs[0].text() : cssSrc;
const html = fs.readFileSync(r("ui/index.html"), "utf8").replaceAll("__VERSION__", VERSION);
const ico = fs.readFileSync(r("assets/icon.ico")).toString("base64");
const png = fs.readFileSync(r("assets/icon-128.png")).toString("base64");

const gen = `// Сгенерировано scripts/build.ts — не редактировать.
const ICO = ${JSON.stringify(ico)};
export const ICON_ICO_BASE64 = ICO;
export const UI_FILES: Record<string, { data: string; base64?: boolean }> = {
  "index.html": { data: ${JSON.stringify(html)} },
  "app.js": { data: ${JSON.stringify(appJs)} },
  "app.css": { data: ${JSON.stringify(appCss)} },
  "icon.png": { data: ${JSON.stringify(png)}, base64: true },
  "favicon.ico": { data: ICO, base64: true },
  "favicon-${VERSION}.ico": { data: ICO, base64: true },
};
`;
fs.writeFileSync(r("src/ui-assets.gen.ts"), gen);
console.log(`  app.js ${(appJs.length / 1024).toFixed(0)} КБ, app.css ${(appCss.length / 1024).toFixed(0)} КБ`);

if (args.has("--dev")) {
  step("Запуск сервера (Ctrl+C — выход)");
  spawnSync(process.execPath, [r("src/main.ts"), "--headless", "--port", "47821"], { stdio: "inherit" });
  process.exit(0);
}
if (!wantExe) process.exit(0);

// ───── 2. Среда выполнения Windows с иконкой и описанием ─────
step("Подготовка среды выполнения Windows (иконка, версия)");
const bunVer = Bun.version;
const cacheDir = path.join(os.homedir(), ".bun", "install", "cache");
// Native Windows builds use the running Bun executable; a same-target compile may not populate the cross-compile cache.
let runtime = process.platform === "win32" ? process.execPath : path.join(cacheDir, `bun-windows-x64-v${bunVer}`);
if (!fs.existsSync(runtime)) {
  // скачиваем базовую среду, собрав пустой файл
  const tmp = path.join(os.tmpdir(), "nc-warmup.ts");
  fs.writeFileSync(tmp, "console.log(1)");
  const warmup = spawnSync(process.execPath, ["build", tmp, "--compile", "--target=bun-windows-x64", "--outfile", path.join(os.tmpdir(), "nc-warmup.exe")], { stdio: "inherit" });
  if (warmup.error || warmup.status !== 0) throw new Error(`Не удалось подготовить Windows runtime: ${warmup.error?.message || warmup.status}`);
}
if (!fs.existsSync(runtime)) throw new Error(`Не найдена среда ${runtime}`);
if (fs.statSync(runtime).isDirectory()) runtime = path.join(runtime, fs.readdirSync(runtime).find((f) => f.endsWith(".exe")) ?? "bun.exe");

const exe = ResEdit.NtExecutable.from(fs.readFileSync(runtime), { ignoreCert: true });
const res = ResEdit.NtExecutableResource.from(exe);
const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(r("assets/icon.ico")));
const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
const gid = groups[0]?.id ?? 1;
const glang = groups[0]?.lang ?? 1033;
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
  res.entries,
  gid,
  glang,
  iconFile.icons.map((i) => i.data),
);
const [maj, min, pat] = VERSION.split("-")[0].split(".").map(Number);
const vis = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
const vi = vis[0] ?? ResEdit.Resource.VersionInfo.createEmpty();
const lang = { lang: 1033, codepage: 1200 };
vi.setFileVersion(maj, min, pat, 0, 1033);
vi.setProductVersion(maj, min, pat, 0, 1033);
vi.setStringValues(lang, {
  CompanyName: "Jarvis Code",
  FileDescription: "Jarvis Code",
  ProductName: "Jarvis Code",
  InternalName: "JarvisCode",
  OriginalFilename: "JarvisCode.exe",
  LegalCopyright: "Jarvis Code",
  FileVersion: VERSION,
  ProductVersion: VERSION,
});
vi.outputToResourceEntries(res.entries);
res.outputResource(exe);
const patched = path.join(os.tmpdir(), `nc-runtime-${bunVer}.exe`);
fs.writeFileSync(patched, Buffer.from(exe.generate()));

// ───── 3. Компиляция ─────
step("Компиляция JarvisCode.exe");
fs.mkdirSync(r("dist"), { recursive: true });
const out = r("dist", "JarvisCode.exe");
// источник обновлений «из коробки» (см. src/version.ts)
const updDefines: string[] = [];
{
  const repo = (process.env.JC_UPDATE_REPO ?? "").trim().replace(/^https:\/\/github\.com\//, "").replace(/\/$/, "");
  const url = (process.env.JC_UPDATE_URL ?? "").trim();
  if (repo && !/^[A-Za-z0-9-]+\/[\w.-]+$/.test(repo)) {
    console.error(`  JC_UPDATE_REPO: ожидается owner/repo, получено «${repo}»`);
    process.exit(1);
  }
  if (url && !/^https:\/\/[^\s"]+$/.test(url)) {
    console.error("  JC_UPDATE_URL: нужен адрес https://…/latest.json");
    process.exit(1);
  }
  updDefines.push("--define", `process.env.JC_UPDATE_REPO=${JSON.stringify(repo)}`, "--define", `process.env.JC_UPDATE_URL=${JSON.stringify(url)}`);
  console.log(`  обновления: ${url || (repo ? `github.com/${repo}` : "источник не вшит (задайте JC_UPDATE_REPO или JC_UPDATE_URL)")}`);
}
const b = spawnSync(
  process.execPath,
  [
    "build",
    r("src/main.ts"),
    "--compile",
    "--target=bun-windows-x64",
    "--windows-hide-console",
    "--minify",
    `--compile-executable-path=${patched}`,
    "--define",
    'process.env.NODE_ENV="production"',
    ...updDefines,
    "--outfile",
    out,
  ],
  { stdio: "inherit", cwd: ROOT },
);
if (b.status !== 0) process.exit(b.status ?? 1);
sign(out);
fs.copyFileSync(out, r("dist", "JarvisCodeSetup.exe"));
console.log(`  ${out} — ${(fs.statSync(out).size / 1024 / 1024).toFixed(1)} МБ`);

// ───── 4. Архив для пользователей ─────
if (wantRelease) {
  step("Архивы release/");
  const rel = r("release");
  fs.rmSync(rel, { recursive: true, force: true });
  // docs/ — необязательные файлы для пользователя рядом с установщиком (может отсутствовать)
  const docs = (fs.existsSync(r("docs")) ? fs.readdirSync(r("docs")) : []).map((f) => [f, r("docs", f)] as [string, string]);
  writeZip(path.join(rel, "JarvisCodeSetup.zip"), [["JarvisCodeSetup.exe", r("dist", "JarvisCodeSetup.exe")], ...docs]);
  // для автообновления: exe + latest.json + SHA256SUMS.txt — загрузите их в релиз GitHub или на свой HTTPS-сервер
  const setup = r("dist", "JarvisCodeSetup.exe");
  fs.copyFileSync(setup, path.join(rel, "JarvisCodeSetup.exe"));
  const sha = crypto.createHash("sha256").update(fs.readFileSync(setup)).digest("hex");
  const manifest = { version: VERSION, url: "JarvisCodeSetup.exe", sha256: sha, size: fs.statSync(setup).size, date: new Date().toISOString(), notes: releaseNotes(VERSION) };
  fs.writeFileSync(path.join(rel, "latest.json"), JSON.stringify(manifest, null, 2) + "\n");
  fs.writeFileSync(path.join(rel, "SHA256SUMS.txt"), `${sha}  JarvisCodeSetup.exe\n`);
  const skip = /^(node_modules|dist|release|shots|\.git|\.tmp)(\/|$)|^src\/ui-assets\.gen\.ts$/;
  writeZip(
    path.join(rel, "JarvisCode-source.zip"),
    listFiles(ROOT, (p) => skip.test(p)).map(([n, f]) => [`jarvis-code/${n}`, f]),
  );
  for (const f of fs.readdirSync(rel)) console.log(`  ${f} — ${(fs.statSync(path.join(rel, f)).size / 1024 / 1024).toFixed(1)} МБ`);
}

// ───── вспомогательное ─────

/** Раздел CHANGELOG.md для этой версии — в заметки к обновлению. */
function releaseNotes(version: string): string {
  try {
    const md = fs.readFileSync(r("CHANGELOG.md"), "utf8");
    const at = md.search(new RegExp(`^## \\[?${version.replace(/\./g, "\\.")}\\b`, "m"));
    if (at < 0) return "";
    const rest = md.slice(at).split("\n").slice(1);
    const end = rest.findIndex((l) => /^## /.test(l));
    return (end < 0 ? rest : rest.slice(0, end)).join("\n").trim().slice(0, 4000);
  } catch {
    return "";
  }
}

/** Подпись Authenticode. Без сертификата — пропускается (exe работает, но SmartScreen предупредит). */
function sign(file: string): boolean {
  const cmd = process.env.JC_SIGN_CMD;
  const cert = process.env.JC_SIGN_CERT;
  const pass = process.env.JC_SIGN_PASS ?? "";
  const ts = process.env.JC_SIGN_TIMESTAMP ?? "http://timestamp.digicert.com";
  const run = (bin: string, a: string[], shell = false) => {
    const res = spawnSync(bin, a, { stdio: ["ignore", "inherit", "inherit"], shell });
    if (res.status !== 0) throw new Error(`${bin}: код ${res.status ?? res.error?.message}`);
  };
  try {
    if (cmd) {
      run(cmd.replaceAll("{file}", JSON.stringify(file)), [], true);
    } else if (cert) {
      if (process.platform === "win32") {
        run("signtool", ["sign", "/f", cert, ...(pass ? ["/p", pass] : []), "/fd", "SHA256", "/tr", ts, "/td", "SHA256", "/d", "Jarvis Code", file]);
      } else {
        const tmp = file + ".signed";
        run("osslsigncode", ["sign", "-pkcs12", cert, ...(pass ? ["-pass", pass] : []), "-n", "Jarvis Code", "-h", "sha256", "-ts", ts, "-in", file, "-out", tmp]);
        fs.renameSync(tmp, file);
      }
    } else {
      console.log("  подпись: пропущена (задайте JC_SIGN_CERT или JC_SIGN_CMD)");
      return false;
    }
    console.log("  подпись: ✓");
    return true;
  } catch (e) {
    console.error(`  подпись не удалась: ${(e as Error).message}`);
    if (process.env.JC_SIGN_REQUIRED) process.exit(1);
    return false;
  }
}

