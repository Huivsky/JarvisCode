import { Marked, type Tokens } from "marked";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const SAFE_URL = /^(https?:|mailto:)/i;
const WIN_PATH = /^(?:[a-zA-Z]:\\|\\\\|~[\\/]|%[A-Z_]+%\\)[^\n<>"|?*]*$/;

const LANG_NAMES: Record<string, string> = {
  ps1: "PowerShell", powershell: "PowerShell", pwsh: "PowerShell", sh: "bash", bash: "bash", shell: "shell", cmd: "cmd", bat: "batch",
  ts: "TypeScript", tsx: "TSX", js: "JavaScript", jsx: "JSX", json: "JSON", py: "Python", python: "Python", rs: "Rust", go: "Go",
  cs: "C#", cpp: "C++", c: "C", java: "Java", kt: "Kotlin", html: "HTML", css: "CSS", sql: "SQL", yaml: "YAML", yml: "YAML", toml: "TOML",
  md: "Markdown", diff: "diff", xml: "XML", ini: "INI",
};

/** Очень лёгкая подсветка: строки, комментарии, числа и ключевые слова. */
function highlight(code: string, lang: string): string {
  const l = lang.toLowerCase();
  if (l === "diff") {
    return code
      .split("\n")
      .map((line) => {
        const e = esc(line);
        if (line.startsWith("+")) return `<span class="hl-add">${e}</span>`;
        if (line.startsWith("-")) return `<span class="hl-del">${e}</span>`;
        if (line.startsWith("@@")) return `<span class="hl-meta">${e}</span>`;
        return e;
      })
      .join("\n");
  }
  const kw =
    /^(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|class|extends|new|import|from|export|default|async|await|try|catch|finally|throw|typeof|interface|type|enum|public|private|protected|static|def|elif|in|of|not|and|or|is|None|True|False|true|false|null|undefined|void|fn|pub|impl|struct|use|mod|match|package|func|using|namespace|param|foreach|echo|then|fi|esac)$/;
  const lineComment = ["py", "python", "sh", "bash", "shell", "ps1", "powershell", "pwsh", "yaml", "yml", "toml", "ini", "rb"].includes(l) ? "#" : "//";
  const re = new RegExp(
    `(${lineComment === "#" ? "#[^\\n]*" : "\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/"})|("(?:[^"\\\\\\n]|\\\\.)*"|'(?:[^'\\\\\\n]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`)|(\\b\\d+(?:\\.\\d+)?\\b)|(\\$?[A-Za-z_][\\w-]*)`,
    "g",
  );
  let out = "";
  let last = 0;
  for (const m of code.matchAll(re)) {
    out += esc(code.slice(last, m.index));
    const [t, c, s, n, w] = m;
    if (c) out += `<span class="hl-com">${esc(c)}</span>`;
    else if (s) out += `<span class="hl-str">${esc(s)}</span>`;
    else if (n) out += `<span class="hl-num">${esc(n)}</span>`;
    else if (w && kw.test(w)) out += `<span class="hl-kw">${esc(w)}</span>`;
    else if (w && w.startsWith("$")) out += `<span class="hl-var">${esc(w)}</span>`;
    else out += esc(t);
    last = (m.index ?? 0) + t.length;
  }
  return out + esc(code.slice(last));
}

const md = new Marked({ gfm: true, breaks: false });
md.use({
  renderer: {
    // Любой «сырой» HTML от модели показываем как текст — никакого XSS.
    html(token: Tokens.HTML | Tokens.Tag) {
      return esc(token.text);
    },
    link(token: Tokens.Link) {
      const text = this.parser.parseInline(token.tokens);
      if (!SAFE_URL.test(token.href)) return text;
      return `<a href="${esc(token.href)}" data-external="1" title="${esc(token.href)}">${text}</a>`;
    },
    image(token: Tokens.Image) {
      if (!SAFE_URL.test(token.href)) return esc(token.text);
      return `<a href="${esc(token.href)}" data-external="1">🖼 ${esc(token.text || token.href)}</a>`;
    },
    code(token: Tokens.Code) {
      const lang = (token.lang ?? "").trim().split(/\s+/)[0] ?? "";
      const name = LANG_NAMES[lang.toLowerCase()] ?? lang;
      return `<div class="codeblock"><div class="codeblock-head"><span>${esc(name || "код")}</span><button class="copy-btn" data-copy="1" type="button">Копировать</button></div><pre><code>${highlight(token.text, lang)}</code></pre></div>`;
    },
    codespan(token: Tokens.Codespan) {
      const raw = token.text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      if (WIN_PATH.test(raw)) return `<code class="path" data-path="${esc(raw)}" title="Показать в проводнике">${esc(raw)}</code>`;
      return `<code>${esc(raw)}</code>`;
    },
    table(token: Tokens.Table) {
      const head = token.header.map((c) => `<th${c.align ? ` style="text-align:${c.align}"` : ""}>${this.parser.parseInline(c.tokens)}</th>`).join("");
      const rows = token.rows
        .map((r) => `<tr>${r.map((c) => `<td${c.align ? ` style="text-align:${c.align}"` : ""}>${this.parser.parseInline(c.tokens)}</td>`).join("")}</tr>`)
        .join("");
      return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
    },
  },
});

export function renderMarkdown(text: string): string {
  try {
    return md.parse(text, { async: false }) as string;
  } catch {
    return `<p>${esc(text)}</p>`;
  }
}

export { esc };