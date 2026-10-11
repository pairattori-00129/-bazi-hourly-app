const CONTACT_ENDPOINT='https://oplwrlljqwgxnrqrdufp.supabase.co/functions/v1/contact-settings?public=1';
function contactUrl(v){try{const u=new URL(v);return u.protocol==='https:'&&!u.username&&!u.password?u.href:null}catch{return null}}
function renderShopContact(c={},failed=false){const root=document.getElementById('shopContactDetails');root.replaceChildren();
let photo=null;try{const u=new URL(c.storefront_url);if(u.origin==='https://oplwrlljqwgxnrqrdufp.supabase.co'&&u.pathname.startsWith('/storage/v1/object/public/product-images/products/'))photo=u.href}catch{}
const placeholder=()=>{const div=document.createElement('div');div.className='storefront-placeholder';const span=document.createElement('span');span.textContent='🏪 รูปหน้าร้าน Bake & Bite\nรอเพิ่มรูปหน้าร้าน';span.style.whiteSpace='pre-line';div.append(span);return div};
if(photo){const img=document.createElement('img');img.src=photo;img.alt='รูปหน้าร้าน '+(c.store_name||'Bake & Bite');img.loading='lazy';img.style.cssText='display:block;width:100%;aspect-ratio:3/2;object-fit:contain;background:white;border-radius:20px;margin:12px 0';img.onerror=()=>img.replaceWith(placeholder());root.append(img)}else root.append(placeholder());
function card(icon,title,text,url,color='green',logo){const row=document.createElement(url?'a':'div');row.className='contact-card '+color+(text?'':' is-pending');row.style.textDecoration='none';row.style.color='inherit';if(url){row.href=url;if(url.startsWith('https:')){row.target='_blank';row.rel='noopener'}}const i=document.createElement('div');i.className='cicon';if(logo){const img=document.createElement('img');img.className='contact-channel-icon';img.src=logo;img.alt=title;img.onerror=()=>{i.textContent=icon};i.append(img)}else i.textContent=icon;const body=document.createElement('div');body.className='cbody';const h=document.createElement('h3');h.textContent=title;const p=document.createElement('p');p.textContent=text||(failed?'โหลดข้อมูลไม่สำเร็จ':'ยังไม่ได้ตั้งค่า');p.style.whiteSpace='pre-line';body.append(h,p);row.append(i,body);if(url){const arrow=document.createElement('span');arrow.className='arrow';arrow.textContent='›';row.append(arrow)}root.append(row)}
card('🥪','ร้าน',c.store_name||'Bake & Bite');
card('📞','โทรหาร้าน',c.phone,c.phone&&/^[0-9+()\s-]{8,25}$/.test(c.phone)?'tel:'+c.phone.replace(/[^+0-9]/g,''):null,'peach');
card('🕒','เวลาทำการ',c.hours,null,'gold');card('📍','ที่อยู่ / จุดรับสินค้า',c.address,contactUrl(c.map_url),'pink');
if(!c.address&&contactUrl(c.map_url))card('📍','แผนที่ร้าน','เปิด Google Maps',contactUrl(c.map_url),'pink');
const heading=document.createElement('h2');heading.className='contact-details-heading';heading.textContent='ช่องทางติดต่อและสั่งอาหาร';root.append(heading);
card('💬','LINE Chat',contactUrl(c.line_url)?'ทักแชตร้าน':null,contactUrl(c.line_url));
card('f','Facebook',contactUrl(c.facebook_url)?'ติดตามข่าวสารและเมนูของร้าน':null,contactUrl(c.facebook_url),'green','contact-assets/facebook.svg');
card('♪','TikTok',contactUrl(c.tiktok_url)?'ชมวิดีโอของร้าน':null,contactUrl(c.tiktok_url),'peach','contact-assets/tiktok.svg');
card('🛍️','ShopeeFood',contactUrl(c.shopeefood_url)?'เปิดร้านบน ShopeeFood':null,contactUrl(c.shopeefood_url),'gold','contact-assets/shopee.svg');
card('✉️','อีเมล',c.email,c.email&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)?'mailto:'+c.email:null);
}
async function loadShopContact(){try{const r=await fetch(CONTACT_ENDPOINT,{cache:'no-store'});const j=await r.json();if(!r.ok||!j.ok)throw Error();renderShopContact(j.config||{})}catch{renderShopContact({},true)}}
loadShopContact();
