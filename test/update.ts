// Проверки обновлений и отчётов о сбоях: версии, latest.json, GitHub, SHA-256, обезличивание, отправка.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const home = fs.mkdtempSync(path.join(os.tmpdir(), "jc-upd-"));
process.env.JARVIS_CODE_HOME = home;
const { Updater, cmpVersion, allowedUrl, releaseFromManifest, releaseFromGitHub, UPDATES_DIR, updateSource, sourceLabel } = await import("../src/updater");
const { defaultConfig } = await import("../src/config");
const crash = await import("../src/crash");
const { VERSION } = await import("../src/version");

let failed = 0;
let passed = 0;
const check = (name: string, ok: boolean, extra?: unknown) => (ok ? passed++ : (failed++, console.log(`✗ ${name}`, extra ?? "")));

// ── версии ──
check("3.0.1 > 3.0.0", cmpVersion("3.0.1", "3.0.0") === 1);
// источник обновлений: настройки важнее вшитого при сборке
{
  const none = { repo: "", manifestUrl: "" };
  const built = { repo: "acme/jarvis", manifestUrl: "" };
  const s1 = updateSource(none, built);
  check("пусто → встроенный репозиторий", s1.repo === "acme/jarvis" && s1.builtin && sourceLabel(s1) === "github.com/acme/jarvis", s1);
  const s2 = updateSource({ repo: "me/fork", manifestUrl: "" }, built);
  check("свой репозиторий важнее встроенного", s2.repo === "me/fork" && !s2.builtin, s2);
  const s3 = updateSource({ repo: "me/fork", manifestUrl: "https://x.dev/latest.json" }, built);
  check("latest.json важнее репозитория", s3.manifestUrl === "https://x.dev/latest.json" && s3.repo === "", s3);
  const s4 = updateSource(none, { repo: "acme/jarvis", manifestUrl: "https://acme.dev/latest.json" });
  check("встроенный latest.json важнее встроенного репозитория", s4.manifestUrl === "https://acme.dev/latest.json" && s4.repo === "", s4);
  const s5 = updateSource(none, none);
  check("ничего не задано → не настроено", !s5.repo && !s5.manifestUrl && !s5.builtin, s5);
}
check("v3.0.0 == 3.0.0", cmpVersion("v3.0.0", "3.0.0") === 0);
check("3.10.0 > 3.9.9", cmpVersion("3.10.0", "3.9.9") === 1);
check("3.0.0-beta < 3.0.0", cmpVersion("3.0.0-beta.2", "3.0.0") === -1);
check("2.9 < 3.0.0", cmpVersion("2.9", "3.0.0") === -1);
check("https разрешён", allowedUrl("https://example.com/a.exe"));
check("http запрещён", !allowedUrl("http://example.com/a.exe"));
check("localhost разрешён", allowedUrl("http://127.0.0.1:8080/x"));
check("file запрещён", !allowedUrl("file:///C:/x.exe"));

// ── локальный «сервер обновлений» ──
const next = VERSION.replace(/\d+$/, (n) => String(Number(n) + 1));
const payload = crypto.randomBytes(300_000);
const sha = crypto.createHash("sha256").update(payload).digest("hex");
let manifest: any = { version: next, url: "JarvisCodeSetup.exe", sha256: sha, notes: "Исправления", size: payload.length };
let posted: any = null;
let base = "";
const srv = Bun.serve({
  port: 0,
  async fetch(req): Promise<Response> {
    const u = new URL(req.url);
    if (u.pathname === "/latest.json") return Response.json(manifest);
    if (u.pathname === "/JarvisCodeSetup.exe") return new Response(payload, { headers: { "content-length": String(payload.length) } });
    if (u.pathname === "/bad.exe") return new Response(crypto.randomBytes(1000));
    if (u.pathname === "/repos/me/jc/releases/latest")
      return Response.json({
        tag_name: "v" + next,
        body: "## Что нового",
        published_at: "2026-01-01T00:00:00Z",
        assets: [
          { name: "JarvisCodeSetup.zip", browser_download_url: `${base}/x.zip`, size: 1 },
          { name: "JarvisCodeSetup.exe", browser_download_url: `${base}/JarvisCodeSetup.exe`, size: payload.length, digest: `sha256:${sha}` },
        ],
      });
    if (u.pathname === "/repos/me/nodigest/releases/latest")
      return Response.json({
        tag_name: next,
        assets: [
          { name: "JarvisCodeSetup.exe", browser_download_url: `${base}/JarvisCodeSetup.exe`, size: payload.length },
          { name: "SHA256SUMS.txt", browser_download_url: `${base}/sums.txt` },
        ],
      });
    if (u.pathname === "/sums.txt") return new Response(`${sha}  JarvisCodeSetup.exe\n`);
    if (u.pathname === "/crash") {
      posted = await req.json();
      return Response.json({ ok: true });
    }
    return new Response("nf", { status: 404 });
  },
});
base = `http://127.0.0.1:${srv.port}`;

const r1 = await releaseFromManifest(`${base}/latest.json`);
check("latest.json: относительный url", r1.url === `${base}/JarvisCodeSetup.exe`, r1.url);
check("latest.json: sha256", r1.sha256 === sha);
const g1 = await releaseFromGitHub("me/jc", undefined, base);
check("GitHub: setup.exe и digest", g1.url.endsWith("/JarvisCodeSetup.exe") && g1.sha256 === sha && g1.version === next, g1);
const g2 = await releaseFromGitHub("me/nodigest", undefined, base);
check("GitHub: хеш из SHA256SUMS", g2.sha256 === sha, g2);
let bad = "";
await releaseFromGitHub("../etc", undefined, base).catch((e) => (bad = e.message));
check("GitHub: неверный repo", /owner\/repo/.test(bad));

// ── обновлятор: проверка → автозагрузка → готово ──
const { controls } = await import("../src/control-center");
controls.setUpdatePolicy({channel: "beta",requireSignature:false,publisher:""});
const cfg = defaultConfig();
cfg.update.manifestUrl = `${base}/latest.json`;
const events: string[] = [];
let quit = 0;
const up = new Updater({ cfg: () => cfg, save: () => {}, emit: (u) => events.push(u.status), quit: () => quit++, hasWindow: () => true, installDir: () => home });
const info = await up.check(false);
check("найдено обновление", info.status === "available" || info.status === "downloading" || info.status === "ready", info);
for (let i = 0; i < 50 && up.info.status !== "ready"; i++) await Bun.sleep(50);
check("скачано и проверено", up.info.status === "ready", up.info);
const file = path.join(UPDATES_DIR, `JarvisCodeSetup-${next}.exe`);
check("файл на месте и совпадает", fs.existsSync(file) && crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") === sha);
check("статусы по порядку", events.includes("checking") && events.includes("downloading") && events.at(-1) === "ready", events);
check("нет .part", !fs.readdirSync(UPDATES_DIR).some((n) => n.endsWith(".part")));

// после «перезапуска» — не качаем заново
const up2 = new Updater({ cfg: () => cfg, save: () => {}, emit: () => {}, quit: () => {}, hasWindow: () => false, installDir: () => home });
const i2 = await up2.check(true);
check("повторный запуск: сразу готово", i2.status === "ready", i2);

// подмена файла на диске перед установкой
fs.writeFileSync(file, "tampered");
let tamper = "";
await up2.install().catch((e) => (tamper = e.message));
check("подменённый файл не запускается", /изменился/.test(tamper) && !fs.existsSync(file), tamper);
check("выход не вызван", quit === 0);

// неверная контрольная сумма при загрузке
manifest = { version: next, url: `${base}/bad.exe`, sha256: sha };
const up3 = new Updater({ cfg: () => cfg, save: () => {}, emit: () => {}, quit: () => {}, hasWindow: () => true, installDir: () => home });
await up3.check(false);
for (let i = 0; i < 50 && up3.info.status === "downloading"; i++) await Bun.sleep(50);
check("битый файл отклонён", up3.info.status === "error" && /контрольная сумма/.test(up3.info.error ?? ""), up3.info);
check("битый файл удалён", !fs.readdirSync(UPDATES_DIR).some((n) => n.includes(next)));

// без SHA-256 — не скачиваем
manifest = { version: next, url: "JarvisCodeSetup.exe" };
const up4 = new Updater({ cfg: () => cfg, save: () => {}, emit: () => {}, quit: () => {}, hasWindow: () => true, installDir: () => home });
await up4.check(false);
check("без хеша: только «доступно»", up4.info.status === "available", up4.info);
let nohash = "";
await up4.install().catch((e) => (nohash = e.message));
check("без хеша: установка запрещена", /SHA-256/.test(nohash), nohash);

// не по HTTPS
manifest = { version: next, url: "http://evil.example/x.exe", sha256: sha };
const up5 = new Updater({ cfg: () => cfg, save: () => {}, emit: () => {}, quit: () => {}, hasWindow: () => true, installDir: () => home });
await up5.check(false);
check("http-ссылка отклонена", up5.info.status === "error" && /HTTPS/.test(up5.info.error ?? ""), up5.info);

// та же версия — «последняя»
manifest = { version: VERSION, url: "JarvisCodeSetup.exe", sha256: sha };
const up6 = new Updater({ cfg: () => cfg, save: () => {}, emit: () => {}, quit: () => {}, hasWindow: () => true, installDir: () => home });
check("актуальная версия", (await up6.check(false)).status === "uptodate");

// пропуск версии
manifest = { version: next, url: "JarvisCodeSetup.exe" };
const up7 = new Updater({ cfg: () => cfg, save: () => {}, emit: () => {}, quit: () => {}, hasWindow: () => true, installDir: () => home });
await up7.check(false);
up7.skip();
check("пропуск запомнен", cfg.update.skipped === next && up7.info.skipped === true);
check("после пропуска — без напоминаний", (await up7.check(true)).skipped === true);

// ── отчёты о сбоях ──
const ntnToken = "ntn_" + "x".repeat(40);
crash.setCrashConfig(() => cfg);
const user = os.userInfo().username;
const e = new Error(`fail at ${os.homedir()}${path.sep}secret.txt token ${ntnToken} https://abc.ngrok-free.app/mcp/${"f".repeat(48)} me@mail.ru`);
const rep = crash.recordCrash(e, "uncaughtException")!;
const raw = fs.readFileSync(path.join(crash.CRASH_DIR, rep.id + ".json"), "utf8");
check("отчёт сохранён", !!rep && raw.includes('"uncaughtException"'));
check("без токена", !raw.includes(ntnToken));
check("без домашней папки", !raw.includes(os.homedir()));
check("без имени пользователя", user.length <= 2 || !new RegExp(`\\b${user}\\b`).test(raw.replace(/<user>/g, "")), raw.slice(0, 300));
check("без адреса туннеля и ключа", !raw.includes("ngrok-free.app") && !raw.includes("f".repeat(48)));
check("без почты", !raw.includes("me@mail.ru"));
check("дубликат не пишется", crash.recordCrash(e, "uncaughtException") === null);
check("свежий сбой не показывается как «прошлый»", crash.pendingCrashes().length === 0);
// отчёт «с прошлого запуска»
const old = { ...rep, id: "old-1", at: crash.STARTED_AT - 60_000 };
fs.writeFileSync(path.join(crash.CRASH_DIR, "old-1.json"), JSON.stringify(old));
fs.writeFileSync(path.join(crash.CRASH_DIR, "old-2.json"), JSON.stringify({ ...old, id: "old-2", kind: "unhandledRejection" }));
const pend = crash.pendingCrashes();
check("прошлый сбой виден (без unhandledRejection)", pend.length === 1 && pend[0].id === "old-1", pend);
const s0 = await crash.sendCrashes(["old-1"], "");
check("без адреса — не отправляется", !s0.ok && /адрес/.test(s0.error ?? ""));
const s1 = await crash.sendCrashes(["old-1"], "http://example.com/crash");
check("не https — не отправляется", !s1.ok);
const s2 = await crash.sendCrashes(["old-1"], `${base}/crash`);
check("отправлено", s2.ok && s2.sent === 1 && posted?.reports?.[0]?.id === "old-1", s2);
check("в отправке нет служебных полей", posted && !("seen" in posted.reports[0]) && posted.version === VERSION);
check("после отправки не показывается", crash.pendingCrashes().length === 0);
crash.markCrashes(undefined, { seen: true });
check("dismiss всех", crash.pendingCrashes().length === 0);

srv.stop(true);
console.log(`${failed ? "✗" : "✓"} обновления и сбои: ${passed} проверок прошло, ${failed} упало`);
process.exit(failed ? 1 : 0);
