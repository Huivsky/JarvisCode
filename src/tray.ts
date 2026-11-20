/**
 * Значок в области уведомлений (без окна консоли): скрытый PowerShell с NotifyIcon.
 * Команды в PowerShell — по stdin, клики меню — обратно по stdout.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, IS_WIN } from "./paths";
import { ICON_ICO_BASE64 } from "./ui-assets.gen";

export type TrayCommand = "open" | "notion" | "bridge" | "copy" | "autostart" | "exit" | "balloon";

const SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
# Console.In.ReadLineAsync is synchronous in .NET (SyncTextReader) and would freeze the menu - read stdin with our own StreamReader.
$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), (New-Object System.Text.UTF8Encoding($false)))
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$ni = New-Object System.Windows.Forms.NotifyIcon
$ni.Icon = New-Object System.Drawing.Icon('__ICON__')
$ni.Text = 'Jarvis Code'
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$items = @{}
function Send([string]$s) { [Console]::Out.WriteLine($s); [Console]::Out.Flush() }
function Add([string]$key, [string]$text) {
  $it = New-Object System.Windows.Forms.ToolStripMenuItem($text)
  $it.Tag = $key
  $it.add_Click({ param($s, $e) Send $s.Tag })
  [void]$menu.Items.Add($it)
  $items[$key] = $it
}
function Sep { [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) }
Add 'open' '__L_open__'
$items['open'].Font = New-Object System.Drawing.Font($items['open'].Font, [System.Drawing.FontStyle]::Bold)
Add 'notion' '__L_notion__'
Sep
Add 'status' '__L_status__'
$items['status'].Enabled = $false
Add 'bridge' '__L_bridge__'
Add 'copy' '__L_copy__'
Sep
Add 'autostart' '__L_autostart__'
Sep
Add 'exit' '__L_exit__'
$ni.ContextMenuStrip = $menu
$ni.add_MouseClick({ param($s, $e) if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Send 'open' } })
$ni.add_BalloonTipClicked({ Send 'balloon' })
$ni.Visible = $true
$script:task = $stdin.ReadLineAsync()
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 150
$timer.add_Tick({
  while ($script:task.IsCompleted) {
    $line = $script:task.Result
    if ($line -eq $null) { $ni.Visible = $false; $ni.Dispose(); [System.Windows.Forms.Application]::Exit(); return }
    $p = $line.Split([char]9)
    switch ($p[0]) {
      'tip' { $t = $p[1]; if ($t.Length -gt 63) { $t = $t.Substring(0, 63) }; $ni.Text = $t }
      'check' { if ($items[$p[1]]) { $items[$p[1]].Checked = ($p[2] -eq '1') } }
      'enable' { if ($items[$p[1]]) { $items[$p[1]].Enabled = ($p[2] -eq '1') } }
      'text' { if ($items[$p[1]]) { $items[$p[1]].Text = $p[2] } }
      'balloon' { $ni.ShowBalloonTip(8000, $p[1], $p[2], [System.Windows.Forms.ToolTipIcon]::Info) }
      'copy' { [System.Windows.Forms.Clipboard]::SetText($p[1]) }
      'exit' { $ni.Visible = $false; $ni.Dispose(); [System.Windows.Forms.Application]::Exit(); return }
    }
    $script:task = $stdin.ReadLineAsync()
  }
})
$timer.Start()
[System.Windows.Forms.Application]::Run()
$ni.Visible = $false
$ni.Dispose()
`;

/**
 * Подписи меню — обычными строками, не внутри String.raw: при сборке exe минификатор Bun
 * записывает не-ASCII символы как \uXXXX, а в String.raw такие escape-последовательности
 * остаются как есть — в трее было «\u041E\u0442…» вместо «Открыть».
 */
const LABELS: Record<string, string> = {
  open: "Открыть Jarvis Code",
  notion: "Открыть Notion",
  status: "Мост: …",
  bridge: "Мост для агента в Notion",
  copy: "Скопировать адрес MCP",
  autostart: "Запускать при входе в Windows",
  exit: "Выход",
};

export function trayScript(icon: string): string {
  let s = SCRIPT.replace("__ICON__", icon.replace(/'/g, "''"));
  for (const [k, t] of Object.entries(LABELS)) s = s.replace(`__L_${k}__`, t.replace(/'/g, "''"));
  return s;
}

export class Tray {
  private child: ChildProcess | null = null;
  private restarts = 0;
  private last: Record<string, string> = {};
  private closed = false;

  constructor(private onCommand: (c: TrayCommand) => void) {}

  get available() {
    return IS_WIN;
  }

  start() {
    if (!IS_WIN || this.child) return;
    const icon = path.join(DATA_DIR, "tray.ico");
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(icon, Buffer.from(ICON_ICO_BASE64, "base64"));
    } catch {}
    const enc = Buffer.from(trayScript(icon), "utf16le").toString("base64");
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-STA", "-WindowStyle", "Hidden", "-EncodedCommand", enc], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.child = child;
    let buf = "";
    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      const parts = buf.split(/\r?\n/);
      buf = parts.pop() ?? "";
      for (const p of parts) {
        const c = p.trim() as TrayCommand;
        if (c) this.onCommand(c);
      }
    });
    child.on("error", () => {});
    child.on("close", () => {
      this.child = null;
      if (!this.closed && this.restarts++ < 3) setTimeout(() => this.start(), 2000);
    });
    // восстановить состояние после перезапуска значка
    const state = this.last;
    this.last = {};
    for (const [k, v] of Object.entries(state)) this.write(k, v);
  }

  private write(key: string, line: string) {
    this.last[key] = line;
    try {
      this.child?.stdin?.write(line.replace(/[\r\n]+/g, " ") + "\n");
    } catch {}
  }

  tip(text: string) {
    this.write("tip", `tip\t${text}`);
  }
  check(item: string, on: boolean) {
    this.write(`check:${item}`, `check\t${item}\t${on ? 1 : 0}`);
  }
  enable(item: string, on: boolean) {
    this.write(`enable:${item}`, `enable\t${item}\t${on ? 1 : 0}`);
  }
  text(item: string, text: string) {
    this.write(`text:${item}`, `text\t${item}\t${text}`);
  }
  balloon(title: string, body: string) {
    try {
      this.child?.stdin?.write(`balloon\t${title.replace(/[\t\r\n]+/g, " ")}\t${(body || " ").replace(/[\t\r\n]+/g, " ")}\n`);
    } catch {}
  }
  copy(text: string) {
    try {
      this.child?.stdin?.write(`copy\t${text}\n`);
    } catch {}
  }

  stop() {
    this.closed = true;
    try {
      this.child?.stdin?.write("exit\n");
      this.child?.stdin?.end();
    } catch {}
    const c = this.child;
    setTimeout(() => {
      try {
        if (c && c.exitCode === null) c.kill();
      } catch {}
    }, 800);
    this.child = null;
  }
}
