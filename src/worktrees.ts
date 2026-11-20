import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { DATA_DIR } from "./paths";
import { canonical, within } from "./control-center";
import { redactTransfer } from "./transfer-gate";
export interface Worktree {chatId:string;source:string;target:string;branch:string;base:string;createdAt:number;removed?:boolean;}
export class Worktrees {
  private rows:Worktree[]=[];
  private root:string;
  constructor(private file=path.join(DATA_DIR,"worktrees.json"),root=path.join(os.homedir(),".jarvis-code-worktrees")){
    this.root=path.resolve(root);
    if(fs.existsSync(file)){const v=JSON.parse(fs.readFileSync(file,"utf8"));if(v.schema!==1||!Array.isArray(v.rows))throw new Error("Повреждён реестр worktree");this.rows=v.rows;}
  }
  private save(){fs.mkdirSync(path.dirname(this.file),{recursive:true});if(fs.existsSync(this.file))fs.copyFileSync(this.file,this.file+".bak");fs.writeFileSync(this.file+".tmp",JSON.stringify({schema:1,rows:this.rows}),{mode:0o600});fs.renameSync(this.file+".tmp",this.file);}
  private git(cwd:string,args:string[]){
    const env={...process.env,GIT_TERMINAL_PROMPT:"0",GIT_OPTIONAL_LOCKS:"0"};for(const key of Object.keys(env))if(/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|EXTERNAL_DIFF|CONFIG_COUNT|CONFIG_PARAMETERS|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/.test(key))delete (env as Record<string,string|undefined>)[key];
    const hooks=path.join(DATA_DIR,"disabled-git-hooks");fs.mkdirSync(hooks,{recursive:true});
    const r=spawnSync("git",["-c",`core.hooksPath=${hooks}`,"-c","core.fsmonitor=false","-c","diff.external=",...args],{cwd,env,encoding:"utf8",windowsHide:true,timeout:20000,maxBuffer:8*1024*1024});
    if(r.error||r.status!==0)throw new Error(redactTransfer(String(r.error?.message||r.stderr||"Git завершился с ошибкой")).slice(0,1000));return r.stdout.trim();
  }
  get(chatId:string){const row=this.rows.findLast(r=>r.chatId===chatId&&!r.removed);return row?structuredClone(row):null;}
  private checked(chatId:string){
    const r=this.rows.findLast(r=>r.chatId===chatId&&!r.removed);if(!r)throw new Error("У этого чата нет управляемой рабочей копии");
    if(!within(this.root,r.target)||canonical(this.git(r.target,["rev-parse","--show-toplevel"]))!==canonical(r.target)||canonical(this.git(r.source,["rev-parse","--show-toplevel"]))!==canonical(r.source))throw new Error("Рабочая копия перемещена или не принадлежит этому реестру");
    if(this.git(r.target,["branch","--show-current"])!==r.branch)throw new Error("В рабочей копии переключена ветка — верните исходную ветку перед операцией");return r;
  }
  create(chatId:string,project:string){
    if(this.get(chatId))throw new Error("У чата уже есть рабочая копия");
    const source=this.git(project,["rev-parse","--show-toplevel"]);
    if(canonical(source)!==canonical(project))throw new Error("Выберите корень Git-репозитория как папку чата");
    if(this.git(source,["status","--porcelain","--untracked-files=all"]))throw new Error("Сначала самостоятельно сохраните/закоммитьте изменения основной папки. Автоматический stash не выполняется.");
    const base=this.git(source,["rev-parse","HEAD"]),suffix=crypto.randomBytes(8).toString("hex"),branch=`jarvis/task-${suffix}`,target=path.join(this.root,suffix);
    fs.mkdirSync(this.root,{recursive:true});this.git(source,["worktree","add","-b",branch,target,base]);
    const row:Worktree={chatId,source:path.resolve(source),target,branch,base,createdAt:Date.now()};this.rows.push(row);
    try{this.save();}catch(e){this.rows.pop();throw new Error("Worktree создана, но реестр не сохранён. Копия и ветка оставлены; удалите их вручную через git worktree. "+(e as Error).message);}
    return structuredClone(row);
  }
  inspect(chatId:string){const r=this.checked(chatId);const raw=this.git(r.target,["diff","--no-ext-diff","--no-textconv","--stat",r.base]);return {...structuredClone(r),dirty:!!this.git(r.target,["status","--porcelain","--untracked-files=all"]),head:this.git(r.target,["rev-parse","HEAD"]),summary:redactTransfer(raw).slice(0,16000)};}
  diff(chatId:string){const r=this.checked(chatId);const diff=this.git(r.target,["diff","--no-ext-diff","--no-textconv",r.base,"--"]);const untracked=this.git(r.target,["ls-files","--others","--exclude-standard"]);return {diff:redactTransfer(diff).slice(0,200000),truncated:diff.length>200000,untracked:redactTransfer(untracked).slice(0,10000),note:"Diff включает отслеживаемые файлы и коммиты. Новые неотслеживаемые файлы перечислены отдельно; их содержимое не прочитано."};}
  apply(chatId:string){
    const r=this.checked(chatId);
    if(this.git(r.source,["status","--porcelain","--untracked-files=all"]))throw new Error("Основная папка содержит несохранённые изменения — применение отменено");
    if(this.git(r.source,["rev-parse","HEAD"])!==r.base)throw new Error("Основная ветка изменилась с момента создания/применения копии. Автоматический rebase/merge запрещён.");
    if(this.git(r.target,["status","--porcelain","--untracked-files=all"]))throw new Error("Сначала проверьте и закоммитьте изменения в рабочей копии. Автоматическое добавление файлов и commit не выполняются.");
    const head=this.git(r.target,["rev-parse","HEAD"]);if(head===r.base)throw new Error("Нет новых коммитов для применения");
    this.git(r.source,["merge","--ff-only","--no-edit","--no-stat",r.branch]);r.base=head;this.save();return structuredClone(r);
  }
  remove(chatId:string){const r=this.checked(chatId);if(this.git(r.target,["status","--porcelain","--untracked-files=all"]))throw new Error("В копии есть незакоммиченные файлы. Удаление без --force отменено.");this.git(r.source,["worktree","remove",r.target]);r.removed=true;this.save();return {source:r.source,branch:r.branch,note:"Копия удалена, ветка с коммитами сохранена."};}
}
export const worktrees=new Worktrees();
