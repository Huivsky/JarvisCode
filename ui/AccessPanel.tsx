import { useEffect, useState } from "react";
import type { Mode } from "../src/config";
import type { ProjectPolicy } from "../src/control-center";
import { useStore } from "./store";

type Act = (action:string, body:Record<string,unknown>)=>Promise<void>;
export const ACCESS_NAMES: Record<ProjectPolicy["profile"],string> = { readonly:"Только чтение", confirm:"С подтверждениями", trusted:"Свои разрешённые команды", full:"Полный доступ к ПК" };
const MODE_NAMES: Record<Mode,string> = { plan:"Только чтение", ask:"Спрашивать", "auto-edit":"Авто-правки", full:"Полный", autonomous:"Автономный" };
const choices: {key:ProjectPolicy["profile"];title:string;hint:string;tag:string}[] = [
  {key:"readonly",title:"Только чтение",hint:"Агент изучает файлы. Не изменяет их и не запускает команды.",tag:"Без изменений"},
  {key:"confirm",title:"С подтверждениями",hint:"Каждая обычная команда и изменение файла требуют вашего решения.",tag:"Рекомендуется"},
  {key:"full",title:"Полный доступ к ПК",hint:"Обычные команды, создание и изменение файлов — без отдельных вопросов. Не только в папке проекта.",tag:"Для доверенных задач"},
];
export function AccessOverview({policy,mode,open}:{policy:ProjectPolicy;mode:Mode;open:()=>void}) {
  const scope=useStore(s=>s.state?.settings.fileScope);
  const ready=policy.profile==="full"&&mode==="full";
  return <section className="cc-card cc-access-summary"><p className="cc-eyebrow">Доступ агента</p><h3>{ACCESS_NAMES[policy.profile]||"Неизвестные права"}</h3><p>{ready?"Обычные команды и файловые правки выполняются без отдельных запросов.":policy.profile==="readonly"?"Файлы можно читать; запись и команды запрещены.":"Разрешения зависят от режима чата и правил проекта. Настройте их вместе в разделе «Доступ»."}</p><p className="muted small">Режим чата: {MODE_NAMES[mode]||mode}. {scope==="project"?"Глобально включено ограничение «только папка проекта».":"Глобального ограничения папкой проекта нет."}</p><button className="btn primary" onClick={open}>Настроить доступ</button></section>;
}
export function AccessPanel({value,mode,act}:{value:ProjectPolicy;mode:Mode;act:Act}) {
  const scope=useStore(s=>s.state?.settings.fileScope);
  const [profile,setProfile]=useState(value.profile),[roots,setRoots]=useState(value.roots.join("\n")),[commands,setCommands]=useState(value.commands.join("\n"));
  const [consent,setConsent]=useState(false),[dirty,setDirty]=useState(false),[saving,setSaving]=useState(false),[saved,setSaved]=useState(false),[error,setError]=useState("");
  const serverSignature=JSON.stringify(value);
  useEffect(()=>{if(!dirty){setProfile(value.profile);setRoots(value.roots.join("\n"));setCommands(value.commands.join("\n"));}},[serverSignature,dirty]);
  const pick=(next:ProjectPolicy["profile"])=>{setProfile(next);setConsent(false);setDirty(true);setSaved(false);setError("");};
  const needsConsent=profile==="full"&&(value.profile!=="full"||mode!=="full");
  const save=async()=>{if(needsConsent&&!consent)return;setSaving(true);setError("");try{await act("policy",{policy:{profile,roots:roots.split(/\r?\n/).map(s=>s.trim()).filter(Boolean),commands:commands.split(/\r?\n/).map(s=>s.trim()).filter(Boolean)},confirmFullAccess:consent});setDirty(false);setConsent(false);setSaved(true);}catch(e){setError((e as Error).message);}finally{setSaving(false);}};
  return <form className="cc-access" onSubmit={e=>{e.preventDefault();void save();}}>
    <h2>Что агенту можно делать?</h2><p className="muted">Выберите один вариант и примените. Он согласует права проекта и режим текущего чата — больше не нужно искать два разных переключателя.</p>
    <div className="cc-access-current" role="status">Сейчас: <strong>{ACCESS_NAMES[value.profile]}</strong> · режим чата: {MODE_NAMES[mode]||mode}</div>
    <div className="cc-access-options" role="radiogroup" aria-label="Уровень доступа">{choices.map(c=><label key={c.key} className={`cc-access-option ${profile===c.key?"selected":""}`}><span className="cc-access-option-head"><input type="radio" name="cc-access-profile" value={c.key} checked={profile===c.key} onChange={()=>pick(c.key)}/><strong>{c.title}</strong></span><span className="cc-access-tag">{c.tag}</span><span>{c.hint}</span></label>)}</div>
    {profile==="full"&&<div className="cc-access-warning"><strong>Вы доверяете агенту работу с ПК</strong><p>Shell-команды могут устанавливать программы, обращаться к сети и менять файлы. Это не песочница. Права проекта общие для чатов с этой же рабочей папкой; режим «Полный» включится только в текущем чате.</p><p>Защита системных операций, секретов и внутренних данных приложения сохраняется. Подозрительные команды, экран, буфер обмена и удаление вне проекта всё ещё могут требовать согласия. Ограничения передачи данных также продолжают действовать.</p>{needsConsent&&<label className="cc-dep"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/>Разрешаю обычные команды и изменение файлов на ПК без отдельных подтверждений</label>}</div>}
    {scope==="project"&&<p className="cc-access-warning">В общих настройках включено «Только папка проекта». Эта настройка важнее полного доступа и не меняется автоматически. Для работы с другими папками измените её в настройках приложения.</p>}
    <details className="cc-access-advanced"><summary>Дополнительно: папки и точные команды</summary><p className="muted">Для полного доступа список папок не ограничивает инструменты; остальные профили запрашивают подтверждение за его пределами. Секреты и глобальные запреты не разрешаются этим списком.</p>
      <label className="cc-dep"><input type="checkbox" checked={profile==="trusted"} onChange={e=>pick(e.target.checked?"trusted":"confirm")}/>Разрешать автоматически только команды из моего списка</label>
      {profile==="trusted"&&<p>Обычные файловые правки — автоматически в разрешённых папках. Команды вне списка — с подтверждением.</p>}
      <label htmlFor="cc-roots">Разрешённые папки · по одной на строку</label><textarea id="cc-roots" rows={3} value={roots} onChange={e=>{setRoots(e.target.value);setDirty(true);setSaved(false);}}/>
      {profile==="trusted"&&<><label htmlFor="cc-commands">Точные команды · без масок · по одной на строку</label><textarea id="cc-commands" rows={4} value={commands} onChange={e=>{setCommands(e.target.value);setDirty(true);setSaved(false);}} placeholder="git status"/></>}
    </details>
    <p className="muted small">Чтобы применить права, сначала завершите или остановите задачи во всех чатах этого проекта. Уже выполненные операции не отменяются.</p>
    {error&&<p className="field-error" role="alert">{error}</p>}{saved&&<p role="status">Доступ применён.</p>}
    <button className="btn primary" disabled={saving||(needsConsent&&!consent)}>{saving?"Применяем…":profile==="full"?"Применить полный доступ":"Применить доступ"}</button>
  </form>;
}
