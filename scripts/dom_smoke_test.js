/* 哀牢山天气 v2 DOM 冒烟测试（jsdom）
 * 验证：预警中心 / 景点一键聚焦 / 科普面板 / 沉浸式背景 / 雨滴 / 风速计 /
 *      能见度 / 紫外线 / 云海概率 / 空气质量卡片 / 骨架屏 API / PWA 标记 / main() 全流程
 * 运行：NODE_PATH=/Users/apple/.workbuddy/binaries/node/workspace/node_modules node scripts/dom_smoke_test.js
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

const dom = new JSDOM(html, {
  url: "https://ailaoshan.example.com/",
  runScripts: "outside-only",
  pretendToBeVisual: true,
});
const { window } = dom;
const { document } = window;

/* ---------- 浏览器环境补齐 ---------- */
window.matchMedia = window.matchMedia || (() => ({
  matches: false, media: "", onchange: null,
  addListener() {}, removeListener() {},
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
}));
window.ResizeObserver = window.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };
window.requestAnimationFrame = window.requestAnimationFrame || (cb => setTimeout(() => cb(Date.now()), 16));
window.cancelAnimationFrame = window.cancelAnimationFrame || (id => clearTimeout(id));
window.echarts = {
  init() { return { setOption() {}, resize() {}, dispose() {}, on() {}, off() {}, clear() {} }; },
  graphic: {},
};

/* ---------- fetch 桩：本地模型文件 + 假 Open-Meteo ---------- */
const N_HOURS = 72;
function mockHourlyArrays() {
  const time = [];
  const base = Date.UTC(2026, 7, 15, 0, 0, 0);
  for (let k = 0; k < N_HOURS; k++) {
    const d = new Date(base + k * 3600e3);
    time.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}T${String(d.getUTCHours()).padStart(2, "0")}`);
  }
  const out = { time };
  const gen = {
    temperature_2m: k => 12 + 6 * Math.sin((k - 8) / 24 * Math.PI * 2) + (k % 7),
    relative_humidity_2m: k => 78 + 12 * Math.sin(k / 24 * Math.PI),
    surface_pressure: k => 820 + Math.sin(k / 12),
    cloud_cover: k => 60 + 30 * Math.sin(k / 8),
    wind_speed_10m: k => 2.5 + 1.5 * Math.sin(k / 6),
    wind_gusts_10m: k => 4 + 2 * Math.sin(k / 6),
    precipitation: k => (k % 5 === 0 ? 1.2 : 0),
    dew_point_2m: k => 8 + 4 * Math.sin(k / 24 * Math.PI),
    soil_moisture_0_to_7cm: k => 0.32 + 0.02 * Math.sin(k / 12),
    soil_moisture_7_to_28cm: k => 0.36 + 0.01 * Math.sin(k / 12),
    visibility: k => 8000 + 4000 * Math.sin(k / 10),
    is_day: k => (k % 24 >= 7 && k % 24 < 19 ? 1 : 0),
    shortwave_radiation: k => (k % 24 >= 7 && k % 24 < 19 ? 300 * Math.sin((k % 24 - 7) / 12 * Math.PI) : 0),
    uv_index: k => (k % 24 >= 7 && k % 24 < 19 ? 4 * Math.sin((k % 24 - 7) / 12 * Math.PI) : 0),
  };
  for (const key of Object.keys(gen)) out[key] = time.map((_, k) => Math.round(gen[key](k) * 10) / 10);
  return out;
}

window.fetch = (url) => {
  const u = String(url);
  if (u.includes("api.open-meteo.com/v1/forecast")) {
    const m = u.match(/latitude=([^&]*)/);
    const n = m ? m[1].split(",").length : 1;
    const arr = Array.from({ length: n }, () => ({ latitude: 24.5, longitude: 101.0, elevation: 1800, hourly: mockHourlyArrays() }));
    return Promise.resolve(new Response(JSON.stringify(arr), { status: 200, headers: { "Content-Type": "application/json" } }));
  }
  if (u.includes("air-quality-api.open-meteo.com")) {
    const arr = Array.from({ length: 3 }, () => {
      const h = mockHourlyArrays();
      h.pm2_5 = h.time.map((_, k) => 15 + (k % 6) * 5);
      h.pm10 = h.time.map((_, k) => 30 + (k % 5) * 8);
      h.us_aqi = h.time.map((_, k) => 40 + (k % 4) * 10);
      return { hourly: h };
    });
    return Promise.resolve(new Response(JSON.stringify(arr), { status: 200, headers: { "Content-Type": "application/json" } }));
  }
  const clean = u.split("?")[0].replace(/^https?:\/\/[^/]+\//, "");
  const fp = path.join(ROOT, clean);
  if (fs.existsSync(fp)) {
    return Promise.resolve(new Response(fs.readFileSync(fp, "utf8"), { status: 200, headers: { "Content-Type": "application/json" } }));
  }
  return Promise.resolve(new Response("{}", { status: 404, headers: { "Content-Type": "application/json" } }));
};

/* ---------- 错误收集 ---------- */
const errors = [];
window.addEventListener("error", e => errors.push(String(e.error && e.error.message || e.message)));
window.addEventListener("unhandledrejection", e => errors.push("PROMISE: " + String(e.reason && e.reason.message || e.reason)));

/* ---------- 脚本执行 ----------
 * jsdom runScripts:"outside-only" 下动态 <script> 不会执行，只能用 window.eval。
 * - three.min.js / OrbitControls.js 为非 strict 的间接 eval → 顶层声明进全局(window)
 * - 业务脚本(site/gb/fx/app/terrain3d)含 "use strict"，拼接成一次间接 eval →
 *   所有顶层声明共享同一严格作用域，等价于浏览器多个 <script> 共享全局
 */
window.eval(fs.readFileSync(path.join(ROOT, "js/lib/three.min.js"), "utf8"));
window.eval(fs.readFileSync(path.join(ROOT, "js/lib/OrbitControls.js"), "utf8"));

/* 前置桩：canvas 2D 上下文（jsdom 未实现）+ devicePixelRatio + 假 WebGLRenderer */
window.eval(`
  const __p2d = new Proxy({}, {
    get(t, p) { if (p === "canvas") return null; return typeof p === "string" ? (() => ({ addColorStop(){} })) : undefined; },
    set() { return true; }
  });
  HTMLCanvasElement.prototype.getContext = function(type){ return type === "2d" ? __p2d : null; };
  window.devicePixelRatio = 1;
  window.THREE.WebGLRenderer = class {
    constructor(){ this.domElement = document.createElement("div"); this.shadowMap = { enabled:false, type:null }; }
    setPixelRatio(){} setSize(w,h){ this.domElement.style.width = w+"px"; this.domElement.style.height = h+"px"; }
    setAnimationLoop(){} render(){} dispose(){}
  };
`);

const appScripts = ["js/site.js", "js/gb.js", "js/fx.js", "js/app.js", "js/terrain3d.js"];
const concat = appScripts.map(f => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n;\n");
try {
  window.eval(concat);
  console.log("app scripts eval OK");
} catch (e) {
  errors.push("APP EVAL: " + e.message);
  console.log("app scripts eval FAIL -", e.message);
}

/* ---------- 等 main() 跑完 ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitSettled() {
  for (let i = 0; i < 200; i++) {
    await sleep(100);
    const poi = document.querySelectorAll(".poi-btn").length;
    const meta = document.querySelector("#meta");
    if (!meta) continue;
    if (poi >= 5 && (meta.textContent.includes("哀牢山生态站") || meta.textContent.includes("加载失败"))) return true;
  }
  return false;
}

(async () => {
  const settled = await waitSettled();
  const meta = document.querySelector("#meta");
  console.log("\n== 结果 ==");
  console.log("main 流程收敛:", settled);
  console.log("meta:", meta ? meta.textContent.slice(0, 120) : "(无)");

  const checks = [];
  const c = (name, ok, extra) => checks.push({ name, ok, extra });

  // 0. main() 全流程成功（无 加载失败）
  c("main() 全流程成功(含3D路径)", settled && meta && meta.textContent.includes("哀牢山生态站") && !meta.textContent.includes("加载失败"),
    meta ? meta.textContent.slice(0, 60) : "meta 缺失");

  // 1. 预警中心
  c("预警中心面板存在", !!document.getElementById("warnCenterPanel"));
  const warnItems = document.querySelectorAll(".warn-item").length;
  c("预警中心风险项 >= 6", warnItems >= 6, `实际 ${warnItems}`);

  // 2. 景点一键聚焦
  c("景点面板存在", !!document.getElementById("poiPanel"));
  const poiBtns = document.querySelectorAll(".poi-btn").length;
  c("景点按钮 >= 5", poiBtns >= 5, `实际 ${poiBtns}`);
  c("flyToPlace 已暴露", typeof window.flyToPlace === "function");

  // 3. 科普面板
  const scienceDetails = document.querySelectorAll("#sciencePanel details").length;
  c("科普面板存在", !!document.getElementById("sciencePanel"));
  c("科普条目 == 4", scienceDetails === 4, `实际 ${scienceDetails}`);

  // 4. 沉浸式背景 + 动效
  const bgCls = [...document.body.classList].filter(x => x.startsWith("bg-atmos-"));
  c("背景氛围类已设置", bgCls.length > 0, bgCls.join(",") || "无");
  c("雨滴画布存在", !!document.getElementById("rainFx"));
  c("风速计存在", !!document.getElementById("windGauge"));
  c("applyBackground 已暴露", typeof window.__applyBackground === "function");

  // 5. 天气卡片（能见度/紫外线/云海概率/空气质量）
  const sky = document.getElementById("skyCards") || document.getElementById("weatherPanel") || document.body;
  const skyText = sky.textContent;
  c("能见度卡片 👁", skyText.includes("👁"));
  c("紫外线卡片 ☀️", skyText.includes("☀️"));
  c("云海概率卡片 🌫", skyText.includes("🌫") || skyText.includes("云海概率"));
  c("空气质量卡片 🏭", skyText.includes("🏭") || skyText.includes("空气质量"));

  // 6. 云海概率 / 空气质量 API 暴露
  c("cloudSeaProb 已暴露", typeof window.__cloudSeaProb === "function");
  c("fetchAirQuality 已暴露", typeof window.__fetchAirQuality === "function");

  // 7. 骨架屏
  c("enableSkeleton 已暴露", typeof window.__enableSkeleton === "function");

  // 8. PWA 标记
  const manifest = document.querySelector('link[rel="manifest"]');
  c("manifest 已链接", !!manifest && (manifest.getAttribute("href") || "").includes("manifest.json"));
  c("sw.js 注册脚本存在", html.includes("serviceWorker") || html.includes("sw.js"));

  // 9. 错误
  c("无未捕获 JS 错误", errors.length === 0, JSON.stringify(errors));

  console.log("\n== 明细 ==");
  let fail = 0;
  for (const { name, ok, extra } of checks) {
    console.log(`${ok ? "✅" : "❌"} ${name}${extra !== undefined ? "  [" + extra + "]" : ""}`);
    if (!ok) fail++;
  }
  console.log(`\n${checks.length - fail}/${checks.length} 项通过`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("测试崩溃:", e); process.exit(2); });
