// Explicit Windows UI QA; runs only against an isolated temporary data folder.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser } from "playwright-core";
const home=process.env.JARVIS_CODE_HOME;
if(!home||!path.resolve(home).startsWith(path.resolve(os.tmpdir())+path.sep))throw new Error("Set JARVIS_CODE_HOME to an isolated temporary directory before running this test");
fs.mkdirSync(home,{recursive:true});
const {startServer}=await import("../src/server");
const {defaultConfig}=await import("../src/config");
const cfg=defaultConfig();cfg.bridge.enabled=false;cfg.update.repo="";cfg.update.manifestUrl="";
const project=path.join(home,"project");fs.mkdirSync(project,{recursive:true});
const app=startServer({cfg,mode:"app",port:0,initialProject:project});
const api=async(route:string,body?:unknown)=>{const r=await fetch(app.url+"api/"+route,{method:body===undefined?"GET":"POST",headers:{"x-nc-token":app.token,"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});return{status:r.status,data:await r.json() as any};};
let browser:Browser|undefined;let checks=0;
const pass=(name:string)=>{checks++;console.log("PASS UI: "+name);};
try{
  const created=await api("chats",{title:"Проверка доступа UI",project,mode:"ask"});assert.equal(created.status,200);const id=created.data.id;assert(id);
  browser=await chromium.launch({channel:"msedge",headless:true});
  const page=await browser.newPage({viewport:{width:1280,height:940}});const browserErrors:string[]=[];page.on("pageerror",e=>browserErrors.push(e.message));
  await page.goto(app.url+"#t="+app.token+"&chat="+id);await page.getByRole("button",{name:"Центр управления",exact:true}).click();
  await page.getByRole("button",{name:"Настроить доступ",exact:true}).waitFor();pass("overview is the default and exposes access settings");
  await page.getByRole("button",{name:"Настроить доступ",exact:true}).click();
  await page.getByRole("radio",{name:/Полный доступ к ПК/}).check();const grant=page.getByRole("button",{name:"Применить полный доступ",exact:true});assert(await grant.isDisabled());pass("full access cannot be enabled without explicit consent");
  await page.getByRole("checkbox",{name:/Разрешаю обычные команды/}).check();await grant.click();await page.getByText("Доступ применён.",{exact:true}).waitFor();
  let view=(await api("control/"+id)).data;assert.equal(view.policy.profile,"full");assert.equal(view.access.mode,"full");pass("applying access updates project and chat together through real API");
  const output=process.env.JC_ACCESS_QA_OUTPUT||home;fs.mkdirSync(output,{recursive:true});await page.screenshot({path:path.join(output,"access-ui-desktop.png")});
  await page.getByRole("radio",{name:/С подтверждениями/}).check();await page.waitForTimeout(2400);assert(await page.getByRole("radio",{name:/С подтверждениями/}).isChecked());pass("polling does not overwrite unsaved access selection");
  await page.getByRole("button",{name:"Применить доступ",exact:true}).click();await page.getByText("Доступ применён.",{exact:true}).waitFor();view=(await api("control/"+id)).data;assert.equal(view.policy.profile,"confirm");assert.equal(view.access.mode,"ask");pass("safer selection revokes full project access and switches chat to ask");
  await api("settings",{fileScope:"project"});await page.getByText(/В общих настройках включено/).waitFor();pass("global file scope restriction is visible and not silently disabled");
  await page.setViewportSize({width:390,height:844});await page.getByRole("radio",{name:/Полный доступ к ПК/}).check();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(output,"access-ui-mobile.png")});pass("mobile layout has no horizontal overflow");
  assert.deepEqual(browserErrors,[]);pass("no browser runtime errors");
  console.log(`ACCESS_UI_SUCCESS: ${checks} checks passed`);
}finally{await browser?.close();app.stop();}
process.exit(0);
