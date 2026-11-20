import { cx } from "./common";
import { Alert, Check, Info } from "./icons";
import { set, useStore } from "./store";

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite" role="status">
      {toasts.map((t) => (
        <div key={t.id} className={cx("toast", t.level)} onClick={() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== t.id) }))}>
          <span className="toast-ico">{t.level === "error" ? <Alert size={15} /> : t.level === "success" ? <Check size={15} /> : <Info size={15} />}</span>
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}
