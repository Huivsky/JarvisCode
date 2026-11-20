import fs from "node:fs";
import { AUDIT_LOG, DATA_DIR } from "./paths";

/** Журнал действий агента на ПК (JSON Lines). Токены сюда не пишутся. */
export function audit(entry: Record<string, unknown>): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(AUDIT_LOG, JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n");
  } catch {
    /* журнал не критичен */
  }
}

/** Текст ошибки для пользователя. */
export function describeError(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as any).message);
  return String(e);
}
