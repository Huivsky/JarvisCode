/**
 * Свои «/»-команды — Markdown-файлы с готовыми заданиями для агента (как в Claude Code):
 *   <папка проекта>/.jarvis/commands/*.md — команды проекта (можно хранить в git);
 *   <папка проекта>/.claude/commands/*.md — те же файлы Claude Code подходят без изменений;
 *   ~/.notion-code/commands/*.md — личные, во всех папках.
 * Имя команды — имя файла (/deploy → deploy.md). Описание — `description:` в шапке
 * `---` … `---` или первая строка файла. `$ARGUMENTS` заменяется текстом после имени команды.
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./paths";

export const USER_COMMANDS_DIR = path.join(DATA_DIR, "commands");
/** Встроенные команды окна — свои с такими именами не подменяют их. */
const BUILTIN = new Set(["init", "review", "plan", "ask", "auto", "full", "folder", "notion", "model", "new", "commands"]);
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const MAX_FILE = 64_000;
const MAX_COMMANDS = 60;

export interface CustomCommand {
  name: string;
  description: string;
  source: "project" | "user";
  file: string;
  /** В тексте есть $ARGUMENTS — после выбора команды нужно дописать аргументы. */
  args: boolean;
}

function parse(raw: string): { description: string; body: string } {
  let text = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  let description = "";
  const fm = text.match(/^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  if (fm) {
    const d = fm[1].match(/^description:[ \t]*(.+)$/m);
    if (d) description = d[1].trim().replace(/^(["'])(.*)\1$/, "$2");
    text = text.slice(fm[0].length);
  }
  const body = text.trim();
  if (!description) description = (body.split("\n").find((l) => l.trim()) ?? "").replace(/^#+\s*/, "").trim();
  return { description: description.length > 100 ? description.slice(0, 99) + "…" : description, body };
}

function dirs(project: string): { dir: string; source: CustomCommand["source"] }[] {
  const p = project ? path.resolve(project) : "";
  return [
    ...(p ? [{ dir: path.join(p, ".jarvis", "commands"), source: "project" as const }, { dir: path.join(p, ".claude", "commands"), source: "project" as const }] : []),
    { dir: USER_COMMANDS_DIR, source: "user" },
  ];
}

/** Команды для папки проекта: сначала команды проекта, затем личные (одноимённые личные скрываются). */
export function listCommands(project: string): CustomCommand[] {
  const seen = new Set<string>();
  const out: CustomCommand[] = [];
  for (const { dir, source } of dirs(project)) {
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((n) => /\.md$/i.test(n)).sort((a, b) => a.localeCompare(b));
    } catch {
      continue;
    }
    for (const n of names) {
      const name = n.slice(0, -3).toLowerCase();
      if (!NAME_RE.test(name) || seen.has(name) || BUILTIN.has(name)) continue;
      const file = path.join(dir, n);
      try {
        const st = fs.statSync(file);
        if (!st.isFile() || st.size > MAX_FILE) continue;
        const { description, body } = parse(fs.readFileSync(file, "utf8"));
        if (!body) continue;
        seen.add(name);
        out.push({ name, description: description || name, source, file, args: body.includes("$ARGUMENTS") });
      } catch {}
      if (out.length >= MAX_COMMANDS) return out;
    }
  }
  return out;
}

/** «/имя аргументы» → задание из файла команды; null — это не своя команда. */
export function expandCommand(project: string, text: string): { name: string; prompt: string; file: string } | null {
  const m = text.match(/^\/([a-z0-9][a-z0-9_-]{0,39})(?:\s+([\s\S]*))?$/i);
  if (!m) return null;
  const name = m[1].toLowerCase();
  if (BUILTIN.has(name)) return null;
  const cmd = listCommands(project).find((c) => c.name === name);
  if (!cmd) return null;
  let body: string;
  try {
    body = parse(fs.readFileSync(cmd.file, "utf8")).body;
  } catch {
    return null;
  }
  const args = (m[2] ?? "").trim();
  const prompt = body.includes("$ARGUMENTS") ? body.split("$ARGUMENTS").join(args) : args ? `${body}\n\n${args}` : body;
  return { name, prompt, file: cmd.file };
}

/** Папка личных команд с примером — открывается из «/commands». */
export function ensureUserCommands(): string {
  fs.mkdirSync(USER_COMMANDS_DIR, { recursive: true });
  const example = path.join(USER_COMMANDS_DIR, "explain.md");
  if (!fs.readdirSync(USER_COMMANDS_DIR).some((n) => /\.md$/i.test(n)))
    fs.writeFileSync(
      example,
      [
        "---",
        "description: Объяснить код простыми словами",
        "---",
        "Объясни простыми словами, как устроен и что делает $ARGUMENTS: главная идея, ключевые места, неочевидные моменты и риски.",
        "Ничего не меняй — только читай файлы.",
        "",
      ].join("\n"),
      "utf8",
    );
  return USER_COMMANDS_DIR;
}
