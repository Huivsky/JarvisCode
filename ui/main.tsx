import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Installer } from "./Installer";
import { openExternal, start, VIEW } from "./store";

// Окно приложения не должно уходить со своей страницы: внешние ссылки — в браузер по умолчанию.
document.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest?.("a[href]") as HTMLAnchorElement | null;
  if (!a) return;
  const href = a.getAttribute("href") ?? "";
  if (/^(https?:|mailto:)/i.test(href)) {
    e.preventDefault();
    openExternal(href);
  }
});
// Файл, брошенный мимо поля ввода, иначе откроется вместо приложения.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

start();
createRoot(document.getElementById("root")!).render(VIEW === "install" ? <Installer /> : <App />);
