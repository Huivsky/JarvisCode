import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ControlCenter, projectDecision } from "../src/control-center";
import { RelayHub, sessionPrompt } from "../src/relay-hub";
import { diagnosticChecks, diagnosticReport } from "../src/diagnostics";
import { signaturePermitted, waitForHealthyUpdate } from "../src/update-health";
import { cmpVersion } from "../src/updater";
import { Inbox } from "../src/inbox";
import { defaultConfig } from "../src/config";
import { decide } from "../src/permissions";

const dir=fs.mkdtempSync(path.join(os.tmpdir(),"jarvis-control-")), project=path.join(dir,"project");fs.mkdirSync(project);
let passed=0;
async function test(name:string,fn:()=>void|Promise<void>){await fn();passed++;console.log("PASS: "+name);}
try {
  await test("two relay queues route only to their own session and replies",async()=>{
    const hub=new RelayHub({idleMinutes:()=>1});hub.bind("a".repeat(48),"a");hub.bind("b".repeat(48),"b");
    const a=hub.forChat("a").enqueue({chatId:"a",build:()=>"MESSAGE A"}),b=hub.forChat("b").enqueue({chatId:"b",build:()=>"MESSAGE B"});
    await assert.rejects(()=>hub.scoped(undefined,async()=>"bypass"),/session_id/);
    await assert.rejects(()=>hub.scoped("unknown",async()=>"bypass"),/Unknown/);
    const messages=await Promise.all([hub.scoped("a".repeat(48),()=>hub.current().next(1)),hub.scoped("b".repeat(48),()=>hub.current().next(1))]);
    assert.deepEqual(messages,["MESSAGE A","MESSAGE B"]);
    await hub.scoped("b".repeat(48),async()=>{hub.current().reply("ANSWER B","DONE");});
    await hub.scoped("a".repeat(48),async()=>{hub.current().reply("ANSWER A","DONE");});
    assert.equal((await a).text,"ANSWER A");assert.equal((await b).text,"ANSWER B");
  });
  await test("duplicate listener is rejected without consuming a second message",async()=>{
    const inbox=new Inbox({idleMinutes:()=>1}),signal=new AbortController();
    const waiting=inbox.next(1,signal.signal);
    assert.match(await inbox.next(1),/^LISTENER_BUSY/);signal.abort();await waiting;
  });
  await test("unanswered task is never silently discarded on repeated inbox polls",async()=>{
    const inbox=new Inbox({idleMinutes:()=>1});const answer=inbox.enqueue({chatId:"a",build:()=>"task"});
    await inbox.next(1);assert.match(await inbox.next(1),/^NO_REPLY_YET/);assert.match(await inbox.next(1),/^NO_REPLY_YET/);assert.equal(inbox.activeChat()?.chatId,"a");inbox.reply("done");await answer;
  });
  await test("cancellation affects only its own chat and exposes abort signal",async()=>{
    const hub=new RelayHub({idleMinutes:()=>1}),abort=new AbortController();
    const a=hub.forChat("a").enqueue({chatId:"a",build:()=>"A",signal:abort.signal}),b=hub.forChat("b").enqueue({chatId:"b",build:()=>"B"});
    await hub.forChat("a").next(1);assert.equal(hub.forChat("a").activeChat()?.signal,abort.signal);abort.abort();assert((await a).cancelled);
    assert.equal(await hub.forChat("b").next(1),"B");hub.forChat("b").reply("B done");assert.equal((await b).text,"B done");
  });
  await test("revoked token cannot access a relay queue",async()=>{
    const hub=new RelayHub({idleMinutes:()=>1});hub.bind("c".repeat(48),"c");hub.revoke("c");await assert.rejects(()=>hub.scoped("c".repeat(48),async()=>"x"),/Unknown/);
    assert.match(sessionPrompt("BASE","d".repeat(48)),/EVERY nc_\* call/);
  });
  await test("project policies restrict writes, external paths and unapproved commands",()=>{
    const readonly={profile:"readonly" as const,roots:[project],commands:[]};
    assert.equal(projectDecision(readonly,"read",[path.join(project,"code.ts")]).action,"allow");assert.equal(projectDecision(readonly,"write",[path.join(project,"code.ts")]).action,"deny");
    assert.equal(projectDecision({...readonly,profile:"confirm"},"read",[path.join(dir,"other.txt")]).action,"ask");
    assert.equal(projectDecision({...readonly,profile:"trusted",commands:["git status"]},"exec",[project],"git status").action,"allow");
    assert.equal(projectDecision({...readonly,profile:"trusted",commands:["git status"]},"exec",[project],"git status; whoami").action,"ask");
    assert.equal(projectDecision({...readonly,profile:"trusted"},"read",[path.join(project,".env")]).action,"deny");
  });
  await test("full access is explicit, persists, permits ordinary commands and keeps protected boundaries",()=>{
    const c=new ControlCenter(path.join(dir,"full-policy.json"));assert.equal(c.policy(project).profile,"confirm");
    const policy={profile:"full" as const,roots:[project],commands:[]};c.setPolicy(project,policy);
    assert.equal(new ControlCenter(path.join(dir,"full-policy.json")).policy(project).profile,"full");
    for(const command of ["git status","git diff","Write-Output ok"]){assert.equal(projectDecision(policy,"exec",[project],command).action,"allow");}
    assert.equal(projectDecision(policy,"write",[path.join(dir,"outside.txt")]).action,"allow");
    assert.equal(projectDecision(policy,"read",[path.join(project,".env")]).action,"deny");
    const cfg=defaultConfig(),base={cfg,mode:"full" as const,project,sessionAllow:[]};
    assert.equal(decide({...base,kind:"exec",command:"git status"}).action,"allow");
    assert.equal(decide({...base,kind:"exec",command:"format C:"}).action,"deny");
    assert.equal(decide({...base,kind:"exec",command:"Get-Content .env"}).action,"ask");
    assert.equal(decide({...base,kind:"exec",command:"powershell -EncodedCommand "+Buffer.from("Write-Output ok","utf16le").toString("base64")}).action,"ask");
    assert.equal(decide({...base,kind:"observe",tool:"nc_screenshot"}).action,"ask");
    cfg.deny=["git status"];assert.equal(decide({...base,kind:"exec",command:"git status"}).action,"deny");
    cfg.fileScope="project";assert.equal(decide({...base,kind:"write",paths:[path.join(dir,"outside.txt")]}).action,"ask");
  });
  await test("symlink escape requires confirmation even inside a lexical project path",()=>{
    const outside=path.join(dir,"outside");fs.mkdirSync(outside);fs.symlinkSync(outside,path.join(project,"escape"),process.platform==="win32"?"junction":"dir");
    assert.equal(projectDecision({profile:"confirm",roots:[project],commands:[]},"write",[path.join(project,"escape","new.txt")]).action,"ask");
  });
  await test("user memory sections persist and disabled sections are omitted",()=>{
    const file=path.join(dir,"memory.json"),c=new ControlCenter(file);
    c.setMemory(project,{rules:{text:"RULES",enabled:true},decisions:{text:"PRIVATE DECISION",enabled:false},task:{text:"CURRENT TASK",enabled:true}});
    const restart=new ControlCenter(file);assert.match(restart.memoryPreview(project),/RULES/);assert(!restart.memoryPreview(project).includes("PRIVATE DECISION"));
    assert.equal(restart.memory(project).decisions.text,"PRIVATE DECISION");
  });
  await test("execution cards persist steps and failed tools prevent DONE",()=>{
    const c=new ControlCenter(path.join(dir,"runs.json")),run=c.begin("a","Fix","project");
    c.step("a",{id:"i1",kind:"tool",tool:"nc_run",status:"error"});c.finish("a","done");assert.equal(c.run(run.id)?.status,"error");
    assert.throws(()=>c.accept("b",run.id,["i1"]));c.accept("a",run.id,["i1"]);assert(c.run(run.id)?.accepted.includes("i1"));
  });
  await test("restart marks running work interrupted and queue paused without replay",()=>{
    const file=path.join(dir,"restart.json"),c=new ControlCenter(file);c.begin("a","Work",project);const task=c.addTask("a",{title:"Task",prompt:"Do it",dependsOn:[]});
    const restarted=new ControlCenter(file);assert.equal(restarted.last("a")?.status,"interrupted");assert.equal(restarted.snapshot("a",project).tasks.find(t=>t.id===task.id)?.status,"paused");
  });
  await test("dependency queue executes in order and does not run dependent work on error",async()=>{
    const c=new ControlCenter(path.join(dir,"queue.json"));const first=c.addTask("a",{title:"Fix",prompt:"fix",dependsOn:[]});c.addTask("a",{title:"Test",prompt:"test",dependsOn:[first.id]});
    const seen:string[]=[];await c.startQueue("a",async task=>{seen.push(task.prompt);return{ok:false};});assert.deepEqual(seen,["fix"]);
    c.editTask("a",first.id,{title:"Fix again",prompt:"fix2",dependsOn:[]});await c.startQueue("a",async task=>{seen.push(task.prompt);return{ok:true};});assert.deepEqual(seen,["fix","fix2","test"]);
  });
  await test("dependency validation rejects cross-chat references and cycles",()=>{
    const c=new ControlCenter(path.join(dir,"cycles.json")),a=c.addTask("a",{title:"A",prompt:"a",dependsOn:[]}),b=c.addTask("a",{title:"B",prompt:"b",dependsOn:[a.id]});
    assert.throws(()=>c.editTask("a",a.id,{title:"A",prompt:"a",dependsOn:[b.id]}));assert.throws(()=>c.addTask("b",{title:"C",prompt:"c",dependsOn:[a.id]}));
  });
  await test("pause stops the next task and queue cannot start twice",async()=>{
    const c=new ControlCenter(path.join(dir,"pause.json"));c.addTask("a",{title:"A",prompt:"a",dependsOn:[]});c.addTask("a",{title:"B",prompt:"b",dependsOn:[]});
    let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);let count=0;
    const running=c.startQueue("a",async()=>{count++;entered();await gate;return{ok:true};});await started;
    await assert.rejects(()=>c.startQueue("a",async()=>({ok:true})),/уже/);c.pauseQueue("a");release();await running;assert.equal(count,1);
  });
  await test("diagnostic report is allowlisted and omits supplied secrets and addresses",()=>{
    const checks=diagnosticChecks({enabled:true,listening:true,connected:false,tunnel:{url:"https://SECRET-TOKEN.example.test"},error:"PASSWORD"},{listening:false,waiting:false,queued:1,activeChatId:"PRIVATE-ID"},"C:\\private\\data");
    const report=diagnosticReport(checks,{channel:"beta",sessions:2,busy:1,queued:1});for(const secret of ["SECRET-TOKEN","PASSWORD","PRIVATE-ID","private\\data"])assert(!report.includes(secret));assert.equal(JSON.parse(report).channel,"beta");
  });
  await test("signature policy rejects missing or mismatched publishers",()=>{
    const unsigned={status:"NotSigned",subject:""},good={status:"Valid",subject:"CN=Publisher"};
    assert(!signaturePermitted({requireSignature:true,publisher:""},unsigned,unsigned));assert(signaturePermitted({requireSignature:true,publisher:"CN=Publisher"},unsigned,good));
    assert(!signaturePermitted({requireSignature:false,publisher:""},good,{status:"Valid",subject:"CN=Other"}));
    assert(!signaturePermitted({requireSignature:false,publisher:"CN=Publisher"},unsigned,{status:"HashMismatch",subject:"CN=Publisher"}));
  });
  await test("health check requires sustained successful startup and resets on failure",async()=>{
    let time=0,calls=0;
    assert(await waitForHealthyUpdate(async()=>++calls!==2,{timeoutMs:100,stableMs:30,intervalMs:10,now:()=>time,sleep:async ms=>{time+=ms;}}));assert(time>=50);
    time=0;assert(!await waitForHealthyUpdate(async()=>false,{timeoutMs:40,stableMs:10,intervalMs:10,now:()=>time,sleep:async ms=>{time+=ms;}}));
  });
  await test("semver stable is newer than prerelease",()=>{assert(cmpVersion("4.1.0","4.1.0-beta.1")>0);assert(cmpVersion("4.2.0-beta.1","4.1.0")>0);});
  console.log(`\n${passed} control-center test groups passed`);
} finally {fs.rmSync(dir,{recursive:true,force:true});}
