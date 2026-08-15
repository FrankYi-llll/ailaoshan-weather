/* =====================================================================
 * fx.js — 沉浸式氛围动效（哀牢山主题）
 *   - 动态背景：根据当前天气（云量/降水/能见度）切换"晴天云海/阴雨森林/浓雾深林"氛围
 *   - 雨滴粒子：Canvas 全屏雨幕，强度随降水增大
 *   - 风速计旋转：风速越大力臂转动越快（CSS 变量驱动）
 * 依赖：无（纯 DOM + Canvas）；由 app.js main() 调用
 * ===================================================================== */
(function(){
  "use strict";
  const $ = id => document.getElementById(id);
  let rainCanvas = null, rainCtx = null, rainDrops = [], rainRAF = null, rainRunning = false, rainIntensity = 0;
  let fxSetup = false;

  /* ---------- 一次性搭建 DOM ---------- */
  function setup(){
    if(fxSetup) return;
    fxSetup = true;
    // 雨幕 canvas（全屏，覆盖在背景之上、内容之下）
    const cv = document.createElement("canvas");
    cv.id = "rainFx";
    cv.style.cssText = "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:1;opacity:0";
    document.body.appendChild(cv);
    rainCanvas = cv;
    rainCtx = cv.getContext("2d");
    let resizeTimer = null;
    const resize = ()=>{
      if(resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(()=>{
        cv.width = window.innerWidth * devicePixelRatio;
        cv.height = window.innerHeight * devicePixelRatio;
      }, 150);
    };
    resize();
    window.addEventListener("resize", resize);
    // 风速计 DOM（放 header 右侧）
    if(!$("windGauge")){
      const h = document.querySelector("header");
      if(h){
        const g = document.createElement("div");
        g.id = "windGauge";
        g.style.cssText = "display:none;align-items:center;gap:8px;font-family:var(--mono);font-size:11px;color:var(--sub);margin-left:auto";
        g.innerHTML =
          '<div style="position:relative;width:30px;height:30px;border-radius:50%;border:1px solid rgba(150,204,170,.35);display:flex;align-items:center;justify-content:center">'+
          '<span style="position:absolute;width:2px;height:13px;background:var(--teal);transform-origin:50% 100%;bottom:50%;left:50%;margin-left:-1px" id="windNeedle">▲</span>'+
          '<span style="font-size:9px;color:var(--dim)">m/s</span></div>'+
          '<span id="windGaugeVal" style="color:var(--text)">0.0</span>';
        h.appendChild(g);
      }
    }
  }

  /* ---------- 动态背景（根据天气氛围设置 body 类） ---------- */
  const BG_CLASS = "bg-atmos";
  function applyBackground(series){
    if(!series || !series.length) return;
    setup();
    const cur = series[0];
    const rain3h = series.slice(0,3).reduce((a,s)=>a+(s.precip||0), 0);   // 近3h降水
    const rainNow = cur.precip||0;
    const cloud = cur.cloud != null ? cur.cloud : 50;
    const vis = cur.vis;                          // km
    const isDay = cur.isDay != null ? cur.isDay : 1;
    let mood = "sunny";
    if(rainNow >= 0.8 || rain3h >= 2.5) mood = "rain";
    else if(vis != null && vis < 2) mood = "fog";
    else if(cloud >= 80) mood = "overcast";
    else if(cloud >= 40) mood = "partly";
    document.body.classList.remove(BG_CLASS+"-sunny", BG_CLASS+"-rain", BG_CLASS+"-fog", BG_CLASS+"-overcast", BG_CLASS+"-partly");
    document.body.classList.add(BG_CLASS+"-"+mood);
    // 雨幕强度
    const rainK = Math.min(1, (rainNow / 2.5) * 0.7 + (rain3h / 10) * 0.3);
    setRain(rainK);
    // 风速计
    setWindGauge(cur.ws, cur.wg);
  }
  window.__applyBackground = applyBackground;

  /* ---------- 雨滴粒子 ---------- */
  function setRain(k){
    if(k <= 0.02){ stopRain(); return; }
    startRain(k);
  }
  function startRain(k){
    setup();
    const cv = rainCanvas, ctx = rainCtx;
    if(rainRunning){ rainIntensity = k; cv.style.opacity = Math.min(0.55, k); return; }
    rainRunning = true;
    rainIntensity = k;
    cv.style.opacity = Math.min(0.55, k);
    rainDrops = [];
    const DPR = devicePixelRatio;
    const make = ()=>{
      const w = window.innerWidth, h = window.innerHeight;
      const x = Math.random()*w*DPR, y = -Math.random()*h*DPR;
      const len = (6 + Math.random()*10) * DPR;
      const sp = (4 + Math.random()*5) * DPR;
      return {x, y, len, sp, w: Math.max(1, Math.random()*1.6)*DPR};
    };
    const N = Math.round(90 * k + 10);
    for(let i=0;i<N;i++) rainDrops.push(make());
    const step = ()=>{
      if(!rainRunning) return;
      try{
        const w = cv.width, h = cv.height;
        ctx.clearRect(0, 0, w, h);
        ctx.strokeStyle = "rgba(160,190,220,0.5)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        for(const d of rainDrops){
          d.y += d.sp; d.x += d.sp * 0.08;
          if(d.y - d.len > h || d.x > w + 20){ Object.assign(d, make()); }
          ctx.moveTo(d.x, d.y - d.len); ctx.lineTo(d.x, d.y);
        }
        ctx.stroke();
      }catch(e){
        console.error("[fx] 雨滴渲染异常:", e);
        stopRain();
        return;
      }
      rainRAF = requestAnimationFrame(step);
    };
    rainRAF = requestAnimationFrame(step);
  }
  function stopRain(){
    rainRunning = false;
    if(rainRAF){ cancelAnimationFrame(rainRAF); rainRAF = null; }
    if(rainCtx && rainCanvas){ rainCtx.clearRect(0, 0, rainCanvas.width, rainCanvas.height); rainCanvas.style.opacity = 0; }
  }

  /* ---------- 风速计 ---------- */
  function setWindGauge(ws, wg){
    const g = $("windGauge");
    if(!g) return;
    if(ws == null){ g.style.display = "none"; return; }
    g.style.display = "flex";
    const needle = $("windNeedle");
    const val = $("windGaugeVal");
    if(val) val.textContent = ws.toFixed(1) + (wg ? " · 阵" + Math.round(wg) : "");
    if(needle){
      // 风速 → 旋转角速度（度/秒）：1 m/s ≈ 18°/s，封顶 360°/s
      const spd = Math.min(360, Math.max(0, ws * 18));
      needle.style.transition = "none";
      needle.style.animation = "none";
      void needle.offsetWidth;
      needle.style.animation = "windSpin " + Math.max(0.6, 360 / Math.max(spd, 1)) + "s linear infinite";
    }
    if(!document.querySelector("style#windSpinStyle")){
      const st = document.createElement("style");
      st.id = "windSpinStyle";
      st.textContent = "@keyframes windSpin{to{transform:rotate(360deg)}}";
      document.head.appendChild(st);
    }
  }

  /* ---------- 骨架屏：替换 .loading 为骨架动画（数据加载前调用） ---------- */
  function enableSkeleton(){
    setup();
    document.querySelectorAll(".loading").forEach(el=>{
      el.classList.add("sk");
      el.innerHTML = '<span class="sk-bar" style="width:38%"></span><span class="sk-bar" style="width:62%"></span><span class="sk-bar" style="width:52%"></span>';
    });
  }
  window.__enableSkeleton = enableSkeleton;
})();
