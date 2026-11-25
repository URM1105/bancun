/* =========================================================
   半寸 · 应用逻辑
   数据全部存于本机 localStorage，不上传
   ========================================================= */
(function(){
'use strict';

/* ---------- 常量与体型配置 ---------- */
const STORE_KEY = 'bancun_v1';
const BODY_TYPES = {
  pear:      { name:'梨型',   desc:'臀腿更丰满，上身纤细' },
  apple:     { name:'苹果型', desc:'腰腹集中，四肢偏细' },
  hourglass: { name:'沙漏型', desc:'腰细，胸臀曲线明显' },
  rectangle: { name:'矩形',   desc:'肩腰臀接近，线条平直' },
  mixed:     { name:'混合型', desc:'兼具两种体型特征' }
};
// 各体型在"基线"上的轮廓参数（半宽，单位相对视图），用于SVG绘制
// shoulder 肩 / bust 胸 / waist 腰 / hip 臀 / thigh 大腿
const BASE = {
  pear:      { shoulder:34, bust:33, waist:28, hip:47, thigh:30 },
  apple:     { shoulder:38, bust:40, waist:44, hip:38, thigh:27 },
  hourglass: { shoulder:36, bust:40, waist:25, hip:44, thigh:29 },
  rectangle: { shoulder:37, bust:35, waist:34, hip:36, thigh:27 },
  mixed:     { shoulder:36, bust:37, waist:32, hip:41, thigh:28 }
};
// 减重时各部位缩小权重（决定"变化最大部位"与形态）
const WEIGHT = {
  pear:      { waist:.55, hip:1.0,  thigh:.85 },
  apple:     { waist:1.0, hip:.55, thigh:.45 },
  hourglass: { waist:.95, hip:.85, thigh:.6  },
  rectangle: { waist:.8,  hip:.7,  thigh:.55 },
  mixed:     { waist:.85, hip:.85, thigh:.7  }
};
const PART_LABEL = { waist:'腰腹', hip:'臀部', thigh:'大腿' };
const MAX_LOSS = 4; // kg / 30天

/* ---------- 体重变化 → 各部位相对变化(由合成训练数据拟合,见 fit_body_model.py / body_model.json) ----------
   rel = a*L + b*L*(BMI-21)/5,L 为体重变化(kg,减重为负);rel 为周长/宽度的相对变化(如 -0.06 = 缩小 6%)。
   注意:训练数据是合成的,模型反映的是生成时的假设,不是真实人体测量;其中胸围偏大,仅供参考。 */
const BODY_MODEL = {"v":1,"bmiRef":21,"src":"synthetic","types":{
  "pear":{"bust":[0.0143,-0.00254],"waist":[0.01476,-0.00342],"hip":[0.00717,-0.00071],"thigh":[0.00865,-0.00138],"calf":[0.00766,-0.00108]},
  "apple":{"bust":[0.01359,-0.00198],"waist":[0.02011,-0.00321],"hip":[0.00516,-0.00079],"thigh":[0.00719,-0.00148],"calf":[0.00642,-0.00115]},
  "hourglass":{"bust":[0.01455,-0.0018],"waist":[0.0132,-0.00322],"hip":[0.00704,-0.00081],"thigh":[0.00847,-0.00156],"calf":[0.00764,-0.00117]},
  "rectangle":{"bust":[0.01414,-0.00205],"waist":[0.01505,-0.00322],"hip":[0.00655,-0.00087],"thigh":[0.00875,-0.00174],"calf":[0.00756,-0.00131]},
  "mixed":{"bust":[0.01391,-0.00184],"waist":[0.01635,-0.00344],"hip":[0.00648,-0.00078],"thigh":[0.00826,-0.00144],"calf":[0.00725,-0.00106]}}};
const VIS_GAIN = 2.5;   // 示意放大倍数:真实变化很小,放大后才看得清;界面必须同时标注"实际变化更小"
function relChange(bt,lm,loss,bmi){
  const t=(BODY_MODEL.types[bt]||BODY_MODEL.types.mixed)[lm]; if(!t||!loss) return 0;
  const b=Math.max(15,Math.min(40,bmi||BODY_MODEL.bmiRef));
  return t[0]*loss + t[1]*loss*(b-BODY_MODEL.bmiRef)/5;
}

/* ---------- 数据层 ---------- */
function defaultData(){
  return {
    version:1,
    createdAt: Date.now(),
    profile:null,           // {height,weight,waist,hip,thigh,bodyType,bmiTier}
    agreed:false,
    records:[],             // {date,weight,waist,hip,thigh,calf,diet,period}
    snapshots:[],           // {id,date,bodyType,loss,gain,bmi}：只存参数,显示时再画,不存 SVG
    settings:{ reminder:{enabled:false,time:'08:00',last:''}, periodDefault:false },
    guest:true
  };
}

/* 转义：所有拼进 HTML 的用户文字都必须经过这一层 */
function esc(s){
  return String(s==null?'':s).replace(/[&<>"']/g,function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; });
}
/* 数字校验：返回范围内的数字,否则 null */
function numIn(v,lo,hi){
  const n=typeof v==='number'?v:parseFloat(v);
  return (isFinite(n)&&n>=lo&&n<=hi)?n:null;
}
const RANGE={ height:[80,250], weight:[20,300], waist:[30,200], hip:[40,200], thigh:[20,120], calf:[15,80] };

/* 日期一律用本地时间(之前用 UTC,东八区 0–8 点会记到前一天) */
function ymd(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function today(){ return ymd(new Date()); }
function validDate(s){
  if(typeof s!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d=new Date(s+'T00:00:00'); return !isNaN(d.getTime()) && ymd(d)===s;
}
function fmtDate(s){ if(!validDate(s)) return ''; const p=s.split('-'); return (+p[1])+'月'+(+p[2])+'日'; }

/* 读入数据的唯一入口：本地存储和备份恢复都先经过这里。
   结构不对返回 null(调用方据此拒绝),字段不合法的单条记录会被丢弃,不会让应用崩溃。 */
function sanitizeData(d){
  if(!d||typeof d!=='object'||Array.isArray(d)||!Array.isArray(d.records)) return null;
  const out=defaultData();
  out.createdAt=numIn(d.createdAt,0,4102444800000)||out.createdAt;
  out.agreed=d.agreed===true;
  out.guest=d.guest!==false;
  if(d.profile!=null){
    const p=d.profile;
    if(typeof p!=='object'||Array.isArray(p)) return null;
    const h=numIn(p.height,RANGE.height[0],RANGE.height[1]); if(h==null) return null;
    const w=numIn(p.weight,RANGE.weight[0],RANGE.weight[1]);
    out.profile={ height:h, weight:w,
      waist:numIn(p.waist,RANGE.waist[0],RANGE.waist[1]), hip:numIn(p.hip,RANGE.hip[0],RANGE.hip[1]), thigh:numIn(p.thigh,RANGE.thigh[0],RANGE.thigh[1]),
      bodyType:BODY_TYPES[p.bodyType]?p.bodyType:'rectangle', tier:tierOf(w,h) };
  }
  const seen={};
  d.records.forEach(function(r){
    if(!r||typeof r!=='object'||!validDate(r.date)) return;
    const w=numIn(r.weight,RANGE.weight[0],RANGE.weight[1]); if(w==null) return;
    const o={date:r.date,weight:w};
    ['waist','hip','thigh','calf'].forEach(function(k){ const v=numIn(r[k],RANGE[k][0],RANGE[k][1]); if(v!=null) o[k]=v; });
    o.diet=typeof r.diet==='string'?r.diet.slice(0,500):'';
    o.period=r.period===true;
    seen[r.date]=o;                       // 同一天只留最后一条
  });
  out.records=Object.keys(seen).sort().map(function(k){ return seen[k]; });
  if(Array.isArray(d.snapshots)) d.snapshots.forEach(function(s,i){
    if(!s||typeof s!=='object'||!BODY_TYPES[s.bodyType]||!validDate(s.date)) return;
    const loss=numIn(s.loss,-MAX_LOSS,0); if(loss==null) return;
    // 身材尺度(可选)：六个系数都是 0.5–2 之间的数才保留,否则丢弃,显示时回到体型基本形态
    let sc=null;
    if(s.sc&&typeof s.sc==='object'){
      const t={}; let ok=true;
      ['shoulder','bust','waist','hip','thigh','calf'].forEach(function(k){ const v=numIn(s.sc[k],0.5,2); if(v==null) ok=false; else t[k]=v; });
      if(ok) sc=t;
    }
    out.snapshots.push({ id:numIn(s.id,0,9e15)||(Date.now()+i), date:s.date, bodyType:s.bodyType, loss:loss,
      gain:numIn(s.gain,1,5)||VIS_GAIN, bmi:numIn(s.bmi,15,40), sc:sc });
  });
  const rm=d.settings&&d.settings.reminder;
  if(rm&&typeof rm==='object'){
    out.settings.reminder={ enabled:rm.enabled===true,
      time:(typeof rm.time==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(rm.time))?rm.time:'08:00',
      last:validDate(rm.last)?rm.last:'' };
  }
  out.settings.periodDefault=!!(d.settings&&d.settings.periodDefault);
  return out;
}

let DATA = load();
function load(){
  let raw=null;
  try{
    raw = localStorage.getItem(STORE_KEY);
    if(!raw) return defaultData();
    const clean = sanitizeData(JSON.parse(raw));
    if(clean) return clean;
  }catch(e){}
  // 本地数据损坏：留一份副本方便找回,再用空白数据启动,避免应用无法打开
  try{ if(raw) localStorage.setItem(STORE_KEY+'_corrupt_'+Date.now(), raw); }catch(e){}
  return defaultData();
}
function save(){
  try{ localStorage.setItem(STORE_KEY, JSON.stringify(DATA)); }
  catch(e){ toast('保存失败，请检查浏览器存储权限','err'); }
}

/* BMI 档位：内部用 tier，界面用友好名称 */
function bmiOf(weight,heightCm){
  if(!weight||!heightCm) return null;
  const h = heightCm/100;
  return weight/(h*h);
}
function tierOf(weight,heightCm){
  const bmi = bmiOf(weight,heightCm);
  if(bmi==null) return 'unknown';
  if(bmi<18.5) return 'low';
  if(bmi<24) return 'normal';
  if(bmi<28) return 'high';
  return 'higher';
}
const TIER_NAME = { low:'偏低体重范围', normal:'常规体重范围', high:'略高体重范围', higher:'偏高体重范围', unknown:'未填写' };

/* 当前 BMI(用最近体重 + 身高;缺一则返回 null,绘图时按参考值 21 处理) */
function curBmi(){
  const p=DATA.profile||{};
  return bmiOf(latestWeight(), p.height) || null;
}
/* 30 天内可设定的减重幅度上限：既不超过 MAX_LOSS,也不超过"每周体重的 1.5%"(数据集里的护栏线);
   超过每周 1% 时提示偏快。未填体重则只用 MAX_LOSS。 */
function lossCap(){
  const w=latestWeight();
  if(!w) return { cap:MAX_LOSS, soft:null, byWeight:false };
  const hard=Math.floor(Math.min(MAX_LOSS, 0.015*w*30/7)*2)/2;
  return { cap:Math.max(0.5,hard), soft:0.010*w*30/7, byWeight:hard<MAX_LOSS };
}

/* ---------- 身材尺度：同样的体重,身高、体型、围度不同,身形就不同 ----------
   模板轮廓代表"参考体型"(BMI 21、身高 160、体型居中)。每个部位的缩放系数 = 你的周长/身高 ÷ 参考的周长/身高:
   · 填过围度:用你最近一次填的围度,并按体重(BMI)的变化折算到现在;
   · 没填围度:用体型的基本形态,再按你的 BMI 估算。
   所以只填体重也会更新轮廓(BMI 变了),而身高、体型、围度决定它从哪里开始。
   各部位周长随 BMI 变化的斜率来自合成数据,仅作估算。 */
const EST={ bust:[82,1.5], waist:[69,2.3], hip:[92,1.7], thigh:[53,1.0], calf:[34,0.45] };   // [BMI 21 的参考周长 cm, BMI 每增加 1 的周长增加 cm]
const EST_ADJ={
  pear:{bust:-5,waist:-2,hip:5,thigh:3,calf:0}, apple:{bust:2,waist:5,hip:-2,thigh:-2,calf:0},
  hourglass:{bust:4,waist:-4,hip:4,thigh:1,calf:0}, rectangle:{bust:0,waist:1,hip:-1,thigh:-1,calf:0},
  mixed:{bust:0,waist:0,hip:0,thigh:0,calf:0}
};
function clamp(v,lo,hi){ return Math.max(lo,Math.min(hi,v)); }
/* 没有任何围度记录时,按身高、BMI、体型估算周长(cm) */
function estCirc(k,bt,bmi,height){
  const a=(EST_ADJ[bt]||EST_ADJ.mixed)[k];
  return (EST[k][0]+EST[k][1]*(clamp(bmi||21,15,40)-21)+a)*((height||160)/160);
}
/* BMI 从 then 变到 now,该部位周长的变化倍数 */
function bmiGrowth(k,now,then){
  const f=function(b){ return EST[k][0]+EST[k][1]*(clamp(b||21,15,40)-21); };
  return f(now)/f(then);
}
/* 最近一次填写的某部位围度,以及填写当时的 BMI */
function lastGirth(k){
  const p=DATA.profile||{};
  for(let i=DATA.records.length-1;i>=0;i--){
    const r=DATA.records[i];
    if(r[k]) return { c:r[k], bmi:bmiOf(r.weight,p.height) };
  }
  if(p[k]) return { c:p[k], bmi:bmiOf(p.weight||latestWeight(),p.height) };
  return null;
}
/* 轮廓缩放系数。opt: {height,bmi,noMeasured}(引导页预览体型时不带围度) */
function bodyScale(bt,opt){
  opt=opt||{};
  const p=DATA.profile||{};
  const h=opt.height||p.height||160, now=opt.bmi||curBmi()||21;
  const mods=TPL.mods[bt]||TPL.mods.mixed, s={};
  ['bust','waist','hip','thigh','calf'].forEach(function(k){
    let f=null;
    if(!opt.noMeasured){
      const m=lastGirth(k);
      if(m&&m.bmi) f=(m.c*bmiGrowth(k,now,m.bmi)/h)/(EST[k][0]/160);   // 实测围度,折算到现在的体重
    }
    if(f==null) f=mods[k]*bmiGrowth(k,now,21);                          // 没填围度:体型形态 × BMI
    s[k]=+clamp(f,0.6,1.7).toFixed(3);
  });
  s.shoulder=+clamp(mods.shoulder*(1+0.35*(bmiGrowth('bust',now,21)-1)),0.85,1.2).toFixed(3);   // 肩宽随体重变化更小
  return s;
}
/* 当前轮廓是否参考了实测围度(用于界面说明) */
function hasMeasured(){ return !!(lastGirth('waist')||lastGirth('hip')||lastGirth('thigh')); }

/* 取最近有效体重 */
function latestWeight(){
  for(let i=DATA.records.length-1;i>=0;i--){
    if(DATA.records[i].weight) return DATA.records[i].weight;
  }
  return DATA.profile && DATA.profile.weight ? DATA.profile.weight : null;
}
function recommendedBodyType(waist,hip){
  if(!waist||!hip) return null;
  const r = waist/hip;
  if(r<=0.68) return 'hourglass';
  if(r<=0.76) return 'pear';
  if(r<=0.84) return 'mixed';
  if(r<=0.92) return 'rectangle';
  return 'apple';
}
function waistHipText(waist,hip){
  if(!waist||!hip) return '';
  const r=(waist/hip).toFixed(2);
  let t='较接近混合型';
  const rec=recommendedBodyType(waist,hip);
  if(rec) t=`较接近${BODY_TYPES[rec].name}`;
  return `你的腰臀比为 ${r}，${t}。`;
}

/* ---------- 温柔话术 ---------- */
function gentleTalk(ctx){
  // ctx: {count, tier, bodyType, part, loss, days}
  const n = ctx.count||0;
  if(ctx.tier==='low'){
    return '你的身体已经很轻盈了，比起数字，更想听听身体的感受。如有需要，可以找专业的人聊聊。';
  }
  if(n<3){
    return '每一次记录都是和自己的温柔约定。先记下来，变化会慢慢被看见。';
  }
  const part = PART_LABEL[ctx.part]||'腰腹';
  if(ctx.days>=7 && ctx.loss===0){
    return `你已经连续记录了 ${ctx.days} 天，这份稳定本身就值得被肯定。身体有自己的节奏。`;
  }
  if(ctx.loss===0){
    return '维持也是一种照顾自己的方式。记录着，就已经在向前。';
  }
  const map = {
    pear:`按梨型的特征推演，${part}的变化会相对明显一些。这是一份参考，不必急着对照。`,
    apple:`按苹果型的特征推演，${part}会先有回应。慢慢来，你的身体有自己的节奏。`,
    hourglass:`按沙漏型的特征推演，${part}的变化会更易察觉。保持记录就很了不起。`,
    rectangle:`按矩形体型的特征推演，${part}会有细微变化。给自己多一点时间。`,
    mixed:`按体型特征推演，${part}会有一点回应。这是一份温柔的参考。`
  };
  return map[ctx.bodyType] || '这是一份温柔的参考，你的身体有自己的节奏。';
}

/* ---------- 人体轮廓引擎：参考图实测剪影(密集点) + 体型/减重驱动的宽度修正 + 平滑样条 ----------
   模板点从参考图(服装制版女模板)的外轮廓提取,单位为"占身高百分比",每点 [高度 v, 半宽 u]。
   一条连续外轮廓：颈 → 肩 → 手臂外缘 → 手 → 手臂内缘 → 腋 → 躯干 → 腿外缘 → 脚 → 腿内缘 → 裆,再镜像;
   头单独成一条闭合曲线。体型修正与减重变化都按"高度"在胸/腰/臀/大腿/小腿之间平滑插值,
   所以曲线不会出现手调关键点时的折角和波浪;手臂只在被躯干挤到时才外移。
   保持 PRD 边界：不画面部五官、不画服装、不做写实人像。 */
const TPL = {
  head:[[0.0,0.12],[0.2,1.39],[0.9,2.50],[2.0,3.23],[3.2,3.57],[4.5,3.71],[5.7,3.99],[6.9,3.56],[8.0,2.94]],
  shoulderChain:[[10.8,2.00],[12.8,2.21],[14.4,3.32],[15.1,5.13],[15.3,7.10],[16.3,8.79],[18.1,9.53]],
  armOuter:[[21.4,9.74],[24.6,9.83],[27.9,10.06],[31.1,10.42],[34.3,11.07],[37.5,11.41],[40.7,11.41],[44.0,11.41]],
  hand:[[45.8,11.75],[47.6,12.19],[49.4,12.47],[51.1,11.81],[52.4,10.63],[53.0,9.01],[51.2,9.17],[49.5,8.82],[47.6,8.82],[45.8,9.24]],
  armInner:[[25.2,6.47],[27.3,6.66],[29.4,6.91],[31.5,7.13],[33.6,7.27],[35.7,7.58],[37.8,8.04],[39.8,8.50],[41.9,8.92],[44.0,9.29]],
  torsoSide:[[25.2,6.47],[27.3,5.98],[29.4,5.67],[31.5,5.39],[33.7,5.68],[35.6,6.54],[37.7,7.30],[39.7,7.79],[41.9,8.09],[44.0,8.17],[46.2,8.18],[48.4,8.12],[50.5,7.91],[52.7,7.70],[54.8,7.34],[56.9,7.01],[59.1,6.75],[61.2,6.54],[63.4,6.47],[65.5,6.32],[67.7,6.34],[69.8,6.47],[72.0,6.61],[74.1,6.71],[76.3,6.75],[78.4,6.71],[80.6,6.47],[82.7,6.08],[84.8,5.63],[86.9,5.22],[89.1,4.80],[91.2,4.65],[93.3,4.91],[95.4,5.41],[97.5,6.09],[99.5,5.76]],
  legInner:[[46.1,0.00],[48.6,0.57],[51.1,0.88],[53.7,1.06],[56.2,1.13],[58.7,1.29],[61.3,1.29],[63.8,1.29],[66.4,1.58],[68.9,1.92],[71.4,1.99],[73.9,1.76],[76.5,1.76],[79.0,1.79],[81.6,2.00],[84.1,2.20],[86.6,2.24],[89.2,2.05],[91.7,2.00],[94.3,1.87],[96.8,1.66],[99.3,1.76]],
  // 体型相对参考图(= 混合型 = 1)的宽度乘数
  mods:{
    pear:      {shoulder:.95,bust:.92,waist:1.06,hip:1.10,thigh:1.14,calf:1.05},
    apple:     {shoulder:1.03,bust:1.08,waist:1.32,hip:.96,thigh:.95,calf:.95},
    hourglass: {shoulder:.99,bust:1.08,waist:.88,hip:1.07,thigh:1.04,calf:1.00},
    rectangle: {shoulder:1.00,bust:1.02,waist:1.26,hip:.95,thigh:.93,calf:.95},
    mixed:     {shoulder:1.00,bust:1.00,waist:1.00,hip:1.00,thigh:1.00,calf:1.00}
  },
  // 各部位在参考图中的高度(来自剪影:腋 25.2 / 腰最细 31.5 / 臀最宽 46 / 小腿最粗 76)
  keyY:{shoulder:18.1,bust:26,waist:32,hip:46,thigh:58,calf:76}
};
const VIEW={w:240,h:620,cx:120,top:30,H:560};
const ARM_GAP=0.45;   // 手臂内缘与躯干的最小间距(参考图中约 0.6)
function py(y){ return VIEW.top + y/100*VIEW.H; }
function px(x){ return x/100*VIEW.H; }   // x 为"占身高"比例的半宽
function interp(y,rows){
  if(y<=rows[0][0]) return rows[0][1];
  if(y>=rows[rows.length-1][0]) return rows[rows.length-1][1];
  for(let i=0;i<rows.length-1;i++){
    if(y>=rows[i][0]&&y<=rows[i+1][0]){
      const t=(y-rows[i][0])/(rows[i+1][0]-rows[i][0]);
      return rows[i][1]*(1-t)+rows[i+1][1]*t;
    }
  }
  return 1;
}
let _figBmi=21, _figGain=1, _figScale=null;
// 体型乘数：按高度在 肩/胸/腰/臀/大腿/小腿 之间平滑插值。传入 scale(身材尺度)时用它,否则用体型的基本形态
function typeMul(y,bt){
  const mk=_figScale||TPL.mods[bt]||TPL.mods.mixed, K=TPL.keyY;
  return interp(y,[[10,1],[K.shoulder,mk.shoulder],[K.bust,mk.bust],[K.waist,mk.waist],[K.hip,mk.hip],[K.thigh,mk.thigh],[K.calf,mk.calf],[92,1]]);
}
// 减重乘数：胸/腰/臀/大腿/小腿五处取拟合模型的相对变化,按高度插值(肩及以上为 0)
function lossMul(y,bt,loss){
  if(!loss) return 1;
  const K=TPL.keyY, r=function(k){ return relChange(bt,k,loss,_figBmi); };
  return 1+_figGain*interp(y,[[K.shoulder,0],[K.bust,r('bust')],[K.waist,r('waist')],[K.hip,r('hip')],[K.thigh,r('thigh')],[K.calf,r('calf')],[92,r('calf')*0.5]]);
}
// 模板点 [v,u] → 屏幕点 [X,Y]；sign=±1 镜像；躯干/腿/颈肩应用体型与减重修正
function tplPts(arr,bt,loss,sign){
  return arr.map(function(a){
    return [VIEW.cx + sign*px(a[1]*typeMul(a[0],bt)*lossMul(a[0],bt,loss)), py(a[0])];
  });
}
// 单调 Catmull-Rom → 三次贝塞尔：过关键点、连续平滑、无折线段
function smoothPath(pts,closed){
  if(pts.length<2) return '';
  const n=pts.length;
  const at=i=>closed?pts[((i%n)+n)%n]:pts[Math.max(0,Math.min(n-1,i))];
  let d=`M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  const segs=closed?n:n-1;
  for(let i=0;i<segs;i++){
    const p0=at(i-1),p1=at(i),p2=at(i+1),p3=at(i+2);
    const c1x=p1[0]+(p2[0]-p0[0])/6, c1y=p1[1]+(p2[1]-p0[1])/6;
    const c2x=p2[0]-(p3[0]-p1[0])/6, c2y=p2[1]-(p3[1]-p1[1])/6;
    d+=` C ${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  if(closed) d+=' Z';
  return d;
}
function figureSVG(opt){
  opt=opt||{};
  const bt=opt.bodyType||'rectangle';
  const loss=Math.min(0,Math.max(-MAX_LOSS,opt.loss||0));
  const stroke=opt.stroke||'#5b7a6b';
  const op=opt.opacity!=null?opt.opacity:1;
  _figBmi=opt.bmi||BODY_MODEL.bmiRef;                 // 用户 BMI(没有则取参考值 21)
  _figGain=opt.gain!=null?opt.gain:1;                 // 示意放大倍数(默认 1 = 按模型原样)
  _figScale=opt.scale||null;                          // 身材尺度(由身高/BMI/体型/围度算出),没有则用体型基本形态
  const cx=VIEW.cx;
  const dashAttr=opt.dash?' stroke-dasharray="4 3"':'';   // 叠加对比时,"当前"用虚线
  const line =`fill="none" stroke="${stroke}" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round" opacity="${op}"${dashAttr}`;
  const thin =`fill="none" stroke="${stroke}" stroke-width="0.7" stroke-linecap="round" opacity="${op*0.5}"`;
  const gd   =`fill="none" stroke="#b9c4bc" stroke-width="0.5" stroke-dasharray="3 4" opacity="${op*0.5}"`;
  let s='';

  /* 淡辅助虚线：中线、胸/腰/臀/膝水平线、腿中线;叠加对比的底图不画 */
  if(!opt.noGuides){
    s+=`<line x1="${cx}" y1="${py(12.5)}" x2="${cx}" y2="${py(46)}" ${gd}/>`;
    [[26,46],[32,40],[46,52],[66,40]].forEach(function(l){
      s+=`<line x1="${cx-l[1]}" y1="${py(l[0])}" x2="${cx+l[1]}" y2="${py(l[0])}" ${gd}/>`;
    });
    [-1,1].forEach(function(sg){
      const x=cx+sg*px(4.2);
      s+=`<line x1="${x}" y1="${py(50)}" x2="${x}" y2="${py(92)}" ${gd}/>`;
    });
  }

  /* 头：单层闭合曲线(由参考图头部轮廓 + 下颌弧),无外部帽状轮廓、无五官 */
  const hp=function(sg){ return TPL.head.map(function(a){ return [cx+sg*px(a[1]), py(a[0])]; }); };
  const chin=[[8.8,2.85],[9.9,2.35],[10.8,1.5],[11.4,0.75]];      // 下颌圆弧(参考图被颈部遮住的部分)
  const cl=chin.map(function(a){ return [cx-px(a[1]), py(a[0])]; });
  const cr=chin.map(function(a){ return [cx+px(a[1]), py(a[0])]; }).reverse();
  const headPath=smoothPath(hp(-1).slice(0,-1).concat(cl,[[cx,py(11.65)]],cr,hp(1).slice(1,-1).reverse()),true);
  s+=`<path d="${headPath}" ${line}/>`;

  /* 手臂点：随躯干宽度外移——任何高度上手臂内缘都至少离躯干 ARM_GAP;外移量只增不减,避免臀部一带鼓包；
     手臂位置只按"当前体型"(不含减重)计算,叠加对比时两条手臂线才会重合 */
  const apexY=TPL.armInner[0][0];
  const torsoHalf=function(y){
    return interp(y,TPL.torsoSide.map(function(a){ return [a[0], a[1]*typeMul(a[0],bt)]; }));
  };
  const armInnerX=function(y){ return interp(y,TPL.armInner); };
  const armPts=function(arr,sg,mode){
    return arr.map(function(a,i){
      const w=Math.max(0,Math.min(1,(a[0]-apexY)/4));   // 腋下点不动,往下逐渐生效
      let need=0; for(let t=apexY;t<=a[0];t+=1){ need=Math.max(need, torsoHalf(t)+ARM_GAP-armInnerX(t)); }
      let base=a[1];
      if(mode==='inner' && i===0) base=a[1]*typeMul(a[0],bt)*lossMul(a[0],bt,loss);   // 腋下点与躯干起点一致
      if(mode==='outer') base=a[1]*(1+(typeMul(TPL.keyY.shoulder,bt)-1)*Math.max(0,1-(a[0]-18)/12));   // 肩宽修正向下渐消
      return [cx+sg*px(base+need*w), py(a[0])];
    });
  };
  const seg=function(p){ return smoothPath(p,false).replace(/^M [^C]*/,''); };
  const fmt=function(p){ return p[0].toFixed(1)+' '+p[1].toFixed(1); };
  const sideOf=function(sg){
    const A=tplPts(TPL.shoulderChain,bt,loss,sg)
      .concat(armPts(TPL.armOuter,sg,'outer'), armPts(TPL.hand,sg,'hand'), armPts(TPL.armInner,sg,'inner').reverse());
    return {A:A, B:tplPts(TPL.torsoSide,bt,loss,sg)};
  };
  /* 一条连续外轮廓：颈→肩→手臂外缘→手→手臂内缘→腋→胸→腰→臀→腿外缘→脚→腿内缘→裆(再镜像) */
  const SL=sideOf(-1), SR=sideOf(1);
  const iL=tplPts(TPL.legInner,bt,loss,-1).reverse(), iR=tplPts(TPL.legInner,bt,loss,1);
  const BRr=SR.B.slice().reverse(), ARr=SR.A.slice().reverse();
  const body='M '+fmt(SL.A[0])+' '+seg(SL.A)+' L '+fmt(SL.B[0])+' '+seg(SL.B)
    +' L '+fmt(iL[0])+' '+seg(iL)+' L '+fmt(iR[0])+' '+seg(iR)
    +' L '+fmt(BRr[0])+' '+seg(BRr)+' L '+fmt(ARr[0])+' '+seg(ARr);
  s+='<path d="'+body+'" '+line+'/>';

  if(!opt.noGuides){
    const crotchY=TPL.legInner[0][0];
    const hw=px(interp(41,TPL.torsoSide)*typeMul(41,bt)*lossMul(41,bt,loss)*0.96);
    s+='<path d="M '+(cx-hw).toFixed(1)+' '+py(41).toFixed(1)+' Q '+(cx-px(4))+' '+py(crotchY-1.2).toFixed(1)+' '+cx+' '+py(crotchY).toFixed(1)+' Q '+(cx+px(4))+' '+py(crotchY-1.2).toFixed(1)+' '+(cx+hw).toFixed(1)+' '+py(41).toFixed(1)+'" '+thin+'/>';   // 淡内裤线
    s+='<path d="M '+(cx-px(6))+' '+py(19.8).toFixed(1)+' Q '+cx+' '+py(22).toFixed(1)+' '+(cx+px(6))+' '+py(19.8).toFixed(1)+'" '+thin+'/>';   // 淡锁骨弧
    // 手指分隔：每只手一条极淡短线,让手有形状(手的位置随躯干宽度外移)
    [-1,1].forEach(function(sg){
      const hq=armPts([[47.6,10.6],[50.6,10.5]],sg,'hand');
      s+='<line x1="'+hq[0][0].toFixed(1)+'" y1="'+hq[0][1].toFixed(1)+'" x2="'+hq[1][0].toFixed(1)+'" y2="'+hq[1][1].toFixed(1)+'" '+thin+'/>';
    });

    /* 参考图里的结构细节：胸部弧线、肘/膝/踝标记(都是很淡的细线,随体型与减重一起变化) */
    const rowsXY=function(pts){ return pts.map(function(p){ return [p[1],p[0]]; }); };   // [Y,X],供 interp 使用
    const crossAt=function(v,outerPts,innerPts){
      const Y=py(v), x1=interp(Y,rowsXY(outerPts)), x2=interp(Y,rowsXY(innerPts));
      return '<line x1="'+x1.toFixed(1)+'" y1="'+Y.toFixed(1)+'" x2="'+x2.toFixed(1)+'" y2="'+Y.toFixed(1)+'" '+thin+'/>';
    };
    const bf=typeMul(26,bt)*lossMul(26,bt,loss);                // 胸围处的宽度系数
    [-1,1].forEach(function(sg){
      // 胸部：自中线向外的浅弧(类似胸围线)
      s+='<path d="M '+(cx+sg*px(0.8)).toFixed(1)+' '+py(27.3).toFixed(1)+' Q '+(cx+sg*px(2.9*bf)).toFixed(1)+' '+py(31.2).toFixed(1)+' '+(cx+sg*px(5.2*bf)).toFixed(1)+' '+py(27.6).toFixed(1)+'" '+thin+'/>';
      // 肘:手臂中段一条短横线
      s+=crossAt(35.5, armPts(TPL.armOuter,sg,'outer'), armPts(TPL.armInner,sg,'inner'));
      // 膝、踝:每条腿一条短横线
      const legO=tplPts(TPL.torsoSide,bt,loss,sg), legI=tplPts(TPL.legInner,bt,loss,sg);
      s+=crossAt(66.5, legO, legI);
      s+=crossAt(92, legO, legI);
    });
  }

  return opt.inner ? s : `<svg viewBox="0 0 ${VIEW.w} ${VIEW.h}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="身形比例示意图">${s}</svg>`;
}
/* 叠加对比：同一个人台上,虚线 = 当前轮廓,实线 = 30 天后参考(同一比例尺) */
function figureOverlay(opt){
  opt=opt||{};
  const base=figureSVG({bodyType:opt.bodyType,loss:0,stroke:'#9aa59d',dash:true,noGuides:true,inner:true,scale:opt.scale});
  const top=figureSVG({bodyType:opt.bodyType,loss:opt.loss,stroke:opt.stroke||'#b9755a',bmi:opt.bmi,gain:opt.gain,scale:opt.scale});
  return top.replace(/(<svg[^>]*>)/,'$1'+base);   // 底图放在最下层
}

/* ---------- 计算模拟参数 ---------- */
function simulateParams(loss){
  const bt = DATA.profile?DATA.profile.bodyType:'rectangle';
  // 相对变化最明显的部位：按拟合模型在腰/臀/大腿中取变化比例最大者
  let part='waist', max=0;
  ['waist','hip','thigh'].forEach(function(k){
    const v=Math.abs(relChange(bt,k,loss||-1,curBmi()));
    if(v>max){ max=v; part=k; }
  });
  return { bodyType:bt, loss, part, tier:(DATA.profile?DATA.profile.tier:'unknown') };
}

/* ---------- Toast ---------- */
let toastTimer=null;
function toast(msg,type){
  const root=document.getElementById('toastRoot');
  const el=document.createElement('div');
  el.className='toast'+(type?' '+type:'');
  el.textContent=msg;
  root.appendChild(el);
  clearTimeout(toastTimer);
  setTimeout(()=>{ el.classList.add('out'); setTimeout(()=>el.remove(),300); }, 2600);
}

/* ---------- 弹层 ---------- */
const modalRoot=document.getElementById('modalRoot');
let modalOpener=null;
function openModal(html){
  modalOpener=document.activeElement;                       // 关闭后把焦点还回去
  modalRoot.innerHTML=`<div class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle" tabindex="-1">${html}</div>`;
  modalRoot.hidden=false;
  modalRoot.onclick=(e)=>{ if(e.target===modalRoot) closeModal(); };
  const m=modalRoot.querySelector('.modal');
  const t=m.querySelector('h3,h4'); if(t&&!t.id) t.id='modalTitle';
  [].forEach.call(m.querySelectorAll('.modal-close'),function(b){ if(!b.getAttribute('aria-label')) b.setAttribute('aria-label','关闭'); });
  const first=m.querySelector('.modal-foot .btn-primary, button, input, a')||m;
  setTimeout(function(){ try{ first.focus(); }catch(e){} },0);   // 焦点进入弹层
}
function closeModal(){
  modalRoot.hidden=true; modalRoot.innerHTML='';
  if(modalOpener&&document.contains(modalOpener)){ try{ modalOpener.focus(); }catch(e){} }
  modalOpener=null;
}
// Esc 关闭弹层;Tab 在弹层内循环(焦点不跑到背景页面)
document.addEventListener('keydown',function(e){
  if(modalRoot.hidden) return;
  if(e.key==='Escape'){ e.preventDefault(); closeModal(); return; }
  if(e.key==='Tab'){
    const f=[].slice.call(modalRoot.querySelectorAll('button,a[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')).filter(function(x){ return !x.disabled&&x.offsetParent!==null; });
    if(!f.length) return;
    const first=f[0], last=f[f.length-1];
    if(e.shiftKey&&document.activeElement===first){ e.preventDefault(); last.focus(); }
    else if(!e.shiftKey&&document.activeElement===last){ e.preventDefault(); first.focus(); }
  }
});

/* ---------- 免责文本 ---------- */
const DISCLAIMER_HTML = `
  <h4>免责声明与使用边界</h4>
  <p>半寸是一款轻量化减脂可视化<strong>参考</strong>工具，帮助你在记录体重的同时，用简约线稿看到一种可能的身体轮廓变化。它<strong>不是</strong>医疗、营养或训练工具，也不提供任何诊断、治疗或健康建议。</p>
  <p>模拟结果基于简化的理想化规则生成，<strong>不构成对真实身体变化的预测</strong>。身体的真实变化受遗传、饮食、作息、运动、激素与健康状态等多重因素影响，请以专业医疗人员的意见为准。</p>
  <p>本工具<strong>不面向未成年人</strong>，不适合有进食障碍史或因此产生焦虑的人群。若体重对应的身体质量指数偏低，我们不提供减重模拟，建议关注身体感受并在必要时寻求专业帮助。</p>
  <p>我们倡导不评价、不恐吓、不羞耻、不比较。你身体的样子值得被温柔对待。</p>
  <h4 style="margin-top:18px">隐私与数据</h4>
  <p>你填写的体重、围度、饮食文字与经期标记属于敏感个人信息。在游客模式下，这些数据<strong>只保存在这台设备的浏览器本地存储中，不上传、不与第三方共享</strong>。清除浏览器数据会导致数据丢失，请自行备份。应用不采集人脸、照片或位置信息。</p>
`;

/* =========================================================
   入口与导航
   ========================================================= */
const landingEl=document.getElementById('landing');
const appEl=document.getElementById('app');
const onbEl=document.getElementById('onboarding');
const PAGES={today:'今日记录',simulate:'身形模拟',dashboard:'数据看板',settings:'设置'};
let currentPage='today';

function showLanding(){
  landingEl.hidden=false; appEl.hidden=true; onbEl.hidden=true;
  window.scrollTo(0,0);
}
function showApp(){
  landingEl.hidden=true; appEl.hidden=true; onbEl.hidden=true;
  // 未同意免责或未完成引导 -> 走引导
  if(!DATA.agreed || !DATA.profile){ startOnboarding(); return; }
  appEl.hidden=false;
  goPage(currentPage);
}
function bindPage(page){
  if(page==='today') bindToday();
  else if(page==='simulate') bindSimulate();
  else if(page==='dashboard') bindDashboard();
  else if(page==='settings') bindSettings();
}
function goPage(page){
  if(!PAGES[page]) page='today';
  currentPage=page;
  document.getElementById('topbarTitle').textContent=PAGES[page];
  document.querySelectorAll('#sideNav button').forEach(b=>b.classList.toggle('active',b.dataset.page===page));
  const c=document.getElementById('appContent');
  c.innerHTML = page==='today'?renderToday()
              : page==='simulate'?renderSimulate()
              : page==='dashboard'?renderDashboard()
              : renderSettings();
  bindPage(page);
  document.getElementById('sidebar').classList.remove('open');
  window.scrollTo(0,0);
}

/* =========================================================
   今日记录 F2
   ========================================================= */
function renderToday(){
  let h=`<div class="page-head"><h2>今天，记一次就好</h2><p>体重是唯一必填项。起床后、空腹、如厕后称量，更稳定。</p></div>`;

  // 今日已记录
  const t=today();
  const rec=DATA.records.find(r=>r.date===t);
  if(rec){
    h+=`<div class="today-record">
      <div><div class="tr-main">今日已记录 · ${rec.weight} kg</div>
      <div class="tr-sub">${rec.period?'已标记经期 · ':''}记录于 ${fmtDate(t)}</div></div>
      <div class="tr-actions">
        <button class="mini-btn" id="editToday">修改</button>
        <button class="mini-btn danger" id="delToday">删除</button>
      </div></div>`;
  }

  const bmi = rec && rec.weight && DATA.profile ? bmiOf(rec.weight, DATA.profile.height) : null;
  h+=`<div class="card"><h3>${rec?'修改今日记录':'记录今日体重'}</h3>
    <div class="sub">${rec?'当天的最后一次提交为准':'仅需体重，其余可稍后补充'}</div>
    <form id="recordForm" autocomplete="off">
      <div class="form-grid">
        <div class="form-field"><label>体重 <span style="color:var(--clay)">必填</span></label>
          <div class="input-wrap"><input type="number" name="weight" step="0.1" min="20" max="300" placeholder="例如 52.5" value="${rec&&rec.weight?rec.weight:''}" required><span class="input-unit">kg</span></div>
          <div class="hint" id="weightHint">合理范围 20–300 kg</div>
        </div>
        <div class="form-field"><label>身体质量指数参考</label>
          <div class="inline-pill" id="bmiPill">${bmi?bmi.toFixed(1)+' · '+TIER_NAME[tierOf(rec.weight,DATA.profile.height)]:'填写体重后显示'}</div>
        </div>
      </div>
      <div class="fold">
        <button type="button" class="fold-toggle" id="foldToggle"><span>＋ 补充围度、饮食与经期（可选）</span><span class="chevron">⌄</span></button>
        <div class="fold-body" id="foldBody">
          <div class="form-grid">
            <div class="form-field"><label>腰围</label><div class="input-wrap"><input type="number" name="waist" step="0.1" min="30" max="200" placeholder="例如 68" value="${rec&&rec.waist?rec.waist:''}"><span class="input-unit">cm</span></div></div>
            <div class="form-field"><label>臀围</label><div class="input-wrap"><input type="number" name="hip" step="0.1" min="40" max="200" placeholder="例如 92" value="${rec&&rec.hip?rec.hip:''}"><span class="input-unit">cm</span></div></div>
            <div class="form-field"><label>大腿围</label><div class="input-wrap"><input type="number" name="thigh" step="0.1" min="20" max="120" placeholder="例如 52" value="${rec&&rec.thigh?rec.thigh:''}"><span class="input-unit">cm</span></div></div>
            <div class="form-field"><label>小腿围</label><div class="input-wrap"><input type="number" name="calf" step="0.1" min="15" max="80" placeholder="例如 34" value="${rec&&rec.calf?rec.calf:''}"><span class="input-unit">cm</span></div></div>
          </div>
          <div class="form-field" style="margin-top:18px"><label>今天吃了什么（可选）</label><textarea name="diet" placeholder="简单记几句就好，不必计算热量" maxlength="500">${rec&&rec.diet?esc(rec.diet):''}</textarea></div>
          <label class="checkbox-row" style="margin-top:14px"><input type="checkbox" name="period" ${rec&&rec.period?'checked':''}><span>今天标记经期</span></label>
        </div>
      </div>
      <div style="margin-top:24px"><button type="submit" class="btn btn-primary btn-block" id="saveRecord">${rec?'保存修改':'保存记录'}</button></div>
    </form>
  </div>`;

  // 近7次趋势
  const recent=DATA.records.slice(-7);
  const pts=recent.filter(r=>r.weight).map(r=>({date:r.date,v:r.weight}));
  h+=`<div class="card"><h3>近 7 次体重</h3><div class="sub">给坚持一点看得见的回应</div>`;
  if(pts.length<2){
    h+=`<div class="empty"><div class="empty-ico">⌁</div><p>再记录一次，就能看到趋势了。</p></div>`;
  }else{
    h+=miniLine(pts,'var(--sage)');
  }
  h+=`</div>`;
  return h;
}

function bindToday(){
  const fold=document.getElementById('foldToggle');
  if(fold) fold.onclick=()=>{ fold.classList.toggle('open'); document.getElementById('foldBody').classList.toggle('open'); };
  const form=document.getElementById('recordForm');
  if(form){
    form.onsubmit=(e)=>{
      e.preventDefault();
      const btn=document.getElementById('saveRecord');
      if(btn.disabled) return;
      const fd=new FormData(form);
      let weight=parseFloat(fd.get('weight'));
      if(isNaN(weight)||weight<20||weight>300){ toast('请输入 20–300 kg 之间的体重','err'); return; }
      const obj={ date:today(), weight };
      ['waist','hip','thigh','calf'].forEach(k=>{ const v=parseFloat(fd.get(k)); if(!isNaN(v)&&v>0) obj[k]=v; });
      obj.diet=(fd.get('diet')||'').toString().trim().slice(0,500);
      obj.period=fd.get('period')==='on';
      const tier=tierOf(weight, DATA.profile&&DATA.profile.height);
      if(tier==='low'){ /* 仍允许记录，仅模拟时限制 */ }
      // 当天覆盖
      const idx=DATA.records.findIndex(r=>r.date===obj.date);
      if(idx>=0) DATA.records[idx]=obj; else DATA.records.push(obj);
      if(DATA.profile && !DATA.profile.weight){ DATA.profile.weight=weight; }
      save();
      btn.disabled=true; btn.textContent='保存中…';
      setTimeout(()=>{ toast('已保存','ok'); goPage('today'); },220);
    };
    const wInput=form.querySelector('[name=weight]');
    if(wInput) wInput.oninput=()=>{
      const v=parseFloat(wInput.value);
      const hint=document.getElementById('weightHint');
      const pill=document.getElementById('bmiPill');
      if(!isNaN(v)&&DATA.profile&&DATA.profile.height){
        const b=bmiOf(v,DATA.profile.height);
        pill.textContent=b.toFixed(1)+' · '+TIER_NAME[tierOf(v,DATA.profile.height)];
        if(v<20||v>300){ hint.textContent='这个数值超出常见范围，请核对后填写'; hint.style.color='var(--clay)'; }
        else{ hint.textContent='合理范围 20–300 kg'; hint.style.color=''; }
      } else if(!isNaN(v)){
        hint.textContent=(v<20||v>300)?'这个数值超出常见范围，请核对后填写':'合理范围 20–300 kg';
        hint.style.color=(v<20||v>300)?'var(--clay)':'';
      }
    };
  }
  const ed=document.getElementById('editToday'); if(ed) ed.onclick=()=>{ form.scrollIntoView({behavior:'smooth',block:'center'}); form.querySelector('[name=weight]').focus(); };
  const del=document.getElementById('delToday'); if(del) del.onclick=()=>{
    confirmModal('删除今日记录','删除后当天的记录将无法恢复。确定删除吗？',()=>{
      DATA.records=DATA.records.filter(r=>r.date!==today()); save(); toast('已删除','ok'); goPage('today');
    });
  };
}

/* 简易折线 SVG */
function miniLine(pts,color){
  const W=520,H=150,pad=24;
  const w=pts.map(p=>p.v);
  let min=Math.min(...w),max=Math.max(...w);
  if(max-min<0.6){ min-=0.5; max+=0.5; }
  const x=i=>pad+i*(W-2*pad)/(pts.length-1||1);
  const y=v=>H-pad-((v-min)/(max-min))*(H-2*pad);
  let d=pts.map((p,i)=>`${i?'L':'M'} ${x(i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(' ');
  let s=`<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto"><path d="${d}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`;
  pts.forEach((p,i)=>{ s+=`<circle cx="${x(i).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="3.5" fill="${color}"/>`; });
  s+=`</svg>`;
  return s;
}

function confirmModal(title,lead,onOk){
  openModal(`<button class="modal-close" onclick="__closeModal()">×</button>
    <h3>${title}</h3><p class="modal-lead">${lead}</p>
    <div class="modal-foot"><button class="btn btn-outline" id="cCancel">取消</button><button class="btn btn-primary" id="cOk">确定</button></div>`);
  document.getElementById('cCancel').onclick=closeModal;
  document.getElementById('cOk').onclick=()=>{ closeModal(); onOk(); };
}
window.__closeModal=closeModal;

/* =========================================================
   身形模拟 F3 / F4 / 安全规则
   ========================================================= */
let simLoss=-1.5, simOverlay=false, simGain=true;
function renderSimulate(){
  const profile=DATA.profile||{};
  const lc=lossCap();
  simLoss=Math.max(simLoss,-lc.cap);
  const tier=profile.tier||'unknown';
  const low=tier==='low';
  const count=DATA.records.filter(r=>r.weight).length;
  const bt=profile.bodyType||'rectangle';
  let h=`<div class="page-head"><h2>身形模拟</h2><p>一份理想化参考，不是承诺，也不是预测。</p></div>`;

  if(count<3){
    h+=`<div class="success-note">记录还不多，目前按你设定的目标推演。（已有 ${count} 条记录）</div>`;
  }
  if(low){
    h+=`<div class="safety-box"><h4>先照顾好身体感受</h4>
      根据你填写的身高体重，当前处于偏低体重范围，我们不提供减重模拟。
      比起数字，更重要的是身体的感受与状态。如果你有顾虑，建议找专业医疗人员聊聊。
      <a href="#" id="safetyHelp">查看求助信息</a></div>`;
    return h;
  }

  h+=`<div class="sim-layout">
    <div class="card sim-panel">
      <h3>设定三十天变化</h3>
      <div class="sub">体型：${BODY_TYPES[bt].name} · ${TIER_NAME[tier]}</div>
      <div class="slider-block">
        <label class="field-label">体重变化 <span id="simLossLabel">${simLoss.toFixed(1)} kg / 30 天</span></label>
        <input type="range" id="simLoss" min="${-lc.cap}" max="0" step="0.5" value="${simLoss}">
        <div class="range-ticks"><span>−${lc.cap} kg</span><span>维持</span></div>
        <p class="sim-reason">${lc.byWeight
          ? `为了更稳妥的节奏，按你目前的体重，最多设定 −${lc.cap} kg / 30 天（每周不超过体重的 1.5%）。我们不提供超过此范围的推演。`
          : '为了更稳妥的节奏，最多设定 −4 kg / 30 天。我们不提供超过此范围的推演。'}</p>
      </div>
      <div class="toggle-row"><input type="checkbox" id="simOverlay" ${simOverlay?'checked':''}><label for="simOverlay">叠加显示（虚线为当前轮廓）</label></div>
      <div class="toggle-row"><input type="checkbox" id="simGain" ${simGain?'checked':''}><label for="simGain">放大显示差异（示意）</label></div>
      <div class="toggle-row"><span style="font-size:12px;color:var(--ink-faint)">当前体型可随时在「设置」中重新校准。</span></div>
      <button class="btn btn-primary btn-block" id="genSim">生成模拟</button>
    </div>
    <div class="card sim-result" id="simResult"></div>
  </div>`;
  return h;
}

function bindSimulate(){
  const low=(DATA.profile&&DATA.profile.tier)==='low';
  if(low){
    const help=document.getElementById('safetyHelp');
    if(help) help.onclick=(e)=>{ e.preventDefault(); openModal(`<button class="modal-close" onclick="__closeModal()">×</button><h3>寻求专业帮助</h3><p class="modal-lead">如果你对自己的体重或身体状态有担心，建议联系当地医院的营养科或心理咨询门诊，或拨打当地健康热线获取专业支持。半寸不能替代专业医疗意见。</p><div class="modal-foot"><button class="btn btn-primary" onclick="__closeModal()">我知道了</button></div>`); };
    return;
  }
  const slider=document.getElementById('simLoss');
  if(slider) slider.oninput=()=>{ simLoss=parseFloat(slider.value); document.getElementById('simLossLabel').textContent=simLoss.toFixed(1)+' kg / 30 天'; drawSimResult(); };
  const ov=document.getElementById('simOverlay');
  if(ov) ov.onchange=()=>{ simOverlay=ov.checked; drawSimResult(); };
  const gn=document.getElementById('simGain');
  if(gn) gn.onchange=()=>{ simGain=gn.checked; drawSimResult(); };
  const gen=document.getElementById('genSim');
  if(gen) gen.onclick=()=>{ drawSimResult(); document.getElementById('simResult').scrollIntoView({behavior:'smooth',block:'center'}); };
  drawSimResult();
}

function drawSimResult(){
  const box=document.getElementById('simResult'); if(!box) return;
  const p=simulateParams(simLoss);
  const gain=simGain?VIS_GAIN:1, bmi=curBmi()||undefined;
  const sc=bodyScale(p.bodyType);                       // 按身高、体重、体型、围度算出的身材尺度
  const cur=figureSVG({bodyType:p.bodyType,loss:0,stroke:'#6b7d70',bmi:bmi,scale:sc});
  const fut=figureSVG({bodyType:p.bodyType,loss:simLoss,stroke:'#5b7a6b',bmi:bmi,gain:gain,scale:sc});
  let h=`<h3>三十天后 · 身形参考</h3><div class="sub">${BODY_TYPES[p.bodyType].name} · 目标 ${simLoss.toFixed(1)} kg · 正面比例示意</div>`;
  h+=`<div class="sim-figures">`;
  if(simOverlay){
    // 叠加显示：同一个人台、同一比例尺；虚线 = 当前，实线 = 30 天后参考
    const ovl=figureOverlay({bodyType:p.bodyType,loss:simLoss,bmi:bmi,gain:gain,scale:sc});
    h+=`<div class="fig-col"><div class="fig-frame">${ovl}</div><div class="fig-label"><span class="legend-dash"></span>当前（虚线） · <span class="legend-solid"></span><span class="accent">30 天后参考（实线）</span></div></div>`;
  } else {
    h+=`<div class="fig-col"><div class="fig-frame">${cur}</div><div class="fig-label">当前</div></div>`;
    h+=`<div class="fig-col"><div class="fig-frame">${fut}</div><div class="fig-label accent">30 天后参考</div></div>`;
  }
  h+=`</div>`;
  {
    const pr=DATA.profile||{}, w=latestWeight();
    h+=`<p class="sim-gain-note">轮廓按你的身高 ${esc(pr.height||'—')} cm、体重 ${esc(w||'—')} kg 和${BODY_TYPES[p.bodyType].name}调整${hasMeasured()?'，并参考了你填写的围度':'；没填围度时按身高体重估算，填写腰围、臀围后会更贴近你'}。</p>`;
  }
  if(simGain && simLoss<0){
    h+=`<p class="sim-gain-note">轮廓差异已放大约 ${VIS_GAIN} 倍以便看清，实际变化更小，数值以下方围度表为准。</p>`;
  }
  if(Math.abs(simLoss)<=0.5){
    h+=`<p class="sim-small-change">这个阶段的变化很小，重点是坚持记录。</p>`;
  }
  const lc=lossCap();
  if(lc.soft && -simLoss>lc.soft){
    h+=`<div class="sim-caution">这个节奏偏快。更稳妥的做法是每周不超过体重的 1%（按你的体重约 −${(Math.floor(lc.soft*2)/2).toFixed(1)} kg / 30 天）。</div>`;
  }

  // 围度参考表（用用户实际填写的围度，按体型权重推演）
  const m=measureTable(p, simLoss);
  if(m){
    h+=`<div class="measure-table"><div class="mt-head"><span>部位</span><span>当前</span><span>30 天后参考</span></div>`;
    m.forEach(r=>{
      h+=`<div class="mt-row"><span>${r.name}</span><span>${r.from!=null?r.from+' cm':'—'}</span><span class="${r.changed?'accent':''}">${r.to!=null?r.to+' cm':'—'}</span></div>`;
    });
    h+=`</div>`;
  }

  if(simLoss<0){
    h+=`<div style="text-align:center;margin-top:14px"><span class="change-badge">相对明显的变化部位：<b>${PART_LABEL[p.part]}</b></span></div>`;
  }
  const talk=gentleTalk({count:DATA.records.filter(r=>r.weight).length,tier:p.tier,bodyType:p.bodyType,part:p.part,loss:simLoss,days:streakDays()});
  h+=`<div class="talk-box"><div class="talk-tag">给你的一句话</div><p>${talk}</p></div>`;
  h+=`<p style="font-size:11px;color:var(--ink-faint);text-align:center;margin-top:14px">线稿为身材比例示意，不含面部与服装；模拟结果仅为理想化参考，不构成真实身体变化的预测。</p>`;
  h+=`<div class="snapshot-save"><button class="btn btn-outline" id="saveSnap">保存为快照</button></div>`;
  box.innerHTML=h;
  const sb=document.getElementById('saveSnap');
  sb.onclick=()=>{
    // 只存参数,不存 SVG：体积小,也记下当时的放大倍数和 BMI,显示时按同样参数重画
    const snap={id:Date.now(),date:today(),bodyType:p.bodyType,loss:simLoss,gain:gain,bmi:bmi||null,sc:sc};
    DATA.snapshots.push(snap); save(); toast('快照已保存','ok');
  };
}

// 快照：按存下的参数重新绘制(含当时的放大倍数和 BMI)
function snapFigure(s){ return figureSVG({bodyType:s.bodyType,loss:s.loss,bmi:s.bmi||undefined,gain:s.gain,scale:s.sc||undefined}); }
function snapMeta(s){ return fmtDate(s.date)+' · '+BODY_TYPES[s.bodyType].name+' · '+s.loss.toFixed(1)+'kg'+(s.gain>1?' · 示意放大':''); }

// 围度参考数值表：来自用户实际填写的围度；未填则用体型基线估算
function measureTable(p, loss){
  const prof=DATA.profile||{};
  const bmi=curBmi();
  // 当前围度：最近一次填写的值,按体重(BMI)的变化折算到现在;从没填过则按身高、BMI、体型估算
  const girthNow=function(k){
    const m=lastGirth(k);
    if(m&&m.bmi&&bmi) return Math.round(m.c*bmiGrowth(k,bmi,m.bmi));
    if(m) return Math.round(m.c);
    return Math.round(estCirc(k,p.bodyType,bmi,prof.height));
  };
  const from={ waist:girthNow('waist'), hip:girthNow('hip'), thigh:girthNow('thigh') };
  // 数值按拟合模型的真实比例计算(不含图上的示意放大)
  const to=function(v,key){ return Math.max(1,Math.round(v*(1+relChange(p.bodyType,key,loss,bmi)))); };
  const rows=[
    {name:'腰围', from:from.waist,  to:to(from.waist,'waist')},
    {name:'臀围', from:from.hip,    to:to(from.hip,'hip')},
    {name:'大腿围',from:from.thigh, to:to(from.thigh,'thigh')}
  ];
  rows.forEach(r=>r.changed = r.to<r.from);
  return rows;
}

function streakDays(){
  if(!DATA.records.length) return 0;
  const set=new Set(DATA.records.map(r=>r.date));
  let n=0; const d=new Date();
  if(!set.has(ymd(d))) d.setDate(d.getDate()-1);   // 今天还没记,就从昨天往前数,不让连续天数突然归零
  for(;;){
    const key=ymd(d);
    if(set.has(key)){ n++; d.setDate(d.getDate()-1); }
    else break;
  }
  return n;
}

/* =========================================================
   数据看板 F5
   ========================================================= */
const GIRTH_PARTS=[['waist','腰围','#5b7a6b'],['hip','臀围','#b9755a'],['thigh','大腿围','#7d9a8a'],['calf','小腿围','#b89b6a']];
let girthActive=[0,1,2,3];
function renderDashboard(){
  const recs=DATA.records;
  let h=`<div class="page-head"><h2>数据看板</h2><p>体重趋势、围度变化与快照相册。</p></div>`;
  // 统计
  const wRecs=recs.filter(r=>r.weight);
  const first=wRecs[0]&&wRecs[0].weight, last=latestWeight();
  const diff=(first&&last)?(last-first):null;
  h+=`<div class="stat-row">
    <div class="stat"><div class="s-label">累计记录</div><div class="s-val">${recs.length}<small> 次</small></div></div>
    <div class="stat"><div class="s-label">当前体重</div><div class="s-val">${last||'—'}<small> kg</small></div></div>
    <div class="stat"><div class="s-label">累计变化</div><div class="s-val">${diff==null?'—':(diff>0?'+':'')+diff.toFixed(1)}<small> kg</small></div></div>
    <div class="stat"><div class="s-label">快照</div><div class="s-val">${DATA.snapshots.length}<small> 张</small></div></div>
  </div>`;

  // 体重折线（标注经期与缺口）
  h+=`<div class="card chart-card"><h3>体重趋势</h3><div class="sub">经期以浅色区间标记；虚线表示中间有未记录的天</div>`;
  if(wRecs.length<2){
    h+=`<div class="empty"><div class="empty-ico">⌁</div><p>再记录一次，就能看到趋势了。</p></div>`;
  }else{
    h+=`<div id="weightChartBox">${weightChart(wRecs)}</div>`;
  }
  h+=`</div>`;

  // 围度多线
  h+=`<div class="card chart-card"><h3>围度趋势</h3><div class="sub">腰、臀、大腿、小腿，可单独查看</div>`;
  const parts=GIRTH_PARTS;
  const anyPart=parts.some(p=>recs.filter(r=>r[p[0]]).length>=2);
  girthActive=[0,1,2,3];
  if(!anyPart){
    h+=`<div class="empty"><div class="empty-ico">⌁</div><p>再记录一次围度，就能看到趋势了。</p></div>`;
  }else{
    h+=`<div class="chart-legend">${parts.map((p,i)=>`<button type="button" class="leg active" aria-pressed="true" data-i="${i}"><i style="background:${p[2]}"></i>${p[1]}</button>`).join('')}</div>`;
    h+=`<div id="girthChart">${girthChart(recs,parts,girthActive)}</div>`;
  }
  h+=`</div>`;

  // 快照相册
  h+=`<div class="card"><h3>快照相册</h3><div class="sub">按月查看，可两两对比</div>`;
  if(!DATA.snapshots.length){
    h+=`<div class="empty"><div class="empty-ico">▧</div><p>还没有快照。去「身形模拟」生成并保存一张吧。</p></div>`;
  }else{
    h+=`<div class="snap-album">`;
    DATA.snapshots.slice().reverse().forEach(s=>{
      h+=`<div class="snap-item">${snapFigure(s)}<div class="snap-meta">${esc(snapMeta(s))}</div><button class="snap-del" data-id="${s.id}">删除</button></div>`;
    });
    h+=`</div>`;
    if(DATA.snapshots.length>=2){
      h+=`<div style="text-align:center;margin-top:18px"><button class="btn btn-outline" id="compareSnap">对比两张快照</button></div>`;
    }
  }
  h+=`</div>`;
  return h;
}

function bindDashboard(){
  // 围度图例切换
  document.querySelectorAll('.leg').forEach(el=>{
    el.onclick=()=>{
      const i=+el.dataset.i;
      let cur=girthActive.slice();
      if(cur.indexOf(i)>=0){ if(cur.length===1) return; cur=cur.filter(x=>x!==i); } else cur.push(i);   // 至少保留一条线
      girthActive=cur;
      document.querySelectorAll('.leg').forEach(x=>{
        const on=cur.indexOf(+x.dataset.i)>=0; x.classList.toggle('active',on); x.setAttribute('aria-pressed',on?'true':'false');
      });
      document.getElementById('girthChart').innerHTML=girthChart(DATA.records,GIRTH_PARTS,cur);
    };
  });
  document.querySelectorAll('.snap-del').forEach(b=>b.onclick=()=>{
    const id=+b.dataset.id;
    confirmModal('删除快照','删除后无法恢复，确定吗？',()=>{ DATA.snapshots=DATA.snapshots.filter(s=>s.id!==id); save(); goPage('dashboard'); });
  });
  const cmp=document.getElementById('compareSnap');
  if(cmp) cmp.onclick=()=>{
    const s=DATA.snapshots.slice(-2);
    const amp=s.some(function(x){ return x.gain>1; });
    openModal(`<button class="modal-close" aria-label="关闭" onclick="__closeModal()">×</button><h3 id="modalTitle">快照对比</h3><p class="modal-lead">${fmtDate(s[0].date)} 与 ${fmtDate(s[1].date)}</p><div style="display:flex;justify-content:center;gap:6px">${s.map(snapFigure).join('')}</div>${amp?'<p class="sim-gain-note">带“示意放大”的快照，轮廓差异已放大以便看清，实际变化更小。</p>':''}<div class="modal-foot"><button class="btn btn-primary" onclick="__closeModal()">关闭</button></div>`);
  };
}

/* ---------- 图表：按真实日期排布,缺口可见,标签不重叠,宽度随屏幕 ---------- */
function chartW(){
  const c=document.getElementById('appContent');
  const w=(c&&c.clientWidth)||620;
  return Math.max(300,Math.min(640,w-70));
}
function dn(s){ const p=s.split('-'); return Date.UTC(+p[0],+p[1]-1,+p[2])/86400000; }   // 日期 → 天数(用 UTC 计算,避免时区取整)
function dnLabel(n){ const d=new Date(n*86400000); return (d.getUTCMonth()+1)+'月'+d.getUTCDate()+'日'; }
function timeAxis(recs,pl,pr,W){
  const d0=dn(recs[0].date), d1=dn(recs[recs.length-1].date), span=Math.max(1,d1-d0), inner=W-pl-pr;
  return { d0:d0, d1:d1, span:span, dayW:inner/span, x:function(date){ return pl+(dn(date)-d0)*inner/span; } };
}
function xTicks(ax,W,pl,pr,H,svgFont){
  const n=Math.min(W<420?4:6, ax.span+1);
  let s='';
  for(let k=0;k<n;k++){
    const day=n===1?ax.d0:Math.round(ax.d0+k*ax.span/(n-1));
    const x=pl+(day-ax.d0)*(W-pl-pr)/ax.span;
    const anchor=k===0?'start':(k===n-1?'end':'middle');
    s+='<text x="'+x.toFixed(1)+'" y="'+(H-8)+'" font-size="'+svgFont+'" fill="#6f7a73" text-anchor="'+anchor+'">'+dnLabel(day)+'</text>';
  }
  return s;
}

function weightChart(recs){
  const W=chartW(),H=240,pl=46,pr=16,pt=16,pb=34,fs=12;
  const ax=timeAxis(recs,pl,pr,W);
  const vals=recs.map(r=>r.weight);
  let min=Math.min.apply(null,vals)-0.5,max=Math.max.apply(null,vals)+0.5;
  const y=v=>H-pb-((v-min)/(max-min))*(H-pt-pb);
  let s='<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="体重趋势折线图">';
  for(let g=0;g<=4;g++){
    const gy=pt+g*(H-pt-pb)/4, v=max-g*(max-min)/4;
    s+='<line x1="'+pl+'" y1="'+gy+'" x2="'+(W-pr)+'" y2="'+gy+'" stroke="#ece5da" stroke-width="1"/>';
    s+='<text x="'+(pl-8)+'" y="'+(gy+4)+'" font-size="'+fs+'" fill="#6f7a73" text-anchor="end">'+v.toFixed(1)+'</text>';
  }
  // 经期：连续的经期日合并成一个区间
  let i=0;
  while(i<recs.length){
    if(recs[i].period){
      let j=i;
      while(j+1<recs.length&&recs[j+1].period&&dn(recs[j+1].date)-dn(recs[j].date)<=1) j++;
      const x1=Math.max(pl,ax.x(recs[i].date)-ax.dayW/2), x2=Math.min(W-pr,ax.x(recs[j].date)+ax.dayW/2);
      s+='<rect x="'+x1.toFixed(1)+'" y="'+pt+'" width="'+Math.max(4,x2-x1).toFixed(1)+'" height="'+(H-pt-pb)+'" fill="#f3e3da" opacity=".7"/>';
      i=j+1;
    } else i++;
  }
  // 折线：相邻记录相隔 1 天以内画实线；中间缺了天,用淡虚线连接
  for(let k=1;k<recs.length;k++){
    const gap=dn(recs[k].date)-dn(recs[k-1].date)>1;
    s+='<line x1="'+ax.x(recs[k-1].date).toFixed(1)+'" y1="'+y(recs[k-1].weight).toFixed(1)+'" x2="'+ax.x(recs[k].date).toFixed(1)+'" y2="'+y(recs[k].weight).toFixed(1)+'" stroke="#5b7a6b" stroke-width="'+(gap?1.6:2.6)+'" stroke-linecap="round"'+(gap?' stroke-dasharray="3 5" opacity=".55"':'')+'/>';
  }
  recs.forEach(function(r){ s+='<circle cx="'+ax.x(r.date).toFixed(1)+'" cy="'+y(r.weight).toFixed(1)+'" r="'+(recs.length>40?2.5:3.5)+'" fill="#5b7a6b"/>'; });
  s+=xTicks(ax,W,pl,pr,H,fs);
  s+='</svg>';
  return s;
}

function girthChart(recs,parts,active){
  const W=chartW(),H=230,pl=46,pr=16,pt=16,pb=34,fs=12;
  const series=active.map(i=>recs.filter(r=>r[parts[i][0]])).filter(s=>s.length);
  const all=[]; active.forEach(i=>recs.forEach(r=>{ if(r[parts[i][0]]) all.push(r[parts[i][0]]); }));
  if(!all.length) return '';
  const ax=timeAxis(recs,pl,pr,W);
  let min=Math.min.apply(null,all)-2,max=Math.max.apply(null,all)+2;
  const y=v=>H-pb-((v-min)/(max-min))*(H-pt-pb);
  let s='<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="围度趋势折线图">';
  for(let g=0;g<=4;g++){
    const gy=pt+g*(H-pt-pb)/4, v=max-g*(max-min)/4;
    s+='<line x1="'+pl+'" y1="'+gy+'" x2="'+(W-pr)+'" y2="'+gy+'" stroke="#ece5da"/>';
    s+='<text x="'+(pl-8)+'" y="'+(gy+4)+'" font-size="'+fs+'" fill="#6f7a73" text-anchor="end">'+v.toFixed(0)+'</text>';
  }
  active.forEach(function(idx){
    const key=parts[idx][0], color=parts[idx][2];
    const arr=recs.filter(r=>r[key]);
    if(!arr.length) return;
    if(arr.length>1){
      const d=arr.map((r,i)=>(i?'L':'M')+' '+ax.x(r.date).toFixed(1)+' '+y(r[key]).toFixed(1)).join(' ');
      s+='<path d="'+d+'" fill="none" stroke="'+color+'" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>';
    }
    arr.forEach(function(r){ s+='<circle cx="'+ax.x(r.date).toFixed(1)+'" cy="'+y(r[key]).toFixed(1)+'" r="3.2" fill="'+color+'"/>'; });
  });
  s+=xTicks(ax,W,pl,pr,H,fs);
  s+='</svg>';
  return s;
}

/* =========================================================
   设置 F7
   ========================================================= */
function renderSettings(){
  const p=DATA.profile||{};
  const r=DATA.settings.reminder;
  let h=`<div class="page-head"><h2>设置</h2><p>体型校准、数据管理与隐私说明。</p></div>`;

  h+=`<div class="card"><h3>体型与基础信息</h3><div class="sub">当前体型：${BODY_TYPES[p.bodyType]?BODY_TYPES[p.bodyType].name:'未设置'}</div>
    <div class="form-grid">
      <div class="form-field"><label>身高</label><div class="input-wrap"><input type="number" id="setHeight" step="0.1" value="${p.height||''}" placeholder="例如 165"><span class="input-unit">cm</span></div></div>
      <div class="form-field"><label>体重范围</label><div class="inline-pill">${TIER_NAME[p.tier||'unknown']}</div></div>
    </div>
    <div style="margin-top:20px"><button class="btn btn-outline" id="recalib">重新校准体型</button></div>
    <p class="hint">新生成的模拟按新体型计算；历史快照保留原体型，不被改写。</p>
  </div>`;

  h+=`<div class="card"><h3>数据说明</h3>
    <div class="setting-row"><div class="setting-info"><h4>当前模式</h4><p>游客体验 · 数据只保存在这台设备，不上传</p></div><div class="setting-action"><span class="mode-pill">${DATA.guest?'游客':'正式账号'}</span></div></div>
    <div class="setting-row"><div class="setting-info"><h4>账号与同步</h4><p>账号只用于身份和同步，不改变「默认不上传」的承诺。当前为本地体验，无需登录。</p></div></div>
    <div class="setting-row"><div class="setting-info"><h4>备份与恢复</h4><p>备份文件带版本号与生成时间，仅用于恢复，不是健康记录。</p></div><div class="setting-action"><button class="btn btn-outline btn-sm" id="setBackup">备份 / 恢复</button></div></div>
    <div class="setting-row"><div class="setting-info"><h4>免责声明与协议</h4><p>可随时查看产品的边界与隐私说明。</p></div><div class="setting-action"><button class="btn btn-outline btn-sm" id="setDisclaimer">查看</button></div></div>
  </div>`;

  h+=`<div class="card"><h3>记录提醒</h3><div class="sub">可选，默认关闭</div>
    <div class="setting-row"><div class="setting-info"><h4 id="remLabel">每日提醒</h4><p>到点、且今天还没记录时提醒你。<strong>只在这个页面打开着时才会提醒</strong>；关闭页面或浏览器后无法提醒。</p><p class="hint" id="remStatus">${esc(reminderStatusText())}</p></div><div class="setting-action"><button type="button" class="switch ${r.enabled?'on':''}" id="remSwitch" role="switch" aria-checked="${r.enabled?'true':'false'}" aria-labelledby="remLabel"></button></div></div>
    <div class="setting-row"><div class="setting-info"><h4><label for="remTime">提醒时间</label></h4></div><div class="setting-action"><input type="time" class="time-input" id="remTime" value="${esc(r.time)}" ${r.enabled?'':'disabled'}></div></div>
  </div>`;

  h+=`<div class="card danger-zone"><h3>清除数据</h3>
    <div class="setting-row"><div class="setting-info"><h4>一键清除全部数据</h4><p>将删除 ${DATA.records.length} 条记录与 ${DATA.snapshots.length} 张快照，清除后不可恢复。</p></div><div class="setting-action"><button class="btn btn-outline btn-sm" id="clearAll" style="color:var(--clay);border-color:#d9a39a">清除</button></div></div>
  </div>`;
  return h;
}

function bindSettings(){
  const sh=document.getElementById('setHeight');
  if(sh) sh.onchange=()=>{
    const v=parseFloat(sh.value);
    if(!isNaN(v)&&v>=80&&v<=250){
      DATA.profile.height=v;
      DATA.profile.tier=tierOf(latestWeight()||DATA.profile.weight, v);
      save(); toast('身高已更新','ok');
    }else toast('请输入 80–250 cm 之间的身高','err');
  };
  const rc=document.getElementById('recalib'); if(rc) rc.onclick=()=>startOnboarding(true);
  const bk=document.getElementById('setBackup'); if(bk) bk.onclick=openBackupModal;
  const ds=document.getElementById('setDisclaimer'); if(ds) ds.onclick=showDisclaimer;
  const sw=document.getElementById('remSwitch');
  if(sw) sw.onclick=()=>{
    const on=!DATA.settings.reminder.enabled;
    DATA.settings.reminder.enabled=on; save();
    sw.classList.toggle('on',on); sw.setAttribute('aria-checked',on?'true':'false');
    document.getElementById('remTime').disabled=!on;
    const apply=function(){
      document.getElementById('remStatus').textContent=reminderStatusText();
      if(!on) toast('提醒已关闭','ok');
      else if('Notification' in window && Notification.permission==='granted') toast('提醒已开启（页面打开时生效）','ok');
      else toast('提醒已开启，但浏览器未允许通知，只会在页面里提示','ok');
    };
    if(on) requestNotify(apply); else apply();
  };
  const rt=document.getElementById('remTime');
  if(rt) rt.onchange=()=>{
    if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(rt.value)){ toast('请选择有效的提醒时间','err'); rt.value=DATA.settings.reminder.time; return; }
    DATA.settings.reminder.time=rt.value; DATA.settings.reminder.last=''; save(); toast('提醒时间已更新','ok');
  };
  const ca=document.getElementById('clearAll'); if(ca) ca.onclick=()=>{
    confirmModal('清除全部数据',`将永久删除 ${DATA.records.length} 条记录和 ${DATA.snapshots.length} 张快照，且无法恢复。建议先备份。确定清除吗？`,()=>{
      DATA=defaultData(); save(); toast('数据已清除','ok'); showApp();
    });
  };
}
function requestNotify(done){
  const cb=function(){ if(done) done(); };
  if(!('Notification' in window)){ cb(); return; }
  if(Notification.permission==='default'){
    try{
      const p=Notification.requestPermission(function(){ cb(); });   // 旧写法的回调
      if(p&&p.then) p.then(cb,cb);
    }catch(e){ cb(); }
  } else cb();
}
function reminderStatusText(){
  const r=DATA.settings.reminder;
  if(!r.enabled) return '当前：未开启';
  if(!('Notification' in window)) return '当前：已开启 · 这个浏览器不支持系统通知，只会在页面里提示';
  if(Notification.permission==='granted') return '当前：已开启 · 每天 '+r.time+'，今天还没记录时通过系统通知提醒（需保持本页面打开）';
  if(Notification.permission==='denied') return '当前：已开启 · 浏览器已禁止通知，只会在页面里提示（需保持本页面打开）';
  return '当前：已开启 · 尚未允许通知，只会在页面里提示（需保持本页面打开）';
}
/* 提醒检查：页面打开时每 30 秒看一次。到点、今天还没记录、今天还没提醒过 → 通知(或页面内提示) */
function checkReminder(){
  const r=DATA&&DATA.settings&&DATA.settings.reminder;
  if(!r||!r.enabled||!DATA.profile||!DATA.agreed) return;
  const now=new Date(), t=today();
  if(r.last===t) return;
  const hm=String(now.getHours()).padStart(2,'0')+':'+String(now.getMinutes()).padStart(2,'0');
  if(hm<r.time) return;
  if(DATA.records.some(function(x){ return x.date===t; })){ r.last=t; save(); return; }   // 已经记了,今天不再提醒
  r.last=t; save();
  const msg='今天还没记录体重，记一次吧。';
  if('Notification' in window && Notification.permission==='granted'){
    try{ const n=new Notification('半寸 · 记录提醒',{body:msg}); n.onclick=function(){ window.focus(); goPage('today'); n.close(); }; return; }catch(e){}
  }
  toast(msg,'ok');
}

/* =========================================================
   引导流程 F1 / F6
   ========================================================= */
let onbStep=1, onbRecalib=false;
let onbDraft={};
function startOnboarding(recalib){
  onbRecalib=!!recalib;
  onbStep=1;
  onbDraft={
    height:recalib?(DATA.profile&&DATA.profile.height)||'':'',
    weight:recalib?(latestWeight())||'':'',
    waist:recalib?(DATA.profile&&DATA.profile.waist)||'':'',
    hip:recalib?(DATA.profile&&DATA.profile.hip)||'':'',
    thigh:recalib?(DATA.profile&&DATA.profile.thigh)||'':'',
    bodyType:recalib&&DATA.profile?DATA.profile.bodyType:null
  };
  landingEl.hidden=true; appEl.hidden=true; onbEl.hidden=false;
  renderOnb();
}
function renderOnb(){
  document.getElementById('onbStep').textContent=onbStep;
  const body=document.getElementById('onbBody');
  if(onbStep===1){
    body.innerHTML=`<div class="onb-step-tag">第 1 步 · 使用之前</div>
      <h2>先讲清楚，<br>我们再开始。</h2>
      <p class="onb-lead">半寸是一份温柔的参考，不是医疗或预测工具。读完下面的说明再继续。</p>
      <div class="onb-agree">${DISCLAIMER_HTML}</div>
      <label class="checkbox-row"><input type="checkbox" id="agreeBox" ${DATA.agreed?'checked':''}><span>我已阅读并同意以上免责声明、隐私与用户协议</span></label>
      <div class="onb-nav-btns"><span></span><button class="btn btn-primary" id="onbNext">继续</button></div>`;
    document.getElementById('onbNext').onclick=()=>{
      const c=document.getElementById('agreeBox');
      if(!c.checked){ toast('请先勾选同意','err'); return; }
      DATA.agreed=true; save(); onbStep=2; renderOnb();
    };
  }else if(onbStep===2){
    body.innerHTML=`<div class="onb-step-tag">第 2 步 · 基础信息</div>
      <h2>填几项就好，<br>之后随时能补。</h2>
      <p class="onb-lead">身高必填，其余可选，之后随时能补。</p>
      <div class="card" style="margin-bottom:0">
        <div class="form-grid">
          <div class="form-field"><label>身高 <span style="color:var(--clay)">必填</span></label><div class="input-wrap"><input type="number" id="obHeight" step="0.1" placeholder="例如 165" value="${onbDraft.height}"><span class="input-unit">cm</span></div></div>
          <div class="form-field"><label>体重 <span class="opt">可选</span></label><div class="input-wrap"><input type="number" id="obWeight" step="0.1" placeholder="例如 52" value="${onbDraft.weight}"><span class="input-unit">kg</span></div></div>
          <div class="form-field"><label>腰围 <span class="opt">可选</span></label><div class="input-wrap"><input type="number" id="obWaist" step="0.1" placeholder="例如 68" value="${onbDraft.waist}"><span class="input-unit">cm</span></div></div>
          <div class="form-field"><label>臀围 <span class="opt">可选</span></label><div class="input-wrap"><input type="number" id="obHip" step="0.1" placeholder="例如 92" value="${onbDraft.hip}"><span class="input-unit">cm</span></div></div>
          <div class="form-field"><label>大腿围 <span class="opt">可选</span></label><div class="input-wrap"><input type="number" id="obThigh" step="0.1" placeholder="例如 52" value="${onbDraft.thigh}"><span class="input-unit">cm</span></div></div>
        </div>
        <p class="hint" style="margin-top:16px">${waistHipText(onbDraft.waist,onbDraft.hip)||'填写腰围和臀围后，我们会给出体型建议。'}</p>
      </div>
      <div class="onb-nav-btns"><button class="btn btn-ghost" id="onbBack">上一步</button><button class="btn btn-primary" id="onbNext">下一步</button></div>`;
    document.getElementById('onbBack').onclick=()=>{ syncDraft2(); onbStep=1; renderOnb(); };
    document.getElementById('onbNext').onclick=()=>{
      syncDraft2();
      const verr=validateOnb(); if(verr){ toast(verr,'err'); return; }
      if(!onbDraft.bodyType){
        const rec=recommendedBodyType(onbDraft.waist,onbDraft.hip);
        onbDraft.bodyType=rec||'rectangle';
      }
      onbStep=3; renderOnb();
    };
    ['obHeight','obWeight','obWaist','obHip','obThigh'].forEach(id=>{
      const el=document.getElementById(id);
      if(el) el.oninput=syncDraft2;
    });
  }else if(onbStep===3){
    const bt=onbDraft.bodyType||'rectangle';
    // 体型预览按你刚填的身高、体重(BMI)缩放,不带围度,这样五种体型之间的差别才是"体型"本身
    const dh=parseFloat(onbDraft.height)||undefined, dw=parseFloat(onbDraft.weight)||undefined;
    const onbFig=function(k,sel){
      return figureSVG({bodyType:k,loss:0,stroke:sel?'#5b7a6b':'#8d978f',
        scale:bodyScale(k,{height:dh,bmi:(dh&&dw)?bmiOf(dw,dh):undefined,noMeasured:true})});
    };
    body.innerHTML=`<div class="onb-step-tag">第 3 步 · 确认体型</div>
      <h2>选一个最接近你的体型。</h2>
      <p class="onb-lead">${waistHipText(onbDraft.waist,onbDraft.hip)||'我们按常见特征给出建议，你也可以自己选。'}体型会用于线稿推演，可随时重新校准。</p>
      <div class="bodytype-grid" id="btGrid">
        ${Object.keys(BODY_TYPES).map(k=>`<button class="bodytype-card ${k===bt?'selected':''}" data-bt="${k}">
          ${onbFig(k,k===bt)}
          <div class="bt-name">${BODY_TYPES[k].name}</div><div class="bt-desc">${BODY_TYPES[k].desc}</div></button>`).join('')}
      </div>
      <div class="onb-nav-btns"><button class="btn btn-ghost" id="onbBack">上一步</button><button class="btn btn-primary" id="onbNext">完成</button></div>`;
    document.querySelectorAll('#btGrid .bodytype-card').forEach(c=>c.onclick=()=>{
      onbDraft.bodyType=c.dataset.bt;
      document.querySelectorAll('#btGrid .bodytype-card').forEach(x=>{
        const sel=x.dataset.bt===onbDraft.bodyType;
        x.classList.toggle('selected',sel);
        x.querySelector('svg').outerHTML=onbFig(x.dataset.bt,sel);
      });
    });
    document.getElementById('onbBack').onclick=()=>{ onbStep=2; renderOnb(); };
    document.getElementById('onbNext').onclick=()=>finishOnboarding();
  }
}
/* 引导页输入校验(范围与记录页、设置页一致) */
function validateOnb(){
  const d=onbDraft;
  if(numIn(d.height,RANGE.height[0],RANGE.height[1])==null) return '请填写 80–250 cm 之间的身高';
  const items=[['weight','体重','kg'],['waist','腰围','cm'],['hip','臀围','cm'],['thigh','大腿围','cm']];
  for(let i=0;i<items.length;i++){
    const k=items[i][0];
    if(d[k]!==''&&d[k]!=null&&numIn(d[k],RANGE[k][0],RANGE[k][1])==null)
      return items[i][1]+'需在 '+RANGE[k][0]+'–'+RANGE[k][1]+' '+items[i][2]+' 之间，请核对后再填';
  }
  return null;
}
function syncDraft2(){
  const g=id=>{const e=document.getElementById(id);return e?e.value:'';};
  onbDraft.height=g('obHeight'); onbDraft.weight=g('obWeight');
  onbDraft.waist=g('obWaist'); onbDraft.hip=g('obHip'); onbDraft.thigh=g('obThigh');
}
function finishOnboarding(){
  const verr=validateOnb(); if(verr){ toast(verr,'err'); onbStep=2; renderOnb(); return; }
  const h=parseFloat(onbDraft.height);
  const w=parseFloat(onbDraft.weight)||null;
  const profile={
    height:h,
    weight:w,
    waist:parseFloat(onbDraft.waist)||null,
    hip:parseFloat(onbDraft.hip)||null,
    thigh:parseFloat(onbDraft.thigh)||null,
    bodyType:onbDraft.bodyType||'rectangle',
    tier:'unknown'
  };
  // 填了体重：今天有记录就同步更新(否则新体重会被悄悄忽略),没有就补一条
  let weightNote='';
  if(w){
    const t=today();
    const rec=DATA.records.find(r=>r.date===t);
    if(rec){
      if(rec.weight!==w){ rec.weight=w; weightNote='今日体重已更新为 '+w+' kg'; }
      ['waist','hip','thigh'].forEach(function(k){ if(profile[k]) rec[k]=profile[k]; });
    }else{
      const nr={date:t,weight:w,period:false,diet:''};
      ['waist','hip','thigh'].forEach(function(k){ if(profile[k]) nr[k]=profile[k]; });
      DATA.records.push(nr);
    }
  }
  DATA.profile=profile; DATA.agreed=true;
  profile.tier=tierOf(latestWeight(),h);
  save();
  onbEl.hidden=true;
  if(onbRecalib){ appEl.hidden=false; goPage('settings'); toast(weightNote||'体型已重新校准','ok'); }
  else { appEl.hidden=false; goPage('today'); toast('欢迎来到半寸','ok'); }
}

/* =========================================================
   免责 / 备份弹层
   ========================================================= */
function showDisclaimer(){
  openModal(`<button class="modal-close" onclick="__closeModal()">×</button>${DISCLAIMER_HTML}<div class="modal-foot"><button class="btn btn-primary" onclick="__closeModal()">我知道了</button></div>`);
}
function openBackupModal(){
  const payload=JSON.stringify({app:'半寸',...DATA},null,2);
  const blob=new Blob([payload],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  openModal(`<button class="modal-close" onclick="__closeModal()">×</button>
    <h3>备份与恢复</h3>
    <p class="modal-lead">备份文件仅用于在本工具中恢复你的记录、快照与体型设置，不是健康记录，也不含模拟结果说明。</p>
    <div class="backup-info">当前：${DATA.records.length} 条记录 · ${DATA.snapshots.length} 张快照 · 版本 v${DATA.version}</div>
    <div class="file-row">
      <div>导出备份文件</div>
      <a class="btn btn-outline btn-sm" id="dlBackup" href="${url}" download="半寸备份-${today()}.json">下载备份</a>
    </div>
    <div class="file-row">
      <div>从备份文件恢复</div>
      <input type="file" id="restoreFile" accept="application/json,.json">
    </div>
    <div class="modal-foot"><button class="btn btn-primary" onclick="__closeModal()">完成</button></div>`);
  document.getElementById('restoreFile').onchange=(e)=>{
    const f=e.target.files[0]; if(!f) return;
    if(f.size>5*1024*1024){ toast('备份文件过大，无法恢复','err'); return; }
    const reader=new FileReader();
    reader.onload=()=>{
      let raw=null, clean=null;
      try{ raw=JSON.parse(reader.result); clean=sanitizeData(raw); }catch(err){}
      // 格式不对、缺少体型信息时一律拒绝,不动现有数据
      if(!clean||!clean.profile){ toast('备份文件无法识别，现有数据没有改动','err'); return; }
      const dropped=(raw.records.length-clean.records.length);
      const lead='恢复将覆盖当前设备上的记录、快照与体型设置：共 '+clean.records.length+' 条记录、'+clean.snapshots.length+' 张快照。'
        +(dropped>0?'另有 '+dropped+' 条无效或重复的记录已被忽略。':'')+'确定恢复吗？';
      confirmModal('确认恢复',lead,()=>{
        DATA=clean; save(); closeModal(); toast('恢复成功','ok'); showApp();
      });
    };
    reader.onerror=()=>toast('读取备份文件失败','err');
    reader.readAsText(f);
  };
}

/* =========================================================
   落地页：首屏插画 + 试玩模拟器
   ========================================================= */
function initLanding(){
  // 首屏双轮廓
  const hv=document.getElementById('heroFigures');
  if(hv){
    hv.innerHTML=figureSVG({bodyType:'hourglass',loss:0,stroke:'#8d978f'})+
      figureSVG({bodyType:'hourglass',loss:-2,stroke:'#5b7a6b',gain:VIS_GAIN});
  }
  // 试玩体型 chips
  const cg=document.getElementById('demoBodyTypes');
  let demoBt='pear', demoLoss=-1.5;
  if(cg){
    cg.innerHTML=Object.keys(BODY_TYPES).map(k=>`<button class="chip ${k===demoBt?'active':''}" data-bt="${k}">${BODY_TYPES[k].name}</button>`).join('');
    cg.querySelectorAll('.chip').forEach(c=>c.onclick=()=>{
      demoBt=c.dataset.bt;
      cg.querySelectorAll('.chip').forEach(x=>x.classList.toggle('active',x===c));
      drawDemo();
    });
    const sl=document.getElementById('demoLoss');
    sl.oninput=()=>{ demoLoss=parseFloat(sl.value); document.getElementById('demoLossLabel').textContent=demoLoss.toFixed(1)+' kg'; drawDemo(); };
  }
  function drawDemo(){
    const df=document.getElementById('demoFigures'); if(!df) return;
    df.innerHTML=figureSVG({bodyType:demoBt,loss:0,stroke:'#8d978f'})+
      figureSVG({bodyType:demoBt,loss:demoLoss,stroke:'#5b7a6b',gain:VIS_GAIN});
    const p=simulateParams.call(null,demoLoss);
    document.getElementById('demoTalk').textContent=gentleTalk({count:4,tier:'normal',bodyType:demoBt,part:dominantPart(demoBt),loss:demoLoss,days:3});
  }
  if(cg) drawDemo();

  // 滚动出现动画
  const io=new IntersectionObserver(entries=>{
    entries.forEach(e=>{ if(e.isIntersecting){ e.target.classList.add('show'); io.unobserve(e.target);} });
  },{threshold:.12});
  document.querySelectorAll('.reveal').forEach(el=>io.observe(el));

  // 导航
  const nav=document.getElementById('nav');
  window.addEventListener('scroll',()=>nav.classList.toggle('scrolled',window.scrollY>20));
  const mt=document.getElementById('menuToggle');
  const nl=document.getElementById('navLinks');
  if(mt) mt.onclick=()=>nl.classList.toggle('open');
  nl.querySelectorAll('a').forEach(a=>a.onclick=()=>nl.classList.remove('open'));

  // 入口按钮
  ['navEnter','navStart','heroStart','heroDemo','ctaStart'].forEach(id=>{
    const el=document.getElementById(id); if(el) el.onclick=enterApp;
  });
  document.querySelectorAll('.open-disclaimer').forEach(a=>a.onclick=(e)=>{ e.preventDefault(); showDisclaimer(); });
}
function dominantPart(bt){
  let part='waist',max=0;
  ['waist','hip','thigh'].forEach(function(k){
    const v=Math.abs(relChange(bt,k,-1,null));
    if(v>max){ max=v; part=k; }
  });
  return part;
}
function enterApp(){
  if(!DATA.agreed||!DATA.profile) startOnboarding(false);
  else { showApp(); }
}

/* =========================================================
   初始化
   ========================================================= */
function init(){
  initLanding();
  // hash 直达应用内页面（也用于刷新保持当前页）
  const h=(location.hash||'').replace('#','');
  if(PAGES[h]){
    if(DATA.agreed&&DATA.profile){ landingEl.hidden=true; appEl.hidden=false; goPage(h); }
    else { startOnboarding(false); }
  }
  // 侧栏
  document.querySelectorAll('#sideNav button').forEach(b=>b.onclick=()=>goPage(b.dataset.page));
  const ham=document.getElementById('hamburger'); if(ham) ham.onclick=()=>document.getElementById('sidebar').classList.add('open');
  const sc=document.getElementById('sideClose'); if(sc) sc.onclick=()=>document.getElementById('sidebar').classList.remove('open');
  document.getElementById('btnBackup').onclick=openBackupModal;
  document.getElementById('btnDisclaimer').onclick=showDisclaimer;
  document.getElementById('onbClose').onclick=()=>{
    // 退出引导：未完成则回落地页
    showLanding();
  };
  // 模式标识
  const mp=document.getElementById('modePill');
  if(mp) mp.textContent=DATA.guest?'游客体验':'正式账号';
  const sm=document.getElementById('sideMode');
  if(sm) sm.textContent=DATA.guest?'试用中 · 数据只在这台设备上':'你的记录在本设备';
  // 记录提醒(页面打开时每 30 秒检查一次)
  setTimeout(checkReminder,2000); setInterval(checkReminder,30000);
  // 图表宽度随窗口变化重画(只在宽度真的变了时)
  let lastW=window.innerWidth, rzTimer=null;
  window.addEventListener('resize',function(){
    clearTimeout(rzTimer);
    rzTimer=setTimeout(function(){ if(window.innerWidth!==lastW){ lastW=window.innerWidth; redrawCharts(); } },200);
  });
}
function redrawCharts(){
  const wb=document.getElementById('weightChartBox');
  if(wb) wb.innerHTML=weightChart(DATA.records.filter(function(r){ return r.weight; }));
  const gb=document.getElementById('girthChart');
  if(gb) gb.innerHTML=girthChart(DATA.records,GIRTH_PARTS,girthActive);
}

if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init);
else init();
})();
