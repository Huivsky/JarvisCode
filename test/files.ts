// Проверки файловых инструментов: кодировки, переводы строк, многократные правки, отмена.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.JARVIS_CODE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jc-home-"));
const { editFile, writeFile, readFile, runCommand, startJob } = await import("../src/tools");
const { loadConfig } = await import("../src/config");
const { restoreSnapshot, encodeText, decodeBuffer } = await import("../src/textfile");
const { redactSecrets } = await import("../src/secrets");

let failed = 0;
let passed = 0;
const check = (name: string, ok: boolean, extra?: unknown) => (ok ? passed++ : (failed++, console.log(`✗ ${name}`, extra ?? "")));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jc-files-"));

// windows-1251 + CRLF
const f1 = path.join(dir, "cp.txt");
fs.writeFileSync(f1, encodeText("Привет\r\nмир\r\nстрока три\r\n", "cp1251").buf);
check("cp1251: чтение без кракозябр", readFile(f1).includes("Привет") && readFile(f1).includes("windows-1251"));
const r1 = editFile(f1, "мир", "дивный мир");
const d1 = decodeBuffer(fs.readFileSync(f1));
check("cp1251: кодировка сохранена", d1.enc === "cp1251" && d1.text === "Привет\r\nдивный мир\r\nстрока три\r\n", d1);
check("cp1251: есть id отмены", !!r1.undo);
// многострочная правка с LF от агента в CRLF-файле
editFile(f1, "Привет\nдивный мир", "Здравствуй\nдивный мир");
check("CRLF: многострочная правка", decodeBuffer(fs.readFileSync(f1)).text.startsWith("Здравствуй\r\nдивный мир\r\n"));
// отмена последней правки и затем первой (первая — уже после второй → нужен force)
const u = restoreSnapshot(r1.undo!);
check("отмена: файл менялся позже — нужен force", !u.ok && u.changed === true, u);
const u2 = restoreSnapshot(r1.undo!, true);
check("отмена с force", u2.ok && decodeBuffer(fs.readFileSync(f1)).text === "Привет\r\nмир\r\nстрока три\r\n");

// UTF-8 BOM
const f2 = path.join(dir, "bom.cs");
fs.writeFileSync(f2, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("class A {}\n")]));
editFile(f2, "class A", "class B");
const b2 = fs.readFileSync(f2);
check("BOM сохранён", b2[0] === 0xef && b2.subarray(3).toString() === "class B {}\n");

// UTF-16 LE (например, вывод PowerShell >)
const f3 = path.join(dir, "u16.txt");
fs.writeFileSync(f3, encodeText("alpha\r\nbeta\r\n", "utf16le").buf);
check("UTF-16: читается", readFile(f3).includes("alpha"));
editFile(f3, "beta", "gamma");
check("UTF-16: сохранён", decodeBuffer(fs.readFileSync(f3)).enc === "utf16le" && decodeBuffer(fs.readFileSync(f3)).text === "alpha\r\ngamma\r\n");

// несколько правок за раз — всё или ничего
const f4 = path.join(dir, "multi.ts");
fs.writeFileSync(f4, "const a = 1;\nconst b = 2;\nconst c = 3;\n");
const r4 = editFile(f4, [
  { old_string: "const a = 1;", new_string: "const a = 10;" },
  { old_string: "const c = 3;", new_string: "const c = 30;" },
]);
check("multi: обе правки", fs.readFileSync(f4, "utf8") === "const a = 10;\nconst b = 2;\nconst c = 30;\n" && r4.diff.some((l) => l.startsWith("@@")) === false);
let threw = false;
try {
  editFile(f4, [
    { old_string: "const a = 10;", new_string: "const a = 11;" },
    { old_string: "нет такого", new_string: "x" },
  ]);
} catch {
  threw = true;
}
check("multi: при ошибке файл не тронут", threw && fs.readFileSync(f4, "utf8").includes("const a = 10;"));

// хвостовые пробелы
const f5 = path.join(dir, "ws.py");
fs.writeFileSync(f5, "def f():   \n    return 1  \n\nprint(f())\n");
editFile(f5, "def f():\n    return 1", "def f():\n    return 2");
check("правка при отличии хвостовых пробелов", fs.readFileSync(f5, "utf8").includes("return 2"), fs.readFileSync(f5, "utf8"));

// перезапись сохраняет CRLF
const f6 = path.join(dir, "crlf.bat");
fs.writeFileSync(f6, "@echo off\r\necho 1\r\n");
writeFile(f6, "@echo off\necho 2\n");
check("write: CRLF сохранён", fs.readFileSync(f6, "utf8") === "@echo off\r\necho 2\r\n");
const w7 = writeFile(path.join(dir, "new", "file.txt"), "hello\n");
check("write: новый файл и папка", fs.readFileSync(path.join(dir, "new", "file.txt"), "utf8") === "hello\n" && !!w7.undo);
check("отмена создания удаляет файл", restoreSnapshot(w7.undo!).ok && !fs.existsSync(path.join(dir, "new", "file.txt")));

// скрытие токенов
const cfg: any = { accounts: [{ token: "ntn_abcdefghijklmnopqrstuvwxyz0123456789" }], notionToken: "", bridge: { ngrokAuthtoken: "2abcDEFghiJKLmnoPQR_xyz" }, mcp: { token: "f".repeat(48) } };
const red = redactSecrets(`token=ntn_abcdefghijklmnopqrstuvwxyz0123456789 ngrok=2abcDEFghiJKLmnoPQR_xyz url=/mcp/${"f".repeat(48)}\n-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----`, cfg);
check("redact: токены и ключи скрыты", !red.includes("ntn_abc") && !red.includes("2abcDEF") && !red.includes("ffffffffffff") && !red.includes("AAAA"), red);

// вывод команды: буква, разорванная между двумя кусками вывода, не превращается в «�»
{
  const split = `node -e "process.stdout.write(Buffer.from([0xd0])); setTimeout(() => process.stdout.write(Buffer.from([0xb6, 0x0a])), 120)"`;
  const out = await runCommand(loadConfig(), split, dir, 10);
  check("команда: буква на границе кусков вывода", out.includes("ж") && !out.includes("\uFFFD"), out);
  const job = startJob(loadConfig(), split, dir);
  for (let i = 0; i < 40 && !job.done; i++) await new Promise((r) => setTimeout(r, 100));
  check("фоновая команда: буква на границе кусков", job.output.includes("ж") && !job.output.includes("\uFFFD"), job.output);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${failed ? "✗" : "✓"} Файлы: ${passed} пройдено, ${failed} с ошибками`);
if (failed) process.exit(1);
