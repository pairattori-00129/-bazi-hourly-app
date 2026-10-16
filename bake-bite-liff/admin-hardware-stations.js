(()=>{
const root=document.getElementById('stationCards'),notice=document.getElementById('stationNotice');
function node(tag,text){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n}
function toggle(card,label,checked,disabled=false){const row=node('label');row.className='toggle-row';const text=node('span',label),input=node('input');input.type='checkbox';input.className='use-toggle';input.checked=checked;input.disabled=disabled;row.append(text,input);card.append(row);return input}
function field(parent,label,value,type='input'){const wrap=node('label',label),input=node(type);if(type==='input'){input.type='text';input.maxLength=200;input.placeholder='เช่น XP-Q80'}else for(const mm of ['80','58']){const o=node('option',mm+' มม.');o.value=mm;input.append(o)}input.value=value;wrap.append(input);parent.append(wrap);return input}
function testPrint(station,name,paper,feedback){const w=window.open('','_blank','width=430,height=650');if(!w){feedback.textContent='กรุณาอนุญาตป๊อปอัป หรือเปิดด้วย Chrome / Edge';return}const d=w.document;d.title='ทดสอบเครื่องพิมพ์สถานี';const style=d.createElement('style');style.textContent='@page{size:'+paper+'mm auto;margin:4mm}body{font:14px sans-serif;width:'+(Number(paper)-8)+'mm}h1{font-size:20px}@media print{button,.help{display:none}}';d.head.append(style);
for(const text of ['BAKE & BITE','ทดสอบ: '+station,'เลือกเครื่อง: '+(name||'ยังไม่ระบุชื่อ'),'กระดาษ '+paper+' มม.','ภาษาไทย / English / 0123456789','รายการทดสอบ — ไม่ใช่ยอดขาย']){const p=d.createElement('p');p.textContent=text;d.body.append(p)}
const b=d.createElement('button');b.textContent='พิมพ์ / ลองเปิดหน้าต่างพิมพ์อีกครั้ง';b.onclick=()=>w.print();d.body.append(b);const help=d.createElement('p');help.className='help';help.textContent='หากหน้าต่างพิมพ์ไม่เปิด ให้เปิดเว็บด้วย Chrome หรือ Edge แล้วเลือกเครื่องพิมพ์ใน Windows';d.body.append(help);w.focus();setTimeout(()=>w.print(),250);feedback.textContent='เปิดใบทดสอบแล้ว กรุณาเลือกเครื่องพิมพ์ในหน้าต่างพิมพ์'}
function render(config,onlyId){if(!onlyId)root.replaceChildren();for(const station of config.stations){
if(onlyId&&station.id!==onlyId)continue;
const card=node('article');card.className='station-card';card.append(node('h3',station.name));
const enabled=toggle(card,'เปิดใช้งานสถานี / รับรายการใหม่',station.enabled,station.is_default);
const columns=node('div');columns.className='station-output-grid';
const screenCol=node('div'),printerCol=node('div');screenCol.className=printerCol.className='station-output';
const screen=toggle(screenCol,'ใช้หน้าจอ',station.screen_enabled),printer=toggle(printerCol,'ใช้เครื่องพิมพ์',station.printer_enabled);
const selected=new Set(config.routes.filter(r=>r.station_id===station.id).map(r=>r.category_id)),pairs=[];
for(const col of [screenCol,printerCol]){
col.append(node('h4','หมวดสินค้าที่ส่งมาสถานีนี้'));
if(station.is_default){col.append(node('p','รับรายการที่ยังไม่กำหนดสถานีโดยอัตโนมัติ'));continue}
if(!config.categories.length)col.append(node('p','ยังไม่มีหมวดสินค้า'));
for(const category of config.categories){
const route=config.routes.find(r=>r.category_id===category.id),other=route&&route.station_id!==station.id;
const owner=route?config.stations.find(st=>st.id===route.station_id)?.name:'';
const row=node('label');row.className='check-category';
const input=node('input');input.type='checkbox';input.value=category.id;input.checked=selected.has(category.id);
row.append(input,node('span',category.name+(owner?' — '+owner:'')));col.append(row);
pairs.push({input,id:category.id,other:!!other,output:col===screenCol?screen:printer});
input.onchange=()=>{if(input.checked)selected.add(category.id);else selected.delete(category.id);for(const item of pairs)if(item.id===category.id)item.input.checked=input.checked;summary.textContent='หมวดสินค้า: '+(config.categories.filter(c=>selected.has(c.id)).map(c=>c.name).join(', ')||'ยังไม่ได้เลือกหมวด')};
}}
columns.append(screenCol,printerCol);card.append(columns);
card.append(node('small',station.is_default?'จุดรวมต้องเปิดรับงานไว้เพื่อรองรับรายการที่ยังไม่กำหนดสถานี':'หากหมวดถูกใช้แล้ว ให้เอาหมวดออกจากสถานีเดิมก่อน'));
card.append(node('small','หมวดสินค้าเป็นค่าร่วมของสถานี เลือกฝั่งใดจะตรงกันทั้งสองฝั่ง ส่วนจอและเครื่องพิมพ์เปิด–ปิดได้แยกกัน'));
const summary=node('small',station.is_default?'หมวดสินค้า: รายการที่ยังไม่กำหนดสถานี':'หมวดสินค้า: '+(config.categories.filter(c=>selected.has(c.id)).map(c=>c.name).join(', ')||'ยังไม่ได้เลือกหมวด'));card.append(summary);
const details=node('details');details.className='printer-details';details.append(node('summary','ตั้งค่าและทดสอบเครื่องพิมพ์'));
const name=field(details,'ชื่อเครื่องพิมพ์ใน Windows',station.printer_name||''),paper=field(details,'ขนาดกระดาษ',station.paper||'80','select'),test=node('button','ทดสอบพิมพ์สถานีนี้');test.type='button';test.className='secondary';details.append(test,node('small','เลือกเครื่องพิมพ์ผ่านหน้าต่าง Windows ทุกครั้ง ขณะนี้ยังไม่พิมพ์อัตโนมัติ'));card.append(details);
const actions=node('div');actions.className='station-actions';const save=node('button','บันทึกสถานีนี้');save.type='button';const open=node('a','เปิดจอสถานี →');open.href='station-screen.html?station='+encodeURIComponent(station.id);const edit=node('a','แก้ไขชื่อสถานี');edit.href='admin-stations.html';actions.append(save,open,edit);const feedback=node('p');feedback.className='station-feedback';feedback.setAttribute('role','status');card.append(actions,feedback);
function sync(){details.hidden=!printer.checked;open.hidden=!screen.checked||!enabled.checked;for(const item of pairs)item.input.disabled=item.other||!item.output.checked||!enabled.checked}
screen.onchange=printer.onchange=enabled.onchange=sync;sync();test.onclick=()=>testPrint(station.name,name.value,paper.value,feedback);
save.onclick=async()=>{
if(!screen.checked&&!printer.checked){feedback.textContent='เลือกจอหรือเครื่องพิมพ์อย่างน้อยหนึ่งอย่าง หากพักสถานี ให้ปิดรับรายการใหม่';return}
save.disabled=true;feedback.textContent='กำลังบันทึก…';
try{const categoryIds=Array.from(selected);await stationRequest('save',{id:station.id,name:station.name,enabled:enabled.checked,screen_enabled:screen.checked,printer_enabled:printer.checked,printer_name:name.value.trim(),paper:paper.value,category_ids:categoryIds});
config.routes=config.routes.filter(r=>r.station_id!==station.id).concat(categoryIds.map(category_id=>({category_id,station_id:station.id})));
newCategories(config);feedback.textContent='บันทึกแล้ว ใช้กับรายการใหม่';}
catch(e){feedback.textContent=e.message}finally{save.disabled=false}
};root.append(card)}notice.textContent='เลือกจอและเครื่องพิมพ์ พร้อมกำหนดหมวดสินค้าของแต่ละสถานี';}
const byId=id=>document.getElementById(id);
function newCategories(config){const list=byId('newStationCategories');list.replaceChildren();for(const c of config.categories){const route=config.routes.find(r=>r.category_id===c.id),row=node('label');row.className='check-category';const input=node('input');input.type='checkbox';input.value=c.id;input.name='newStationCategory';input.disabled=!!route;const owner=route?config.stations.find(s=>s.id===route.station_id)?.name:'';row.append(input,node('span',c.name+(route?' — ใช้อยู่ที่ '+(owner||'สถานีอื่น'):'')));list.append(row)}if(!config.categories.length)list.append(node('p','ยังไม่มีหมวดสินค้า เพิ่มหมวดในหน้าจัดการเมนูก่อน หรือเพิ่มสถานีไว้ก่อนแล้วกำหนดภายหลัง'));byId('createStation').disabled=false;}
byId('newStationPrinter').onchange=()=>{byId('newStationPrinterDetails').hidden=!byId('newStationPrinter').checked};
byId('createStation').onclick=async()=>{
const feedback=byId('createStationFeedback'),name=byId('newStationName').value.trim();
if(!name){feedback.textContent='กรุณาระบุชื่อสถานี';byId('newStationName').focus();return}
if(!byId('newStationScreen').checked&&!byId('newStationPrinter').checked){feedback.textContent='เลือกใช้หน้าจอหรือเครื่องพิมพ์อย่างน้อยหนึ่งอย่าง';return}
const button=byId('createStation');button.disabled=true;feedback.textContent='กำลังเพิ่มสถานี…';let created=false;
try{const result=await stationRequest('save',{name,enabled:byId('newStationEnabled').checked,screen_enabled:byId('newStationScreen').checked,printer_enabled:byId('newStationPrinter').checked,printer_name:byId('newStationPrinterName').value.trim(),paper:byId('newStationPaper').value,category_ids:Array.from(byId('newStationCategories').querySelectorAll('input:checked')).map(i=>i.value)});created=true;
const config=await stationRequest();render(config,result.id);newCategories(config);byId('newStationName').value='';feedback.textContent='เพิ่มสถานี '+name+' แล้ว ปรับเปิด–ปิดได้ในการ์ดด้านบน';}
catch(e){feedback.textContent=created?'เพิ่มสถานีแล้ว แต่โหลดรายการใหม่ไม่สำเร็จ กรุณารีเฟรชหน้าเพื่อดูสถานี ห้ามกดเพิ่มซ้ำ':e.message}
finally{button.disabled=created&&feedback.textContent.includes('โหลดรายการใหม่ไม่สำเร็จ')}
};
(async()=>{if(!await requireAdmin())return;try{const config=await stationRequest();render(config);newCategories(config)}catch(e){notice.textContent='โหลดสถานีไม่สำเร็จ: '+e.message;const retry=node('button','ลองโหลดสถานีอีกครั้ง');retry.type='button';retry.onclick=()=>location.reload();notice.append(retry)}})();
})();