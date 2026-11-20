import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "./paths";
import { projectKey, within } from "./control-center";
import { defaultTransfer, validateTransfer, redactTransfer, excludedPath, type TransferPolicy } from "./transfer-gate";
import { VERSION } from "./version";

export type CriterionKind = "manual" | "command" | "artifact";
export interface Criterion { id:string; title:string; kind:CriterionKind; value:string; }
export interface Proof { criterion:Criterion; state:"pending"|"passed"|"failed"; detail:string; event?:number; hash?:string; }
export interface TraceEvent { seq:number; at:number; type:string; tool?:string; status?:string; requestHash?:string; resultHash?:string; bytes?:number; ms?:number; body?:string; }
export interface RunProof { id:string; chatId:string; project:string; startedAt:number; endedAt?:number; version:string; source:"notion-relay"; model:"selected-in-notion"; mode:string; effort:string; verdict:"unconfigured"|"pending"|"passed"|"failed"; checks:Proof[]; events:TraceEvent[]; captureBodies:boolean; capped:boolean; context?:{hash:string;chars:number}; }
interface HarnessState {schema:1;criteria:Record<string,Criterion[]>;policies:Record<string,TransferPolicy>;runs:RunProof[];}
export const digest=(s:string|Buffer)=>crypto.createHash("sha256").update(s).digest("hex");
const makeId=()=>crypto.randomBytes(8).toString("hex");
export class Harness {
  private data:HarnessState={schema:1,criteria:{},policies:{},runs:[]};
  warning="";
  constructor(private file=path.join(DATA_DIR,"harness.json")){
    if(fs.existsSync(file)){
      const v=JSON.parse(fs.readFileSync(file,"utf8"));
      if(v.schema!==1||!v.criteria||!v.policies||!Array.isArray(v.runs))throw new Error("Повреждён harness.json; восстановите резервную копию. Политики не сброшены.");
      this.data=v;
      for(const p of Object.values(this.data.policies))validateTransfer(p);
      for(const r of this.data.runs)if(!r.endedAt){r.endedAt=Date.now();r.verdict=r.checks.length?"failed":"unconfigured";r.events.push({seq:r.events.length+1,at:Date.now(),type:"interrupted",status:"not-replayed"});}
      this.save();
    }
  }
  private save(){fs.mkdirSync(path.dirname(this.file),{recursive:true});if(fs.existsSync(this.file))fs.copyFileSync(this.file,this.file+".bak");fs.writeFileSync(this.file+".tmp",JSON.stringify(this.data),{mode:0o600});fs.renameSync(this.file+".tmp",this.file);this.warning="";}
  private safeSave(){try{this.save();}catch{this.warning="Журнал не сохранён: проверьте место и доступ к папке данных. Действия не повторяются автоматически.";}}
  policy(project:string):TransferPolicy{return structuredClone(this.data.policies[projectKey(project)]||defaultTransfer());}
  setPolicy(project:string,p:TransferPolicy){this.data.policies[projectKey(project)]=validateTransfer(p);this.save();}
  criteria(chatId:string){return structuredClone(this.data.criteria[chatId]||[]);}
  setCriteria(chatId:string,input:unknown){
    if(!Array.isArray(input)||input.length>20)throw new Error("До 20 критериев на задачу");
    const rows:Criterion[]=input.map((v:any)=>{
      if(!v||typeof v.title!=="string"||!v.title.trim()||v.title.length>200||!["manual","command","artifact"].includes(v.kind)||typeof v.value!=="string"||v.value.length>2000)throw new Error("Некорректный критерий");
      if(v.kind!=="manual"&&!v.value.trim())throw new Error("Для команды/файла нужно значение");
      if(v.kind==="artifact"&&(path.isAbsolute(v.value)||/^[a-z]:|^\\\\/i.test(v.value)||v.value.replace(/\\/g,"/").split("/").includes("..")||/[\x00-\x1f]/.test(v.value)))throw new Error("Артефакт: относительный путь внутри проекта");
      return {id:typeof v.id==="string"&&/^[a-f0-9]{16}$/.test(v.id)?v.id:makeId(),title:v.title.trim(),kind:v.kind,value:v.value.trim()};
    });
    if(new Set(rows.map(r=>r.id)).size!==rows.length)throw new Error("Повторяющиеся критерии");
    this.data.criteria[chatId]=rows;this.save();
  }
  begin(id:string,chatId:string,project:string,mode:string,effort:string){
    if(this.data.runs.some(r=>r.id===id))throw new Error("Задача уже записана");
    this.data.runs=this.data.runs.filter(r=>!r.endedAt).concat(this.data.runs.filter(r=>r.endedAt).slice(-199));
    const r:RunProof={id,chatId,project,startedAt:Date.now(),version:VERSION,source:"notion-relay",model:"selected-in-notion",mode,effort,verdict:"pending",checks:this.criteria(chatId).map(criterion=>({criterion,state:"pending",detail:"Ещё не проверено"})),events:[],captureBodies:this.policy(project).captureBodies,capped:false};
    this.data.runs.push(r);this.event(r,{type:"begin",status:"running"});return structuredClone(r);
  }
  current(chatId:string){return this.data.runs.find(r=>r.chatId===chatId&&!r.endedAt);}
  get(chatId:string,id:string){const r=this.data.runs.find(r=>r.id===id&&r.chatId===chatId);if(!r)throw new Error("Журнал задачи не найден в этом чате");return r;}
  view(chatId:string,project:string){return structuredClone({criteria:this.criteria(chatId),policy:this.policy(project),runs:this.data.runs.filter(r=>r.chatId===chatId).slice(-50).map(({events,...r})=>({...r,eventCount:events.length})),warning:this.warning});}
  private event(r:RunProof,e:Omit<TraceEvent,"seq"|"at">){if(e.body && r.events.reduce((n,v)=>n+(v.body?.length||0),0)+e.body.length>64000){delete e.body;r.capped=true;}if(r.events.length>=1000){r.capped=true;return;}r.events.push({...e,seq:r.events.length+1,at:Date.now()});this.safeSave();}
  context(chatId:string,text:string){const r=this.current(chatId);if(!r)return;r.context={hash:digest(text),chars:text.length};this.event(r,{type:"context",bytes:Buffer.byteLength(text),resultHash:r.context.hash,...(r.captureBodies?{body:redactTransfer(text).slice(0,8000)}:{})});}
  approval(chatId:string,answer:string){const r=this.current(chatId);if(r)this.event(r,{type:"approval",status:answer});}
  tool(chatId:string,tool:string,args:Record<string,unknown>,ok:boolean,text:string,ms?:number){
    const r=this.current(chatId);if(!r)return;
    const requestHash=digest(JSON.stringify({tool,args}));
    const e:Omit<TraceEvent,"seq"|"at">={type:"tool",tool,status:ok?"ok":"error",requestHash,resultHash:digest(text),bytes:Buffer.byteLength(text),ms};
    if(r.captureBodies)e.body=redactTransfer(text).slice(0,8000);
    this.event(r,e);
    // This is evidence of an exact command returning exit 0, not an agent's claim.
    for(const c of r.checks)if(c.criterion.kind==="command"&&tool==="nc_run"&&args.command===c.criterion.value){
      const success=ok&&/exit code:\s*0\b/i.test(text);
      c.state=success?"passed":"failed";c.detail=success?"Точная команда завершилась с кодом 0":"Команда не завершилась с кодом 0";c.event=r.events.length;
    }
    this.safeSave();
  }
  finish(chatId:string,successful:boolean):boolean {
    const r=this.current(chatId);if(!r)return true;
    for(const c of r.checks)if(c.criterion.kind==="artifact"){
      try{
        const file=path.resolve(r.project,c.criterion.value),policy=this.policy(r.project);
        if(!within(r.project,file)||excludedPath(r.project,file,policy))throw new Error("Файл вне проекта или исключён");
        const st=fs.statSync(file);if(!st.isFile()||st.size>64*1024*1024)throw new Error("Нужен обычный файл до 64 МиБ для проверки SHA-256");
        c.hash=digest(fs.readFileSync(file));c.state="passed";c.detail=`Файл существует: ${st.size} байт; SHA-256 рассчитан. Запуск/содержимое этим не проверены.`;
      }catch(e){c.state="failed";c.detail=(e as Error).message.slice(0,200);}
    }
    if(!successful)for(const c of r.checks)if(c.state==="pending"&&c.criterion.kind!=="manual"){c.state="failed";c.detail="Задача не завершилась успешно";}
    r.endedAt=Date.now();this.verdict(r);this.event(r,{type:"end",status:successful?r.verdict:"task-not-done"});
    return !r.checks.length||r.verdict==="passed";
  }
  private verdict(r:RunProof){r.verdict=!r.checks.length?"unconfigured":r.checks.some(c=>c.state==="failed")?"failed":r.checks.every(c=>c.state==="passed")?"passed":"pending";}
  verify(chatId:string,runId:string,criterionId:string,passed:boolean,note:string){
    const r=this.get(chatId,runId);if(!r.endedAt)throw new Error("Дождитесь завершения задачи");
    const c=r.checks.find(c=>c.criterion.id===criterionId&&c.criterion.kind==="manual");if(!c||typeof passed!=="boolean"||typeof note!=="string"||!note.trim()||note.length>1000)throw new Error("Нужен ручной критерий и примечание до 1 000 символов");
    c.state=passed?"passed":"failed";c.detail=redactTransfer(note.trim());this.verdict(r);this.event(r,{type:"user-verification",status:passed?"passed":"failed"});
  }
  replay(chatId:string,runId:string){const r=this.get(chatId,runId);return structuredClone({schema:1,mode:"read-only-replay",executesTools:false,version:r.version,source:r.source,model:r.model,runId:r.id,context:r.context,verdict:r.verdict,checks:r.checks,events:r.events,capped:r.capped,note:"Это просмотр записанных событий. Команды, файлы, сеть и модель не запускаются. Полного детерминированного воспроизведения модели нет."});}
  criteriaPrompt(chatId:string){const rows=this.current(chatId)?.checks.map(c=>c.criterion)||this.criteria(chatId);return rows.length?"User-defined acceptance criteria (do not claim checks you did not perform):\n"+rows.map(c=>`- ${c.title} (${c.kind}${c.value?": "+c.value:""})`).join("\n"):"";}
}
export const harness=new Harness();
