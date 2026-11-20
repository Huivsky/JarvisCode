import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeRelayUrl, relayDestination, relayService } from "../src/relay-links";
import { atomicInstallFile, ownedInstallFiles, validateInstallDir } from "../src/install-files";
import { ChatStore } from "../src/chats";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-regression-"));
let passed = 0;
function test(name: string, run: () => void) { run(); passed++; console.log(`PASS: ${name}`); }
try {
  test("normalize individual destination", () => {
    assert.equal(normalizeRelayUrl("  notion.so/my-chat?q=1  "), "https://notion.so/my-chat?q=1");
    assert.equal(normalizeRelayUrl(""), "");
    assert.equal(normalizeRelayUrl("https://www.notion.com/chat#x"), "https://www.notion.com/chat#x");
    assert.equal(normalizeRelayUrl("huivsky.retool.com/apps/jarvis"), "https://huivsky.retool.com/apps/jarvis");
    assert.equal(normalizeRelayUrl("https://sandbox-1.retool.app/x"), "https://sandbox-1.retool.app/x");
    assert.equal(relayService("https://huivsky.retool.com/apps/jarvis"), "retool");
    assert.equal(relayService("https://notion.so/a"), "notion");
    assert.equal(relayService(""), "notion");
  });
  test("reject dangerous or unrelated destinations", () => {
    for (const url of [null, 42, "javascript:alert(1)", "http://notion.so/a", "https://notion.so.evil.test/a", "https://evil.test/a", "https://user:pass@notion.so/a", "https://notion.so:81/a", "https://notion.so/a b", "http://retool.com/a", "https://retool.com.evil.test/a", "https://evilretool.com/a"]) assert.throws(() => normalizeRelayUrl(url));
  });
  test("individual → global → default fallback", () => {
    assert.equal(relayDestination("https://notion.so/a", "https://notion.so/b", "default"), "https://notion.so/a");
    assert.equal(relayDestination("", "https://notion.so/b", "default"), "https://notion.so/b");
    assert.equal(relayDestination("bad value", "", "default"), "default");
  });
  test("independent destinations persist after restart", () => {
    const folder = path.join(dir, "chats"), store = new ChatStore(folder);
    const a = store.create({ title: "A", mode: "ask", project: dir });
    const b = store.create({ title: "B", mode: "ask", project: dir });
    a.relayChatUrl = "https://notion.so/a"; b.relayChatUrl = "https://notion.so/b";
    store.save(a, true); store.save(b, true); store.flush();
    const restarted = new ChatStore(folder);
    assert.equal(restarted.get(a.id)?.relayChatUrl, a.relayChatUrl);
    assert.equal(restarted.get(b.id)?.relayChatUrl, b.relayChatUrl);
    assert.equal(restarted.list().find(c => c.id === a.id)?.relayChatUrl, a.relayChatUrl);
  });
  test("safe Windows installation paths", () => {
    assert.equal(validateInstallDir("C:\\Users\\Test\\Apps\\Jarvis Code", true), "C:\\Users\\Test\\Apps\\Jarvis Code");
    for (const value of ["", "C:\\", "relative", "C:\\bad\u0000path", "C:\\Apps\\bad:name", "C:\\Apps\\bad*name"]) assert.throws(() => validateInstallDir(value, true));
  });
  test("atomic install replaces program without touching neighbouring files", () => {
    const source = path.join(dir, "source.exe"), target = path.join(dir, "JarvisCode.exe"), foreign = path.join(dir, "personal.txt");
    fs.writeFileSync(source, "NEW EXECUTABLE"); fs.writeFileSync(target, "OLD EXECUTABLE"); fs.writeFileSync(foreign, "KEEP");
    atomicInstallFile(source, target);
    assert.equal(fs.readFileSync(target, "utf8"), "NEW EXECUTABLE"); assert.equal(fs.readFileSync(foreign, "utf8"), "KEEP");
    assert.equal(fs.readdirSync(dir).filter(x => /\.(tmp|bak)$/.test(x)).length, 0);
  });
  test("copy failure preserves installed application", () => {
    const target = path.join(dir, "JarvisCode.exe");
    assert.throws(() => atomicInstallFile(path.join(dir, "missing.exe"), target));
    assert.equal(fs.readFileSync(target, "utf8"), "NEW EXECUTABLE");
  });
  test("replacement failure rolls back to previous executable", () => {
    const source = path.join(dir, "source.exe"), target = path.join(dir, "JarvisCode.exe");
    fs.writeFileSync(target, "WORKING OLD");
    const rename = fs.renameSync;
    fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
      if (String(from).endsWith(".tmp")) throw new Error("simulated locked target");
      return rename(from, to);
    }) as typeof fs.renameSync;
    try { assert.throws(() => atomicInstallFile(source, target), /simulated/); }
    finally { fs.renameSync = rename; }
    assert.equal(fs.readFileSync(target, "utf8"), "WORKING OLD");
  });
  test("uninstall allowlist preserves unrelated files and nested folders", () => {
    fs.writeFileSync(path.join(dir, "jarvis.cmd"), "launcher"); fs.writeFileSync(path.join(dir, "jarvis-code-4.0.4.ico"), "icon");
    fs.mkdirSync(path.join(dir, "user-documents")); fs.writeFileSync(path.join(dir, "user-documents", "important.txt"), "KEEP");
    const owned = ownedInstallFiles(dir);
    assert(owned.includes("JarvisCode.exe")); assert(owned.includes("jarvis-code-4.0.4.ico"));
    assert(!owned.includes("personal.txt")); assert(!owned.includes("user-documents")); assert(!owned.includes("source.exe"));
  });
  console.log(`\n${passed} regression groups passed`);
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
