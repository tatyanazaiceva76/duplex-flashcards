const PAPER = Object.freeze({
  A4: Object.freeze({name:'A4', width:210, height:297}),
  LETTER: Object.freeze({name:'US Letter', width:215.9, height:279.4}),
});
const LIMITS = Object.freeze({inputBytes:131072, cards:64, fieldCodePoints:240, offsetMm:5, cardsPerSheet:8, columns:2, rows:4, marginMm:15, gapMm:3, maxLines:6});
const TEXT_STYLE = Object.freeze({fontSizeUserUnits:4.8,fontFamily:'Arial, "DejaVu Sans", sans-serif',horizontalInsetMm:6});

export class DuplexCardError extends Error {
  constructor(code, message, row=null) {
    super(message); this.name='DuplexCardError'; this.code=code; this.row=row;
  }
  toJSON(){ return {code:this.code,row:this.row,message:this.message}; }
}
const fail=(code,message,row=null)=>{ throw new DuplexCardError(code,message,row); };
const utf8Bytes=value=>new TextEncoder().encode(value).length;
const codePoints=value=>Array.from(value);

function parseRows(input, delimiter){
  if(typeof input!=='string') fail('INPUT_TYPE','Input must be text.');
  if(![',','\t'].includes(delimiter)) fail('DELIMITER','Delimiter must be comma or tab.');
  if(utf8Bytes(input)>LIMITS.inputBytes) fail('INPUT_BYTES','Input exceeds 128 KiB UTF-8.');
  let text=input.startsWith('\uFEFF')?input.slice(1):input;
  if(!text.length) fail('INPUT_EMPTY','Input is empty.');
  const rows=[]; let fields=[], value='', inQuote=false, afterQuote=false, quoted=false;
  let line=1, rowLine=1, endedOnRecord=false;
  const pushField=()=>{ fields.push({value,quoted}); value=''; quoted=false; afterQuote=false; };
  const pushRow=()=>{ pushField(); rows.push({fields,line:rowLine}); fields=[]; endedOnRecord=true; rowLine=line+1; };
  for(let i=0;i<text.length;i++){
    const ch=text[i]; endedOnRecord=false;
    if(inQuote){
      if(ch==='"'){
        if(text[i+1]==='"'){ value+='"'; i++; }
        else { inQuote=false; afterQuote=true; }
      } else if(ch==='\r') {
        if(text[i+1]!=='\n') fail('CSV_CR','A carriage return must be followed by line feed.',rows.length+1);
        value+='\n'; i++; line++;
      } else { value+=ch; if(ch==='\n') line++; }
      continue;
    }
    if(afterQuote){
      if(ch===delimiter){ pushField(); continue; }
      if(ch==='\n'){ pushRow(); line++; continue; }
      if(ch==='\r'){
        if(text[i+1]!=='\n') fail('CSV_CR','A carriage return must be followed by line feed.',rows.length+1);
        pushRow(); i++; line++; continue;
      }
      fail('CSV_AFTER_QUOTE','Only a delimiter or line ending may follow a closing quote.',rows.length+1);
    }
    if(ch==='"'){
      if(value.length) fail('CSV_QUOTE_POSITION','A quote may only start an empty field.',rows.length+1);
      inQuote=true; quoted=true; continue;
    }
    if(ch===delimiter){ pushField(); continue; }
    if(ch==='\n'){ pushRow(); line++; continue; }
    if(ch==='\r'){
      if(text[i+1]!=='\n') fail('CSV_CR','A carriage return must be followed by line feed.',rows.length+1);
      pushRow(); i++; line++; continue;
    }
    value+=ch;
  }
  if(inQuote) fail('CSV_UNCLOSED_QUOTE','Quoted field is not closed.',rows.length+1);
  if(!endedOnRecord || fields.length || value.length || quoted || afterQuote){ pushField(); rows.push({fields,line:rowLine}); }
  return rows;
}

export function parseCardTable(input,{delimiter=',',header=false}={}){
  if(typeof header!=='boolean') fail('HEADER_FLAG','Header must be true or false.');
  const rows=parseRows(input,delimiter);
  if(header){
    if(rows[0].fields.length!==2) fail('HEADER_COLUMNS','Header must have exactly two columns.',1);
    const names=rows[0].fields.map(field=>field.value.trim().toLocaleLowerCase('en-US'));
    if(names[0]!=='front'||names[1]!=='back') fail('HEADER_NAMES','Header must be front,back.',1);
    rows.shift();
  }
  if(!rows.length) fail('NO_CARDS','No card rows were provided.');
  if(rows.length>LIMITS.cards) fail('CARD_LIMIT','Input exceeds 64 cards.');
  return rows.map((row,index)=>{
    const number=index+1;
    if(row.fields.length!==2) fail('ROW_COLUMNS','Each record must contain exactly two fields.',number+(header?1:0));
    const [front,back]=row.fields.map(field=>field.value);
    if(!front.trim()||!back.trim()) fail('FIELD_EMPTY','Front and back must both contain text.',number+(header?1:0));
    if(codePoints(front).length>LIMITS.fieldCodePoints||codePoints(back).length>LIMITS.fieldCodePoints) fail('FIELD_LENGTH','A field exceeds 240 Unicode code points.',number+(header?1:0));
    return Object.freeze({id:number,front,back});
  });
}

function conservativeGlyphMm(char){
  const cp=char.codePointAt(0);
  if(cp>=0x300&&cp<=0x36f) return 0;
  if(char==='\t') return 7.2;
  if(char===' ') return 1.8;
  if(/[ilI.,:;!'|]/u.test(char)) return 1.8;
  if(/[MW@#%&]/u.test(char)) return 4.8;
  if(cp>=0x2e80 || cp>0xffff) return 4.8;
  return 3.6;
}
export const conservativeMeasureTextMm=text=>codePoints(text).reduce((sum,char)=>sum+conservativeGlyphMm(char),0);

function checkedWidth(text,measureTextMm){
  let width;
  try { width=measureTextMm(text); }
  catch { fail('MEASURE_CALLBACK','Text measurement callback failed.'); }
  if(!Number.isFinite(width)||width<0) fail('MEASURE_CALLBACK','Text measurement callback must return a finite nonnegative width in SVG user units (mm).');
  return width;
}

export function wrapCardText(text,{maxWidthMm,measureTextMm=conservativeMeasureTextMm,maxLines=LIMITS.maxLines}={}){
  if(typeof text!=='string'||!Number.isFinite(maxWidthMm)||maxWidthMm<=0||typeof measureTextMm!=='function'||!Number.isInteger(maxLines)||maxLines<1) fail('WRAP_ARGUMENT','Invalid text-wrap arguments.');
  const lines=[];
  for(const paragraph of text.split('\n')){
    if(paragraph===''){ lines.push(''); continue; }
    let line='';
    for(const char of codePoints(paragraph)){
      if(checkedWidth(line+char,measureTextMm)<=maxWidthMm){ line+=char; continue; }
      if(!line||checkedWidth(char,measureTextMm)>maxWidthMm) fail('TEXT_FIT','A glyph cannot fit within the usable card text width.');
      lines.push(line); line=char;
    }
    lines.push(line);
  }
  if(lines.length>maxLines) fail('TEXT_FIT',`Text needs ${lines.length} lines; the limit is ${maxLines}.`);
  return Object.freeze(lines);
}

function numberMm(value,name){
  if(value===''||value===null||typeof value==='boolean') fail('OFFSET_NUMBER',`${name} must be a finite number.`);
  const n=typeof value==='number'?value:Number(value);
  if(!Number.isFinite(n)) fail('OFFSET_NUMBER',`${name} must be a finite number.`);
  if(n < -LIMITS.offsetMm || n > LIMITS.offsetMm) fail('OFFSET_RANGE',`${name} must be between -5 and 5 mm.`);
  return Object.is(n,-0)?0:n;
}
function paperLayout(paper){
  const page=PAPER[paper]; if(!page) fail('PAPER','Paper must be A4 or LETTER.');
  const width=(page.width-2*LIMITS.marginMm-LIMITS.gapMm)/2;
  const height=(page.height-2*LIMITS.marginMm-3*LIMITS.gapMm)/4;
  return Object.freeze({...page,cellWidth:width,cellHeight:height});
}
function physicalIndexForBack(slot,flip){
  const row=Math.floor(slot/2),column=slot%2;
  if(flip==='LONG_EDGE') return row*2+(1-column);
  if(flip==='SHORT_EDGE') return (3-row)*2+column;
  fail('FLIP','Flip must be LONG_EDGE or SHORT_EDGE.');
}
function deepFreeze(value){
  if(value&&typeof value==='object'&&!Object.isFrozen(value)){ Object.freeze(value); for(const item of Object.values(value)) deepFreeze(item); }
  return value;
}

export function createPlan(raw){
  if(!raw||typeof raw!=='object'||Array.isArray(raw)) fail('PLAN_OBJECT','Plan input must be an object.');
  const cards=parseCardTable(raw.input,{delimiter:raw.delimiter,header:raw.header});
  const layout=paperLayout(raw.paper);
  if(!['LONG_EDGE','SHORT_EDGE'].includes(raw.flip)) fail('FLIP','Flip must be LONG_EDGE or SHORT_EDGE.');
  if(typeof raw.measured!=='boolean') fail('MEASURED_FLAG','Measured must be true or false.');
  if(raw.measured&&raw.measurementView!=='BACK_TOP_UPRIGHT') fail('MEASUREMENT_VIEW','Measured offsets must be recorded in BACK view with TOP upright.');
  const observedX=numberMm(raw.observedX,'Observed X'), observedY=numberMm(raw.observedY,'Observed Y');
  if((observedX!==0||observedY!==0)&&!raw.measured) fail('MEASUREMENT_REQUIRED','A nonzero correction requires explicit measured confirmation.');
  const correction=Object.freeze({x:-observedX,y:-observedY});
  if(raw.measureTextMm!==undefined&&typeof raw.measureTextMm!=='function') fail('MEASURE_CALLBACK','measureTextMm must be a function when supplied.');
  const measureTextMm=raw.measureTextMm??conservativeMeasureTextMm;
  const usableTextWidthMm=layout.cellWidth-2*TEXT_STYLE.horizontalInsetMm;
  const wrapOptions={maxWidthMm:usableTextWidthMm,measureTextMm,maxLines:LIMITS.maxLines};
  const fitted=cards.map(card=>Object.freeze({...card,frontLines:wrapCardText(card.front,wrapOptions),backLines:wrapCardText(card.back,wrapOptions)}));
  const sheets=[];
  for(let start=0;start<fitted.length;start+=8){
    const chunk=fitted.slice(start,start+8),frontSlots=Array(8).fill(null),backSlots=Array(8).fill(null);
    chunk.forEach((card,index)=>{ frontSlots[index]=card; backSlots[physicalIndexForBack(index,raw.flip)]=card; });
    sheets.push({number:sheets.length+1,frontSlots,backSlots});
  }
  return deepFreeze({
    schemaVersion:1,cards:fitted,paper:raw.paper,flip:raw.flip,measured:raw.measured,measurementView:raw.measured?'BACK_TOP_UPRIGHT':null,
    observed:Object.freeze({x:observedX,y:observedY}),correction,layout,sheets,
    textLayout:Object.freeze({...TEXT_STYLE,usableTextWidthMm,measurement:raw.measureTextMm?'CALLER_MEASURED':'CONSERVATIVE_FALLBACK'}),
    declarations:Object.freeze({physicalAlignmentGuaranteed:false,constantTranslationOnly:true,scalePercent:100})
  });
}

const xml=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;').replaceAll('\t','&#9;');
const mm=n=>Number(n.toFixed(4));
function slotGeometry(index,layout){
  const row=Math.floor(index/2),column=index%2;
  return {x:LIMITS.marginMm+column*(layout.cellWidth+LIMITS.gapMm),y:LIMITS.marginMm+row*(layout.cellHeight+LIMITS.gapMm)};
}
function cardContent(card,index,side,layout){
  if(!card) return '';
  const {x,y}=slotGeometry(index,layout),lines=side==='FRONT'?card.frontLines:card.backLines;
  const lineHeight=6.2,total=(lines.length-1)*lineHeight,first=y+layout.cellHeight/2-total/2;
  const tspans=lines.map((line,i)=>`<tspan x="${mm(x+layout.cellWidth/2)}" y="${mm(first+i*lineHeight)}">${xml(line)}</tspan>`).join('');
  return `<g class="card-content" data-card-id="${card.id}"><text class="card-id" x="${mm(x+4)}" y="${mm(y+6)}">${card.id}</text><text class="card-text" xml:space="preserve" text-anchor="middle">${tspans}</text></g>`;
}
function pageSvg(plan,sheetIndex,side){
  const sheet=plan.sheets[sheetIndex]; if(!sheet) fail('SHEET_INDEX','Sheet index is outside the plan.');
  const slots=side==='FRONT'?sheet.frontSlots:side==='BACK'?sheet.backSlots:null; if(!slots) fail('SIDE','Side must be FRONT or BACK.');
  const guides=side==='FRONT'?`<g class="cut-guides">${Array.from({length:8},(_,i)=>{ const {x,y}=slotGeometry(i,plan.layout); return `<rect x="${mm(x)}" y="${mm(y)}" width="${mm(plan.layout.cellWidth)}" height="${mm(plan.layout.cellHeight)}"/>`; }).join('')}</g>`:'';
  const cards=slots.map((card,i)=>cardContent(card,i,side,plan.layout)).join('');
  const transform=side==='BACK'?` transform="translate(${mm(plan.correction.x)} ${mm(plan.correction.y)})"`:'';
  const note=side==='BACK'?`BACK · top upright · correction ${plan.correction.x} mm X, ${plan.correction.y} mm Y`:'FRONT · top upright';
  return `<svg class="print-page" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${plan.layout.width} ${plan.layout.height}" width="${plan.layout.width}mm" height="${plan.layout.height}mm" role="img" aria-label="${side} sheet ${sheet.number}"><text class="page-note" x="${LIMITS.marginMm}" y="9">${xml(note)} · sheet ${sheet.number}/${plan.sheets.length}</text>${guides}<g class="${side.toLowerCase()}-card-group"${transform}>${cards}</g></svg>`;
}
export function renderSheetSvg(plan,sheetIndex,side){ return pageSvg(plan,sheetIndex,side); }

function packetCss(paper){
  const p=PAPER[paper];
  return `@page{size:${p.width}mm ${p.height}mm;margin:0}*{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff;color:#102b3f;font-family:Arial,"DejaVu Sans",sans-serif}.packet-note{padding:8mm;font:12px/1.45 Arial,sans-serif}.print-page{display:block;width:${p.width}mm;height:${p.height}mm;break-after:page;page-break-after:always;background:#fff}.print-page:last-child{break-after:auto;page-break-after:auto}.cut-guides{fill:none;stroke:#6a7d86;stroke-width:.25;stroke-dasharray:2 1}.card-id{font-size:3.2px;fill:#567;font-family:Arial,"DejaVu Sans",sans-serif}.card-text{font-size:${TEXT_STYLE.fontSizeUserUnits}px;fill:#102b3f;font-family:${TEXT_STYLE.fontFamily}}.page-note{font-size:3px;fill:#345;font-family:Arial,"DejaVu Sans",sans-serif}@media print{.packet-note{display:none}}`;
}
function documentShell(title,paper,body){
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"><meta name="robots" content="noindex,nofollow"><title>${xml(title)}</title><style>${packetCss(paper)}</style></head><body>${body}</body></html>`;
}
export function buildCardPacketHtml(plan){
  const pages=plan.sheets.flatMap((_,index)=>[pageSvg(plan,index,'FRONT'),pageSvg(plan,index,'BACK')]).join('');
  const edge=plan.flip==='LONG_EDGE'?'long edge':'short edge';
  const measured=plan.measured?'measured back-view correction':'UNMEASURED / no correction';
  const note=`<section class="packet-note"><h1>Duplex flashcard packet</h1><p>${plan.cards.length} cards · ${plan.sheets.length} physical sheets · ${xml(plan.layout.name)} portrait · flip ${edge} · ${measured}.</p><p>Print at 100% / actual size with browser headers and footers off. Keep the same paper, driver, scale and feed used for calibration. This file applies a constant translation only; it cannot repair skew, rotation, scale or variable feed. Test plain paper before a batch. Physical alignment is not guaranteed.</p></section>`;
  return documentShell('Duplex flashcard packet',plan.paper,note+pages);
}

export function formatPlanSummary(plan){
  const state=plan.measured?`MEASURED BACK view · correction ${plan.correction.x} mm X / ${plan.correction.y} mm Y`:'UNMEASURED · no correction';
  return `${plan.cards.length} cards · ${plan.sheets.length} sheets · ${state}`;
}

function calibrationPage(paper,side){
  const p=PAPER[paper],points=[[35,45],[p.width-35,45],[35,p.height-45],[p.width-35,p.height-45]];
  const marks=points.map(([x,y],i)=>side==='FRONT'
    ? `<g data-mark="${i+1}"><path d="M ${x-6} ${y} H ${x+6} M ${x} ${y-6} V ${y+6}"/><circle cx="${x}" cy="${y}" r="1"/></g>`
    : `<g data-mark="${i+1}"><circle cx="${x}" cy="${y}" r="6"/><circle cx="${x}" cy="${y}" r="1"/></g>`).join('');
  return `<svg class="print-page calibration" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${p.width} ${p.height}" width="${p.width}mm" height="${p.height}mm" role="img" aria-label="Calibration ${side}"><style>.calibration path,.calibration circle{fill:none;stroke:#102b3f;stroke-width:.45}.calibration text{fill:#102b3f;font-family:Arial,sans-serif}</style><text x="15" y="13" font-size="6">${side} · TOP ↑ · UN-SHIFTED</text>${marks}<path d="M 15 ${p.height-18} H 65"/><path d="M 15 ${p.height-21} V ${p.height-15} M 65 ${p.height-21} V ${p.height-15}"/><text x="15" y="${p.height-9}" font-size="4">50 mm reference — measure before using offsets</text></svg>`;
}
export function buildCalibrationHtml({paper='A4',flip='LONG_EDGE'}={}){
  if(!PAPER[paper]) fail('PAPER','Paper must be A4 or LETTER.');
  if(!['LONG_EDGE','SHORT_EDGE'].includes(flip)) fail('FLIP','Flip must be LONG_EDGE or SHORT_EDGE.');
  const edge=flip==='LONG_EDGE'?'long edge':'short edge';
  const note=`<section class="packet-note"><h1>Unshifted duplex calibration pair</h1><p>Two pages, zero offset, ${xml(PAPER[paper].name)} portrait, flip ${edge}. No card data is included.</p><ol><li>Print at 100% / actual size with headers and footers off.</li><li>Use the same paper, feed, driver and flip setting planned for the cards.</li><li>Look at the BACK with its TOP marker upright against light. Record where each BACK ring sits relative to its FRONT cross: right is positive X; down is positive Y.</li><li>Use a constant offset only when the displacement is reasonably consistent. Variation across corners or sheets may require printer calibration or a different workflow.</li></ol><p>This packet has not been physically printed or verified.</p></section>`;
  return documentShell('Unshifted duplex calibration pair',paper,note+calibrationPage(paper,'FRONT')+calibrationPage(paper,'BACK'));
}

export {LIMITS,PAPER,TEXT_STYLE};
