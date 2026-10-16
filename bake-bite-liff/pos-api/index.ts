import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"content-type,authorization","Access-Control-Allow-Methods":"GET,POST,OPTIONS"};
function json(data:any,status=200){return new Response(JSON.stringify(data),{status,headers:{...cors,"content-type":"application/json; charset=utf-8"}})}
const encoder=new TextEncoder();
function randomHex(bytes:number){return Array.from(crypto.getRandomValues(new Uint8Array(bytes)),v=>v.toString(16).padStart(2,"0")).join("")}
async function sha256(value:string){return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",encoder.encode(value))),v=>v.toString(16).padStart(2,"0")).join("")}
async function passwordHash(password:string,salt:string){const key=await crypto.subtle.importKey("raw",encoder.encode(password),"PBKDF2",false,["deriveBits"]);const bits=await crypto.subtle.deriveBits({name:"PBKDF2",salt:encoder.encode(salt),iterations:210000,hash:"SHA-256"},key,256);return Array.from(new Uint8Array(bits),v=>v.toString(16).padStart(2,"0")).join("")}
function sameHash(a:string,b:string){if(a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0}
function tokenFrom(req:Request){return req.headers.get("authorization")?.match(/^Bearer ([a-f0-9]{64})$/i)?.[1]||""}
async function createSession(role:"admin"|"user"){const token=randomHex(32);const {error}=await supabase.from("pos_sessions").insert({token_hash:await sha256(token),role,expires_at:new Date(Date.now()+12*60*60*1000).toISOString()});if(error)throw error;return {token,role,expires_in:12*60*60}}
async function session(req:Request){const token=tokenFrom(req);if(!token)return null;const hash=await sha256(token);const now=new Date().toISOString();const {data,error}=await supabase.from("pos_sessions").select("id,role").eq("token_hash",hash).gt("expires_at",now).maybeSingle();if(error)throw error;if(data)return data;const {data:admin,error:ae}=await supabase.from("admin_sessions").select("id").eq("token_hash",hash).gt("expires_at",now).maybeSingle();if(ae)throw ae;return admin?{id:admin.id,role:"admin"}:null}
async function requirePos(req:Request){const s=await session(req);return s&&["admin","user"].includes(s.role)?s:null}
function shortText(v:any,max:number){return String(v??"").trim().slice(0,max)}
async function nextOrderNumber(){
  const {data,error}=await supabase.rpc("next_bake_bite_order_no");
  if(error)throw error;
  if(!data?.order_no||!data?.display_order_no)throw new Error("order_number_failed");
  return data as {order_no:string,display_order_no:string};
}
async function pushKitchenStatus(to:string,order:any,status:string){
  const token=Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN");
  if(!token||!to)return false;
  const text=status==="preparing"
    ?"👨‍🍳 Bake & Bite กำลังจัดเตรียมอาหารของคุณ\nเลขที่ออเดอร์: "+(order.display_order_no||order.order_no)+"\nเรากำลังปรุงให้สดใหม่ กรุณารอสักครู่นะครับ"
    :status==="ready"
      ?"✅ Bake & Bite ปรุงอาหารเสร็จเรียบร้อยแล้ว\nเลขที่ออเดอร์: "+(order.display_order_no||order.order_no)+"\nอาหารของคุณพร้อมรับแล้วครับ 🥪🥗"
      :"";
  if(!text)return false;
  try{
    const response=await fetch("https://api.line.me/v2/bot/message/push",{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify({to,messages:[{type:"text",text}]})});
    if(!response.ok){console.error("LINE kitchen status push failed",response.status,await response.text());return false}
    return true;
  }catch(e){console.error("LINE kitchen status push error",e);return false}
}

async function pushLinePointsClaim(to:string,order:any){
  const token=Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN");
  if(!token||!to)return false;
  const points=Math.floor(Number(order.total||0)/50);if(points<=0)return false;
  const message={type:"text",text:"ออเดอร์ "+(order.display_order_no||order.order_no)+" ได้ "+points+" แต้ม\nหากต้องการรับคะแนนสะสม กรุณากดปุ่มด้านล่าง",quickReply:{items:[{type:"action",action:{type:"message",label:"⭐ รับคะแนนสะสม",text:"รับแต้ม "+order.order_no}}]}};
  try{
    const response=await fetch("https://api.line.me/v2/bot/message/push",{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify({to,messages:[message]})});
    if(!response.ok){console.error("LINE points push failed",response.status,await response.text());return false}
    return true;
  }catch(e){console.error("LINE points push error",e);return false}
}

Deno.serve(async req=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
  const u=new URL(req.url);const action=u.searchParams.get("action")||"session";
  try{
    if(action==="login"&&req.method==="POST"){
      const p=await req.json();const role=p.role==="admin"?"admin":p.role==="user"?"user":null;const password=typeof p.password==="string"?p.password:"";
      if(!role||!password||password.length>256)return json({ok:false,error:"invalid_credentials"},401);
      const table=role==="admin"?"admin_auth":"pos_user_auth";
      const {data,error}=await supabase.from(table).select("salt,password_hash").eq("id",1).maybeSingle();if(error)throw error;if(!data)return json({ok:false,error:"login_not_configured"},503);
      const valid=sameHash(await passwordHash(password,data.salt),data.password_hash);if(!valid)return json({ok:false,error:"invalid_credentials"},401);
      return json({ok:true,...await createSession(role)});
    }
    if(action==="session"&&req.method==="GET"){
      const s=await session(req);return s?json({ok:true,role:s.role}):json({ok:false,error:"unauthorized"},401);
    }
    if(action==="logout"&&req.method==="POST"){
      const token=tokenFrom(req);if(token){const hash=await sha256(token);await supabase.from("pos_sessions").delete().eq("token_hash",hash);await supabase.from("admin_sessions").delete().eq("token_hash",hash);}return json({ok:true});
    }
    if(action==="order"&&req.method==="POST"){
      if(!await requirePos(req))return json({ok:false,error:"unauthorized"},401);
      const p=await req.json();const items=Array.isArray(p.items)?p.items:[];if(!items.length)return json({ok:false,error:"empty_cart"},400);
      const ids=items.map((x:any)=>x.product_id).filter(Boolean);
      const {data:dbProducts,error:pe}=await supabase.from("products").select("id,name,price,is_active").in("id",ids);if(pe)throw pe;
      const map=new Map((dbProducts||[]).filter((x:any)=>x.is_active).map((x:any)=>[x.id,x]));const normalized:any[]=[];let total=0;
      for(const item of items){const prod:any=map.get(item.product_id);const qty=Math.min(99,Math.max(1,Math.floor(Number(item.quantity||1))));if(!prod)continue;const line=Number(prod.price)*qty;total+=line;normalized.push({product_id:prod.id,product_name:prod.name,unit_price:Number(prod.price),quantity:qty,line_total:line})}
      if(!normalized.length)return json({ok:false,error:"no_valid_items"},400);
      const paymentMethod=["cash","promptpay","truemoney","shopeepay"].includes(p.payment_method)?p.payment_method:"cash";const customerName=shortText(p.customer_name,100)||"ลูกค้าหน้าร้าน";const numbering=await nextOrderNumber();const orderNo=numbering.order_no;
      const {data:order,error:oe}=await supabase.from("orders").insert({order_no:orderNo,display_order_no:numbering.display_order_no,customer_name:customerName,subtotal:total,total,status:"pending",payment_status:"pending",payment_method:paymentMethod,fulfillment_method:"pickup",order_source:"pos",note:shortText(p.note,500)||null}).select("id,order_no,display_order_no,total,status,payment_status,payment_method,order_source,created_at").single();if(oe)throw oe;
      const {error:ie}=await supabase.from("order_items").insert(normalized.map((x:any)=>({...x,order_id:order.id})));if(ie){await supabase.from("orders").delete().eq("id",order.id);throw ie}
      return json({ok:true,order,items:normalized});
    }
    if(action==="pay"&&req.method==="POST"){
      if(!await requirePos(req))return json({ok:false,error:"unauthorized"},401);
      const p=await req.json();if(typeof p.id!=="string"||!/^[a-f0-9-]{36}$/i.test(p.id))return json({ok:false,error:"invalid_order"},400);
      const {data:existing,error:ee}=await supabase.from("orders").select("id,order_no,display_order_no,total,status,payment_status,payment_method,order_source,customer_name,paid_at").eq("id",p.id).maybeSingle();if(ee)throw ee;if(!existing)return json({ok:false,error:"order_not_found"},404);if(existing.order_source!=="pos")return json({ok:false,error:"not_pos_order"},409);if(existing.status==="cancelled")return json({ok:false,error:"order_cancelled"},409);if(existing.payment_status==="paid")return json({ok:true,already_paid:true,order:existing});
      const now=new Date().toISOString();const {data,error}=await supabase.from("orders").update({payment_status:"paid",paid_at:now,status:existing.status==="pending"?"confirmed":existing.status,updated_at:now}).eq("id",existing.id).select("id,order_no,display_order_no,total,status,payment_status,payment_method,order_source,customer_name,paid_at").single();if(error)throw error;return json({ok:true,already_paid:false,order:data});
    }
    if(action==="kitchen-orders"&&req.method==="GET"){
      if(!await requirePos(req))return json({ok:false,error:"unauthorized"},401);
      const {data,error}=await supabase.from("orders")
        .select("id,member_id,line_user_id,order_no,display_order_no,customer_name,total,status,payment_status,payment_method,fulfillment_method,delivery_address,recipient_name,recipient_phone,note,created_at,updated_at,order_items(product_name,quantity,unit_price)")
        .in("status",["pending","confirmed","preparing","ready"])
        .order("created_at",{ascending:false}).limit(100);
      if(error)throw error;
      return json({ok:true,orders:data||[]});
    }
    if(action==="kitchen-update-order"&&req.method==="POST"){
      if(!await requirePos(req))return json({ok:false,error:"unauthorized"},401);
      const p=await req.json();
      if(typeof p.id!=="string"||!/^[a-f0-9-]{36}$/i.test(p.id))return json({ok:false,error:"invalid_order"},400);
      if(!["preparing","ready","completed"].includes(p.status))return json({ok:false,error:"invalid_status"},400);
      const {data:existing,error:ee}=await supabase.from("orders")
        .select("id,paid_at,status,payment_status,member_id,line_user_id,total,order_no,display_order_no,points_prompt_sent_at").eq("id",p.id).maybeSingle();
      if(ee)throw ee;if(!existing)return json({ok:false,error:"order_not_found"},404);
      const {data:prep,error:prepError}=await supabase.from("prep_tickets").select("station_id,status").eq("order_id",p.id);
      if(prepError)throw prepError;
      if((prep||[]).length>1&&["ready","completed"].includes(p.status)&&(prep||[]).some(t=>t.status!=="ready"))return json({ok:false,error:"ยังมีสถานีที่ทำไม่เสร็จ กรุณาอัปเดตจากคิวแยกสถานี"},409);
      if((prep||[]).length===1&&["preparing","ready"].includes(p.status)){const {error:te}=await supabase.from("prep_tickets").update({status:p.status,updated_at:new Date().toISOString()}).eq("order_id",p.id);if(te)throw te}

      const {data,error}=await supabase.from("orders").update({status:p.status,updated_at:new Date().toISOString()})
        .eq("id",p.id).select("id,status,payment_status,member_id,line_user_id,total,order_no,display_order_no,points_prompt_sent_at").single();
      if(error)throw error;
      if(existing.status!==data.status && ["preparing","ready"].includes(data.status) && data.line_user_id){
        await pushKitchenStatus(data.line_user_id,data,data.status);
      }
      const becameReadyForPoints=data.status==="completed"&&data.payment_status==="paid"&&existing.status!=="completed";
      if(becameReadyForPoints&&data.member_id&&data.line_user_id&&!data.points_prompt_sent_at){
        const sent=await pushLinePointsClaim(data.line_user_id,data);
        if(sent)await supabase.from("orders").update({points_prompt_sent_at:new Date().toISOString()}).eq("id",data.id);
      }
      return json({ok:true,order:data});
    }
    if(action==="print-order"&&req.method==="GET"){
      if(!await requirePos(req))return json({ok:false,error:"unauthorized"},401);
      const id=u.searchParams.get("id");if(!id||!/^[a-f0-9-]{36}$/i.test(id))return json({ok:false,error:"invalid_order"},400);
      const {data:order,error}=await supabase.from("orders").select("id,member_id,order_no,display_order_no,customer_name,total,status,payment_status,payment_method,fulfillment_method,note,created_at,order_items(product_name,quantity,unit_price,line_total,prep_station_id)").eq("id",id).maybeSingle();
      if(error)throw error;if(!order)return json({ok:false,error:"order_not_found"},404);
      const stationIds=[...new Set((order.order_items||[]).map((i:any)=>i.prep_station_id).filter(Boolean))];
      const names=new Map<string,string>();if(stationIds.length){const q=await supabase.from("prep_stations").select("id,name").in("id",stationIds);if(q.error)throw q.error;for(const s of q.data||[])names.set(s.id,s.name);}
      let earned=0,balance:number|null=null,memberName:string|null=null;
      if(order.member_id){const [m,t]=await Promise.all([supabase.from("members").select("points,display_name").eq("id",order.member_id).maybeSingle(),supabase.from("point_transactions").select("points").eq("order_id",order.id).eq("member_id",order.member_id).eq("transaction_type","earn")]);if(m.error||t.error)throw m.error||t.error;balance=m.data?Number(m.data.points||0):null;memberName=m.data?.display_name||null;earned=(t.data||[]).reduce((sum:number,row:any)=>sum+Number(row.points||0),0);}
      const potential=order.member_id&&order.payment_status==="paid"&&order.status!=="cancelled"?Math.floor(Number(order.total||0)/50):0;
      const {member_id,order_items,...publicOrder}=order;
      return json({ok:true,order:publicOrder,items:(order_items||[]).map((i:any)=>({name:i.product_name,quantity:i.quantity,unit_price:i.unit_price,line_total:i.line_total,department:names.get(i.prep_station_id)||"จุดรวม"})),points:{member_linked:!!member_id,member_name:memberName,earned,balance,pending:Math.max(0,potential-earned),as_of:new Date().toISOString()}});
    }
    if(action==="paid-feed"&&req.method==="GET"){
      if(!await requirePos(req))return json({ok:false,error:"unauthorized"},401);
      const since=u.searchParams.get("since");let q=supabase.from("orders").select("id,order_no,display_order_no,total,customer_name,order_source,payment_method,paid_at").eq("payment_status","paid").not("paid_at","is",null).order("paid_at",{ascending:true}).limit(30);if(since){const d=new Date(since);if(!Number.isNaN(d.getTime()))q=q.gt("paid_at",d.toISOString())}
      const {data,error}=await q;if(error)throw error;return json({ok:true,orders:data||[],server_time:new Date().toISOString()});
    }
    return json({ok:false,error:"not_found"},404);
  }catch(e){console.error(e);return json({ok:false,error:"server_error"},500)}
});