// Свои «/»-команды: разбор файлов, приоритеты, аргументы. Запуск: bun test/commands.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.JARVIS_CODE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jc-home-"));
const { listCommands, expandCommand, ensureUserCommands, USER_COMMANDS_DIR } = await import("../src/commands");

let failed = 0;
let passed = 0;
const check = (name: string, ok: boolean, extra?: unknown) => (ok ? passed++ : (failed++, console.log(`✗ ${name}`, extra ?? "")));
const project = fs.mkdtempSync(path.join(os.tmpdir(), "jc-proj-"));
const pj = path.join(project, ".jarvis", "commands");
const cl = path.join(project, ".claude", "commands");
fs.mkdirSync(pj, { recursive: true });
fs.mkdirSync(cl, { recursive: true });
fs.mkdirSync(USER_COMMANDS_DIR, { recursive: true });

fs.writeFileSync(path.join(pj, "deploy.md"), "\uFEFF---\r\ndescription: \"Выкатить на прод\"\r\nallowed-tools: Bash\r\n---\r\nСобери и выкати $ARGUMENTS.\r\nПотом проверь $ARGUMENTS ещё раз.\r\n");
fs.writeFileSync(path.join(cl, "fix-tests.md"), "# Почини упавшие тесты\n\nЗапусти тесты, найди причину, исправь.\n");
fs.writeFileSync(path.join(cl, "deploy.md"), "Claude-версия deploy — не должна победить\n");
fs.writeFileSync(path.join(USER_COMMANDS_DIR, "deploy.md"), "личная deploy — скрыта командой проекта\n");
fs.writeFileSync(path.join(USER_COMMANDS_DIR, "standup.md"), "Сводка по git log за вчера\n");
fs.writeFileSync(path.join(USER_COMMANDS_DIR, "init.md"), "подмена встроенной /init\n");
fs.writeFileSync(path.join(USER_COMMANDS_DIR, "Плохое имя.md"), "x\n");
fs.writeFileSync(path.join(USER_COMMANDS_DIR, "empty.md"), "---\ndescription: пусто\n---\n\n");
fs.writeFileSync(path.join(USER_COMMANDS_DIR, "notes.txt"), "не .md\n");

const list = listCommands(project);
const names = list.map((c) => c.name);
check("список: проект, claude, личные — по порядку", JSON.stringify(names) === JSON.stringify(["deploy", "fix-tests", "standup"]), names);
const dep = list.find((c) => c.name === "deploy")!;
check("шапка: description без кавычек, BOM и CRLF", dep.description === "Выкатить на прод" && dep.source === "project" && dep.args, dep);
check("описание из первой строки без #", list.find((c) => c.name === "fix-tests")?.description === "Почини упавшие тесты");
check("личная команда", list.find((c) => c.name === "standup")?.source === "user");

const e1 = expandCommand(project, "/deploy staging");
check("аргументы подставляются везде", e1?.prompt === "Собери и выкати staging.\nПотом проверь staging ещё раз.", e1);
const e2 = expandCommand(project, "/fix-tests только auth.test.ts");
check("без $ARGUMENTS — аргументы дописываются", e2?.prompt.endsWith("исправь.\n\nтолько auth.test.ts") === true, e2);
check("регистр имени не важен", expandCommand(project, "/Standup")?.name === "standup");
check("многострочные аргументы", expandCommand(project, "/deploy a\nb")?.prompt.startsWith("Собери и выкати a\nb.") === true);
check("встроенные не подменяются", expandCommand(project, "/init") === null && expandCommand(project, "/review x") === null);
check("неизвестная — как обычный текст", expandCommand(project, "/nope") === null && expandCommand(project, "не команда") === null && expandCommand(project, "/deploy/x") === null);
check("без проекта — только личные", listCommands("").map((c) => c.name).join() === "deploy,standup");

fs.rmSync(USER_COMMANDS_DIR, { recursive: true, force: true });
const dir = ensureUserCommands();
check("пример личной команды создаётся в пустой папке", fs.existsSync(path.join(dir, "explain.md")) && listCommands("").some((c) => c.name === "explain" && c.args));
fs.writeFileSync(path.join(dir, "explain.md"), "моя версия\n");
ensureUserCommands();
check("пример не перезаписывает файлы пользователя", fs.readFileSync(path.join(dir, "explain.md"), "utf8") === "моя версия\n");

fs.rmSync(project, { recursive: true, force: true });
fs.rmSync(process.env.JARVIS_CODE_HOME!, { recursive: true, force: true });
console.log(`\n${failed ? "✗" : "✓"} Свои команды: ${passed} пройдено, ${failed} с ошибками`);
process.exit(failed ? 1 : 0);
