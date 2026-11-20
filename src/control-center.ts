import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "./paths";

export type RunStatus = "running" | "done" | "error" | "blocked" | "stopped" | "interrupted";
export interface TaskRun { id: string; chatId: string; title: string; project: string; startedAt: number; endedAt?: number; status: RunStatus; steps: Array<{ id: string; tool: string; label: string; status: string; ms?: number }>; accepted: string[]; }
export interface PlannedTask { id: string; chatId: string; title: string; prompt: string; dependsOn: string[]; status: "pending" | "running" | "done" | "error" | "blocked" | "paused"; runId?: string; note?: string; }
export interface ProjectPolicy { profile: "readonly" | "confirm" | "trusted" | "full"; roots: string[]; commands: string[]; }
export interface MemorySection { text: string; enabled: boolean; }
export interface ProjectMemory { rules: MemorySection; decisions: MemorySection; task: MemorySection; }
export interface UpdatePolicy { channel: "stable" | "beta"; requireSignature: boolean; publisher: string; }
interface State { schema: 1; runs: TaskRun[]; tasks: PlannedTask[]; policies: Record<string, ProjectPolicy>; memories: Record<string, ProjectMemory>; update: UpdatePolicy; }
const id = () => crypto.randomBytes(10).toString("hex");
export const projectKey = (project: string) => crypto.createHash("sha256").update(process.platform === "win32" ? path.resolve(project).toLowerCase() : path.resolve(project)).digest("hex");
const emptyMemory = (): ProjectMemory => ({ rules: { text: "", enabled: true }, decisions: { text: "", enabled: true }, task: { text: "", enabled: true } });

export class ControlCenter {
  private data: State;
  private queues = new Map<string, { stop: boolean }>();
  constructor(private file = path.join(DATA_DIR, "control-center.json")) {
    this.data = { schema: 1, runs: [], tasks: [], policies: {}, memories: {}, update: { channel: "stable", requireSignature: false, publisher: "" } };
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (data.schema !== 1 || !Array.isArray(data.runs) || !Array.isArray(data.tasks) || !data.policies || !data.memories) throw new Error("Повреждён control-center.json — восстановите резервную копию; сброс прав автоматически запрещён");
      this.data = { ...this.data, ...data };
      for (const run of this.data.runs) if (run.status === "running") { run.status = "interrupted"; run.endedAt = Date.now(); }
      for (const task of this.data.tasks) if (task.status === "running" || task.status === "pending") { task.status = "paused"; task.note = "Перезапуск: подтвердите продолжение, действия не повторены автоматически"; }
      this.save();
    }
  }
  private save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    if (fs.existsSync(this.file)) fs.copyFileSync(this.file, this.file + ".bak");
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 }); fs.renameSync(tmp, this.file);
  }
  snapshot(chatId: string, project: string) {
    return structuredClone({ runs: this.data.runs.filter(r => r.chatId === chatId).slice(-100), tasks: this.data.tasks.filter(t => t.chatId === chatId), policy: this.policy(project), memory: this.memory(project), update: this.data.update, queueRunning: this.queues.has(chatId) });
  }
  begin(chatId: string, title: string, project: string): TaskRun {
    if (this.current(chatId)) throw new Error("В этом чате уже выполняется задача");
    const run: TaskRun = { id: id(), chatId, title: title.slice(0,200), project, startedAt: Date.now(), status: "running", steps: [], accepted: [] };
    this.data.runs.push(run); this.save(); return structuredClone(run);
  }
  current(chatId: string) { return this.data.runs.find(r => r.chatId === chatId && r.status === "running"); }
  last(chatId: string) { return this.data.runs.filter(r => r.chatId === chatId).at(-1); }
  run(runId: string) { return this.data.runs.find(r => r.id === runId); }
  step(chatId: string, item: { id: string; kind: string; tool?: string; label?: string; status?: string; ms?: number }) {
    const run = this.current(chatId); if (!run || item.kind !== "tool") return;
    const step = { id: item.id, tool: item.tool || "", label: item.label || item.tool || "", status: item.status || "running", ms: item.ms };
    const at = run.steps.findIndex(s => s.id === item.id); if (at < 0) run.steps.push(step); else run.steps[at] = step;
    this.save();
  }
  finish(chatId: string, status: RunStatus) {
    const run = this.current(chatId); if (!run) return;
    run.status = status === "done" && run.steps.some(s => ["error","denied","running","waiting"].includes(s.status)) ? "error" : status;
    run.endedAt = Date.now(); this.save();
  }
  accept(chatId: string, runId: string, itemIds: string[]) {
    const run = this.run(runId); if (!run || run.chatId !== chatId || run.status === "running") throw new Error("Задача не найдена или ещё выполняется");
    if (itemIds.some(id => !run.steps.some(s => s.id === id))) throw new Error("Правка не принадлежит этой задаче");
    run.accepted = [...new Set([...run.accepted,...itemIds])]; this.save();
  }
  policy(project: string): ProjectPolicy { return structuredClone(this.data.policies[projectKey(project)] || { profile: "confirm", roots: [path.resolve(project)], commands: [] }); }
  setPolicy(project: string, input: ProjectPolicy) {
    if (!["readonly","confirm","trusted","full"].includes(input.profile) || !Array.isArray(input.roots) || !input.roots.length || input.roots.length > 20 || !Array.isArray(input.commands) || input.commands.length > 100) throw new Error("Некорректные права проекта");
    const roots = input.roots.map(root => { if (typeof root !== "string" || !path.isAbsolute(root) || !fs.statSync(root).isDirectory()) throw new Error("Разрешённые папки должны существовать и иметь абсолютный путь"); return path.resolve(root); });
    const commands = input.commands.map(cmd => { if (typeof cmd !== "string" || !cmd.trim() || cmd.length > 2000 || /[\r\n]/.test(cmd)) throw new Error("Одна точная команда на строку"); return cmd.trim(); });
    this.data.policies[projectKey(project)] = { profile: input.profile, roots, commands }; this.save();
  }
  memory(project: string): ProjectMemory { return structuredClone(this.data.memories[projectKey(project)] || emptyMemory()); }
  setMemory(project: string, input: ProjectMemory) {
    const memory = emptyMemory();
    for (const key of ["rules","decisions","task"] as const) { const v = input[key]; if (!v || typeof v.text !== "string" || v.text.length > 16000 || typeof v.enabled !== "boolean") throw new Error("Некорректный раздел памяти (до 16 000 символов)"); memory[key] = { text: v.text, enabled: v.enabled }; }
    this.data.memories[projectKey(project)] = memory; this.save();
  }
  memoryPreview(project: string) { return Object.entries(this.memory(project)).filter(([,v]) => v.enabled && v.text.trim()).map(([key,v]) => `[${key}]\n${v.text}`).join("\n\n"); }
  updatePolicy() { return structuredClone(this.data.update); }
  setUpdatePolicy(input: UpdatePolicy) {
    if (!["stable","beta"].includes(input.channel) || typeof input.requireSignature !== "boolean" || typeof input.publisher !== "string" || input.publisher.length > 500) throw new Error("Некорректная политика обновления");
    this.data.update = { channel: input.channel, requireSignature: input.requireSignature, publisher: input.publisher.trim() }; this.save();
  }
  addTask(chatId: string, input: { title: string; prompt: string; dependsOn: string[] }) {
    if (this.data.tasks.filter(t => t.chatId === chatId && t.status !== "done").length >= 100) throw new Error("В очереди уже 100 задач");
    const task: PlannedTask = { id: id(), chatId, title: "", prompt: "", dependsOn: [], status: "pending" }; this.validateTask(task, input); this.data.tasks.push(task); this.save(); return structuredClone(task);
  }
  private validateTask(task: PlannedTask, input: { title: string; prompt: string; dependsOn: string[] }) {
    if (typeof input.title !== "string" || !input.title.trim() || input.title.length > 200 || typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 20000 || !Array.isArray(input.dependsOn) || input.dependsOn.length > 30) throw new Error("Нужны название, задание и список зависимостей");
    const visit = (node: string, seen = new Set<string>()): boolean => { if (node === task.id) return true; if (seen.has(node)) return false; seen.add(node); return (this.data.tasks.find(t => t.id === node)?.dependsOn || []).some(dep => visit(dep, seen)); };
    for (const dep of input.dependsOn) if (typeof dep !== "string" || !this.data.tasks.some(t => t.id === dep && t.chatId === task.chatId) || visit(dep)) throw new Error("Зависимость не существует в этом чате или образует цикл");
    task.title = input.title.trim(); task.prompt = input.prompt.trim(); task.dependsOn = [...new Set(input.dependsOn)];
  }
  editTask(chatId: string, taskId: string, input: { title: string; prompt: string; dependsOn: string[] }) {
    const task = this.data.tasks.find(t => t.id === taskId && t.chatId === chatId); if (!task || task.status === "running" || task.status === "done") throw new Error("Нельзя изменить эту задачу");
    this.validateTask(task,input); task.status = "paused"; task.note = "Изменено пользователем; требуется запуск"; this.save();
  }
  removeTask(chatId: string, taskId: string) {
    const task = this.data.tasks.find(t => t.id === taskId && t.chatId === chatId);
    if (!task || task.status === "running" || this.data.tasks.some(t => t.dependsOn.includes(taskId))) throw new Error("У задачи есть зависимости или она выполняется");
    this.data.tasks = this.data.tasks.filter(t => t.id !== taskId); this.save();
  }
  pauseQueue(chatId: string) { const queue = this.queues.get(chatId); if (queue) queue.stop = true; for (const task of this.data.tasks) if (task.chatId === chatId && task.status === "pending") task.status = "paused"; this.save(); }
  async startQueue(chatId: string, execute: (task: PlannedTask) => Promise<{ ok: boolean; runId?: string }>) {
    if (this.queues.has(chatId)) throw new Error("Очередь уже запущена");
    const queue = { stop: false }; this.queues.set(chatId,queue);
    for (const task of this.data.tasks) if (task.chatId === chatId && ["paused","blocked"].includes(task.status)) task.status = "pending";
    this.save();
    try {
      while (!queue.stop) {
        const pending = this.data.tasks.filter(t => t.chatId === chatId && t.status === "pending"); if (!pending.length) break;
        const task = pending.find(t => t.dependsOn.every(dep => this.data.tasks.find(x => x.id === dep)?.status === "done"));
        if (!task) { for (const t of pending) { t.status = "blocked"; t.note = "Зависимости не завершены успешно"; } this.save(); break; }
        task.status = "running"; task.note = undefined; this.save();
        try { const result = await execute(structuredClone(task)); task.runId = result.runId; task.status = result.ok ? "done" : "error"; }
        catch (e) { task.status = "error"; task.note = (e as Error).message.slice(0,300); }
        this.save();
        if (task.status !== "done") { queue.stop = true; task.note ||= "Ошибка, BLOCKED или нет явного DONE; дальнейшие действия остановлены"; }
      }
    } finally { this.queues.delete(chatId); for (const t of this.data.tasks) if (t.chatId === chatId && t.status === "pending") t.status = "paused"; this.save(); }
  }
}

/** Resolves existing symlinks and a non-existent tail before checking a boundary. */
export function canonical(file: string): string {
  let at = path.resolve(file); const tail: string[] = [];
  while (!fs.existsSync(at)) { const parent = path.dirname(at); if (parent === at) break; tail.unshift(path.basename(at)); at = parent; }
  const result = path.join(fs.realpathSync(at), ...tail); return process.platform === "win32" ? result.toLowerCase() : result;
}
export function within(root: string, file: string): boolean { const rel = path.relative(canonical(root),canonical(file)); return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel)); }
export function projectDecision(policy: ProjectPolicy, kind: string, paths: string[], command?: string): { action: "allow" | "ask" | "deny"; reason: string } {
  const secret = paths.some(p => /(?:^|[\\/])(?:\.ssh|\.aws|\.azure|\.kube)(?:[\\/]|$)|(?:^|[\\/])\.env(?:$|\.(?!example$|sample$|template$))|\.(?:pem|pfx|key|kdbx)$/i.test(p) || within(DATA_DIR,p));
  if (secret) return { action: "deny", reason: "Права проекта: ключи, секреты и внутренние данные приложения запрещены" };
  if (policy.profile === "readonly" && kind !== "read") return { action: "deny", reason: "Проект открыт только для чтения; команды и наблюдение отключены" };
  if (policy.profile !== "full" && paths.some(p => !policy.roots.some(root => within(root,p)))) return { action: "ask", reason: "Действие за пределами разрешённых папок: разрешение только на этот вызов" };
  if (kind === "exec" && policy.profile !== "full" && (policy.profile !== "trusted" || !command || !policy.commands.includes(command.trim()))) return { action: "ask", reason: "Команда не разрешена точным правилом проекта; подтвердите только этот вызов" };
  return { action: "allow", reason: "Права проекта" };
}
export const controls = new ControlCenter();
