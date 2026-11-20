import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { HISTORY_DIR } from "./paths";

// ───────────── кодировки: правки не портят файлы в windows-1251 / UTF-16 / с BOM ─────────────

export type Encoding = "utf8" | "utf8bom" | "utf16le" | "utf16be" | "cp1251";
export type Eol = "\r\n" | "\n";
export interface Decoded {
  text: string;
  enc: Encoding;
  eol: Eol;
}
export const ENCODING_LABEL: Record<Encoding, string> = {
  utf8: "UTF-8",
  utf8bom: "UTF-8 с BOM",
  utf16le: "UTF-16 LE",
  utf16be: "UTF-16 BE",
  cp1251: "windows-1251",
};

export function isBinary(buf: Buffer): boolean {
  if (hasUtf16Bom(buf)) return false;
  return buf.subarray(0, 8000).includes(0);
}
const hasUtf16Bom = (b: Buffer) => b.length >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff));

export function detectEol(text: string): Eol {
  const crlf = text.split("\r\n").length - 1;
  const lf = text.split("\n").length - 1 - crlf;
  return crlf > 0 && crlf >= lf ? "\r\n" : "\n";
}

export function decodeBuffer(buf: Buffer): Decoded {
  let text: string;
  let enc: Encoding;
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    text = buf.subarray(3).toString("utf8");
    enc = "utf8bom";
  } else if (buf[0] === 0xff && buf[1] === 0xfe) {
    text = buf.subarray(2).toString("utf16le");
    enc = "utf16le";
  } else if (buf[0] === 0xfe && buf[1] === 0xff) {
    const sw = Buffer.from(buf.subarray(2));
    swapBytes(sw);
    text = sw.toString("utf16le");
    enc = "utf16be";
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
      enc = "utf8";
    } catch {
      text = new TextDecoder("windows-1251").decode(buf);
      enc = "cp1251";
    }
  }
  return { text, enc, eol: detectEol(text) };
}

function swapBytes(b: Buffer) {
  for (let i = 0; i + 1 < b.length; i += 2) {
    const t = b[i];
    b[i] = b[i + 1];
    b[i + 1] = t;
  }
}

let cp1251: Map<string, number> | undefined;
function cp1251Table(): Map<string, number> {
  if (cp1251) return cp1251;
  cp1251 = new Map();
  const dec = new TextDecoder("windows-1251");
  for (let b = 0x80; b <= 0xff; b++) {
    const ch = dec.decode(new Uint8Array([b]));
    if (ch && ch !== "\ufffd") cp1251.set(ch, b);
  }
  return cp1251;
}

/** Кодирует текст в исходную кодировку файла. Если символы не помещаются в windows-1251 — UTF-8 (с пометкой). */
export function encodeText(text: string, enc: Encoding): { buf: Buffer; enc: Encoding; note?: string } {
  switch (enc) {
    case "utf8":
      return { buf: Buffer.from(text, "utf8"), enc };
    case "utf8bom":
      return { buf: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]), enc };
    case "utf16le":
      return { buf: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]), enc };
    case "utf16be": {
      const b = Buffer.from(text, "utf16le");
      swapBytes(b);
      return { buf: Buffer.concat([Buffer.from([0xfe, 0xff]), b]), enc };
    }
    case "cp1251": {
      const t = cp1251Table();
      const out = Buffer.alloc(text.length);
      let n = 0;
      for (const ch of text) {
        const c = ch.codePointAt(0)!;
        if (c < 0x80) out[n++] = c;
        else {
          const b = t.get(ch);
          if (b === undefined)
            return { buf: Buffer.from(text, "utf8"), enc: "utf8", note: `символ «${ch}» не помещается в windows-1251 — файл сохранён в UTF-8` };
          out[n++] = b;
        }
      }
      return { buf: out.subarray(0, n), enc };
    }
  }
}

export function withEol(text: string, eol: Eol): string {
  const lf = text.replace(/\r\n/g, "\n");
  return eol === "\r\n" ? lf.replace(/\n/g, "\r\n") : lf;
}

/** Запись через временный файл и переименование; если не вышло (файл занят, антивирус) — обычная запись. */
export function atomicWrite(file: string, data: Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.jc-${process.pid}-${crypto.randomBytes(3).toString("hex")}.tmp`);
  try {
    let mode: number | undefined;
    try {
      mode = fs.statSync(file).mode;
    } catch {}
    fs.writeFileSync(tmp, data, mode !== undefined ? { mode } : undefined);
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    fs.writeFileSync(file, data);
  }
}

// ───────────── diff: Майерс, несколько фрагментов с контекстом ─────────────

type Op = { t: "=" | "-" | "+"; a: number; b: number };

function myers(A: string[], B: string[]): Op[] | null {
  const n = A.length;
  const m = B.length;
  const max = n + m;
  if (max > 6000) return null;
  const off = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        // обратный проход
        const ops: Op[] = [];
        let cx = n;
        let cy = m;
        for (let dd = d; dd > 0; dd--) {
          const pv = trace[dd];
          const kk = cx - cy;
          const prevK = kk === -dd || (kk !== dd && pv[off + kk - 1] < pv[off + kk + 1]) ? kk + 1 : kk - 1;
          const px = pv[off + prevK];
          const py = px - prevK;
          while (cx > px && cy > py) ops.push({ t: "=", a: --cx, b: --cy });
          if (cx === px) ops.push({ t: "+", a: cx, b: --cy });
          else ops.push({ t: "-", a: --cx, b: cy });
        }
        while (cx > 0 && cy > 0) ops.push({ t: "=", a: --cx, b: --cy });
        return ops.reverse();
      }
    }
    if (trace.length > 2500) return null;
  }
  return null;
}

/**
 * Построчный diff: строки «  N текст», «- N текст», «+ N текст» и разделители «@@ … @@» между фрагментами.
 * Номера: для «-» и « » — в старом файле, для «+» — в новом.
 */
export function lineDiff(a: string, b: string, ctx = 3, maxLines = 240): string[] {
  const A = a.split(/\r?\n/);
  const B = b.split(/\r?\n/);
  // общий префикс/суффикс снимаем заранее — так Майерсу достаётся только изменённая середина
  let s = 0;
  while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let ea = A.length;
  let eb = B.length;
  while (ea > s && eb > s && A[ea - 1] === B[eb - 1]) {
    ea--;
    eb--;
  }
  const midOps = myers(A.slice(s, ea), B.slice(s, eb));
  let ops: Op[];
  if (midOps) ops = midOps.map((o) => ({ t: o.t, a: o.a + s, b: o.b + s }));
  else {
    ops = [];
    for (let i = s; i < ea; i++) ops.push({ t: "-", a: i, b: s });
    for (let i = s; i < eb; i++) ops.push({ t: "+", a: ea, b: i });
  }
  const all: Op[] = [];
  for (let i = 0; i < s; i++) all.push({ t: "=", a: i, b: i });
  all.push(...ops);
  for (let i = 0; i < A.length - ea; i++) all.push({ t: "=", a: ea + i, b: eb + i });
  // фрагменты с контекстом
  const keep = new Uint8Array(all.length);
  all.forEach((o, i) => {
    if (o.t !== "=") for (let j = Math.max(0, i - ctx); j <= Math.min(all.length - 1, i + ctx); j++) keep[j] = 1;
  });
  const out: string[] = [];
  let prev = -2;
  for (let i = 0; i < all.length; i++) {
    if (!keep[i]) continue;
    const o = all[i];
    if (prev !== i - 1 && out.length) out.push(`@@ строка ${o.t === "+" ? o.b + 1 : o.a + 1} @@`);
    prev = i;
    if (o.t === "=") out.push(`  ${o.a + 1} ${A[o.a]}`);
    else if (o.t === "-") out.push(`- ${o.a + 1} ${A[o.a]}`);
    else out.push(`+ ${o.b + 1} ${B[o.b]}`);
  }
  return out.length > maxLines ? [...out.slice(0, maxLines), `… ещё ${out.length - maxLines} строк diff`] : out;
}

export function diffStat(lines: string[]): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const l of lines) {
    if (l.startsWith("+ ")) add++;
    else if (l.startsWith("- ")) del++;
  }
  return { add, del };
}

// ───────────── история правок: «Отменить» для изменений агента ─────────────

const MAX_BACKUP = 20 * 1024 * 1024;

interface Snapshot {
  id: string;
  file: string;
  existed: boolean;
  at: number;
  /** sha1 содержимого после правки агента — чтобы не затереть более поздние изменения. */
  after?: string;
}
const sha1 = (b: Buffer) => crypto.createHash("sha1").update(b).digest("hex");

/** Сохраняет состояние файла до правки. Возвращает id для отмены (или undefined, если файл слишком большой). */
export function snapshot(file: string): string | undefined {
  try {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    const id = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
    let existed = false;
    if (fs.existsSync(file)) {
      const st = fs.statSync(file);
      if (!st.isFile() || st.size > MAX_BACKUP) return undefined;
      fs.copyFileSync(file, path.join(HISTORY_DIR, id + ".bin"));
      existed = true;
    }
    const snap: Snapshot = { id, file: path.resolve(file), existed, at: Date.now() };
    fs.writeFileSync(path.join(HISTORY_DIR, id + ".json"), JSON.stringify(snap));
    return id;
  } catch {
    return undefined;
  }
}

export function markWritten(id: string | undefined, data: Buffer): void {
  if (!id) return;
  try {
    const f = path.join(HISTORY_DIR, id + ".json");
    const snap: Snapshot = JSON.parse(fs.readFileSync(f, "utf8"));
    snap.after = sha1(data);
    fs.writeFileSync(f, JSON.stringify(snap));
  } catch {}
}

/** Возвращает файл к состоянию до правки. Если файл менялся после неё — нужен force. */
export function restoreSnapshot(id: string, force = false): { ok: boolean; changed?: boolean; message: string } {
  if (!/^[a-z0-9-]+$/i.test(id)) return { ok: false, message: "Неверный id" };
  const f = path.join(HISTORY_DIR, id + ".json");
  if (!fs.existsSync(f)) return { ok: false, message: "Резервная копия не найдена (старше 14 дней или удалена)." };
  const snap: Snapshot = JSON.parse(fs.readFileSync(f, "utf8"));
  const cur = fs.existsSync(snap.file) ? fs.readFileSync(snap.file) : null;
  if (!force && snap.after && (!cur || sha1(cur) !== snap.after))
    return { ok: false, changed: true, message: "Файл изменился после этой правки — при отмене пропадут и более поздние изменения." };
  if (snap.existed) atomicWrite(snap.file, fs.readFileSync(path.join(HISTORY_DIR, id + ".bin")));
  else if (cur) fs.unlinkSync(snap.file);
  return { ok: true, message: snap.existed ? `Восстановлен ${snap.file}` : `Удалён созданный файл ${snap.file}` };
}

function readSnapshot(id: string): Snapshot | null {
  if (!/^[a-z0-9-]+$/i.test(id)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, id + ".json"), "utf8")) as Snapshot;
  } catch {
    return null;
  }
}

/** Файл, к которому относится резервная копия (для группировки правок по файлам). */
export function snapshotFile(id: string): string | null {
  return readSnapshot(id)?.file ?? null;
}

/**
 * Откат нескольких правок сразу (например, всего ответа агента): каждый файл возвращается
 * к состоянию до первой правки (first). Если файл менялся после последней правки (last) —
 * без force ничего не трогаем и сообщаем, какие файлы изменились.
 */
export function rollbackFiles(groups: { first: string; last?: string }[], force = false): { ok: boolean; changed?: boolean; conflicts: string[]; restored: number; missing: number; message: string } {
  const plan: { snap: Snapshot; id: string }[] = [];
  const conflicts: string[] = [];
  let missing = 0;
  for (const g of groups) {
    const first = readSnapshot(g.first);
    if (!first || (first.existed && !fs.existsSync(path.join(HISTORY_DIR, g.first + ".bin")))) {
      missing++;
      continue;
    }
    const last = g.last ? readSnapshot(g.last) : null;
    if (!force && last?.after) {
      const cur = fs.existsSync(first.file) ? fs.readFileSync(first.file) : null;
      if (!cur || sha1(cur) !== last.after) conflicts.push(first.file);
    }
    plan.push({ snap: first, id: g.first });
  }
  if (missing) return { ok:false, conflicts:[], restored:0, missing, message:"Откат отменён до записи: отсутствуют резервные копии. Ни один файл не изменён." };
  if (conflicts.length)
    return {
      ok: false,
      changed: true,
      conflicts,
      restored: 0,
      missing,
      message: `После правок агента ${conflicts.length === 1 ? "изменился файл" : "изменились файлы"}: ${conflicts.map((f) => path.basename(f)).join(", ")} — при откате пропадут и более поздние изменения.`,
    };
  let restored = 0;
  for (const { snap, id } of plan) {
    try {
      if (snap.existed) atomicWrite(snap.file, fs.readFileSync(path.join(HISTORY_DIR, id + ".bin")));
      else if (fs.existsSync(snap.file)) fs.unlinkSync(snap.file);
      restored++;
    } catch {
      missing++;
    }
  }
  const files = `${restored} ${restored % 10 === 1 && restored % 100 !== 11 ? "файл" : restored % 10 >= 2 && restored % 10 <= 4 && (restored % 100 < 12 || restored % 100 > 14) ? "файла" : "файлов"}`;
  return {
    ok: restored > 0 || (!plan.length && !missing),
    conflicts: [],
    restored,
    missing,
    message: restored ? `Правки откачены: ${files}${missing ? ` (без резервной копии: ${missing})` : ""}` : "Резервные копии не найдены (старше 14 дней или удалены).",
  };
}

export function pruneHistory(maxAgeDays = 14): void {
  try {
    const limit = Date.now() - maxAgeDays * 86400_000;
    for (const n of fs.readdirSync(HISTORY_DIR)) {
      const p = path.join(HISTORY_DIR, n);
      try {
        if (fs.statSync(p).mtimeMs < limit) fs.unlinkSync(p);
      } catch {}
    }
  } catch {}
}
