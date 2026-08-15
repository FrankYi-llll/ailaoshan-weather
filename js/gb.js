/* =====================================================================
 * gb.js — 哀牢山双模型浏览器端推理引擎
 * 复刻 Python 侧 (build_alt_model.py / live_warning.engineer_features):
 *   1. 特征工程(21特征, 与训练完全一致)
 *   2. GradientBoosting 树推理 (init_log_odds + Σ lr·leaf)
 *   3. sigmoid → 原始概率 → 等渗校准 → 主模型尺度概率
 * 供 index.html 直接使用, 无需任何后端。
 * ===================================================================== */
"use strict";

/* ---------- 常量: 网格定义(覆盖全图 23.90~24.70N × 100.90~101.90E) ---------- */
const GRID_LATS = [23.90,24.00,24.10,24.20,24.30,24.40,24.50,24.60,24.70];
const GRID_LONS = [100.90,101.00,101.10,101.20,101.30,101.40,101.50,101.60,101.70,101.80,101.90];
function gridPoints(){
  const pts = [];
  for(const la of GRID_LATS) for(const lo of GRID_LONS) pts.push({lat:la, lon:lo});
  return pts; // 99 点
}

/* ---------- 站点静态地形特征(mid 山腰站, 与训练一致) ----------
 * 由构建脚本生成 js/site.js 定义全局 DEM_ATTRS, 本文件不声明。
 */

/* ---------- 工具 ---------- */
function sigmoid(z){ return 1/(1+Math.exp(-z)); }
function interp1d(xs, ys, x){
  // 分段线性插值(np.interp), 越界取端点值(out_of_bounds=clip)
  if(x <= xs[0]) return ys[0];
  if(x >= xs[xs.length-1]) return ys[ys.length-1];
  let lo=0, hi=xs.length-1;
  while(hi-lo>1){ const mid=(lo+hi)>>1; if(xs[mid]<=x) lo=mid; else hi=mid; }
  const t=(x-xs[lo])/(xs[hi]-xs[lo]||1e-12);
  return ys[lo]+t*(ys[hi]-ys[lo]);
}

/* ---------- 单树推理(tree: {feature,threshold,left,right,value}, x: Float64Array) ---------- */
function predictTree(tree, x){
  let node = 0;
  const feat = tree.feature, thr = tree.threshold;
  while(feat[node] !== -2){
    node = (x[feat[node]] <= thr[node]) ? tree.left[node] : tree.right[node];
  }
  return tree.value[node];
}

/* ---------- 整模型推理: 返回 [校准后概率, 原始概率] ---------- */
function predictProb(model, x){
  let raw = model.init_log_odds || 0;
  const lr = model.learning_rate || 0.05;
  for(const t of model.trees) raw += lr * predictTree(t, x);
  const pRaw = sigmoid(raw);
  const cal = model.calibration;
  if(cal && cal.x && cal.x.length) return [interp1d(cal.x, cal.y, pRaw), pRaw];
  return [pRaw, pRaw];
}

/* ---------- 等级分级(与本地版 level() 一致) ---------- */
function levelOf(p, thr){
  if(p >= thr) return {name:"预警", color:"#ff4d4f", code:3};
  if(p >= 0.6) return {name:"较高", color:"#ff9f43", code:2};
  if(p >= 0.4) return {name:"关注", color:"#f7d154", code:1};
  return {name:"低", color:"#2ecc71", code:0};
}

/* ---------- 特征工程: 21 特征(与 live_warning.engineer_features 一致) ----------
 * rows: [{temp, rh, press, cloud, ws, wg, dew, precip, sm7, sm28, hour}] 逐小时数组
 * 返回 Float64Array[21] 特征向量(按 features 列表顺序)
 * elevation_m: 标称海拔(与训练一致), dem_elevation_m: API 真实高程
 */
function buildFeatures(rows, elevation_m, demElev){
  const n = rows.length;
  const feat = new Float64Array(21);
  // 气象变量取"未来整体"的统计: 逐小时遍历累加(近似: 使用每行特征, 但树模型需要单行特征)
  // 说明: 训练时每个小时一行特征; 这里用"逐小时推理"更准确, 由调用方循环调用本函数一次/小时。
  // 因此本函数按"最后一行=目标小时"设计: 传入 rows 为 [0..t] 的历史+当前, 取最后一行计算。
  const r = rows[rows.length-1];
  const h = r.hour;
  const v = new Float64Array(21);
  const set = (name, val) => { const i = FEAT_IDX[name]; if(i!==undefined) v[i]=val; };
  set("temp", r.temp);
  set("rh", r.rh);
  set("press", r.press);
  set("cloud", r.cloud);
  set("ws", r.ws);
  set("wg", r.wg);
  set("tdew_diff", r.temp - r.dew);
  // press_drop3h: 当前气压 - 3 小时前气压(不足 3h 用第一个可用值)
  const p0 = rows.length>3 ? rows[rows.length-4].press : rows[0].press;
  set("press_drop3h", r.press - p0);
  // precip_3h: 当前与之前 2 小时降水之和(不足则累加可用)
  let sum3 = 0, cnt = 0;
  for(let k=rows.length-1; k>=0 && cnt<3; k--){ sum3 += rows[k].precip; cnt++; }
  set("precip_3h", sum3);
  set("sm_7cm", r.sm7);
  set("sm_28cm", r.sm28);
  set("hour_sin", Math.sin(2*Math.PI*h/24));
  set("hour_cos", Math.cos(2*Math.PI*h/24));
  set("elevation_m", elevation_m);
  set("slope_deg", DEM_ATTRS.slope_deg);
  set("tpi", DEM_ATTRS.tpi);
  set("dist_valley", DEM_ATTRS.dist_valley);
  set("max_slope_3km", DEM_ATTRS.max_slope_3km);
  set("elev_range_10km", DEM_ATTRS.elev_range_10km);
  set("dem_elevation_m", demElev);
  set("region_code", 1);
  return v;
}
/* 特征名->下标 */
let FEAT_IDX = {};
function setFeaturesOrder(features){
  FEAT_IDX = {};
  features.forEach((f,i)=>FEAT_IDX[f]=i);
}

/* ---------- 道路安全模型特征工程 (17 特征) ----------
 * 与 build_road_model.py 训练时完全一致
 * 新增: is_day(昼夜), shortwave_rad(短波辐射), precip_1h(当前降水)
 */
let ROAD_FEAT_IDX = {};
function setRoadFeaturesOrder(features){
  ROAD_FEAT_IDX = {};
  features.forEach((f,i)=>ROAD_FEAT_IDX[f]=i);
}
function buildRoadFeatures(rows, elevation_m){
  const r = rows[rows.length-1];
  const h = r.hour;
  const v = new Float64Array(17);
  const set = (name, val) => { const i = ROAD_FEAT_IDX[name]; if(i!==undefined) v[i]=val; };
  // is_day: 优先用 API 值，否则按小时估算 (7-19 为白天)
  set("is_day", r.isDay != null ? r.isDay : (h >= 7 && h <= 19 ? 1 : 0));
  // shortwave_rad: 优先用 API 值，否则按小时+云量估算
  set("shortwave_rad", r.rad != null ? r.rad : 0);
  set("temp", r.temp);
  set("rh", r.rh);
  set("press", r.press);
  set("cloud", r.cloud);
  set("ws", r.ws);
  set("wg", r.wg);
  set("tdew_diff", r.temp - r.dew);
  const p0 = rows.length>3 ? rows[rows.length-4].press : rows[0].press;
  set("press_drop3h", r.press - p0);
  let sum3 = 0, cnt = 0;
  for(let k=rows.length-1; k>=0 && cnt<3; k--){ sum3 += rows[k].precip; cnt++; }
  set("precip_3h", sum3);
  set("precip_1h", r.precip);
  set("hour_sin", Math.sin(2*Math.PI*h/24));
  set("hour_cos", Math.cos(2*Math.PI*h/24));
  set("elevation_m", elevation_m);
  set("sm_7cm", r.sm7);
  set("sm_28cm", r.sm28);
  return v;
}

/* ---------- 拉取 Open-Meteo 99 格点逐小时预报(分3批, 每批33点) ---------- */
const OM = "https://api.open-meteo.com/v1/forecast";
const OM_CACHE_KEY = "ailaoshan_om_cache_v2";
const OM_CACHE_TTL = 10 * 60 * 1000;

function getOMCache(){
  try{
    const s = localStorage.getItem(OM_CACHE_KEY);
    if(!s) return null;
    const o = JSON.parse(s);
    if(Date.now() - o.ts > OM_CACHE_TTL) return null;
    return o.data;
  }catch(e){ return null; }
}
function setOMCache(data){
  try{ localStorage.setItem(OM_CACHE_KEY, JSON.stringify({ts:Date.now(), data})); }catch(e){}
}

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

async function fetchOneBatch(pts, retries){
  const params = new URLSearchParams({
    latitude: pts.map(p=>p.lat).join(","),
    longitude: pts.map(p=>p.lon).join(","),
    hourly: "temperature_2m,relative_humidity_2m,surface_pressure,cloud_cover,wind_speed_10m,wind_gusts_10m,precipitation,dew_point_2m,soil_moisture_0_to_7cm,soil_moisture_7_to_28cm,visibility,is_day,shortwave_radiation,uv_index",
    forecast_days: "3",
    past_days: "0",
    timezone: "Asia/Shanghai",
  });
  const url = OM + "?" + params.toString();
  let lastErr;
  for(let attempt=0; attempt<retries; attempt++){
    try{
      if(attempt>0) await sleep((Math.pow(2, attempt) + Math.random()) * 1000);
      const resp = await fetch(url, {cache:"no-store"});
      if(!resp.ok){
        lastErr = new Error("Open-Meteo HTTP " + resp.status);
        if(resp.status === 429) continue;
        throw lastErr;
      }
      const j = await resp.json();
      return j.map((g,i)=>({
        lat: pts[i].lat, lon: pts[i].lon,
        elev: g.elevation || 0,
        hourly: g.hourly.time.map((t,k)=>({
          time: t, hour: new Date(t.replace(" ","T")+":00").getHours(),
          temp: g.hourly.temperature_2m[k],
          rh: g.hourly.relative_humidity_2m[k],
          press: g.hourly.surface_pressure[k],
          cloud: g.hourly.cloud_cover[k],
          ws: g.hourly.wind_speed_10m[k],
          wg: g.hourly.wind_gusts_10m[k],
          precip: g.hourly.precipitation[k],
          dew: g.hourly.dew_point_2m[k],
          sm7: g.hourly.soil_moisture_0_to_7cm[k],
          sm28: g.hourly.soil_moisture_7_to_28cm[k],
          vis: g.hourly.visibility ? g.hourly.visibility[k] : null,
          isDay: g.hourly.is_day ? g.hourly.is_day[k] : null,
          rad: g.hourly.shortwave_radiation ? g.hourly.shortwave_radiation[k] : 0,
          uv: g.hourly.uv_index ? g.hourly.uv_index[k] : null,
        })),
      }));
    }catch(e){ lastErr = e; }
  }
  throw lastErr || new Error("批次请求失败");
}

async function fetchAllGrid(hours){
  const cached = getOMCache();
  if(cached){ cached._fromCache = true; return cached; }

  try{
    const pts = gridPoints();
    // 分3批: 每3行一批 (33点 × 3批)
    const batchSize = 33;
    const batches = [];
    for(let i=0; i<pts.length; i+=batchSize){
      batches.push(pts.slice(i, i+batchSize));
    }
    const results = [];
    for(let b=0; b<batches.length; b++){
      // 批间间隔 500ms 避免短时间并发
      if(b>0) await sleep(500);
      const batchResult = await fetchOneBatch(batches[b], 3);
      results.push(...batchResult);
    }
    setOMCache(results);
    return results;
  }catch(e){
    // 网络失败时回退到过期缓存（如果有的话），至少能展示旧数据
    const stale = getOMCacheAny();
    if(stale){
      stale._fromCache = true;
      stale._stale = true;
      return stale;
    }
    throw e;
  }
}

function getOMCacheAny(){
  try{
    const s = localStorage.getItem(OM_CACHE_KEY);
    if(!s) return null;
    return JSON.parse(s).data;
  }catch(e){ return null; }
}

/* 供页面调用的手动重试入口 */
window.retryLoadWeather = async function(){
  try{
    const badge = document.getElementById("freshBadge");
    if(badge){ badge.className = "badge"; badge.textContent = "刷新中…"; }
    await main();
  }catch(e){
    console.error(e);
    alert("刷新失败：" + e.message);
  }
};

/* ---------- 逐格点双模型推理 ---------- */
async function predictGrid(modelT, modelF, hours=24, modelR){
  setFeaturesOrder(modelT.features);
  if(modelR) setRoadFeaturesOrder(modelR.features);
  const raw = await fetchAllGrid(hours);
  const now = new Date();
  const nowIso = localHourKey(now);
  const mapped = raw.map(g=>{
    const rows = g.hourly;
    const fut = rows.filter(r=>r.time >= nowIso).slice(0, hours);
    let pk={p:0,t:null}, fpk={p:0,t:null}, rpk={p:0,t:null};
    const series = [];
    for(let i=0;i<fut.length;i++){
      const ctx = rows.slice(0, rows.indexOf(fut[i])+1);
      const x = buildFeatures(ctx, 2450, g.elev);
      const [p] = predictProb(modelT, x);
      const [fp] = predictProb(modelF, x);
      let rp = 0;
      if(modelR){
        const xr = buildRoadFeatures(ctx, 2450);
        const [rpCal] = predictProb(modelR, xr);
        rp = rpCal;
      }
      if(p>pk.p){pk={p:p,t:fut[i].time};}
      if(fp>fpk.p){fpk={p:fp,t:fut[i].time};}
      if(rp>rpk.p){rpk={p:rp,t:fut[i].time};}
      series.push({
        t:fut[i].time,
        p:Math.round(p*10000)/10000, f:Math.round(fp*10000)/10000,
        r:Math.round(rp*10000)/10000,
        temp:fut[i].temp, rh:fut[i].rh, precip:fut[i].precip, cloud:fut[i].cloud,
        ws:fut[i].ws, wg:fut[i].wg,
        vis:fut[i].vis, isDay:fut[i].isDay, rad:fut[i].rad
      });
    }
    return {
      lat:g.lat, lon:g.lon, elev:g.elev,
      peak_prob:pk.p, peak_time:pk.t,
      fog_prob:fpk.p, fog_peak_time:fpk.t,
      road_prob:rpk.p, road_peak_time:rpk.t,
      series,
    };
  });
  const out = mapped;
  out._fromCache = raw._fromCache || false;
  out._stale = raw._stale || false;
  return out;
}

/* 从所有格点序列合成区域代表序列(取每时刻 30 格点强对流概率最大值 + 平均气象要素) */
function regionSeries(grid){
  if(!grid || !grid.length || !grid[0].series) return [];
  const n = grid[0].series.length;
  const out = [];
  for(let i=0;i<n;i++){
    let maxP=0, maxF=0, maxR=0, temp=0, rh=0, precip=0, cloud=0, ws=0, wg=0, vis=0, rad=0, uv=0, isDay=1;
    for(const g of grid){
      const s = g.series[i];
      maxP = Math.max(maxP, s.p);
      maxF = Math.max(maxF, s.f);
      maxR = Math.max(maxR, s.r||0);
      temp += s.temp; rh += s.rh; precip += s.precip; cloud += s.cloud;
      ws += s.ws||0; wg += s.wg||0;
      if(s.vis != null) vis = Math.max(vis, s.vis);
      if(s.rad != null) rad = Math.max(rad, s.rad);
      if(s.uv != null) uv = Math.max(uv, s.uv);
      if(s.isDay != null) isDay = s.isDay;
    }
    const m = grid.length;
    out.push({
      t: grid[0].series[i].t,
      p: maxP, f: maxF, r: maxR,
      temp: Math.round(temp/m*10)/10,
      rh: Math.round(rh/m*10)/10,
      precip: Math.round(precip/m*10)/10,
      cloud: Math.round(cloud/m*10)/10,
      ws: Math.round(ws/m*10)/10,
      wg: Math.round(wg/m*10)/10,
      vis: vis > 0 ? Math.round(vis/100)/10 : null,  // km
      rad: Math.round(rad),
      uv: uv ? Math.round(uv*10)/10 : null,
      isDay: isDay
    });
  }
  return out;
}

/* 本地时区小时键 "YYYY-MM-DDTHH:00" */
function localHourKey(d){
  const p = n => String(n).padStart(2,"0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:00`;
}

/* ---------- 空气质量（Open-Meteo Air Quality API，代表点，失败不阻塞主流程） ---------- */
const AQ_POINTS = [
  {name:"戛洒镇",  lat:24.08,  lon:101.60},
  {name:"金山原始森林", lat:23.945, lon:101.51},
  {name:"金山丫口", lat:23.939, lon:101.50},
];
const AQ_CACHE_KEY = "ailaoshan_aq_cache_v1";
const AQ_CACHE_TTL = 30 * 60 * 1000;

function getAqCache(){
  try{
    const s = localStorage.getItem(AQ_CACHE_KEY);
    if(!s) return null;
    const o = JSON.parse(s);
    if(Date.now() - o.ts > AQ_CACHE_TTL) return null;
    return o.data;
  }catch(e){ return null; }
}
function setAqCache(data){
  try{ localStorage.setItem(AQ_CACHE_KEY, JSON.stringify({ts:Date.now(), data})); }catch(e){}
}

async function fetchAirQuality(){
  const cached = getAqCache();
  if(cached) return cached;
  try{
    const params = new URLSearchParams({
      latitude: AQ_POINTS.map(p=>p.lat).join(","),
      longitude: AQ_POINTS.map(p=>p.lon).join(","),
      hourly: "pm2_5,pm10,us_aqi",
      forecast_days: "2",
      timezone: "Asia/Shanghai",
    });
    const url = "https://air-quality-api.open-meteo.com/v1/air-quality?" + params.toString();
    const resp = await fetch(url, {cache:"no-store"});
    if(!resp.ok) return null;
    const j = await resp.json();
    const out = AQ_POINTS.map((p,i)=>{
      const g = j[i] || {};
      const h = g.hourly || {};
      const time = (h.time||[]).map(t=>t.slice(0,13)+":00");
      return {
        name: p.name, lat: p.lat, lon: p.lon,
        series: time.map((t,k)=>({
          t,
          pm25: h.pm2_5 ? Math.round(h.pm2_5[k]) : null,
          pm10: h.pm10 ? Math.round(h.pm10[k]) : null,
          aqi: h.us_aqi ? Math.round(h.us_aqi[k]) : null,
        }))
      };
    });
    setAqCache(out);
    return out;
  }catch(e){ return null; }
}

/* ---------- 云海概率启发式模型（湿度 + 昼夜温差 + 风速） ---------- */
/* 哀牢山云海多出现于秋冬清晨：高相对湿度 + 明显昼夜温差 + 低风速 + 低层逆温。
 * 无官方云海观测，采用物理解释性经验公式，返回 0-100 概率。 */
function cloudSeaProb(rhNow, tDiff24, wsNow){
  if(rhNow == null || tDiff24 == null) return null;
  const s = (v, a, b) => Math.max(0, Math.min(1, (v - a) / (b - a)));
  const fRh  = s(rhNow, 55, 98);
  const fTd  = s(tDiff24, 4, 16);
  const fW   = 1 - s(wsNow, 0, 4.5);
  const prob = (0.45*fRh + 0.30*fTd + 0.25*fW) * 100;
  return Math.round(prob);
}

window.__fetchAirQuality = fetchAirQuality;
window.__cloudSeaProb = cloudSeaProb;
