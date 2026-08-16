/* =====================================================================
 * sw.js — Service Worker（PWA 弱网/离线缓存）
 * 缓存策略：
 *   - 页面骨架 & 核心脚本：预缓存（cache-first，fallback 到预缓存）
 *   - 模型/数据 JSON：网络优先，失败回退缓存（弱网/离线可看上次数据）
 *   - 外部 API（Open-Meteo）：网络优先，失败回退缓存（离线仍可看上次预报）
 *   - 外部 CDN（three.js/echarts）：缓存优先，失败走网络
 *   - 离线 fallback：所有导航请求失败时回退到 index.html
 * ===================================================================== */
const CACHE = "ailaoshan-v2026081539";
const CORE = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./js/site.js?v=2026081539",
  "./js/gb.js?v=2026081539",
  "./js/fx.js?v=2026081539",
  "./js/app.js?v=2026081539",
  "./js/terrain3d.js?v=2026081539",
  "./js/lib/three.min.js",
  "./js/lib/OrbitControls.js",
];

// 离线 fallback 页面（内嵌极简 HTML，不依赖外部资源）
const OFFLINE_FALLBACK = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">'+
  '<meta name="viewport" content="width=device-width,initial-scale=1">'+
  '<title>哀牢山天气 - 离线模式</title>'+
  '<style>body{background:#050d09;color:#eaf5ee;font-family:sans-serif;padding:40px 20px;text-align:center;line-height:1.8}'+
  'h1{color:#6fd39a;font-size:20px}p{color:#9bc4b0;font-size:14px;max-width:480px;margin:12px auto}'+
  '.btn{display:inline-block;margin-top:16px;padding:10px 28px;border-radius:6px;background:#6fd39a;color:#04130a;text-decoration:none;font-weight:700}</style></head>'+
  '<body><h1>🏔 哀牢山天气</h1>'+
  '<p>⚠️ 当前处于离线模式。<br>显示的是上次缓存的预报数据，<b>可能有延迟</b>。<br>进山前请务必联网刷新获取最新预报。</p>'+
  '<p>缓存时间：'+new Date().toLocaleString("zh-CN")+'</p>'+
  '<a class="btn" href="./">重新连接</a></body></html>';

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(CORE)).then(()=>self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if(e.request.method !== "GET") return;

  // 导航请求（页面加载）：网络优先 → 缓存 → 离线 fallback
  if(e.request.mode === "navigate"){
    e.respondWith(
      fetch(e.request).then(resp => {
        if(resp.ok){
          const clone = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return resp;
      }).catch(()=>{
        return caches.match(e.request).then(cached => cached || caches.match("./index.html"));
      })
    );
    return;
  }

  // 外部 API（Open-Meteo）：网络优先，失败回退缓存
  if(url.hostname.includes("open-meteo")){
    e.respondWith(
      fetch(e.request).then(resp => {
        const clone = resp.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return resp;
      }).catch(()=>{
        return caches.match(e.request).then(cached => {
          if(cached){
            // 通知客户端数据来自缓存
            self.clients.matchAll().then(clients => {
              clients.forEach(c => c.postMessage({type:"offline-cache", url:e.request.url}));
            });
            return cached;
          }
          return new Response('{"error":"offline"}', {headers:{"Content-Type":"application/json"}});
        });
      })
    );
    return;
  }

  // 外部 CDN（jsdelivr 等）：缓存优先，失败走网络
  if(url.hostname.includes("jsdelivr")){
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request).then(resp => {
        const clone = resp.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return resp;
      }).catch(()=> hit))
    );
    return;
  }

  // 同源静态资源（JS/CSS/JSON/图片）：网络优先（确保最新），失败回退缓存
  e.respondWith(
    fetch(e.request).then(resp => {
      if(resp.ok){
        const clone = resp.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return resp;
    }).catch(()=>{
      // 网络失败：有缓存就返回缓存，没有就返回对应类型的空响应（绝不对 JS/CSS 返回 HTML）
      return caches.match(e.request).then(cached => {
        if(cached) return cached;
        var ct = "text/plain";
        if(url.pathname.endsWith(".js")) ct = "application/javascript";
        else if(url.pathname.endsWith(".css")) ct = "text/css";
        else if(url.pathname.endsWith(".json")) ct = "application/json";
        return new Response("/* offline */", {status:504, statusText:"Gateway Timeout", headers:{"Content-Type":ct}});
      });
    })
  );
});

// 接收客户端消息：手动触发缓存清理
self.addEventListener("message", e => {
  if(e.data && e.data.type === "SKIP_WAITING"){
    self.skipWaiting();
  }
});
