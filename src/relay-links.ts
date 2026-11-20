/** A destination is a browser link, not a separate MCP session: a Notion AI chat or a Retool app/chat. */
const NOTION_HOSTS = ["notion.so", "notion.com"];
const RETOOL_HOSTS = ["retool.com", "retool.app"];
const matches = (host: string, bases: string[]) => bases.some((base) => host === base || host.endsWith("." + base));

export type RelayService = "notion" | "retool";

/** Which agent the destination link points to (unknown or empty — Notion, the default). */
export function relayService(value: string | undefined): RelayService {
  try { return matches(new URL(value ?? "").hostname.toLowerCase(), RETOOL_HOSTS) ? "retool" : "notion"; }
  catch { return "notion"; }
}

export function normalizeRelayUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("Нужна строка со ссылкой на чат Notion или Retool");
  let text = value.trim();
  if (!text) return "";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = "https://" + text;
  let url: URL;
  try { url = new URL(text); } catch { throw new Error("Некорректная ссылка на чат Notion или Retool"); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.port || /\s/.test(text) ||
      !(matches(host, NOTION_HOSTS) || matches(host, RETOOL_HOSTS)))
    throw new Error("Нужна HTTPS-ссылка на notion.so, notion.com, retool.com или retool.app");
  return url.href;
}
export function relayDestination(own: string | undefined, global: string, fallback: string): string {
  for (const candidate of [own, global]) {
    try { const url = normalizeRelayUrl(candidate ?? ""); if (url) return url; } catch { /* legacy invalid value */ }
  }
  return fallback;
}
