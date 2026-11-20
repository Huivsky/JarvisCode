import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Mode } from "./store";
import { Check, X } from "./icons";

export const MODE_INFO: Record<Mode, { label: string; hint: string; tone: string }> = {
  plan: { label: "План", hint: "Только чтение и план действий", tone: "blue" },
  ask: { label: "Спрашивать", hint: "Подтверждать каждую правку и команду", tone: "default" },
  "auto-edit": { label: "Авто-правки", hint: "Файлы без вопросов, команды — с подтверждением", tone: "purple" },
  full: { label: "Полный доступ", hint: "Всё без подтверждений", tone: "orange" },
  autonomous: { label: "Автономно", hint: "Полный доступ и самостоятельная работа по задачам", tone: "red" },
};
export const MODE_ORDER: Mode[] = ["plan", "ask", "auto-edit", "full", "autonomous"];

export function cx(...a: (string | false | null | undefined)[]) {
  return a.filter(Boolean).join(" ");
}

export function shortPath(p: string, max = 38): string {
  if (!p) return "";
  if (p.length <= max) return p;
  const parts = p.split(/[\\/]/);
  const last = parts.pop() ?? "";
  const root = parts[0] ?? "";
  return `${root}\\…\\${last}`.length <= max ? `${root}\\…\\${last}` : "…" + p.slice(-max + 1);
}

export function baseName(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

export function ago(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "только что";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ч назад`;
  const d = Math.round(h / 24);
  if (d === 1) return "вчера";
  if (d < 7) return `${d} дн назад`;
  return new Date(ts).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} Б`;
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} КБ`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0).replace(".", ",")} МБ`;
  return `${(n / 1024 ** 3).toFixed(1).replace(".", ",")} ГБ`;
}

/** Группа для списка чатов: Сегодня, Вчера, 7 дней, 30 дней, месяц. */
export function dayGroup(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= start) return "Сегодня";
  if (ts >= start - 86_400_000) return "Вчера";
  if (ts >= start - 6 * 86_400_000) return "Последние 7 дней";
  if (ts >= start - 29 * 86_400_000) return "Последние 30 дней";
  const m = d.toLocaleDateString("ru-RU", { month: "long", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
  return m.charAt(0).toUpperCase() + m.slice(1);
}

// ───── Просмотр картинок и видео во весь экран ─────
interface LightboxReq {
  src: string;
  kind: "image" | "video";
  name?: string;
  path?: string;
}
let showLightbox: ((r: LightboxReq | null) => void) | null = null;
export function openLightbox(r: LightboxReq) {
  showLightbox?.(r);
}
export function LightboxHost({ onOpenPath }: { onOpenPath?: (p: string) => void }) {
  const [req, setReq] = useState<LightboxReq | null>(null);
  useEffect(() => {
    showLightbox = setReq;
    return () => {
      showLightbox = null;
    };
  }, []);
  useEffect(() => {
    if (!req) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setReq(null);
      }
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [req]);
  if (!req) return null;
  return (
    <div className="lightbox" onMouseDown={(e) => e.target === e.currentTarget && setReq(null)} role="dialog" aria-label={req.name ?? "Просмотр"}>
      <div className="lightbox-bar">
        <span className="lightbox-name">{req.name}</span>
        {req.path && onOpenPath && (
          <button className="btn small ghost on-dark" onClick={() => onOpenPath(req.path!)}>
            Показать в проводнике
          </button>
        )}
        <button className="icon-btn on-dark" onClick={() => setReq(null)} aria-label="Закрыть">
          <X size={18} />
        </button>
      </div>
      {req.kind === "video" ? <video src={req.src} controls autoPlay className="lightbox-media" /> : <img src={req.src} alt={req.name ?? ""} className="lightbox-media" />}
    </div>
  );
}

export function useElapsed(since: number | undefined): string {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!since) return;
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [since]);
  if (!since) return "";
  const s = Math.max(0, Math.round((Date.now() - since) / 1000));
  return s < 60 ? `${s} с` : `${Math.floor(s / 60)} мин ${s % 60} с`;
}

export interface MenuItem {
  key: string;
  label: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  checked?: boolean;
  danger?: boolean;
  divider?: boolean;
  onSelect?: () => void;
}

/** Выпадающее меню, привязанное к кнопке. */
export function Menu({
  anchor,
  items,
  onClose,
  align = "left",
  placement = "auto",
  width,
}: {
  anchor: HTMLElement | null;
  items: MenuItem[];
  onClose: () => void;
  align?: "left" | "right";
  placement?: "auto" | "above" | "below";
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const [active, setActive] = useState(-1);
  const selectable = items.map((it, i) => (!it.divider ? i : -1)).filter((i) => i >= 0);

  useLayoutEffect(() => {
    if (!anchor || !ref.current) return;
    const a = anchor.getBoundingClientRect();
    const m = ref.current.getBoundingClientRect();
    const above = placement === "above" || (placement === "auto" && a.bottom + m.height + 8 > window.innerHeight && a.top > m.height + 8);
    let left = align === "right" ? a.right - m.width : a.left;
    left = Math.max(8, Math.min(left, window.innerWidth - m.width - 8));
    setPos({ left, top: above ? a.top - m.height - 6 : a.bottom + 6, above });
  }, [anchor, align, placement, items.length]);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node) || anchor?.contains(e.target as Node)) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const idx = selectable.indexOf(active);
        const next = e.key === "ArrowDown" ? selectable[(idx + 1) % selectable.length] : selectable[(idx - 1 + selectable.length) % selectable.length];
        setActive(next);
      } else if (e.key === "Enter" && active >= 0) {
        e.preventDefault();
        items[active]?.onSelect?.();
        onClose();
      }
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key, true);
    };
  }, [anchor, onClose, active, items, selectable]);

  return (
    <div ref={ref} className={cx("menu", pos && "shown", pos?.above ? "above" : "below", align === "right" && "right")} role="menu" style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, width }}>
      {items.map((it, i) =>
        it.divider ? (
          <div key={it.key} className="menu-divider" />
        ) : (
          <button
            key={it.key}
            role="menuitem"
            className={cx("menu-item", it.danger && "danger", i === active && "active")}
            onMouseEnter={() => setActive(i)}
            onClick={() => {
              it.onSelect?.();
              onClose();
            }}
          >
            {it.icon && <span className="menu-icon">{it.icon}</span>}
            <span className="menu-text">
              <span className="menu-label">{it.label}</span>
              {it.hint && <span className="menu-hint">{it.hint}</span>}
            </span>
            {it.checked && <span className="menu-check"><Check size={15} /></span>}
          </button>
        ),
      )}
    </div>
  );
}

export function Modal({ title, onClose, children, wide, className }: { title?: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean; className?: string }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx("modal", wide && "wide", className)} role="dialog" aria-modal="true">
        {title && (
          <div className="modal-head">
            <div className="modal-title">{title}</div>
            <button className="icon-btn" onClick={onClose} aria-label="Закрыть">
              <X size={17} />
            </button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode }) {
  return (
    <label className="toggle-row">
      <span className="toggle-text">
        <span>{label}</span>
        {hint && <span className="muted small">{hint}</span>}
      </span>
      <button type="button" role="switch" aria-checked={checked} className={cx("switch", checked && "on")} onClick={() => onChange(!checked)}>
        <span />
      </button>
    </label>
  );
}