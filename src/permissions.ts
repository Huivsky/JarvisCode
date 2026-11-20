import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config, Mode } from "./config";
import { DATA_DIR, IS_WIN, STORE_DIR } from "./paths";

/** observe — снимок экрана, буфер обмена (ничего не меняет, но показывает личное); delete — удаление в корзину. */
export type ToolKind = "read" | "write" | "exec" | "observe" | "delete";
export type Risk = "low" | "medium" | "high";
export interface Decision {
  action: "allow" | "ask" | "deny";
  reason: string;
  risk?: Risk;
  /** Что запомнить при ответе «Всегда»: шаблон команды или `path:<файл>`. Нет — «Всегда» не предлагается. */
  remember?: string;
}

// ───────────── неотключаемые запреты ─────────────

/** Неотключаемый список опасных команд (диски, системные папки, защита Windows). */
const HARD_DENY = [
  /\bformat(\.com)?\s+[a-z]:/i,
  /\bdiskpart\b/i,
  /\bbcdedit\b/i,
  /\bcipher(\.exe)?\s+\/w/i,
  /\bvssadmin(\.exe)?\s+(delete|resize)\b/i,
  /\bwbadmin(\.exe)?\s+delete\b/i,
  /\bwmic\b.*\bshadowcopy\b.*\bdelete\b/i,
  /\bmkfs(\.\w+)?\b/i,
  /\bdd\s+.*of=\/dev\//i,
  /\brm\s+(-[a-z]*\s+)*-[a-z]*r[a-z]*\s+(-[a-z]*\s+)*(--no-preserve-root\s+)?["']?\/\*?["']?(\s|$)/i,
  /(remove-item|\bri\b|\brm\b|\brd\b|\brmdir\b|\bdel\b|\berase\b)[^|;&\n]*["'\s][a-z]:\\?(windows|program files( \(x86\))?|programdata|users)?\\?\*?(["'\s]|$)/i,
  /(remove-item|\bri\b|\brm\b|\brd\b|\brmdir\b|\bdel\b|\berase\b)[^|;&\n]*\\windows\\(system32|syswow64|winsxs)/i,
  /(remove-item|\bri\b|\brm\b)[^|;&\n]*\$env:(systemroot|windir|systemdrive|programfiles)/i,
  /set-mppreference[^|;&\n]*-disable/i,
  /\breg(\.exe)?\s+delete\s+["']?hk(lm|ey_local_machine)\\(system|software\\microsoft\\windows nt)/i,
  /clear-disk|initialize-disk|format-volume|remove-partition/i,
  /\bwevtutil(\.exe)?\s+(cl|clear-log)\b/i,
];

/** Убирает приёмы маскировки: `di`skpart`, `f^ormat`, `di""skpart`, лишние пробелы. */
export function normalizeCommand(command: string): string {
  return command
    .replace(/`(?=[a-z0-9-])/gi, "")
    .replace(/\^(?=[^\r\n])/g, "")
    .replace(/(\w)(""|'')(?=\w)/g, "$1")
    .replace(/[ \t]+/g, " ");
}

/** Текст из `-EncodedCommand <base64>` (UTF-16LE), чтобы проверить и его. */
export function decodeEncodedCommand(command: string): string | undefined {
  for (const m of command.matchAll(/(?:^|\s)[-/]([a-z]+)\s+["']?([A-Za-z0-9+/=]{8,})/gi)) {
    const flag = m[1].toLowerCase();
    if (flag !== "ec" && !(flag.startsWith("e") && "encodedcommand".startsWith(flag))) continue;
    try {
      const t = Buffer.from(m[2], "base64").toString("utf16le");
      const printable = t.replace(/[^\x20-\x7e\r\n\t]/g, "").length;
      if (t.length >= 3 && printable / t.length > 0.8) return t;
    } catch {}
  }
  return undefined;
}

function variants(command: string): string[] {
  const out = [command, normalizeCommand(command)];
  const dec = decodeEncodedCommand(command);
  if (dec) out.push(dec, normalizeCommand(dec));
  return out;
}

export function isHardDenied(command: string): boolean {
  return variants(command).some((c) => HARD_DENY.some((r) => r.test(c)));
}

// ───────────── подозрительные приёмы (скрытый код, загрузка и запуск, закрепление) ─────────────

const SUSPICIOUS: [RegExp, string][] = [
  [/\b(iex|invoke-expression)\b/i, "выполнение строки как кода (Invoke-Expression)"],
  [/frombase64string|\[convert\]::frombase64/i, "декодирование base64"],
  [/downloadstring|downloadfile|net\.webclient|start-bitstransfer|bitsadmin(\.exe)?\s+\/transfer/i, "загрузка и запуск из интернета"],
  [/\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n]*\|\s*(sh|bash|zsh|iex|invoke-expression|python\d?|node|powershell|pwsh|cmd)\b/i, "загрузка и запуск из интернета"],
  [/\bcertutil(\.exe)?\s+[^\n]*-(decode|urlcache)/i, "certutil как загрузчик"],
  [/\bmshta(\.exe)?\b|\bregsvr32(\.exe)?\s+[^\n]*\/i:|rundll32(\.exe)?\s+[^\n]*javascript:/i, "запуск скрипта через системную программу"],
  [/\s-w(i(n(d(o(w(s(t(y(l(e)?)?)?)?)?)?)?)?)?)?\s+["']?h(i(d(d(e(n)?)?)?)?)?["']?(\s|$)/i, "скрытое окно"],
  [/add-mppreference[^\n]*-exclusion|set-mppreference/i, "изменение защиты Windows"],
  [/\bschtasks(\.exe)?\s+\/create|register-scheduledtask|new-scheduledtask/i, "создание задачи планировщика"],
  [/\breg(\.exe)?\s+add\s+[^\n]*\\currentversion\\run(once)?\b|\\currentversion\\run(once)?[^\n]*new-itemproperty|set-itemproperty[^\n]*\\currentversion\\run/i, "автозапуск через реестр"],
  [/\bnet(\.exe)?\s+(user|localgroup)\s+[^\n]*\/add\b|new-localuser|add-localgroupmember/i, "создание пользователей / прав"],
  [/set-executionpolicy\s+[^\n]*(unrestricted|bypass)\s+[^\n]*-scope\s+localmachine/i, "смена политики выполнения для всей системы"],
  [/\b(netsh(\.exe)?\s+advfirewall\s+set\s+[^\n]*off|set-netfirewallprofile[^\n]*-enabled\s+(false|\$false))/i, "отключение брандмауэра"],
];

export function suspicious(command: string): string | undefined {
  if (decodeEncodedCommand(command)) return "закодированная команда PowerShell";
  for (const c of variants(command)) for (const [re, why] of SUSPICIOUS) if (re.test(c)) return why;
  return undefined;
}

// ───────────── секретные зоны ─────────────

const norm = (p: string) => path.resolve(p).replace(/\\/g, "/").toLowerCase();

const SECRET_PATHS: [RegExp, string][] = [
  [/\/\.ssh(\/|$)/, "SSH-ключи"],
  [/\/(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.pub)?$/, "SSH-ключ"],
  [/\.(pem|key|pfx|p12|ppk|jks|keystore|kdbx|kdb|gpg|asc|ovpn)$/, "ключи, сертификаты и базы паролей"],
  [/\/\.env(\.(?!example$|sample$|template$|dist$|defaults$)[\w.-]+)?$/, "файл .env с переменными и ключами"],
  [/\/(\.git-credentials|\.netrc|_netrc|\.npmrc|\.pypirc|\.pgpass)$/, "учётные данные разработчика"],
  [/\/\.(aws|azure|kube|docker|gnupg)\/|\/gcloud\/(credentials|legacy_credentials|access_tokens|application_default)|\/\.config\/gh\/hosts\.yml$/, "облачные учётные данные"],
  [/\/user data\/.*\/(login data|cookies|web data|local state|network\/cookies)(-journal)?$/, "пароли и cookies браузера"],
  [/\/user data\/local state$/, "ключ шифрования браузера"],
  [/\/profiles\/[^/]+\/(logins\.json|key[34]\.db|cookies\.sqlite|cert9\.db)$/, "пароли и cookies Firefox"],
  [/\/microsoft\/(credentials|protect|vault)(\/|$)/, "хранилище паролей Windows"],
  [/\/windows\/system32\/config\/(sam|security|system)$/, "системные базы паролей"],
  [/\/tdata(\/|$)/, "сессия Telegram"],
  [/\/(wallet\.dat|wallets?\/[^/]*)$|\/(electrum|exodus|atomic|ethereum\/keystore)(\/|$)|nkbihfbeogaeaoehlefnkodbefgpgknn/, "криптокошелёк"],
  [/\/ngrok2?\/ngrok\.yml$|\/\.ngrok2\/ngrok\.yml$|\/\.cloudflared\//, "ключи туннеля"],
];

/** Метка секретной зоны для пути (пароли, ключи, токены) или undefined. */
export function secretZone(p: string): string | undefined {
  const n = norm(p);
  // Old config can still contain tokens after moving the data directory.
  if (/\/\.(notion-code|jarvis-code)\/config\.json(?:$|[.\/])/.test(n)) return "токены Jarvis Code";
  if (n === norm(path.join(DATA_DIR, "config.json")) || n.startsWith(norm(path.join(DATA_DIR, "config.json")))) return "токены Jarvis Code";
  for (const [re, label] of SECRET_PATHS) if (re.test(n)) return label;
  return undefined;
}

/** Места, запись в которые даёт запуск кода или закрепление в системе. */
const SENSITIVE_WRITE: [RegExp, string][] = [
  [/\/start menu\/programs\/startup(\/|$)/, "автозагрузка Windows"],
  [/\/\.git\/(hooks\/|config$)/, "git-хуки и настройки git (запуск кода)"],
  [/\/(windows|program files|program files \(x86\)|programdata)(\/|$)/, "системная папка"],
  [/\/documents\/(windows)?powershell\/[^/]*profile\.ps1$/, "профиль PowerShell (запуск при старте)"],
  [/\/\.(bashrc|bash_profile|profile|zshrc|zprofile)$/, "профиль оболочки (запуск при старте)"],
  [/\/\.gitconfig$/, "глобальные настройки git"],
];

export function sensitiveWriteZone(p: string): string | undefined {
  const n = norm(p);
  if (n.startsWith(norm(DATA_DIR) + "/") && !/^\/(uploads|screenshots)\//.test(n.slice(norm(DATA_DIR).length))) return "данные Jarvis Code";
  // хранилище (чаты, память, копии файлов до правок): агент может класть файлы только во вложения и снимки
  const store = norm(STORE_DIR);
  if (n.startsWith(store + "/") && !/^\/(uploads|screenshots)\//.test(n.slice(store.length))) return "данные Jarvis Code";
  const s = secretZone(p);
  if (s) return s;
  const home = norm(os.homedir());
  for (const [re, label] of SENSITIVE_WRITE) {
    if (label === "системная папка" && n.startsWith(home)) continue;
    if (re.test(n)) return label;
  }
  return undefined;
}

const SECRET_CMD =
  /[\\/]\.ssh\b|\bid_(rsa|dsa|ecdsa|ed25519)\b|\.git-credentials|[\\/_.]netrc\b|\.npmrc\b|\.pypirc\b|login data|[\\/]cookies\b|key[34]\.db|logins\.json|\btdata\b|wallet\.dat|\.kdbx\b|microsoft[\\/](credentials|protect|vault)|config[\\/]sam\b|ngrok\.yml|\.notion-code[\\/]config|(^|[\s"'\\/=])\.env(\.(?!example|sample|template|dist)\w+)?(?=$|[\s"';|])|\.(pem|pfx|p12|ppk)\b|cmdkey(\.exe)?\s+\/list|vaultcmd|mimikatz|\blsass\b|reg(\.exe)?\s+save\s+["']?hk(lm|ey_local_machine)\\(sam|security|system)|get-storedcredential|\bconvertfrom-securestring\b/i;

export function commandTouchesSecrets(command: string): boolean {
  return variants(command).some((c) => SECRET_CMD.test(c));
}

// ───────────── разбор команд ─────────────

export interface ParsedCommand {
  segments: string[];
  /** Подстановки, блоки кода, перенаправления в файлы — такую команду нельзя одобрить шаблоном. */
  complex: boolean;
}
export type ShellKind = "ps" | "cmd" | "bash";
export const shellKind = (cfg?: Pick<Config, "shell">): ShellKind => (!IS_WIN ? "bash" : cfg?.shell === "cmd" ? "cmd" : "ps");

/**
 * Делит команду на части по ; && || | & и переводам строк с учётом кавычек.
 * Отмечает «сложные» конструкции: $(…), `…` (bash), {…}, @(…), <(…), перенаправление в файл.
 */
export function parseCommand(command: string, shell: ShellKind = shellKind()): ParsedCommand {
  const segments: string[] = [];
  let cur = "";
  let complex = false;
  let q: '"' | "'" | null = null;
  const s = command;
  const singleQuotes = shell !== "cmd";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const n = s[i + 1];
    if (q === "'") {
      cur += c;
      if (c === "'") q = null;
      continue;
    }
    if (q === '"') {
      if (c === "`") {
        if (shell !== "ps" || n === undefined || !/[0abefnrtv"`$]/.test(n)) complex = true;
        cur += c + (n ?? "");
        i++;
        continue;
      }
      if (c === "\\" && shell === "bash" && n !== undefined) {
        cur += c + n;
        i++;
        continue;
      }
      if (c === "$" && n === "(") complex = true;
      cur += c;
      if (c === '"') q = null;
      continue;
    }
    if (c === '"' || (c === "'" && singleQuotes)) {
      q = c;
      cur += c;
      continue;
    }
    if (c === "`") complex = true;
    if ((c === "$" || c === "@" || c === "<") && n === "(") complex = true;
    if (c === "{" || c === "}") complex = true;
    if (c === ">") {
      const m = s.slice(i).match(/^>(&\d|>?\s*(\$null|nul|\/dev\/null)(?![\w.]))/i);
      if (m) {
        // безопасное перенаправление (2>&1, >$null) не мешает сравнению с шаблонами
        cur = cur.replace(/\d$/, "");
        i += m[0].length - 1;
        continue;
      }
      complex = true;
    }
    if (c === "\n" || c === "\r" || c === ";" || c === "|" || c === "&") {
      if ((c === "|" || c === "&") && n === c) i++;
      if (cur.trim()) segments.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (q) complex = true;
  if (cur.trim()) segments.push(cur.trim());
  return { segments, complex };
}

function patternToRegex(p: string): RegExp {
  if (p.startsWith("re:")) return new RegExp(p.slice(3), "i");
  const esc = p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${esc}$`, "i");
}

function test(p: string, c: string): boolean {
  try {
    return patternToRegex(p).test(c);
  } catch {
    return false;
  }
}

/** Шаблон, которому соответствует вся команда целиком (для deny и старых проверок). */
export function matchPattern(patterns: string[], command: string): string | undefined {
  const c = command.trim();
  return patterns.find((p) => !p.startsWith("path:") && test(p, c));
}

/**
 * Разрешено ли шаблонами allow: каждая часть цепочки (a; b | c) должна подходить под какой-то шаблон,
 * а подстановки и перенаправления в файлы шаблоном не одобряются.
 */
export function matchAllow(patterns: string[], command: string, shell: ShellKind = shellKind()): string | undefined {
  const pats = patterns.filter((p) => p && !p.startsWith("path:"));
  if (!pats.length) return undefined;
  const { segments, complex } = parseCommand(command, shell);
  if (complex || !segments.length) return undefined;
  const used: string[] = [];
  for (const seg of segments) {
    const p = pats.find((x) => test(x, seg));
    if (!p) return undefined;
    if (!used.includes(p)) used.push(p);
  }
  return used.join(", ");
}

/** Запрет deny срабатывает, если под шаблон подходит команда целиком или любая её часть. */
export function matchDeny(patterns: string[], command: string): string | undefined {
  if (!patterns.length) return undefined;
  const whole = matchPattern(patterns, command) ?? matchPattern(patterns, normalizeCommand(command));
  if (whole) return whole;
  for (const seg of parseCommand(command).segments) {
    const p = matchPattern(patterns, seg) ?? matchPattern(patterns, normalizeCommand(seg));
    if (p) return p;
  }
  return undefined;
}

const DESTRUCTIVE =
  /^(rm|del|erase|rd|rmdir|ri|remove-item|clear-content|format|stop-process|kill|taskkill|pkill|shutdown|restart-computer|stop-computer|reg|sc|net|schtasks|takeown|icacls|cacls|attrib|move-item|mv|move|rename-item|ren|set-itemproperty|remove-itemproperty|set-acl|diskpart|bcdedit|chmod|chown|sudo|runas|start-process|saps|start|invoke-item|ii|new-service|set-service|uninstall-package|winget|choco|scoop|msiexec|robocopy|xcopy|copy-item|cp|copy|out-file|set-content|add-content|tee-object|tee|truncate|dd)$/i;
const INTERPRETERS = /^(python\d*(\.\d+)?|py|node|deno|ruby|perl|php|powershell|pwsh|cmd|bash|sh|zsh|wsl|cscript|wscript|osascript|lua|java|dotnet-script|iex|invoke-expression|curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)(\.exe)?$/i;
const SUBCOMMAND_TOOLS = /^(git|npm|pnpm|yarn|bun|npx|bunx|pnpx|docker|docker-compose|podman|cargo|go|dotnet|pip|pip3|uv|poetry|conda|kubectl|helm|gh|az|aws|gcloud|terraform|make|cmake|mvn|gradle|gradlew|flutter|dart|rustup|composer|deno)(\.exe|\.cmd)?$/i;
const RISKY_SUB = /^(push|reset|clean|rebase|checkout|restore|rm|stash|filter-branch|gc|prune|update-ref|branch|tag|remote|config|publish|unpublish|login|logout|exec|dlx|x|system|volume|run|rmi|kill|uninstall|delete|destroy|apply)$/i;

/**
 * Шаблон для «Разрешать всегда» с учётом подкоманд: «git status --short» → «git status*».
 * Для удаления, интерпретаторов, загрузок и цепочек команд «всегда» не предлагается (undefined).
 */
export function rememberPattern(command: string, shell: ShellKind = shellKind()): string | undefined {
  const { segments, complex } = parseCommand(command, shell);
  if (complex || segments.length !== 1) return undefined;
  const words = segments[0].split(/\s+/).filter(Boolean);
  if (!words.length) return undefined;
  const w0 = words[0].replace(/^["'&.\\/]+|["']+$/g, "");
  const base = path.basename(w0.replace(/\\/g, "/"));
  if (DESTRUCTIVE.test(base) || INTERPRETERS.test(base)) return undefined;
  if (suspicious(command) || commandTouchesSecrets(command)) return undefined;
  if (SUBCOMMAND_TOOLS.test(base)) {
    const sub = words[1];
    if (!sub || sub.startsWith("-")) return `${words[0]}*`;
    if (/^(run|run-script|task)$/i.test(sub) && words[2] && !words[2].startsWith("-")) return `${words.slice(0, 3).join(" ")}*`;
    if (RISKY_SUB.test(sub)) return undefined;
    return `${words.slice(0, 2).join(" ")}*`;
  }
  return words.length > 1 ? `${words.slice(0, 2).join(" ")}*` : `${words[0]}*`;
}

/** Оценка риска команды — для бейджа на карточке подтверждения. */
export function commandRisk(command: string): Risk {
  if (isHardDenied(command) || suspicious(command) || commandTouchesSecrets(command)) return "high";
  const { segments, complex } = parseCommand(command);
  const firsts = segments.map((s) => path.basename((s.split(/\s+/)[0] ?? "").replace(/\\/g, "/").replace(/^["'&]+|["']+$/g, "")));
  if (firsts.some((w) => /^(rm|del|erase|rd|rmdir|ri|remove-item|format|stop-process|kill|taskkill|shutdown|restart-computer|reg|takeown|icacls|diskpart)$/i.test(w))) return "high";
  if (/\s(-rf|-fr|\/s|\/q|-recurse|-force)\b/i.test(command) && firsts.some((w) => DESTRUCTIVE.test(w))) return "high";
  if (complex || segments.length > 1 || firsts.some((w) => DESTRUCTIVE.test(w) || INTERPRETERS.test(w))) return "medium";
  if (/\b(install|add|update|upgrade|push|publish|deploy)\b/i.test(command)) return "medium";
  return "low";
}

// ───────────── решение ─────────────

function inside(root: string, p: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function decide(o: {
  cfg: Config;
  mode: Mode;
  kind: ToolKind;
  project: string;
  paths?: string[];
  command?: string;
  sessionAllow: string[];
  /** Инструмент видит только имена файлов (список папки, поиск по имени) — секретные зоны не проверяются. */
  namesOnly?: boolean;
  /** Имя инструмента — для «Всегда в этом чате» у снимка экрана и буфера обмена. */
  tool?: string;
}): Decision {
  const { cfg, mode, kind, project, paths = [], command, sessionAllow, namesOnly } = o;
  const auto = mode === "autonomous";
  if (command && isHardDenied(command))
    return { action: "deny", reason: "Команда в неотключаемом списке опасных (диски, системные папки, защита Windows).", risk: "high" };
  if (command) {
    const d = matchDeny(cfg.deny, command);
    if (d) return { action: "deny", reason: `Команда запрещена правилом deny: ${d}`, risk: "high" };
  }
  if (cfg.fileScope === "project" && paths.some((p) => !inside(project, p))) {
    if (auto) return { action: "deny", reason: "Путь вне папки проекта (ограничение «только папка проекта»)." };
    return { action: "ask", reason: "Путь вне папки проекта.", risk: "medium" };
  }
  const approved = new Set(sessionAllow.filter((s) => s.startsWith("path:")).map((s) => s.slice(5)));
  if (kind === "read") {
    if (!namesOnly) {
      for (const p of paths) {
        const z = secretZone(p);
        if (z && !approved.has(norm(p))) {
          if (auto) return { action: "deny", reason: `Секретная зона (${z}): в автономном режиме чтение запрещено — попросите пользователя.`, risk: "high" };
          return { action: "ask", reason: `Секретная зона: ${z}. Агент хочет прочитать содержимое.`, risk: "high", remember: `path:${norm(p)}` };
        }
      }
    }
    return { action: "allow", reason: "чтение" };
  }
  if (kind === "observe") {
    // экран и буфер обмена — личное: только с согласия человека в этом чате, в любом режиме
    const remember = `observe:${o.tool ?? "*"}`;
    if (sessionAllow.includes(remember)) return { action: "allow", reason: "разрешено в этом чате" };
    const what = o.tool === "nc_clipboard" ? "буфер обмена (там бывают пароли и личные данные)" : "экран (всё, что сейчас открыто)";
    if (auto) return { action: "deny", reason: `Автономный режим: ${what} — только с согласия человека. Попросите пользователя.`, risk: "medium" };
    return { action: "ask", reason: `Агент увидит ${what}.`, risk: "medium", remember };
  }
  if (mode === "plan") return { action: "deny", reason: "Режим «План»: разрешено только чтение. Смените режим доступа." };
  if (kind === "write" || kind === "delete") {
    for (const p of paths) {
      const z = sensitiveWriteZone(p);
      if (z && !approved.has(norm(p))) {
        if (auto) return { action: "deny", reason: `Защищённое место (${z}): в автономном режиме запись запрещена.`, risk: "high" };
        return { action: "ask", reason: `Защищённое место: ${z}.`, risk: "high", remember: `path:${norm(p)}` };
      }
    }
  }
  if (kind === "exec" && command) {
    const why = suspicious(command);
    if (why) {
      if (auto) return { action: "deny", reason: `Подозрительная команда (${why}) — в автономном режиме запрещена.`, risk: "high" };
      return { action: "ask", reason: `Подозрительная команда: ${why}.`, risk: "high" };
    }
    if (commandTouchesSecrets(command)) {
      if (auto) return { action: "deny", reason: "Команда обращается к паролям, ключам или токенам — в автономном режиме запрещена.", risk: "high" };
      return { action: "ask", reason: "Команда обращается к паролям, ключам или токенам.", risk: "high" };
    }
    const a = matchAllow([...cfg.allow, ...sessionAllow], command, shellKind(cfg));
    if (a) return { action: "allow", reason: `allow: ${a}` };
  }
  if (kind === "delete") {
    // в корзину (восстановимо); без вопроса — только внутри папки проекта в полном/автономном режиме, «Всегда» не предлагается
    // «папка проекта» не считается, если это вся домашняя папка или корень диска; саму папку проекта — только с вопросом
    const root = path.resolve(project);
    const broad = norm(root) === norm(os.homedir()) || path.parse(root).root === root;
    const outside = broad || paths.some((p) => !inside(root, p) || path.resolve(p) === root);
    if ((mode === "full" || auto) && !outside) return { action: "allow", reason: `${mode}: в папке проекта` };
    if (auto) return { action: "deny", reason: "Автономный режим: удалять вне папки проекта нельзя — попросите пользователя.", risk: "high" };
    const dirs = paths.some((p) => {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
    return {
      action: "ask",
      reason: `${dirs ? "Удаление папок" : "Удаление"} в корзину — можно восстановить${outside ? "; вне папки проекта" : ""}.`,
      risk: dirs || outside ? "high" : "medium",
    };
  }
  const risk = command ? commandRisk(command) : kind === "write" ? "medium" : "low";
  const remember = command ? rememberPattern(command, shellKind(cfg)) : undefined;
  switch (mode) {
    case "ask":
      return { action: "ask", reason: "Режим «Спрашивать»", risk, remember };
    case "auto-edit":
      return kind === "write"
        ? { action: "allow", reason: "Авто-правки" }
        : { action: "ask", reason: "Авто-правки: команды с подтверждением", risk, remember };
    case "full":
    case "autonomous":
      return { action: "allow", reason: mode };
  }
  return { action: "ask", reason: "", risk, remember };
}
