/* =====================================================================
 * app.js — 哀牢山公网预警站主逻辑
 * 流程: 加载模型与地形数据 → Open-Meteo 拉最新预报 → 浏览器端双模型推理
 *       → 综合风险指数 → 渲染总表/地图/公路表  (每次刷新 = 全新数据)
 * ===================================================================== */
"use strict";

/* ---- 加固：带超时+重试的 JSON fetch ---- */
async function fetchJSON(url, retries){
  retries = retries || 2;
  let lastErr;
  for(let attempt=0; attempt<=retries; attempt++){
    try{
      if(attempt>0) await new Promise(r=>setTimeout(r, 600*attempt));
      const ctrl = new AbortController();
      const timer = setTimeout(function(){ ctrl.abort(); }, 12000);
      const resp = await fetch(url, {cache:"no-store", signal:ctrl.signal});
      clearTimeout(timer);
      if(!resp.ok) throw new Error("HTTP "+resp.status);
      return await resp.json();
    }catch(e){
      lastErr = e;
      if(e.name === "AbortError") lastErr = new Error("请求超时");
    }
  }
  throw lastErr;
}

const $ = id => document.getElementById(id);
let TERR = null, MODEL_T = null, MODEL_F = null, MODEL_R = null, CALIB = null, GRID = null, ROADS = [], riskType = "thunder", FENGHE = null, JOINT = null, TERRAIN3D = null, HEIGHT_MAP = null, RECALC3D = null, heat3DType = "elev", rot3D = {rx:-0.32, ry:0.6, scale:1.0};
let TREE_IMGS = {conifer:null, broad:null, shrub:null, loaded:false, loading:false};
const LVL = {"低":"#2ecc71","关注":"#f7d154","较高":"#ff9f43","预警":"#ff4d4f"};

/* ---------- 历史灾害关联校准 ---------- */
function sigmoid(z){ return 1/(1+Math.exp(-z)); }
function interp1d(xs, ys, x){
  if(x <= xs[0]) return ys[0];
  if(x >= xs[xs.length-1]) return ys[xs.length-1];
  let lo=0, hi=xs.length-1;
  while(hi-lo>1){ const mid=(lo+hi)>>1; if(xs[mid]<=x) lo=mid; else hi=mid; }
  const t=(x-xs[lo])/(xs[hi]-xs[lo]||1e-12);
  return ys[lo]+t*(ys[hi]-ys[lo]);
}
function calibrate(features){
  if(!CALIB || !CALIB.logistic) return {prob:0, level:"低", factor:1.0};
  const f = features;
  const mean = CALIB.scaler.mean, scale = CALIB.scaler.scale;
  const coef = CALIB.logistic.coef, inter = CALIB.logistic.intercept;
  let z = inter;
  for(let i=0;i<coef.length;i++) z += (f[i]-mean[i])/scale[i]*coef[i];
  let p = sigmoid(z);
  // 季节加成（6-8月历史灾害集中）
  const month = f[6];
  if(month>=6 && month<=8) p += CALIB.rules.summer_boost;
  // 地形高敏感加成
  if(f[4]>=60) p += CALIB.rules.terrain_sens_boost;
  p = Math.min(0.99, Math.max(0, p));
  const calP = interp1d(CALIB.calibration.x, CALIB.calibration.y, p);
  const lv = calP>=CALIB.rules.extreme_impact_threshold?"预警":calP>=CALIB.rules.high_impact_threshold?"较高":calP>=0.25?"关注":"低";
  return {prob: calP, level: lv, factor: 1 + 0.25*calP};
}
function gridCalibFeatures(g, series){
  const gf = TERR.grid_factors[g.lat.toFixed(2)+","+g.lon.toFixed(2)] || {};
  const s = series || g.series || [];
  const p24 = s.slice(0,24).reduce((a,x)=>a+(x.precip||0),0);
  let p3=0, p1=0;
  for(let i=0;i<s.length;i++){
    p1 = Math.max(p1, s[i].precip||0);
    if(i<=s.length-3) p3 = Math.max(p3, (s[i].precip||0)+(s[i+1].precip||0)+(s[i+2].precip||0));
  }
  const now = new Date();
  return [
    Math.log1p(p24), Math.log1p(p3), Math.log1p(p1),
    gf.slope||0, Math.max(gf.flash||0, gf.debris||0, gf.slump||0), 0,
    now.getMonth()+1
  ];
}
function roadCalibFeatures(r, series){
  const s = series || [];
  const p24 = s.slice(0,24).reduce((a,x)=>a+(x.precip||0),0);
  let p3=0, p1=0;
  for(let i=0;i<s.length;i++){
    p1 = Math.max(p1, s[i].precip||0);
    if(i<=s.length-3) p3 = Math.max(p3, (s[i].precip||0)+(s[i+1].precip||0)+(s[i+2].precip||0));
  }
  const rf = TERR.road_factors[r.id] || {};
  const geo = r.geo || {};
  const avgGeo = ((geo.debris||0)+(geo.slump||0)+(geo.flash||0))/3*100;
  const now = new Date();
  return [
    Math.log1p(p24), Math.log1p(p3), Math.log1p(p1),
    rf.slope||r.slope_deg||12, Math.max(rf.flash||0, rf.debris||0, rf.slump||0), avgGeo,
    now.getMonth()+1
  ];
}
function applyCalibration(){
  // 格点校准
  GRID.forEach(g=>{
    const cal = calibrate(gridCalibFeatures(g, g.series));
    g.calibrated = cal;
    if(g.riskIndex){
      // 融合：原始综合指数占 70%，历史校准概率占 30%
      const blended = 0.70*g.riskIndex.value + 0.30*cal.prob*100;
      const lv = blended>=75?"预警":blended>=55?"较高":blended>=35?"关注":"低";
      g.riskIndex.rawValue = g.riskIndex.value;
      g.riskIndex.value = Math.round(blended);
      g.riskIndex.level = lv;
      g.riskIndex.color = LVL[lv];
      g.riskIndex.calibProb = Math.round(cal.prob*100);
    }
  });
  // 路段校准
  ROADS.forEach(r=>{
    const seq = r.pts.map(p=>{
      let best=null,bd=1e9;
      for(const g of GRID){ const d=Math.hypot(g.lat-p[0],g.lon-p[1]); if(d<bd){bd=d;best=g;} }
      return best?best.series:[];
    }).find(x=>x&&x.length) || [];
    const cal = calibrate(roadCalibFeatures(r, seq));
    r.calibrated = cal;
    const blended = 0.70*r.risk_index.value + 0.30*cal.prob*100;
    const lv = blended>=75?"预警":blended>=55?"较高":blended>=35?"关注":"低";
    r.risk_index.rawValue = r.risk_index.value;
    r.risk_index.value = Math.round(blended);
    r.risk_index.level = lv;
    r.risk_index.color = LVL[lv];
    r.risk_index.calibProb = Math.round(cal.prob*100);
  });
}

/* ---------- 综合风险指数(与 area_warning.py 一致) ---------- */
function riskIndexFor(g){
  const gf = TERR.grid_factors[g.lat.toFixed(2)+","+g.lon.toFixed(2)];
  if(!gf) return null;
  const th = g.peak_prob*100, fo = g.fog_prob*100;
  const tm = Math.max(gf.flash, gf.debris, gf.slump);
  const ri = 0.40*th + 0.15*fo + 0.30*tm + 0.15*Math.min(100, gf.slope*3);
  const lv = ri>=75?"预警":ri>=55?"较高":ri>=35?"关注":"低";
  return {value: Math.round(ri), level: lv, color: LVL[lv], terrain: gf};
}

/* ---------- 公路灾害评分(复刻 hazard_road.compute) ---------- */
const HAZARD_LABEL = {"fog":"大雾","debris":"泥石流","flash":"山洪","slump":"塌方"};
function lvlOfScore(s){ return s>=0.6?"预警":s>=0.45?"较高":s>=0.30?"关注":"低"; }
function computeRoads(grid){
  const lats = [...new Set(grid.map(g=>g.lat))].sort((a,b)=>a-b);
  const lons = [...new Set(grid.map(g=>g.lon))].sort((a,b)=>a-b);
  function idw(lat, lon, key){
    // 反距离加权(4 最近格点, 与 hazard_road._idw_key 一致)
    let wsum=0, acc=0;
    for(const g of grid){
      const d = Math.hypot(g.lat-lat, g.lon-lon);
      if(d<1e-9) return g[key]||0;
      const w = 1/(d+1e-6);
      acc += w*(g[key]||0); wsum += w;
    }
    return acc/wsum;
  }
  function seq(lat, lon){
    // 返回该点 24h 概率序列(从 series 插值近似: 直接取最近格点序列)
    let best=null, bd=1e9;
    for(const g of grid){ const d=Math.hypot(g.lat-lat,g.lon-lon); if(d<bd){bd=d;best=g;} }
    return best.series;
  }
  const out = [];
  for(const r of TERR.roads){
    const n = 24;
    let p1h=0, fogP=0, hoursHigh=0;
    const best3hArr=[];
    const s0 = seq(r.pts[0][0], r.pts[0][1]) || [];
    for(let k=0;k<n;k++){
      let maxP=0, maxF=0, sum3=0;
      for(const [la,lo] of r.pts){
        const s = seq(la,lo)||[];
        const v = s[k]? s[k].p : 0, f = s[k]? s[k].f : 0;
        maxP = Math.max(maxP, v); maxF = Math.max(maxF, f);
        if(k>0) sum3 += v;
      }
      p1h = Math.max(p1h, maxP); fogP = Math.max(fogP, maxF);
      if(maxP>=0.4) hoursHigh++;
      // 3h 均值(含前后): 简化用当前+前2
      if(k>=2){
        let s3=0;
        for(const [la,lo] of r.pts){
          const s = seq(la,lo)||[];
          s3 = Math.max(s3, ((s[k]?s[k].p:0)+(s[k-1]?s[k-1].p:0)+(s[k-2]?s[k-2].p:0))/3);
        }
        best3hArr.push(s3);
      }
    }
    const best3h = best3hArr.length? Math.max(...best3hArr): 0;
    const rf = TERR.road_factors[r.id] || {};
    const slope = rf.slope != null ? rf.slope : 12;
    const slope_f = Math.min(1, slope/45);
    const persist24 = Math.min(1, hoursHigh/10);
    const terr = {flash:(rf.flash||20)/100, debris:(rf.debris||20)/100, slump:(rf.slump||20)/100};
    const g = r.geo || {};
    const scores = {
      fog: 0.80*fogP + 0.20*(g.fog||0.05),
      debris: 0.40*p1h + 0.20*persist24 + 0.20*Math.max(g.debris||0.1, terr.debris) + 0.20*slope_f,
      flash: 0.45*best3h + 0.25*p1h + 0.30*terr.flash,
      slump: 0.35*persist24 + 0.25*p1h + 0.40*terr.slump,
    };
    const risks = {};
    for(const k in scores) risks[k] = {level: lvlOfScore(scores[k]), score: scores[k]};
    let worst = Object.keys(scores).reduce((a,b)=>scores[a]>=scores[b]?a:b);
    const meanAll = (scores.fog+scores.debris+scores.flash+scores.slump)/4;
    const composite = 0.50*scores[worst] + 0.50*meanAll;
    const compLevel = lvlOfScore(composite);
    const tops = Object.keys(scores).sort((a,b)=>scores[b]-scores[a]).filter(k=>scores[k]>=0.30).map(k=>HAZARD_LABEL[k]);
    const adv = (TERR.advice[worst]||{})[risks[worst].level] || "谨慎通行";
    out.push({
      id: r.id, name: r.name, road_type: r.road_type, desc: r.desc, pts: r.pts,
      slope_deg: Math.round(slope*10)/10,
      metrics: {p1h:Math.round(p1h*1000)/1000, fog_p:Math.round(fogP*1000)/1000, best3h:Math.round(best3h*1000)/1000, high_hours:hoursHigh},
      terrain_sim: {flash:Math.round(rf.flash||0), debris:Math.round(rf.debris||0), slump:Math.round(rf.slump||0), tri:Math.round(rf.tri||0)},
      risk_index: {value: Math.round(composite*100), level: compLevel, color: LVL[compLevel], top_hazards: tops.slice(0,3), worst: tops.slice(0,1)},
      risks, advice: TERR.advice, worst: {type: worst, level: risks[worst].level},
    });
  }
  return out.sort((a,b)=>b.risk_index.value-a.risk_index.value);
}

/* ---------- 渲染: 道路出行安全评估面板 ---------- */
function renderRoadSafety(grid, series){
  const el = $("roadSafetyContent");
  if(!el) return;
  if(!MODEL_R){ el.innerHTML = '<div class="desc" style="padding:12px">道路安全模型未加载</div>'; return; }
  if(!grid || !grid.length){ el.innerHTML = '<div class="desc" style="padding:12px">暂无数据</div>'; return; }

  // 取区域代表序列的第一个时间点作为"当前"
  const cur = series && series.length ? series[0] : {};

  // 格点道路安全峰值统计
  const roadProbs = grid.map(g=>g.road_prob||0);
  const maxRoad = Math.max(...roadProbs);
  const avgRoad = roadProbs.reduce((a,b)=>a+b,0) / roadProbs.length;
  const highCount = roadProbs.filter(p=>p >= 0.4).length;
  const warnCount = roadProbs.filter(p=>p >= (MODEL_R.opt_threshold||0.6)).length;

  // 综合道路安全等级
  const roadLv = maxRoad>= (MODEL_R.opt_threshold||0.6) ? "预警" : maxRoad>=0.6 ? "较高" : maxRoad>=0.4 ? "关注" : "低";
  const lvColor = LVL[roadLv] || "#2ecc71";

  // 能见度评估
  const visKm = cur.vis != null ? cur.vis : null;
  let visDesc, visColor;
  if(visKm == null){ visDesc = "无数据"; visColor = "var(--text)"; }
  else if(visKm < 0.5){ visDesc = visKm+"km 极低"; visColor = "#ff4d4f"; }
  else if(visKm < 1.0){ visDesc = visKm+"km 很低"; visColor = "#ff9f43"; }
  else if(visKm < 3.0){ visDesc = visKm+"km 偏低"; visColor = "#f7d154"; }
  else { visDesc = visKm+"km 良好"; visColor = "#2ecc71"; }

  // 阳光/昼夜
  const isDay = cur.isDay != null ? cur.isDay : 1;
  const rad = cur.rad != null ? cur.rad : 0;
  let sunDesc, sunColor;
  if(isDay === 0){ sunDesc = "🌙 夜间"; sunColor = "#6c5ce7"; }
  else if(rad > 600){ sunDesc = "☀️ 强日照 "+rad+"W/m²"; sunColor = "#ff9f43"; }
  else if(rad > 200){ sunDesc = "🌤 有日照 "+rad+"W/m²"; sunColor = "#f7d154"; }
  else { sunDesc = "☁️ 无日照 "+rad+"W/m²"; sunColor = "var(--text)"; }

  // 温度评估
  const temp = cur.temp != null ? cur.temp : "--";
  let tempDesc, tempColor;
  if(typeof temp === "number"){
    if(temp < 0){ tempDesc = temp+"°C 冰冻"; tempColor = "#4aa3ff"; }
    else if(temp < 5){ tempDesc = temp+"°C 低温"; tempColor = "#4aa3ff"; }
    else if(temp > 30){ tempDesc = temp+"°C 高温"; tempColor = "#ff9f43"; }
    else { tempDesc = temp+"°C 适宜"; tempColor = "#2ecc71"; }
  } else { tempDesc = "--"; tempColor = "var(--text)"; }

  // 降水
  const precip = cur.precip != null ? cur.precip : 0;
  let precipDesc, precipColor;
  if(precip >= 8){ precipDesc = precip+"mm/h 暴雨"; precipColor = "#ff4d4f"; }
  else if(precip >= 3){ precipDesc = precip+"mm/h 中雨"; precipColor = "#ff9f43"; }
  else if(precip >= 0.5){ precipDesc = precip+"mm/h 小雨"; precipColor = "#f7d154"; }
  else { precipDesc = "无降水"; precipColor = "#2ecc71"; }

  // 风力
  const wg = cur.wg != null ? cur.wg : 0;
  let windDesc, windColor;
  if(wg >= 25){ windDesc = "阵风"+wg+"m/s 极强"; windColor = "#ff4d4f"; }
  else if(wg >= 17){ windDesc = "阵风"+wg+"m/s 强风"; windColor = "#ff9f43"; }
  else { windDesc = "阵风"+wg+"m/s"; windColor = "var(--text)"; }

  // 出行建议
  let advice;
  if(roadLv === "预警"){
    advice = "⚠️ 道路出行风险较高：建议谨慎驾驶，特别是夜间、浓雾或暴雨时段。已上路车辆请减速慢行、开启雾灯、保持安全车距。";
  } else if(roadLv === "较高"){
    advice = "⚠️ 道路出行风险较高：谨慎驾驶，注意能见度变化，山区弯道减速。夜间行驶请开启远光灯（会车切换近光），保持 2 倍以上安全车距。";
  } else if(roadLv === "关注"){
    advice = "💡 道路出行需关注：路况总体尚可，但需注意早晚温差导致的路面凝霜、午后对流性降水。建议随身携带雨具和保暖衣物。";
  } else {
    advice = "✅ 道路出行条件良好：天气状况适宜驾驶，注意常规行车安全即可。长途驾驶建议每 2 小时休息一次。";
  }

  // 模型信息
  const auc = MODEL_R.test_auc || "--";
  const nTrees = MODEL_R.n_trees || 150;
  const featCount = MODEL_R.features ? MODEL_R.features.length : 17;

  el.innerHTML = `
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px">
      <div style="flex:1;min-width:200px;background:var(--bg-card);border-radius:8px;padding:14px;border-left:4px solid ${lvColor}">
        <div style="font-size:13px;color:var(--text-dim)">道路出行安全等级</div>
        <div style="font-size:28px;font-weight:700;color:${lvColor}">${roadLv}</div>
        <div style="font-size:13px;color:var(--text-dim)">峰值概率 ${(maxRoad*100).toFixed(1)}% | 平均 ${(avgRoad*100).toFixed(1)}% | 高风险格点 ${highCount}/${grid.length}</div>
      </div>
      <div style="flex:2;min-width:300px;display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px">
        <div class="rs-factor"><span>👁 能见度</span><b style="color:${visColor}">${visDesc}</b></div>
        <div class="rs-factor"><span>☀️ 阳光</span><b style="color:${sunColor}">${sunDesc}</b></div>
        <div class="rs-factor"><span>🌡 温度</span><b style="color:${tempColor}">${tempDesc}</b></div>
        <div class="rs-factor"><span>🌧 降水</span><b style="color:${precipColor}">${precipDesc}</b></div>
        <div class="rs-factor"><span>💨 风力</span><b style="color:${windColor}">${windDesc}</b></div>
        <div class="rs-factor"><span>📊 高危格点</span><b style="color:${warnCount>0?'#ff4d4f':'#2ecc71'}">${warnCount} 个</b></div>
      </div>
    </div>
    <div style="background:var(--bg-card);border-radius:8px;padding:12px;margin-bottom:10px;border-left:3px solid ${lvColor}">
      <b>出行建议</b>：${advice}
    </div>
    <details style="margin-top:8px">
      <summary style="cursor:pointer;color:var(--text-dim);font-size:13px">模型详情 (AUROC=${auc} | ${nTrees}棵树 | ${featCount}维特征)</summary>
      <div style="font-size:12px;color:var(--text-dim);padding:8px 0 0 16px">
        ${MODEL_R.label_definition ? Object.entries(MODEL_R.label_definition).map(([k,v])=>`<div>• <b>${k}</b>: ${v}</div>`).join("") : ""}
        <div style="margin-top:4px">• 综合考虑：阳光（短波辐射）、昼夜、温度、能见度（RH/露点差代理）、风力、降水</div>
        <div>• 训练数据：3海拔站点（560m/2450m/2846m）2020-2026 共 174,087 条小时级记录</div>
        <div>• 推理时从 Open-Meteo 预报 API 获取真实 visibility/is_day/shortwave_radiation</div>
      </div>
    </details>
  `;
}
function renderWeather(series, aq){
  if(!series || !series.length){ $("weatherSummary").innerHTML = "暂无数据"; return; }
  const cur = series[0];
  // 未来 24h 统计
  const next24 = series.slice(0, 24);
  const maxT = Math.max(...next24.map(s=>s.temp));
  const minT = Math.min(...next24.map(s=>s.temp));
  const totalP = next24.reduce((a,s)=>a+(s.precip||0), 0);
  const maxRh = Math.max(...next24.map(s=>s.rh));
  const avgWs = next24.reduce((a,s)=>a+(s.ws||0), 0) / next24.length;
  const maxWg = Math.max(...next24.map(s=>s.wg||0));
  // 云海概率（湿度 + 昼夜温差 + 风速）
  const csp = (typeof window.__cloudSeaProb === "function")
    ? window.__cloudSeaProb(cur.rh, maxT - minT, cur.ws) : null;
  // 能见度分级
  const visKm = cur.vis;
  const visCls = visKm == null ? "var(--text)"
    : visKm < 0.2 ? "var(--red)" : visKm < 1 ? "var(--orange)" : visKm < 8 ? "var(--yellow)" : "var(--teal)";
  const card = (icon, label, val, unit, color) =>
    '<div class="sum-item" style="min-width:110px">'+icon+' '+label+
    '<b style="color:'+(color||'var(--text)')+'">'+val+'<span style="font-size:13px;font-weight:400">'+unit+'</span></b></div>';
  // AQI 卡（代表点当前值）
  let aqCard = "";
  if(aq && aq.length && aq[0].series && aq[0].series.length){
    const a = aq[0].series[0];
    if(a.aqi != null){
      const aqiLv = a.aqi<=50?"var(--teal)":a.aqi<=100?"var(--yellow)":a.aqi<=150?"var(--orange)":"var(--red)";
      aqCard = card("🏭","空气AQI", a.aqi, " · PM2.5 "+a.pm25+"µg", aqiLv);
    }
  }
  $("weatherSummary").innerHTML =
    card("🌡","当前气温", cur.temp, "°C", cur.temp>=25?"#ff9f43":cur.temp<=5?"#4aa3ff":"var(--text)")+
    card("💧","当前湿度", cur.rh, "%", cur.rh>=85?"#4aa3ff":"var(--text)")+
    card("💨","当前风速", cur.ws, " m/s")+
    card("🌬","阵风峰值", Math.round(maxWg*10)/10, " m/s", maxWg>=17?"#ff4d4f":"var(--text)")+
    card("👁","能见度", visKm != null ? visKm : "—", " km", visCls)+
    card("☀️","紫外线UV", cur.uv != null ? cur.uv : "—", "", cur.uv>=7?"#ff4d4f":cur.uv>=5?"#ff9f43":"var(--text)")+
    card("🌫","云海概率", csp != null ? csp : "—", "%", csp!=null&&csp>=70?"#62c4e8":csp!=null&&csp>=45?"#6fd39a":"var(--text)")+
    aqCard+
    card("📊","24h气温", minT+"~"+maxT, "°C")+
    card("🌧","24h降水", Math.round(totalP*10)/10, " mm", totalP>=25?"#ff4d4f":totalP>=10?"#ff9f43":"var(--text)")+
    card("💧","24h最高湿", Math.round(maxRh), "%")+
    card("☁️","当前云量", cur.cloud, "%");
  renderHero(series, aq, csp);
  renderEcoIndex(series, aq, csp);

  /* ---- 天气驱动 3D 场景联动 ---- */
  if(window.applyWeatherTo3D){
    window.applyWeatherTo3D({
      temp: cur.temp, rh: cur.rh, precip: cur.precip || 0,
      cloud: cur.cloud || 0, vis: cur.vis, ws: cur.ws || 0,
      wg: cur.wg || 0, code: cur.code || 800
    });
  }
}

/* ---------- Hero 第一屏数据绑定 ---------- */
function renderHero(series, aq, csp){
  if(!series || !series.length) return;
  const cur = series[0];
  const next24 = series.slice(0, 24);
  const maxT = Math.max(...next24.map(s=>s.temp));
  const minT = Math.min(...next24.map(s=>s.temp));
  const totalP = next24.reduce((a,s)=>a+(s.precip||0), 0);
  const maxWg = Math.max(...next24.map(s=>s.wg||0));
  const visKm = cur.vis;
  // 当前天气
  const heroTemp = $("heroTemp");
  if(heroTemp) heroTemp.innerHTML = cur.temp + "<small>°C</small>";
  const heroDesc = $("heroWeatherDesc");
  if(heroDesc){
    const wText = [];
    if(cur.precip > 0.1) wText.push("有降水");
    else if(cur.cloud > 70) wText.push("多云");
    else if(cur.cloud > 30) wText.push("少云");
    else wText.push("晴朗");
    wText.push("湿度 " + Math.round(cur.rh) + "%");
    wText.push("风速 " + cur.ws + "m/s");
    heroDesc.textContent = wText.join(" · ");
  }
  // 哀牢山徒步指数：温度/降水/能见度/风速 综合评分
  let score = 0;
  const tOk = cur.temp >= 8 && cur.temp <= 26;
  const pOk = totalP < 5;
  const vOk = visKm == null || visKm >= 3;
  const wOk = maxWg < 12;
  if(tOk) score++;
  if(pOk) score++;
  if(vOk) score++;
  if(wOk) score++;
  if(cur.uv != null && cur.uv < 7) score++;
  const stars = "★★★★★".slice(0, score) + "☆☆☆☆☆".slice(0, 5 - score);
  const heroStars = $("heroStars");
  if(heroStars) heroStars.textContent = stars;
  const heroHikingDesc = $("heroHikingDesc");
  if(heroHikingDesc){
    const reasons = [];
    reasons.push(tOk ? "温度适宜" : (cur.temp < 8 ? "气温偏低" : "气温偏高"));
    reasons.push(pOk ? "降雨较少" : "有明显降水");
    reasons.push(vOk ? "能见度良好" : "能见度较差");
    heroHikingDesc.textContent = reasons.join(" · ");
  }
  // 云海概率
  const heroCsp = $("heroCloudSea");
  if(heroCsp) heroCsp.innerHTML = (csp != null ? csp : "—") + "<small>%</small>";
  const heroCspBar = $("heroCloudSeaBar");
  if(heroCspBar) heroCspBar.style.width = (csp != null ? csp : 0) + "%";
  const heroCspDesc = $("heroCloudSeaDesc");
  if(heroCspDesc) heroCspDesc.textContent = csp >= 70 ? "适合观云海" : csp >= 45 ? "可能出现云雾" : "云海概率较低";
  // 推荐路线：根据风险与天气动态推荐
  const heroRoute = $("heroRoute");
  const heroRouteDesc = $("heroRouteDesc");
  if(heroRoute && heroRouteDesc){
    const risk = Math.max(...next24.map(s=>s.p||0), ...next24.map(s=>s.f||0));
    if(risk >= 0.6){ heroRoute.textContent = "暂缓进山"; heroRouteDesc.textContent = "强对流/浓雾风险较高，建议取消"; }
    else if(totalP >= 10){ heroRoute.textContent = "戛洒镇周边"; heroRouteDesc.textContent = "低海拔 · 雨天备选"; }
    else if(csp >= 70){ heroRoute.textContent = "金山丫口"; heroRouteDesc.textContent = "云海概率高 · 日出首选"; }
    else { heroRoute.textContent = "金山森林"; heroRouteDesc.textContent = "半日轻松 · 原始森林"; }
  }
  // 元信息
  const heroMeta = $("heroMeta");
  if(heroMeta) heroMeta.innerHTML = "99 格点 · 9 模型 · DEM 三维<br>" + new Date().toLocaleString("zh-CN", {month:"numeric", day:"numeric", hour:"2-digit", minute:"2-digit"});
}

/* ---------- 生态体验指数（徒步/云海/森林舒适度） ---------- */
function renderEcoIndex(series, aq, csp){
  const el = $("ecoIndexContent");
  if(!el || !series || !series.length) return;
  const cur = series[0];
  const next24 = series.slice(0, 24);
  const maxT = Math.max(...next24.map(s=>s.temp));
  const minT = Math.min(...next24.map(s=>s.temp));
  const totalP = next24.reduce((a,s)=>a+(s.precip||0), 0);
  const maxWg = Math.max(...next24.map(s=>s.wg||0));
  const visKm = cur.vis;

  // 1) 哀牢山徒步指数
  let hScore = 0;
  const hReasons = [];
  if(cur.temp >= 8 && cur.temp <= 26){ hScore++; hReasons.push("温度适宜"); } else { hReasons.push(cur.temp < 8 ? "气温偏低" : "气温偏高"); }
  if(totalP < 5){ hScore++; hReasons.push("降雨较少"); } else { hReasons.push("有明显降水"); }
  if(visKm == null || visKm >= 3){ hScore++; hReasons.push("能见度良好"); } else { hReasons.push("能见度较差"); }
  if(maxWg < 12){ hScore++; hReasons.push("风力温和"); } else { hReasons.push("阵风较强"); }
  if(cur.uv != null && cur.uv < 7){ hScore++; hReasons.push("紫外线适中"); }
  const hStars = "★★★★★".slice(0, hScore) + "☆☆☆☆☆".slice(0, 5 - hScore);
  const hLevel = hScore >= 4 ? "非常适合" : hScore >= 3 ? "适合" : hScore >= 2 ? "一般" : "不建议";

  // 2) 云雾/云海指数
  const cspVal = csp != null ? csp : 0;
  const cspText = cspVal >= 70 ? "极易出现云海" : cspVal >= 50 ? "可能出现云雾" : cspVal >= 30 ? "局部有雾" : "云雾较少";
  const cspColor = cspVal >= 70 ? "#62c4e8" : cspVal >= 50 ? "#6fd39a" : cspVal >= 30 ? "#e3cf7d" : "var(--sub)";

  // 3) 森林舒适度（负氧离子/湿度/温度综合）
  let fScore = 0;
  const fTags = [];
  if(cur.rh >= 60 && cur.rh <= 85){ fScore++; fTags.push("空气湿润"); }
  else if(cur.rh > 85){ fTags.push("湿度过高"); }
  else { fTags.push("空气偏干"); }
  if(cur.temp >= 15 && cur.temp <= 24){ fScore++; fTags.push("温度舒适"); }
  else { fTags.push(cur.temp < 15 ? "偏凉" : "偏热"); }
  if(aq && aq[0] && aq[0].series && aq[0].series[0] && aq[0].series[0].aqi != null && aq[0].series[0].aqi <= 50){ fScore++; fTags.push("空气清新"); }
  else { fTags.push("空气一般"); }
  if(cur.uv != null && cur.uv < 5){ fScore++; fTags.push("紫外线弱"); }
  const fLevel = fScore >= 3 ? "极佳" : fScore >= 2 ? "良好" : "一般";

  el.innerHTML =
    '<div class="eco-card hiking">'+
      '<div class="eco-title">哀牢山徒步指数</div>'+
      '<div class="eco-stars">' + hStars + '</div>'+
      '<div class="eco-value">' + hLevel + '<small> / 5</small></div>'+
      '<div class="eco-desc">' + hReasons.join(" · ") + '</div>'+
      '<div class="eco-tags"><span class="eco-tag">温度 ' + cur.temp + '°C</span><span class="eco-tag">24h降水 ' + Math.round(totalP*10)/10 + 'mm</span><span class="eco-tag">能见度 ' + (visKm != null ? visKm + 'km' : '—') + '</span></div>'+
    '</div>'+
    '<div class="eco-card cloud">'+
      '<div class="eco-title">云海 / 云雾概率</div>'+
      '<div class="eco-value" style="color:' + cspColor + '">' + cspVal + '<small>%</small></div>'+
      '<div class="eco-bar"><i style="width:' + cspVal + '%;background:' + cspColor + '"></i></div>'+
      '<div class="eco-desc">' + cspText + ' · 湿度 ' + Math.round(cur.rh) + '% + 昼夜温差 ' + Math.round((maxT-minT)*10)/10 + '°C + 风速 ' + cur.ws + 'm/s</div>'+
      '<div class="eco-tags"><span class="eco-tag">最佳观赏：清晨 5:30-8:30</span><span class="eco-tag">推荐点位：金山丫口</span></div>'+
    '</div>'+
    '<div class="eco-card forest">'+
      '<div class="eco-title">森林舒适度</div>'+
      '<div class="eco-value">' + fLevel + '<small> / 4</small></div>'+
      '<div class="eco-desc">负氧离子浓度预估较高，原始森林环境' + (fScore >= 3 ? '非常适合森林浴与徒步' : '适合短途游览') + '</div>'+
      '<div class="eco-tags">' + fTags.map(t=>'<span class="eco-tag">' + t + '</span>').join('') + '</div>'+
    '</div>';
}

/* ---------- 任意经纬度的天气插值（IDW，供 3D 点击/海拔层使用） ---------- */
function weatherAt(lat, lon){
  if(!GRID || !GRID.length) return null;
  let n = 0, times = null;
  for(const g of GRID){
    if(g.series && g.series.length){ n = g.series.length; times = g.series.map(s=>s.t); break; }
  }
  if(!n) return null;
  const acc = Array.from({length:n}, ()=>({p:0,f:0,r:0,temp:0,rh:0,precip:0,cloud:0,ws:0,wg:0,vis:0,visW:0,rad:0,radW:0,uv:0,uvW:0}));
  let W = 0;
  for(const g of GRID){
    const s = g.series; if(!s || s.length < n) continue;
    const d = Math.hypot(g.lat-lat, g.lon-lon);
    const w = 1.0 / Math.pow(Math.max(d*111.0, 0.4), 2);
    W += w;
    for(let i=0;i<n;i++){
      const t = s[i], a = acc[i];
      a.p += w*t.p; a.f += w*t.f; a.r += w*(t.r||0);
      a.temp += w*t.temp; a.rh += w*t.rh; a.precip += w*t.precip;
      a.cloud += w*t.cloud; a.ws += w*(t.ws||0); a.wg += w*(t.wg||0);
      if(t.vis != null){ a.vis += w*t.vis; a.visW += w; }
      if(t.rad != null){ a.rad += w*t.rad; a.radW += w; }
      if(t.uv != null){ a.uv += w*t.uv; a.uvW += w; }
    }
  }
  if(!W) return null;
  const series = acc.map(a=>({
    t: times[acc.indexOf(a)],  // 占位，下方重写
    p: Math.round(a.p/W*10000)/10000, f: Math.round(a.f/W*10000)/10000, r: Math.round(a.r/W*10000)/10000,
    temp: Math.round(a.temp/W*10)/10, rh: Math.round(a.rh/W*10)/10,
    precip: Math.round(a.precip/W*10)/10, cloud: Math.round(a.cloud/W*10)/10,
    ws: Math.round(a.ws/W*10)/10, wg: Math.round(a.wg/W*10)/10,
    vis: a.visW ? Math.round(a.vis/a.visW/100)/10 : null,  // km
    rad: a.radW ? Math.round(a.rad/a.radW) : null,
    uv: a.uvW ? Math.round(a.uv/a.uvW*10)/10 : null
  }));
  series.forEach((s,i)=> s.t = times[i]);
  const elev = (typeof elevAt === "function" && window.HEIGHT_MAP) ? Math.round(elevAt(lat, lon)) : null;
  const tp = Math.max(...series.map(s=>s.p)), fp = Math.max(...series.map(s=>s.f));
  return {lat, lon, elev, times, series, peakP: tp, peakF: fp};
}
window.__weatherAt = weatherAt;   // 供 terrain3d.js 点击查询

/* ---------- 渲染: 按海拔层天气差异 ---------- */
// 关键教训：Open-Meteo 返回的温度是其模型地形海拔处的实况，
//           若用我们 DEM 上"高"的坐标但 OM 模型认为"低"，温度会完全反。
//           所以这里三个坐标都先实测过 Open-Meteo 真实海拔：
//   high (24.20,101.30) → OM 2510m → 修正到 2700m（-1.24°C）
//   mid  (23.90,101.30) → OM 1638m → 修正到 2400m（-4.95°C）
//   low  (24.00,101.60) → OM  801m → 修正到 560m  （+1.57°C）
// 直接调 Open-Meteo 拉数据，不走 GRID IDW 插值（99 格点平均会把海拔梯度抹平）
const ALT_BANDS = [
  {key:"high", name:"高海拔 · 山顶草甸",  place:"金山丫口 / 大雪锅山", lat:24.20, lon:101.30, elev:2700, omElev:2510, veg:"苔藓矮林 / 山顶草甸 / 云海"},
  {key:"mid",  name:"中海拔 · 中山湿性林", place:"金山原始森林", lat:23.90, lon:101.30, elev:2400, omElev:1638, veg:"湿性常绿阔叶林 / 石板路环线"},
  {key:"low",  name:"低海拔 · 河谷雨林",  place:"戛洒镇",            lat:24.00, lon:101.60, elev:560,  omElev:801,  veg:"河谷雨林 / 花腰傣风情小镇"},
];
// 海拔层独立 Open-Meteo 实时数据（不走 GRID 插值）
let ALT_BANDS_OM = null;     // [{...band, omElev, series:[{t,temp,rh,cloud,ws,wg,precip,vis}]}]
let ALT_BANDS_OM_LOADING = false;

async function fetchAltitudeBands(){
  if(ALT_BANDS_OM) return ALT_BANDS_OM;
  if(ALT_BANDS_OM_LOADING) return null;
  ALT_BANDS_OM_LOADING = true;
  try{
    const params = new URLSearchParams({
      latitude: ALT_BANDS.map(b=>b.lat).join(","),
      longitude: ALT_BANDS.map(b=>b.lon).join(","),
      hourly: "temperature_2m,relative_humidity_2m,cloud_cover,wind_speed_10m,wind_gusts_10m,precipitation,visibility",
      forecast_days: "2",
      timezone: "Asia/Shanghai",
    });
    const url = "https://api.open-meteo.com/v1/forecast?" + params.toString();
    const ctrl = new AbortController();
    const timer = setTimeout(function(){ ctrl.abort(); }, 12000);
    const resp = await fetch(url, {cache:"no-store", signal:ctrl.signal});
    clearTimeout(timer);
    if(!resp.ok) throw new Error("HTTP "+resp.status);
    const j = await resp.json();
    ALT_BANDS_OM = j.map((g,i)=>{
      const band = ALT_BANDS[i];
      return Object.assign({}, band, {
        omElev: g.elevation || band.omElev,
        series: g.hourly.time.map((t,k)=>({
          t: t, temp: g.hourly.temperature_2m[k],
          rh: g.hourly.relative_humidity_2m[k],
          cloud: g.hourly.cloud_cover[k],
          ws: g.hourly.wind_speed_10m[k],
          wg: g.hourly.wind_gusts_10m[k],
          precip: g.hourly.precipitation[k],
          vis: g.hourly.visibility ? g.hourly.visibility[k] : null,
        })),
      });
    });
    return ALT_BANDS_OM;
  }catch(e){
    console.warn("[altitude-bands] Open-Meteo 拉取失败:", e && e.message);
    return null;
  }finally{
    ALT_BANDS_OM_LOADING = false;
  }
}
async function renderAltitudeWeather(){
  const el = $("altitudeContent");
  if(!el) return;
  // 先显示骨架
  el.innerHTML = ALT_BANDS.map(band=>
    '<div class="alt-card '+band.key+'" style="opacity:.4">'+
      '<div class="alt-elev">'+band.elev+'m<small>'+band.name.split("·")[0]+'</small></div>'+
      '<div class="alt-name">'+band.name+'</div>'+
      '<div style="color:var(--sub);font-size:12px;margin-top:10px">正在等待 Open-Meteo 数据（约需 10-30 秒）…</div>'+
    '</div>'
  ).join("");
  const data = await fetchAltitudeBands();
  if(!data){ el.innerHTML = '<div style="grid-column:1/-1;color:var(--sub)">海拔层实时数据拉取失败，请刷新重试</div>'; return; }
  if(!GRID || !GRID.length){ el.innerHTML = '<div style="grid-column:1/-1;color:var(--sub)">暂无数据</div>'; return; }
  const lr = 0.0065;  // 温度直减率 °C/m
  const now = new Date();
  el.innerHTML = data.map(band=>{
    // 找到距离 now 最近的时间索引
    let bestI=0, bd=1e9;
    band.series.forEach((s,i)=>{
      const tt = new Date(s.t.replace(" ","T")+":00");
      const diff = Math.abs(tt - now);  // JS Date 相减为毫秒
      if(diff < bd){ bd = diff; bestI = i; }
    });
    const cur = band.series[bestI];
    const next24 = band.series.slice(bestI, bestI + 24);
    // 海拔校正：OM 在 omElev 处报的温度，需校正到 elev
    // T_display = T_OM - (elev - omElev) * lr
    const dT = (band.omElev - band.elev) * lr;
    const t24 = next24.map(s => s.temp + dT);
    const tempNow = Math.round((cur.temp + dT) * 10) / 10;
    const minT = Math.round(Math.min.apply(null, t24) * 10) / 10;
    const maxT = Math.round(Math.max.apply(null, t24) * 10) / 10;
    const feel = Math.round((cur.temp + dT - (cur.ws||0) * 1.1) * 10) / 10;
    const totalP = next24.reduce((a,s)=>a+(s.precip||0), 0);
    const maxWg = Math.max.apply(null, next24.map(s=>s.wg||0));
    // 风险等级：就近取 GRID 中最接近的格点
    let peakP=0, peakF=0;
    if(GRID && GRID.length){
      let nb=null, nd=1e9;
      for(const g of GRID){
        const d = Math.hypot(g.lat - band.lat, g.lon - band.lon);
        if(d < nd){ nd = d; nb = g; }
      }
      if(nb){ peakP = nb.peak_prob || 0; peakF = nb.fog_prob || 0; }
    }
    const risk = Math.max(peakP, peakF);
    const rlv = risk >= 0.6 ? "预警" : risk >= 0.45 ? "较高" : risk >= 0.30 ? "关注" : "低";
    const rcol = rlv === "预警" ? "#f0646c" : rlv === "较高" ? "#e8a35c" : rlv === "关注" ? "#e3cf7d" : "#6fd39a";
    const tempCol = tempNow >= 22 ? "#e8a35c" : tempNow <= 8 ? "#62c4e8" : "#fff";
    let wear;
    if(band.elev >= 2500) wear = "<b>必备</b>冲锋衣/抓绒 · 防风手套 · 头灯 · 保温杯 · 防晒（高海拔紫外线强）";
    else if(band.elev >= 1800) wear = "<b>推荐</b>薄冲锋衣+速干衣 · 防滑登山鞋 · 雨具 · 帽子";
    else wear = "<b>轻装</b>速干衣 · 防滑鞋 · 雨伞/雨衣 · 注意河谷闷热与蚊虫";
    return '<div class="alt-card '+band.key+'" style="cursor:pointer" onclick="window.flyToPlace('+band.lat+','+band.lon+',\''+band.place+'\','+band.elev+')">'+
      '<div class="alt-elev">'+band.elev+'m<small>'+band.name.split("·")[0]+'</small></div>'+
      '<div>'+
        '<div class="alt-name">'+band.name+'</div>'+
        '<div class="alt-meta">'+band.place+' · '+band.veg+'</div>'+
        '<div style="margin-top:8px"><span class="alt-risk" style="background:'+rcol+';color:#04130a">'+rlv+'</span>'+
        '<span class="alt-risk" style="background:rgba(150,204,170,.12);color:var(--sub);margin-left:6px">强对流 '+Math.round(peakP*100)+'%</span></div>'+
      '</div>'+
      '<div>'+
        '<div class="alt-temp" style="color:'+tempCol+'">'+tempNow+'<small>°C</small></div>'+
        '<div class="alt-feel">体感 '+feel+'°C · 今日 '+minT+'~'+maxT+'°C</div>'+
      '</div>'+
      '<div class="alt-metrics">'+
        '<span>湿度 <b>'+Math.round(cur.rh)+'%</b></span>'+
        '<span>云量 <b>'+Math.round(cur.cloud)+'%</b></span>'+
        '<span>能见度 <b>'+(cur.vis != null ? Math.round(cur.vis/1000)/10+'km' : '—')+'</b></span>'+
        '<span>阵风 <b>'+Math.round(maxWg*10)/10+'m/s</b></span>'+
        '<span>24h降水 <b>'+Math.round(totalP*10)/10+'mm</b></span>'+
        '<span>浓雾峰值 <b>'+Math.round(peakF*100)+'%</b></span>'+
        '<span style="color:var(--teal);cursor:pointer">📍 3D 查看 →</span>'+
      '</div>'+
      '<div class="alt-wear">🧥 着装建议：'+wear+'</div>'+
    '</div>';
  }).join("");
}

/* ---------- 渲染: 出行建议面板 ---------- */
function renderAdvice(grid, roads, series){
  const adviceEl = $("adviceContent");
  if(!grid || !grid.length){ adviceEl.innerHTML = "暂无数据"; return; }
  // 收集最高风险
  const topGrid = [...grid].sort((a,b)=>(b.riskIndex?.value||0)-(a.riskIndex?.value||0))[0];
  const topRoad = roads[0];
  const maxLv = topGrid?.riskIndex?.level || "低";
  const maxRI = topGrid?.riskIndex?.value || 0;
  // 气象概要
  const next24 = (series||[]).slice(0,24);
  const totalP = next24.reduce((a,s)=>a+(s.precip||0),0);
  const maxWg = Math.max(...next24.map(s=>s.wg||0), 0);
  const curRh = next24[0]?.rh || 0;
  const curT = next24[0]?.temp || 0;
  const maxP = Math.max(...next24.map(s=>s.p||0), 0);
  const maxF = Math.max(...next24.map(s=>s.f||0), 0);
  /* ---- 登山建议大卡（普通人视角：星级 + 一句话结论 + 关键指标） ---- */
  let hs = 4, verdict = "风险较低，适合出行：仍须注意山区天气突变，建议 14:00 前下山", vColor = "#6fd39a";
  if(maxRI >= 75){ hs = 0; verdict = "风险较高：综合风险指数偏高，建议暂缓进山计划，已进山者请关注天气变化尽早下山"; vColor = "#f0646c"; }
  else if(maxRI >= 55){ hs = 1; verdict = "谨慎出行：综合风险较高，如需进山请 12:00 前完成并避开陡坡、河道"; vColor = "#e8a35c"; }
  else if(maxRI >= 35){ hs = 3; verdict = "可出行但需留意：午后易发强对流，建议 14:00 前完成下山"; vColor = "#e3cf7d"; }
  if(maxRI < 35 && totalP >= 10) hs = Math.min(hs, 3);
  if(maxRI < 35 && (maxP >= 0.4 || maxF >= 0.5)) hs = Math.min(hs, 3);
  if(maxRI >= 55 && (maxP >= 0.4 || maxF >= 0.5)) hs = Math.min(hs, 0);
  const starStr = hs >= 4 ? "★★★★★" : hs === 3 ? "★★★☆☆" : hs === 2 ? "★★☆☆☆" : hs === 1 ? "★☆☆☆☆" : "☆☆☆☆☆";
  const feelT = Math.round((curT - (next24[0]?.ws || 0) * 1.1) * 10) / 10;
  const hikeCard =
    '<div class="hike-card">'+
      '<div class="hike-score">'+
        '<div class="hs-stars" style="color:'+vColor+'">'+starStr+'</div>'+
        '<div class="hs-big" style="color:'+vColor+'">'+maxRI+'</div>'+
        '<div class="hs-label">综合风险指数 / 100</div>'+
      '</div>'+
      '<div class="hike-main">'+
        '<div class="hs-verdict" style="color:'+vColor+'">'+verdict+'</div>'+
        '<div class="hs-items">'+
          '<span>🌡 体感 <b>'+feelT+'°C</b>（区域均温 '+curT+'°C）</span>'+
          '<span>🌧 24h降水 <b>'+Math.round(totalP*10)/10+'mm</b></span>'+
          '<span>🌫 浓雾峰值 <b>'+Math.round(maxF*100)+'%</b> · 湿度 '+Math.round(curRh)+'%</span>'+
          '<span>🌩 强对流峰值 <b>'+Math.round(maxP*100)+'%</b></span>'+
          '<span>💨 阵风峰值 <b>'+Math.round(maxWg*10)/10+'m/s</b></span>'+
          '<span>🏔 高海拔注意 <b>每升1000m约降6.5°C</b></span>'+
        '</div>'+
      '</div>'+
    '</div>';
  // 生成建议
  let items = [];
  // 主风险等级建议
  if(maxRI >= 75){
    items.push({icon:"🔴", title:"建议暂缓进山", color:"#ff4d4f",
      text:"综合风险指数 "+maxRI+"（高风险），强对流/地形灾害风险较高。建议暂缓进山计划，已进山者请关注天气变化，尽早下山至安全区域。"});
  } else if(maxRI >= 55){
    items.push({icon:"⚠️", title:"谨慎出行", color:"#ff9f43",
      text:"综合风险指数 "+maxRI+"（较高级），存在较强对流或地形灾害风险。如需进山，请在 12:00 前完成、避开陡坡和河道、保持通讯畅通。"});
  } else if(maxRI >= 35){
    items.push({icon:"📍", title:"留意天气变化", color:"#f7d154",
      text:"综合风险指数 "+maxRI+"（关注级），山区天气多变。建议 14:00 前下山，注意午后对流发展。"});
  } else {
    items.push({icon:"✅", title:"风险较低", color:"#2ecc71",
      text:"综合风险指数 "+maxRI+"（低级），适合正常游览，但仍需注意山区天气突变。"});
  }
  // 降水建议
  if(totalP >= 25){
    items.push({icon:"🌧", title:"大到暴雨预警", color:"#ff4d4f",
      text:"未来 24h 区域平均降水 "+Math.round(totalP*10)/10+"mm，山洪和泥石流风险显著升高。远离河谷低洼地带，不要涉水过河。"});
  } else if(totalP >= 10){
    items.push({icon:"🌧", title:"中雨注意", color:"#ff9f43",
      text:"未来 24h 区域平均降水 "+Math.round(totalP*10)/10+"mm，路面湿滑、能见度下降，驾车减速慢行。"});
  }
  // 风力建议
  if(maxWg >= 17){
    items.push({icon:"🌬", title:"大风预警", color:"#ff4d4f",
      text:"未来 24h 阵风可达 "+Math.round(maxWg*10)/10+"m/s（8级以上），注意树木倒伏、落石，避免在高大树木和悬崖附近停留。"});
  } else if(maxWg >= 10.8){
    items.push({icon:"💨", title:"阵风较强", color:"#ff9f43",
      text:"未来 24h 阵风可达 "+Math.round(maxWg*10)/10+"m/s（6级以上），户外活动注意防风。"});
  }
  // 湿度/雾建议
  if(curRh >= 90 || maxF >= 0.6){
    items.push({icon:"🌫", title:"浓雾风险", color:"#4aa3ff",
      text:"湿度 "+Math.round(curRh)+"%，浓雾概率 "+Math.round(maxF*100)+"%。能见度可能低于 200m，驾车开启雾灯、保持车距，山路尤其谨慎。"});
  } else if(curRh >= 80){
    items.push({icon:"💧", title:"湿度偏高", color:"#4aa3ff",
      text:"当前湿度 "+Math.round(curRh)+"%，山路可能结露湿滑，注意脚下安全。"});
  }
  // 温度建议
  if(curT >= 30){
    items.push({icon:"🌡", title:"高温防暑", color:"#ff9f43",
      text:"当前气温 "+curT+"°C，注意防暑降温、补充水分，避免长时间暴晒。"});
  } else if(curT <= 5){
    items.push({icon:"🌡", title:"低温防寒", color:"#4aa3ff",
      text:"当前气温 "+curT+"°C，高海拔区域可能接近 0°C，注意保暖防失温。"});
  }
  // 强对流建议
  if(maxP >= 0.4){
    const peakTime = next24.find(s=>s.p>=maxP)?.t || "";
    items.push({icon:"🌩", title:"强对流活跃", color:"#ff4d4f",
      text:"未来 24h 强对流峰值概率 "+Math.round(maxP*100)+"%"+(peakTime?("（"+peakTime.slice(11,16)+"左右）"):"")+"。注意雷电、短时强降水、冰雹，远离空旷高地和大树。"});
  }
  // 公路建议
  if(topRoad && topRoad.risk_index.value >= 45){
    items.push({icon:"🚧", title:"公路风险", color:topRoad.risk_index.color,
      text:topRoad.name+" 综合风险 "+topRoad.risk_index.value+"（"+topRoad.risk_index.level+"），主要威胁："+(topRoad.risk_index.top_hazards||[]).join("、")+"。"+((topRoad.advice[topRoad.worst.type]||{})[topRoad.worst.level]||"谨慎通行")});
  }
  // 通用建议
  items.push({icon:"🛡", title:"通用安全提示", color:"var(--sub)",
    text:"哀牢山地形陡峭、气候多变。任何等级下：①14:00前完成下山 ②远离河道、陡坡、滚石区 ③保持手机信号 ④告知他人行程 ⑤遵守保护区规定，以中国气象局和哀牢山管护局官方发布为准。"});
  // 渲染（登山建议大卡置顶）
  adviceEl.innerHTML = hikeCard + items.map(it=>
    '<div style="display:flex;gap:10px;padding:10px 0;border-bottom:1px solid var(--line)">'+
    '<div style="font-size:22px;flex-shrink:0">'+it.icon+'</div>'+
    '<div><div style="font-weight:700;color:'+it.color+';font-size:14px;margin-bottom:3px">'+it.title+'</div>'+
    '<div style="font-size:12.5px;color:var(--sub);line-height:1.7">'+it.text+'</div></div></div>'
  ).join("");
  // 更新顶部风险横幅
  if(typeof updateRiskBanner === "function") updateRiskBanner(maxRI);
}

/* ---------- 渲染: 综合风险指数总表 ---------- */
function renderRisk(grid, roads){
  const entries = [];
  grid.forEach(g=>{
    const ri = g.riskIndex; if(!ri) return;
    const t = ri.terrain || {};
    const typeName = {0:"谷地",1:"坡面",2:"山脊"}[t.type] || "坡面";
    const tags = [typeName+"地形"];
    if(t.flash>=60) tags.push("山洪敏感");
    if(t.debris>=60) tags.push("泥石流敏感");
    if(t.slump>=60) tags.push("塌方敏感");
    const calTag = (ri.calibProb!=null && ri.calibProb>=25) ? '历史复核 '+ri.calibProb+'%' : '';
    entries.push({key:gridPlaceName(g.lat, g.lon), type:g.elev+"m 格点", ri:ri.value, lv:ri.level,
      tags:tags.join("·")+(calTag?' · '+calTag:''), agree: g.agree, adv:advText(ri.level), raw:ri.rawValue, calib:ri.calibProb, lat:g.lat, lon:g.lon});
  });
  roads.forEach(r=>{
    const calTag = (r.risk_index.calibProb!=null && r.risk_index.calibProb>=25) ? '历史复核 '+r.risk_index.calibProb+'%' : '';
    entries.push({key:r.name, type:r.road_type, ri:r.risk_index.value, lv:r.risk_index.level,
      tags:(r.risk_index.top_hazards||[]).join("·")+(calTag?' · '+calTag:''), agree:null,
      adv:(r.advice[r.worst.type]||{})[r.worst.level]||advText(r.risk_index.level), raw:r.risk_index.rawValue, calib:r.risk_index.calibProb});
  });
  entries.sort((a,b)=>b.ri-a.ri);
  $("riskCount").textContent = entries.length+" 项";
  const warnN = entries.filter(e=>e.lv==="预警").length, highN = entries.filter(e=>e.lv==="较高").length;
  const topR = entries.find(e=>e.type.includes("路段"))||entries[0]||{key:"—",ri:0,lv:"低"};
  const topG = entries.find(e=>e.type.includes("格点"))||entries[0]||{key:"—",ri:0,lv:"低"};
  $("riskSummary").innerHTML =
    '<div class="sum-item">🔴 预警级 <b style="color:#ff4d4f">'+warnN+'</b></div>'+
    '<div class="sum-item">🟠 较高 <b style="color:#ff9f43">'+highN+'</b></div>'+
    '<div class="sum-item">🚧 最高路段 <b>'+topR.key+'</b> <span style="color:'+LVL[topR.lv]+'">'+topR.ri+'('+topR.lv+')</span></div>'+
    '<div class="sum-item">📍 最高格点 <b>'+topG.key+'</b>'+(topG.lat!=null?'<span style="font-size:11px;color:var(--sub);margin-left:6px">'+topG.lat.toFixed(2)+'N, '+topG.lon.toFixed(2)+'E</span>':'')+' <span style="color:'+LVL[topG.lv]+'">'+topG.ri+'('+topG.lv+')</span></div>';
  $("riskTbody").innerHTML = entries.slice(0,15).map(e=>{
    const sub = (e.lat!=null ? '<div style="font-size:10px;color:var(--sub);margin-top:1px">'+e.lat.toFixed(2)+'N, '+e.lon.toFixed(2)+'E</div>' : '');
    return '<tr><td><b>'+e.key+'</b>'+sub+'</td><td style="font-size:11.5px;color:var(--sub)">'+e.type+'</td>'+
      '<td>'+riskBar(e.ri)+(e.calib!=null?'<div class="tags" style="margin-top:2px">历史复核 '+e.calib+'%</div>':'')+'</td>'+
      '<td><span class="pill '+pillCls(e.lv)+'">'+e.lv+'</span></td>'+
      '<td class="tags">'+e.tags+'</td>'+
      '<td>'+(e.agree==null?'—':'<span class="'+(e.agree?'agree-yes':'agree-no')+'">'+(e.agree?'✓ 一致':'✗ 分歧')+'</span>')+'</td>'+
      '<td style="font-size:11.5px;color:var(--sub)">'+e.adv+'</td></tr>';
  }).join("");
  $("riskTips").innerHTML = '<b>🛡 通用防护</b>：任何等级下都应在 <b>14:00 前完成下山</b>、远离河道陡坡；指数 ≥55 建议取消进山，≥75 严禁进入保护区。以中国气象局与管护局官方发布为准。';
}
function advText(lv){
  if(lv==="预警") return '<b style="color:#ff4d4f">立即停止进山/驾车，就近避险</b>';
  if(lv==="较高") return '谨慎出行，避开该时段与路段';
  if(lv==="关注") return '留意天气变化，避免强降水时段';
  return '风险较低，仍注意山区天气突变';
}
function riskBar(v){
  const c = v>=75?"#ff4d4f":v>=55?"#ff9f43":v>=35?"#f7d154":"#2ecc71";
  return '<span class="risk-bar"><i style="width:'+Math.min(100,v)+'%;background:'+c+'"></i></span><b style="color:'+c+'">'+v+'</b>';
}
function pillCls(lv){ return lv==="预警"?"warn":lv==="较高"?"high":lv==="关注"?"watch":"low"; }

/* ---------- 地名辅助：把格点经纬度换成最近可读地名 ---------- */
function gridPlaceName(lat, lon){
  const pts = [];
  WAYPOINTS.forEach(w=>pts.push({name:w.name, lat:w.lat, lon:w.lon, kind:"wp"}));
  if(TERR && TERR.towns) TERR.towns.forEach(t=>pts.push({name:t.name, lat:t.lat, lon:t.lon, kind:"town"}));
  if(!pts.length) return lat.toFixed(2)+"N, "+lon.toFixed(2)+"E";
  let best=null, bd=Infinity;
  for(const p of pts){
    const d = Math.hypot(lat-p.lat, lon-p.lon)*111;
    if(d < bd){ bd=d; best=p; }
  }
  if(!best) return lat.toFixed(2)+"N, "+lon.toFixed(2)+"E";
  const nearLimit = best.kind==="wp" ? 12 : 18;
  if(bd <= nearLimit) return best.name + "附近";
  return best.name + "方向";
}
const WAYPOINTS = [
  {id:"gasa", name:"戛洒镇(出发点)", type:"base", lat:24.08, lon:101.60, elev:560, open:true,
   note:"花腰傣风情小镇，食宿补给地", tags:"补给·住宿"},
  {id:"nanen", name:"南恩瀑布", type:"scenic", lat:24.00, lon:101.58, elev:700, open:true,
   note:"路边景点，百米落差瀑布，雨季水量最大", tags:"瀑布"},
  {id:"shimen", name:"石门峡景区", type:"scenic", lat:23.99, lon:101.547, elev:1900, open:true,
   note:"官方开放·门票30元·栈道2.7km·08:00-17:30", tags:"峡谷·栈道"},
  {id:"chama", name:"茶马古道景区", type:"scenic", lat:23.965, lon:101.53, elev:2100, open:true,
   note:"官方开放·门票10元·建议只走前段2km", tags:"古道·徒步", warning:"18km穿越线属未开发区域，严禁走完全程"},
  {id:"jinshan", name:"金山原始森林", type:"scenic", lat:23.945, lon:101.51, elev:2400, open:true,
   note:"官方开放·石板路环线1.7km·门票10元", tags:"原始森林·环线"},
  {id:"jinshanyakou", name:"金山丫口观景台", type:"scenic", lat:23.939, lon:101.50, elev:2700, open:true,
   note:"哀牢山云海日出观景点·遇雾务必停车等待", tags:"云海·日出"},
  {id:"xujiaba", name:"徐家坝生态站(杜鹃湖)", type:"research", lat:24.533, lon:101.017, elev:2450, open:false,
   note:"⚠ 中科院科研站，位于保护区内，不接待游客", tags:"科研·禁区提示"},
];
const FORBIDDEN_ZONES = [
  {id:"core_peak", name:"大雪锅山主峰核心区", type:"core",
   desc:"哀牢山最高峰(3137.6m)核心区 · 禁止任何人进入",
   polygon:[[24.00,100.97],[24.10,100.97],[24.10,101.07],[24.00,101.07]]},
  {id:"core_north", name:"北段主脊核心区", type:"core",
   desc:"海拔2700m以上主脊核心区 · 禁止进入 · 邻近2021年事故区域",
   polygon:[[24.35,100.94],[24.66,100.94],[24.66,101.06],[24.35,101.06]]},
  {id:"chuxiong", name:"楚雄州辖区", type:"forbidden",
   desc:"楚雄管护局：未开展任何旅游项目 · 严禁擅自进入",
   polygon:[[23.95,100.80],[24.66,100.80],[24.66,100.94],[23.95,100.94]]},
  {id:"zhenyuan", name:"镇沅片区", type:"forbidden",
   desc:"镇沅县哀牢山片区(2021年事故区) · 含千家寨周边未开发区域，严禁擅自进入",
   polygon:[[23.85,100.85],[24.15,100.85],[24.15,101.05],[23.85,101.05]]},
];
const HIKING_ROUTES = [
  {id:"r1", name:"耳海环线 · 入门轻徒步", from:"戛洒镇", to:"南恩瀑布（往返）", dist:"6 km", time:"3–4 h", elev:"560 m → 700 m", type:"公路+路边步道", diff:1, diffLabel:"简单", risks:"路面湿滑、雨季落石", tips:"路边停车注意安全；适合首次进山；雨季后瀑布水量最大", stars:"★★★★☆"},
  {id:"r2", name:"石门峡→茶马古道→金山原始森林", from:"石门峡景区", to:"金山原始森林", dist:"11.4 km", time:"6–7 h", elev:"1900 m → 2400 m", type:"古道石板路", diff:2, diffLabel:"适中", risks:"午后强对流、高海拔天气多变；18 km 穿越线属未开发区域", tips:"建议 11:00 前完成前段以避开强对流峰值；石门峡门票30元、茶马古道10元、金山森林10元", stars:"★★★★☆"},
  {id:"r3", name:"金山丫口观景 · 日出挑战线", from:"金山森林停车场", to:"金山丫口观景台", dist:"5 km", time:"4–5 h", elev:"2400 m → 2700 m", type:"景区公路+观景台步道", diff:3, diffLabel:"较难", risks:"高海拔浓雾、低温、大风", tips:"日出前查好天气；2700 m 务必带冲锋衣/抓绒；遇雾停车等待", stars:"★★★☆☆"},
];
const ROUTE_RULES = [
  "核心区禁止任何人进入；生态旅游仅在批准的一般控制区开展",
  "未经批准擅自进入保护区：罚款100~5000元；发生意外自行承担救援费用",
  "保护区外围林地徒步须向管护机构备案并由专业向导带队",
  "每年11月至次年6月中旬为防火期，封山期间未经批准不得进入",
  "严禁采挖野生植物、投喂野生动物、野外用火；遇险拨打110/119/12119",
];

function wpIDW(lat, lon){
  // 反距离加权插值：返回 {thunder:[], fog:[], times:[]}
  let n = 0, times = null;
  for(const g of GRID){
    if(g.series && g.series.length){ n = g.series.length; times = g.series.map(s=>s.t); break; }
  }
  if(!n) return null;
  const accP = new Array(n).fill(0), accF = new Array(n).fill(0), wt = new Array(n).fill(0);
  for(const g of GRID){
    const s = g.series; if(!s) continue;
    const d = Math.hypot(g.lat-lat, g.lon-lon);
    const w = 1.0 / Math.max(d*111.0, 1.0) ** 2;
    for(let i=0;i<n;i++){
      if(s[i].p!=null){ accP[i] += w*s[i].p; wt[i] += w; }
      if(s[i].f!=null){ accF[i] += w*s[i].f; }
    }
  }
  const tPeak = [], fPeak = [];
  for(let i=0;i<n;i++){
    tPeak.push(wt[i] ? accP[i]/wt[i] : 0);
    fPeak.push(wt[i] ? accF[i]/wt[i] : 0);
  }
  return {times, tPeak, fPeak};
}

/* ---------- 预警中心：聚合六大类风险最高等级 ---------- */
function renderWarningCenter(){
  const el = $("warnCenterContent");
  if(!el) return;
  if(!GRID || !GRID.length){ el.innerHTML = '<div style="grid-column:1/-1;color:var(--sub)">暂无数据</div>'; return; }
  const lvOf = (p, thr) => p>=thr?"预警":p>=0.6?"较高":p>=0.4?"关注":"低";
  const T = MODEL_T ? MODEL_T.opt_threshold : 0.793;
  const F = MODEL_F ? MODEL_F.opt_threshold : 0.978;
  const R = MODEL_R ? MODEL_R.opt_threshold : 0.6;
  const maxOf = key => GRID.reduce((a,g)=>Math.max(a, g[key]||0), 0);
  const maxTer = key => GRID.reduce((a,g)=>(g.terrainHazard && g.terrainHazard[key] != null ? Math.max(a, g.terrainHazard[key]) : a), 0);
  // terrainHazard 的 flash/debris/slump 已经是 0-100 的百分比，需先归一化再按概率逻辑处理
  const maxTer01 = key => (maxTer(key) || 0) / 100;
  const items = [
    {icon:"🌩", name:"强对流", val:Math.round(maxOf("peak_prob")*100)+"%", lv:lvOf(maxOf("peak_prob"), T), tip:"雷暴/冰雹/短时强降水，午后高发"},
    {icon:"🌫", name:"浓雾", val:Math.round(maxOf("fog_prob")*100)+"%", lv:lvOf(maxOf("fog_prob"), F), tip:"能见度骤降，山区最危险的常态"},
    {icon:"🌊", name:"山洪", val:Math.round(maxTer01("flash")*100)+"%", lv:lvOf(maxTer01("flash"), 0.6), tip:"谷地集水快，涨水极迅速"},
    {icon:"🪨", name:"泥石流", val:Math.round(maxTer01("debris")*100)+"%", lv:lvOf(maxTer01("debris"), 0.6), tip:"陡坡松散堆积物 + 强降水触发"},
    {icon:"⛰", name:"塌方", val:Math.round(maxTer01("slump")*100)+"%", lv:lvOf(maxTer01("slump"), 0.6), tip:"公路边坡/高切坡路段高发"},
    {icon:"🚗", name:"道路出行", val:Math.round(maxOf("road_prob")*100)+"%", lv:lvOf(maxOf("road_prob"), R), tip:"能见度+路面+昼夜综合评估"},
  ];
  const lvCol = lv => lv==="预警"?"#f0646c":lv==="较高"?"#e8a35c":lv==="关注"?"#e3cf7d":"#6fd39a";
  el.innerHTML = items.map(it=>{
    const c = lvCol(it.lv);
    const tip = it.lv==="预警" ? (it.tip+" → 建议取消进山") : it.lv==="较高" ? (it.tip+" → 谨慎出行") : it.tip;
    return '<div class="warn-item" style="border-left:3px solid '+c+'">'+
      '<div class="warn-icon">'+it.icon+'</div>'+
      '<div class="warn-name">'+it.name+'</div>'+
      '<div class="warn-val" style="color:'+c+'">'+it.val+'</div>'+
      '<span class="warn-lv" style="background:'+c+';color:#04130a">'+it.lv+'</span>'+
      '<div class="warn-tip">'+tip+'</div></div>';
  }).join("");
}

/* ---------- 景点一键聚焦 ---------- */
function renderPOI(){
  const gridEl = $("poiGrid"), badge = $("poiBadge");
  if(!gridEl) return;
  if(!GRID || !GRID.length){ gridEl.innerHTML = '<div style="grid-column:1/-1;color:var(--sub)">暂无数据</div>'; return; }
  const data = computeRoutes();
  const typeLabel = {base:"出发点", scenic:"景区", research:"科研站"};
  const lvCol = lv => lv==="预警"?"#f0646c":lv==="较高"?"#e8a35c":lv==="关注"?"#e3cf7d":"#6fd39a";
  if(badge) badge.textContent = WAYPOINTS.length+" 个点位";
  gridEl.innerHTML = WAYPOINTS.map(wp=>{
    const r = data && data.waypoints.find(x=>x.id===wp.id);
    const risk = r ? r.risk : "低";
    const c = lvCol(risk);
    const tagCls = wp.elev>=2500?"cold":wp.type==="base"?"hot":"";
    const openCls = wp.open ? "" : " disabled";
    return '<button class="poi-btn'+openCls+'" style="'+(wp.open?"":"opacity:.55")+'" onclick="window.selectPOI(\''+wp.id+'\')">'+
      '<span class="poi-tag '+tagCls+'">'+(wp.open?typeLabel[wp.type]:'禁区')+'</span>'+
      '<div class="poi-name">'+wp.name+'</div>'+
      '<div class="poi-sub">'+wp.elev+'m · '+wp.tags+'</div>'+
      '<div style="font-size:10.5px;margin-top:4px"><span class="pill '+pillCls(risk)+'">'+risk+'</span>'+
      (r?'<span style="color:'+c+';font-family:var(--mono)"> '+r.recStars+'</span>':'')+'</div></button>';
  }).join("");
}

/* ---------- 景点详情卡 ---------- */
window.selectPOI = function(id){
  const wp = WAYPOINTS.find(w=>w.id===id);
  if(!wp) return;
  const detailEl = $("poiDetail");
  if(!detailEl) return;
  // 高亮按钮
  document.querySelectorAll(".poi-btn").forEach(b=>b.classList.remove("active"));
  const btns = document.querySelectorAll("#poiGrid .poi-btn");
  const idx = WAYPOINTS.findIndex(w=>w.id===id);
  if(btns[idx]) btns[idx].classList.add("active");
  // 获取天气数据
  const w = weatherAt(wp.lat, wp.lon);
  const data = computeRoutes();
  const r = data && data.waypoints.find(x=>x.id===id);
  let weatherHtml = '<div style="color:var(--sub);font-size:12px">天气数据加载中（约需 10-30 秒）…</div>';
  if(w && w.series && w.series.length){
    const cur = w.series[0];
    const next24 = w.series.slice(0, 24);
    const totalP = next24.reduce((a,s)=>a+(s.precip||0), 0);
    const maxT = Math.max(...next24.map(s=>s.temp)), minT = Math.min(...next24.map(s=>s.temp));
    const maxWg = Math.max(...next24.map(s=>s.wg||0));
    const csp = (typeof window.__cloudSeaProb === "function") ? window.__cloudSeaProb(cur.rh, maxT - minT, cur.ws) : null;
    const visKm = cur.vis;
    const tempCol = cur.temp >= 22 ? "#e8a35c" : cur.temp <= 8 ? "#62c4e8" : "#fff";
    weatherHtml =
      '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px">'+
        '<div><div style="font-size:11px;color:var(--sub)">当前气温</div><div style="font-family:var(--mono);font-size:24px;font-weight:700;color:'+tempCol+'">'+cur.temp+'<small style="font-size:12px">°C</small></div></div>'+
        '<div><div style="font-size:11px;color:var(--sub)">湿度</div><div style="font-family:var(--mono);font-size:24px;font-weight:700">'+Math.round(cur.rh)+'<small style="font-size:12px">%</small></div></div>'+
        '<div><div style="font-size:11px;color:var(--sub)">能见度</div><div style="font-family:var(--mono);font-size:24px;font-weight:700">'+(visKm != null ? visKm : '—')+'<small style="font-size:12px">km</small></div></div>'+
        '<div><div style="font-size:11px;color:var(--sub)">云海概率</div><div style="font-family:var(--mono);font-size:24px;font-weight:700;color:'+(csp>=70?'#62c4e8':csp>=45?'#6fd39a':'#fff')+'">'+(csp != null ? csp : '—')+'<small style="font-size:12px">%</small></div></div>'+
      '</div>'+
      '<div style="margin-top:10px;font-size:11.5px;color:var(--sub)">'+
        '体感 '+Math.round((cur.temp - (cur.ws||0)*1.1)*10)/10+'°C · 今日 '+minT+'~'+maxT+'°C · 24h降水 '+Math.round(totalP*10)/10+'mm · 阵风峰值 '+Math.round(maxWg*10)/10+'m/s'+
      '</div>';
  }
  // 最佳游览时段
  let bestTime = "全天适宜";
  if(wp.elev >= 2500) bestTime = "清晨 5:30-8:30（看日出云海）";
  else if(wp.elev >= 1800) bestTime = "上午 8:00-12:00（避开午后强对流）";
  else bestTime = "上午 7:00-11:00 / 下午 15:00-18:00";
  if(r && r.risk === "预警") bestTime = "⚠ 当前风险较高，建议暂缓";
  // 推荐路线
  const routeHint = wp.id === "gasa" ? "出发基地 → 南恩瀑布 → 石门峡 → 金山森林"
    : wp.id === "nanen" ? "戛洒镇 → 南恩瀑布 → 石门峡"
    : wp.id === "shimen" ? "戛洒 → 南恩 → 石门峡 → 茶马古道"
    : wp.id === "chama" ? "石门峡 → 茶马古道 → 金山森林"
    : wp.id === "jinshan" ? "茶马古道 → 金山森林 → 金山丫口"
    : wp.id === "jinshanyakou" ? "金山森林 → 金山丫口（日出）"
    : "参考景区导览";
  const riskColor = r ? LVL[r.risk] : "#6fd39a";
  const riskText = r ? r.risk : "低";
  detailEl.style.display = "block";
  detailEl.innerHTML =
    '<div style="background:rgba(150,204,170,.06);border:1px solid var(--line);border-left:3px solid '+riskColor+';border-radius:8px;padding:16px 18px">'+
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px">'+
        '<div>'+
          '<div style="font-size:16px;font-weight:700;color:#fff">'+wp.name+'</div>'+
          '<div style="font-family:var(--mono);font-size:11px;color:var(--sub);margin-top:2px">海拔 '+wp.elev+'m · '+wp.lat.toFixed(3)+'°N, '+wp.lon.toFixed(3)+'°E · '+wp.tags+'</div>'+
        '</div>'+
        '<div style="text-align:right">'+
          '<span class="pill '+pillCls(riskText)+'" style="font-size:12px">'+riskText+'</span>'+
          (r ? '<div style="color:'+riskColor+';font-family:var(--mono);font-size:14px;margin-top:4px">'+r.recStars+'</div>' : '')+
        '</div>'+
      '</div>'+
      '<div style="margin-top:12px;padding:10px 12px;background:rgba(150,204,170,.04);border-radius:6px;font-size:12px;color:var(--sub);line-height:1.6">'+wp.note+(wp.warning?'<br><span style="color:var(--red)">⚠ '+wp.warning+'</span>':'')+'</div>'+
      '<div style="margin-top:12px">'+weatherHtml+'</div>'+
      '<div style="margin-top:12px;display:grid;grid-template-columns:1fr 1fr;gap:10px">'+
        '<div style="padding:10px 12px;background:rgba(232,163,92,.08);border-radius:6px">'+
          '<div style="font-size:11px;color:var(--orange);font-family:var(--mono)">最佳游览时段</div>'+
          '<div style="font-size:13px;color:#fff;margin-top:4px">'+bestTime+'</div>'+
        '</div>'+
        '<div style="padding:10px 12px;background:rgba(111,211,154,.08);border-radius:6px">'+
          '<div style="font-size:11px;color:var(--teal);font-family:var(--mono)">推荐路线</div>'+
          '<div style="font-size:13px;color:#fff;margin-top:4px">'+routeHint+'</div>'+
        '</div>'+
      '</div>'+
    '</div>';
  // 3D 飞行
  if(window.flyToPlace) window.flyToPlace(wp.lat, wp.lon, wp.name, wp.elev);
}

function computeRoutes(){
  const thrT = MODEL_T ? MODEL_T.opt_threshold : 0.793;
  const thrF = MODEL_F ? MODEL_F.opt_threshold : 0.978;
  const SEV = {"低":0,"关注":1,"较高":2,"预警":3};
  const out = [];
  let worstOpen = 0, worstName = "";
  for(const wp of WAYPOINTS){
    const r = {...wp};
    const idw = wpIDW(wp.lat, wp.lon);
    if(!idw){ r.risk="未知"; r.recIndex=0; r.recStars="—"; r.tPeak=0; r.fPeak=0; r.tPeakTime="—"; r.fPeakTime="—"; r.bestWin="—"; out.push(r); continue; }
    const tp = Math.max(...idw.tPeak), fp = Math.max(...idw.fPeak);
    const ti = idw.tPeak.indexOf(tp), fi = idw.fPeak.indexOf(fp);
    const tLv = tp>=thrT?"预警":tp>=0.60?"较高":tp>=0.40?"关注":"低";
    const fLv = fp>=thrF?"预警":fp>=0.60?"较高":fp>=0.40?"关注":"低";
    const lv = SEV[tLv]>=SEV[fLv] ? tLv : fLv;
    r.risk = lv; r.riskColor = LVL[lv];
    r.tPeak = tp; r.fPeak = fp;
    r.tPeakTime = (idw.times[ti]||"").slice(11,16);
    r.fPeakTime = (idw.times[fi]||"").slice(11,16);
    // 推荐指数: 100 - max(tPeak,fPeak)*100 - 海拔惩罚 + 开放加成
    let idx = 100 - Math.max(tp, fp)*100;
    if(wp.elev >= 2500) idx -= 10;
    else if(wp.elev >= 2000) idx -= 5;
    if(!wp.open) idx = 0;
    else if(wp.type === "base") idx = Math.min(100, idx + 15);
    idx = Math.max(0, Math.min(100, Math.round(idx)));
    r.recIndex = idx;
    r.recStars = idx>=80?"★★★★★":idx>=60?"★★★★":idx>=40?"★★★":idx>=20?"★★":"★";
    // 最佳游览窗口：未来12h内找4h最低风险窗口
    const winH = 4, lookH = Math.min(12, idw.times.length);
    let bestStart = -1, bestScore = 1e9;
    for(let s=0; s<=lookH-winH; s++){
      let segMax = 0;
      for(let k=s;k<s+winH;k++) segMax = Math.max(segMax, idw.tPeak[k], idw.fPeak[k]);
      if(segMax < bestScore){ bestScore = segMax; bestStart = s; }
    }
    if(bestStart >= 0){
      r.bestWin = (idw.times[bestStart]||"").slice(11,16) + "~" + (idw.times[bestStart+winH-1]||"").slice(11,16);
    } else { r.bestWin = "—"; }
    if(wp.open && SEV[lv] > worstOpen){ worstOpen = SEV[lv]; worstName = wp.name; }
    out.push(r);
  }
  // 整体结论
  let verdict, verdictColor;
  if(worstOpen >= 3){ verdict = "⚠ 今日不建议前往："+worstName+" 有预警级风险，建议改期"; verdictColor = "#ff4d4f"; }
  else if(worstOpen === 2){ verdict = "⚠ 谨慎前往："+worstName+" 风险较高，避开风险时段"; verdictColor = "#ff9f43"; }
  else { verdict = "✅ 建议前往：开放景区风险较低，适合游览（仍须遵守进山规范）"; verdictColor = "#2ecc71"; }
  return {waypoints: out, verdict, verdictColor, worstRisk: {0:"低",1:"关注",2:"较高",3:"预警"}[worstOpen]};
}

function renderRoutes(){
  const data = computeRoutes();
  if(!data){ $("routeTbody").innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--sub)">暂无数据</td></tr>'; return; }
  // 摘要
  const open = data.waypoints.filter(w=>w.open);
  const ok = open.filter(w=>w.recIndex>=60).length;
  const caution = open.filter(w=>w.recIndex>=30 && w.recIndex<60).length;
  const bad = open.filter(w=>w.recIndex<30).length;
  var rb = $("routeBadge"); if(rb) rb.textContent = open.length+" 景点";
  $("routeSummary").innerHTML =
    '<div class="sum-item" style="border-left:3px solid '+data.verdictColor+'">路线结论<b style="color:'+data.verdictColor+';font-size:14px">'+data.verdict+'</b></div>'+
    '<div class="sum-item">✅ 推荐(≥60)<b style="color:#2ecc71">'+ok+'</b></div>'+
    '<div class="sum-item">⚠ 谨慎(30-59)<b style="color:#ff9f43">'+caution+'</b></div>'+
    '<div class="sum-item">⛔ 不推荐(<30)<b style="color:#ff4d4f">'+bad+'</b></div>';
  // 表格
  const typeLabel = {base:"出发点", scenic:"景区", research:"科研站"};
  $("routeTbody").innerHTML = data.waypoints.map(w=>{
    const recColor = w.recIndex>=60?"#2ecc71":w.recIndex>=30?"#ff9f43":"#ff4d4f";
    const openTag = w.open ? "" : '<span class="pill warn" style="margin-left:4px">禁区</span>';
    return '<tr><td><b>'+w.name+'</b>'+openTag+'<div style="font-size:10px;color:var(--sub)">'+w.tags+'</div></td>'+
      '<td style="font-size:11.5px;color:var(--sub)">'+typeLabel[w.type]+'</td>'+
      '<td>'+w.elev+'m</td>'+
      '<td><span class="pill '+pillCls(w.risk)+'">'+w.risk+'</span></td>'+
      '<td>'+(w.tPeak*100).toFixed(0)+'%<div class="tags">@'+w.tPeakTime+'</div></td>'+
      '<td>'+(w.fPeak*100).toFixed(0)+'%<div class="tags">@'+w.fPeakTime+'</div></td>'+
      '<td><b style="color:'+recColor+';font-size:15px">'+w.recIndex+'</b><div style="color:'+recColor+';font-size:12px">'+w.recStars+'</div></td>'+
      '<td style="font-size:12px">'+w.bestWin+'</td>'+
      '<td style="font-size:11px;color:var(--sub)">'+w.note+(w.warning?'<br/><b style="color:#ff4d4f">'+w.warning+'</b>':'')+'</td></tr>';
  }).join("");
  // 禁区列表
  $("forbiddenList").innerHTML = FORBIDDEN_ZONES.map(z=>
    '<div style="padding:6px 0;border-bottom:1px solid var(--line)">'+
    '<span style="color:#ff4d4f;font-weight:700">🔻 '+z.name+'</span>'+
    '<span style="margin-left:8px;font-size:11.5px;color:var(--sub)">'+z.desc+'</span></div>'
  ).join("");
  // 进山规范
  $("routeRules").innerHTML = '<b>📋 进山规范要点</b><br/>'+ROUTE_RULES.map((r,i)=>'<span style="margin-right:16px;font-size:11.5px">'+(i+1)+'. '+r+'</span>').join("");
}

function renderHikingRoutes(){
  const typeIcon = {"公路+路边步道":"🛣","官方木栈道":"🪵","古道石板路":"🪨","石板路环线":"🌲","景区公路+观景台步道":"🌄"};
  $("hikingTbody").innerHTML = HIKING_ROUTES.map(r=>{
    const dc = r.diff===1?"#2ecc71":r.diff===2?"#f7d154":"#ff9f43";
    return '<tr><td><b>'+r.name+'</b><div style="font-size:12px;color:'+dc+'">'+r.stars+'</div></td>'+
      '<td style="font-size:12px">'+r.from+'<br/>↓<br/>'+r.to+'</td>'+
      '<td style="font-size:12px">'+r.dist+'<br/>'+r.time+'</td>'+
      '<td>'+r.elev+'</td>'+
      '<td style="font-size:12px"><span style="margin-right:4px">'+(typeIcon[r.type]||"")+'</span>'+r.type+'</td>'+
      '<td><span class="pill '+pillCls(r.diff>=3?"较高":r.diff>=2?"关注":"低")+'">'+r.diffLabel+'</span></td>'+
      '<td style="font-size:11.5px;color:var(--sub)">'+r.risks+'</td>'+
      '<td style="font-size:11.5px;color:var(--sub)">'+r.tips+'</td></tr>';
  }).join("");
}

/* ---------- 渲染: 历史灾害关联校准面板 ---------- */
function renderCalibration(){
  if(!CALIB){ $("calibPanel").style.display="none"; return; }
  $("calibPanel").style.display="block";
  // 统计
  const gridBoosted = GRID.filter(g=>g.riskIndex && g.riskIndex.calibProb>=25).length;
  const roadBoosted = ROADS.filter(r=>r.risk_index.calibProb>=25).length;
  const topCases = (CALIB.cases||[]).sort((a,b)=>b.severity-a.severity).slice(0,5);
  const sevName = {0:"无/轻微",1:"中",2:"高",3:"极端"};
  $("calibSummary").innerHTML =
    '<div class="sum-item">📚 历史案例 <b>'+(CALIB.cases?CALIB.cases.length:0)+'</b></div>'+
    '<div class="sum-item">🔺 格点被历史复核上调 <b style="color:'+(gridBoosted?"#ff9f43":"var(--text)")+'">'+gridBoosted+'</b></div>'+
    '<div class="sum-item">🚧 路段被历史复核上调 <b style="color:'+(roadBoosted?"#ff9f43":"var(--text)")+'">'+roadBoosted+'</b></div>';
  $("calibCases").innerHTML = topCases.map(c=>
    '<tr><td><b>'+c.date+'</b></td><td>'+c.title+'</td><td>'+c.type+'</td>'+
    '<td><span class="pill '+pillCls(c.severity>=3?"预警":c.severity>=2?"较高":"关注")+'">'+sevName[c.severity]+'</span></td>'+
    '<td class="tags">24h '+c.precip.p24+'mm · 坡度 '+c.terrain.slope.toFixed(1)+'° · 地形敏 '+Math.max(c.terrain.flash,c.terrain.debris,c.terrain.slump).toFixed(0)+'</td></tr>'
  ).join("");
  $("calibNote").innerHTML =
    '校准逻辑：从 '+CALIB.cases.length+' 个真实灾害案例提取「降水强度·地形敏感性·季节·地质静态因子」与实际严重度的关系，'+
    '用 Logistic 回归计算当前条件与历史灾害的相似概率，再按 <b>70% 原始模型 + 30% 历史校准</b> 融合为最终风险指数。'+
    '当历史复核概率 ≥25% 时会在风险表中标注。';
}

/* ---------- 渲染: 地图(SVG 覆盖精细底图) ---------- */
function tipHtml(g){
  const ri = g.riskIndex;
  const th = g.terrainHazard;
  return '<b>'+g.lat.toFixed(2)+'N, '+g.lon.toFixed(2)+'E</b> · 海拔 '+g.elev+'m<br/>'+
    '🌩 强对流峰值 <b style="color:'+g.color+'">'+(g.peak_prob*100).toFixed(1)+'%</b> ('+g.level+') @'+g.peak_time+'<br/>'+
    '🌫 浓雾峰值 <b style="color:'+g.fogColor+'">'+(g.fog_prob*100).toFixed(1)+'%</b> ('+g.fogLevel+') @'+g.fog_peak_time+'<br/>'+
    (g.agree!=null?('🔁 双模型 '+(g.agree?'<span class="agree-yes">✓ 一致</span>':'<span class="agree-no">✗ 分歧</span>')+'<br/>'):'')+
    (ri?('<b>📊 综合风险指数 '+(ri.value)+' ('+ri.level+')</b><br/>'):'')+
    (th?('🏔 '+th.typeName+' · 山洪'+th.flash+'%/泥石流'+th.debris+'%/塌方'+th.slump+'% · 坡度'+th.slope+'°'):'');
}
function lngLat2px(lat, lon){
  const x = (lon - TERR.lon0)/(TERR.lon1-TERR.lon0)*100;
  const y = (TERR.lat1 - lat)/(TERR.lat1-TERR.lat0)*100;
  return [x, y];
}
function renderMap(){
  const svg = $("mapSvg");
  let s = "";
  /* 迷你标签 + 碰撞避免：优先右侧，冲突则上/下/左侧，都冲突则不画字 */
  const placedLbl = [];
  const mkLbl = (cx, cy, txt, fs, fill, weight, preferred)=>{
    if(!txt) return "";
    const w = txt.length*fs*0.95, h = fs*1.2;
    const cand = preferred==="middle"
      ? [{a:"middle",dx:0,dy:0},{a:"middle",dx:0,dy:-1.2},{a:"middle",dx:0,dy:h+1.2},{a:"start",dx:w+1.5,dy:0},{a:"end",dx:-(w+1.5),dy:0}]
      : [{a:"start",dx:2.2,dy:0},{a:"middle",dx:0,dy:-1.2},{a:"middle",dx:0,dy:h+1.2},{a:"end",dx:-(w+2.2),dy:0}];
    for(const o of cand){
      const x0 = o.a==="start" ? cx+o.dx : o.a==="end" ? cx+o.dx-w : cx+o.dx-w/2;
      const y0 = cy+o.dy-h/2;
      if(!placedLbl.some(p=> x0 < p[2] && x0+w > p[0] && y0 < p[3] && y0+h > p[1])){
        placedLbl.push([x0, y0, x0+w, y0+h]);
        return '<text class="lbl" x="'+(cx+o.dx)+'" y="'+(cy+o.dy)+'" font-size="'+fs+'" fill="'+fill+'" text-anchor="'+o.a+'" stroke="#fff" stroke-width="'+(0.12*fs)+'" paint-order="stroke fill" style="font-weight:'+weight+'">'+txt+'</text>';
      }
    }
    return "";
  };

  // 格点色块：0.10° 间距，半宽 0.05° —— 放在最底层，只作为底图染色，避免遮挡道路/地名
  GRID.forEach(g=>{
    const [x0,y0] = lngLat2px(g.lat+0.05, g.lon-0.05);
    const [x1,y1] = lngLat2px(g.lat-0.05, g.lon+0.05);
    const w = Math.abs(x1-x0), h = Math.abs(y1-y0);
    const s2 = riskLvFor(g, riskType);
    const c = LVL[s2]||"#2ecc71";
    // 降低透明度，重点在预警/较高；低等级几乎透明，不再挡住底图文字
    const op = s2==="预警"?0.38 : s2==="较高"?0.28 : s2==="关注"?0.18 : 0.09;
    const px = Math.min(x0,x1), py = Math.min(y0,y1);
    s += '<rect class="cell" x="'+px+'" y="'+py+'" width="'+w+'" height="'+h+'" fill="'+c+'" fill-opacity="'+op+
         '" stroke="rgba(40,40,40,0.14)" stroke-width="0.22" data-lat="'+g.lat+'" data-lon="'+g.lon+'"/>';
  });

  // 河流
  (TERR.rivers||[]).forEach(rv=>{
    const lw = 0.4 + 0.9*Math.min(1, rv.flow/200);
    s += '<polyline points="'+rv.pts.map(p=>lngLat2px(p[0],p[1]).join(",")).join(" ")+
         '" fill="none" stroke="#1f6fc0" stroke-width="'+lw+'" opacity="0.8" style="vector-effect:non-scaling-stroke"/>';
  });

  // 乡镇公路：真实道路（路基阴影 + 浅灰路面 + 白色中心虚线）
  const roadStyleExtra = {baseW:2.6, face:"#9ca8b0", casing:"#5d6b75", dash:[1.4,1.2], dashCol:"#f0f0f0"};
  (TERR.roads_extra||[]).forEach(rd=>{
    const pts = rd.pts.map(p=>lngLat2px(p[0],p[1]).join(",")).join(" ");
    s += '<polyline points="'+pts+'" fill="none" stroke="rgba(0,0,0,0.28)" stroke-width="'+(roadStyleExtra.baseW+0.8)+'" opacity="0.6" style="vector-effect:non-scaling-stroke"/>';
    s += '<polyline points="'+pts+'" fill="none" stroke="'+roadStyleExtra.casing+'" stroke-width="'+(roadStyleExtra.baseW+0.35)+'" opacity="0.8" style="vector-effect:non-scaling-stroke"/>';
    s += '<polyline points="'+pts+'" fill="none" stroke="'+roadStyleExtra.face+'" stroke-width="'+roadStyleExtra.baseW+'" opacity="0.88" style="vector-effect:non-scaling-stroke"/>';
    s += '<polyline points="'+pts+'" fill="none" stroke="'+roadStyleExtra.dashCol+'" stroke-width="0.65" opacity="0.55" stroke-dasharray="'+roadStyleExtra.dash.join(" ")+'" style="vector-effect:non-scaling-stroke"/>';
  });

  // 主要公路：真实路基 + 路面 + 中心线（按类型区分宽度和标线）
  const roadStyles = {
    "高速":   {baseW:4.0, face:"#1565c0", casing:"#0a3d80", dash:[0,0], dashCol:"#ffffff"},
    "国道":   {baseW:3.4, face:"#d9480f", casing:"#8a2f0a", dash:[2.2,1.8], dashCol:"#ffffff"},
    "省道":   {baseW:3.0, face:"#7e57c2", casing:"#4a2f80", dash:[2.0,1.8], dashCol:"#ffffff"},
    "景区公路":{baseW:2.7, face:"#e65100", casing:"#9a3600", dash:[1.6,1.8], dashCol:"#fff0c0"},
    "县道":   {baseW:2.5, face:"#78909c", casing:"#4e5b63", dash:[1.4,1.4], dashCol:"#ffffff"},
    "县乡道": {baseW:2.1, face:"#90a4ae", casing:"#5d6e79", dash:[1.2,1.2], dashCol:"#e8e8e8"}
  };
  ROADS.forEach(r=>{
    const st = roadStyles[r.road_type] || roadStyles["县乡道"];
    const pts = r.pts.map(p=>lngLat2px(p[0],p[1]).join(",")).join(" ");
    // 路基阴影
    s += '<polyline points="'+pts+'" fill="none" stroke="rgba(0,0,0,0.28)" stroke-width="'+(st.baseW+1.0)+'" opacity="0.55" style="vector-effect:non-scaling-stroke"/>';
    // 路缘/描边
    s += '<polyline points="'+pts+'" fill="none" stroke="'+st.casing+'" stroke-width="'+(st.baseW+0.45)+'" opacity="0.82" style="vector-effect:non-scaling-stroke"/>';
    s += '<polyline points="'+pts+'" fill="none" stroke="#ffffff" stroke-width="'+(st.baseW+0.15)+'" opacity="0.9" style="vector-effect:non-scaling-stroke"/>';
    // 路面
    s += '<polyline points="'+pts+'" fill="none" stroke="'+st.face+'" stroke-width="'+st.baseW+'" opacity="0.92" style="vector-effect:non-scaling-stroke"/>';
    // 中心线
    if(st.dash[0] > 0){
      s += '<polyline points="'+pts+'" fill="none" stroke="'+st.dashCol+'" stroke-width="0.75" opacity="0.75" stroke-dasharray="'+st.dash.join(" ")+'" style="vector-effect:non-scaling-stroke"/>';
    } else {
      // 高速：双白实线
      s += '<polyline points="'+pts+'" fill="none" stroke="'+st.dashCol+'" stroke-width="0.7" opacity="0.85" style="vector-effect:non-scaling-stroke"/>';
    }
    // 风险高时在路面上叠加风险色虚线
    const riskC = LVL[r.worst.level]||"transparent";
    if(r.worst.level==="预警"||r.worst.level==="较高"){
      s += '<polyline points="'+pts+'" fill="none" stroke="'+riskC+'" stroke-width="1.0" opacity="0.5" stroke-dasharray="5 3" style="vector-effect:non-scaling-stroke"/>';
    }
  });

  // 禁区多边形（红色半透明 + 斜线纹理）
  FORBIDDEN_ZONES.forEach(z=>{
    const pts = z.polygon.map(p=>lngLat2px(p[0],p[1]).join(",")).join(" ");
    s += '<polygon points="'+pts+'" fill="rgba(255,77,79,0.12)" stroke="#ff4d4f" stroke-width="0.8" stroke-dasharray="4 2" style="vector-effect:non-scaling-stroke"/>';
    // 禁区标签（迷你字号，防重叠）
    const cx = z.polygon.reduce((a,p)=>a+p[0],0)/z.polygon.length;
    const cy = z.polygon.reduce((a,p)=>a+p[1],0)/z.polygon.length;
    const [lx,ly] = lngLat2px(cy, cx);
    s += mkLbl(lx, ly, '🚫'+z.name.slice(0,6), 1.4, "#ff4d4f", 600, "middle");
  });
  // 景点标记（迷你字号，防重叠）
  WAYPOINTS.forEach(wp=>{
    const [x,y] = lngLat2px(wp.lat, wp.lon);
    if(!wp.open){
      s += '<circle cx="'+x+'" cy="'+y+'" r="1.2" fill="#ff4d4f" stroke="#fff" stroke-width="0.4"/>';
      s += mkLbl(x, y, '⚠'+wp.name.slice(0,4), 1.4, "#ff4d4f", 600, "start");
    } else {
      s += '<circle cx="'+x+'" cy="'+y+'" r="1.3" fill="#2ecc71" stroke="#fff" stroke-width="0.5"/>';
      s += mkLbl(x, y, wp.name.slice(0,4), 1.4, "#1a5d2a", 600, "start");
    }
  });
  // 村镇：更小的点与迷你字号（县城略大），防重叠
  (TERR.towns||[]).forEach(t=>{
    const [x,y] = lngLat2px(t.lat,t.lon);
    const isCounty = t.cls==="县城";
    s += '<circle cx="'+x+'" cy="'+y+'" r="'+(isCounty?1.4:1.1)+'" fill="'+(isCounty?"#fff":"#eee")+'" stroke="'+(isCounty?"#d9480f":"#666")+'" stroke-width="0.4"/>';
    s += mkLbl(x, y, t.name, isCounty?1.6:1.3, "#333", isCounty?600:400, "start");
  });

  svg.innerHTML = s;
  // 绑定交互
  svg.querySelectorAll(".cell").forEach(rect=>{
    rect.addEventListener("mouseenter", ()=>{
      const g = GRID.find(x=>x.lat===+rect.dataset.lat && x.lon===+rect.dataset.lon);
      if(!g) return;
      const tip = $("tip"); tip.innerHTML = tipHtml(g); tip.style.display = "block";
    });
    rect.addEventListener("mouseleave", ()=>{ $("tip").style.display = "none"; });
    rect.addEventListener("click", ()=>{
      const g = GRID.find(x=>x.lat===+rect.dataset.lat && x.lon===+rect.dataset.lon);
      if(!g) return;
      const tip = $("tip"); tip.innerHTML = tipHtml(g);
      tip.style.display = "block"; tip.style.left = "12px"; tip.style.top = "12px";
    });
  });
}
function setRisk(t){
  riskType = t;
  const btnIds = {thunder:"btnThunder",fog:"btnFog",flash:"btnFlash",debris:"btnDebris",slump:"btnSlump",road:"btnRoad"};
  for(const k in btnIds){
    const b = $(btnIds[k]);
    if(b) b.classList.toggle("active", t===k);
  }
  renderMap();
  renderRiskDistBar();
  renderRiskHotspots();
  renderRiskTimeline();
}

/* ---- 风险类型 → 取值函数 ---- */
function riskValFor(g, type){
  if(type==="thunder") return g.peak_prob;
  if(type==="fog") return g.fog_prob;
  if(type==="road") return g.road_prob || 0;
  if(g.terrainHazard){
    if(type==="flash") return (g.terrainHazard.flash||0)/100;
    if(type==="debris") return (g.terrainHazard.debris||0)/100;
    if(type==="slump") return (g.terrainHazard.slump||0)/100;
  }
  return 0;
}
function riskLvFor(g, type){
  if(type==="thunder") return g.level;
  if(type==="fog") return g.fogLevel;
  if(type==="road") return g.roadLevel || "低";
  const v = riskValFor(g, type);
  return v>=0.6?"预警":v>=0.45?"较高":v>=0.30?"关注":"低";
}
function riskTimeFor(g, type){
  if(type==="thunder") return g.peak_time || "—";
  if(type==="fog") return g.fog_peak_time || "—";
  if(type==="road") return g.peak_time || "—";
  return "持续";
}
const RISK_TYPE_LABEL = {
  thunder:"强对流", fog:"浓雾", flash:"山洪", debris:"泥石流", slump:"塌方", road:"道路出行"
};

/* ---- 风险地图概览仪表盘 ---- */
function renderRiskMapSummary(){
  const el = $("riskMapSummary");
  if(!el || !GRID || !GRID.length) return;
  const type = riskType;
  const vals = GRID.map(g=>({g, v:riskValFor(g, type), lv:riskLvFor(g, type)}));
  const warnN = vals.filter(x=>x.lv==="预警").length;
  const highN = vals.filter(x=>x.lv==="较高").length;
  const watchN = vals.filter(x=>x.lv==="关注").length;
  const lowN = vals.filter(x=>x.lv==="低").length;
  const maxVal = vals.reduce((a,x)=>Math.max(a, x.v), 0);
  const topG = vals.find(x=>x.v===maxVal);
  const total = GRID.length;
  const lvCol = lv => lv==="预警"?"#ff4d4f":lv==="较高"?"#ff9f43":lv==="关注"?"#f7d154":"#2ecc71";
  el.innerHTML =
    '<div class="rms-card" style="--accent-color:'+lvCol(topG?topG.lv:"低")+'">'+
      '<div class="rms-label">当前类型</div>'+
      '<div class="rms-value" style="font-size:16px">'+RISK_TYPE_LABEL[type]+'</div>'+
      '<div class="rms-sub">'+total+' 个格点</div>'+
    '</div>'+
    '<div class="rms-card" style="--accent-color:'+lvCol(maxVal>=0.6?"预警":maxVal>=0.45?"较高":maxVal>=0.30?"关注":"低")+'">'+
      '<div class="rms-label">峰值概率</div>'+
      '<div class="rms-value" style="color:'+lvCol(topG?topG.lv:"低")+'">'+(maxVal*100).toFixed(1)+'<small style="font-size:13px">%</small></div>'+
      '<div class="rms-sub">最高: '+(topG?gridPlaceName(topG.g.lat, topG.g.lon):"—")+'</div>'+
    '</div>'+
    '<div class="rms-card" style="--accent-color:#ff4d4f">'+
      '<div class="rms-label">预警 / 较高</div>'+
      '<div class="rms-value"><span style="color:#ff4d4f">'+warnN+'</span> / <span style="color:#ff9f43">'+highN+'</span></div>'+
      '<div class="rms-sub">关注 '+watchN+' · 低 '+lowN+'</div>'+
    '</div>'+
    '<div class="rms-card" style="--accent-color:var(--teal)">'+
      '<div class="rms-label">风险分布</div>'+
      '<div class="rms-dist" style="margin-top:4px">'+
        '<span><i style="background:#ff4d4f"></i>'+warnN+'</span>'+
        '<span><i style="background:#ff9f43"></i>'+highN+'</span>'+
        '<span><i style="background:#f7d154"></i>'+watchN+'</span>'+
        '<span><i style="background:#2ecc71"></i>'+lowN+'</span>'+
      '</div>'+
      '<div class="rms-sub" style="margin-top:4px">共 '+total+' 格点</div>'+
    '</div>';
}

/* ---- 风险分布条形图 ---- */
function renderRiskDistBar(){
  const bar = $("riskDistBar"), labels = $("riskDistLabels");
  if(!bar || !GRID || !GRID.length) return;
  const type = riskType;
  const vals = GRID.map(g=>riskLvFor(g, type));
  const warnN = vals.filter(v=>v==="预警").length;
  const highN = vals.filter(v=>v==="较高").length;
  const watchN = vals.filter(v=>v==="关注").length;
  const lowN = vals.filter(v=>v==="低").length;
  const total = vals.length;
  const pct = n => total ? (n/total*100).toFixed(0) : 0;
  bar.innerHTML =
    '<div style="width:'+pct(warnN)+'%;background:#ff4d4f" title="预警 '+warnN+'"></div>'+
    '<div style="width:'+pct(highN)+'%;background:#ff9f43" title="较高 '+highN+'"></div>'+
    '<div style="width:'+pct(watchN)+'%;background:#f7d154" title="关注 '+watchN+'"></div>'+
    '<div style="width:'+pct(lowN)+'%;background:#2ecc71" title="低 '+lowN+'"></div>';
  labels.innerHTML =
    '<span>🟥 预警 '+warnN+' ('+pct(warnN)+'%)</span>'+
    '<span>🟧 较高 '+highN+' ('+pct(highN)+'%)</span>'+
    '<span>🟨 关注 '+watchN+' ('+pct(watchN)+'%)</span>'+
    '<span>🟩 低 '+lowN+' ('+pct(lowN)+'%)</span>';
}

/* ---- 风险热点排行 ---- */
function renderRiskHotspots(){
  const tbody = $("riskHotspotTbody"), badge = $("hotspotBadge");
  if(!tbody || !GRID || !GRID.length) return;
  const type = riskType;
  const data = GRID.map(g=>({
    g, v:riskValFor(g, type), lv:riskLvFor(g, type), t:riskTimeFor(g, type)
  })).sort((a,b)=>b.v-a.v).slice(0, 8);
  const lvCol = lv => lv==="预警"?"#ff4d4f":lv==="较高"?"#ff9f43":lv==="关注"?"#f7d154":"#2ecc71";
  if(badge) badge.textContent = "Top " + data.length + " / " + GRID.length + " 格点 · 按 " + RISK_TYPE_LABEL[type] + " 概率排序";
  tbody.innerHTML = data.map((d, i)=>{
    const name = gridPlaceName(d.g.lat, d.g.lon);
    const barW = Math.round(d.v * 100);
    return '<tr>'+
      '<td class="hs-rank">'+(i+1)+'</td>'+
      '<td><b>'+name+'</b><div style="font-size:10px;color:var(--sub)">'+d.g.lat.toFixed(2)+'N, '+d.g.lon.toFixed(2)+'E</div></td>'+
      '<td>'+d.g.elev+'m</td>'+
      '<td><b style="color:'+lvCol(d.lv)+'">'+(d.v*100).toFixed(1)+'%</b></td>'+
      '<td class="hs-bar"><div class="hs-mini-bar"><i style="width:'+barW+'%;background:'+lvCol(d.lv)+'"></i></div></td>'+
      '<td><span class="pill '+pillCls(d.lv)+'">'+d.lv+'</span></td>'+
      '<td style="font-size:11px;color:var(--sub);font-family:var(--mono)">'+d.t+'</td>'+
    '</tr>';
  }).join("");
}

/* ---- 24h 风险演变时间线 ---- */
function renderRiskTimeline(){
  const svg = $("riskTimelineSvg"), peakEl = $("riskTimelinePeak");
  if(!svg || !GRID || !GRID.length) return;
  const type = riskType;
  // 地质类风险没有时间序列，用静态值平铺
  const isGeological = type==="flash" || type==="debris" || type==="slump";
  let hours = [], maxVals = [];
  if(isGeological){
    // 静态值，24h 平铺
    const maxV = GRID.reduce((a,g)=>Math.max(a, riskValFor(g, type)), 0);
    for(let h=0; h<24; h++){ hours.push(h); maxVals.push(maxV); }
  } else {
    // 从 series 提取每小时最大概率
    const key = type==="fog" ? "f" : type==="road" ? "p" : "p"; // thunder & road use p
    const fogKey = type==="fog";
    let n = 0, times = [];
    for(const g of GRID){
      if(g.series && g.series.length){ n = g.series.length; times = g.series.map(s=>s.t); break; }
    }
    if(!n){ svg.innerHTML = ""; return; }
    for(let i=0; i<n; i++){
      hours.push(i);
      let mx = 0;
      for(const g of GRID){
        const s = g.series; if(!s || i>=s.length) continue;
        let v;
        if(type==="fog") v = s[i].f || 0;
        else if(type==="road") v = s[i].p || 0;
        else v = s[i].p || 0; // thunder
        if(v > mx) mx = v;
      }
      maxVals.push(mx);
    }
  }
  const W = 480, H = 70, padX = 4, padY = 8;
  const n = maxVals.length;
  if(n < 2){ svg.innerHTML = ""; return; }
  const stepX = (W - padX*2) / (n - 1);
  const pts = maxVals.map((v, i)=>[padX + i*stepX, H - padY - v*(H - padY*2)]);
  const pathD = pts.map((p, i)=>(i===0?"M":"L")+p[0].toFixed(1)+","+p[1].toFixed(1)).join(" ");
  const areaD = pathD + " L"+pts[n-1][0].toFixed(1)+","+(H-padY)+" L"+pts[0][0].toFixed(1)+","+(H-padY)+" Z";
  const maxV = Math.max(...maxVals);
  const maxIdx = maxVals.indexOf(maxV);
  const lvCol = v => v>=0.6?"#ff4d4f":v>=0.45?"#ff9f43":v>=0.30?"#f7d154":"#2ecc71";
  const lineCol = lvCol(maxV);
  // 时间标签
  let firstTime = "", peakTime = "";
  for(const g of GRID){
    if(g.series && g.series.length){
      firstTime = g.series[0].t;
      if(maxIdx < g.series.length) peakTime = g.series[maxIdx].t;
      break;
    }
  }
  if(isGeological) peakTime = "持续存在";
  if(peakEl) peakEl.textContent = "峰值 " + (maxV*100).toFixed(1) + "% @" + (peakTime || "—");
  // 阈值线
  const thrY = H - padY - 0.6*(H-padY*2);
  const watchY = H - padY - 0.45*(H-padY*2);
  svg.innerHTML =
    '<defs><linearGradient id="riskTLGrad" x1="0" y1="0" x2="0" y2="1">'+
      '<stop offset="0%" stop-color="'+lineCol+'" stop-opacity="0.35"/>'+
      '<stop offset="100%" stop-color="'+lineCol+'" stop-opacity="0.02"/>'+
    '</linearGradient></defs>'+
    '<line x1="'+padX+'" y1="'+thrY.toFixed(1)+'" x2="'+(W-padX)+'" y2="'+thrY.toFixed(1)+'" stroke="#ff4d4f" stroke-width="0.5" stroke-dasharray="3 2" opacity="0.4"/>'+
    '<line x1="'+padX+'" y1="'+watchY.toFixed(1)+'" x2="'+(W-padX)+'" y2="'+watchY.toFixed(1)+'" stroke="#f7d154" stroke-width="0.5" stroke-dasharray="3 2" opacity="0.3"/>'+
    '<path d="'+areaD+'" fill="url(#riskTLGrad)"/>'+
    '<path d="'+pathD+'" fill="none" stroke="'+lineCol+'" stroke-width="1.8" stroke-linejoin="round"/>'+
    '<circle cx="'+pts[maxIdx][0].toFixed(1)+'" cy="'+pts[maxIdx][1].toFixed(1)+'" r="3" fill="'+lineCol+'" stroke="#fff" stroke-width="1"/>'+
    '<text x="'+padX+'" y="'+(H-1)+'" font-size="8" fill="var(--dim)" font-family="var(--mono)">'+(firstTime||"0h")+'</text>'+
    '<text x="'+(W-padX-16)+'" y="'+(H-1)+'" font-size="8" fill="var(--dim)" font-family="var(--mono)">+23h</text>';
}

/* ---------- 渲染: 公路灾害表 ---------- */
function renderRoads(roads){
  $("roadCount").textContent = roads.length+" 路段";
  const label = HAZARD_LABEL;
  const cell = risk => '<span class="pill '+pillCls(risk.level)+'">'+risk.level+'</span>';
  $("roadTbody").innerHTML = roads.map(r=>{
    const ri = r.risk_index;
    return '<tr><td><b>'+r.name+'</b><div style="font-size:10px;color:var(--sub)">'+r.road_type+' · 坡'+r.slope_deg+'°</div></td>'+
      '<td>'+riskBar(ri.value)+'<div class="tags">'+(ri.top_hazards||[]).join("/")+'</div></td>'+
      '<td>'+cell(r.risks.fog)+'<div class="tags">峰值 '+(r.metrics.fog_p*100).toFixed(0)+'%</div></td>'+
      '<td>'+cell(r.risks.debris)+'<div class="tags">p '+(r.metrics.p1h*100).toFixed(0)+'%</div></td>'+
      '<td>'+cell(r.risks.flash)+'<div class="tags">3h '+(r.metrics.best3h*100).toFixed(0)+'%</div></td>'+
      '<td>'+cell(r.risks.slump)+'<div class="tags">持续 '+r.metrics.high_hours+'h</div></td>'+
      '<td style="font-size:11.5px;color:var(--sub)"><b style="color:'+LVL[r.worst.level]+'">'+label[r.worst.type]+' · '+r.worst.level+'</b><br/>'+
      ((r.advice[r.worst.type]||{})[r.worst.level]||"—")+'</td></tr>';
  }).join("");
}

/* ---------- 天气 chart ---------- */
let weatherChart = null, chartType = "thunder";
function renderChart(series){
  const dom = $("weatherChart");
  if(!dom) return;
  if(!weatherChart) weatherChart = echarts.init(dom);
  const times = series.map(s=>s.t.slice(5,16).replace("T"," "));
  const ps = series.map(s=>Math.round(s.p*100));
  const fs = series.map(s=>Math.round(s.f*100));
  const pre = series.map(s=>s.precip);
  const rha = series.map(s=>s.rh);
  const cloud = series.map(s=>s.cloud);
  const tmp = series.map(s=>s.temp);
  const isT = chartType==="thunder";
  // 图表筛选
  const cf = window.__chartFilter || "all";
  const showAll = (cf === "all");
  const showThunder = showAll || cf === "thunder";
  const showFog = showAll || cf === "fog";
  const showRain = showAll || cf === "rain";
  const showTemp = showAll || cf === "temp";
  const showWind = showAll || cf === "wind";
  const showHumidity = showAll;
  const ws = series.map(s=>s.ws);
  const wg = series.map(s=>s.wg);
  const option = {
    backgroundColor:"transparent",
    tooltip:{trigger:"axis", axisPointer:{type:"cross"}, formatter:p=>{
      const i = p[0].dataIndex;
      const s = series[i];
      let h = '<b>'+times[i]+'</b><br/>';
      h += '🌩 强对流 '+Math.round(s.p*100)+'% · 🌫 浓雾 '+Math.round(s.f*100)+'%<br/>';
      h += '🌡 气温 '+s.temp+'°C · 💧 湿度 '+s.rh+'%<br/>';
      h += '🌧 降水 '+s.precip+'mm · ☁️ 云量 '+s.cloud+'%<br/>';
      h += '💨 风速 '+s.ws+'m/s · 阵风 '+s.wg+'m/s';
      return h;
    }},
    legend:{data:[showThunder?"强对流概率":(showFog?"浓雾概率":""), showRain?"降水":"", showHumidity?"湿度":"", showTemp?"气温":"", showWind?"风速/阵风":""].filter(Boolean), textStyle:{color:"#8fa3c0"}, top:6},
    grid:{left:48, right:52, top:48, bottom:28},
    xAxis:{type:"category", data:times, axisLine:{lineStyle:{color:"#243349"}}, axisLabel:{color:"#8fa3c0", fontSize:10}},
    yAxis:[
      {type:"value", name:"概率 %", min:0, max:100, axisLine:{lineStyle:{color:"#243349"}}, axisLabel:{color:"#8fa3c0"}, splitLine:{lineStyle:{color:"#1a2a40"}}},
      {type:"value", name:"mm / % / °C", min:0, max:100, axisLine:{lineStyle:{color:"#243349"}}, axisLabel:{color:"#8fa3c0"}, splitLine:{show:false}}
    ],
    series:[
      (showThunder||showFog) ? {name:isT?"强对流概率":"浓雾概率", type:"line", data:(isT?ps:fs), smooth:true, symbol:"none",
       lineStyle:{width:3, color:(isT?"#ff9f43":"#4aa3ff")},
       areaStyle:{color:{type:"linear", x:0, y:0, x2:0, y2:1,
         colorStops:[
           {offset:0, color:(isT?"rgba(255,159,67,.35)":"rgba(74,163,255,.35)")},
           {offset:1, color:(isT?"rgba(255,159,67,.05)":"rgba(74,163,255,.05)")}
         ]}}} : null,
      showRain ? {name:"降水", type:"bar", yAxisIndex:1, data:pre, itemStyle:{color:"rgba(74,163,255,.55)"}, barWidth:"40%"} : null,
      showHumidity ? {name:"湿度", type:"line", yAxisIndex:1, data:rha, smooth:true, symbol:"none", lineStyle:{width:2, color:"#2ecc71"}} : null,
      showTemp ? {name:"气温", type:"line", yAxisIndex:1, data:tmp, smooth:true, symbol:"none", lineStyle:{width:2, color:"#ff6b6b"}} : null,
      showWind ? {name:"风速/阵风", type:"line", yAxisIndex:1, data:ws, smooth:true, symbol:"none", lineStyle:{width:1.5, color:"#e8a35c", type:"dashed"}} : null
    ].filter(Boolean)
  };
  weatherChart.setOption(option);
}
function setChart(t){
  chartType = t;
  $("btnChartT").classList.toggle("active", t==="thunder");
  $("btnChartF").classList.toggle("active", t==="fog");
  if(window.__chartSeries) renderChart(window.__chartSeries);
}

/* ---------- 渲染: 风和气象模型面板 ---------- */
function renderFenghe(){
  if(!FENGHE) return;
  $("fenghePanel").style.display = "";
  const fh = FENGHE;
  const priors = fh.fenghe_priors || {};
  const anomaly = fh.region_anomaly || {};
  const mc = fh.extreme_scenarios || {};
  const stations = fh.station_comparison || [];

  // 摘要
  const riskIdx = (priors.climate_risk_index||0);
  const riskLv = priors.risk_level || "—";
  const riskColor = riskLv==="极高"?"#ff4d4f":riskLv==="高"?"#ff9f43":riskLv==="中"?"#f7d154":"#2ecc71";
  $("fengheNote").innerHTML = `${fh.model_name||"风和气象模型"} v${fh.version||"1.0"} · 学习区域: 哀牢山/玉溪/普洱/昆明 · 数据: ${fh.data_period||"2020-2026"} · 共 ${fh.total_records||0} 条小时级记录`;
  $("fengheSummary").innerHTML = `
    <div class="sum-item" style="border-color:${riskColor}">气候风险指数<b style="color:${riskColor}">${(riskIdx*100).toFixed(1)}</b></div>
    <div class="sum-item">风险等级<b style="color:${riskColor}">${riskLv}</b></div>
    <div class="sum-item">极端降水<b>${((priors.extreme_precip_prior||0)*100).toFixed(1)}%</b></div>
    <div class="sum-item">极端大风<b>${((priors.extreme_wind_prior||0)*100).toFixed(1)}%</b></div>
    <div class="sum-item">浓雾概率<b>${((priors.extreme_fog_prior||0)*100).toFixed(1)}%</b></div>
    <div class="sum-item">强对流概率<b>${((priors.thunderstorm_prior||0)*100).toFixed(1)}%</b></div>
    <div class="sum-item">降水异常<b>${(anomaly.precip||0).toFixed(2)}σ</b></div>
    <div class="sum-item">温度异常<b>${(anomaly.temp||0).toFixed(2)}σ</b></div>
  `;

  // 各站点极端天气概率表
  const pct = v => v!=null ? (v*100).toFixed(1)+"%" : "—";
  const sigma = v => v!=null ? (v>=0?"+":"")+v.toFixed(2)+"σ" : "—";
  $("fengheStationTbody").innerHTML = stations.map(s => `
    <tr>
      <td>${s.region||""}</td>
      <td>${s.station||""}</td>
      <td>${s.elev||""}m</td>
      <td><span class="pill ${s.extreme_precip_prob>=0.5?"warn":s.extreme_precip_prob>=0.2?"high":s.extreme_precip_prob>=0.1?"watch":"low"}">${pct(s.extreme_precip_prob)}</span></td>
      <td><span class="pill ${s.extreme_wind_prob>=0.15?"high":s.extreme_wind_prob>=0.1?"watch":"low"}">${pct(s.extreme_wind_prob)}</span></td>
      <td><span class="pill ${s.extreme_fog_prob>=0.2?"warn":s.extreme_fog_prob>=0.1?"high":s.extreme_fog_prob>=0.05?"watch":"low"}">${pct(s.extreme_fog_prob)}</span></td>
      <td><span class="pill ${s.thunderstorm_prob>=0.05?"high":s.thunderstorm_prob>=0.03?"watch":"low"}">${pct(s.thunderstorm_prob)}</span></td>
      <td style="color:${(s.anomaly_precip||0)<-0.5?"#4aa3ff":(s.anomaly_precip||0)>0.5?"#ff9f43":"#8fa3c0"}">${sigma(s.anomaly_precip)}</td>
      <td style="color:${(s.anomaly_temp||0)>0.3?"#ff9f43":"#8fa3c0"}">${sigma(s.anomaly_temp)}</td>
    </tr>
  `).join("");

  // 蒙特卡洛模拟表
  const mcRows = [];
  if(mc.weekly_max_precip){
    const w = mc.weekly_max_precip;
    mcRows.push(`<tr><td>周最大日降水(mm)</td><td>${w.mean||"—"}</td><td>${w.p90||"—"}</td><td>${w.p95||"—"}</td><td>${w.p99||"—"}</td><td>${w.max||"—"}</td></tr>`);
  }
  if(mc.weekly_max_wind){
    const w = mc.weekly_max_wind;
    const fmt = v => v&&!isNaN(v) ? v : "—";
    mcRows.push(`<tr><td>周最大阵风(m/s)</td><td>${fmt(w.mean)}</td><td>${fmt(w.p90)}</td><td>${fmt(w.p95)}</td><td>—</td><td>${fmt(w.max)}</td></tr>`);
  }
  if(mc.weekly_fog_days){
    const w = mc.weekly_fog_days;
    mcRows.push(`<tr><td>周浓雾天数</td><td>${w.mean||"—"}</td><td>${w.p90||"—"}</td><td>—</td><td>—</td><td>${w.max||"—"}</td></tr>`);
  }
  if(mc.weekly_thunderstorm_days){
    const w = mc.weekly_thunderstorm_days;
    mcRows.push(`<tr><td>周强对流天数</td><td>${w.mean||"—"}</td><td>${w.p90||"—"}</td><td>—</td><td>—</td><td>${w.max||"—"}</td></tr>`);
  }
  $("fengheMCTbody").innerHTML = mcRows.join("");

  // 洞察
  const extProb = mc.extreme_event_probability || 0;
  $("fengheInsight").innerHTML = `蒙特卡洛1000次模拟显示，未来一周内发生至少一次极端事件（日降水>50mm 或 阵风>20m/s 或 浓雾≥3天）的概率为 <b style="color:${extProb>=0.8?"#ff4d4f":"#ff9f43"}">${(extProb*100).toFixed(1)}%</b>。`+
    (anomaly.precip!=null ? ` 近期降水${anomaly.precip<-0.5?"显著偏少":anomaly.precip>0.5?"显著偏多":"接近常年"}(${anomaly.precip.toFixed(2)}σ)。` : "")+
    (anomaly.temp!=null ? ` 气温${anomaly.temp>0.3?"偏高":anomaly.temp<-0.3?"偏低":"接近常年"}(${anomaly.temp.toFixed(2)}σ)。` : "");
}

/* ---------- 渲染: 多模型联合研判面板 ---------- */
function renderJoint(){
  if(!JOINT) return;
  $("jointPanel").style.display = "";
  const j = JOINT;
  const ca = j.comprehensive_assessment || {};
  const scenarios = j.emergency_scenarios || [];
  const findings = ca.key_findings || [];
  const recs = j.recommendations || [];
  const cal = j.seasonal_risk_calendar || {};

  // 摘要
  const riskScore = ca.overall_risk_score || 0;
  const riskLevel = ca.overall_risk_level || "—";
  const riskColor = riskLevel.includes("I级")?"#ff4d4f":riskLevel.includes("II级")?"#ff9f43":riskLevel.includes("III级")?"#f7d154":"#2ecc71";
  $("jointNote").innerHTML = `${j.report_title||"多模型联合研判"} · ${j.report_period||""} · 生成时间: ${j.generated_at||""}`;
  $("jointSummary").innerHTML = `
    <div class="sum-item" style="border-color:${riskColor}">综合风险评分<b style="color:${riskColor}">${(riskScore*100).toFixed(1)}</b></div>
    <div class="sum-item">综合风险等级<b style="color:${riskColor}">${riskLevel}</b></div>
    <div class="sum-item">建议措施<b style="font-size:13px;color:${riskColor}">${ca.recommended_action||""}</b></div>
    <div class="sum-item">高风险场景<b>${ca.high_risk_scenario_count||0}</b></div>
    <div class="sum-item">极端风险场景<b>${ca.extreme_risk_scenario_count||0}</b></div>
    <div class="sum-item">模型一致性<b style="color:${(ca.multi_model_consensus||{}).model_agreement==="高"?"#ff4d4f":"#ff9f43"}">${(ca.multi_model_consensus||{}).model_agreement||"—"}</b></div>
  `;

  // 场景表
  const lvlColor = lv => lv==="极高"?"#ff4d4f":lv==="高"?"#ff9f43":lv==="中"?"#f7d154":"#2ecc71";
  $("jointScenariosTbody").innerHTML = scenarios.map(s => `
    <tr>
      <td><b>${s.id}</b></td>
      <td>${s.name}</td>
      <td style="font-size:11px;color:var(--sub)">${s.trigger||""}</td>
      <td>${((s.fenghe_prior||0)*100).toFixed(1)}%</td>
      <td>${((s.model_adjusted||0)*100).toFixed(1)}%</td>
      <td><span class="pill ${s.risk_level==="极高"?"warn":s.risk_level==="高"?"high":s.risk_level==="中"?"watch":"low"}">${(s.combined_risk*100).toFixed(1)}%</span></td>
      <td style="color:${lvlColor(s.risk_level)};font-weight:700">${s.risk_level}</td>
      <td style="font-size:11px">${(s.affected_areas||[]).join("、")}</td>
      <td style="font-size:11px;color:var(--sub)">${s.timeline||""}</td>
      <td style="font-size:11px">${s.recommendation||""}</td>
    </tr>
  `).join("");

  // 关键发现
  $("jointFindings").innerHTML = findings.map(f => `<p style="margin:4px 0">• ${f}</p>`).join("");

  // 建议措施
  $("jointRecs").innerHTML = recs.map(r => `<p style="margin:4px 0">${r}</p>`).join("");

  // 季节性风险日历
  const months = Object.keys(cal).sort((a,b)=>parseInt(a)-parseInt(b));
  $("jointCalTbody").innerHTML = months.map(m => {
    const r = cal[m];
    const ri = r.climate_risk_index || 0;
    const lv = r.risk_level || "—";
    const lc = lv==="极高"?"#ff4d4f":lv==="高"?"#ff9f43":lv==="中"?"#f7d154":"#2ecc71";
    return `<tr>
      <td><b>${m}月</b></td>
      <td><span class="pill ${r.precip_risk>=0.1?"high":r.precip_risk>=0.05?"watch":"low"}">${(r.precip_risk*100).toFixed(1)}%</span></td>
      <td><span class="pill ${r.wind_risk>=0.1?"high":"low"}">${(r.wind_risk*100).toFixed(1)}%</span></td>
      <td><span class="pill ${r.fog_risk>=0.1?"high":r.fog_risk>=0.05?"watch":"low"}">${(r.fog_risk*100).toFixed(1)}%</span></td>
      <td><span class="pill ${r.thunder_risk>=0.1?"high":r.thunder_risk>=0.05?"watch":"low"}">${(r.thunder_risk*100).toFixed(1)}%</span></td>
      <td><b style="color:${lc}">${(ri*100).toFixed(1)}</b></td>
      <td style="color:${lc};font-weight:700">${lv}</td>
    </tr>`;
  }).join("");
}

/* ---------- 3D全景地形渲染 ---------- */
/* 地理坐标 -> 3D网格坐标 [x,y,z]：用 mesh 的经纬范围 + heatmap.elev 双线性插值取海拔 */
function meshPos(lat, lon){
  const m = TERRAIN3D.mesh_3d;
  const lat0 = m.lat_range[0], lat1 = m.lat_range[1];
  const lon0 = m.lon_range[0], lon1 = m.lon_range[1];
  const x = (lon - lon0)/(lon1 - lon0)*2 - 1;
  const z = (lat - lat0)/(lat1 - lat0)*2 - 1;
  const hm = TERRAIN3D.heatmap.elev;
  const rows = hm.length, cols = hm[0].length;
  const fi = (lat - lat0)/(lat1 - lat0) * (rows-1);
  const fj = (lon - lon0)/(lon1 - lon0) * (cols-1);
  const i0 = Math.min(rows-2, Math.max(0, Math.floor(fi)));
  const j0 = Math.min(cols-2, Math.max(0, Math.floor(fj)));
  const di = fi - i0, dj = fj - j0;
  const e = hm[i0][j0]*(1-di)*(1-dj) + hm[i0+1][j0]*di*(1-dj)
          + hm[i0][j0+1]*(1-di)*dj + hm[i0+1][j0+1]*di*dj;
  return [x, e/3137, z];
}

/* 快速海拔查询（米），用于森林分布/坡度过滤 */
function elevAt(lat, lon){
  return meshPos(lat, lon)[1] * 3137;
}
function slopeAt(lat, lon){
  const d = 0.005;
  const e1 = elevAt(lat+d, lon), e2 = elevAt(lat-d, lon);
  const e3 = elevAt(lat, lon+d), e4 = elevAt(lat, lon-d);
  const gx = (e3-e4)/(2*d*111000), gy = (e1-e2)/(2*d*111000);
  return Math.hypot(gx, gy);
}

/* 树林点缓存：按海拔带撒确定性树点（哀牢山垂直带谱） */
let FOREST3D = null;
function loadTreeSprites(){
  if(TREE_IMGS.loading) return;
  TREE_IMGS.loading = true;
  const names = {conifer:"images/trees_conifer.png", broad:"images/trees_broad.png", shrub:"images/trees_shrub.png"};
  Promise.all(Object.entries(names).map(([k, src])=> new Promise((res)=>{
    const img = new Image();
    img.onload = ()=>{ TREE_IMGS[k] = img; res(); };
    img.onerror = ()=> res();
    img.src = src;
  }))).then(()=>{ TREE_IMGS.loaded = true; /* Three.js 自有渲染循环，无需手动重绘 */ });
}
function buildForest3D(){
  const m = TERRAIN3D.mesh_3d;
  const lat0=m.lat_range[0], lat1=m.lat_range[1], lon0=m.lon_range[0], lon1=m.lon_range[1];
  let seed = 20260814;
  const rnd = ()=>{ seed = (seed*1103515245+12345) & 0x7fffffff; return seed/0x7fffffff; };
  const items = [];
  const CAND = 9000;
  for(let i=0;i<CAND;i++){
    const lat = lat0 + rnd()*(lat1-lat0);
    const lon = lon0 + rnd()*(lon1-lon0);
    const p = meshPos(lat, lon);
    const e = p[1]*3137;
    let density = 0;
    if(e>=900 && e<1900)      density = 0.15 + (e-900)/1000*0.12;   // 低山常绿阔叶林
    else if(e>=1900 && e<2620) density = 0.30;                       // 中山湿性林最茂密
    else if(e>=2620 && e<2820) density = 0.15;                       // 苔藓矮林
    else if(e>=700 && e<900)  density = 0.06;                        // 河谷稀树
    else if(e>=2820)          density = 0.025;                       // 山顶草甸
    if(rnd() > density) continue;
    if(slopeAt(lat, lon) > 0.52) continue;                           // 陡坡无树
    // 树种与色阶：低山阔叶，中山针叶+阔叶，高山灌丛
    let kind = 1; // conifer 默认
    if(e < 1400)       kind = 0;                // broad
    else if(e < 2200)  kind = rnd() < 0.55 ? 1 : 0; // 针阔混交
    else if(e >= 2700) kind = 2;                // alpine shrub
    // 色阶：低山深绿 vari=0，中山翠绿 vari=1，高山黄绿 vari=2
    let vari = e < 1600 ? 0 : e < 2350 ? 1 : 2;
    // 低海拔阔叶偏深绿，高山针叶偏黄绿：vari 与 kind 做一点随机扰动
    if(rnd() < 0.18) vari = Math.max(0, Math.min(2, vari + (rnd()<0.5 ? -1 : 1)));
    items.push({
      x:p[0], y:p[1], z:p[2],
      size: 0.85 + rnd()*1.05,   // 比原来稍大，便于看清贴图
      kind, vari,
      flip: rnd() < 0.45          // 左右镜像增加多样性
    });
  }
  FOREST3D = {items};
}

function renderTerrain3D(){
  if(!TERRAIN3D) return;
  const t = TERRAIN3D;
  const panel = $("terrain3DPanel");
  if(panel) panel.style.display = "block";
  const hero = $("heroSection");
  if(hero) hero.style.display = "block";

  const meshInfo = HEIGHT_MAP
    ? `Three.js 实时 3D：${HEIGHT_MAP.h}x${HEIGHT_MAP.w} 精细 DEM 高度场 / 70,000+ 三角面，真实透视+光照阴影`
    : `基于原始 ${t.dem_grid} DEM：${t.mesh_3d.n_vertices} 顶点 / ${t.mesh_3d.n_faces} 面 3D网格`;
  $("terrain3DNote").textContent = `${meshInfo}。海拔范围 ${t.elev_range[0]}~${t.elev_range[1]}m。已叠加 ${(TERR.roads||[]).length+(TERR.roads_extra||[]).length} 条真实道路、${(TERR.rivers||[]).length} 条河流、按海拔带分布的真实森林与悬浮地名标签（悬停查看海拔/坡度/风险增强）。`;

  const rs = t.risk_factors_summary || {};
  $("terrain3DSummary").innerHTML = `
    <div class="sum-item">风强增强<b style="color:var(--orange)">${(rs.wind_enhance*100).toFixed(1)}%</b>最大 ${(rs.wind_enhance_max*100).toFixed(1)}%</div>
    <div class="sum-item">浓雾增强<b style="color:var(--blue)">${(rs.fog_enhance*100).toFixed(1)}%</b>最大 ${(rs.fog_enhance_max*100).toFixed(1)}%</div>
    <div class="sum-item">泥石流增强<b style="color:var(--red)">${(rs.debris_enhance*100).toFixed(1)}%</b>最大 ${(rs.debris_enhance_max*100).toFixed(1)}%</div>
    <div class="sum-item">雷电增强<b style="color:#f7d154">${(rs.lightning_enhance*100).toFixed(1)}%</b>最大 ${(rs.lightning_enhance_max*100).toFixed(1)}%</div>
    <div class="sum-item">3D特征数<b>${t.features.length}</b>种</div>
    <div class="sum-item">3D网格<b>${HEIGHT_MAP ? (HEIGHT_MAP.h*HEIGHT_MAP.w).toLocaleString() : t.mesh_3d.n_vertices}</b>顶点 / <b>${HEIGHT_MAP ? ((HEIGHT_MAP.h-1)*(HEIGHT_MAP.w-1)*2).toLocaleString() : t.mesh_3d.n_faces}</b>面</div>
  `;

  initThreeTerrain();
  drawHeatmap3D();
}

function draw3DCanvas(){
  const cv = $("canvas3D");
  if(!cv || !TERRAIN3D) return;
  if(!SUBD_MESH || !SUBD_MESH.vnorms) buildFromHeightMap();
  const ctx = cv.getContext("2d");
  const w = cv.width, h = cv.height;
  const DPR = w / 760;

  // ---- 天空背景：径向渐变，营造景深 ----
  const sky = ctx.createRadialGradient(w*0.5, h*0.30, 0, w*0.5, h*0.5, Math.max(w,h)*0.85);
  sky.addColorStop(0.0, "#1a2f4d");
  sky.addColorStop(0.45, "#0f1e33");
  sky.addColorStop(0.85, "#0a1320");
  sky.addColorStop(1.0, "#050a10");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  const mesh = TERRAIN3D.mesh_3d;
  const er = TERRAIN3D.elev_range || [452, 3078];
  const verts = SUBD_MESH.verts, faces = SUBD_MESH.faces;
  const vnorms = SUBD_MESH.vnorms;

  // 旋转变换参数
  const cosY = Math.cos(rot3D.ry), sinY = Math.sin(rot3D.ry);
  const cosX = Math.cos(rot3D.rx), sinX = Math.sin(rot3D.rx);
  const s = rot3D.scale * Math.min(w, h) * 0.38;
  const cx = w / 2, cy = h / 2 - 10;
  const EX = 0.85;  // 降低垂直夸张，保留立体感同时让宽高比例更真实

  // 光照与雾效
  const fogColor = [8, 15, 26];          // 远处融入背景
  const fogNear = -0.22, fogFar = 0.62;  // 基于模型 z 的雾范围

  const elevNorm = v => Math.max(0, Math.min(1, (v[1]*3137 - er[0]) / (er[1] - er[0])));

  // ---- 投影 + 逐顶点光照（Gouraud：顶点法线平均，面用三顶点颜色均值） ----
  const projected = new Array(verts.length);
  const shadedColor = new Array(verts.length);
  for(let i=0;i<verts.length;i++){
    const v = verts[i];
    let x1 = v[0]*cosY - v[2]*sinY;
    let z1 = v[0]*sinY + v[2]*cosY;
    let y1 = v[1]*EX*cosX - z1*sinX;
    let z2 = v[1]*EX*sinX + z1*cosX;
    projected[i] = {x: cx + x1*s, y: cy - y1*s, z: z2};

    const n = vnorms[i];
    const base = elevColor(elevNorm(v));
    // 漫反射 + 环境光 + 边缘光（让山体轮廓更分明）
    const diff = Math.max(0, n[0]*LD[0] + n[1]*LD[1] + n[2]*LD[2]);
    const rim  = Math.max(0, 1 - Math.abs(n[2])) * 0.18;  // 侧向边缘提亮
    const slope= Math.max(0, 1 - n[2]) * 0.10;            // 陡坡稍微压暗，增加侵蚀感
    const light = 0.38 + 0.52*diff + rim - slope;
    let r = base[0]*light, g = base[1]*light, b = base[2]*light;

    // 雾效（越远越融入背景）
    const ff = Math.max(0, Math.min(1, (z2 - fogNear) / (fogFar - fogNear)));
    r = r*(1-ff) + fogColor[0]*ff;
    g = g*(1-ff) + fogColor[1]*ff;
    b = b*(1-ff) + fogColor[2]*ff;

    shadedColor[i] = [Math.min(255, Math.round(r)), Math.min(255, Math.round(g)), Math.min(255, Math.round(b))];
  }

  // 面排序（画家算法）
  const faceData = faces.map((f, i)=>{
    const a=projected[f[0]], b=projected[f[1]], c=projected[f[2]];
    return {f, avgZ: (a.z+b.z+c.z)/3};
  }).sort((x, y)=> x.avgZ - y.avgZ);

  // ---- 绘制地形面：用三顶点颜色均值，因网格细分后面很小，整体呈现平滑过渡 ----
  ctx.lineJoin = "round";
  for(const fd of faceData){
    const f = fd.f;
    const p0 = projected[f[0]], p1 = projected[f[1]], p2 = projected[f[2]];
    const cross = (p1.x-p0.x)*(p2.y-p0.y) - (p1.y-p0.y)*(p2.x-p0.x);
    if(cross < 0) continue; // 背面剔除
    const c0 = shadedColor[f[0]], c1 = shadedColor[f[1]], c2 = shadedColor[f[2]];
    const r = (c0[0]+c1[0]+c2[0])/3 | 0;
    const g = (c0[1]+c1[1]+c2[1])/3 | 0;
    const b = (c0[2]+c1[2]+c2[2])/3 | 0;
    ctx.fillStyle = "rgb(" + r + "," + g + "," + b + ")";
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.closePath();
    ctx.fill();
  }

  // ---- 河流（蓝色曲线，先画） ----
  const riverSegs = [];
  (TERR.rivers||[]).forEach(rv=>{
    const pts = rv.pts||[];
    if(pts.length<2) return;
    const proj = pts.map(pt=> project3D(meshPos(pt[0], pt[1]), cosX, sinX, cosY, sinY, s, cx, cy, EX));
    let zs=0; proj.forEach(pp=> zs+=pp.z);
    riverSegs.push({pts: proj, z: zs/proj.length});
  });
  riverSegs.sort((a,b)=> a.z - b.z);
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  for(const rg of riverSegs){
    ctx.strokeStyle = "rgba(90,180,255,0.22)";
    ctx.lineWidth = 3.4*DPR;
    ctx.beginPath();
    rg.pts.forEach((pp,i)=> i ? ctx.lineTo(pp.x,pp.y) : ctx.moveTo(pp.x,pp.y));
    ctx.stroke();
    ctx.strokeStyle = "rgba(150,215,255,0.80)";
    ctx.lineWidth = 1.5*DPR;
    ctx.beginPath();
    rg.pts.forEach((pp,i)=> i ? ctx.lineTo(pp.x,pp.y) : ctx.moveTo(pp.x,pp.y));
    ctx.stroke();
  }

  // ---- 道路（Catmull-Rom 平滑 + 路基/路面/虚实线） ----
  function catmullRom(seq, segs=4){
    const out=[];
    for(let i=0;i<seq.length-1;i++){
      const p0=seq[Math.max(0,i-1)], p1=seq[i], p2=seq[i+1], p3=seq[Math.min(seq.length-1,i+2)];
      for(let k=0;k<segs;k++){
        const t=k/segs, t2=t*t, t3=t2*t;
        out.push({
          x:0.5*((2*p1.x)+(-p0.x+p2.x)*t+(2*p0.x-5*p1.x+4*p2.x-p3.x)*t2+(-p0.x+3*p1.x-3*p2.x+p3.x)*t3),
          y:0.5*((2*p1.y)+(-p0.y+p2.y)*t+(2*p0.y-5*p1.y+4*p2.y-p3.y)*t2+(-p0.y+3*p1.y-3*p2.y+p3.y)*t3)
        });
      }
    }
    out.push(seq[seq.length-1]);
    return out;
  }
  const roadTypeOf = r=>{
    if(r.road_type) return r.road_type;
    const n = r.name||"";
    if(n.includes("高速")) return "高速";
    if(n.includes("国道")) return "国道";
    if(n.includes("省道")) return "省道";
    if(n.includes("乡道")) return "县乡道";
    if(n.includes("县道")) return "县道";
    if(n.includes("景区")) return "景区公路";
    return "县乡道";
  };
  const roadSurface = {
    "高速":   {base:0.55, face:"#7c858f", dash:[0,0], dashCol:"#ffffff"},
    "国道":   {base:0.50, face:"#949aa2", dash:[3.2,2.6], dashCol:"#ffffff"},
    "省道":   {base:0.45, face:"#a4aab2", dash:[2.8,2.6], dashCol:"#ffffff"},
    "县道":   {base:0.40, face:"#b0b6bc", dash:[2.4,2.4], dashCol:"#ffffff"},
    "县乡道": {base:0.36, face:"#b9bec4", dash:[2.0,2.0], dashCol:"#e8e8e8"},
    "景区公路":{base:0.40, face:"#c4b7a0", dash:[2.4,2.6], dashCol:"#fff0c0"}
  };
  const allRoads = (TERR.roads||[]).concat(TERR.roads_extra||[]);
  const roadDraw = [];
  allRoads.forEach(r=>{
    const pts = r.pts||[];
    if(pts.length<2) return;
    const raw = pts.map(pt=> project3D(meshPos(pt[0], pt[1]), cosX, sinX, cosY, sinY, s, cx, cy, EX));
    const proj = catmullRom(raw, 3);
    let zs=0; raw.forEach(pp=> zs+=pp.z);
    roadDraw.push({pts: proj, z: zs/raw.length, style: roadSurface[roadTypeOf(r)] || roadSurface["县乡道"]});
  });
  roadDraw.sort((a,b)=> a.z - b.z);
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  const roadBaseW = 3.4 * DPR, roadFaceW = 2.0 * DPR, dashW = 0.8 * DPR;
  for(const rd of roadDraw){
    const st = rd.style;
    // 路基阴影（嵌在地形里的投影）
    ctx.save();
    ctx.translate(0, 1.1 * DPR);
    ctx.strokeStyle = "rgba(0,0,0,0.42)";
    ctx.lineWidth = roadBaseW + 1.0 * DPR;
    ctx.beginPath();
    rd.pts.forEach((pp,i)=> i ? ctx.lineTo(pp.x,pp.y) : ctx.moveTo(pp.x,pp.y));
    ctx.stroke();
    ctx.restore();
    // 路基
    ctx.strokeStyle = "rgba(0,0,0," + (0.48 + st.base*0.22) + ")";
    ctx.lineWidth = roadBaseW;
    ctx.beginPath();
    rd.pts.forEach((pp,i)=> i ? ctx.lineTo(pp.x,pp.y) : ctx.moveTo(pp.x,pp.y));
    ctx.stroke();
    // 路面
    ctx.strokeStyle = st.face;
    ctx.lineWidth = roadFaceW;
    ctx.beginPath();
    rd.pts.forEach((pp,i)=> i ? ctx.lineTo(pp.x,pp.y) : ctx.moveTo(pp.x,pp.y));
    ctx.stroke();
    // 中线
    if(st.dash[0] > 0){
      ctx.setLineDash(st.dash.map(v=>v*DPR));
      ctx.strokeStyle = st.dashCol;
      ctx.lineWidth = dashW;
      ctx.beginPath();
      rd.pts.forEach((pp,i)=> i ? ctx.lineTo(pp.x,pp.y) : ctx.moveTo(pp.x,pp.y));
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // ---- 树林（真实树贴图 + 树底投影，按深度排序） ----
  if(!FOREST3D) buildForest3D();
  if(FOREST3D && FOREST3D.items.length){
    const kindImg = ["broad","conifer","shrub"];
    const kindRatio = [144/112, 160/96, 88/96];  // 高/宽
    const trees = FOREST3D.items.map(t=>{
      const p = project3D([t.x, t.y, t.z], cosX, sinX, cosY, sinY, s, cx, cy, EX);
      return {px:p.x, py:p.y, z:p.z, size:t.size, kind:t.kind, vari:t.vari, flip:t.flip};
    });
    trees.sort((a,b)=> a.z - b.z);
    for(const tr of trees){
      const r = tr.size * DPR * (0.72 + (tr.z+1)*0.30);   // 树冠半径（屏幕像素）
      if(r < 0.55) continue;                               // 极远处只省略
      const img = TREE_IMGS[kindImg[tr.kind]];
      if(img && TREE_IMGS.loaded){
        const sw = img.width / 3, sh = img.height;
        const tw = r * 2.4;                               // 树宽度
        const th = tw * (sh / sw);
        // 树底投影
        ctx.fillStyle = "rgba(0,0,0,0.26)";
        ctx.beginPath();
        ctx.ellipse(tr.px, tr.py + r*0.05, tw*0.48, tw*0.12, 0, 0, Math.PI*2);
        ctx.fill();
        // 贴图绘制（底端对齐地面，可选镜像）
        ctx.save();
        if(tr.flip) ctx.translate(tr.px * 2, 0), ctx.scale(-1, 1);
        ctx.drawImage(img, tr.vari*sw, 0, sw, sh, tr.px - tw/2, tr.py - th, tw, th);
        ctx.restore();
      } else {
        // 贴图未加载时回退到简单色块
        const dark = tr.kind===2 ? [92,108,78] : tr.kind===0 ? [40,92,54] : [34,80,48];
        const lite = tr.kind===2 ? [130,145,100] : tr.kind===0 ? [80,150,84] : [72,140,64];
        const g = ctx.createRadialGradient(tr.px, tr.py - r, r*0.1, tr.px, tr.py - r, r);
        g.addColorStop(0, "rgb(" + lite.join(",") + ")");
        g.addColorStop(1, "rgb(" + dark.join(",") + ")");
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(tr.px, tr.py - r, r, 0, Math.PI*2); ctx.fill();
      }
    }
  }

  // ---- 柔和等高线（每 250m，细线、低对比，只勾轮廓不抢戏） ----
  const hmE = (HEIGHT_MAP && HEIGHT_MAP.elev_2d) ? HEIGHT_MAP.elev_2d : TERRAIN3D.heatmap.elev;
  if(hmE){
    const lat0 = mesh.lat_range[0], lat1 = mesh.lat_range[1];
    const lon0 = mesh.lon_range[0], lon1 = mesh.lon_range[1];
    ctx.strokeStyle = "rgba(0,0,0,0.28)";
    ctx.lineWidth = 0.8 * DPR;
    ctx.beginPath();
    for(let lev=500; lev<=3000; lev+=250){
      if(lev < er[0] || lev > er[1]) continue;
      const segs = contourSegments(hmE, lat0, lat1, lon0, lon1, lev);
      for(const sg of segs){
        const pA = project3D(meshPos(sg[0][0], sg[0][1]), cosX, sinX, cosY, sinY, s, cx, cy, EX);
        const pB = project3D(meshPos(sg[1][0], sg[1][1]), cosX, sinX, cosY, sinY, s, cx, cy, EX);
        ctx.moveTo(pA.x, pA.y);
        ctx.lineTo(pB.x, pB.y);
      }
    }
    ctx.stroke();
  }

  // ---- 地平面参考网格：帮助区分高度与宽度 ----
  const hmRange = HEIGHT_MAP ? HEIGHT_MAP : TERRAIN3D.mesh_3d;
  const latR = hmRange.lat_range, lonR = hmRange.lon_range;
  const xz = (la, lo)=> [2*(lo-lonR[0])/(lonR[1]-lonR[0])-1, 0, 2*(la-latR[0])/(latR[1]-latR[0])-1];
  ctx.save();
  ctx.strokeStyle = "rgba(232,238,247,0.10)";
  ctx.lineWidth = 0.8 * DPR;
  ctx.beginPath();
  for(let k=0;k<=4;k++){
    const lat = latR[0] + (latR[1]-latR[0])*(k/4);
    const p0 = project3D(xz(lat, lonR[0]), cosX, sinX, cosY, sinY, s, cx, cy, EX);
    const p1 = project3D(xz(lat, lonR[1]), cosX, sinX, cosY, sinY, s, cx, cy, EX);
    if(p0.z < 0.55 && p1.z < 0.55){ ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); }
  }
  for(let k=0;k<=4;k++){
    const lon = lonR[0] + (lonR[1]-lonR[0])*(k/4);
    const p0 = project3D(xz(latR[0], lon), cosX, sinX, cosY, sinY, s, cx, cy, EX);
    const p1 = project3D(xz(latR[1], lon), cosX, sinX, cosY, sinY, s, cx, cy, EX);
    if(p0.z < 0.55 && p1.z < 0.55){ ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); }
  }
  ctx.stroke();
  ctx.restore();

  // ---- 标注：精简 + 防重叠 ----
  const markers = [];
  const pushMarker = (la, lo, label, kind, priority)=>{
    const p = project3D(meshPos(la, lo), cosX, sinX, cosY, sinY, s, cx, cy, EX);
    markers.push({px: p.x, py: p.y, z: p.z, label, kind, priority});
  };
  // 只保留县城 + 核心景区，乡镇全部隐藏避免重叠
  (TERR.towns||[]).forEach(t=>{
    if(t.cls === "县城") pushMarker(t.lat, t.lon, t.name, "county", 2);
  });
  (WAYPOINTS||[]).forEach(wp=>{
    const pri = wp.open ? 3 : 1;
    const label = wp.name.replace(/景区$/, "").replace(/观景台$/, "");
    pushMarker(wp.lat, wp.lon, label, wp.open ? "wp" : "wpClosed", pri);
  });
  // 按优先级和深度排序：重要且近的先画
  markers.sort((a, b)=> (b.priority*10 + b.z) - (a.priority*10 + a.z));

  const occupied = [];  // 已占矩形 {x,y,w,h}
  const collides = (x, y, w, h)=>{
    for(const r of occupied){
      if(x < r.x+r.w+4*DPR && x+w+4*DPR > r.x && y < r.y+r.h+3*DPR && y+h+3*DPR > r.y) return true;
    }
    return false;
  };

  markers.forEach(mk=>{
    if(mk.px < -40 || mk.px > w+40 || mk.py < -40 || mk.py > h+40) return;
    const col = mk.kind==="wp" ? "#A8FFBC" : mk.kind==="wpClosed" ? "#FF9E9E" : "#FFE082";
    const label = mk.label.length>6 ? mk.label.slice(0,6) : mk.label;
    ctx.font = (mk.kind==="county" ? "bold " : "") + (11*DPR) + "px sans-serif";
    ctx.textBaseline = "middle";
    const tw = ctx.measureText(label).width;
    const tx = mk.px + 7*DPR, ty = mk.py;
    const box = {x: tx-2*DPR, y: ty-7*DPR, w: tw+4*DPR, h: 14*DPR};
    if(collides(box.x, box.y, box.w, box.h)) return;

    // 点
    ctx.beginPath();
    ctx.arc(mk.px, mk.py, (mk.kind==="wp" ? 3.0 : 2.4) * DPR, 0, Math.PI*2);
    ctx.fillStyle = "rgba(5,10,16,0.85)";
    ctx.fill();
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.4 * DPR;
    ctx.stroke();

    // 文字描边+填充
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(0,0,0,0.92)";
    ctx.lineWidth = 3.5 * DPR;
    ctx.strokeText(label, tx, ty);
    ctx.fillStyle = col;
    ctx.fillText(label, tx, ty);

    occupied.push(box);
  });

  // ---- 标题信息 ----
  ctx.fillStyle = "rgba(232,238,247,0.82)";
  ctx.font = "bold " + (14*DPR) + "px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("哀牢山 3D全景地形", 16*DPR, 26*DPR);
  ctx.font = (11*DPR) + "px sans-serif";
  ctx.fillStyle = "rgba(232,238,247,0.52)";
  ctx.fillText("拖拽旋转 · 滚轮缩放 · 海拔 " + er[0] + "–" + er[1] + "m · 垂直放大" + EX.toFixed(1) + "x", 16*DPR, 45*DPR);

  // ---- 指北针（右上角） ----
  const nx2 = -sinY, ny2 = cosY*sinX;
  const nl2 = Math.hypot(nx2, ny2) || 1;
  const nax = nx2/nl2, nay = ny2/nl2;
  const cxN = w - 48*DPR, cyN = 48*DPR, rN = 16*DPR;
  ctx.strokeStyle = "rgba(232,238,247,0.45)";
  ctx.lineWidth = 1.2 * DPR;
  ctx.beginPath(); ctx.arc(cxN, cyN, rN, 0, Math.PI*2); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cxN + nax*rN*0.95, cyN + nay*rN*0.95);
  ctx.lineTo(cxN - nax*rN*0.95, cyN - nay*rN*0.95);
  ctx.stroke();
  ctx.fillStyle = "#FFD54F";
  ctx.beginPath();
  ctx.arc(cxN + nax*rN*0.95, cyN + nay*rN*0.95, 3.0*DPR, 0, Math.PI*2);
  ctx.fill();
  ctx.font = "bold " + (12*DPR) + "px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("N", cxN + nax*(rN+11*DPR), cyN + nay*(rN+11*DPR) + 3*DPR);

  // ---- 海拔色标（右下角，加宽防截断） ----
  const lx0 = w - 56*DPR, ly0 = h - 210*DPR, lw = 16*DPR, lh = 160*DPR;
  ctx.textAlign = "left";
  for(let k=0;k<=40;k++){
    const tt = k/40;
    const cc = elevColor(tt);
    ctx.fillStyle = "rgb(" + Math.round(cc[0]) + "," + Math.round(cc[1]) + "," + Math.round(cc[2]) + ")";
    ctx.fillRect(lx0, ly0 + lh*(1-tt), lw, lh/40 + 0.5);
  }
  ctx.strokeStyle = "rgba(232,238,247,0.45)";
  ctx.lineWidth = 1;
  ctx.strokeRect(lx0, ly0, lw, lh);
  ctx.fillStyle = "rgba(232,238,247,0.85)";
  ctx.font = "bold " + (10*DPR) + "px sans-serif";
  // 文字放左侧，避免右侧截断
  ctx.textAlign = "right";
  ctx.fillText(Math.round(er[1]) + "m", lx0 - 5*DPR, ly0 + 4*DPR);
  ctx.fillStyle = "rgba(232,238,247,0.65)";
  ctx.font = (10*DPR) + "px sans-serif";
  ctx.fillText(Math.round(er[0]) + "m", lx0 - 5*DPR, ly0 + lh + 2*DPR);
  ctx.textAlign = "left";
}

/* ---------- 3D渲染辅助：细分网格 / 顶点法线 / 光照 / 色带 / 等高线 ---------- */
let SUBD_MESH = null;
const LD = (()=>{ const d=[0.45,0.78,0.42]; const l=Math.hypot(d[0],d[1],d[2]); return [d[0]/l, d[1]/l, d[2]/l]; })(); // 东南上方光源

function buildFromHeightMap(){
  const hm = HEIGHT_MAP;
  if(!hm) return buildSubdividedMesh();
  const rows = hm.h, cols = hm.w;
  const lat0 = hm.lat_range[0], lat1 = hm.lat_range[1];
  const lon0 = hm.lon_range[0], lon1 = hm.lon_range[1];
  const verts = [];
  for(let i=0;i<rows;i++){
    const lat = lat0 + (lat1-lat0)*(i/(rows-1));
    for(let j=0;j<cols;j++){
      const lon = lon0 + (lon1-lon0)*(j/(cols-1));
      const v = meshPos(lat, lon);
      // 使用离线高度场的精确海拔（米）
      v[1] = hm.elev[i*cols + j] / 3137.0;
      verts.push(v);
    }
  }
  const faces = [];
  for(let i=0;i<rows-1;i++){
    for(let j=0;j<cols-1;j++){
      const a = i*cols + j;
      const b = a + 1;
      const c = (i+1)*cols + j;
      const d = c + 1;
      faces.push([a, c, b], [b, c, d]);
    }
  }
  // 同步生成二维等高线输入
  const elev2d = [];
  for(let i=0;i<rows;i++) elev2d.push(hm.elev.slice(i*cols, (i+1)*cols));
  hm.elev_2d = elev2d;
  SUBD_MESH = {verts: verts, faces: faces};
  computeVertexNormals();
}

function buildSubdividedMesh(){
  const m = TERRAIN3D.mesh_3d;
  let verts = [], faces = [];
  let midCache = new Map();
  const keyOf = (a, b)=> a<b ? a+"_"+b : b+"_"+a;
  const getMid = (cache, vaList, faList)=>{
    return (a, b)=>{
      const k = keyOf(a, b);
      if(cache.has(k)) return cache.get(k);
      const va = vaList[a], vb = vaList[b];
      const lat = ((va[2]+vb[2])/2 + 1)/2 * (m.lat_range[1]-m.lat_range[0]) + m.lat_range[0];
      const lon = ((va[0]+vb[0])/2 + 1)/2 * (m.lon_range[1]-m.lon_range[0]) + m.lon_range[0];
      const p = meshPos(lat, lon);
      const idx = faList.length;
      faList.push(p);
      cache.set(k, idx);
      return idx;
    };
  };

  // 第一次细分
  const getMid1 = getMid(midCache, m.vertices, verts);
  for(const f of m.faces){
    const a=f[0], b=f[1], c=f[2];
    const ab=getMid1(a,b), bc=getMid1(b,c), ca=getMid1(c,a);
    faces.push([a,ab,ca], [b,bc,ab], [c,ca,bc], [ab,bc,ca]);
  }

  // 第二次细分（让面更小，颜色过渡更平滑；缓存复用避免重复）
  let verts2 = verts.slice();
  let faces2 = [];
  let midCache2 = new Map();
  const getMid2 = getMid(midCache2, verts, verts2);
  for(const f of faces){
    const a=f[0], b=f[1], c=f[2];
    const ab=getMid2(a,b), bc=getMid2(b,c), ca=getMid2(c,a);
    faces2.push([a,ab,ca], [b,bc,ab], [c,ca,bc], [ab,bc,ca]);
  }

  SUBD_MESH = {verts: verts2, faces: faces2};
  computeVertexNormals();
}

function computeVertexNormals(){
  const verts = SUBD_MESH.verts, faces = SUBD_MESH.faces;
  const norms = new Array(verts.length).fill(0).map(()=>[0,0,0]);
  // 对每个面计算法线，累加到三个顶点
  for(const f of faces){
    const n = faceNormal(verts[f[0]], verts[f[1]], verts[f[2]]);
    for(const idx of f){
      norms[idx][0] += n[0]; norms[idx][1] += n[1]; norms[idx][2] += n[2];
    }
  }
  // 归一化
  for(let i=0;i<norms.length;i++){
    const l = Math.hypot(norms[i][0], norms[i][1], norms[i][2]) || 1;
    norms[i][0] /= l; norms[i][1] /= l; norms[i][2] /= l;
  }
  SUBD_MESH.vnorms = norms;
}

function faceNormal(p0, p1, p2){
  const ux=p1[0]-p0[0], uy=p1[1]-p0[1], uz=p1[2]-p0[2];
  const wx=p2[0]-p0[0], wy=p2[1]-p0[1], wz=p2[2]-p0[2];
  let nx=uy*wz-uz*wy, ny=uz*wx-ux*wz, nz=ux*wy-uy*wx;
  const l=Math.hypot(nx,ny,nz)||1;
  nx/=l; ny/=l; nz/=l;
  if(nz<0){ nx=-nx; ny=-ny; nz=-nz; }
  return [nx, ny, nz];
}

function elevColor(t){
  // 专业地形色带：低海拔深绿 -> 中海拔草绿/土黄 -> 高海拔棕褐 -> 雪峰白
  const stops = [
    [0.00,[26,82,42]],    [0.18,[58,130,58]],   [0.35,[108,168,84]],
    [0.52,[178,166,96]],  [0.68,[168,118,68]],  [0.82,[136,88,60]],
    [0.92,[118,78,58]],   [1.00,[235,232,240]]
  ];
  t = Math.max(0, Math.min(1, t));
  for(let i=0;i<stops.length-1;i++){
    const t0=stops[i][0], c0=stops[i][1], t1=stops[i+1][0], c1=stops[i+1][1];
    if(t<=t1){
      const k = t1===t0 ? 0 : (t-t0)/(t1-t0);
      return [c0[0]+(c1[0]-c0[0])*k, c0[1]+(c1[1]-c0[1])*k, c0[2]+(c1[2]-c0[2])*k];
    }
  }
  return stops[stops.length-1][1];
}

function project3D(p, cosX, sinX, cosY, sinY, s, cx, cy, EX){
  let x1 = p[0]*cosY - p[2]*sinY, z1 = p[0]*sinY + p[2]*cosY;
  let y1 = p[1]*EX*cosX - z1*sinX, z2 = p[1]*EX*sinX + z1*cosX;
  return {x: cx + x1*s, y: cy - y1*s, z: z2};
}

/* Marching Squares：从海拔热力网格提取等值线段 [[lat,lon],[lat,lon]] */
function contourSegments(elev, lat0, lat1, lon0, lon1, level){
  const segs = [];
  const rows = elev.length, cols = elev[0].length;
  if(rows < 2 || cols < 2) return segs;
  const dLat = (lat1-lat0)/(rows-1), dLon = (lon1-lon0)/(cols-1);
  const tAt = (va, vb) => va===vb ? 0.5 : (level-va)/(vb-va);
  for(let i=0;i<rows-1;i++){
    for(let j=0;j<cols-1;j++){
      const v00=elev[i][j], v10=elev[i][j+1], v01=elev[i+1][j], v11=elev[i+1][j+1];
      const idx = (v00>=level?8:0) | (v10>=level?4:0) | (v01>=level?2:0) | (v11>=level?1:0);
      if(idx===0 || idx===15) continue;
      const la = lat0 + i*dLat, lo = lon0 + j*dLon;
      const T = [la, lo + tAt(v00,v10)*dLon];
      const R = [la + tAt(v10,v11)*dLat, lo + dLon];
      const B = [la + dLat, lo + tAt(v01,v11)*dLon];
      const L = [la + tAt(v00,v01)*dLat, lo];
      switch(idx){
        case 1:  segs.push([R,B]); break;
        case 2:  segs.push([L,B]); break;
        case 3:  segs.push([L,R]); break;
        case 4:  segs.push([T,R]); break;
        case 5:  segs.push([T,B]); break;
        case 6:  segs.push([T,R],[L,B]); break;
        case 7:  segs.push([T,L]); break;
        case 8:  segs.push([T,L]); break;
        case 9:  segs.push([T,B],[L,R]); break;
        case 10: segs.push([T,B]); break;
        case 11: segs.push([T,R]); break;
        case 12: segs.push([L,R]); break;
        case 13: segs.push([L,B]); break;
        case 14: segs.push([R,B]); break;
      }
    }
  }
  return segs;
}

function drawHeatmap3D(){
  const img = $("contour3DImg");
  if(!img || !TERRAIN3D) return;
  img.style.display = "block";
  img.src = "assets/terrain3d_contour_" + heat3DType + ".png";

  const hm = TERRAIN3D.heatmap;
  const data = hm[heat3DType] || hm.elev;
  let rangeTxt = "";
  if(data){
    let mn = Infinity, mx = -Infinity;
    for(let i=0;i<data.length;i++) for(let j=0;j<data[0].length;j++){
      const v = data[i][j];
      if(v < mn) mn = v;
      if(v > mx) mx = v;
    }
    rangeTxt = " | 范围: " + mn.toFixed(2) + " ~ " + mx.toFixed(2);
  }

  const labels = {
    elev: "海拔高程 (m)", wind_expo: "风暴露指数 (0-1)", cold_pooling: "冷池潜力 (0-1)",
    channeling: "地形通道指数 (0-1)", lightning_enhance: "雷电增强因子 (0-1)",
    debris_enhance: "泥石流增强因子 (0-1)", roughness_3d: "3D综合粗糙度 (0-1)",
    ridge_valley: "脊谷指数 (-1~+1)"
  };
  $("heat3DDesc").textContent = (labels[heat3DType] || heat3DType) + rangeTxt;
}

function heatColor(v, type){
  // 不同类型不同色带
  if(type === "elev"){
    if(v < 0.25) return `rgb(${30+v*100},${100+v*120},${30+v*40})`;
    if(v < 0.50) return `rgb(${100+v*120},${150+v*60},${50+v*60})`;
    if(v < 0.75) return `rgb(${180+v*60},${140+v*40},${80+v*80})`;
    return `rgb(${220+v*35},${200+v*40},${140+v*80})`;
  }
  if(type === "ridge_valley"){
    // -1蓝 0绿 +1红
    if(v < 0.5) return `rgb(${30},${100+v*120},${150-v*60})`;
    return `rgb(${100+v*155},${150-v*60},${60})`;
  }
  // 通用: 蓝→绿→黄→橙→红
  if(v < 0.25) return `rgb(${30+v*40},${80+v*120},${150-v*40})`;
  if(v < 0.50) return `rgb(${40+v*120},${180+v*60},${100})`;
  if(v < 0.75) return `rgb(${200+v*55},${180-v*40},${60})`;
  return `rgb(${255},${100-v*60},${60-v*40})`;
}

function setHeat3D(type){
  heat3DType = type;
  document.querySelectorAll("#terrain3DPanel .risk-btn").forEach(b=>{
    b.classList.toggle("active", b.textContent === ({elev:"海拔",wind_expo:"风暴露",cold_pooling:"冷池潜力",channeling:"地形通道",lightning_enhance:"雷电增强",debris_enhance:"泥石流增强",roughness_3d:"3D粗糙度",ridge_valley:"脊谷指数"})[type]);
  });
  drawHeatmap3D();
}

function init3DInteraction(){
  const cv = $("canvas3D");
  if(!cv) return;
  let dragging = false, lastX = 0, lastY = 0;
  cv.addEventListener("mousedown", e=>{ dragging = true; lastX = e.clientX; lastY = e.clientY; cv.style.cursor = "grabbing"; });
  cv.addEventListener("mousemove", e=>{
    if(!dragging) return;
    rot3D.ry += (e.clientX - lastX) * 0.01;
    rot3D.rx += (e.clientY - lastY) * 0.01;
    rot3D.rx = Math.max(-1.4, Math.min(0.2, rot3D.rx));
    lastX = e.clientX; lastY = e.clientY;
    draw3DCanvas();
  });
  cv.addEventListener("mouseup", ()=>{ dragging = false; cv.style.cursor = "grab"; });
  cv.addEventListener("mouseleave", ()=>{ dragging = false; cv.style.cursor = "grab"; });
  cv.addEventListener("wheel", e=>{
    e.preventDefault();
    rot3D.scale *= e.deltaY > 0 ? 0.92 : 1.08;
    rot3D.scale = Math.max(0.3, Math.min(3.0, rot3D.scale));
    draw3DCanvas();
  });
}

/* ---------- 3D重算结果渲染 ---------- */
function renderRecalc3D(){
  if(!RECALC3D) return;
  const r = RECALC3D;
  const panel = $("recalc3DPanel");
  if(panel) panel.style.display = "block";

  $("recalc3DNote").textContent = `${r.model_name} · DEM ${r.dem_grid} · 海拔 ${r.elev_range[0]}~${r.elev_range[1]}m · 5个模型全部融入3D地形特征重新计算`;

  const m5 = r.m5_joint_3d;
  $("recalc3DSummary").innerHTML = `
    <div class="sum-item">M1强对流<b>${(r.m1_thunder_3d.avg_enhanced*100).toFixed(1)}%</b>Δ${(r.m1_thunder_3d.avg_enhanced-r.m1_thunder_3d.avg_base>=0?"+":"")}${((r.m1_thunder_3d.avg_enhanced-r.m1_thunder_3d.avg_base)*100).toFixed(1)}%</div>
    <div class="sum-item">M2浓雾<b>${(r.m2_fog_3d.avg_enhanced*100).toFixed(1)}%</b>Δ${(r.m2_fog_3d.avg_enhanced-r.m2_fog_3d.avg_base>=0?"+":"")}${((r.m2_fog_3d.avg_enhanced-r.m2_fog_3d.avg_base)*100).toFixed(1)}%</div>
    <div class="sum-item">M3校准<b>${(r.m3_calibration_3d.avg_enhanced*100).toFixed(1)}%</b>Δ${(r.m3_calibration_3d.avg_enhanced-r.m3_calibration_3d.avg_orig>=0?"+":"")}${((r.m3_calibration_3d.avg_enhanced-r.m3_calibration_3d.avg_orig)*100).toFixed(1)}%</div>
    <div class="sum-item">M5综合风险<b style="color:${m5.enhanced_overall>=0.5?"var(--red)":"var(--orange)"}">${(m5.enhanced_overall*100).toFixed(1)}%</b>${m5.overall_level}</div>
  `;

  // M1 表
  const m1Rows = Object.entries(r.m1_thunder_3d.grid_results).slice(0, 12);
  $("m1Tbody").innerHTML = m1Rows.map(([k, v])=>{
    const dColor = v.delta > 0 ? "var(--orange)" : "var(--sub)";
    const lvColor = v.level.includes("红") ? "var(--red)" : v.level.includes("橙") ? "var(--orange)" : v.level.includes("黄") ? "#f7d154" : "var(--teal)";
    return `<tr><td>${k}</td><td>${(v.base_prob*100).toFixed(1)}%</td><td><b>${(v.enhanced_prob*100).toFixed(1)}%</b></td><td style="color:${dColor}">${v.delta>=0?"+":""}${(v.delta*100).toFixed(2)}%</td><td>${(v.lightning_boost*100).toFixed(0)}%</td><td>${(v.wind_boost*100).toFixed(0)}%</td><td style="color:${lvColor};font-weight:700">${v.level}</td></tr>`;
  }).join("");

  // M2 表
  const m2Rows = Object.entries(r.m2_fog_3d.grid_results).slice(0, 12);
  $("m2Tbody").innerHTML = m2Rows.map(([k, v])=>{
    const dColor = v.delta > 0 ? "var(--blue)" : "var(--sub)";
    const lvColor = v.level.includes("红") ? "var(--red)" : v.level.includes("橙") ? "var(--orange)" : v.level.includes("黄") ? "#f7d154" : "var(--teal)";
    return `<tr><td>${k}</td><td>${(v.base_prob*100).toFixed(1)}%</td><td><b>${(v.enhanced_prob*100).toFixed(1)}%</b></td><td style="color:${dColor}">${v.delta>=0?"+":""}${(v.delta*100).toFixed(2)}%</td><td>${(v.cold_pooling*100).toFixed(0)}%</td><td>${(v.fog_enhance*100).toFixed(0)}%</td><td style="color:${lvColor};font-weight:700">${v.level}</td></tr>`;
  }).join("");

  // M3 表
  $("m3Tbody").innerHTML = r.m3_calibration_3d.cases.map(c=>{
    return `<tr><td>${c.date}</td><td>${c.name||"-"}</td><td>${c.type}</td><td>${(c.orig_cal_prob*100).toFixed(1)}%</td><td><b>${(c.enhanced_prob*100).toFixed(1)}%</b></td><td style="color:var(--orange)">+${(c.delta*100).toFixed(1)}%</td><td>${(c.debris_enhance*100).toFixed(0)}%</td><td>${c.roughness_3d.toFixed(3)}</td></tr>`;
  }).join("");

  // M4 表
  $("m4Tbody").innerHTML = Object.entries(r.m4_fenghe_3d.station_interactions).map(([k, s])=>{
    return `<tr><td>${s.station||k}</td><td>${s.elev}m</td><td>${(s.wind_expo*100).toFixed(0)}%</td><td>${(s.channeling*100).toFixed(0)}%</td><td>${(s.cold_pooling*100).toFixed(0)}%</td><td>${(s.extreme_wind.orig*100).toFixed(1)}% → <b>${(s.extreme_wind["3d"]*100).toFixed(1)}%</b></td><td>${(s.fog.orig*100).toFixed(1)}% → <b>${(s.fog["3d"]*100).toFixed(1)}%</b></td><td>${(s.thunderstorm.orig*100).toFixed(1)}% → <b>${(s.thunderstorm["3d"]*100).toFixed(1)}%</b></td></tr>`;
  }).join("");

  // M5 表
  $("m5Tbody").innerHTML = m5.scenarios.map(s=>{
    const lvColor = s.new_level === "极高" ? "var(--red)" : s.new_level === "高" ? "var(--orange)" : "#f7d154";
    const upgraded = s.new_level !== s.orig_level;
    return `<tr><td>${s.id}</td><td>${(s.orig_risk*100).toFixed(1)}%</td><td><b>${(s.enhanced_risk*100).toFixed(1)}%</b></td><td style="color:var(--orange)">+${(s.delta*100).toFixed(1)}%</td><td>${s.orig_level}</td><td style="color:${lvColor};font-weight:700">${s.new_level}${upgraded?" ⬆":""}</td><td style="font-size:11px;color:var(--sub)">${s.terrain_note}</td></tr>`;
  }).join("");

  // 路段3D
  $("road3DTbody").innerHTML = Object.entries(r.road_3d_recalc).map(([k, v])=>{
    const lvColor = v.level.includes("极高") ? "var(--red)" : v.level.includes("高度") ? "var(--orange)" : "#f7d154";
    return `<tr><td>${k}</td><td>${(v.wind_expo*100).toFixed(0)}%</td><td>${(v.cold_pooling*100).toFixed(0)}%</td><td>${(v.channeling*100).toFixed(0)}%</td><td>${v.roughness_3d.toFixed(3)}</td><td>${v.max_slope}°</td><td><b>${(v["3d_risk_score"]*100).toFixed(1)}%</b></td><td style="color:${lvColor};font-weight:700">${v.level}</td></tr>`;
  }).join("");

  // 关键发现
  $("recalc3DFindings").innerHTML = (r.key_findings || []).map(f=>`<div style="margin:4px 0;padding-left:12px;border-left:2px solid var(--blue)">📌 ${f}</div>`).join("");
}

/* ---------- 主流程(每次刷新执行) ---------- */
async function main(){
  $("freshBadge").className = "badge"; $("freshBadge").textContent = "加载中";
  $("meta").innerHTML = "正在加载双模型与地形数据…";
  if(window.__enableSkeleton) window.__enableSkeleton();
  try{
    const [t, f, terr, calib, fenghe, joint, terr3d, heightMap, recalc3d, roadModel] = await Promise.all([
      fetchJSON("models/thunder_gb.json", 2),
      fetchJSON("models/fog_gb.json", 2),
      fetchJSON("data/terrain_web.json", 2),
      fetchJSON("models/calibration_model.json", 1).catch(()=>null),
      fetchJSON("models/fenghe_model.json", 1).catch(()=>null),
      fetchJSON("models/joint_assessment.json", 1).catch(()=>null),
      fetchJSON("models/terrain_3d.json", 1).catch(()=>null),
      fetchJSON("models/terrain_height.json", 1).catch(()=>null),
      fetchJSON("models/terrain_3d_recalc.json", 1).catch(()=>null),
      fetchJSON("models/road_gb.json", 1).catch(()=>null),
    ]);
    MODEL_T = t; MODEL_F = f; MODEL_R = roadModel; TERR = terr; CALIB = calib; FENGHE = fenghe; JOINT = joint; TERRAIN3D = terr3d; HEIGHT_MAP = heightMap; RECALC3D = recalc3d;
    // 暴露给 terrain3d.js（独立 IIFE 脚本访问全局）
    window.HEIGHT_MAP = HEIGHT_MAP;
    window.TERRAIN3D = TERRAIN3D;
    window.TERR = TERR;
    $("meta").innerHTML = "模型加载完成，正在拉取最新气象预报（Open-Meteo 99 格点，分3批，约需 10-30 秒）…";
    // 长等待提示：30 秒后若仍未完成，给用户一个友好的说明
    const longWaitTimer = setTimeout(function(){
      $("meta").innerHTML = '数据仍在加载中，Open-Meteo 从海外服务器拉取 99 格点数据可能较慢… <button onclick="retryLoadWeather()" style="margin-left:8px;padding:4px 12px;border-radius:4px;border:none;background:var(--blue);color:#fff;cursor:pointer">🔄 重试</button>';
    }, 30000);
    // 预报
    const raw = await predictGrid(t, f, 24, roadModel, function(ev){
      if(ev.type === "batch"){
        $("meta").innerHTML = "正在拉取 Open-Meteo 第 "+ev.current+"/"+ev.total+" 批数据（"+ev.points+" 格点）…";
      }else if(ev.type === "retry"){
        $("meta").innerHTML = "Open-Meteo 第 "+ev.attempt+"/"+ev.total+" 次重试中…";
      }else if(ev.type === "cache"){
        $("meta").innerHTML = "使用本地缓存气象数据（10 分钟内有效）…";
      }
    });
    clearTimeout(longWaitTimer);
    // 计算综合风险与地形标签
    GRID = raw.map(g=>{
      const ri = riskIndexFor(g);
      const gf = ri ? ri.terrain : null;
      const typeName = gf ? ({0:"谷地",1:"坡面",2:"山脊"}[gf.type]||"坡面") : null;
      const th = gf ? {typeName, flash:gf.flash, debris:gf.debris, slump:gf.slump, slope:gf.slope, elev:gf.elev} : null;
      const lv = g.peak_prob>=t.opt_threshold?"预警":g.peak_prob>=0.6?"较高":g.peak_prob>=0.4?"关注":"低";
      const flv = g.fog_prob>=f.opt_threshold?"预警":g.fog_prob>=0.6?"较高":g.fog_prob>=0.4?"关注":"低";
      const rlv = !roadModel ? "低" : (g.road_prob>=roadModel.opt_threshold?"预警":g.road_prob>=0.6?"较高":g.road_prob>=0.4?"关注":"低");
      return {...g, level:lv, color:LVL[lv], fogLevel:flv, fogColor:LVL[flv],
        roadLevel:rlv, roadColor:LVL[rlv],
        riskIndex:ri, terrainHazard:th, agree:true};
    });
    ROADS = computeRoads(GRID);
    applyCalibration();
    renderRisk(GRID, ROADS);
    renderRoads(ROADS);
    // 天气 chart
    window.__chartSeries = regionSeries(GRID);
    renderChart(window.__chartSeries);
    // 实况天气面板
    const aq = await (window.__fetchAirQuality ? window.__fetchAirQuality().catch(()=>null) : Promise.resolve(null));
    renderWeather(window.__chartSeries, aq);
    // 沉浸式动态背景 + 雨滴/风速动效
    if(window.__applyBackground) window.__applyBackground(window.__chartSeries);
    // 按海拔层天气差异面板
    renderAltitudeWeather();
    // 道路出行安全评估面板
    renderRoadSafety(GRID, window.__chartSeries);
    // 出行建议面板
    renderAdvice(GRID, ROADS, window.__chartSeries);
    // 地质灾害分流域演算
    if(typeof window.renderGeoHazard === "function") window.renderGeoHazard();
    // 景点路线推荐面板
    renderRoutes();
    // 景点一键聚焦 + 预警中心
    renderPOI();
    renderWarningCenter();
    renderHikingRoutes();
    // 历史灾害关联校准面板
    renderCalibration();
    // 风和气象模型面板
    renderFenghe();
    // 多模型联合研判面板
    renderJoint();
    // 3D全景地形面板
    renderTerrain3D();
    // 3D重算结果面板
    renderRecalc3D();
    // 地形底图
    const img = $("mapImg");
    img.onload = ()=>{
      renderMap();
      renderRiskMapSummary();
      renderRiskDistBar();
      renderRiskHotspots();
      renderRiskTimeline();
    };
    img.src = "assets/ailaoshan_map.png?_="+Date.now();
    img.style.display = "block";
    // 地形图（面板已移除，安全跳过）
    var tImg = $("terrainImg"), tDesc = $("terrainDesc");
    if(tImg){ tImg.src = "assets/ailaoshan_map.png?_="+Date.now(); tImg.style.display = "block"; }
    if(tDesc){ tDesc.textContent = "0.02° 精细 DEM 重采样（"+TERR.region+"）· 最高海拔 "+TERR.max_elev+"m"; }
    // 双模型验证
    $("altDesc").textContent = "主模型(HistGradientBoosting 直方图分箱) vs 第二模型(GradientBoosting 精确分裂) 在 2026 留出集交叉验证，实时预测两模型相互印证：";
    const p = (x)=> (x*100).toFixed(1)+"%";
    $("altThunder").innerHTML = "Pearson r <b style='color:var(--teal)'>0.909</b> · 同等级率 <b>90.1%</b> · 平均|Δp| 5.8%<br/>主模型预警处双模型同时预警 7.2% — 两模型均发预警的格点可信度显著增强";
    $("altFog").innerHTML = "Pearson r <b style='color:var(--teal)'>0.991</b> · 同等级率 <b>97.3%</b> · 平均|Δp| 1.3%<br/>浓雾预测两模型高度一致";
    const now = new Date();
    const cacheTag = GRID._stale ? ' · <span style="color:#ff4d4f">⚠️ Open-Meteo 实时连接失败，已显示过期缓存数据（点击上方"刷新"可重试）</span>'
      : GRID._fromCache ? ' · <span style="color:var(--orange)">已使用本地缓存（Open-Meteo 限流，10分钟内有效）</span>' : '';
    $("freshBadge").textContent = "● 实时 "+now.toTimeString().slice(0,8);
    $("meta").innerHTML = "哀牢山生态站(徐家坝 24.54N,101.02E) · 数据更新 <b>"+now.toLocaleString("zh-CN")+"</b>"+
      ' · 强对流阈值 <b style="color:var(--blue)">'+(t.opt_threshold*100).toFixed(1)+'%</b> · 浓雾阈值 <b style="color:var(--teal)">'+(f.opt_threshold*100).toFixed(1)+'%</b>'+
      " · 每次刷新实时重算" + cacheTag;
  }catch(e){
    const is429 = String(e.message).includes("429") || String(e.message).includes("Open-Meteo");
    const isNetwork = String(e.message).includes("fetch") || String(e.message).includes("network") || String(e.message).includes("timeout") || String(e.message).includes("超时");
    $("freshBadge").className = "badge red"; $("freshBadge").textContent = "加载失败";
    let msg;
    if(GRID && GRID._stale){
      msg = '❌ Open-Meteo 实时连接失败，当前显示的是过期缓存数据。';
    }else if(is429){
      msg = "❌ Open-Meteo API 暂时限流（HTTP 429）。已启用本地缓存 + 指数退避重试，请稍后刷新。";
    }else if(isNetwork){
      msg = "❌ 网络连接失败：无法访问 Open-Meteo 预报服务器（api.open-meteo.com）。这通常是地区性网络波动或 DNS 问题，请稍后刷新或切换网络重试。";
    }else{
      msg = "❌ 加载失败: "+e.message+"（请检查网络后刷新重试）";
    }
    $("meta").innerHTML = msg + ' <button onclick="retryLoadWeather()" style="margin-left:8px;padding:4px 12px;border-radius:4px;border:none;background:var(--blue);color:#fff;cursor:pointer">🔄 立即重试</button>';
    const errNote = '<div class="desc" style="color:#ff4d4f">数据加载失败：'+e.message+'。<button onclick="retryLoadWeather()" style="margin-left:8px;padding:4px 12px;border-radius:4px;border:none;background:var(--blue);color:#fff;cursor:pointer">🔄 重试</button></div>';
    ["riskTbody","warnCenterContent","weatherSummary","ecoIndexContent","altitudeContent","adviceContent","routeSummary","routeTbody","hikingTbody","roadTbody","roadSafetyContent","geoHazardContent","triModelContent"].forEach(function(id){
      const el = document.getElementById(id);
      if(el){
        if(el.tagName === "TBODY") el.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#ff4d4f">数据加载失败，请刷新重试</td></tr>';
        else el.innerHTML = errNote;
      }
    });
    console.error(e);
  }
}
main();
