/* =====================================================================
 * sw.js — Service Worker（PWA 弱网缓存）
 * 缓存策略：
 *   - 页面骨架 & 核心脚本：预缓存（cache-first，fallback 到预缓存）
 *   - 模型/数据 JSON：网络优先，失败回退缓存（弱网/离线可看上次数据）
 *   - 外部 CDN（three.js/echarts）：缓存优先，失败走网络
 * ===================================================================== */
const CACHE = "ailaoshan-v2026081515";
const CORE = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./js/site.js?v=2026081515",
  "./js/gb.js?v=2026081515",
  "./js/fx.js?v=2026081515",
  "./js/app.js?v=2026081515",
  "./js/terrain3d.js?v=2026081515",
  "./js/lib/three.min.js",
  "./js/lib/OrbitControls.js",
];

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

  // 外部 API（Open-Meteo / CDN）：缓存优先，失败走网络
  if(url.hostname.includes("open-meteo") || url.hostname.includes("jsdelivr")){
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request).then(resp => {
        const clone = resp.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return resp;
      }).catch(()=> hit))
    );
    return;
  }

  // 同源静态资源（HTML/JS/CSS/JSON/图片）：stale-while-revalidate
  // 先返回缓存快速显示，同时后台更新缓存；离线时直接用缓存
  e.respondWith(
    caches.match(e.request).then(cached => {
      const fetchPromise = fetch(e.request).then(resp => {
        if(resp.ok){
          const clone = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return resp;
      }).catch(()=> cached || caches.match("./index.html"));
      // 有缓存就先返回缓存，没有就等网络
      return cached || fetchPromise;
    })
  );
});
