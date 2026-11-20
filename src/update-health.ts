/** Require several seconds of consecutive healthy startup checks, not just successful spawn(). */
export async function waitForHealthyUpdate(probe: () => Promise<boolean>, options: { timeoutMs?: number; stableMs?: number; intervalMs?: number; now?: () => number; sleep?: (ms:number)=>Promise<void> } = {}): Promise<boolean> {
  const now=options.now || Date.now, sleep=options.sleep || ((ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms)));
  const deadline=now()+(options.timeoutMs??25000); let healthyAt: number|undefined;
  while(now()<deadline){
    let ok=false;try{ok=await probe();}catch{}
    if(ok){healthyAt??=now();if(now()-healthyAt>=(options.stableMs??3500))return true;}else healthyAt=undefined;
    await sleep(options.intervalMs??500);
  }
  return false;
}
export function signaturePermitted(policy: { requireSignature:boolean;publisher:string }, current:{status:string;subject:string}, next:{status:string;subject:string}): boolean {
  if((policy.requireSignature||policy.publisher||current.status==="Valid")&&next.status!=="Valid")return false;
  if(policy.publisher&&next.subject!==policy.publisher)return false;
  return current.status!=="Valid"||next.subject===current.subject;
}
