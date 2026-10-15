const HARDWARE_KEY='bake_bite_hardware_profile';
function hardwareProfile(){try{return JSON.parse(localStorage.getItem(HARDWARE_KEY)||'{}')}catch{return {}}}
function hardwarePrintEnabled(kind){const c=hardwareProfile();return c[kind==='kitchen'?'kitchen_printer_enabled':'receipt_enabled']!=='no'}
function hardwarePaper(kind){return hardwareProfile()[kind==='kitchen'?'kitchen_paper':'receipt_paper']==='58'?'58':'80'}
function hardwareAutoCash(){return hardwarePrintEnabled('receipt')&&hardwareProfile().auto_cash!=='no'}
