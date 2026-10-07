const POS_API='https://oplwrlljqwgxnrqrdufp.supabase.co/functions/v1/pos-api';
const POS_SESSION_KEY='bake_bite_pos_session';
const POS_ROLE_KEY='bake_bite_pos_role';
function posToken(){return sessionStorage.getItem(POS_SESSION_KEY)||''}
function posRole(){return sessionStorage.getItem(POS_ROLE_KEY)||''}
function savePosSession(token,role){sessionStorage.setItem(POS_SESSION_KEY,token);sessionStorage.setItem(POS_ROLE_KEY,role)}
function clearPosSession(){sessionStorage.removeItem(POS_SESSION_KEY);sessionStorage.removeItem(POS_ROLE_KEY)}
async function posRequest(action,method='GET',body){
 const response=await fetch(POS_API+'?action='+action,{method,headers:{authorization:'Bearer '+posToken(),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const data=await response.json();
 if(response.status===401){clearPosSession();location.replace('pos-login.html');throw new Error('กรุณาเข้าสู่ระบบใหม่')}
 if(!response.ok||!data.ok)throw new Error(data.error||'เชื่อมต่อ POS ไม่สำเร็จ');
 return data;
}
async function requirePos(){
 if(!posToken()){location.replace('pos-login.html');return false}
 try{const s=await posRequest('session');savePosSession(posToken(),s.role);document.body.classList.add('pos-verified');return true}
 catch(e){return false}
}
async function logoutPos(){
 try{await posRequest('logout','POST')}catch(e){}
 clearPosSession();sessionStorage.removeItem('bake_bite_admin_session');location.replace('pos-login.html');
}
function goAdmin(){
 if(posRole()!=='admin'){alert('บัญชี USER ไม่มีสิทธิ์เข้าสู่ระบบ Admin');return}
 if(!sessionStorage.getItem('bake_bite_admin_session')){location.href='admin-login.html';return}
 location.href='admin-main.html';
}
