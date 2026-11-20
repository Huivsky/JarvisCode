// Автозагрузка ngrok: распаковка zip, проверки, загрузка с локального сервера и запуск туннеля после неё.
// Запуск: bun test/ngrok.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
process.env.JARVIS_CODE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jc-home-"));
process.env.NGROK_CONFIG = path.join(process.env.JARVIS_CODE_HOME, "no-ngrok.yml");
delete process.env.NGROK_AUTHTOKEN;

let failed = 0;
let passed = 0;
const check = (name: string, ok: boolean, extra?: unknown) => (ok ? passed++ : (failed++, console.log(`✗ ${name}`, extra ?? "")));

function crc32(buf: Buffer) {
  let c = 0xffffffff;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}
function makeZip(files: { name: string; data: Buffer; store?: boolean; badCrc?: boolean }[]) {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let off = 0;
  for (const f of files) {
    const comp = f.store ? f.data : zlib.deflateRawSync(f.data);
    const name = Buffer.from(f.name);
    const crc = crc32(f.data) ^ (f.badCrc ? 1 : 0);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(f.store ? 0 : 8, 8);
    lh.writeUInt32LE(crc >>> 0, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(f.store ? 0 : 8, 10);
    ch.writeUInt32LE(crc >>> 0, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(off, 42);
    locals.push(lh, name, comp);
    central.push(ch, name);
    off += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

const fake = Buffer.from(`#!/bin/sh\necho "ngrok version 3.99.0"\n#${"x".repeat(1_200_000)}\n`);
const good = makeZip([{ name: "README.txt", data: Buffer.from("hi") }, { name: "ngrok", data: fake }]);
const zips: Record<string, Buffer> = {
  "/good.zip": good,
  "/stored.zip": makeZip([{ name: "ngrok", data: fake, store: true }]),
  "/badcrc.zip": makeZip([{ name: "ngrok", data: fake, badCrc: true }]),
  "/empty.zip": makeZip([{ name: "other.exe", data: fake }]),
  "/small.zip": makeZip([{ name: "ngrok", data: Buffer.from("#!/bin/sh\necho ngrok version 3\n") }]),
  "/notrun.zip": makeZip([{ name: "ngrok", data: Buffer.from(`#!/bin/sh\nexit 3\n#${"y".repeat(1_100_000)}\n`) }]),
};
let hits = 0;
const srv = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    hits++;
    const z = zips[new URL(req.url).pathname];
    return z ? new Response(new Uint8Array(z), { headers: { "content-length": String(z.length) } }) : new Response("nope", { status: 404 });
  },
});
const base = `http://127.0.0.1:${srv.port}`;

const { extractFromZip, downloadNgrok, ngrokTarget, ngrokDownloadUrl } = await import("../src/ngrok-download");
const { Tunnel } = await import("../src/tunnel");
const { defaultConfig } = await import("../src/config");

// распаковка
const e1 = extractFromZip(good, (n) => n === "ngrok");
check("zip deflate: нашёл ngrok", !!e1 && e1.data.equals(fake));
const e2 = extractFromZip(zips["/stored.zip"], (n) => n === "ngrok");
check("zip store", !!e2 && e2.data.equals(fake));
let threw = "";
try {
  extractFromZip(zips["/badcrc.zip"], (n) => n === "ngrok");
} catch (e) {
  threw = (e as Error).message;
}
check("zip: битая CRC отклонена", /контрольная/.test(threw), threw);
threw = "";
try {
  extractFromZip(Buffer.from("not a zip at all, definitely not a zip file"), () => true);
} catch (e) {
  threw = (e as Error).message;
}
check("zip: мусор отклонён", /повреждён/.test(threw), threw);

// адреса
delete process.env.NC_NGROK_URL;
check("URL windows amd64 / arm64 официальные", /^https:\/\/bin\.equinox\.io\/c\/bNyj1mQVY4c\/ngrok-v3-stable-\w+-amd64\.zip$/.test(ngrokDownloadUrl("x64")) && ngrokDownloadUrl("arm64").endsWith("-arm64.zip"));

async function dl(name: string) {
  process.env.NC_NGROK_URL = base + name;
  try {
    const progress: any[] = [];
    const exe = await downloadNgrok((p) => progress.push(p));
    return { exe, progress, err: "" };
  } catch (e) {
    return { exe: "", progress: [], err: (e as Error).message };
  }
}
for (const [name, re] of [
  ["/badcrc.zip", /контрольная/],
  ["/empty.zip", /нет ngrok/],
  ["/small.zip", /маленький/],
  ["/notrun.zip", /не запускается/],
  ["/missing.zip", /404/],
] as const) {
  const r = await dl(name);
  check(`загрузка ${name} отклонена`, !r.exe && re.test(r.err), r.err);
  check(`${name}: файла нет`, !fs.existsSync(ngrokTarget()) && !fs.existsSync(ngrokTarget() + ".part"));
}
const ok = await dl("/good.zip");
check("загрузка: путь в папке данных", ok.exe === ngrokTarget() && ok.exe.startsWith(process.env.JARVIS_CODE_HOME!), ok);
check("загрузка: файл на месте и исполняемый", fs.existsSync(ok.exe) && (fs.statSync(ok.exe).mode & 0o111) !== 0);
check("загрузка: прогресс до конца", ok.progress.length > 0 && ok.progress.at(-1).got === good.length && ok.progress.at(-1).total === good.length, ok.progress.at(-1));

// туннель: ngrok не найден → скачивает сам → просит authtoken
fs.rmSync(ngrokTarget(), { force: true });
process.env.NC_NGROK_URL = base + "/good.zip";
const cfg = defaultConfig();
cfg.bridge.provider = "ngrok";
cfg.bridge.ngrokPath = "";
cfg.bridge.ngrokAuthtoken = "";
const hasSystemNgrok = (await import("../src/tunnel")).findNgrok(cfg);
if (hasSystemNgrok) console.log("(ngrok уже установлен в системе — проверка туннеля пропущена)");
else {
  const states: string[] = [];
  const t = new Tunnel(() => states.push(`${t.state.status}${t.state.download ? ":dl" : ""}${t.state.hint ? ":" + t.state.hint : ""}`));
  let installed = "";
  t.onNgrokInstalled = (exe) => (installed = exe);
  const t0 = Date.now();
  await t.start(cfg, 45999);
  check("туннель: start не ждёт загрузку", Date.now() - t0 < 5000);
  for (let i = 0; i < 100 && t.state.status === "starting"; i++) await Bun.sleep(100);
  check("туннель: шла загрузка", states.some((s) => s.includes(":dl")), states);
  check("туннель: после загрузки — запрос authtoken", t.state.status === "error" && t.state.hint === "ngrok-auth" && /скачан/.test(t.state.error ?? ""), t.state);
  check("туннель: путь сохранён", installed === ngrokTarget() && !t.state.download);
  await t.stop();

  // неудачная загрузка → подсказка ngrok-missing, без бесконечных повторов
  fs.rmSync(ngrokTarget(), { force: true });
  process.env.NC_NGROK_URL = base + "/missing.zip";
  const t2 = new Tunnel(() => {});
  await t2.start(cfg, 45999);
  for (let i = 0; i < 100 && t2.state.status === "starting"; i++) await Bun.sleep(100);
  check("туннель: ошибка загрузки → ngrok-missing", t2.state.status === "error" && t2.state.hint === "ngrok-missing" && /скачать/.test(t2.state.error ?? ""), t2.state);
  const before = hits;
  await t2.start(cfg, 45999);
  await Bun.sleep(200);
  check("туннель: повтор сам не качает сразу", hits === before && t2.state.hint === "ngrok-missing");
  process.env.NC_NGROK_URL = base + "/good.zip";
  await t2.downloadAndStart(cfg, 45999);
  for (let i = 0; i < 100 && t2.state.status === "starting"; i++) await Bun.sleep(100);
  check("туннель: кнопка «Скачать» качает снова", hits > before && t2.state.hint === "ngrok-auth", t2.state);
  await t2.stop();
}

srv.stop(true);
console.log(`ngrok: ${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
