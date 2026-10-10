import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';
const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization,content-type','Access-Control-Allow-Methods':'GET,POST,OPTIONS'};
function reply(body:unknown,status=200){return new Response(JSON.stringify(body),{status,headers:{...cors,'content-type':'application/json','cache-control':'no-store'}})}
const configFields=['store_name','merchant_id','environment','approval','client_id','api_url','token_url','callback_url','docs_url','notes','connection_mode','gateway_name','outlet_id','payment_flow'];
const secretFields=['client_secret','access_token','webhook_secret'];
function safeView(row:any){return {ok:true,config:row?.config||{},secrets_present:Object.fromEntries(secretFields.map(key=>[key,!!row?.credentials?.[key]])),updated_at:row?.updated_at||null,integration_status:'adapter_pending'}}
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
  const platform=new URL(req.url).searchParams.get('platform');
  if(!['truemoney','shopeepay'].includes(platform||''))return reply({ok:false,error:'invalid_platform'},400);
  const {data:current,error:readError}=await db.from('payment_api_settings').select('config,credentials,updated_at').eq('platform',platform).maybeSingle();
  if(readError)throw new Error('settings_database_error');
  if(req.method==='GET')return reply(safeView(current));
  const raw=await req.text();if(raw.length>20000)return reply({ok:false,error:'payload_too_large'},413);
  let body:any;try{body=JSON.parse(raw)}catch{return reply({ok:false,error:'invalid_json'},400)}
  if(!body||typeof body.config!=='object'||!body.config||Array.isArray(body.config)||typeof body.secrets!=='object'||!body.secrets||Array.isArray(body.secrets)||typeof body.clear_secrets!=='boolean')return reply({ok:false,error:'invalid_settings'},400);
  const config:Record<string,string>={};
  for(const key of configFields){const value=body.config[key]??'';if(typeof value!=='string'||value.length>(key==='notes'?2000:key.endsWith('_url')?1000:key==='client_id'?500:200))return reply({ok:false,error:'invalid_'+key},400);config[key]=value.trim()}
  if(!['sandbox','production'].includes(config.environment)||!['not_requested','pending','approved'].includes(config.approval))return reply({ok:false,error:'invalid_settings'},400);
  for(const key of ['api_url','token_url','callback_url','docs_url']){if(!config[key])continue;try{const url=new URL(config[key]);if(url.protocol!=='https:'||url.username||url.password)throw new Error()}catch{return reply({ok:false,error:key+' ต้องเป็น HTTPS และไม่ใส่รหัสผ่านใน URL'},400)}}
  if(!['direct','gateway'].includes(config.connection_mode)||!['merchant_qr','customer_qr','online_checkout'].includes(config.payment_flow))return reply({ok:false,error:'invalid_payment_settings'},400);
  const credentials:Record<string,string>=body.clear_secrets?{}:{...current?.credentials};
  for(const key of secretFields){const value=body.secrets[key];if(value===undefined||value==='')continue;if(typeof value!=='string'||value.length>4096)return reply({ok:false,error:'invalid_secret'},400);credentials[key]=value}
  const row={platform,config,credentials,updated_at:new Date().toISOString()};
  const {error}=await db.from('payment_api_settings').upsert(row,{onConflict:'platform'});if(error)throw new Error('settings_write_error');
  return reply(safeView(row));
 }catch{return reply({ok:false,error:'settings_server_error'},500)}
});
