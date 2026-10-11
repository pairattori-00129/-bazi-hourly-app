import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';
const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization,content-type','Access-Control-Allow-Methods':'GET,POST,OPTIONS'};
function reply(body:unknown,status=200){return new Response(JSON.stringify(body),{status,headers:{...cors,'content-type':'application/json','cache-control':'no-store'}})}
const configFields=['browser_key','map_id','store_name','store_address','store_lat','store_lng','zoom','notes'];
function safeView(row:any){return {ok:true,config:row?.config||{},updated_at:row?.updated_at||null}}
Deno.serve(async(req:Request)=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers:cors});
 if(!['GET','POST'].includes(req.method))return reply({ok:false,error:'method_not_allowed'},405);
 try{
  const token=req.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/i)?.[1];
  if(!token)return reply({ok:false,error:'unauthorized'},401);
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))),v=>v.toString(16).padStart(2,'0')).join('');
  const {data:session,error:sessionError}=await db.from('admin_sessions').select('id').eq('token_hash',hash).gt('expires_at',new Date().toISOString()).maybeSingle();
  if(sessionError)throw new Error('session_database_error');
  if(!session)return reply({ok:false,error:'unauthorized'},401);
  const {data:current,error:readError}=await db.from('google_maps_settings').select('config,updated_at').eq('id',1).maybeSingle();
  if(readError)throw new Error('settings_database_error');
  if(req.method==='GET')return reply(safeView(current));
  const raw=await req.text();if(raw.length>20000)return reply({ok:false,error:'payload_too_large'},413);
  let body:any;try{body=JSON.parse(raw)}catch{return reply({ok:false,error:'invalid_json'},400)}
  if(!body||typeof body.config!=='object'||!body.config||Array.isArray(body.config))return reply({ok:false,error:'invalid_settings'},400);
  const config:Record<string,string>={};
  for(const key of configFields){const value=body.config[key]??'';if(typeof value!=='string'||value.length>(key==='notes'?2000:key==='store_address'?1000:key.endsWith('_url')?1000:key==='client_id'?500:200))return reply({ok:false,error:'invalid_'+key},400);config[key]=value.trim()}
  for(const [key,max] of [['store_lat',90],['store_lng',180]] as const){if(config[key]&&(!Number.isFinite(Number(config[key]))||Math.abs(Number(config[key]))>max))return reply({ok:false,error:'invalid_'+key},400)}
  if(config.zoom&&(!Number.isInteger(Number(config.zoom))||Number(config.zoom)<1||Number(config.zoom)>20))return reply({ok:false,error:'invalid_zoom'},400);
  if(config.browser_key&&!/^AIza[\w-]{35}$/.test(config.browser_key))return reply({ok:false,error:'invalid_browser_key'},400);
  const row={id:1,config,updated_at:new Date().toISOString()};
  const {error}=await db.from('google_maps_settings').upsert(row,{onConflict:'id'});if(error)throw new Error('settings_write_error');
  return reply(safeView(row));
 }catch{return reply({ok:false,error:'settings_server_error'},500)}
});
