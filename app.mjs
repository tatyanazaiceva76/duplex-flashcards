import {buildCalibrationHtml,buildCardPacketHtml,createPlan,DuplexCardError,formatPlanSummary,renderSheetSvg,TEXT_STYLE} from './core.mjs';

const $=id=>document.getElementById(id);
const form=$('tool'),input=$('input'),delimiter=$('delimiter'),header=$('header'),paper=$('paper'),flip=$('flip');
const observedX=$('observed-x'),observedY=$('observed-y'),measured=$('measured'),error=$('error'),result=$('result');
const summary=$('summary'),preview=$('preview'),front=$('preview-front'),back=$('preview-back'),download=$('download');
let current=null,packetUrl=null;
const measureTextMm=(()=>{
  const canvas=document.createElement('canvas'),context=canvas.getContext('2d');
  if(!context) return undefined;
  context.font=`${TEXT_STYLE.fontSizeUserUnits}px ${TEXT_STYLE.fontFamily}`;
  return text=>context.measureText(text).width;
})();

function revoke(){ if(packetUrl){ URL.revokeObjectURL(packetUrl); packetUrl=null; } }
function invalidate(){
  revoke(); current=null; result.hidden=true; preview.replaceChildren(); summary.textContent='';
  front.disabled=true; back.disabled=true; download.disabled=true; error.hidden=true; error.textContent='';
}
function raw(){ return {input:input.value,delimiter:delimiter.value,header:header.checked,paper:paper.value,flip:flip.value,observedX:observedX.value,observedY:observedY.value,measured:measured.checked,measurementView:'BACK_TOP_UPRIGHT',measureTextMm}; }
function saveHtml(name,html){
  const url=URL.createObjectURL(new Blob([html],{type:'text/html;charset=utf-8'}));
  const anchor=document.createElement('a'); anchor.href=url; anchor.download=name; anchor.hidden=true;
  document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(()=>URL.revokeObjectURL(url),0);
}
function showError(cause){
  invalidate(); const prefix=cause instanceof DuplexCardError?`${cause.code}${cause.row?` (row ${cause.row})`:''}: `:'';
  error.textContent=prefix+(cause?.message||'Unable to generate the packet.'); error.hidden=false;
}
function showSide(side){
  if(!current) return;
  const parser=new DOMParser(),doc=parser.parseFromString(renderSheetSvg(current.plan,0,side),'image/svg+xml');
  const node=document.importNode(doc.documentElement,true); preview.replaceChildren(node);
  front.setAttribute('aria-pressed',String(side==='FRONT')); back.setAttribute('aria-pressed',String(side==='BACK'));
}

form.addEventListener('input',invalidate);
form.addEventListener('change',invalidate);
$('sample').addEventListener('click',()=>{
  input.value='front,back\n"What does duplex mean?","Printing on both sides"\n"Comma, quote, and Unicode","Comma, quote, and Привет"\n"Measure in BACK view","Right = +X; down = +Y"';
  delimiter.value=','; header.checked=true; paper.value='A4'; flip.value='LONG_EDGE'; observedX.value='0'; observedY.value='0'; measured.checked=false; invalidate(); input.focus();
});
$('reset-tool').addEventListener('click',()=>{ HTMLFormElement.prototype.reset.call(form); input.value=''; observedX.value='0'; observedY.value='0'; measured.checked=false; invalidate(); input.focus(); });
$('calibration').addEventListener('click',()=>{
  try{ saveHtml(`duplex-calibration-${paper.value.toLowerCase()}.html`,buildCalibrationHtml({paper:paper.value,flip:flip.value})); }
  catch(cause){ showError(cause); }
});
form.addEventListener('submit',event=>{
  event.preventDefault();
  try{
    if(!measureTextMm) throw new DuplexCardError('TEXT_MEASUREMENT_UNAVAILABLE','This browser cannot measure the card text. Enable Canvas2D text measurement or use another browser; no printable card packet was created.');
    const plan=createPlan(raw()),html=buildCardPacketHtml(plan);
    revoke(); packetUrl=URL.createObjectURL(new Blob([html],{type:'text/html;charset=utf-8'})); current={plan,html};
    summary.textContent=formatPlanSummary(plan);
    result.hidden=false; front.disabled=false; back.disabled=false; download.disabled=false; error.hidden=true; showSide('FRONT');
  }catch(cause){ showError(cause); }
});
front.addEventListener('click',()=>showSide('FRONT'));
back.addEventListener('click',()=>showSide('BACK'));
download.addEventListener('click',()=>{
  if(!current||!packetUrl) return;
  const anchor=document.createElement('a'); anchor.href=packetUrl; anchor.download='duplex-flashcards.html'; anchor.hidden=true;
  document.body.append(anchor); anchor.click(); anchor.remove();
});
window.addEventListener('pagehide',revoke,{once:true});
