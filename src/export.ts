/** Чат → Markdown («Сохранить в Markdown»): сообщения, шаги агента и разрешения — для архива, письма или страницы Notion. */
import fs from "node:fs";
import path from "node:path";
import type { Chat } from "./chats";
import type { Mode } from "./config";

const MODE_LABEL: Record<Mode, string> = { plan: "План", ask: "Спрашивать", "auto-edit": "Авто-правки", full: "Полный доступ", autonomous: "Автономно" };
const MARK: Record<string, string> = { ok: "✓", error: "✕", denied: "⊘", waiting: "…", running: "…" };
const ANSWER: Record<string, string> = { yes: "разрешено", always: "разрешено до конца чата", no: "отклонено", timeout: "нет ответа — отклонено" };

const oneLine = (s: string, n = 160) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};
/** Встроенный код, внутри которого могут быть обратные кавычки. */
const code = (s: string) => {
  const t = oneLine(s);
  if (!t.includes("`")) return `\`${t}\``;
  const n = Math.max(...[...t.matchAll(/`+/g)].map((m) => m[0].length)) + 1;
  return `${"`".repeat(n)} ${t} ${"`".repeat(n)}`;
};

export function chatMarkdown(chat: Chat): string {
  const when = (t: number) => new Date(t).toLocaleString("ru-RU", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const mode = MODE_LABEL[chat.mode] ?? chat.mode;
  const out: string[] = [`# ${chat.title.replace(/\n/g, " ")}`, "", `_Jarvis Code · ${when(chat.createdAt)} · папка ${code(chat.project)} · режим «${mode}»_`, ""];
  // string, а не объединение: значение меняют и вложенные функции — сужение типа здесь не подходит
  let last = "" as string;
  const agent = () => {
    if (last === "steps") out.push("");
    if (last !== "agent" && last !== "steps") out.push("## Агент", "");
  };
  const step = (line: string) => {
    if (last !== "steps") agent();
    out.push(line);
    last = "steps";
  };
  for (const it of chat.items) {
    if (it.kind === "user") {
      if (last === "steps") out.push("");
      out.push(it.queue === "steer" ? "## Вы (по ходу работы)" : "## Вы", "", it.text?.trim() || "_(без текста)_", "");
      const atts = it.attachments ?? [];
      if (atts.length) out.push(`Вложения: ${atts.map((a) => code(a.path ?? a.name)).join(", ")}`, "");
      last = "user";
    } else if (it.kind === "assistant") {
      agent();
      out.push(it.text?.trim() ?? "", "");
      last = "agent";
    } else if (it.kind === "tool") {
      const st = it.undone ? "↶" : (MARK[it.status ?? "ok"] ?? "•");
      step(`- ${st} **${it.label || it.tool}**${it.summary ? ` ${code(it.summary)}` : ""}${it.result ? ` — ${oneLine(it.result)}` : ""}${it.undone ? " _(отменено)_" : ""}`);
    } else if (it.kind === "approval" && it.approval) {
      const a = it.approval;
      step(`- 🛡 ${a.heading}${a.summary ? ` ${code(a.summary)}` : ""} — ${ANSWER[a.answer ?? ""] ?? "ждёт ответа"}${a.feedback ? ` («${oneLine(a.feedback)}»)` : ""}`);
    } else if (it.kind === "notice" || it.kind === "error") {
      if (!it.text?.trim()) continue;
      step(`- ${it.kind === "error" ? "⚠" : "ℹ"} ${oneLine(it.text, 300)}`);
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/** Сохраняет Markdown чата в папку (обычно «Загрузки»), не перезаписывая файлы. */
export function saveChatMarkdown(chat: Chat, dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  let base = chat.title.replace(/[<>:"/\\|?*\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80).replace(/[. ]+$/, "") || "Чат Jarvis Code";
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(base)) base = `Чат ${base}`; // имена, занятые Windows
  let file = path.join(dir, `${base}.md`);
  for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${base} (${i}).md`);
  fs.writeFileSync(file, chatMarkdown(chat), "utf8");
  return file;
}
