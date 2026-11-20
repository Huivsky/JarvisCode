import { useEffect, useState } from "react";
import { ChevronLeft, File as FileIcon, Folder } from "./icons";
import { cx, Modal } from "./common";
import { api, get } from "./store";

let resolver: ((paths: string[]) => void) | null = null;
let openBrowser: ((kind: "folder" | "files", start: string) => void) | null = null;

/** Нативный диалог Windows; в предпросмотре — встроенный браузер папок. */
export async function pickPaths(kind: "folder" | "files", start?: string): Promise<string[]> {
  const r = await api<{ paths: string[]; native: boolean }>("pick", { body: { kind, start } }).catch(() => ({ paths: [], native: false }));
  if (r.native) return r.paths;
  return new Promise((resolve) => {
    resolver = resolve;
    openBrowser?.(kind, start || get().state?.system.home || "/");
  });
}

export function FolderBrowserHost() {
  const [req, setReq] = useState<{ kind: "folder" | "files"; start: string } | null>(null);
  useEffect(() => {
    openBrowser = (kind, start) => setReq({ kind, start });
    return () => {
      openBrowser = null;
    };
  }, []);
  if (!req) return null;
  const done = (paths: string[]) => {
    resolver?.(paths);
    resolver = null;
    setReq(null);
  };
  return <FolderBrowser kind={req.kind} start={req.start} onDone={done} />;
}

function FolderBrowser({ kind, start, onDone }: { kind: "folder" | "files"; start: string; onDone: (p: string[]) => void }) {
  const [dir, setDir] = useState(start);
  const [data, setData] = useState<{ path: string; parent: string; entries: { name: string; dir: boolean }[] } | null>(null);
  const [sel, setSel] = useState<string[]>([]);
  const [err, setErr] = useState("");
  const drives = get().state?.system.drives ?? [];
  const sep = dir.includes("\\") ? "\\" : "/";

  useEffect(() => {
    api(`fs?path=${encodeURIComponent(dir)}`)
      .then((d) => {
        setData(d);
        setErr("");
      })
      .catch((e) => setErr(e.message));
  }, [dir]);

  const join = (name: string) => (data!.path.endsWith(sep) ? data!.path + name : data!.path + sep + name);

  return (
    <Modal title={kind === "folder" ? "Выберите папку" : "Выберите файлы"} onClose={() => onDone([])} className="browser-modal">
      <div className="browser-path">
        <button className="icon-btn" onClick={() => data && setDir(data.parent)} aria-label="Вверх">
          <ChevronLeft size={16} />
        </button>
        <input value={dir} onChange={(e) => setDir(e.target.value)} spellCheck={false} />
      </div>
      {drives.length > 1 && (
        <div className="browser-drives">
          {drives.map((d) => (
            <button key={d} className="chip" onClick={() => setDir(d)}>
              {d}
            </button>
          ))}
        </div>
      )}
      <div className="browser-list">
        {err && <div className="muted pad">{err}</div>}
        {data?.entries
          .filter((e) => kind === "files" || e.dir)
          .map((e) => {
            const full = join(e.name);
            return (
              <button
                key={e.name}
                className={cx("browser-item", sel.includes(full) && "selected")}
                onClick={() => (e.dir ? setDir(full) : setSel((s) => (s.includes(full) ? s.filter((x) => x !== full) : [...s, full])))}
              >
                {e.dir ? <Folder size={16} /> : <FileIcon size={16} />}
                <span>{e.name}</span>
              </button>
            );
          })}
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={() => onDone([])}>
          Отмена
        </button>
        <button className="btn primary" disabled={kind === "files" ? !sel.length : !data} onClick={() => onDone(kind === "folder" ? [data!.path] : sel)}>
          {kind === "folder" ? "Выбрать эту папку" : `Прикрепить (${sel.length})`}
        </button>
      </div>
    </Modal>
  );
}