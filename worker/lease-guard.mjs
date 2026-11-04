// The database lease lasts 90 seconds. Stop locally 15 seconds earlier to
// leave room for network delay and avoid submitting a scene with stale rights.
const SAFE_LEASE_MS=75000;

export function leaseRevoked(error){
  return /WORKER_LEASE_LOST|invalid.*worker.*lease/i.test(String(error?.message||''));
}

export class LeaseGuard{
  #safeUntil=0;
  confirm(requestStartedAt,now=Date.now()){
    const safeUntil=requestStartedAt+SAFE_LEASE_MS;
    if(now>=safeUntil)return false;
    this.#safeUntil=Math.max(this.#safeUntil,safeUntil);
    return true;
  }
  current(now=Date.now()){return now<this.#safeUntil;}
  mustStop(error,now=Date.now()){return leaseRevoked(error)||!this.current(now);}
}
