import { harness } from "./harness";
import { worktrees } from "./worktrees";
import type { ChatStore, ChatItem } from "./chats";
import type { Engine } from "./engine";
import type { Bridge } from "./bridge";
import type { RelayHub } from "./relay-hub";
import { controls, projectKey } from "./control-center";
import { diagnosticChecks, diagnosticReport } from "./diagnostics";
import { rollbackFiles, snapshotFile } from "./textfile";
import { sessionJobsSafe } from "./tools";
import { STORE_PROBLEM } from "./paths";

export async function controlApi(req: Request, context: { store: ChatStore; engine: Engine; bridge: Bridge; inbox: RelayHub; onUpdatePolicy?: () => void }): Promise<Response | null> {
  const url = new URL(req.url), match = url.pathname.match(/^\/api\/control\/([a-z0-9]+)(?:\/([a-z-]+))?$/);
  if (!match) return null;
  const [,id,action] = match;
  const { store,engine,bridge,inbox } = context;
  const chat = store.get(id);
  if (!chat || chat.bridge) return Response.json({error:"Откройте обычный локальный чат"},{status:404});
  try {
    const checks = () => diagnosticChecks(bridge.state(),inbox.forChat(id).state(),STORE_PROBLEM);
    const view = () => ({ access: { mode: chat.mode }, harness:harness.view(id,chat.project), worktree:worktrees.get(id), ...controls.snapshot(id,chat.project), checks: checks(), session: inbox.forChat(id).state(), changes: chat.items.filter(i=>i.kind==="tool" && (i.undo || i.tool==="nc_run" || i.tool==="nc_job_start" || i.tool==="nc_trash")).slice(-300).map(i=>({id:i.id,taskId:i.taskId,tool:i.tool,summary:i.summary,status:i.status,undo:!!i.undo,undone:!!i.undone,diff:i.diff || []})) });
    if (!action && req.method === "GET") return Response.json(view());
    if (req.method !== "POST") return Response.json({error:"Method not allowed"},{status:405});
    const b = await req.json() as any;
    const idle=()=>{if(engine.isBusy(id)||bridge.state().running)throw new Error("Остановите задачи перед изменением настроек/копии");};
    if(action === "criteria") {idle();harness.setCriteria(id,b.criteria);}
    else if(action === "transfer") {idle();if(Object.keys(engine.busyChats()).length)throw new Error("Остановите задачи во всех чатах перед сменой правил передачи");harness.setPolicy(chat.project,b.policy);}
    else if(action === "verify") {harness.verify(id,String(b.runId),String(b.criterionId),b.passed,String(b.note||""));}
    else if(action === "replay") {return Response.json({replay:harness.replay(id,String(b.runId))});}
    else if(action === "context-preview") {return Response.json({context:engine.composeRelay(chat,String(b.draft||"").slice(0,20000),[],{iteration:0,maxIterations:20},true),note:"Предпросмотр нового контекста, без отправки. Текущий агент может уже иметь более раннюю историю. Ограничение истории не ограничивает отдельно память, системные сведения и вложения."});}
    else if(action === "worktree-create") {
      idle();const tree=worktrees.create(id,chat.project);
      controls.setPolicy(tree.target,{profile:"confirm",roots:[tree.target],commands:[]});
      controls.setMemory(tree.target,controls.memory(chat.project));harness.setPolicy(tree.target,harness.policy(chat.project));
      engine.setProject(id,tree.target);inbox.revoke(id);chat.relaySessionId=undefined;store.save(chat,true);
    } else if(action === "worktree-diff") {return Response.json({worktreeDiff:worktrees.diff(id)});}
    else if(action === "worktree-apply"||action === "worktree-remove") {
      idle();if(Object.keys(engine.busyChats()).length)throw new Error("Остановите задачи во всех чатах перед применением/удалением копии");
      if(b.confirm!==true)throw new Error("Требуется явное подтверждение");
      if(action === "worktree-apply")worktrees.apply(id);else{const removed=worktrees.remove(id);engine.setProject(id,removed.source);inbox.revoke(id);chat.relaySessionId=undefined;store.save(chat,true);}
    } else if (action === "policy") {
      if(bridge.state().running || Object.keys(engine.busyChats()).some(other => { const c=store.get(other);return !!c && projectKey(c.project)===projectKey(chat.project); })) throw new Error("Остановите задачи в чатах этого проекта перед сменой прав");
      const switchingFull=b.policy?.profile==="full" && (controls.policy(chat.project).profile!=="full" || chat.mode!=="full");
      if(switchingFull && b.confirmFullAccess!==true) throw new Error("Подтвердите полный доступ: обычные команды и файловые изменения на ПК будут выполняться без отдельных запросов");
      controls.setPolicy(chat.project,b.policy);
      // Apply both permission layers only after an explicit local UI request, never on startup.
      engine.setMode(id,b.policy.profile==="readonly"?"plan":b.policy.profile==="confirm"?"ask":"full");
    } else if (action === "memory") controls.setMemory(chat.project,b.memory);
    else if (action === "task-add") controls.addTask(id,{title:b.title,prompt:b.prompt,dependsOn:b.dependsOn || []});
    else if (action === "task-edit") controls.editTask(id,String(b.id),{title:b.title,prompt:b.prompt,dependsOn:b.dependsOn || []});
    else if (action === "task-remove") controls.removeTask(id,String(b.id));
    else if (action === "queue-pause") controls.pauseQueue(id);
    else if (action === "stop") { controls.pauseQueue(id); engine.stop(id); }
    else if (action === "queue-start") {
      if(engine.isBusy(id)) throw new Error("В чате уже выполняется задача");
      if(!inbox.forChat(id).alive()) throw new Error("Сначала запустите слушатель именно этого чата");
      void controls.startQueue(id,async task=>{
        if(engine.isBusy(id)) throw new Error("Чат занят другим запросом");
        const at=Date.now(); await engine.send(id,task.prompt);
        const run=controls.last(id);
        return {ok:!!run && run.startedAt>=at && run.status==="done" && sessionJobsSafe(id,at),runId:run?.id};
      }).catch(()=>{});
    } else if (action === "accept") {
      const items = Array.isArray(b.items) ? b.items.map(String) : [];
      if(items.some((itemId:string)=>!chat.items.some(i=>i.id===itemId && i.undo))) throw new Error("Правка не найдена");
      controls.accept(id,String(b.runId),items);
    } else if (action === "revert") {
      if(engine.isBusy(id)) throw new Error("Остановите задачу перед откатом");
      const run=controls.run(String(b.runId)); if(!run || run.chatId!==id) throw new Error("Задача не найдена");
      const items=chat.items.filter(i=>i.taskId===run.id && i.undo && i.status==="ok");
      const filtered=typeof b.itemId==="string" ? items.filter(i=>i.id===b.itemId) : items;
      if(!filtered.length) throw new Error("Нет резервных копий для отката");
      const groups=new Map<string,ChatItem[]>();
      for(const item of filtered){const file=snapshotFile(item.undo!);if(!file) throw new Error("Резервная копия не найдена");const list=groups.get(file)||[];list.push(item);groups.set(file,list);}
      const plan=[...groups.values()].filter(list=>list.some(i=>!i.undone)).map(list=>({first:list[0].undo!,last:[...list].reverse().find(i=>!i.undone)?.undo,items:list}));
      const result=rollbackFiles(plan,false);
      if(result.ok && !result.missing) for(const group of plan) for(const item of group.items) engine.patch(chat,item,{undone:true});
      return Response.json({...result,view:view()}, {status:result.ok?200:409});
    } else if (action === "diagnose") { bridge.checkNow(); return Response.json({checks:checks()}); }
    else if (action === "report") {
      const sessions=inbox.sessions();
      return Response.json({report:diagnosticReport(checks(),{channel:controls.updatePolicy().channel,sessions:sessions.length,busy:Object.keys(engine.busyChats()).length,queued:sessions.reduce((a,s)=>a+s.state.queued,0)})});
    } else if(action === "updates") { controls.setUpdatePolicy(b.update); context.onUpdatePolicy?.(); }
    else if(action === "session-reset") {
      if(engine.isBusy(id)) throw new Error("Остановите задачу перед сбросом сессии");
      inbox.revoke(id); chat.relaySessionId=undefined; store.save(chat,true);
    } else return Response.json({error:"Unknown action"},{status:404});
    return Response.json(view());
  } catch(e) {return Response.json({error:(e as Error).message},{status:400});}
}
