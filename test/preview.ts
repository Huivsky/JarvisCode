/**
 * Предпросмотр интерфейса с поддельным агентом в чате Notion (через MCP моста) — для скриншотов и ручной проверки.
 *   bun scripts/build.ts && bun test/preview.ts
 * Печатает JSON с адресами: app (мост подключён, есть чаты), fresh (первый запуск), installer.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "nc-preview-"));
const homeA = path.join(root, "home-app");
const homeB = path.join(root, "home-fresh");
const project = path.join(root, "my-project");
fs.mkdirSync(path.join(project, "src"), { recursive: true });
fs.writeFileSync(path.join(project, "README.md"), "# My project\n");
fs.writeFileSync(path.join(project, "package.json"), '{"name":"my-project"}\n');
fs.mkdirSync(homeA, { recursive: true });
fs.writeFileSync(
  path.join(homeA, "config.json"),
  JSON.stringify({
    userName: "Draizons",
    effort: "normal",
    project,
    recentProjects: [project, os.homedir()],
    bridge: { enabled: true, mode: "ask", project, provider: "manual", publicUrl: "https://draizons-pc.ngrok-free.app", connectedAt: Date.now() },
    mcp: { port: 20000 + Math.floor(Math.random() * 20000) },
  }),
);

// 3.1: чат со снимком экрана и корзиной (готовая картинка «экрана» рисуется ImageMagick, если он есть)
{
  const shots = path.join(homeA, "screenshots");
  fs.mkdirSync(shots, { recursive: true });
  const img = path.join(shots, "screen-demo.jpg");
  try {
    Bun.spawnSync([
      "magick", "-size", "1600x900", "gradient:#22304f-#0d1322",
      "-fill", "#1e1e1e", "-draw", "roundrectangle 220,110 1380,780 12,12",
      "-fill", "#2d2d2d", "-draw", "roundrectangle 220,110 1380,150 12,12", "-draw", "rectangle 220,135 1380,150",
      "-font", "Liberation-Mono", "-pointsize", "19", "-fill", "#cccccc", "-annotate", "+240+137", "Windows PowerShell",
      "-fill", "#d4d4d4", "-annotate", "+250+200", "PS D:\\\\dev\\\\my-project> npm run build",
      "-annotate", "+250+235", "> my-project@1.0.0 build",
      "-fill", "#f14c4c", "-annotate", "+250+285", "Error: Cannot find module './auth'",
      "-annotate", "+250+315", "Require stack:",
      "-annotate", "+270+345", "- D:\\\\dev\\\\my-project\\\\src\\\\index.ts",
      "-fill", "#d4d4d4", "-annotate", "+250+395", "npm ERR! code 1",
      "-fill", "#1f6feb", "-draw", "rectangle 0,860 1600,900",
      img,
    ]);
  } catch {}
  const at = Date.now() - 3_600_000;
  const it = (i: number, x: object) => ({ id: `demo${i}`, at: at + i * 4000, ...x });
  fs.mkdirSync(path.join(homeA, "chats"), { recursive: true });
  fs.writeFileSync(
    path.join(homeA, "chats", "cdemoshot01.json"),
    JSON.stringify({
      id: "cdemoshot01",
      title: "Что за ошибка на экране",
      createdAt: at,
      updatedAt: at + 60_000,
      mode: "ask",
      project,
      items: [
        it(1, { kind: "user", text: "Посмотри, что за ошибка у меня на экране" }),
        it(2, { kind: "approval", approval: { source: "local", heading: "Снимок экрана", summary: "основной монитор", pattern: "observe:nc_screenshot", reason: "Агент увидит экран (всё, что сейчас открыто).", risk: "medium", answer: "always" } }),
        it(3, { kind: "tool", tool: "nc_screenshot", label: "Снимок экрана", summary: "основной монитор", status: "ok", ms: 1180, result: "Снимок экрана 1920×1080", output: `Снимок экрана 1920×1080: ${img.replace(/\.jpg$/, ".png")}`, ...(fs.existsSync(img) ? { preview: img } : {}) }),
        it(4, { kind: "assistant", text: "На экране — ошибка сборки: `Cannot find module './auth'` в `src/index.ts`. Модуль `src/auth.ts` не существует — его импортируют, но файл не создан.\n\nСоздать `src/auth.ts` с проверкой токена?", agentStatus: "NEED_INPUT" }),
        it(5, { kind: "user", text: "Сначала удали старые логи сборки в корзину" }),
        it(6, { kind: "tool", tool: "nc_trash", label: "В корзину", summary: "3 объекта: build.log, build.1.log, build.2.log", status: "ok", ms: 640, result: "В корзину: 3" }),
        it(7, { kind: "assistant", text: "Готово — три старых лога в корзине, их можно восстановить.", agentStatus: "DONE" }),
      ],
    }),
  );
}

// чат, где пересылка оборвалась (ошибка + «Повторить»)
{
  const at = Date.now() - 7_200_000;
  fs.writeFileSync(
    path.join(homeA, "chats", "cdemoerr001.json"),
    JSON.stringify({
      id: "cdemoerr001",
      title: "Ревью незакоммиченных изменений",
      createdAt: at,
      updatedAt: at + 30_000,
      mode: "ask",
      project,
      items: [
        { id: "e1", at, kind: "user", text: "Сделай ревью незакоммиченных изменений" },
        { id: "e2", at: at + 30_000, kind: "error", text: "Пересылка через чат Notion: агент в чате Notion не ответил за 10 мин — возможно, чат Notion закрыт или агент остановился." },
      ],
    }),
  );
}

// свои «/»-команды: личная и команда проекта
fs.mkdirSync(path.join(homeA, "commands"), { recursive: true });
fs.writeFileSync(path.join(homeA, "commands", "standup.md"), "---\ndescription: Сводка за вчера для стендапа\n---\nСобери по git log за вчера, что сделано, и что в работе.\n");
fs.mkdirSync(path.join(project, ".jarvis", "commands"), { recursive: true });
fs.writeFileSync(path.join(project, ".jarvis", "commands", "deploy.md"), "---\ndescription: Собрать и выкатить\n---\nСобери проект и выкати на $ARGUMENTS.\n");

const FINAL_EDIT = `Готово: проверка токена вынесена в \`src/auth.ts\`, \`src/index.ts\` её использует, в README — короткая заметка.

Проверьте сборку: \`npm run build\`.`;

const FINAL = `## Состояние дисков

| Диск | Свободно | Всего | Заполнено |
|---|---:|---:|---:|
| C: | 112 ГБ | 476 ГБ | 76 % |
| D: | 640 ГБ | 931 ГБ | 31 % |

Больше всего места занимает \`C:\\Users\\Draizons\\Downloads\` — **58 ГБ**:

1. **Видео** — 38 ГБ (старые записи экрана)
2. **Установщики** — 21 ГБ, половина устарела

Временные файлы можно очистить так:

\`\`\`powershell
# очистка временной папки пользователя
Remove-Item "$env:TEMP\\*" -Recurse -Force -ErrorAction SilentlyContinue
\`\`\`

Хотите, разберу «Загрузки» по папкам?`;

async function launch(home: string, extra: string[] = []) {
  const proc = Bun.spawn([process.execPath, path.join(import.meta.dir, "../src/main.ts"), "--headless", "--port", "0", ...extra], {
    env: { ...process.env, JARVIS_CODE_HOME: home },
    stdout: "pipe",
    stderr: "inherit",
  });
  const rd = proc.stdout.getReader();
  let out = "";
  for (;;) {
    const { value, done } = await rd.read();
    if (done) throw new Error("app exited: " + out);
    out += new TextDecoder().decode(value);
    const m = out.match(/(http:\/\/127\.0\.0\.1:\d+\/)#t=([a-f0-9]+)/);
    if (m) return { base: m[1], token: m[2] };
  }
}

const A = await launch(homeA);
const call = (p: string, body?: unknown) =>
  fetch(A.base + "api/" + p, { method: body ? "POST" : "GET", headers: { "x-nc-token": A.token, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());

// ждём адрес моста (туннель manual — локальный адрес есть сразу)
let st: any = await call("state");
for (let i = 0; i < 50 && !st.bridge?.localUrl; i++) {
  await Bun.sleep(100);
  st = await call("state");
}
// мост: вызовы «из Notion» — поддельный агент в чате Notion
const mcp = (method: string, params: object, id = Math.floor(Math.random() * 1e6)) =>
  fetch(st.bridge.localUrl, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) }).then((r) => r.json());
const tool = async (name: string, args: object = {}) => {
  const r: any = await mcp("tools/call", { name, arguments: args });
  return String(r.result?.content?.[0]?.text ?? "");
};
await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Notion", version: "1" } });

// перенос чата «из Notion»: агент сам передаёт переписку (nc_import)
await tool("nc_import", {
  title: "План запуска лендинга",
  summary: "Цель: лендинг для Jarvis Code к пятнице.\nРешено: Astro + Tailwind, хостинг Vercel.\nСделано: структура страниц, тексты hero и FAQ.\nДальше: форма подписки и деплой.",
  messages: [
    { role: "user", text: "Помоги спланировать лендинг для Jarvis Code — к пятнице" },
    { role: "assistant", text: "Предлагаю: **Astro + Tailwind**, хостинг Vercel. Страницы: главная, возможности, FAQ, скачать." },
    { role: "user", text: "Ок. Набросай тексты для hero и FAQ" },
    { role: "assistant", text: "**Hero:** «Ваш ИИ-ассистент на ПК — прямо из чата Notion».\n\n**FAQ:** нужен ли API — нет; где хранятся чаты — на вашем ПК; работает ли офлайн — мост нужен онлайн." },
    { role: "user", text: "Отлично, структуру страниц тоже зафиксируй" },
    { role: "assistant", text: "Зафиксировал: `/`, `/features`, `/faq`, `/download`. Осталось — форма подписки и деплой." },
  ],
});

/** Что «агент» делает с сообщением: вызовы инструментов и итоговый ответ. */
async function handle(full: string): Promise<{ text: string; status?: string } | null> {
  const at = full.indexOf("User's message (typed in Jarvis Code):");
  const msg = at >= 0 ? full.slice(at) : full;
  if (msg.includes("Вынеси проверку")) {
    await tool("nc_write_file", { path: "src/auth.ts", content: "export function checkToken(token: string): boolean {\n  return /^ntn_[A-Za-z0-9]{8,}$/.test(token);\n}\n" });
    await tool("nc_write_file", { path: "src/index.ts", content: 'import { checkToken } from "./auth";\n\nexport function login(token: string) {\n  if (!checkToken(token)) throw new Error("bad token");\n  return { ok: true };\n}\n' });
    await tool("nc_edit_file", { path: "README.md", old_string: "# My project\n", new_string: "# My project\n\nПроверка токена — `src/auth.ts`.\n" });
    return { text: FINAL_EDIT, status: "DONE" };
  }
  if (msg.includes("Почисти")) {
    // ждёт подтверждения в окне — ответа пока нет
    void tool("nc_run", { command: 'Remove-Item "$env:TEMP\\*" -Recurse -Force -ErrorAction SilentlyContinue' });
    return null;
  }
  if (msg.includes("места на дисках")) {
    await tool("nc_batch", { calls: [{ tool: "nc_list_dir", args: { path: "." } }, { tool: "nc_read_file", args: { path: "README.md" } }, { tool: "nc_search", args: { pattern: "name", path: "." } }] });
    return { text: FINAL, status: "NEED_INPUT" };
  }
  return { text: "Готово.", status: "DONE" };
}
const agent = { on: true };
const loop = (async () => {
  let first = true;
  while (agent.on) {
    const r = await tool("nc_inbox", { wait_sec: 1, ...(first ? { start: true } : {}) });
    first = false;
    if (!agent.on) break;
    if (/^(NO_MESSAGE|STOP)/.test(r) || !r.includes("[Jarvis Code]")) continue;
    const res = await handle(r.startsWith("NO_REPLY_YET") ? r.slice(r.indexOf("\n\n") + 2) : r);
    if (!res) break; // ждёт подтверждения — агент «занят»
    await tool("nc_reply", { ...res, wait_next: false });
  }
})();

const wait = async (id: string, ms = 8000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    const s: any = await call("state");
    if (!s.busy[id]) return;
    await Bun.sleep(150);
  }
};
const c1: any = await call("chats", { mode: "ask", project });
await call(`chats/${c1.id}/send`, { text: "Проверь, сколько места на дисках и что занимает больше всего" });
await Bun.sleep(400);
await wait(c1.id);
const c0: any = await call("chats", { mode: "auto-edit", project });
await call(`chats/${c0.id}/rename`, { title: "Рефакторинг модуля авторизации" });
const c5: any = await call("chats", { mode: "auto-edit", project, effort: "deep" });
await call(`chats/${c5.id}/send`, { text: "Вынеси проверку токена в отдельный модуль" });
await Bun.sleep(400);
await wait(c5.id);
const c2: any = await call("chats", { mode: "ask", project });
await call(`chats/${c2.id}/send`, { text: "Почисти временные файлы" });
await Bun.sleep(1500);
agent.on = false;
void loop;

st = await call("state");
const imported = st.chats.find((c: any) => c.title === "План запуска лендинга");
const B = await launch(homeB);
const I = await launch(path.join(root, "home-inst"), ["install"]);
console.log(
  JSON.stringify({
    app: `${A.base}#t=${A.token}`,
    chat: c1.id,
    pending: c2.id,
    edits: c5.id,
    error: "cdemoerr001",
    imported: imported?.id,
    mcp: st.bridge.localUrl,
    fresh: `${B.base}#t=${B.token}`,
    installer: `${I.base}#t=${I.token}&view=install`,
  }),
);
