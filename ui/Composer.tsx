import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, AtSign, ChevronDown, File as FileIcon, FileText, Film, Folder, FolderOpen, Image as ImageIcon, ListChecks, Music, Paperclip, Play, Plug, Plus, Shield, Sliders, Slash, Sparkles, Square, Wand, X } from "./icons";
import { baseName, cx, fmtSize, Menu, MODE_INFO, MODE_ORDER, openLightbox, shortPath, type MenuItem } from "./common";
import { pickPaths } from "./FolderBrowser";
import { api, EFFORTS, effortLabel, fileUrl, get, newChat, openExternal, set, setEffort, toast, uploadFile, useStore, type Effort, type Mode, type OutAttachment, NONE } from "./store";

interface Props {
  variant: "home" | "chat";
  /** Чат, для которого меняется уровень мышления. Без него — для нового чата. */
  chatId?: string;
  effort?: Effort;
  busy: boolean;
  mode: Mode;
  project: string;
  onMode: (m: Mode) => void;
  onProject: (p: string) => void;
  onSend: (text: string, atts: OutAttachment[]) => unknown;
  onStop: () => void;
  prefill?: { text: string; n: number } | null;
}

export type AttKind = "image" | "video" | "audio" | "pdf" | "text" | "folder" | "file" | "paste" | "missing";
interface Att extends OutAttachment {
  id: number;
  kind: AttKind;
  size?: number;
  /** 0…1 — идёт загрузка. */
  progress?: number;
  error?: string;
  /** Превью: object URL (до загрузки) или адрес файла на диске. */
  thumb?: string;
  poster?: string;
  duration?: number;
  lines?: number;
}

const MAX_UPLOAD = 4 * 1024 ** 3;
/** Вставка длиннее — отдельным вложением «Вставленный текст», как в Claude. */
const LONG_PASTE_CHARS = 5000;
const LONG_PASTE_LINES = 60;

const IMG_RE = /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif|heic)$/i;
const VID_RE = /\.(mp4|m4v|mov|webm|mkv|avi|wmv|flv|3gp|mpe?g)$/i;
const AUD_RE = /\.(mp3|wav|m4a|ogg|oga|flac|aac|opus|wma)$/i;
const TXT_RE = /\.(txt|md|markdown|json|jsonc|ya?ml|toml|ini|cfg|conf|env\.example|csv|tsv|log|xml|html?|css|scss|less|[cm]?[jt]sx?|py|rb|go|rs|java|kt|cs|cpp|cc|c|h|hpp|php|sh|bash|ps1|psm1|bat|cmd|sql|lua|swift|dart|vue|svelte|gradle|properties|gitignore|dockerfile)$/i;

export function kindOf(name: string, mime = ""): AttKind {
  if (/[\\/]$/.test(name)) return "folder";
  if (mime.startsWith("image/") || IMG_RE.test(name)) return "image";
  if (mime.startsWith("video/") || VID_RE.test(name)) return "video";
  if (mime.startsWith("audio/") || AUD_RE.test(name)) return "audio";
  if (mime === "application/pdf" || /\.pdf$/i.test(name)) return "pdf";
  if (mime.startsWith("text/") || TXT_RE.test(name)) return "text";
  return "file";
}

export function KindIcon({ kind, size = 15 }: { kind: string; size?: number }) {
  if (kind === "image") return <ImageIcon size={size} />;
  if (kind === "video") return <Film size={size} />;
  if (kind === "audio") return <Music size={size} />;
  if (kind === "folder") return <Folder size={size} />;
  if (kind === "text" || kind === "paste" || kind === "pdf") return <FileText size={size} />;
  return <FileIcon size={size} />;
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
}
function timeLabel(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

function once(el: HTMLMediaElement, ev: string, ms = 6000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => (cleanup(), reject(new Error("timeout"))), ms);
    const ok = () => (cleanup(), resolve());
    const bad = () => (cleanup(), reject(new Error("media error")));
    const cleanup = () => {
      clearTimeout(t);
      el.removeEventListener(ev, ok);
      el.removeEventListener("error", bad);
    };
    el.addEventListener(ev, ok, { once: true });
    el.addEventListener("error", bad, { once: true });
  });
}

/**
 * Раскадровка видео: несколько кадров с отметками времени на одном JPEG — агент «видит» ролик.
 * Кадры декодирует само окно (Edge/Chromium): mp4/webm — да, редкие кодеки — без раскадровки.
 */
async function videoSheet(src: string): Promise<{ blob: Blob; poster: string; duration: number } | null> {
  const v = document.createElement("video");
  v.muted = true;
  v.preload = "auto";
  v.playsInline = true;
  v.src = src;
  try {
    await once(v, "loadeddata", 10000);
    const dur = v.duration;
    if (!isFinite(dur) || dur <= 0 || !v.videoWidth) return null;
    const n = dur < 6 ? 4 : dur < 40 ? 6 : 9;
    const cols = n === 4 ? 2 : 3;
    const rows = Math.ceil(n / cols);
    const w = 480;
    const h = Math.max(1, Math.round((w * v.videoHeight) / v.videoWidth));
    const c = document.createElement("canvas");
    c.width = cols * w;
    c.height = rows * h;
    const g = c.getContext("2d")!;
    g.fillStyle = "#111";
    g.fillRect(0, 0, c.width, c.height);
    let poster = "";
    for (let i = 0; i < n; i++) {
      const t = Math.min(dur - 0.05, (dur * (i + 0.5)) / n);
      v.currentTime = t;
      await once(v, "seeked", 6000);
      const x = (i % cols) * w;
      const y = Math.floor(i / cols) * h;
      g.drawImage(v, x, y, w, h);
      if (i === 0) {
        const pc = document.createElement("canvas");
        pc.width = 160;
        pc.height = Math.round((160 * h) / w);
        pc.getContext("2d")!.drawImage(v, 0, 0, pc.width, pc.height);
        poster = pc.toDataURL("image/jpeg", 0.7);
      }
      const label = timeLabel(t);
      g.font = "600 20px Inter, Segoe UI, sans-serif";
      const tw = g.measureText(label).width;
      g.fillStyle = "rgba(0,0,0,.62)";
      g.beginPath();
      g.roundRect(x + 10, y + h - 40, tw + 20, 30, 8);
      g.fill();
      g.fillStyle = "#fff";
      g.fillText(label, x + 20, y + h - 18);
    }
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/jpeg", 0.82));
    return blob ? { blob, poster, duration: dur } : null;
  } catch {
    return null;
  } finally {
    v.removeAttribute("src");
    v.load();
  }
}

const INIT_PROMPT =
  "Изучи проект в рабочей папке и создай в её корне файл NOTION.md — память проекта для будущих сессий: назначение, стек, структура папок, как установить, запустить, собрать и протестировать, соглашения по коду и важные нюансы. Коротко и по делу (до 150 строк). Если NOTION.md уже есть — обнови его.";
const REVIEW_PROMPT =
  "Сделай ревью незакоммиченных изменений (git status, git diff): найди ошибки, риски и места для улучшения. Ответь списком по файлам — от важного к мелочам. Ничего не меняй без моего подтверждения.";

/** Своя команда из .md-файла (ответ /api/commands). */
interface CustomCmd {
  name: string;
  description: string;
  source: "project" | "user";
  args: boolean;
}

interface Slash {
  cmd: string;
  label: string;
  hint: string;
  icon: JSX.Element;
}

let seq = 0;

/** Подсказка @-упоминания (ответ /api/files/suggest). */
interface FileHit {
  rel: string;
  path: string;
  dir: boolean;
}
const mentionName = (rel: string) => {
  const r = rel.replace(/\/$/, "");
  return r.slice(r.lastIndexOf("/") + 1) + (rel.endsWith("/") ? "/" : "");
};
const mentionDir = (rel: string) => {
  const r = rel.replace(/\/$/, "");
  const i = r.lastIndexOf("/");
  const d = i > 0 ? r.slice(0, i) : "";
  return d.length > 52 ? "…" + d.slice(-51) : d;
};

export function Composer({ variant, chatId, effort: effortProp, busy, mode, project, onMode, onProject, onSend, onStop, prefill }: Props) {
  const [text, setText] = useState("");
  const [atts, setAtts] = useState<Att[]>([]);
  const [menu, setMenu] = useState<null | "plus" | "mode" | "effort">(null);
  const [drag, setDrag] = useState(false);
  const [sending, setSending] = useState(false);
  const [slashIdx, setSlashIdx] = useState(0);
  const [caret, setCaret] = useState(0);
  const [mentionIdx, setMentionIdx] = useState(0);
  const [mentionItems, setMentionItems] = useState<FileHit[]>([]);
  const [mentionOff, setMentionOff] = useState<number | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const plusBtn = useRef<HTMLButtonElement>(null);
  const modeBtn = useRef<HTMLButtonElement>(null);
  const effortBtn = useRef<HTMLButtonElement>(null);
  const jobs = useRef(new Map<number, Promise<void>>());
  const aborts = useRef(new Map<number, AbortController>());
  const urls = useRef(new Set<string>());
  const sendOnEnter = useStore((s) => s.state?.settings.sendOnEnter ?? true);
  const recent = useStore((s) => s.state?.settings.recentProjects ?? NONE);
  const relayOn = useStore((s) => !!s.state?.bridge.relay?.listening);
  const defaultEffort = useStore((s) => s.state?.settings.effort ?? "normal");
  const draftEffort = useStore((s) => s.draftEffort);
  const chatUrl = useStore((s) => (s.currentId === chatId ? s.chat?.relayChatUrl : "") || s.state?.bridgeSettings.chatUrl || "");
  const effort: Effort = chatId ? (effortProp ?? defaultEffort) : (draftEffort ?? defaultEffort);

  useEffect(() => {
    if (prefill) {
      setText(prefill.text);
      setTimeout(() => {
        ta.current?.focus();
        ta.current?.setSelectionRange(prefill.text.length, prefill.text.length);
      }, 0);
    }
  }, [prefill]);

  // «Стоп» или «×» у сообщения в очереди: текст и файлы возвращаются в поле ввода
  const restore = useStore((s) => s.restore);
  useEffect(() => {
    if (!restore || !chatId || restore.chatId !== chatId) return;
    set({ restore: null });
    const texts = restore.items.map((q) => q.text).filter(Boolean);
    if (texts.length) setText((cur) => [...texts, cur.trim()].filter(Boolean).join("\n\n"));
    const paths = restore.items.flatMap((q) => q.attachments.filter((a) => a.path).map((a) => a.path!));
    if (paths.length) void addPaths(paths);
    for (const q of restore.items)
      for (const a of q.attachments)
        if (!a.path && a.text !== undefined) setAtts((x) => [...x, { id: ++seq, name: a.name, kind: "paste", content: a.text, size: new Blob([a.text!]).size, lines: a.text!.split(/\r?\n/).length }]);
    setTimeout(() => ta.current?.focus(), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restore?.n, chatId]);

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4)) + "px";
  }, [text]);

  // object URL превью освобождаем при уходе со страницы
  useEffect(
    () => () => {
      for (const u of urls.current) URL.revokeObjectURL(u);
      for (const a of aborts.current.values()) a.abort();
    },
    [],
  );

  const patch = useCallback((id: number, p: Partial<Att>) => setAtts((x) => x.map((a) => (a.id === id ? { ...a, ...p } : a))), []);
  const objUrl = (b: Blob) => {
    const u = URL.createObjectURL(b);
    urls.current.add(u);
    return u;
  };

  /** Раскадровка для видео (по адресу превью) — загружается рядом с роликом. */
  const addFrames = async (id: number, src: string, name: string) => {
    const sheet = await videoSheet(src);
    if (!sheet) return;
    patch(id, { poster: sheet.poster, duration: sheet.duration });
    try {
      const up = await uploadFile(sheet.blob, name.replace(/\.[^.]+$/, "") + ".frames.jpg");
      patch(id, { frames: up.path });
    } catch {}
  };

  /** Файлы из перетаскивания или буфера — потоково на диск (до 4 ГБ), дальше агент работает с путём. */
  const addFiles = useCallback((files: File[]) => {
    let skipped = 0;
    for (const f0 of files) {
      if (f0.size > MAX_UPLOAD) {
        skipped++;
        continue;
      }
      let name = f0.name || "file";
      if (f0.type.startsWith("image/") && (!f0.name || /^image\.(png|jpe?g|gif|webp|bmp)$/i.test(f0.name))) {
        const ext = (f0.type.split("/")[1] || "png").replace("jpeg", "jpg");
        name = `screenshot-${stamp()}.${ext}`;
      }
      const kind = kindOf(name, f0.type);
      const id = ++seq;
      const thumb = kind === "image" || kind === "video" ? objUrl(f0) : undefined;
      setAtts((x) => [...x, { id, name, kind, size: f0.size, progress: 0, thumb }]);
      const ctrl = new AbortController();
      aborts.current.set(id, ctrl);
      const job = (async () => {
        try {
          const up = await uploadFile(f0, name, (p) => patch(id, { progress: p }), ctrl.signal);
          patch(id, { path: up.path, name: up.name || name, progress: undefined });
          if (kind === "video" && thumb) await addFrames(id, thumb, name);
        } catch (e) {
          if (!ctrl.signal.aborted) patch(id, { progress: undefined, error: (e as Error).message });
        } finally {
          aborts.current.delete(id);
        }
      })();
      jobs.current.set(id, job);
      job.finally(() => jobs.current.delete(id));
    }
    if (skipped) toast(`Пропущено файлов: ${skipped} (больше 4 ГБ). Такие прикрепляйте через «+» — агент прочитает их с диска сам.`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Пути на диске (диалог, буфер Проводника): без копирования, превью — прямо с диска. */
  const addPaths = useCallback(async (paths: string[]) => {
    if (!paths.length) return;
    let info: { path: string; name: string; size: number; kind: string }[] = [];
    try {
      info = (await api<{ items: typeof info }>("attachments/info", { body: { paths } })).items;
    } catch {
      info = paths.map((p) => ({ path: p, name: baseName(p), size: 0, kind: "file" }));
    }
    for (const it of info) {
      const id = ++seq;
      const folder = it.kind === "folder" || /[\\/]$/.test(it.name);
      const name = folder ? it.name.replace(/[\\/]+$/, "") + "\\" : it.name;
      const kind: AttKind = it.kind === "missing" ? "missing" : folder ? "folder" : kindOf(it.name);
      const thumb = kind === "image" || kind === "video" ? fileUrl(it.path) : undefined;
      setAtts((x) => [...x, { id, name, path: it.path, kind, size: it.size, thumb }]);
      if (kind === "video" && thumb) {
        const job = addFrames(id, thumb, it.name);
        jobs.current.set(id, job);
        job.finally(() => jobs.current.delete(id));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addPasted = (t: string) => {
    const lines = t.split(/\r?\n/).length;
    setAtts((x) => [...x, { id: ++seq, name: `Вставленный текст ${stamp().slice(8, 12)}.txt`, kind: "paste", content: t, size: new Blob([t]).size, lines }]);
  };

  const insertText = (t: string) => {
    const el = ta.current;
    if (!el) return setText((x) => x + t);
    const a = el.selectionStart ?? text.length;
    const b = el.selectionEnd ?? text.length;
    const next = text.slice(0, a) + t + text.slice(b);
    setText(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(a + t.length, a + t.length);
    });
  };

  const remove = (a: Att) => {
    aborts.current.get(a.id)?.abort();
    if (a.thumb?.startsWith("blob:")) {
      URL.revokeObjectURL(a.thumb);
      urls.current.delete(a.thumb);
    }
    setAtts((x) => x.filter((y) => y.id !== a.id));
  };

  const uploading = atts.some((a) => a.progress !== undefined);
  // пока агент работает, сообщение встаёт в очередь — агент прочитает его после текущего шага
  const hasContent = text.trim().length > 0 || atts.some((a) => !a.error);
  const canSend = !sending && hasContent;
  const stopMode = busy && !hasContent;

  const submitText = async (t: string) => {
    const list = getAtts();
    setSending(true);
    try {
      if (jobs.current.size) await Promise.allSettled([...jobs.current.values()]);
      const ready = getAtts().filter((a) => !a.error && (a.path || a.content !== undefined));
      setText("");
      setAtts([]);
      await onSend(t, ready.map((a) => ({ name: a.name, path: a.path, content: a.content, frames: a.frames })));
    } catch (e) {
      setText(t);
      setAtts(list);
      toast((e as Error).message, "error");
    } finally {
      setSending(false);
      ta.current?.focus();
    }
  };
  // актуальный список вложений после ожидания загрузок
  const attsRef = useRef(atts);
  attsRef.current = atts;
  const getAtts = () => attsRef.current;

  const submit = () => {
    if (!canSend) return;
    void submitText(text.trim());
  };

  // ───── слэш-команды ─────
  // свои команды (.jarvis/commands/*.md проекта и личные) — подгружаются, когда набран «/»
  const [custom, setCustom] = useState<{ project: string; at: number; items: CustomCmd[] }>({ project: "", at: 0, items: [] });
  const wantCustom = text.startsWith("/") && !/\s/.test(text);
  useEffect(() => {
    if (!wantCustom || !project) return;
    if (custom.project === project && Date.now() - custom.at < 10_000) return;
    let off = false;
    api<{ items: CustomCmd[] }>(`commands?dir=${encodeURIComponent(project)}`)
      .then((r) => !off && setCustom({ project, at: Date.now(), items: r.items ?? [] }))
      .catch(() => {});
    return () => {
      off = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantCustom, project]);
  const openCommands = async () => {
    try {
      const r = await api<{ ok: boolean; dir: string }>("commands/folder", { body: {} });
      setCustom({ project: "", at: 0, items: [] });
      toast(`Своя команда — это .md-файл с заданием: в ${r.dir} (для всех папок) или в .jarvis/commands проекта. Имя файла — имя команды, $ARGUMENTS — текст после неё.`, "info");
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  const slashList: (Slash & { run: () => void })[] = useMemo(
    () => [
      { cmd: "/init", label: "Память проекта", hint: "Изучить проект и создать NOTION.md", icon: <Wand size={15} />, run: () => void submitText(INIT_PROMPT) },
      { cmd: "/review", label: "Ревью изменений", hint: "git diff → ошибки, риски, улучшения", icon: <ListChecks size={15} />, run: () => void submitText(REVIEW_PROMPT) },
      { cmd: "/plan", label: "Режим «План»", hint: MODE_INFO.plan.hint, icon: <Shield size={15} />, run: () => onMode("plan") },
      { cmd: "/ask", label: "Режим «Спрашивать»", hint: MODE_INFO.ask.hint, icon: <Shield size={15} />, run: () => onMode("ask") },
      { cmd: "/auto", label: "Режим «Авто-правки»", hint: MODE_INFO["auto-edit"].hint, icon: <Shield size={15} />, run: () => onMode("auto-edit") },
      { cmd: "/full", label: "Режим «Полный доступ»", hint: MODE_INFO.full.hint, icon: <Shield size={15} />, run: () => onMode("full") },
      { cmd: "/folder", label: "Рабочая папка…", hint: shortPath(project, 40), icon: <FolderOpen size={15} />, run: () => void changeProject() },
      { cmd: "/think", label: "Мышление…", hint: `Сейчас: ${effortLabel(effort)}`, icon: <Sliders size={15} />, run: () => setMenu("effort") },
      { cmd: "/import", label: "Перенести чат…", hint: "Из чата Notion или из текста", icon: <Plug size={15} />, run: () => set({ modal: "import" }) },
      { cmd: "/model", label: "Модель", hint: "Выбирается в чате Notion — откроется Notion", icon: <Sparkles size={15} />, run: () => openExternal(/^https:\/\//.test(chatUrl) ? chatUrl : "https://app.notion.com/chat") },
      { cmd: "/new", label: "Новый чат", hint: "Ctrl+Shift+O", icon: <Plus size={15} />, run: () => newChat() },
      ...(custom.project === project ? custom.items : []).map((c) => ({
        cmd: `/${c.name}`,
        label: c.description,
        hint: c.source === "project" ? "команда проекта" : "моя команда",
        icon: <FileText size={15} />,
        run: () => (c.args ? setText(`/${c.name} `) : void submitText(`/${c.name}`)),
      })),
      { cmd: "/commands", label: "Свои команды…", hint: "Папка для своих команд (.md)", icon: <Slash size={15} />, run: () => void openCommands() },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project, chatId, onMode, custom, effort, chatUrl],
  );
  const slashQuery = /^\/[\w-]*$/.test(text) ? text.toLowerCase() : null;
  const slashHits = slashQuery !== null ? slashList.filter((s) => s.cmd.startsWith(slashQuery) || s.label.toLowerCase().includes(slashQuery.slice(1))) : [];
  useEffect(() => setSlashIdx(0), [slashQuery]);
  const slashOpen = slashHits.length > 0;
  const [slashPlace, setSlashPlace] = useState({ down: false, max: 320 });
  const runSlash = (s: (typeof slashList)[number]) => {
    setText("");
    s.run();
  };

  // ───── @-упоминания файлов рабочей папки ─────
  const mention = useMemo(() => {
    if (slashQuery !== null) return null;
    const before = text.slice(0, caret);
    const m = before.match(/(?:^|[\s(\[{"'«])@([^\s@"'«»]*)$/);
    if (!m) return null;
    return { q: m[1], start: before.length - m[1].length - 1, end: caret };
  }, [text, caret, slashQuery]);
  const mentionKey = mention ? `${mention.start}` : "";
  useEffect(() => {
    if (!mention) {
      setMentionItems([]);
      if (mentionOff !== null) setMentionOff(null);
      return;
    }
    if (mentionOff === mention.start) return;
    let gone = false;
    const t = setTimeout(async () => {
      const r = await api<{ items: FileHit[] }>(`files/suggest?dir=${encodeURIComponent(project)}&q=${encodeURIComponent(mention.q)}`).catch(() => ({ items: [] as FileHit[] }));
      if (!gone) {
        setMentionItems(r.items);
        setMentionIdx(0);
      }
    }, 60);
    return () => {
      gone = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mention?.q, mentionKey, project, mentionOff]);
  const mentionOpen = !!mention && mentionOff !== mention.start && mentionItems.length > 0;

  const pickMention = (f: FileHit) => {
    if (!mention) return;
    const ins = "@" + f.rel + (f.dir ? "" : " ");
    const next = text.slice(0, mention.start) + ins + text.slice(mention.end);
    const pos = mention.start + ins.length;
    setText(next);
    setCaret(pos);
    requestAnimationFrame(() => {
      ta.current?.focus();
      ta.current?.setSelectionRange(pos, pos);
    });
    // файл — сразу вложением (агенту не нужен лишний шаг чтения); папка — раскрываем дальше
    if (!f.dir && !getAtts().some((a) => a.path === f.path)) void addPaths([f.path]);
  };
  // подсказки раскрываются туда, где больше места (на главном экране поле посередине)
  useLayoutEffect(() => {
    if ((!slashOpen && !mentionOpen) || !root.current) return;
    const r = root.current.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 14;
    const above = r.top - 64;
    const down = below > above;
    setSlashPlace({ down, max: Math.round(Math.max(140, Math.min(320, down ? below : above))) });
  }, [slashOpen, mentionOpen]);

  const cycleMode = (dir = 1) => {
    const i = MODE_ORDER.indexOf(mode);
    onMode(MODE_ORDER[(i + dir + MODE_ORDER.length) % MODE_ORDER.length]);
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionOpen && mention) {
      const n = mentionItems.length;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIdx((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
        return;
      }
      if ((e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) || e.key === "Tab") {
        e.preventDefault();
        pickMention(mentionItems[Math.min(mentionIdx, n - 1)]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setMentionOff(mention.start);
        return;
      }
    }
    if (slashHits.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIdx((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + slashHits.length) % slashHits.length);
        return;
      }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        e.preventDefault();
        runSlash(slashHits[Math.min(slashIdx, slashHits.length - 1)]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setText("");
        return;
      }
    }
    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      cycleMode();
      return;
    }
    // ↑ в пустом поле — вернуть последнее своё сообщение (как в терминале)
    if (e.key === "ArrowUp" && !text && chatId) {
      const last = [...(get().chat?.items ?? [])].reverse().find((i) => i.kind === "user" && i.text);
      if (last?.text) {
        e.preventDefault();
        setText(last.text);
        return;
      }
    }
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      const wantSend = sendOnEnter ? !e.shiftKey : e.ctrlKey || e.metaKey;
      if (wantSend) {
        e.preventDefault();
        submit();
      }
    }
  };

  const attachFiles = async () => addPaths(await pickPaths("files", project));
  const attachFolder = async () => {
    const paths = await pickPaths("folder", project);
    if (paths[0]) addPaths([paths[0].replace(/[\\/]*$/, "\\")]);
  };
  const changeProject = async () => {
    const paths = await pickPaths("folder", project);
    if (paths[0]) onProject(paths[0]);
  };

  // ───── вставка (Ctrl+V) — работает, даже если фокус не в поле ввода ─────
  useEffect(() => {
    const onPaste = async (e: ClipboardEvent) => {
      const target = e.target instanceof Element ? (e.target as HTMLElement) : null;
      const own = !!target && target === ta.current;
      const editable = !!target && (target.closest("input, textarea, [contenteditable=true], select") as HTMLElement | null);
      if (!own && (editable || get().modal || document.querySelector(".modal-backdrop"))) return;
      const cd = e.clipboardData;
      if (!cd) return;
      const files = [...cd.files];
      const text = cd.getData("text/plain");
      const types = [...cd.types];
      const bitmaps = files.length > 0 && files.every((f) => f.type.startsWith("image/") && (!f.name || /^image\.(png|jpe?g|gif|bmp|webp)$/i.test(f.name)));
      if (bitmaps) {
        // текст из Excel/Word приходит вместе с картинкой — тогда важнее текст
        if (text.trim()) {
          if (!own) (e.preventDefault(), insertText(text));
          return;
        }
        e.preventDefault();
        addFiles(files);
        return;
      }
      if (files.length || types.includes("Files")) {
        e.preventDefault();
        // скопировано в Проводнике: берём настоящие пути (без копирования гигабайтов)
        const r = await api<{ paths: string[] }>("clipboard/files").catch(() => ({ paths: [] as string[] }));
        if (r.paths.length) addPaths(r.paths);
        else if (files.length) addFiles(files);
        return;
      }
      if (text && (text.length > LONG_PASTE_CHARS || text.split("\n").length > LONG_PASTE_LINES)) {
        e.preventDefault();
        addPasted(text);
        return;
      }
      if (!own && text) {
        e.preventDefault();
        insertText(text);
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  });

  // ───── перетаскивание файлов в любое место окна ─────
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e) || get().modal) return;
      depth++;
      setDrag(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDrag(false);
    };
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e) || get().modal) return;
      e.preventDefault();
      depth = 0;
      setDrag(false);
      const dt = e.dataTransfer!;
      let dirs = 0;
      const files: File[] = [];
      for (const item of [...dt.items]) {
        if (item.kind !== "file") continue;
        if (item.webkitGetAsEntry?.()?.isDirectory) dirs++;
        else {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (!dt.items.length) files.push(...dt.files);
      if (dirs) toast("Папку целиком так не прикрепить — нажмите «+» → «Прикрепить папку»: агент прочитает её с диска.", "info");
      if (files.length) addFiles(files);
      ta.current?.focus();
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [addFiles]);

  const plusItems: MenuItem[] = [
    { key: "files", icon: <Paperclip size={16} />, label: "Прикрепить файлы…", hint: "Или Ctrl+V / перетащите в окно", onSelect: attachFiles },
    { key: "folder", icon: <Folder size={16} />, label: "Прикрепить папку…", onSelect: attachFolder },
    { key: "d", divider: true, label: "" },
    { key: "proj", icon: <FolderOpen size={16} />, label: "Рабочая папка…", hint: shortPath(project, 44), onSelect: changeProject },
    ...recent
      .filter((p) => p !== project)
      .slice(0, 4)
      .map((p) => ({ key: "r" + p, icon: <span className="menu-dot" />, label: baseName(p), hint: shortPath(p, 44), onSelect: () => onProject(p) })),
    { key: "d2", divider: true, label: "" },
    { key: "slash", icon: <Slash size={16} />, label: "Команды", hint: "Наберите / в поле ввода", onSelect: () => (setText("/"), ta.current?.focus()) },
    {
      key: "mention",
      icon: <AtSign size={16} />,
      label: "Упомянуть файл",
      hint: "Наберите @ — поиск по рабочей папке",
      onSelect: () => insertText(text && !/\s$/.test(text.slice(0, ta.current?.selectionStart ?? text.length)) ? " @" : "@"),
    },
  ];
  const effortItems: MenuItem[] = [
    ...EFFORTS.map((e) => ({
      key: e.key,
      icon: <EffortBars level={e.key} />,
      label: e.label,
      hint: e.hint,
      checked: e.key === effort,
      onSelect: () => setEffort(chatId, e.key),
    })),
    { key: "d", divider: true, label: "" },
    {
      key: "model",
      icon: <Sparkles size={16} />,
      label: "Модель — в чате Notion",
      hint: "Jarvis Code не переключает модель: выберите её в самом чате Notion",
      onSelect: () => openExternal(/^https:\/\//.test(chatUrl) ? chatUrl : "https://app.notion.com/chat"),
    },
  ];
  const modeItems: MenuItem[] = MODE_ORDER.map((m) => ({
    key: m,
    label: (
      <span className={cx("mode-label", `tone-${MODE_INFO[m].tone}`)}>
        <span className="mode-dot" />
        {MODE_INFO[m].label}
      </span>
    ),
    hint: MODE_INFO[m].hint,
    checked: m === mode,
    onSelect: () => onMode(m),
  }));

  const media = atts.filter((a) => a.kind === "image" || a.kind === "video");
  const others = atts.filter((a) => a.kind !== "image" && a.kind !== "video");

  return (
    <div ref={root} className={cx("composer", variant, drag && "drag", busy && "busy")}>
      {mentionOpen && (
        <div className={cx("slash-pop mention-pop", slashPlace.down && "down")} style={{ maxHeight: slashPlace.max }} role="listbox" aria-label="Файлы рабочей папки">
          {mentionItems.map((f, i) => (
            <button
              key={f.rel}
              role="option"
              aria-selected={i === mentionIdx}
              className={cx("mention-item", i === mentionIdx && "active")}
              onMouseEnter={() => setMentionIdx(i)}
              onMouseDown={(e) => (e.preventDefault(), pickMention(f))}
              title={f.path}
            >
              <span className="slash-ico">
                <KindIcon kind={f.dir ? "folder" : kindOf(f.rel)} size={15} />
              </span>
              <span className="mention-name">{mentionName(f.rel)}</span>
              <span className="mention-dir">{mentionDir(f.rel)}</span>
            </button>
          ))}
        </div>
      )}
      {slashHits.length > 0 && (
        <div className={cx("slash-pop", slashPlace.down && "down")} style={{ maxHeight: slashPlace.max }} role="listbox" aria-label="Команды">
          {slashHits.map((s, i) => (
            <button key={s.cmd} role="option" aria-selected={i === slashIdx} className={cx("slash-item", i === slashIdx && "active")} onMouseEnter={() => setSlashIdx(i)} onMouseDown={(e) => (e.preventDefault(), runSlash(s))}>
              <span className="slash-ico">{s.icon}</span>
              <span className="slash-cmd">{s.cmd}</span>
              <span className="slash-label">{s.label}</span>
              <span className="slash-hint">{s.hint}</span>
            </button>
          ))}
        </div>
      )}
      {atts.length > 0 && (
        <div className="att-row">
          {media.map((a) => (
            <div key={a.id} className={cx("att-thumb", a.error && "bad", a.progress !== undefined && "loading")} title={a.error ?? a.path ?? a.name}>
              <button className="att-thumb-btn" onClick={() => a.thumb && openLightbox({ src: a.thumb, kind: a.kind === "video" ? "video" : "image", name: a.name })}>
                {a.kind === "image" && a.thumb ? <img src={a.thumb} alt="" draggable={false} /> : a.poster ? <img src={a.poster} alt="" draggable={false} /> : <span className="att-thumb-ph"><Film size={18} /></span>}
                {a.kind === "video" && (
                  <span className="att-video-badge">
                    <Play size={10} />
                    {a.duration ? timeLabel(a.duration) : ""}
                  </span>
                )}
              </button>
              {a.progress !== undefined && <Progress value={a.progress} />}
              <button className="att-x" onClick={() => remove(a)} aria-label="Убрать">
                <X size={11} />
              </button>
            </div>
          ))}
          {others.map((a) => (
            <span key={a.id} className={cx("att-chip", a.kind, a.error && "bad", a.progress !== undefined && "loading")} title={a.error ?? a.path ?? a.name}>
              <span className="att-ico">
                <KindIcon kind={a.kind} size={15} />
              </span>
              <span className="att-text">
                <span className="att-name">{a.kind === "paste" ? "Вставленный текст" : a.name}</span>
                <span className="att-meta">
                  {a.error ? "не загружено" : a.kind === "paste" ? `${a.lines} строк` : a.kind === "folder" ? "папка" : a.kind === "missing" ? "не найден" : a.size ? fmtSize(a.size) : ""}
                </span>
              </span>
              {a.kind === "paste" && (
                <button
                  className="att-inline"
                  title="Вставить в поле как обычный текст"
                  onClick={() => {
                    remove(a);
                    insertText(a.content ?? "");
                  }}
                >
                  В поле
                </button>
              )}
              {a.progress !== undefined && <span className="att-bar" style={{ "--p": a.progress } as React.CSSProperties} />}
              <button className="att-x" onClick={() => remove(a)} aria-label="Убрать">
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={ta}
        value={text}
        rows={variant === "home" ? 2 : 1}
        placeholder={variant === "home" ? "Чем помочь? / — команды, @ — файлы проекта" : busy ? "Агент работает — можно писать: он прочитает сообщение после текущего шага" : "Ответить…"}
        onChange={(e) => {
          setText(e.target.value);
          setCaret(e.target.selectionStart ?? e.target.value.length);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
        onKeyDown={onKey}
        aria-label="Сообщение агенту"
        autoFocus
      />
      <div className="composer-bar">
        <div className="composer-left">
          <button ref={plusBtn} className={cx("icon-btn round plus-btn", menu === "plus" && "open")} onClick={() => setMenu(menu === "plus" ? null : "plus")} title="Файлы, папки и команды" aria-label="Прикрепить">
            <Plus size={18} />
          </button>
          <button className="folder-chip" onClick={changeProject} title={`Рабочая папка: ${project}\nАгенту доступен весь ПК — это папка для относительных путей`}>
            <Folder size={14} />
            <span>{baseName(project)}</span>
          </button>
          <button ref={modeBtn} className={cx("mode-btn", `tone-${MODE_INFO[mode].tone}`, menu === "mode" && "open")} onClick={() => setMenu(menu === "mode" ? null : "mode")} title="Режим доступа к ПК (Shift+Tab)">
            <span className="mode-dot" />
            <span>{MODE_INFO[mode].label}</span>
            <ChevronDown size={13} className="chev-s" />
          </button>
        </div>
        <div className="composer-right">
          <button
            ref={effortBtn}
            className={cx("model-btn effort-btn", menu === "effort" && "open")}
            onClick={() => setMenu(menu === "effort" ? null : "effort")}
            title={`Мышление: ${effortLabel(effort)} — насколько тщательно агент работает над ответом.\nМодель выбирается в чате Notion.\n${relayOn ? "Агент в чате Notion на связи" : "Агент в чате Notion сейчас не на связи"}`}
          >
            <span className={cx("relay-dot", relayOn && "on")} />
            <EffortBars level={effort} />
            <span className="model-name">{effortLabel(effort)}</span>
            <ChevronDown size={13} className="chev-s" />
          </button>
          {busy && !stopMode && (
            <button className="stop-mini" onClick={onStop} title="Остановить агента (Esc)" aria-label="Остановить">
              <Square size={13} />
            </button>
          )}
          <button
            className={cx("send-btn", stopMode ? "stop" : canSend && "ready", busy && !stopMode && "queue", (sending || uploading) && !stopMode && "wait")}
            disabled={!stopMode && !canSend}
            onClick={stopMode ? onStop : submit}
            title={
              stopMode
                ? "Остановить (Esc)"
                : uploading
                  ? "Файлы загружаются — отправлю, как только закончится"
                  : busy
                    ? "В очередь (Enter) — агент прочитает после текущего шага"
                    : "Отправить (Enter)"
            }
            aria-label={stopMode ? "Остановить" : busy ? "В очередь" : "Отправить"}
          >
            <span className="send-ico arrow">
              <ArrowUp size={18} />
            </span>
            <span className="send-ico stop">
              <Square size={14} />
            </span>
          </button>
        </div>
      </div>
      {drag && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-card">
            <span className="drop-ico">
              <Paperclip size={26} />
            </span>
            <b>Отпустите, чтобы прикрепить</b>
            <span>Картинки, видео, документы, код — до 4 ГБ</span>
          </div>
        </div>
      )}
      {menu === "plus" && <Menu anchor={plusBtn.current} items={plusItems} onClose={() => setMenu(null)} width={300} />}
      {menu === "mode" && <Menu anchor={modeBtn.current} items={modeItems} onClose={() => setMenu(null)} width={320} />}
      {menu === "effort" && <Menu anchor={effortBtn.current} items={effortItems} onClose={() => setMenu(null)} align="right" width={300} />}
    </div>
  );
}

function Progress({ value }: { value: number }) {
  const r = 14;
  const c = 2 * Math.PI * r;
  return (
    <svg className="att-ring" viewBox="0 0 36 36" aria-label={`Загрузка ${Math.round(value * 100)}%`}>
      <circle cx="18" cy="18" r={r} className="track" />
      <circle cx="18" cy="18" r={r} className="bar" strokeDasharray={c} strokeDashoffset={c * (1 - Math.max(0.02, value))} />
    </svg>
  );
}

export function useProjectSetter() {
  return async (p: string) => {
    const st = get();
    if (st.currentId) {
      try {
        await api(`chats/${st.currentId}/project`, { body: { project: p } });
      } catch (e) {
        toast((e as Error).message, "error");
      }
    } else set({ draftProject: p });
  };
}

/** Уровень мышления — четыре столбика, как индикатор сигнала. */
export function EffortBars({ level }: { level: Effort | string }) {
  const n = Math.max(1, EFFORTS.findIndex((e) => e.key === level) + 1);
  return (
    <span className="effort-bars" aria-hidden="true">
      {[1, 2, 3, 4].map((i) => (
        <i key={i} className={cx(i <= n && "on")} style={{ height: 3 + i * 2.5 }} />
      ))}
    </span>
  );
}
