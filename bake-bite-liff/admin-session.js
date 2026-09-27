const ADMIN_API='https://oplwrlljqwgxnrqrdufp.supabase.co/functions/v1/store-api';
const ADMIN_SESSION_KEY='bake_bite_admin_session';
function adminToken(){return sessionStorage.getItem(ADMIN_SESSION_KEY)||''}
function saveAdminToken(token){sessionStorage.setItem(ADMIN_SESSION_KEY,token)}
function clearAdminToken(){sessionStorage.removeItem(ADMIN_SESSION_KEY)}
async function adminRequest(action,method='GET',body){
 const response=await fetch(ADMIN_API+'?action='+action,{method,headers:{authorization:'Bearer '+adminToken(),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const data=await response.json();
 if(response.status===401){clearAdminToken();location.replace('admin-login.html');throw new Error('กรุณาเข้าสู่ระบบใหม่')}
 if(!response.ok||!data.ok)throw new Error(data.error||'เชื่อมต่อไม่สำเร็จ');
 return data;
}
async function requireAdmin(){
 if(!adminToken()){location.replace('admin-login.html');return false}
 try{await adminRequest('admin-session');document.body.classList.add('admin-verified');return true}
 catch(e){if(e.message!=='กรุณาเข้าสู่ระบบใหม่')console.error('admin session',e);return false}
}
async function logoutAdmin(){
 try{await adminRequest('admin-logout','POST')}catch(e){console.error('logout',e)}
 clearAdminToken();location.replace('admin-login.html');
}
window.addEventListener('pageshow',event=>{if(event.persisted)location.reload()});
