import {createHash,randomBytes,randomUUID} from 'node:crypto';
import path from 'node:path';
import {createClient} from '@supabase/supabase-js';
import {encryptedSessionStorage} from './runtime-state.mjs';
import {publishableKey,supabaseUrl} from './config.js';

const key='muse-worker-control-device-v1';
const validDevice=value=>value && /^[a-f0-9-]{36}$/.test(value.id) && /^[a-f0-9]{64}$/.test(value.secret);
export function controlStorage(directory){return encryptedSessionStorage(path.join(directory,'control'));}
export async function getControlDevice(storage,{create=false}={}){
  const saved=await storage.getItem(key);
  if(saved){const device=JSON.parse(saved);if(!validDevice(device))throw Error('Dữ liệu kết nối máy không hợp lệ.');return device;}
  if(!create)return null;
  const device={id:randomUUID(),secret:randomBytes(32).toString('hex')};
  await storage.setItem(key,JSON.stringify(device));
  return device;
}
export async function enrollControlDevice(client,directory){
  const device=await getControlDevice(controlStorage(directory),{create:true});
  const hash=createHash('sha256').update(device.secret).digest('hex');
  const result=await client.rpc('muse_control_enroll',{p_device_id:device.id,p_secret_hash:hash});
  if(result.error)throw result.error;
}
export function createControlClient(){
  return createClient(supabaseUrl,publishableKey,{
    auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},
    global:{fetch:(url,options={})=>fetch(url,{...options,signal:AbortSignal.timeout(8000)})}
  });
}
export function createControlPoller({client,storage,readState,wake,intervalMs=10000}){
  let busy=false,closed=false,timer=null,lastRequest=null;
  async function poll(){
    if(busy||closed)return;
    busy=true;
    try{
      const device=await getControlDevice(storage);
      if(!device)return;
      const credentials={p_device_id:device.id,p_secret:device.secret};
      const response=await client.rpc('muse_control_poll',{...credentials,p_state:await readState()});
      if(response.error)throw response.error;
      const request=response.data?.request_id;
      if(request){
        if(request!==lastRequest){lastRequest=request;wake();}
        await client.rpc('muse_control_ack',{...credentials,p_request_id:request});
      }
    }catch{/* Local startup continues safely even when the control channel is offline. */}
    finally{busy=false;}
  }
  return {
    start(){if(timer||closed)return;void poll();timer=setInterval(()=>void poll(),intervalMs);timer.unref?.();},
    stop(){closed=true;if(timer)clearInterval(timer);},
    poll
  };
}
