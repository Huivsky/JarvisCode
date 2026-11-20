/**
 * Общие типы и защита текста для агента в чате Notion (мост MCP, пересылка из окна Jarvis Code).
 */

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
  error?: string;
}

export type AgentStatus = "DONE" | "CONTINUE" | "NEED_INPUT" | "BLOCKED";
const STATUS_RE = /^\s*NC_STATUS:\s*(DONE|CONTINUE|NEED_INPUT|BLOCKED)\s*$/im;

/** Строка «NC_STATUS: …» в конце ответа (если агент написал её текстом, а не полем status). */
export function splitStatus(text: string): { body: string; status?: AgentStatus } {
  const lines = text.replace(/\s+$/, "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 3); i--) {
    const m = lines[i].match(STATUS_RE);
    if (m) {
      lines.splice(i, 1);
      return { body: lines.join("\n").trimEnd(), status: m[1].toUpperCase() as AgentStatus };
    }
  }
  return { body: text };
}

/**
 * Вывод инструментов и файлов не может выдать себя за сообщение пользователя
 * или за блоки, которые добавляет только приложение (<user_message>, <previous_conversation>…).
 */
export function neutralize(text: string): string {
  return text.replace(/<(\/?)(nc_results?|user_message|previous_conversation|chat_memory|imported_conversation)\b/gi, "<\u200b$1$2");
}
