/** Контекст чатов: разбор вставленной переписки, история для агента, пути после переноса хранилища. */
import { parseTranscript, chatHistory, recentTranscript } from "../src/context";
import { rewritePaths, type Chat } from "../src/chats";

let failed = 0;
const check = (name: string, ok: unknown, extra?: unknown) => {
  console.log(`${ok ? "✓" : "✗"} ${name}${!ok && extra !== undefined ? ` — ${JSON.stringify(extra).slice(0, 400)}` : ""}`);
  if (!ok) failed++;
};

const t1 = parseTranscript("Вы: Привет\nNotion AI: Здравствуйте!\nЧем помочь?\nВы: Сделай отчёт\n");
check("переписка «Вы / Notion AI»", t1.length === 3 && t1[1].role === "assistant" && t1[1].text === "Здравствуйте!\nЧем помочь?" && t1[2].text === "Сделай отчёт", t1);
const t2 = parseTranscript("# Чат\n\n## Вы\n\nвопрос\n\n## Агент\n\nответ с кодом:\n```\nВы: не маркер\n```\n");
check("экспорт Jarvis Code «## Вы / ## Агент», код не ломает", t2.length === 2 && t2[1].text.includes("Вы: не маркер"), t2);
check("обычный текст — не переписка", parseTranscript("Я думаю, что надо сделать отчёт.\nЕщё заметка.").length === 0);
check("English: User / Assistant", parseTranscript("User: hi\nAssistant: hello\n").length === 2);

const chat: Chat = {
  id: "c1",
  title: "Тест",
  createdAt: 0,
  updatedAt: 0,
  mode: "ask",
  project: "C:\\p",
  items: Array.from({ length: 50 }, (_, k) => ({ id: `i${k}`, kind: k % 2 ? "assistant" : "user", at: k * 1000, text: k === 3 ? "секретный рецепт пирога" : `сообщение ${k} ` + "x".repeat(2000) })) as Chat["items"],
};
const h = chatHistory(chat, { query: "рецепт" });
check("nc_history: поиск", h.includes("1 match") && h.includes("#4 Assistant") && h.includes("секретный рецепт"), h.slice(0, 300));
const h2 = chatHistory(chat, { from: 1, limit: 2 });
check("nc_history: по номерам", h2.includes("#1 User") && h2.includes("#2 Assistant") && !h2.includes("#3 "), h2.slice(0, 200));
const r = recentTranscript(chat, 10_000, false);
check("начальный контекст: последние сообщения в бюджете, остальное — счётчик", r.omitted > 0 && r.text.includes("#50 ") && r.text.length < 13_000, { omitted: r.omitted, len: r.text.length });

const win = { a: "C:\\Users\\me\\.notion-code\\uploads\\f.png", b: ["см. C:\\Users\\me\\.notion-code\\screenshots\\s.png"], c: "C:\\Users\\me\\.notion-code-other\\x", d: "C:/Users/me/.notion-code/uploads/g.txt" };
const out = rewritePaths(JSON.parse(JSON.stringify(win)), "C:\\Users\\me\\.notion-code", "D:\\JC");
check("пути хранилища заменяются (\\ и /)", out.a === "D:\\JC\\uploads\\f.png" && out.b[0] === "см. D:\\JC\\screenshots\\s.png" && out.d === "D:/JC/uploads/g.txt", out);
check("похожие папки не трогаются", out.c === win.c, out.c);

console.log(failed ? `\n${failed} проверок не прошло` : "\nВсе проверки пройдены");
process.exit(failed ? 1 : 0);
