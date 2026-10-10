const platform=document.body.dataset.platform;
const fields=['store_name','merchant_id','environment','approval','client_id','api_url','token_url','callback_url','docs_url','notes'];
const secretFields=['client_secret','access_token','webhook_secret'];
const message=document.getElementById('message');
function notice(text,error=false){message.textContent=text;message.classList.toggle('error',error)}
async function settingsRequest(method='GET',body){
 const response=await fetch(ADMIN_API.replace('/store-api','/delivery-settings')+'?platform='+encodeURIComponent(platform),{method,headers:{authorization:'Bearer '+adminToken(),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 let data;try{data=await response.json()}catch{throw new Error('เซิร์ฟเวอร์การตั้งค่ายังไม่พร้อมใช้งาน')}
 if(response.status===401){clearAdminToken();location.replace('admin-login.html');throw new Error('กรุณาเข้าสู่ระบบใหม่')}
 if(!response.ok||!data.ok)throw new Error(data.error||'บันทึกไม่สำเร็จ');return data;
}
function display(data){
 fields.forEach(key=>{document.getElementById(key).value=data.config[key]??({store_name:'Bake & Bite',environment:'sandbox',approval:'not_requested'}[key]||'')});
 secretFields.forEach(key=>{document.getElementById(key).value='';document.getElementById(key+'_state').textContent=data.secrets_present[key]?'บันทึกค่าไว้แล้ว — กรอกใหม่เพื่อเปลี่ยน':'ยังไม่ได้บันทึกค่า'});
 document.getElementById('clear_secrets').checked=false;
 document.getElementById('status').textContent=data.updated_at?'บันทึกค่าล่าสุด '+new Date(data.updated_at).toLocaleString('th-TH'):'ยังไม่ได้ตั้งค่า';
}
(async()=>{if(!await requireAdmin())return;try{display(await settingsRequest());document.getElementById('save').disabled=false;document.getElementById('check').disabled=false}catch(e){notice(e.message,true);document.getElementById('status').textContent='โหลดการตั้งค่าไม่สำเร็จ'}})();
document.getElementById('settings').onsubmit=async event=>{event.preventDefault();const save=document.getElementById('save');save.disabled=true;try{const config=Object.fromEntries(fields.map(key=>[key,document.getElementById(key).value.trim()]));const secrets=Object.fromEntries(secretFields.filter(key=>document.getElementById(key).value).map(key=>[key,document.getElementById(key).value]));display(await settingsRequest('POST',{config,secrets,clear_secrets:document.getElementById('clear_secrets').checked}));notice('บันทึกการตั้งค่าแล้ว — ยังไม่ได้เชื่อมรับออเดอร์อัตโนมัติ')}catch(e){notice(e.message,true)}finally{save.disabled=false}};
document.getElementById('check').onclick=async()=>{try{const data=await settingsRequest();const missing=['merchant_id','client_id','api_url'].filter(key=>!data.config[key]);notice(missing.length?'ข้อมูลตั้งต้นที่ยังขาด: '+missing.join(', '):'ข้อมูลตั้งต้นครบ ต้องตรวจรูปแบบตามเอกสารและทดสอบ API จริงก่อนใช้งาน',!!missing.length)}catch(e){notice(e.message,true)}};
