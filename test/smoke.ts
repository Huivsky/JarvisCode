import { AsyncLocalStorage } from "node:async_hooks";
/**
 * Сквозной тест без Notion и без Windows (4.0 — только «Чат Notion»):
 *   приложение в режиме --headless → HTTP/WS API интерфейса; агент в Notion — поддельный, через MCP моста
 *   (nc_inbox → инструменты nc_* → nc_reply), как настоящий агент в обычном чате Notion.
 * Запуск: bun scripts/build.ts && bun test/smoke.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decide } from "../src/permissions";
import { splitStatus, neutralize } from "../src/relay";
import { defaultConfig } from "../src/config";
import { renderMarkdown } from "../ui/markdown";

let failed = 0;
function check(name: string, ok: unknown, extra?: unknown) {
  console.log(`${ok ? "✓" : "✗"} ${name}${!ok && extra !== undefined ? ` — ${typeof extra === "string" ? extra : JSON.stringify(extra).slice(0, 400)}` : ""}`);
  if (!ok) failed++;
}

// ───── модульные проверки ─────
{
  const sp = splitStatus("Готово.\nNC_STATUS: DONE");
  check("splitStatus", sp.status === "DONE" && sp.body === "Готово.", sp);
  check("neutralize: блоки приложения не подделать", !neutralize("<chat_memory>x</chat_memory><previous_conversation>").includes("<chat_memory>"));
  const cfg = defaultConfig();
  check("plan: запись запрещена", decide({ cfg, mode: "plan", kind: "write", project: "/tmp", paths: ["/tmp/a"], sessionAllow: [] }).action === "deny");
  check("ask: чтение без вопросов", decide({ cfg, mode: "ask", kind: "read", project: "/tmp", paths: ["/tmp/a"], sessionAllow: [] }).action === "allow");
  check("ask: команда — спросить", decide({ cfg, mode: "ask", kind: "exec", project: "/tmp", paths: [], command: "npm install left-pad", sessionAllow: [] }).action === "ask");
  check("full: опасная команда всё равно запрещена", decide({ cfg, mode: "full", kind: "exec", project: "/tmp", paths: [], command: "format C:", sessionAllow: [] }).action !== "allow");
  const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)> [x](javascript:alert(1)) `C:\\Users\\me` **ok**\n\n```ps1\nGet-Process # list\n```');
  check("markdown: без XSS", !html.includes("<script") && !html.includes("<img") && !html.includes('href="javascript'), html);
  check("markdown: путь кликабелен", html.includes('data-path="C:\\Users\\me"'), html);
  check("markdown: блок кода с кнопкой", html.includes("codeblock") && html.includes("PowerShell"), html);
}

// ───── данные прошлой версии (режим API) ─────
const home = fs.mkdtempSync(path.join(os.tmpdir(), "nc-home-"));
const project = fs.mkdtempSync(path.join(os.tmpdir(), "nc-proj-"));
const bigDisk = fs.mkdtempSync(path.join(os.tmpdir(), "nc-disk-"));
fs.writeFileSync(path.join(project, "hello.txt"), "hello world\n");
fs.writeFileSync(
  path.join(home, "config.json"),
  JSON.stringify({ accounts: [{ id: "a1", token: "ntn_secret_old", userName: "Draizons", workspaceName: "Тест", agentId: "notion_ai" }], activeAccount: "a1", via: "api", creditFailover: "account", bridge: { autoHandoff: true, enabled: false } }),
);
fs.mkdirSync(path.join(home, "chats"), { recursive: true });
fs.writeFileSync(
  path.join(home, "chats", "cold1.json"),
  JSON.stringify({
    id: "cold1",
    title: "Старый чат",
    createdAt: 1,
    updatedAt: 2,
    mode: "ask",
    project,
    accountId: "a1",
    agentId: "notion_ai",
    via: "api",
    sessionId: "sess_old",
    tokens: 5,
    items: [
      { id: "i1", kind: "user", at: 1, text: "старый вопрос про hello" },
      { id: "i2", kind: "assistant", at: 2, text: "старый ответ" },
      { id: "i3", kind: "error", at: 3, text: "кредиты", hint: "credits", handoff: true },
    ],
  }),
);

// ───── приложение ─────
const app = Bun.spawn([process.execPath, path.join(import.meta.dir, "../src/main.ts"), "--headless", "--port", "0"], {
  env: { ...process.env, JARVIS_CODE_HOME: home },
  stdout: "pipe",
  stderr: "inherit",
});
const reader = app.stdout.getReader();
let out = "";
let base = "";
let token = "";
const t0 = Date.now();
while (!token && Date.now() - t0 < 15000) {
  const { value, done } = await reader.read();
  if (done) break;
  out += new TextDecoder().decode(value);
  const m = out.match(/(http:\/\/127\.0\.0\.1:\d+\/)#t=([a-f0-9]+)/);
  if (m) [, base, token] = m;
}
check("приложение запустилось", token, out);
if (!token) process.exit(1);

const sessions = new Map<string,string>();
const testScope = new AsyncLocalStorage<string>();
let selectedSession = "";
const chooseChat = async (chatId:string) => {
  if(!sessions.has(chatId)) {
    await api("relay/start",{chatId,open:false});
    const chat=(await api(`chats/${chatId}`)).data;
    if(!chat.relaySessionId) throw new Error("No relay session created for test chat");
    sessions.set(chatId,chat.relaySessionId);
    if(agent.on) startWorker(chatId,chat.relaySessionId);
  }
  selectedSession=sessions.get(chatId)!;
};
const api = async (p: string, body?: unknown, method?: string, headers: Record<string, string> = {}): Promise<{status:number;data:any}> => {
  const relay = p.match(/^chats\/([a-z0-9]+)\/(send|retry)$/);
  if(relay) await chooseChat(relay[1]);
  const r = await fetch(base + "api/" + p, {
    method: method ?? (body !== undefined ? "POST" : "GET"),
    headers: { "x-nc-token": token, "content-type": "application/json", ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if(method === "DELETE" && /^chats\/[a-z0-9]+$/.test(p)) sessions.delete(p.split("/")[1]);
  return { status: r.status, data: (await r.json().catch(() => ({}))) as any };
};

/** Поддельный агент в чате Notion: вызывает инструменты моста, как настоящий. */
let rpcUrl = "";
const rpc = async (method: string, params: object = {}, url = rpcUrl, id = Math.floor(Math.random() * 1e6)) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  return { status: r.status, data: (await r.json().catch(() => ({}))) as any };
};
const call = async (name: string, args: object = {}) => {
  const session = testScope.getStore() ?? selectedSession;
  const r = await rpc("tools/call", { name, arguments: { ...args, ...(session ? {session_id:session} : {}) } });
  return { text: String(r.data.result?.content?.[0]?.text ?? ""), isError: !!r.data.result?.isError, raw: r.data };
};

const received: string[] = [];
const agent = { on: false };
/** Что «агент» делает с сообщением: вызовы инструментов и итоговый ответ. */
async function handle(full: string): Promise<{ text: string; status?: string; memory?: string }> {
  // реагируем только на текст пользователя (в заголовке — название чата)
  const at = full.indexOf("User's message (typed in Jarvis Code):");
  const msg = at >= 0 ? full.slice(at) : full;
  if (msg.includes("Что в hello.txt")) {
    const b = await call("nc_batch", { calls: [{ tool: "nc_list_dir", args: { path: "." } }, { tool: "nc_read_file", args: { path: "hello.txt" } }] });
    const w = await call("nc_write_file", { path: "summary.md", content: "# Итог\nhello world" });
    return { text: `Готово: в \`hello.txt\` написано **hello world**${b.text.includes("hello world") ? "" : " (?)"}, итог ${w.isError ? "не сохранён" : "сохранён в `summary.md`"}.`, status: "DONE" };
  }
  if (msg.includes("ДОЛГО-ШАГ")) {
    await Bun.sleep(500);
    const r = await call("nc_list_dir", { path: "." });
    return { text: /<user_message[\s\S]*<\/user_message>/.test(r.text) ? "Учёл ваше сообщение по ходу работы." : "Посмотрел.", status: "DONE" };
  }
  if (msg.includes("ДОЛГО-ОТВЕТ")) {
    await Bun.sleep(500);
    return { text: "Первый ответ.", status: "DONE" };
  }
  if (msg.includes("СЛЕДОМ")) return { text: "Ответ на сообщение из очереди.", status: "DONE" };
  if (msg.includes("ДОЛГО-СТОП")) {
    await Bun.sleep(1500);
    return { text: "Очень длинный ответ.", status: "DONE" };
  }
  if (msg.includes("ДВЕ-ПРАВКИ")) {
    await call("nc_write_file", { path: "new.txt", content: "новый файл" });
    await call("nc_edit_file", { path: "edit-me.txt", old_string: "старый", new_string: "новый" });
    await call("nc_edit_file", { path: "edit-me.txt", old_string: "текст", new_string: "текст!" });
    return { text: "Две правки готовы.", status: "DONE" };
  }
  if (msg.includes("ПАМЯТЬ")) {
    const w = await call("nc_memory", { text: "Цель: проверить память.\nРешение: хранить в Jarvis Code." });
    const a = await call("nc_memory", { append: "Шаг 2 сделан." });
    const r = await call("nc_memory", {});
    return { text: `Память: ${w.isError || a.isError ? "ошибка" : r.text.split("\n").length} строк`, status: "DONE", memory: undefined };
  }
  if (msg.includes("ИСТОРИЯ")) {
    const h = await call("nc_history", { query: "отчёт" });
    return { text: `Нашёл: ${h.text.split("\n")[0]}\n${h.text.includes("Сделай отчёт") ? "есть «Сделай отчёт»" : "нет"}`, status: "DONE" };
  }
  if (msg.includes("ЗАПОМНИ-В-ОТВЕТЕ")) return { text: "Записал память в ответе.", status: "DONE", memory: "Память из nc_reply." };
  if (msg.includes("ВОПРОС")) return { text: "Ответ на вопрос.", status: "DONE" };
  return { text: "ok", status: "DONE" };
}
const workers = new Map<string,Promise<void>>();
function startWorker(chatId:string,session:string) {
  if(workers.has(chatId))return;
  const work = testScope.run(session,async()=>{
    let first=true;
    while(agent.on && sessions.get(chatId)===session){
      const r=await call("nc_inbox",{wait_sec:1,...(first?{start:true}:{})});first=false;
      if(!agent.on)break;
      if(/^(NO_MESSAGE|STOP|LISTENER_BUSY)/.test(r.text)||r.isError){if(r.isError)await Bun.sleep(50);continue;}
      const msg=r.text.startsWith("NO_REPLY_YET")?r.text.slice(r.text.indexOf("\n\n")+2):r.text;
      received.push(msg);const res=await handle(msg);await call("nc_reply",{...res,wait_next:false});
    }
  });
  workers.set(chatId,work);
}
function startAgent(){agent.on=true;for(const [chatId,session] of sessions)startWorker(chatId,session);}
async function stopAgent(){agent.on=false;await Promise.all(workers.values());workers.clear();}

try {
  // безопасность
  check("API без токена → 401", (await fetch(base + "api/state")).status === 401);
  check("чужой Origin → 403", (await api("state", undefined, "GET", { origin: "https://evil.example" })).status === 403);
  const index = await fetch(base);
  check("index.html с CSP", index.ok && (index.headers.get("content-security-policy") ?? "").includes("script-src 'self'"));
  const js = await fetch(base + "app.js");
  check("app.js отдаётся", js.ok && (await js.text()).length > 50_000);

  let st = (await api("state")).data;
  check("режима API больше нет: нет входа и аккаунтов", st.loggedIn === undefined && st.accounts === undefined && st.agent === undefined && (await api("login/token", { token: "x" })).status === 404, Object.keys(st));
  check("имя пользователя перенесено из старого входа", st.user?.name === "Draizons", st.user);
  check("в state нет старых токенов", !JSON.stringify(st).includes("ntn_secret_old"));
  check("хранилище по умолчанию — папка данных", st.storage?.dir === home && st.storage.custom === false, st.storage);
  check("в состоянии есть версия и обновления", st.update?.current === st.version && Array.isArray(st.crashes), st.update);
  const upd = (await api("update/check", {})).data;
  check("обновления: без источника — понятная ошибка", upd.update?.status === "error" && /источник/.test(upd.update?.error ?? ""), upd);
  const cr = (await api("crashes")).data;
  check("отчёты о сбоях: список", Array.isArray(cr.items), cr);
  const send = (await api("crashes/send", { ids: [] })).data;
  check("отчёты о сбоях: без адреса не отправляются", send.ok === false && /адрес/.test(send.error ?? ""), send);

  const old = (await api("chats/cold1")).data;
  check("старый чат открывается без полей API", old.id === "cold1" && old.accountId === undefined && old.via === undefined && old.sessionId === undefined && old.items.length === 3 && !old.items[2].hint, old);
  check("настройки: имя, уровень мышления, OCR", (await api("settings", { userName: "Дрейзонс", effort: "deep", ocr: false })).data.ok);
  st = (await api("state")).data;
  check("настройки сохранены", st.user.name === "Дрейзонс" && st.settings.effort === "deep" && st.settings.ocr === false, { user: st.user, s: st.settings });
  const cfgFile = fs.readFileSync(path.join(home, "config.json"), "utf8");
  check("config.json без токенов и полей API", !cfgFile.includes("ntn_secret_old") && !/"accounts"|"creditFailover"|"autoHandoff"|"via"/.test(cfgFile), cfgFile.slice(0, 300));
  await api("settings", { effort: "normal", ocr: true });

  // WebSocket
  const events: any[] = [];
  const ws = new WebSocket(`${base.replace("http", "ws")}ws?t=${token}`);
  await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
  ws.onmessage = (m) => events.push(JSON.parse(String(m.data)));
  const wsBad = new WebSocket(`${base.replace("http", "ws")}ws?t=wrong`);
  const badOpened = await new Promise((res) => ((wsBad.onopen = () => res(true)), (wsBad.onerror = () => res(false)), (wsBad.onclose = () => res(false))));
  check("WS с неверным токеном отклонён", !badOpened);
  const waitFor = async (pred: (e: any) => boolean, ms = 15000) => {
    const t = Date.now();
    while (Date.now() - t < ms) {
      const e = events.find(pred);
      if (e) return e;
      await Bun.sleep(50);
    }
    return null;
  };

  // ── мост MCP ──
  const mcpPort = 20000 + Math.floor(Math.random() * 20000);
  const br = (await api("bridge", { enabled: true, provider: "manual", publicUrl: "https://example.test", port: mcpPort, mode: "ask", project })).data;
  check("мост включён", br.ok && br.bridge.listening && br.bridge.mcpUrl.startsWith("https://example.test/mcp/") && br.bridge.tunnel.status === "online", br.bridge);
  rpcUrl = br.bridge.localUrl;
  const secret = String(br.bridge.mcpUrl).split("/mcp/")[1];
  check("MCP без ключа → 401", (await rpc("initialize", {}, `http://127.0.0.1:${mcpPort}/mcp`)).status === 401 && (await rpc("initialize", {}, `http://127.0.0.1:${mcpPort}/mcp/wrong`)).status === 401);
  const init = (await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } })).data;
  check("MCP initialize", init.result?.serverInfo?.name === "jarvis-code" && typeof init.result.instructions === "string" && init.result.instructions.includes("nc_history"), init);
  const list = (await rpc("tools/list")).data;
  const names: string[] = (list.result?.tools ?? []).map((t: any) => t.name);
  check(
    "MCP tools/list: инструменты ПК, пересылка, история, память, перенос",
    ["nc_list_dir", "nc_read_file", "nc_run", "nc_write_file", "nc_inbox", "nc_reply", "nc_history", "nc_memory", "nc_import"].every((n) => names.includes(n)) && list.result.tools.every((t: any) => t.inputSchema?.type === "object"),
    names,
  );
  check("nc_import помечен как запись", list.result.tools.find((t: any) => t.name === "nc_import")?.annotations?.readOnlyHint === false);
  const ld = await call("nc_list_dir", { path: project });
  check("MCP nc_list_dir", !ld.isError && ld.text.includes("hello.txt"), ld.text.slice(0, 200));
  events.length = 0;
  const writeP = call("nc_write_file", { path: "from-notion.txt", content: "привет из Notion" });
  const bAppr = await waitFor((e) => e.type === "chat.item" && e.chatId === "bridge" && e.item.kind === "approval" && !e.item.approval.answer);
  check("мост: запрос разрешения в журнале", bAppr, events.slice(-5));
  if (bAppr) await api(`approvals/${bAppr.item.id}`, { answer: "yes" });
  const wr = await writeP;
  check("мост: файл записан после разрешения", !wr.isError && fs.readFileSync(path.join(project, "from-notion.txt"), "utf8") === "привет из Notion", wr.text);
  const bchat = (await api("chats/bridge")).data;
  check("журнал моста", bchat.bridge && bchat.items.some((i: any) => i.kind === "tool" && i.tool === "nc_list_dir" && i.via === "bridge"));
  check("журнал моста не в списке чатов", !(await api("state")).data.chats.some((c: any) => c.id === "bridge"));
  check("в журнал моста нельзя писать", (await api("chats/bridge/send", { text: "hi" })).status === 400);
  check("history/memory вне пересылки → подсказка", (await call("nc_history", {})).isError && (await call("nc_memory", {})).text.includes("nc_inbox"));
  const st2 = (await api("state")).data;
  check("счётчик вызовов моста", st2.bridge.calls >= 2, st2.bridge);
  check("health с меткой процесса", (await (await fetch(`http://127.0.0.1:${mcpPort}/health`)).text()).startsWith("ok jarvis-code "));
  check("локальные вызовы не считаются подключением Notion", st2.bridge.connected === false, st2.bridge);
  const h2 = (await api("bridge/connect", {})).data;
  check("«Подключить»: текст с адресом моста (по кнопке)", h2.ok && h2.prompt.includes(st2.bridge.mcpUrl), h2.prompt);
  const rs = (await api("relay/start", {open:false})).data;
  check("команда запуска пересылки: start, без ключа моста", rs.prompt.includes('"start": true') && rs.prompt.includes("nc_reply") && rs.prompt.includes("nc_history") && !rs.prompt.includes(secret), rs.prompt);
  const ip = (await api("import/prompt", { open: false })).data;
  check("команда переноса чата: nc_import, без ключа моста", ip.prompt.includes("nc_import") && ip.prompt.includes("import_id") && !ip.prompt.includes(secret), ip.prompt);
  await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.5", "user-agent": "Notion-MCP-Client" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }),
  });
  await Bun.sleep(150);
  check("вызов из Notion → мост подключён", (await api("state")).data.bridge.connected === true);

  // ── агент не на связи → карточка запуска; ручная пересылка ──
  const chat = (await api("chats", { mode: "ask", project, effort: "deep" })).data;
  check("чат создан с уровнем мышления", chat.id && chat.project === project && chat.effort === "deep" && chat.accountId === undefined, chat);
  events.length = 0;
  const sent = await api(`chats/${chat.id}/send`, { text: "ВОПРОС первый" });
  check("сообщение отправлено", sent.data.ok, sent);
  const card = await waitFor((e) => e.type === "chat.item" && e.chatId === chat.id && e.item.kind === "notice" && e.item.hint === "listen", 5000);
  check("агент в Notion не на связи → карточка запуска", !!card);
  const in1 = await call("nc_inbox", { wait_sec: 5, start: true });
  check("nc_inbox отдаёт сообщение из окна", in1.text.includes("[Jarvis Code]") && in1.text.includes("ВОПРОС первый") && in1.text.includes("nc_reply") && !in1.isError, in1.text.slice(0, 400));
  check("уровень мышления — в сообщении агенту", in1.text.includes("effort=deep") && in1.text.includes("Effort: deep"), in1.text.slice(0, 300));
  check("pc_info и подсказка про историю в первом сообщении", in1.text.includes("<pc_info>") && in1.text.includes("hello.txt") && in1.text.includes("nc_history"), in1.text.slice(0, 600));
  const stR = (await api("state")).data.bridge.relay;
  check("пересылка: агент на связи и работает над чатом", stR.listening && stR.activeChatId === chat.id, stR);
  const qr = await api(`chats/${chat.id}/send`, { text: "ДОБАВКА по ходу" });
  check("сообщение во время работы → в очередь", !!qr.data.queued, qr.data);
  const ld2 = await call("nc_list_dir", { path: project });
  await Bun.sleep(100);
  const c2b = (await api(`chats/${chat.id}`)).data;
  check("действия агента — в этом чате, а не в журнале моста", !ld2.isError && c2b.items.some((i: any) => i.kind === "tool" && i.tool === "nc_list_dir"));
  check(
    "сообщение из очереди — в результате инструмента",
    /<user_message[\s\S]*ДОБАВКА по ходу/.test(ld2.text) && c2b.items.some((i: any) => i.kind === "user" && i.text === "ДОБАВКА по ходу" && i.queue === "steer"),
    ld2.text.slice(-300),
  );
  events.length = 0;
  const rep1 = await call("nc_reply", { text: "Готово из чата Notion", status: "DONE", wait_sec: 1, memory: "Цель: ответить на вопрос." });
  await waitFor((e) => e.type === "done" && e.chatId === chat.id, 5000);
  const c2c = (await api(`chats/${chat.id}`)).data;
  check("nc_reply → ответ в окне Jarvis Code", /nc_inbox/.test(rep1.text) && !c2c.busy && c2c.items.some((i: any) => i.kind === "assistant" && i.text === "Готово из чата Notion" && i.agentStatus === "DONE"), c2c.items.slice(-3));
  check("nc_reply.memory → память чата на диске", fs.readFileSync(path.join(home, "context", chat.id, "memory.md"), "utf8").includes("Цель: ответить"));
  check("память видна в окне", (await api(`chats/${chat.id}/memory`)).data.memory === "Цель: ответить на вопрос.");
  const in2 = await call("nc_inbox", { wait_sec: 1 });
  check("нет сообщений → NO_MESSAGE", in2.text.startsWith("NO_MESSAGE"), in2.text);
  const poll = call("nc_inbox", { wait_sec: 20 });
  await Bun.sleep(300);
  const tp = Date.now();
  await api(`chats/${chat.id}/send`, { text: "ВТОРОЕ из окна" });
  const in3 = await poll;
  check("ожидающий nc_inbox получает сообщение сразу", in3.text.includes("ВТОРОЕ из окна") && Date.now() - tp < 3000);
  check("в той же связи история не повторяется", !in3.text.includes("<previous_conversation") && !in3.text.includes("<pc_info>"), in3.text.slice(0, 300));
  const again = await call("nc_inbox", { wait_sec: 1, start: true });
  check(
    "новый чат Notion (start) → то же сообщение с сохранённым контекстом",
    again.text.includes("ВТОРОЕ из окна") && again.text.includes("<chat_memory") && again.text.includes("Цель: ответить") && again.text.includes("<previous_conversation") && again.text.includes("Готово из чата Notion"),
    again.text.slice(0, 900),
  );
  const nudge = await call("nc_inbox", { wait_sec: 1 });
  check("nc_inbox без ответа → напоминание с текстом", nudge.text.startsWith("NO_REPLY_YET") && nudge.text.includes("ВТОРОЕ из окна"), nudge.text.slice(0, 200));
  await api(`chats/${chat.id}/stop`, {});
  await Bun.sleep(100);
  const stopped = await call("nc_list_dir", { path: project });
  check("остановка в окне → агент получает «stopped»", stopped.isError && /stopped/i.test(stopped.text), stopped.text);
  const rep2 = await call("nc_reply", { text: "не нужно", wait_sec: 1 });
  const c2d = (await api(`chats/${chat.id}`)).data;
  check("ответ после остановки не показывается", /stopped/i.test(rep2.text) && !c2d.busy && !c2d.items.some((i: any) => i.text === "не нужно"));

  // nc_reply сразу отдаёт следующее сообщение; nc_batch; nc_todo
  {
    const in4p = call("nc_inbox", { wait_sec: 5 });
    await Bun.sleep(200);
    await api(`chats/${chat.id}/send`, { text: "ТРЕТЬЕ" });
    const in4 = await in4p;
    check("nc_inbox: третье сообщение", in4.text.includes("ТРЕТЬЕ"), in4.text.slice(0, 200));
    const b = await call("nc_batch", { calls: [{ tool: "nc_list_dir", args: { path: project } }, { tool: "nc_status", args: {} }, { tool: "nope" }] });
    check("nc_batch: несколько вызовов за шаг", b.text.includes("### 1. nc_list_dir — ok") && b.text.includes("### 2. nc_status — ok") && b.text.includes("Unknown tool nope"), b.text.slice(0, 300));
    const todo = await call("nc_todo", { items: [{ text: "Шаг 1", status: "done" }, { text: "Шаг 2", status: "in_progress" }] });
    await Bun.sleep(100);
    const c2t = (await api(`chats/${chat.id}`)).data;
    check("nc_todo → план в чате", !todo.isError && c2t.todos?.length === 2 && c2t.todos[1].status === "in_progress", c2t.todos);
    const repP = call("nc_reply", { text: "ответ на третье", wait_sec: 10 });
    await Bun.sleep(400);
    const t1 = Date.now();
    await api(`chats/${chat.id}/send`, { text: "ЧЕТВЁРТОЕ" });
    const rep3 = await repP;
    check("nc_reply сразу возвращает следующее сообщение", rep3.text.startsWith("Delivered") && rep3.text.includes("ЧЕТВЁРТОЕ") && Date.now() - t1 < 3000, rep3.text.slice(0, 300));
    await call("nc_reply", { text: "ok4", wait_next: false });
    await waitFor((e) => e.type === "done" && e.chatId === chat.id, 3000);
  }

  // ── дальше «агент» работает сам, в цикле ──
  startAgent();
  await Bun.sleep(300);

  // запись файла с подтверждением
  {
    const chatW = (await api("chats", { mode: "ask", project })).data;
    events.length = 0;
    await api(`chats/${chatW.id}/send`, { text: "Что в hello.txt? Запиши итог в summary.md" });
    const appr = await waitFor((e) => e.type === "chat.item" && e.chatId === chatW.id && e.item.kind === "approval" && !e.item.approval.answer);
    check("запрос разрешения на запись файла", appr && /summary\.md/.test(appr.item.approval.summary + appr.item.approval.detail), appr?.item);
    check("событие attention", await waitFor((e) => e.type === "attention"));
    if (appr) check("ответ «Разрешить»", (await api(`approvals/${appr.item.id}`, { answer: "yes" })).data.ok);
    check("агент завершил ответ", await waitFor((e) => e.type === "done" && e.chatId === chatW.id));
    const full = (await api(`chats/${chatW.id}`)).data;
    const last = full.items.at(-1);
    check("финальный ответ", last.kind === "assistant" && last.text.includes("hello world") && last.text.includes("сохранён") && last.agentStatus === "DONE", last);
    check("файл записан после разрешения", fs.readFileSync(path.join(project, "summary.md"), "utf8").includes("hello world"));
    const toolItems = full.items.filter((i: any) => i.kind === "tool" && i.status === "ok");
    check("у инструментов есть время выполнения", toolItems.length >= 2 && toolItems.every((i: any) => typeof i.ms === "number"), toolItems);
    check("уровень мышления по умолчанию — без лишних указаний", received.at(-1)!.includes("effort=normal") && !received.at(-1)!.includes("Effort:"));
    await Bun.sleep(3500);
    check("история чата на диске и зеркало в Markdown", fs.existsSync(path.join(home, "chats", `${chatW.id}.json`)) && fs.readFileSync(path.join(home, "context", chatW.id, "chat.md"), "utf8").includes("summary.md"));
    // смена уровня мышления
    check("смена уровня мышления", (await api(`chats/${chatW.id}/effort`, { effort: "max" })).data.ok && (await api(`chats/${chatW.id}`)).data.effort === "max");
    check("неизвестный уровень → 400", (await api(`chats/${chatW.id}/effort`, { effort: "ultra" })).status === 400);
    events.length = 0;
    await api(`chats/${chatW.id}/send`, { text: "ВОПРОС про уровень" });
    await waitFor((e) => e.type === "done" && e.chatId === chatW.id);
    check("«Максимум» уходит агенту", received.at(-1)!.includes("effort=max") && received.at(-1)!.includes("Effort: max"), received.at(-1)!.slice(0, 300));
    // память и история через инструменты
    events.length = 0;
    await api(`chats/${chatW.id}/send`, { text: "ПАМЯТЬ" });
    await waitFor((e) => e.type === "done" && e.chatId === chatW.id);
    const mem = (await api(`chats/${chatW.id}/memory`)).data.memory;
    check("nc_memory: запись и дополнение", mem.includes("Цель: проверить память.") && mem.endsWith("Шаг 2 сделан."), mem);
    // «Повторить»
    events.length = 0;
    await api(`chats/${chatW.id}/retry`, {});
    await waitFor((e) => e.type === "done" && e.chatId === chatW.id);
    const rItems = (await api(`chats/${chatW.id}`)).data.items;
    check("«Повторить» отправляет последнее сообщение ещё раз", received.at(-1)!.includes("ПАМЯТЬ") && rItems.filter((i: any) => i.kind === "user" && i.text === "ПАМЯТЬ").length === 1);
    await api(`chats/${chatW.id}`, undefined, "DELETE");
    check("удаление чата удаляет его контекст", !fs.existsSync(path.join(home, "context", chatW.id)));
  }

  // ── свои «/»-команды ──
  const chat2 = (await api("chats", { mode: "ask", project })).data;
  fs.mkdirSync(path.join(project, ".jarvis", "commands"), { recursive: true });
  fs.writeFileSync(path.join(project, ".jarvis", "commands", "greet.md"), "---\ndescription: Поздороваться\n---\nПоздоровайся с $ARGUMENTS. ВОПРОС\n");
  fs.writeFileSync(path.join(project, ".jarvis", "commands", "review.md"), "Подмена встроенной команды\n");
  const cmds = (await api(`commands?dir=${encodeURIComponent(project)}`)).data.items;
  check("свои команды: список", cmds.length === 1 && cmds[0].name === "greet" && cmds[0].description === "Поздороваться" && cmds[0].args === true && cmds[0].source === "project", cmds);
  events.length = 0;
  await api(`chats/${chat2.id}/send`, { text: "/greet миром" });
  await waitFor((e) => e.type === "done" && e.chatId === chat2.id);
  const cmdMsg = received.at(-1) ?? "";
  check("свои команды: задание из файла уходит агенту", cmdMsg.includes('<command name="/greet"') && cmdMsg.includes("Поздоровайся с миром.") && !cmdMsg.includes("$ARGUMENTS"), cmdMsg.slice(-400));
  check("свои команды: в чате — то, что набрал пользователь", (await api(`chats/${chat2.id}`)).data.items.some((i: any) => i.kind === "user" && i.text === "/greet миром"));

  // ── сохранение чата в Markdown ──
  const ex = (await api(`chats/${chat2.id}/export`, { reveal: false })).data;
  const md = ex.ok ? fs.readFileSync(ex.path, "utf8") : "";
  check("Markdown: файл в «Загрузках»", ex.ok && ex.path.endsWith(".md") && ex.path.includes("Downloads"), ex);
  check("Markdown: заголовок, реплики", /^# /.test(md) && md.includes("## Вы") && md.includes("## Агент") && md.includes("/greet миром") && md.includes("Ответ на вопрос."), md.slice(0, 600));
  const ex2 = (await api(`chats/${chat2.id}/export`, { reveal: false })).data;
  check("Markdown: не перезаписывает прошлый файл", ex2.ok && ex2.path !== ex.path && / \(2\)\.md$/.test(ex2.path), ex2);
  for (const f of [ex.path, ex2.path]) if (f) fs.rmSync(f, { force: true });

  // ── сообщения во время работы агента (очередь) ──
  {
    const chatQ = (await api("chats", { mode: "ask", project })).data;
    events.length = 0;
    await api(`chats/${chatQ.id}/send`, { text: "ДОЛГО-ШАГ: посмотри проект" });
    await waitFor((e) => e.type === "chat.status" && e.chatId === chatQ.id && e.busy, 3000);
    await Bun.sleep(150);
    const q1 = await api(`chats/${chatQ.id}/send`, { text: "И ещё проверь README" });
    check("во время работы сообщение встаёт в очередь", q1.status === 200 && q1.data.queued?.id && q1.data.queued.text === "И ещё проверь README", q1);
    check("событие chat.queue для окна", !!(await waitFor((e) => e.type === "chat.queue" && e.chatId === chatQ.id && e.queue.length === 1, 2000)));
    await waitFor((e) => e.type === "done" && e.chatId === chatQ.id, 15000);
    const qItems = (await api(`chats/${chatQ.id}`)).data.items;
    const steer = qItems.find((i: any) => i.kind === "user" && i.text === "И ещё проверь README");
    const iTool = qItems.findIndex((i: any) => i.kind === "tool" && i.tool === "nc_list_dir");
    check("очередь ушла агенту вместе с результатом шага", steer?.queue === "steer" && iTool >= 0 && qItems.indexOf(steer) > iTool && qItems.at(-1)?.text?.includes("Учёл"), qItems.map((i: any) => i.kind + ":" + (i.queue ?? "")));
    check("после ответа очередь пуста", (await api(`chats/${chatQ.id}`)).data.queue?.length === 0);

    // ответ без инструментов → очередь уходит следующим сообщением того же запроса
    events.length = 0;
    const nBefore = received.length;
    await api(`chats/${chatQ.id}/send`, { text: "ДОЛГО-ОТВЕТ" });
    await waitFor((e) => e.type === "chat.status" && e.chatId === chatQ.id && e.busy, 3000);
    await Bun.sleep(150);
    await api(`chats/${chatQ.id}/send`, { text: "СЛЕДОМ: а теперь вот это" });
    await waitFor((e) => e.type === "done" && e.chatId === chatQ.id, 15000);
    const after = received.slice(nBefore);
    check("очередь → следующее сообщение после ответа", after.length === 2 && after[1].includes("СЛЕДОМ: а теперь вот это"), after.map((m) => m.slice(-120)));
    const tail = (await api(`chats/${chatQ.id}`)).data.items.slice(-3).map((i: any) => `${i.kind}:${i.text?.slice(0, 12)}${i.queue ? ":" + i.queue : ""}`);
    check("порядок: ответ → сообщение из очереди → ответ на него", tail[0].startsWith("assistant:Первый") && tail[1].startsWith("user:СЛЕДОМ") && !tail[1].includes("steer") && tail[2].startsWith("assistant:Ответ на"), tail);
    check("одно событие done на весь запрос", events.filter((e) => e.type === "done" && e.chatId === chatQ.id).length === 1);

    // «Стоп» → сообщения из очереди возвращаются в поле ввода
    events.length = 0;
    await api(`chats/${chatQ.id}/send`, { text: "ДОЛГО-СТОП" });
    await waitFor((e) => e.type === "chat.status" && e.chatId === chatQ.id && e.busy, 3000);
    await api(`chats/${chatQ.id}/send`, { text: "не успеет", attachments: [{ path: path.join(project, "hello.txt") }] });
    const un = await api(`chats/${chatQ.id}/send`, { text: "уберу сам" });
    const un2 = await api(`chats/${chatQ.id}/unqueue`, { id: un.data.queued?.id });
    check("× убирает сообщение из очереди", un2.data.ok && un2.data.item?.text === "уберу сам" && (await api(`chats/${chatQ.id}`)).data.queue?.length === 1, un2.data);
    await api(`chats/${chatQ.id}/stop`, {});
    const back = await waitFor((e) => e.type === "chat.unqueue" && e.chatId === chatQ.id, 5000);
    check("«Стоп» → текст и файлы из очереди вернулись в окно", back?.items?.length === 1 && back.items[0].text === "не успеет" && back.items[0].attachments?.[0]?.path?.endsWith("hello.txt"), back);
    await waitFor((e) => e.type === "chat.status" && e.chatId === chatQ.id && !e.busy, 5000);
    const qi3 = (await api(`chats/${chatQ.id}`)).data;
    check("неотправленное не попало в историю; «Остановлено.»", !qi3.items.some((i: any) => i.text === "не успеет" || i.text === "уберу сам") && !qi3.busy && qi3.items.at(-1)?.text === "Остановлено.", qi3.items.slice(-2));
    await Bun.sleep(1700); // «агент» дописывает отменённый ответ

    // «Отправить сейчас» → прервать шаг и сразу передать очередь
    events.length = 0;
    const nB2 = received.length;
    await api(`chats/${chatQ.id}/send`, { text: "ДОЛГО-СТОП второй" });
    await waitFor((e) => e.type === "chat.status" && e.chatId === chatQ.id && e.busy, 3000);
    check("«Отправить сейчас» без очереди → 409", (await api(`chats/${chatQ.id}/flush`, {})).status === 409);
    await api(`chats/${chatQ.id}/send`, { text: "СЛЕДОМ срочно" });
    const fl = await api(`chats/${chatQ.id}/flush`, {});
    await waitFor((e) => e.type === "done" && e.chatId === chatQ.id, 15000);
    const qi4 = (await api(`chats/${chatQ.id}`)).data.items;
    check(
      "«Отправить сейчас» прерывает шаг и отправляет сообщение",
      fl.data.ok && received.slice(nB2).some((m) => m.includes("СЛЕДОМ срочно")) && qi4.some((i: any) => i.kind === "notice" && /Прервано/.test(i.text)) && qi4.at(-1)?.text?.includes("из очереди"),
      { msgs: received.slice(nB2).map((m) => m.slice(-80)), tail: qi4.slice(-3) },
    );
    await api(`chats/${chatQ.id}`, undefined, "DELETE");
  }

  // ── «Откатить все правки» ответа агента ──
  {
    fs.writeFileSync(path.join(project, "edit-me.txt"), "старый текст\n");
    const chatE = (await api("chats", { mode: "full", project })).data;
    events.length = 0;
    await api(`chats/${chatE.id}/send`, { text: "ДВЕ-ПРАВКИ" });
    await waitFor((e) => e.type === "done" && e.chatId === chatE.id, 15000);
    const items = (await api(`chats/${chatE.id}`)).data.items;
    const edits = items.filter((i: any) => i.kind === "tool" && i.undo && i.status === "ok");
    check("три правки в одном ответе", edits.length === 3 && fs.readFileSync(path.join(project, "edit-me.txt"), "utf8") === "новый текст!\n" && fs.existsSync(path.join(project, "new.txt")), items.map((i: any) => `${i.kind}:${i.tool ?? ""}:${i.status ?? ""}`));
    fs.appendFileSync(path.join(project, "edit-me.txt"), "дописал сам\n");
    const r1 = (await api("undo/turn", { chatId: chatE.id, itemIds: edits.map((e: any) => e.id) })).data;
    check("откат: файл менялся после агента → предупреждение", r1.ok === false && r1.changed === true && r1.conflicts?.length === 1, r1);
    const r2 = (await api("undo/turn", { chatId: chatE.id, itemIds: edits.map((e: any) => e.id), force: true })).data;
    check("«Откатить все» → файлы как до ответа", r2.ok && r2.restored === 2 && fs.readFileSync(path.join(project, "edit-me.txt"), "utf8") === "старый текст\n" && !fs.existsSync(path.join(project, "new.txt")), r2);
    check("повторный откат — «уже откачено»", (await api("undo/turn", { chatId: chatE.id, itemIds: edits.map((e: any) => e.id) })).data.message === "Уже откачено");
    await api(`chats/${chatE.id}`, undefined, "DELETE");
    const sg = (await api(`files/suggest?dir=${encodeURIComponent(project)}&q=edit`)).data;
    check("@-подсказки: файл найден по части имени", sg.items?.[0]?.rel === "edit-me.txt" && !sg.items[0].dir, sg);
  }

  // ── перенос из текста ──
  let textChat = "";
  {
    const tr = "Вы: Привет\nАгент: Здравствуйте, чем помочь?\nВы: Сделай отчёт по hello.txt\nАгент: Готово, отчёт в report.md\n";
    const im = (await api("chats/import", { text: tr, title: "Отчёт из Notion" })).data;
    textChat = im.chatId;
    check("перенос из текста: чат создан", im.ok && im.parsed && im.count === 4 && im.title === "Отчёт из Notion", im);
    const c = (await api(`chats/${im.chatId}`)).data;
    check("перенесённые сообщения помечены", c.items.filter((i: any) => i.imported).length === 4 && c.items[0].kind === "user" && c.items[1].kind === "assistant" && c.imported?.from === "text" && c.items.at(-1).kind === "notice", c.items);
    check("перенесённый чат — в списке", (await api("state")).data.chats.some((x: any) => x.id === im.chatId && x.imported));
    const plain = (await api("chats/import", { text: "Просто заметки без ролей: цель — быстрый отчёт." })).data;
    const pc = (await api(`chats/${plain.chatId}`)).data;
    check("текст без ролей → контекст одним сообщением", plain.ok && !plain.parsed && pc.items[0].text.includes("Просто заметки") && pc.items[0].imported, pc.items[0]);
    await api(`chats/${plain.chatId}`, undefined, "DELETE");
    check("пустой перенос → 400", (await api("chats/import", { text: "  " })).status === 400);
    events.length = 0;
    await api(`chats/${im.chatId}/send`, { text: "ИСТОРИЯ: что мы делали?" });
    await waitFor((e) => e.type === "done" && e.chatId === im.chatId);
    const msg = received.at(-1) ?? "";
    check("агент получает перенесённую переписку", msg.includes("<previous_conversation") && msg.includes("Сделай отчёт по hello.txt") && msg.includes("(imported)"), msg.slice(0, 1200));
    const ans = (await api(`chats/${im.chatId}`)).data.items.at(-1);
    check("nc_history находит старые сообщения", ans?.kind === "assistant" && ans.text.includes("есть «Сделай отчёт»") && ans.text.includes("match"), ans);
  }

  // ── перенос из чата Notion (nc_import) ──
  await stopAgent();
  selectedSession = "";
  {
    events.length = 0;
    const p1 = await call("nc_import", {
      import_id: "imp-1",
      part: 1,
      parts: 2,
      title: "Сайт для кофейни",
      summary: "Цель: лендинг для кофейни. Решено: Astro + Tailwind. Сделано: макет главной.",
      messages: [
        { role: "user", text: "Сделаем сайт для кофейни" },
        { role: "assistant", text: "Предлагаю Astro + Tailwind" },
      ],
    });
    check("nc_import: первая часть принята", !p1.isError && /Part 1\/2/.test(p1.text), p1.text);
    const p2 = await call("nc_import", { import_id: "imp-1", part: 2, parts: 2, messages: [{ role: "user", text: "Ок, делай главную" }, { role: "assistant", text: "Макет главной готов" }] });
    check("nc_import: последняя часть → чат перенесён", !p2.isError && p2.text.includes("4 messages") && p2.text.includes("nc_inbox"), p2.text);
    const ev = await waitFor((e) => e.type === "imported", 3000);
    check("окно получает событие переноса", ev?.count === 4 && ev.title === "Сайт для кофейни", ev);
    const nc = (await api(`chats/${ev?.chatId}`)).data;
    check("перенесённый чат: 4 сообщения по порядку + заметка", nc.items.filter((i: any) => i.imported).map((i: any) => i.text).join("|") === "Сделаем сайт для кофейни|Предлагаю Astro + Tailwind|Ок, делай главную|Макет главной готов" && nc.imported?.from === "notion" && nc.items.at(-1).kind === "notice", nc.items);
    check("summary → память чата", (await api(`chats/${ev?.chatId}/memory`)).data.memory.includes("Astro + Tailwind"));
    // тот же агент продолжает: история ему не нужна
    await chooseChat(ev.chatId);
    const pin = call("nc_inbox", { wait_sec: 5 });
    await Bun.sleep(200);
    await api(`chats/${ev?.chatId}/send`, { text: "Добавь страницу меню" });
    const m1 = await pin;
    check("тот же чат Notion: без повтора истории", m1.text.includes("Добавь страницу меню") && !m1.text.includes("<previous_conversation"), m1.text.slice(0, 400));
    await call("nc_reply", { text: "Меню добавлено", wait_next: false });
    await waitFor((e) => e.type === "done" && e.chatId === ev?.chatId, 3000);
    // другое пространство / новый чат Notion: вся история из Jarvis Code
    const pin2 = call("nc_inbox", { wait_sec: 5, start: true });
    await Bun.sleep(200);
    await api(`chats/${ev?.chatId}/send`, { text: "Что дальше?" });
    const m2 = await pin2;
    check(
      "другой чат Notion (start) → память и вся переписка",
      m2.text.includes("<chat_memory") && m2.text.includes("Astro + Tailwind") && m2.text.includes("Сделаем сайт для кофейни") && m2.text.includes("Меню добавлено") && m2.text.includes("Что дальше?"),
      m2.text.slice(0, 1500),
    );
    await call("nc_reply", { text: "Дальше — контакты", wait_next: false });
    await waitFor((e) => e.type === "done" && e.chatId === ev?.chatId, 3000);
    check("пустой nc_import → ошибка", (await call("nc_import", { messages: [] })).isError);
  }

  // ── хранилище: перенос на «большой диск» ──
  {
    startAgent();
    const up = await fetch(base + "api/upload?name=" + encodeURIComponent("заметка.txt"), { method: "POST", headers: { "x-nc-token": token }, body: "текст вложения" });
    const upj = (await up.json()) as any;
    check("вложение сохранено в хранилище", upj.ok && upj.path.startsWith(path.join(home, "uploads")), upj);
    const chatS = (await api("chats", { mode: "ask", project })).data;
    events.length = 0;
    await api(`chats/${chatS.id}/send`, { text: "ВОПРОС с файлом", attachments: [{ path: upj.path }] });
    await waitFor((e) => e.type === "done" && e.chatId === chatS.id);
    await stopAgent();
    const info = (await api("storage?fresh=1")).data;
    check("сведения о хранилище: размер и файлы", info.dir === home && info.files > 3 && info.bytes > 0 && info.parts.some((p: any) => p.name === "chats" && p.files > 2), info);
    check("нельзя выбрать папку внутри хранилища", (await api("storage/move", { dir: path.join(home, "chats", "x") })).status === 400);
    check("нужен полный путь", (await api("storage/move", { dir: "relative/dir" })).status === 400);
    const target = path.join(bigDisk, "JarvisCode");
    const insp = (await api("storage/inspect", { dir: target })).data;
    check("проверка новой папки: пустая", insp.hasStore === false && !insp.error, insp);
    events.length = 0;
    const mv = await api("storage/move", { dir: target });
    check("перенос хранилища", mv.status === 200 && mv.data.ok && mv.data.to === target, mv.data);
    check("прогресс переноса в окно", !!(await waitFor((e) => e.type === "storage.move" && e.progress.phase === "done", 3000)));
    check("данные на новом месте, старые папки убраны", fs.existsSync(path.join(target, "chats", `${chatS.id}.json`)) && fs.existsSync(path.join(target, "context", chat.id, "memory.md")) && !fs.existsSync(path.join(home, "chats")) && !fs.existsSync(path.join(home, "uploads")));
    const cf = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
    check("папка хранилища в настройках", cf.storageDir === target && (await api("state")).data.storage.dir === target, cf.storageDir);
    const moved = (await api(`chats/${chatS.id}`)).data;
    const att = moved.items.find((i: any) => i.kind === "user")?.attachments?.[0];
    check("пути вложений в чате обновлены", att?.path === path.join(target, "uploads", path.basename(upj.path)) && fs.existsSync(att.path), att);
    check("чаты на месте после переноса", (await api("state")).data.chats.some((c: any) => c.id === textChat) && (await api(`chats/${textChat}`)).data.items.length >= 6);
    // после переноса всё работает
    startAgent();
    events.length = 0;
    await api(`chats/${chatS.id}/send`, { text: "ВОПРОС после переноса" });
    check("после переноса агент отвечает", !!(await waitFor((e) => e.type === "done" && e.chatId === chatS.id)) && fs.readFileSync(path.join(target, "chats", `${chatS.id}.json`), "utf8").includes("ВОПРОС после переноса") || (await Bun.sleep(600), fs.readFileSync(path.join(target, "chats", `${chatS.id}.json`), "utf8").includes("ВОПРОС после переноса")));
    const up2 = (await (await fetch(base + "api/upload?name=b.txt", { method: "POST", headers: { "x-nc-token": token }, body: "b" })).json()) as any;
    check("новые вложения — в новой папке", up2.path?.startsWith(path.join(target, "uploads")), up2);
    await stopAgent();
    // открыть хранилище в другой папке (без переноса) и вернуться
    const empty = path.join(bigDisk, "Empty");
    const use = await api("storage/move", { dir: empty, mode: "use" });
    check("«открыть хранилище» в пустой папке → чатов нет", use.data.ok && (await api("state")).data.chats.length === 0, use.data);
    const insp2 = (await api("storage/inspect", { dir: target })).data;
    check("проверка папки: там есть хранилище", insp2.hasStore === true && insp2.chats >= 3, insp2);
    const use2 = await api("storage/move", { dir: target, mode: "use" });
    check("вернуться к хранилищу на большом диске", use2.data.ok && (await api("state")).data.chats.some((c: any) => c.id === chatS.id));
    // обратно в папку данных (перенос)
    const back = await api("storage/move", { dir: home });
    check("перенос обратно в папку по умолчанию", back.data.ok && fs.existsSync(path.join(home, "chats", `${chatS.id}.json`)) && JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")).storageDir === "", back.data);
    const back2 = (await api(`chats/${chatS.id}`)).data.items.find((i: any) => i.kind === "user")?.attachments?.[0];
    check("пути вложений снова в папке данных", back2?.path?.startsWith(path.join(home, "uploads")), back2);
  }

  // ── прочее ──
  const tk = (await api("bridge/token", {})).data;
  check("смена ключа моста", tk.bridge.mcpUrl !== br.bridge.mcpUrl && (await rpc("ping")).status === 401);
  check("настройки пересылки", (await api("bridge", { listenIdleMin: 3, chatUrl: "https://app.notion.com/agent/abc" })).data.ok && (await api("state")).data.bridgeSettings.listenIdleMin === 3);
  const badUrl = await api("bridge", { chatUrl: "javascript:alert(1)" });
  check("плохой адрес чата не сохраняется", !badUrl.data.ok && (await api("state")).data.bridgeSettings.chatUrl === "https://app.notion.com/agent/abc");
  const off = (await api("bridge", { enabled: false })).data;
  check("мост выключен", off.ok && !off.bridge.listening);
  check("переименование", (await api(`chats/${chat.id}/rename`, { title: "Тестовый чат" })).data.ok && (await api("state")).data.chats.some((c: any) => c.title === "Тестовый чат"));
  check("настройки", (await api("settings", { theme: "light", defaultMode: "plan" })).data.ok && (await api("state")).data.settings.defaultMode === "plan");
  check("просмотр папки", (await api(`fs?path=${encodeURIComponent(project)}`)).data.entries?.some((e: any) => e.name === "hello.txt"));
  check("удаление чата", (await api(`chats/${chat.id}`, undefined, "DELETE")).data.ok && !(await api("state")).data.chats.some((c: any) => c.id === chat.id));
  ws.close();
} finally {
  if (process.env.DEBUG_RECV) fs.writeFileSync(process.env.DEBUG_RECV, JSON.stringify(received, null, 1));
  agent.on = false;
  app.kill();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
  fs.rmSync(bigDisk, { recursive: true, force: true });
}

// ── очередь пересылки: простой, пауза, новый чат Notion ──
{
  const { Inbox } = await import("../src/inbox");
  const ib = new Inbox({ idleMinutes: () => 0.02, aliveMs: 300 });
  const a = await ib.next(5);
  check("простой → STOP", a.startsWith("STOP"), a);
  check("после STOP агент не на связи", !ib.state().listening && ib.state().paused, ib.state());
  const p = ib.enqueue({ chatId: "x", build: (fresh) => `msg fresh=${fresh}` });
  const b2 = await ib.next(5);
  check("новая связь → свежий контекст", b2 === "msg fresh=true", b2);
  ib.reply("ok", "need_input");
  const r = await p;
  check("ответ и статус из nc_reply", r.text === "ok" && r.status === "NEED_INPUT", r);
  const p3 = ib.enqueue({ chatId: "x", build: (fresh) => `msg fresh=${fresh}` });
  check("тот же чат в той же связи → без истории", (await ib.next(5)) === "msg fresh=false");
  ib.reply("ok");
  await p3;
  ib.markSeen("z");
  const p4 = ib.enqueue({ chatId: "z", build: (fresh) => `z fresh=${fresh}` });
  check("чат, перенесённый этим агентом, — без истории", (await ib.next(5)) === "z fresh=false");
  ib.reply("ok");
  await p4;
  const p5 = ib.enqueue({ chatId: "x", build: (fresh) => `msg fresh=${fresh}` });
  check("start → снова с контекстом", (await ib.next(5, undefined, true)) === "msg fresh=true");
  ib.reply("ok");
  await p5;
  const ac = new AbortController();
  const p2 = ib.enqueue({ chatId: "y", build: () => "y", signal: ac.signal });
  ac.abort();
  check("отмена до выдачи", (await p2).cancelled === true && ib.state().queued === 0);
}

console.log(failed ? `\n${failed} проверок не прошло` : "\nВсе проверки пройдены");
process.exit(failed ? 1 : 0);
