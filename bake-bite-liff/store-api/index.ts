
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const cors = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"content-type,authorization","Access-Control-Allow-Methods":"GET,POST,PUT,DELETE,OPTIONS"};

function json(data:any,status=200){return new Response(JSON.stringify(data),{status,headers:{...cors,"content-type":"application/json; charset=utf-8"}})}
const encoder=new TextEncoder();
function randomHex(bytes:number){return Array.from(crypto.getRandomValues(new Uint8Array(bytes)),v=>v.toString(16).padStart(2,'0')).join('')}
async function sha256(value:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value))),v=>v.toString(16).padStart(2,'0')).join('')}
async function passwordHash(password:string,salt:string){
  const key=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt:encoder.encode(salt),iterations:210000,hash:'SHA-256'},key,256);
  return Array.from(new Uint8Array(bits),v=>v.toString(16).padStart(2,'0')).join('');
}
function sameHash(a:string,b:string){
  if(a.length!==b.length)return false;
  let diff=0;for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);
  return diff===0;
}
async function createAdminSession(){
  const token=randomHex(32);
  const {error}=await supabase.from('admin_sessions').insert({token_hash:await sha256(token),expires_at:new Date(Date.now()+8*60*60*1000).toISOString()});
  if(error)throw error;
  return {token,expires_in:8*60*60};
}
function adminToken(req:Request){return req.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/i)?.[1]||''}
async function okAdmin(req:Request){
  const token=adminToken(req);if(!token)return false;
  const {data,error}=await supabase.from('admin_sessions').select('id')
    .eq('token_hash',await sha256(token)).gt('expires_at',new Date().toISOString()).maybeSingle();
  if(error)throw error;
  return !!data;
}
async function rateLimit(req:Request,success:boolean){
  const ip=req.headers.get('cf-connecting-ip');
  if(!ip)return false;
  const id=await sha256(ip);
  const {data,error}=await supabase.from('admin_login_attempts').select('*').eq('ip_hash',id).maybeSingle();
  if(error)throw error;
  if(success){if(data)await supabase.from('admin_login_attempts').delete().eq('ip_hash',id);return false}
  if(data?.blocked_until&&Date.parse(data.blocked_until)>Date.now())return true;
  const recent=data&&Date.now()-Date.parse(data.updated_at)<15*60*1000;
  const count=recent?data.failed_attempts+1:1;
  const {error:writeError}=await supabase.from('admin_login_attempts').upsert({ip_hash:id,failed_attempts:count,
    blocked_until:count>=8?new Date(Date.now()+15*60*1000).toISOString():null,updated_at:new Date().toISOString()});
  if(writeError)throw writeError;
  return count>=8;
}

class ApiError extends Error {
  constructor(public status:number, public code:string){super(code)}
}

// Never trust a line_user_id supplied in a request body. Verify the LIFF access
// token against the configured LINE Login channel, then ask LINE for the user ID.
async function memberFromLine(req:Request){
  const bearer=req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if(!bearer) return null;
  // The current Bake & Bite LIFF app is 2011741629-yEU5sjz8.
  const channelId=Deno.env.get("LINE_LOGIN_CHANNEL_ID") || "2011741629";
  if(!channelId) throw new ApiError(503,"line_login_not_configured");
  const verifyUrl=new URL("https://api.line.me/oauth2/v2.1/verify");
  verifyUrl.searchParams.set("access_token",bearer);
  const verification=await fetch(verifyUrl);
  if(!verification.ok) throw new ApiError(401,"invalid_line_token");
  const verified=await verification.json();
  if(String(verified.client_id)!==channelId || Number(verified.expires_in)<=0){
    throw new ApiError(401,"wrong_line_channel");
  }
  const response=await fetch("https://api.line.me/v2/profile",{
    headers:{Authorization:`Bearer ${bearer}`}
  });
  if(!response.ok) throw new ApiError(401,"line_profile_unavailable");
  const profile=await response.json();
  if(typeof profile.userId!=="string") throw new ApiError(401,"line_profile_unavailable");

  const {error:insertError}=await supabase.from("members").insert({line_user_id:profile.userId});
  if(insertError && insertError.code!=="23505") throw insertError;
  const update:any={updated_at:new Date().toISOString()};
  if(profile.displayName) update.display_name=profile.displayName;
  if(profile.pictureUrl) update.picture_url=profile.pictureUrl;
  const {data,error}=await supabase.from("members").update(update)
    .eq("line_user_id",profile.userId)
    .select("id,line_user_id,display_name,picture_url,phone,email,points,referral_code").single();
  if(error) throw error;
  return data;
}

function shortText(value:any,max:number){return String(value??"").trim().slice(0,max)}

Deno.serve(async(req)=>{
  if(req.method==="OPTIONS") return new Response("ok",{headers:cors});
  const u=new URL(req.url);
  const action=u.searchParams.get("action")||"catalog";

  try{
    if(action==='admin-login' && req.method==='POST'){
      const p=await req.json();
      const password=typeof p.password==='string'?p.password:'';
      if(!password||password.length>256)return json({ok:false,error:'invalid_credentials'},401);
      const ip=req.headers.get('cf-connecting-ip');
      if(ip){
        const {data:limit,error:le}=await supabase.from('admin_login_attempts').select('blocked_until')
          .eq('ip_hash',await sha256(ip)).maybeSingle();
        if(le)throw le;
        if(limit?.blocked_until&&Date.parse(limit.blocked_until)>Date.now())return json({ok:false,error:'too_many_attempts'},429);
      }
      const {data:credentials,error:ce}=await supabase.from('admin_auth')
        .select('salt,password_hash').eq('id',1).maybeSingle();
      if(ce)throw ce;
      let valid=false;
      if(credentials){valid=sameHash(await passwordHash(password,credentials.salt),credentials.password_hash)}
      else{
        const initial=Deno.env.get('BAKE_BITE_ADMIN_KEY');
        if(!initial)return json({ok:false,error:'admin_login_not_configured'},503);
        valid=sameHash(await sha256(password),await sha256(initial));
        if(valid){
          const salt=randomHex(16);
          const {error:ie}=await supabase.from('admin_auth').insert({id:1,salt,password_hash:await passwordHash(password,salt)});
          if(ie&&ie.code!=='23505')throw ie;
        }
      }
      if(!valid){
        const blocked=await rateLimit(req,false);
        return json({ok:false,error:blocked?'too_many_attempts':'invalid_credentials'},blocked?429:401);
      }
      await rateLimit(req,true);
      return json({ok:true,...await createAdminSession()});
    }
    if(action==='admin-session' && req.method==='GET'){
      return (await okAdmin(req))?json({ok:true}):json({ok:false,error:'unauthorized'},401);
    }
    if(action==='admin-logout' && req.method==='POST'){
      const token=adminToken(req);
      if(token){
        const {error}=await supabase.from('admin_sessions').delete().eq('token_hash',await sha256(token));
        if(error)throw error;
      }
      return json({ok:true});
    }
    if(action==='admin-change-password' && req.method==='POST'){
      if(!await okAdmin(req))return json({ok:false,error:'unauthorized'},401);
      const p=await req.json();
      const current=typeof p.current_password==='string'?p.current_password:'';
      const next=typeof p.new_password==='string'?p.new_password:'';
      if(next.length<12||next.length>128||current===next)return json({ok:false,error:'invalid_new_password'},400);
      const {data:credentials,error:ce}=await supabase.from('admin_auth')
        .select('salt,password_hash').eq('id',1).single();
      if(ce)throw ce;
      if(!sameHash(await passwordHash(current,credentials.salt),credentials.password_hash))
        return json({ok:false,error:'invalid_current_password'},403);
      const salt=randomHex(16);
      const {error:ue}=await supabase.from('admin_auth')
        .update({salt,password_hash:await passwordHash(next,salt),updated_at:new Date().toISOString()}).eq('id',1);
      if(ue)throw ue;
      const {error:de}=await supabase.from('admin_sessions').delete().gte('created_at','1970-01-01T00:00:00Z');
      if(de)throw de;
      return json({ok:true,...await createAdminSession()});
    }
    if(action==="catalog" && req.method==="GET"){
      const {data:cats,error:ce}=await supabase.from("product_categories").select("*").eq("is_active",true).order("sort_order");
      if(ce) throw ce;
      const {data:products,error:pe}=await supabase.from("products").select("*").eq("is_active",true).order("sort_order");
      if(pe) throw pe;
      return json({ok:true,categories:cats,products});
    }

    if(action==="referral-settings" && req.method==="GET"){
      const {data,error}=await supabase.from("referral_point_settings")
        .select("share_points,first_purchase_points").eq("id",1).single();
      if(error) throw error;
      return json({ok:true,settings:data});
    }

    if(action==="me" && req.method==="GET"){
      const member=await memberFromLine(req);
      if(!member) return json({ok:false,error:"line_login_required"},401);
      const {data:addresses,error:ae}=await supabase.from("member_addresses")
        .select("id,label,recipient_name,phone,address_text,latitude,longitude,delivery_note,is_default")
        .eq("member_id",member.id).order("created_at",{ascending:false});
      if(ae) throw ae;
      const {data:orders,error:oe}=await supabase.from("orders")
        .select("id,order_no,total,status,created_at,fulfillment_method,delivery_address,order_items(product_id,product_name,unit_price,quantity)")
        .eq("member_id",member.id).order("created_at",{ascending:false}).limit(20);
      if(oe) throw oe;
      const {data:pointRequests,error:re}=await supabase.from("delivery_orders")
        .select("platform,order_no,purchase_amount,points_calculated,status,submitted_at")
        .eq("member_id",member.id).order("submitted_at",{ascending:false}).limit(10);
      if(re) throw re;
      const {data:referrals,error:rr}=await supabase.from("member_referrals")
        .select("first_purchase_rewarded_at").eq("inviter_id",member.id);
      if(rr) throw rr;
      const {data:referralSettings,error:se}=await supabase.from("referral_point_settings")
        .select("share_points,first_purchase_points").eq("id",1).single();
      if(se) throw se;
      return json({ok:true,member,addresses,orders,point_requests:pointRequests,referral_settings:referralSettings,
        referral_stats:{friends:referrals?.length||0,first_purchases:referrals?.filter(r=>r.first_purchase_rewarded_at).length||0}});
    }

    if(action==="accept-referral" && req.method==="POST"){
      const member=await memberFromLine(req);
      if(!member) return json({ok:false,error:"line_login_required"},401);
      const p=await req.json();
      const code=shortText(p.code,12).toUpperCase();
      if(!/^[A-F0-9]{12}$/.test(code)) return json({ok:false,error:"invalid_code"},400);
      const {data,error}=await supabase.rpc("accept_member_referral",{p_friend_id:member.id,p_code:code});
      if(error) throw error;
      return json({ok:true,status:data});
    }

    if(action==="save-member" && req.method==="POST"){
      const member=await memberFromLine(req);
      if(!member) return json({ok:false,error:"line_login_required"},401);
      const p=await req.json();
      const phone=shortText(p.phone,25),email=shortText(p.email,254);
      if(phone && !/^[0-9+()\s-]{8,25}$/.test(phone)) return json({ok:false,error:"invalid_phone"},400);
      if(email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ok:false,error:"invalid_email"},400);
      const {data,error}=await supabase.from("members").update({phone:phone||null,email:email||null,updated_at:new Date().toISOString()})
        .eq("id",member.id).select("id,display_name,picture_url,phone,email,points").single();
      if(error) throw error;
      return json({ok:true,member:data});
    }

    if(action==="save-address" && req.method==="POST"){
      const member=await memberFromLine(req);
      if(!member) return json({ok:false,error:"line_login_required"},401);
      const p=await req.json();
      const label=["home","work","other"].includes(p.label)?p.label:null;
      const recipientName=shortText(p.recipient_name,100);
      const phone=shortText(p.phone,25);
      const addressText=shortText(p.address_text,500);
      if(!label || !recipientName || !addressText || !/^[0-9+()\s-]{8,25}$/.test(phone)){
        return json({ok:false,error:"invalid_address"},400);
      }
      const latitude=p.latitude==null?null:Number(p.latitude);
      const longitude=p.longitude==null?null:Number(p.longitude);
      if((latitude!==null && (!Number.isFinite(latitude)||Math.abs(latitude)>90)) ||
         (longitude!==null && (!Number.isFinite(longitude)||Math.abs(longitude)>180))){
        return json({ok:false,error:"invalid_coordinates"},400);
      }
      const values={member_id:member.id,label,recipient_name:recipientName,phone,
        address_text:addressText,latitude,longitude,
        delivery_note:shortText(p.delivery_note,500)||null,
        is_default:p.is_default===true,updated_at:new Date().toISOString()};
      if(p.id){
        const {data,error}=await supabase.from("member_addresses").select("id")
          .eq("member_id",member.id).eq("id",p.id).maybeSingle();
        if(error) throw error;
        if(!data) return json({ok:false,error:"address_not_found"},404);
      }
      if(values.is_default){
        const {error}=await supabase.from("member_addresses").update({is_default:false})
          .eq("member_id",member.id).eq("is_default",true);
        if(error) throw error;
      }
      let result;
      if(p.id){
        result=await supabase.from("member_addresses").update(values)
          .eq("member_id",member.id).eq("id",p.id).select().maybeSingle();
      }else{
        result=await supabase.from("member_addresses").insert(values).select().single();
      }
      if(result.error) throw result.error;
      return json({ok:true,address:result.data});
    }

    if(action==="delete-address" && req.method==="POST"){
      const member=await memberFromLine(req);
      if(!member) return json({ok:false,error:"line_login_required"},401);
      const p=await req.json();
      const {error}=await supabase.from("member_addresses").delete()
        .eq("member_id",member.id).eq("id",p.id);
      if(error) throw error;
      return json({ok:true});
    }

    if(action==="request-points" && req.method==="POST"){
      const member=await memberFromLine(req);
      if(!member) return json({ok:false,error:"line_login_required"},401);
      const p=await req.json();
      const platform=["shopeefood","lineman","grabfood"].includes(p.platform)?p.platform:null;
      const orderNo=shortText(p.order_no,80);
      const amount=Number(p.purchase_amount);
      if(!platform||!orderNo||!Number.isFinite(amount)||amount<50||amount>100000){
        return json({ok:false,error:"invalid_point_request"},400);
      }
      const {data,error}=await supabase.from("delivery_orders").insert({
        member_id:member.id,platform,order_no:orderNo,purchase_amount:amount,
        points_calculated:Math.floor(amount/50),status:"pending"
      }).select("id,points_calculated,status").single();
      if(error?.code==="23505") return json({ok:false,error:"order_already_claimed"},409);
      if(error) throw error;
      return json({ok:true,request:data});
    }

    if(action==="order" && req.method==="POST"){
      const member=await memberFromLine(req);
      const p=await req.json();
      const items=Array.isArray(p.items)?p.items:[];
      if(!items.length) return json({ok:false,error:"empty_cart"},400);
      const ids=items.map((x:any)=>x.product_id).filter(Boolean);
      const {data:dbProducts,error:pe}=await supabase.from("products").select("id,name,price,is_active").in("id",ids);
      if(pe) throw pe;
      const map=new Map((dbProducts||[]).filter((x:any)=>x.is_active).map((x:any)=>[x.id,x]));
      const normalized:any[]=[]; let total=0;
      for(const i of items){
        const prod:any=map.get(i.product_id); const qty=Math.min(99,Math.max(1,Math.floor(Number(i.quantity||1))));
        if(!prod) continue;
        const line=Number(prod.price)*qty; total+=line;
        normalized.push({product_id:prod.id,product_name:prod.name,unit_price:Number(prod.price),quantity:qty,line_total:line});
      }
      if(!normalized.length) return json({ok:false,error:"no_valid_items"},400);
      const fulfillment=["pickup","lineman"].includes(p.fulfillment_method)?p.fulfillment_method:"pickup";
      let savedAddress:any=null;
      if(p.member_address_id){
        if(!member) return json({ok:false,error:"line_login_required"},401);
        const {data,error}=await supabase.from("member_addresses").select("*")
          .eq("id",p.member_address_id).eq("member_id",member.id).maybeSingle();
        if(error) throw error;
        if(!data) return json({ok:false,error:"address_not_found"},404);
        savedAddress=data;
      }
      const orderNo="BB"+new Date().toISOString().replace(/\D/g,"").slice(2,14)+crypto.randomUUID().slice(0,4).toUpperCase();
      const {data:order,error:oe}=await supabase.from("orders").insert({
        order_no:orderNo,
        member_id:member?.id??null,
        member_address_id:fulfillment==="lineman"?savedAddress?.id??null:null,
        line_user_id:member?.line_user_id??null,
        customer_name:member?.display_name||shortText(p.customer_name,100)||null,
        subtotal:total,total,status:"pending",payment_status:"pending",
        delivery_status:fulfillment==="lineman"?"waiting_payment":null,
        payment_method:p.payment_method||null,
        note:shortText(p.note,500)||null,fulfillment_method:fulfillment,
        recipient_name:fulfillment==="lineman"?(savedAddress?.recipient_name||shortText(p.recipient_name,100)||null):null,
        recipient_phone:fulfillment==="lineman"?(savedAddress?.phone||shortText(p.recipient_phone,25)||null):null,
        delivery_address:fulfillment==="lineman"?(savedAddress?.address_text||shortText(p.delivery_address,500)||null):null,
        delivery_note:fulfillment==="lineman"?(savedAddress?.delivery_note||shortText(p.delivery_note,500)||null):null,
        delivery_latitude:fulfillment==="lineman"?(savedAddress?.latitude??p.delivery_latitude??null):null,
        delivery_longitude:fulfillment==="lineman"?(savedAddress?.longitude??p.delivery_longitude??null):null
      }).select("id,order_no,total,status,created_at").single();
      if(oe) throw oe;
      const {error:ie}=await supabase.from("order_items").insert(normalized.map(x=>({...x,order_id:order.id})));
      if(ie){
        const {error:cleanupError}=await supabase.from("orders").delete().eq("id",order.id);
        if(cleanupError) console.error("order cleanup:",cleanupError.message);
        throw ie;
      }
      return json({ok:true,order});
    }

    if(action==="admin-list" && req.method==="GET"){
      if(!await okAdmin(req)) return json({ok:false,error:"unauthorized"},401);
      const {data:cats,error:ce}=await supabase.from("product_categories").select("*").order("sort_order"); if(ce) throw ce;
      const {data:products,error:pe}=await supabase.from("products").select("*").order("sort_order"); if(pe) throw pe;
      return json({ok:true,categories:cats,products});
    }

    if(action==="admin-orders" && req.method==="GET"){
      if(!await okAdmin(req)) return json({ok:false,error:"unauthorized"},401);
      const {data,error}=await supabase.from("orders")
        .select("id,order_no,customer_name,total,status,payment_status,payment_method,fulfillment_method,delivery_address,recipient_name,recipient_phone,note,created_at,order_items(product_name,quantity,unit_price)")
        .order("created_at",{ascending:false}).limit(60);
      if(error) throw error;
      return json({ok:true,orders:data});
    }

    if(action==="admin-update-order" && req.method==="POST"){
      if(!await okAdmin(req)) return json({ok:false,error:"unauthorized"},401);
      const p=await req.json();
      if(typeof p.id!=="string"||!/^[a-f0-9-]{36}$/i.test(p.id)) return json({ok:false,error:"invalid_order"},400);
      if(!["pending","confirmed","preparing","ready","completed","cancelled"].includes(p.status)||
         !["pending","paid","refunded"].includes(p.payment_status)) return json({ok:false,error:"invalid_status"},400);
      const {data:existing,error:ee}=await supabase.from("orders")
        .select("id,paid_at").eq("id",p.id).maybeSingle();
      if(ee) throw ee;
      if(!existing) return json({ok:false,error:"order_not_found"},404);
      const {data,error}=await supabase.from("orders")
        .update({status:p.status,payment_status:p.payment_status,
          paid_at:p.payment_status==="paid"?(existing.paid_at||new Date().toISOString()):null,
          updated_at:new Date().toISOString()})
        .eq("id",p.id).select("id,status,payment_status,paid_at").single();
      if(error) throw error;
      return json({ok:true,order:data});
    }

    if(action==="admin-referral-settings" && req.method==="GET"){
      if(!await okAdmin(req)) return json({ok:false,error:"unauthorized"},401);
      const {data,error}=await supabase.from("referral_point_settings")
        .select("share_points,first_purchase_points,updated_at").eq("id",1).single();
      if(error) throw error;
      return json({ok:true,settings:data});
    }

    if(action==="admin-referral-settings" && req.method==="POST"){
      if(!await okAdmin(req)) return json({ok:false,error:"unauthorized"},401);
      const p=await req.json();
      const share=Number(p.share_points),first=Number(p.first_purchase_points);
      if(!Number.isInteger(share)||share<0||share>100||!Number.isInteger(first)||first<0||first>100){
        return json({ok:false,error:"invalid_points"},400);
      }
      const {data,error}=await supabase.from("referral_point_settings")
        .update({share_points:share,first_purchase_points:first,updated_at:new Date().toISOString()})
        .eq("id",1).select("share_points,first_purchase_points,updated_at").single();
      if(error) throw error;
      return json({ok:true,settings:data});
    }

    if(action==="admin-save-product" && (req.method==="POST"||req.method==="PUT")){
      if(!await okAdmin(req)) return json({ok:false,error:"unauthorized"},401);
      const p=await req.json();
      const payload={category_id:p.category_id,name:p.name,description:p.description||null,price:Number(p.price||0),image_url:p.image_url||null,is_active:p.is_active!==false,sort_order:Number(p.sort_order||0),updated_at:new Date().toISOString()};
      if(!payload.category_id||!shortText(payload.name,120)||!Number.isFinite(payload.price)||payload.price<0||payload.price>100000) return json({ok:false,error:"invalid_input"},400);
      let q;
      if(p.id) q=await supabase.from("products").update(payload).eq("id",p.id).select().single();
      else q=await supabase.from("products").insert(payload).select().single();
      if(q.error) throw q.error;
      return json({ok:true,product:q.data});
    }

    if(action==="admin-save-category" && (req.method==="POST"||req.method==="PUT")){
      if(!await okAdmin(req)) return json({ok:false,error:"unauthorized"},401);
      const p=await req.json();
      const payload={name:p.name,slug:p.slug||String(p.name||"").toLowerCase().replace(/\s+/g,"-"),sort_order:Number(p.sort_order||0),is_active:p.is_active!==false};
      let q;
      if(p.id) q=await supabase.from("product_categories").update(payload).eq("id",p.id).select().single();
      else q=await supabase.from("product_categories").insert(payload).select().single();
      if(q.error) throw q.error;
      return json({ok:true,category:q.data});
    }

    return json({ok:false,error:"not_found"},404);
  }catch(e){console.error(e);return json({ok:false,error:e instanceof ApiError?e.code:"server_error"},e instanceof ApiError?e.status:500)}
});
