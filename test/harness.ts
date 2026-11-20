import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Harness } from "../src/harness";
import { Inbox } from "../src/inbox";
import { defaultTransfer, validateTransfer, excludedPath, gateTool, redactTransfer } from "../src/transfer-gate";
import { Worktrees } from "../src/worktrees";
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"jarvis-harness-")),project=path.join(tmp,"project");fs.mkdirSync(project);
let passed=0;
const test=async(name:string,fn:()=>unknown|Promise<unknown>)=>{await fn();passed++;console.log("PASS: "+name);};
const h=new Harness(path.join(tmp,"harness.json"));
try{
  await test("transfer configuration rejects absolute/traversal paths and invalid budgets",()=>{
    for(const pin of ["../secret","C:/private/key","/etc/passwd","a/../../secret"] )assert.throws(()=>validateTransfer({...defaultTransfer(),pins:[pin]}));
    assert.throws(()=>validateTransfer({...defaultTransfer(),historyChars:1}));assert.throws(()=>validateTransfer({...defaultTransfer(),cloud:"yes" as any}));
  });
  await test("excluded globs and symlink aliases cannot pin private data",()=>{
    const p={...defaultTransfer(),excluded:["private/**","**/*.key","credentials"]};
    assert(excludedPath(project,path.join(project,"private","a.txt"),p));assert(excludedPath(project,path.join(project,"a.key"),p));assert(excludedPath(project,path.join(project,"a","b.key"),p));assert(!excludedPath(project,path.join(project,"public.txt"),p));
    const outside=path.join(tmp,"outside");fs.mkdirSync(outside);fs.symlinkSync(outside,path.join(project,"escape"),process.platform==="win32"?"junction":"dir");assert(excludedPath(project,path.join(project,"escape","a.txt"),p));
  });
  await test("cloud-only restrictions and images gate before tool execution",()=>{
    assert(gateTool({...defaultTransfer(),cloud:false},project,"nc_run",[]));assert(gateTool({...defaultTransfer(),images:false},project,"nc_screenshot",[]));assert(gateTool(defaultTransfer(),project,"nc_read_file",[path.join(project,".env")]));assert.equal(gateTool(defaultTransfer(),project,"nc_read_file",[path.join(project,"safe.txt")]),null);
  });
  await test("redaction catches API keys, bearer headers, private keys and secret URLs",()=>{
    const raw="sk-"+"a".repeat(30)+"\nAuthorization: Bearer TOKEN-123\npassword=SECRET\nhttps://name:PASS@host/mcp/"+"f".repeat(48)+"\n-----BEGIN PRIVATE KEY-----\nPRIVATE\n-----END PRIVATE KEY-----";
    const clean=redactTransfer(raw);for(const secret of ["a".repeat(30),"TOKEN-123","password=SECRET","name:PASS","f".repeat(48),"\nPRIVATE\n"])assert(!clean.includes(secret));
  });
  await test("criteria are frozen for each run, manual checks cannot be forged by model text",()=>{
    h.setCriteria("a",[{title:"Review result",kind:"manual",value:""}]);h.begin("r1","a",project,"ask","normal");h.setCriteria("a",[]);
    h.tool("a","nc_run",{command:"echo DONE"},true,"exit code: 0\nall criteria passed");assert.equal(h.finish("a",true),false);assert.equal(h.get("a","r1").verdict,"pending");assert.equal(h.get("a","r1").checks.length,1);
    assert.throws(()=>h.verify("b","r1",h.get("a","r1").checks[0].criterion.id,true,"wrong chat"));h.verify("a","r1",h.get("a","r1").checks[0].criterion.id,true,"Opened and inspected locally");assert.equal(h.get("a","r1").verdict,"passed");
  });
  await test("only exact command plus observed exit 0 satisfies command proof",()=>{
    h.setCriteria("a",[{title:"Tests",kind:"command",value:"bun run test"}]);h.begin("r2","a",project,"ask","normal");h.tool("a","nc_run",{command:"echo bun run test"},true,"exit code: 0");assert.equal(h.get("a","r2").checks[0].state,"pending");h.tool("a","nc_run",{command:"bun run test"},false,"exit code: 1");assert.equal(h.get("a","r2").checks[0].state,"failed");h.tool("a","nc_run",{command:"bun run test"},true,"exit code: 0\ntests passed");assert(h.finish("a",true));assert.equal(h.get("a","r2").checks[0].state,"passed");
  });
  await test("artifact proof hashes a bounded regular file; missing/excluded files fail",()=>{
    fs.writeFileSync(path.join(project,"result.txt"),"result");h.setCriteria("a",[{title:"Artifact",kind:"artifact",value:"result.txt"}]);h.begin("r3","a",project,"ask","normal");assert(h.finish("a",true));assert.match(h.get("a","r3").checks[0].hash!,/^[a-f0-9]{64}$/);
    h.setCriteria("a",[{title:"Missing",kind:"artifact",value:"missing.txt"}]);h.begin("r4","a",project,"ask","normal");assert(!h.finish("a",true));assert.equal(h.get("a","r4").verdict,"failed");
    assert.throws(()=>h.setCriteria("a",[{title:"Escape",kind:"artifact",value:"../secret"}]));
  });
  await test("default journal contains metadata only and safe replay executes nothing",()=>{
    h.setCriteria("b",[]);h.begin("r5","b",project,"ask","normal");h.context("b","CONTEXT SECRET");h.tool("b","nc_run",{command:"secret-command"},true,"PRIVATE FILE CONTENT\nexit code: 0");h.finish("b",true);
    const replay=h.replay("b","r5"),text=JSON.stringify(replay);assert.equal(replay.executesTools,false);assert(!text.includes("CONTEXT SECRET"));assert(!text.includes("secret-command"));assert(!text.includes("PRIVATE FILE CONTENT"));assert.equal(replay.mode,"read-only-replay");assert.throws(()=>h.replay("a","r5"));assert.equal(replay.verdict,"unconfigured");
  });
  await test("optional diagnostic body capture is redacted and bounded",()=>{
    h.setPolicy(project,{...defaultTransfer(),captureBodies:true});h.begin("r6","c",project,"ask","normal");for(let i=0;i<20;i++)h.tool("c","nc_read_file",{},true,"password=SECRET\n"+"x".repeat(8000));h.finish("c",true);const replay=h.replay("c","r6");assert(!JSON.stringify(replay.events).includes("password=SECRET"));assert(replay.events.reduce((n,e)=>n+(e.body?.length||0),0)<=64000);assert(replay.capped);
  });
  await test("restart marks incomplete execution without replaying actions",()=>{
    h.begin("r7","d",project,"ask","normal");const restarted=new Harness(path.join(tmp,"harness.json"));assert(restarted.get("d","r7").endedAt);assert(restarted.replay("d","r7").events.some(e=>e.type==="interrupted"));assert.equal(restarted.current("d"),undefined);
  });
  await test("context build failure resolves the pending run without delivering actions",async()=>{
    const inbox=new Inbox({idleMinutes:()=>1});const reply=inbox.enqueue({chatId:"failed",build:()=>{throw new Error("blocked attachment");}});
    assert.match(await inbox.next(1),/^BLOCKED/);assert.equal((await reply).error,"blocked attachment");assert.equal(inbox.activeChat(),null);
  });
  const repo=path.join(tmp,"repo");fs.mkdirSync(repo);
  const git=(cwd:string,...args:string[])=>{const r=spawnSync("git",["-c","user.name=Harness Test","-c","user.email=test@example.invalid",...args],{cwd,encoding:"utf8",windowsHide:true});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  git(repo,"init");git(repo,"config","core.autocrlf","false");fs.writeFileSync(path.join(repo,"main.txt"),"base\n");git(repo,"add","main.txt");git(repo,"commit","-m","base");
  const trees=new Worktrees(path.join(tmp,"trees.json"),path.join(tmp,"managed-trees"));
  await test("worktree is separate, refuses dirty deletion and applies only committed fast-forward",()=>{
    const tree=trees.create("chat",repo);assert(fs.existsSync(path.join(tree.target,"main.txt")));assert.throws(()=>trees.create("chat",repo));fs.writeFileSync(path.join(tree.target,"main.txt"),"changed\n");assert.equal(fs.readFileSync(path.join(repo,"main.txt"),"utf8"),"base\n");assert.match(trees.diff("chat").diff,/changed/);assert.throws(()=>trees.remove("chat"));assert.throws(()=>trees.apply("chat"));git(tree.target,"add","main.txt");git(tree.target,"commit","-m","change");trees.apply("chat");assert.equal(fs.readFileSync(path.join(repo,"main.txt"),"utf8"),"changed\n");trees.remove("chat");assert(!fs.existsSync(tree.target));assert.equal(trees.get("chat"),null);assert(git(repo,"branch","--list",tree.branch));
  });
  await test("source changes and outside registry operations cannot be silently overwritten",()=>{
    const tree=trees.create("conflict",repo);assert(fs.existsSync(tree.target));fs.writeFileSync(path.join(repo,"main.txt"),"user changes\n");assert.throws(()=>trees.apply("conflict"));fs.writeFileSync(path.join(repo,"main.txt"),"changed\n");trees.remove("conflict");assert.throws(()=>trees.diff("not-owned"));
    fs.writeFileSync(path.join(repo,"untracked.txt"),"user data");assert.throws(()=>trees.create("dirty",repo));assert.equal(fs.readFileSync(path.join(repo,"untracked.txt"),"utf8"),"user data");
  });
  console.log(`HARNESS: ${passed} groups passed`);
}finally{fs.rmSync(tmp,{recursive:true,force:true});}

