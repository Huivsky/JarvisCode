// Windows-safe validation suite. Desktop/ngrok fixtures are Linux-specific and are explicitly omitted.
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
const testHome=fs.mkdtempSync(path.join(os.tmpdir(),"jarvis-windows-suite-"));
if(process.platform!=="win32")throw new Error("Use this runner on Windows; on other platforms run the individual suites or bun run test.");
console.log("Windows validation: desktop.ts and ngrok.ts are NOT included (their fixtures assume Linux). This is not a full native installer test.");
for(const name of ["harness","control-center","session-integration","smoke","context","security","files","commands","update","regression"]){
  console.log(`\n=== ${name} ===`);
  const result=spawnSync(process.execPath,[path.join(import.meta.dir,name+".ts")],{stdio:"inherit",env:{...process.env,JARVIS_CODE_HOME:path.join(testHome,name)},windowsHide:true,timeout:180000});
  if(result.error||result.status!==0){console.error(result.error?.message||`Failed: ${name} (${result.status})`);process.exit(1);}
}
console.log("Windows validation suite passed; skipped suites were listed above.");
