import path from "node:path";
import { canonical, within } from "./control-center";

export interface TransferPolicy {
  cloud: boolean;
  images: boolean;
  scanSecrets: boolean;
  excluded: string[];
  pins: string[];
  history: boolean;
  chatMemory: boolean;
  projectMemory: boolean;
  workSummary: boolean;
  historyChars: number;
  captureBodies: boolean;
}
export const defaultTransfer = (): TransferPolicy => ({ cloud:true,images:true,scanSecrets:true,excluded:[".env",".env.*","**/*.pem","**/*.key"],pins:[],history:true,chatMemory:true,projectMemory:true,workSummary:true,historyChars:24000,captureBodies:false });
export function validateTransfer(v: TransferPolicy): TransferPolicy {
  if(!v || ["cloud","images","scanSecrets","history","chatMemory","projectMemory","workSummary","captureBodies"].some(k=>typeof v[k as keyof TransferPolicy]!=="boolean"))throw new Error("Некорректные переключатели контекста");
  if(!Number.isInteger(v.historyChars)||v.historyChars<2000||v.historyChars>64000)throw new Error("Бюджет истории: 2 000–64 000 символов");
  for(const [key,max] of [["excluded",50],["pins",12]] as const){if(!Array.isArray(v[key])||v[key].length>max)throw new Error("Слишком много путей");for(const s of v[key])if(typeof s!=="string"||!s.trim()||s.length>240||path.isAbsolute(s)||/^[a-z]:|^\\\\/i.test(s)||s.replace(/\\/g,"/").split("/").includes("..")||/[\x00-\x1f]/.test(s))throw new Error("Укажите относительные пути внутри проекта, без ..");}
  return {...v,excluded:[...new Set(v.excluded.map(s=>s.trim().replace(/\\/g,"/")))],pins:[...new Set(v.pins.map(s=>s.trim().replace(/\\/g,"/")))]};
}
function glob(pattern:string,rel:string):boolean {
  const make=(s:string)=>s.split("**").map(part=>part.split("*").map(p=>p.replace(/[.+^${}()|[\]\\]/g,"\\$&").replace(/\?/g,"[^/]" )).join("[^/]*")).join(".*");
  const match=(p:string)=>new RegExp("^(?:"+make(p)+")(?:/.*)?$","i").test(rel);
  return match(pattern)||(pattern.startsWith("**/")&&match(pattern.slice(3)))||(!pattern.includes("/")&&rel.split("/").some(p=>matchPart(pattern,p)));
}
function matchPart(pattern:string,part:string){return new RegExp("^"+pattern.split("*").map(p=>p.replace(/[.+?^${}()|[\]\\]/g,"\\$&")).join(".*")+"$","i").test(part);}
export function excludedPath(project:string,file:string,policy:TransferPolicy):boolean {
  if(!within(project,file))return true;
  const rel=path.relative(canonical(project),canonical(file)).replace(/\\/g,"/");
  return /(?:^|\/)\.git(?:\/|$)/i.test(rel)||policy.excluded.some(p=>glob(p,rel));
}
/** Best-effort redaction, NOT a complete DLP classifier. No network calls. */
export function redactTransfer(text:string):string {
  return text
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g,"[PRIVATE KEY REDACTED]")
    .replace(/\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g,"[SECRET REDACTED]")
    .replace(/((?:authorization|proxy-authorization)\s*[:=]\s*)(?:Bearer\s+|Basic\s+)?[^\r\n]+/gi,"$1[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|cookie|set-cookie)\s*["']?\s*[:=]\s*)["']?[^\s\r\n,;"'}]+["']?/gi,"$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi,"$1[REDACTED]@")
    .replace(/(\/mcp\/)[a-f0-9]{32,}/gi,"$1[REDACTED]")
    .replace(/([?&#](?:token|key|secret|t)=)[^\s&#]+/gi,"$1[REDACTED]");
}
export function gateTool(policy:TransferPolicy,project:string,tool:string,paths:string[]):string|null {
  if(!policy.cloud)return "Проект разрешён только локальным моделям. Пересылка через Notion заблокирована.";
  if(!policy.images && ["nc_screenshot","nc_view_image","nc_clipboard"].includes(tool))return "Передача изображений и буфера отключена для проекта.";
  if(paths.some(p=>within(project,p)&&excludedPath(project,p,policy)))return "Путь исключён из контекста проекта; вызов заблокирован до чтения/изменения.";
  return null;
}
