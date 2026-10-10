
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const cors = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"content-type,authorization","Access-Control-Allow-Methods":"GET,POST,PUT,DELETE,OPTIONS"};

function json(data:any,status=200){return new Response(JSON.stringify(data),{status,headers:{...cors,"content-type":"application/json; charset=utf-8"}})}
async function pushLineOrderConfirmation(to:string,order:any,items:any[],fulfillment:string){
  const token=Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN");
  if(!token||!to)return;
  const lines=items.map((i:any)=>"• "+i.product_name+" × "+i.quantity+" = ฿"+Number(i.line_total).toLocaleString("th-TH")).join("\n");
  const receive=fulfillment==="courier"?"ลูกค้าเรียกไรเดอร์เอง":fulfillment==="lineman"?"จัดส่งด้วย LINE MAN":"รับเองที่ร้าน";
  const text=[
    "Bake & Bite รับคำสั่งซื้อแล้ว 🥗🥪",
    "เลขที่: "+(order.display_order_no||order.order_no),
    "",
    lines,
    "",
    "ยอดรวม: ฿"+Number(order.total).toLocaleString("th-TH"),
    "รับสินค้า: "+receive,
    "",
    "ขอบคุณที่สั่งกับ Bake & Bite"
  ].join("\n");
  try{
    const response=await fetch("https://api.line.me/v2/bot/message/push",{
      method:"POST",
      headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},
      body:JSON.stringify({to,messages:[{type:"text",text}]})
    });
    if(!response.ok){
      const detail=await response.text();
      console.error("LINE order push failed:",response.status,detail);
    }
  }catch(error){
    console.error("LINE order push error:",error);
  }
}

async function pushLinePointsClaim(to:string,order:any){
  const token=Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN");
  if(!token||!to)return false;
  const points=Math.floor(Number(order.total||0)/50);
  if(points<=0)return false;
  const claimText="รับแต้ม "+order.order_no;
  const message={
    type:"text",
    text:"ออเดอร์ "+order.order_no+" ได้ "+points+" แต้ม\nหากต้องการรับคะแนนสะสม กรุณากดปุ่มด้านล่าง",
    quickReply:{
      items:[{
        type:"action",
        action:{
          type:"message",
          label:"⭐ รับคะแนนสะสม",
          text:claimText
        }
      }]
    }
  };
  try{
    const response=await fetch("https://api.line.me/v2/bot/message/push",{
      method:"POST",
      headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},
      body:JSON.stringify({to,messages:[message]})
    });
    if(!response.ok){
      console.error("LINE points quick reply push failed:",response.status,await response.text());
      return false;
    }
    return true;
  }catch(error){
    console.error("LINE points quick reply push error:",error);
    return false;
  }
}

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
async function nextOrderNumber(){
  const {data,error}=await supabase.rpc("next_bake_bite_order_no");
  if(error)throw error;
  if(!data?.order_no||!data?.display_order_no)throw new Error("order_number_failed");
  return data as {order_no:string,display_order_no:string};
}
function bangkokDayBounds(){
  const offset=7*60*60*1000, day=24*60*60*1000;
  const shifted=Date.now()+offset;
  const start=Math.floor(shifted/day)*day-offset;
  return {start:new Date(start).toISOString(),end:new Date(start+day).toISOString()};
}
async function rewardsWithUsage(activeOnly=true){
  let rq=supabase.from("rewards").select("id,name,description,points_required,image_url,stock,daily_limit,is_active,created_at,updated_at").order("points_required").order("created_at");
  if(activeOnly) rq=rq.eq("is_active",true);
  const {data:rewards,error:re}=await rq;if(re)throw re;
  const {start,end}=bangkokDayBounds();
  const {data:redemptions,error:rde}=await supabase.from("reward_redemptions").select("reward_id").eq("status","redeemed").gte("redeemed_at",start).lt("redeemed_at",end);
  if(rde)throw rde;
  const counts=new Map<string,number>();
  for(const row of redemptions||[])counts.set(row.reward_id,(counts.get(row.reward_id)||0)+1);
  return (rewards||[]).map((r:any)=>{
    const used=counts.get(r.id)||0;
    return {...r,used_today:used,remaining_today:r.daily_limit==null?null:Math.max(0,r.daily_limit-used)};
  });
}

const BAKE_BITE_RICHMENU_NAME="BakeBite-Permanent-4";
const BAKE_BITE_LIFF="https://liff.line.me/2011741629-yEU5sjz8/";
async function lineApi(path:string,init:RequestInit={}){
  const channelAccessToken=Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN");
  if(!channelAccessToken)throw new ApiError(503,"line_not_configured");
  const headers=new Headers(init.headers||{});
  headers.set("Authorization","Bearer "+channelAccessToken);
  const response=await fetch("https://api.line.me"+path,{...init,headers});
  return response;
}
async function bakeBiteRichMenuStatus(){
  const info=await lineApi("/v2/bot/info");
  if(!info.ok)throw new ApiError(502,"line_bot_info_failed");
  const bot=await info.json();
  if(bot.basicId!=="@563txfft")throw new ApiError(409,"wrong_line_channel");
  const listResponse=await lineApi("/v2/bot/richmenu/list");
  if(!listResponse.ok)throw new ApiError(502,"richmenu_list_failed");
  const list=await listResponse.json();
  let defaultId:string|null=null;
  const defaultResponse=await lineApi("/v2/bot/user/all/richmenu");
  if(defaultResponse.ok)defaultId=(await defaultResponse.json()).richMenuId||null;
  const menus=(list.richmenus||[]).filter((m:any)=>m.name===BAKE_BITE_RICHMENU_NAME);
  return {bot:{basicId:bot.basicId,displayName:bot.displayName},defaultId,menus,
    permanent:!!defaultId&&menus.some((m:any)=>m.richMenuId===defaultId)};
}

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

    if(action==="admin-richmenu-status" && req.method==="GET"){
      if(!await okAdmin(req))return json({ok:false,error:"unauthorized"},401);
      return json({ok:true,...await bakeBiteRichMenuStatus()});
    }
    if(action==="admin-richmenu-install" && req.method==="POST"){
      if(!await okAdmin(req))return json({ok:false,error:"unauthorized"},401);
      const form=await req.formData();
      const file=form.get("image");
      if(!(file instanceof File)||file.size===0||file.size>1024*1024||!["image/jpeg","image/png"].includes(file.type))
        return json({ok:false,error:"richmenu_image_invalid"},400);
      const status=await bakeBiteRichMenuStatus();
      const menu={
        size:{width:1200,height:810},selected:true,name:BAKE_BITE_RICHMENU_NAME,chatBarText:"เมนู",
        areas:[
          {bounds:{x:0,y:0,width:1200,height:405},action:{type:"uri",label:"สั่งอาหาร",uri:BAKE_BITE_LIFF+"#order"}},
          {bounds:{x:0,y:405,width:400,height:405},action:{type:"uri",label:"สะสมแต้ม",uri:BAKE_BITE_LIFF+"#points"}},
          {bounds:{x:400,y:405,width:400,height:405},action:{type:"uri",label:"แลกแต้ม",uri:BAKE_BITE_LIFF+"#redeem"}},
          {bounds:{x:800,y:405,width:400,height:405},action:{type:"uri",label:"ติดต่อเรา",uri:BAKE_BITE_LIFF+"#contact"}}
        ]
      };
      const create=await lineApi("/v2/bot/richmenu",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(menu)});
      if(!create.ok){console.error("richmenu create",create.status,await create.text());throw new ApiError(502,"richmenu_create_failed")}
      const created=await create.json(); const id=created.richMenuId;
      try{
        const bytes=await file.arrayBuffer();
        const upload=await lineApi("/v2/bot/richmenu/"+encodeURIComponent(id)+"/content",{method:"POST",headers:{"Content-Type":file.type},body:bytes});
        if(!upload.ok){console.error("richmenu upload",upload.status,await upload.text());throw new ApiError(502,"richmenu_upload_failed")}
        const setDefault=await lineApi("/v2/bot/user/all/richmenu/"+encodeURIComponent(id),{method:"POST"});
        if(!setDefault.ok){console.error("richmenu default",setDefault.status,await setDefault.text());throw new ApiError(502,"richmenu_default_failed")}
        for(const old of status.menus||[]){
          if(old.richMenuId&&old.richMenuId!==id){
            const del=await lineApi("/v2/bot/richmenu/"+encodeURIComponent(old.richMenuId),{method:"DELETE"});
            if(!del.ok)console.error("old richmenu delete",old.richMenuId,del.status);
          }
        }
        return json({ok:true,richMenuId:id,permanent:true});
      }catch(error){
        await lineApi("/v2/bot/richmenu/"+encodeURIComponent(id),{method:"DELETE"}).catch(()=>{});
        throw error;
      }
    }

    if(action==="catalog" && req.method==="GET"){
      const {data:cats,error:ce}=await supabase.from("product_categories").select("*").eq("is_active",true).order("sort_order");
      if(ce) throw ce;
      const {data:products,error:pe}=await supabase.from("products").select("*").eq("is_active",true).order("sort_order");
      if(pe) throw pe;
      return json({ok:true,categories:cats,products});
    }

    if(action==="rewards" && req.method==="GET"){
      return json({ok:true,rewards:await rewardsWithUsage(true)});
    }

    if(action==="redeem-reward" && req.method==="POST"){
      const member=await memberFromLine(req);
      if(!member) return json({ok:false,error:"line_login_required"},401);
      const p=await req.json();
      if(typeof p.reward_id!=="string"||!/^[a-f0-9-]{36}$/i.test(p.reward_id)) return json({ok:false,error:"invalid_reward"},400);
      const {data,error}=await supabase.rpc("redeem_reward",{p_member_id:member.id,p_reward_id:p.reward_id});
      if(error)throw error;
      if(!data?.ok){
        const code=data?.error||"redeem_failed";
        const status=code==="insufficient_points"?400:code==="reward_not_available"?404:409;
        return json({ok:false,error:code},status);
      }
      return json({ok:true,...data});
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
        .select("id,order_no,display_order_no,total,status,payment_status,created_at,fulfillment_method,courier_provider,delivery_address,order_items(product_id,product_name,unit_price,quantity)")
        .eq("member_id",member.id).order("created_at",{ascending:false}).limit(20);
      if(oe) throw oe;
      const orderIds=(orders||[]).map((o:any)=>o.id);
      let orderPointMap=new Map<string,number>();
      if(orderIds.length){
        const {data:orderPoints,error:ope}=await supabase.from("point_transactions")
          .select("order_id,points")
          .eq("member_id",member.id)
          .eq("transaction_type","earn")
          .in("order_id",orderIds);
        if(ope) throw ope;
        for(const row of orderPoints||[]){
          if(!row.order_id) continue;
          orderPointMap.set(row.order_id,(orderPointMap.get(row.order_id)||0)+Number(row.points||0));
        }
      }
      const memberOrders=(orders||[]).map((o:any)=>({...o,points_earned:orderPointMap.get(o.id)||0}));
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
      return json({ok:true,member,addresses,orders:memberOrders,point_requests:pointRequests,referral_settings:referralSettings,
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

    if(action==="claim-order-points" && req.method==="POST"){
      const member=await memberFromLine(req);
      if(!member) return json({ok:false,error:"line_login_required"},401);
      const p=await req.json();
      if(typeof p.order_id!=="string"||!/^[a-f0-9-]{36}$/i.test(p.order_id)) return json({ok:false,error:"invalid_order"},400);
      const {data,error}=await supabase.rpc("claim_order_points",{p_member_id:member.id,p_order_id:p.order_id});
      if(error) throw error;
      if(!data?.ok){
        const code=data?.error||"claim_failed";
        const status=code==="order_not_found"?404:code==="order_not_ready"?409:400;
        return json({ok:false,error:code},status);
      }
      return json({ok:true,...data});
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

    if(action==="notify-payment" && req.method==="POST"){
      const member=await memberFromLine(req);
      if(!member) return json({ok:false,error:"line_login_required"},401);
      const p=await req.json();
      if(typeof p.order_id!=="string"||!/^[a-f0-9-]{36}$/i.test(p.order_id)) return json({ok:false,error:"invalid_order"},400);
      const {data:order,error:oe}=await supabase.from("orders")
        .select("id,order_no,display_order_no,member_id,status,payment_status,payment_method,payment_notified_at,total,fulfillment_method,order_items(product_name,quantity,line_total)")
        .eq("id",p.order_id).eq("member_id",member.id).maybeSingle();
      if(oe) throw oe;
      if(!order) return json({ok:false,error:"order_not_found"},404);
      if(order.status==="cancelled") return json({ok:false,error:"order_cancelled"},409);
      if(order.payment_status==="paid") return json({ok:true,already_paid:true,order});
      const now=new Date().toISOString();
      const firstNotification=!order.payment_notified_at;
      const {data,error}=await supabase.from("orders")
        .update({payment_notified_at:order.payment_notified_at||now,updated_at:now})
        .eq("id",order.id)
        .select("id,order_no,display_order_no,payment_status,payment_notified_at,total,fulfillment_method").single();
      if(error) throw error;

      if(firstNotification && member.line_user_id){
        await pushLineOrderConfirmation(member.line_user_id,order,order.order_items||[],order.fulfillment_method||"pickup");
        const sent=await pushLinePointsClaim(member.line_user_id,order);
        if(sent){
          await supabase.from("orders").update({points_prompt_sent_at:now}).eq("id",order.id);
        }
      }

      return json({ok:true,order:data});
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
      const fulfillment=["pickup","lineman","courier"].includes(p.fulfillment_method)?p.fulfillment_method:"pickup";
      const courierProvider=fulfillment==="courier"?p.courier_provider:null;
      if(fulfillment==="courier"&&!["grabexpress","lalamove","lineman"].includes(courierProvider))return json({ok:false,error:"invalid_courier_provider"},400);
      if(fulfillment==="courier"&&(!shortText(p.recipient_name,100)||!shortText(p.recipient_phone,25)||!shortText(p.delivery_address,500)))return json({ok:false,error:"delivery_details_required"},400);
      for(const [key,max] of [["delivery_latitude",90],["delivery_longitude",180]] as const){if(p[key]!=null&&(typeof p[key]!=="number"||!Number.isFinite(p[key])||Math.abs(p[key])>max))return json({ok:false,error:"invalid_coordinates"},400)}
      let savedAddress:any=null;
      if(p.member_address_id){
        if(!member) return json({ok:false,error:"line_login_required"},401);
        const {data,error}=await supabase.from("member_addresses").select("*")
          .eq("id",p.member_address_id).eq("member_id",member.id).maybeSingle();
        if(error) throw error;
        if(!data) return json({ok:false,error:"address_not_found"},404);
        savedAddress=data;
      }
      const numbering=await nextOrderNumber();
      const orderNo=numbering.order_no;
      const {data:order,error:oe}=await supabase.from("orders").insert({
        order_no:orderNo,
        display_order_no:numbering.display_order_no,
        member_id:member?.id??null,
        member_address_id:["lineman","courier"].includes(fulfillment)?savedAddress?.id??null:null,
        line_user_id:member?.line_user_id??null,
        customer_name:member?.display_name||shortText(p.customer_name,100)||null,
        subtotal:total,total,status:"pending",payment_status:"pending",
        delivery_status:["lineman","courier"].includes(fulfillment)?"waiting_payment":null,
        payment_method:p.payment_method||null,
        note:shortText(p.note,500)||null,fulfillment_method:fulfillment,courier_provider:courierProvider,
        recipient_name:["lineman","courier"].includes(fulfillment)?(savedAddress?.recipient_name||shortText(p.recipient_name,100)||null):null,
        recipient_phone:["lineman","courier"].includes(fulfillment)?(savedAddress?.phone||shortText(p.recipient_phone,25)||null):null,
        delivery_address:["lineman","courier"].includes(fulfillment)?(savedAddress?.address_text||shortText(p.delivery_address,500)||null):null,
        delivery_note:["lineman","courier"].includes(fulfillment)?(savedAddress?.delivery_note||shortText(p.delivery_note,500)||null):null,
        delivery_latitude:["lineman","courier"].includes(fulfillment)?(savedAddress?.latitude??p.delivery_latitude??null):null,
        delivery_longitude:["lineman","courier"].includes(fulfillment)?(savedAddress?.longitude??p.delivery_longitude??null):null
      }).select("id,order_no,display_order_no,display_order_no,total,status,created_at").single();
      if(oe) throw oe;
      const {error:ie}=await supabase.from("order_items").insert(normalized.map(x=>({...x,order_id:order.id})));
      if(ie){
        const {error:cleanupError}=await supabase.from("orders").delete().eq("id",order.id);
        if(cleanupError) console.error("order cleanup:",cleanupError.message);
        throw ie;
      }
      return json({ok:true,order});
    }

    if(action==="admin-pos-order" && req.method==="POST"){
      if(!await okAdmin(req)) return json({ok:false,error:"unauthorized"},401);
      const p=await req.json();
      const items=Array.isArray(p.items)?p.items:[];
      if(!items.length) return json({ok:false,error:"empty_cart"},400);
      const ids=items.map((x:any)=>x.product_id).filter(Boolean);
      const {data:dbProducts,error:pe}=await supabase.from("products")
        .select("id,name,price,is_active").in("id",ids);
      if(pe) throw pe;
      const map=new Map((dbProducts||[]).filter((x:any)=>x.is_active).map((x:any)=>[x.id,x]));
      const normalized:any[]=[]; let total=0;
      for(const item of items){
        const prod:any=map.get(item.product_id);
        const qty=Math.min(99,Math.max(1,Math.floor(Number(item.quantity||1))));
        if(!prod) continue;
        const line=Number(prod.price)*qty;
        total+=line;
        normalized.push({
          product_id:prod.id,
          product_name:prod.name,
          unit_price:Number(prod.price),
          quantity:qty,
          line_total:line
        });
      }
      if(!normalized.length) return json({ok:false,error:"no_valid_items"},400);
      const paymentMethod=["cash","promptpay"].includes(p.payment_method)?p.payment_method:"cash";
      const customerName=shortText(p.customer_name,100)||"ลูกค้าหน้าร้าน";
      const numbering=await nextOrderNumber();
      const orderNo=numbering.order_no;
      const {data:order,error:oe}=await supabase.from("orders").insert({
        order_no:orderNo,
        display_order_no:numbering.display_order_no,
        customer_name:customerName,
        subtotal:total,
        total,
        status:"pending",
        payment_status:"pending",
        payment_method:paymentMethod,
        fulfillment_method:"pickup",
        order_source:"pos",
        note:shortText(p.note,500)||null
      }).select("id,order_no,display_order_no,display_order_no,total,status,payment_status,payment_method,order_source,created_at").single();
      if(oe) throw oe;
      const {error:ie}=await supabase.from("order_items")
        .insert(normalized.map((x:any)=>({...x,order_id:order.id})));
      if(ie){
        await supabase.from("orders").delete().eq("id",order.id);
        throw ie;
      }
      return json({ok:true,order,items:normalized});
    }

    if(action==="admin-pos-pay" && req.method==="POST"){
      if(!await okAdmin(req)) return json({ok:false,error:"unauthorized"},401);
      const p=await req.json();
      if(typeof p.id!=="string"||!/^[a-f0-9-]{36}$/i.test(p.id)) return json({ok:false,error:"invalid_order"},400);
      const {data:existing,error:ee}=await supabase.from("orders")
        .select("id,order_no,display_order_no,total,status,payment_status,payment_method,order_source,customer_name,paid_at")
        .eq("id",p.id).maybeSingle();
      if(ee) throw ee;
      if(!existing) return json({ok:false,error:"order_not_found"},404);
      if(existing.order_source!=="pos") return json({ok:false,error:"not_pos_order"},409);
      if(existing.status==="cancelled") return json({ok:false,error:"order_cancelled"},409);
      if(existing.payment_status==="paid") return json({ok:true,already_paid:true,order:existing});
      const now=new Date().toISOString();
      const {data,error}=await supabase.from("orders").update({
        payment_status:"paid",
        paid_at:now,
        status:existing.status==="pending"?"confirmed":existing.status,
        updated_at:now
      }).eq("id",existing.id)
        .select("id,order_no,display_order_no,total,status,payment_status,payment_method,order_source,customer_name,paid_at").single();
      if(error) throw error;
      return json({ok:true,already_paid:false,order:data});
    }

    if(action==="admin-pos-paid-feed" && req.method==="GET"){
      if(!await okAdmin(req)) return json({ok:false,error:"unauthorized"},401);
      const url=new URL(req.url);
      const since=url.searchParams.get("since");
      let q=supabase.from("orders")
        .select("id,order_no,display_order_no,total,customer_name,order_source,payment_method,paid_at")
        .eq("payment_status","paid")
        .not("paid_at","is",null)
        .order("paid_at",{ascending:true})
        .limit(30);
      if(since){
        const d=new Date(since);
        if(!Number.isNaN(d.getTime())) q=q.gt("paid_at",d.toISOString());
      }
      const {data,error}=await q;
      if(error) throw error;
      return json({ok:true,orders:data||[],server_time:new Date().toISOString()});
    }

    if(action==="admin-rewards" && req.method==="GET"){
      if(!await okAdmin(req)) return json({ok:false,error:"unauthorized"},401);
      return json({ok:true,rewards:await rewardsWithUsage(false)});
    }

    if(action==="admin-save-reward" && (req.method==="POST"||req.method==="PUT")){
      if(!await okAdmin(req)) return json({ok:false,error:"unauthorized"},401);
      const p=await req.json();
      const name=shortText(p.name,120);
      const points=Number(p.points_required);
      const daily=p.daily_limit==null||p.daily_limit===""?null:Number(p.daily_limit);
      const stock=p.stock==null||p.stock===""?null:Number(p.stock);
      if(!name||!Number.isInteger(points)||points<=0||points>100000||
         (daily!==null&&(!Number.isInteger(daily)||daily<1||daily>100000))||
         (stock!==null&&(!Number.isInteger(stock)||stock<0||stock>1000000))){
        return json({ok:false,error:"invalid_reward"},400);
      }
      const payload={
        name,description:shortText(p.description,500)||null,points_required:points,
        image_url:shortText(p.image_url,5000)||null,daily_limit:daily,stock,
        is_active:p.is_active!==false,updated_at:new Date().toISOString()
      };
      let q;
      if(p.id){
        if(typeof p.id!=="string"||!/^[a-f0-9-]{36}$/i.test(p.id))return json({ok:false,error:"invalid_reward"},400);
        q=await supabase.from("rewards").update(payload).eq("id",p.id).select().single();
      }else{
        q=await supabase.from("rewards").insert(payload).select().single();
      }
      if(q.error)throw q.error;
      return json({ok:true,reward:q.data});
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
        .select("id,member_id,order_no,display_order_no,customer_name,total,status,payment_status,payment_method,payment_notified_at,fulfillment_method,courier_provider,delivery_address,recipient_name,recipient_phone,note,created_at,order_items(product_name,quantity,unit_price)")
        .order("created_at",{ascending:false}).limit(60);
      if(error) throw error;
      const orders=data||[];
      for(const order of orders){
        order.points_earned=0;
        order.points_balance=0;
        if(order.member_id){
          const memberResult=await supabase.from("members").select("points").eq("id",order.member_id).maybeSingle();
          if(memberResult.error) throw memberResult.error;
          order.points_balance=Number(memberResult.data?.points||0);
          const pointResult=await supabase.from("point_transactions").select("points")
            .eq("order_id",order.id).eq("transaction_type","earn").maybeSingle();
          if(pointResult.error) throw pointResult.error;
          order.points_earned=Number(pointResult.data?.points||0);
        }
      }
      return json({ok:true,orders});
    }

    if(action==="admin-update-order" && req.method==="POST"){
      if(!await okAdmin(req)) return json({ok:false,error:"unauthorized"},401);
      const p=await req.json();
      if(typeof p.id!=="string"||!/^[a-f0-9-]{36}$/i.test(p.id)) return json({ok:false,error:"invalid_order"},400);
      if(!["pending","confirmed","preparing","ready","completed","cancelled"].includes(p.status)||
         !["pending","paid","refunded"].includes(p.payment_status)) return json({ok:false,error:"invalid_status"},400);
      const {data:existing,error:ee}=await supabase.from("orders")
        .select("id,paid_at,status,payment_status,member_id,line_user_id,total,order_no,points_prompt_sent_at").eq("id",p.id).maybeSingle();
      if(ee) throw ee;
      if(!existing) return json({ok:false,error:"order_not_found"},404);
      const {data,error}=await supabase.from("orders")
        .update({status:p.status,payment_status:p.payment_status,
          paid_at:p.payment_status==="paid"?(existing.paid_at||new Date().toISOString()):null,
          updated_at:new Date().toISOString()})
        .eq("id",p.id).select("id,status,payment_status,paid_at,member_id,line_user_id,total,order_no,points_prompt_sent_at").single();
      if(error) throw error;
      const becameReadyForPoints=
        data.status==="completed" && data.payment_status==="paid" &&
        !(existing.status==="completed" && existing.payment_status==="paid");
      if(becameReadyForPoints && data.member_id && data.line_user_id && !data.points_prompt_sent_at){
        const sent=await pushLinePointsClaim(data.line_user_id,data);
        if(sent){
          await supabase.from("orders").update({points_prompt_sent_at:new Date().toISOString()}).eq("id",data.id);
        }
      }
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

    if(action==="admin-upload-image" && req.method==="POST"){
      if(!await okAdmin(req)) return json({ok:false,error:"unauthorized"},401);
      const incomingSize=Number(req.headers.get("content-length")||0);
      if(incomingSize>6*1024*1024) return json({ok:false,error:"image_too_large"},413);
      const form=await req.formData();
      const file=form.get("image");
      if(!(file instanceof File)||file.size===0||file.size>5*1024*1024){
        return json({ok:false,error:"invalid_image_size"},400);
      }
      const types:{[key:string]:{ext:string,signature:(v:Uint8Array)=>boolean}}={
        "image/jpeg":{ext:"jpg",signature:v=>v[0]===0xff&&v[1]===0xd8&&v[2]===0xff},
        "image/png":{ext:"png",signature:v=>v[0]===0x89&&v[1]===0x50&&v[2]===0x4e&&v[3]===0x47},
        "image/webp":{ext:"webp",signature:v=>String.fromCharCode(...v.slice(0,4))==="RIFF"&&String.fromCharCode(...v.slice(8,12))==="WEBP"}
      };
      const type=types[file.type];
      if(!type||!type.signature(new Uint8Array(await file.slice(0,12).arrayBuffer()))){
        return json({ok:false,error:"unsupported_image_type"},400);
      }
      const path=`products/${crypto.randomUUID()}.${type.ext}`;
      const {error}=await supabase.storage.from("product-images")
        .upload(path,file,{contentType:file.type,cacheControl:"3600",upsert:false});
      if(error) throw error;
      const {data}=supabase.storage.from("product-images").getPublicUrl(path);
      return json({ok:true,image_url:data.publicUrl});
    }

    if(action==="admin-move-category" && req.method==="POST"){
      if(!await okAdmin(req)) return json({ok:false,error:"unauthorized"},401);
      const p=await req.json();
      if(typeof p.id!=="string"||!["up","down"].includes(p.direction)) return json({ok:false,error:"invalid_input"},400);
      const {data:ordered,error:listError}=await supabase.from("product_categories").select("id,sort_order").order("sort_order").order("id");
      if(listError) throw listError;
      const position=ordered.findIndex(c=>c.id===p.id);
      const next=position+(p.direction==="up"?-1:1);
      if(position<0||next<0||next>=ordered.length) return json({ok:false,error:"invalid_category_position"},400);
      const current=ordered[position],neighbor=ordered[next];
      const {error:firstError}=await supabase.from("product_categories").update({sort_order:neighbor.sort_order}).eq("id",current.id);
      if(firstError) throw firstError;
      const {error:secondError}=await supabase.from("product_categories").update({sort_order:current.sort_order}).eq("id",neighbor.id);
      if(secondError){await supabase.from("product_categories").update({sort_order:current.sort_order}).eq("id",current.id);throw secondError}
      return json({ok:true});
    }

    if(action==="admin-save-category" && (req.method==="POST"||req.method==="PUT")){
      if(!await okAdmin(req)) return json({ok:false,error:"unauthorized"},401);
      const p=await req.json();
      const name=shortText(p.name,100);
      if(!name) return json({ok:false,error:"invalid_category_name"},400);
      const {data:duplicate,error:dupeError}=await supabase.from("product_categories").select("id").eq("name",name).maybeSingle();
      if(dupeError) throw dupeError;
      if(duplicate&&duplicate.id!==p.id) return json({ok:false,error:"category_already_exists"},409);
      let q;
      if(p.id){
        q=await supabase.from("product_categories").update({name,icon_url:shortText(p.icon_url,2048)||null,is_active:p.is_active!==false}).eq("id",p.id).select().single();
      }else{
        const {data:last,error:sortError}=await supabase.from("product_categories").select("sort_order").order("sort_order",{ascending:false}).limit(1);
        if(sortError) throw sortError;
        const asciiSlug=name.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
        const slug=(asciiSlug||"category")+"-"+crypto.randomUUID().slice(0,8);
        q=await supabase.from("product_categories").insert({name,icon_url:shortText(p.icon_url,2048)||null,slug,sort_order:(last?.[0]?.sort_order||0)+1,is_active:true}).select().single();
      }
      if(q.error) throw q.error;
      return json({ok:true,category:q.data});
    }

    return json({ok:false,error:"not_found"},404);
  }catch(e){console.error(e);return json({ok:false,error:e instanceof ApiError?e.code:"server_error"},e instanceof ApiError?e.status:500)}
});
