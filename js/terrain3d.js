/* =====================================================================
 * terrain3d.js — 哀牢山 3D 全景地形（Three.js 真实 3D 渲染） v2026-08-14-1949
 * 替换原 Canvas 2D 软渲染：
 *   - 真实透视地形（169×209 DEM 高度场, 35,321 顶点 / 70,000+ 三角面）
 *   - 左上 45° 太阳光照 + 山体投影阴影
 *   - 摄影风海拔配色（深绿→黄绿→橄榄→灰褐→白灰）
 *   - 道路 / 河流 / 森林 / 等高线 / 悬浮地名标签
 *   - 鼠标悬停显示海拔·坡度·风险增强；🗺️ 旅游视角模式
 * 依赖：three.js r128 (UMD) + OrbitControls；app.js 全局 TR3D()/HM()/TERR_G()
 * 调用：renderTerrain3D() 中 window.initThreeTerrain()
 * ===================================================================== */
(function(){
  "use strict";
  const $ = id => document.getElementById(id);

  let scene = null, camera = null, renderer = null, controls = null, raycaster = null;
  let terrainMesh = null, terrainMaterial = null, labelsGroup = null, roadsGroup = null, riversGroup = null,
      treesGroup = null, contoursLine = null, forbiddenGroup = null, routesGroup = null,
      cloudsGroup = null, rainGroup = null;
  let sunLight = null, hemiLight = null, fillLight = null, camLight = null;
  let weatherState = { temp:20, rh:60, precip:0, cloud:30, vis:10, ws:2, code:800 };
  let initialized = false, tourMode = false;
  let mouse = new THREE.Vector2(), hoverTimer = null;
  let tourCurves = [];        // 路线相机飞行用（buildTourRoutes 填充）
  let clickDown = null;       // 点击/拖拽识别
  let flyState = null;        // 相机飞行动画句柄

  // 全局数据来自 app.js（必须在 initThreeTerrain 前设置 window.HEIGHT_MAP/TERRAIN3D/TERR）
  const HM = () => window.HEIGHT_MAP;
  const TR3D = () => window.TERRAIN3D;
  const TERR_G = () => window.TERR;

  /* ---------- 坐标映射（lat/lon → 世界坐标） ---------- */
  let KX = 8.0, KZ = 7.3, X0 = 4.25, Z0 = 3.14;   // 由 HM() 计算
  const VERT = 0.003;                              // 3 倍垂直夸张：1 世界单位 ≈ 333m（海拔）

  function calcGeo(){
    const hm = HM();
    const dLon = hm.lon_range[1] - hm.lon_range[0];
    const dLat = hm.lat_range[1] - hm.lat_range[0];
    KX = 100 / dLon;                 // 1 世界单位 ≈ 1km（经度方向）
    KZ = 100 / dLat;                 // 1 世界单位 ≈ 1km（纬度方向）
    X0 = dLon * KX / 2;
    Z0 = dLat * KZ / 2;
  }
  function lon2x(lon){ return (lon - HM().lon_range[0]) * KX - X0; }
  function lat2z(lat){ return (lat - HM().lat_range[0]) * KZ - Z0; }

  /* 双线性插值海拔（米） */
  function elevAt(lat, lon){
    const hm = HM(), rows = hm.h, cols = hm.w;
    const fi = (lat - hm.lat_range[0]) / (hm.lat_range[1] - hm.lat_range[0]) * (rows - 1);
    const fj = (lon - hm.lon_range[0]) / (hm.lon_range[1] - hm.lon_range[0]) * (cols - 1);
    const i0 = Math.min(rows - 2, Math.max(0, Math.floor(fi)));
    const j0 = Math.min(cols - 2, Math.max(0, Math.floor(fj)));
    const di = fi - i0, dj = fj - j0;
    const e = hm.elev;
    return e[i0*cols + j0]*(1-di)*(1-dj) + e[(i0+1)*cols + j0]*di*(1-dj)
         + e[i0*cols + j0+1]*(1-di)*dj + e[(i0+1)*cols + j0+1]*di*dj;
  }
  function slopeDegAt(lat, lon){
    const d = 0.004;
    const eN = elevAt(lat + d, lon), eS = elevAt(lat - d, lon);
    const eE = elevAt(lat, lon + d), eW = elevAt(lat, lon - d);
    const gx = (eE - eW) / (2*d*111000), gy = (eN - eS) / (2*d*111000);
    return Math.atan(Math.hypot(gx, gy)) * 180 / Math.PI;
  }
  function surfPt(lat, lon){
    return new THREE.Vector3(lon2x(lon), elevAt(lat, lon) * VERT, lat2z(lat));
  }

  /* ---------- 摄影风海拔色带 ---------- */
  function elevColor01(t){
    const stops = [
      [0.00, [26, 72, 36]],  [0.12, [48, 112, 50]], [0.26, [88, 150, 66]],
      [0.40, [142, 170, 82]], [0.54, [180, 156, 94]], [0.68, [172, 124, 72]],
      [0.80, [148, 98, 66]],  [0.90, [130, 84, 62]], [1.00, [233, 231, 240]]
    ];
    t = Math.max(0, Math.min(1, t));
    for(let i = 0; i < stops.length - 1; i++){
      const t0 = stops[i][0], c0 = stops[i][1], t1 = stops[i+1][0], c1 = stops[i+1][1];
      if(t <= t1){
        const k = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
        return [c0[0]+(c1[0]-c0[0])*k, c0[1]+(c1[1]-c0[1])*k, c0[2]+(c1[2]-c0[2])*k];
      }
    }
    return stops[stops.length-1][1];
  }

  /* ---------- 场景构建 ---------- */
  function buildScene(){
    if(!HM() || !TR3D()) return;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1d3552);
    // 雾效：使用较亮的雾色，保证远山不会被“吞”成黑色
    scene.fog = new THREE.FogExp2(0x4a6b8a, 0.0075);
    scene.background = new THREE.Color(0x4a6b8a);

    const container = $("three3DContainer");
    const W = container.clientWidth || 900, H = container.clientHeight || 520;

    camera = new THREE.PerspectiveCamera(50, W / H, 0.05, 20000);
    camera.position.set(5.8, 5.0, 6.2);

    renderer = new THREE.WebGLRenderer({antialias: true});
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(W, H);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.insertBefore(renderer.domElement, container.firstChild);

    /* ---- WebGL 上下文丢失/恢复：防止 GPU 重置或标签页切回时 3D 崩溃 ---- */
    renderer.domElement.addEventListener("webglcontextlost", function(e){
      e.preventDefault();
      console.warn("[terrain3d] WebGL 上下文丢失，暂停渲染");
      if(renderer) renderer.setAnimationLoop(null);
    });
    renderer.domElement.addEventListener("webglcontextrestored", function(){
      console.log("[terrain3d] WebGL 上下文恢复，重新加载资源");
      try{
        if(scene && camera){
          renderer.setAnimationLoop(animLoop);
        }
      }catch(err){ console.error("[terrain3d] 恢复渲染失败:", err); }
    });

    /* ---- 相机控制器：旋转/缩放/平移 ---- */
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 1.6, 0);
    controls.minDistance = 2.5;
    controls.maxDistance = 26;
    controls.maxPolarAngle = Math.PI * 0.55;
    controls.minPolarAngle = 0.12;
    controls.enablePan = true;
    // 开场自动缓慢旋转，展示山体三维起伏；用户拖拽后停止
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.35;

    /* ---- 光照：左上 45° 主太阳 + 半球天空/地面环境 + 弱补光 ---- */
    sunLight = new THREE.DirectionalLight(0xfff2d8, 1.55);
    sunLight.position.set(-6.5, 11, -4.2);              // 左(-X) 上(+Y) 后(-Z) → 西北方向光源
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.set(2048, 2048);
    sunLight.shadow.camera.left = -7; sunLight.shadow.camera.right = 7;
    sunLight.shadow.camera.top = 7; sunLight.shadow.camera.bottom = -7;
    sunLight.shadow.camera.near = 0.5; sunLight.shadow.camera.far = 30;
    sunLight.shadow.bias = -0.0006;
    scene.add(sunLight);

    hemiLight = new THREE.HemisphereLight(0x8fb8ff, 0x3d3225, 0.65);
    scene.add(hemiLight);
    fillLight = new THREE.DirectionalLight(0x7a9ac0, 0.38); // 右下补光
    fillLight.position.set(5, 3, 4);
    scene.add(fillLight);
    // 相机补光：始终朝向地形中心，保证用户当前视角的山体正面有光
    camLight = new THREE.DirectionalLight(0xcfe8ff, 0.42);
    camLight.position.copy(camera.position);
    scene.add(camLight);

    /* ---- 地形网格 ---- */
    terrainMesh = buildTerrain();
    scene.add(terrainMesh);

    // 根据真实地形包围盒重置相机/控制器，避免海拔米值过大导致相机位于地形下方
    const tBox = new THREE.Box3().setFromObject(terrainMesh);
    const tCenter = tBox.getCenter(new THREE.Vector3());
    const tSize = tBox.getSize(new THREE.Vector3());
    const tDiag = Math.max(tSize.x, tSize.y, tSize.z);
    camera.far = Math.max(20000, tDiag * 4);
    camera.updateProjectionMatrix();
    controls.target.copy(tCenter);
    controls.minDistance = tDiag * 0.15;
    controls.maxDistance = tDiag * 2.5;
    // 开场相机放在太阳光一侧（-X, -Z），确保山体受光面朝向用户，避免开场死黑
    camera.position.set(tCenter.x - tDiag * 0.75, tCenter.y + tDiag * 0.65, tCenter.z - tDiag * 0.75);

    // 同步调整太阳光位置与阴影相机范围（匹配真实地形尺度）
    sunLight.position.set(-tDiag * 0.7, tDiag * 1.1, -tDiag * 0.45);
    sunLight.shadow.camera.near = tDiag * 0.05;
    sunLight.shadow.camera.far = tDiag * 3.5;
    sunLight.shadow.camera.left = -tDiag * 1.2;
    sunLight.shadow.camera.right = tDiag * 1.2;
    sunLight.shadow.camera.top = tDiag * 1.2;
    sunLight.shadow.camera.bottom = -tDiag * 1.2;
    fillLight.position.set(tDiag * 0.45, tDiag * 0.35, tDiag * 0.4);

    /* ---- 等高线 ---- */
    contoursLine = buildContours();
    scene.add(contoursLine);

    /* ---- 河流 / 道路 ---- */
    riversGroup = new THREE.Group();
    scene.add(riversGroup);
    buildRivers();
    roadsGroup = new THREE.Group();
    scene.add(roadsGroup);
    buildRoads();

    /* ---- 森林 ---- */
    treesGroup = new THREE.Group();
    scene.add(treesGroup);
    buildTrees();

    /* ---- 哀牢山云雾层 ---- */
    cloudsGroup = new THREE.Group();
    scene.add(cloudsGroup);
    buildClouds();

    /* ---- 3D 雨粒子（默认隐藏，天气联动时激活） ---- */
    rainGroup = new THREE.Group();
    rainGroup.visible = false;
    scene.add(rainGroup);
    buildRain();

    /* ---- 地名标签 + 禁区 ---- */
    labelsGroup = new THREE.Group();
    scene.add(labelsGroup);
    buildLabels();
    forbiddenGroup = new THREE.Group();
    scene.add(forbiddenGroup);
    buildForbiddenZones();

    /* ---- 旅游模式路线（默认隐藏） ---- */
    routesGroup = new THREE.Group();
    routesGroup.visible = false;
    scene.add(routesGroup);
    buildTourRoutes();

    /* ---- 3D 指北针（场景内，始终指向北） ---- */
    buildCompass();

    /* ---- 交互 ---- */
    raycaster = new THREE.Raycaster();
    renderer.domElement.addEventListener("mousemove", onMouseMove);
    renderer.domElement.addEventListener("mouseleave", hideTooltip);
    renderer.domElement.style.cursor = "grab";
    renderer.domElement.addEventListener("mousedown", (e)=>{
      clickDown = {x: e.clientX, y: e.clientY};
      renderer.domElement.style.cursor = "grabbing";
    });
    renderer.domElement.addEventListener("mouseup", (e)=>{
      renderer.domElement.style.cursor = "grab";
      if(!clickDown) return;
      const dx = e.clientX - clickDown.x, dy = e.clientY - clickDown.y;
      clickDown = null;
      if(e.button !== 0) return;
      if(Math.hypot(dx, dy) > 6) return;   // 拖拽旋转不算点击
      onTerrainClick(e);
    });
    // 用户开始拖拽/缩放时停止相机飞行
    controls.addEventListener("start", ()=> stopFly());
    // 路线飞行按钮
    document.querySelectorAll("#three3DRoutes .rbtn").forEach((b, k)=>{
      b.addEventListener("click", ()=> flyRoute(parseInt(b.dataset.route, 10)));
    });

    /* ---- 海拔色标文字 ---- */
    $("scaleMax").textContent = Math.round(HM().max_elev) + "m";
    $("scaleMin").textContent = Math.round(HM().min_elev) + "m";

    window.addEventListener("resize", onResize);

    /* ---- 渲染循环（带错误保护，防止单帧异常导致整个循环挂掉） ---- */
    function animLoop(){
      try{
        // 第一视角飞行期间绕过 OrbitControls（其 minDistance 会把贴地相机往后推，造成抖动/穿模）
        if(!fpFlying) controls.update();
        // 卫星影像透明度渐变
        if(terrainMaterial && terrainMaterial.uniforms.satMap.value){
          const sm = terrainMaterial.uniforms.satMix, st = terrainMaterial.uniforms.satMixTarget;
          if(Math.abs(st.value - sm.value) > 0.004){ sm.value += (st.value - sm.value) * 0.06; }
        }
        camLight.position.copy(camera.position);
        // 云雾漂移（受风速影响）
        if(cloudsGroup){
          const t = performance.now();
          for(const c of cloudsGroup.children){
            const mul = c.userData.driftSpeedMul || 1.0;
            c.position.x = c.userData.baseX + Math.sin(t * c.userData.driftSpeed * mul + c.userData.driftPhase) * 1.4;
            c.position.z = c.userData.baseZ + Math.cos(t * c.userData.driftSpeed * 0.7 * mul + c.userData.driftPhase) * 1.0;
          }
        }
        // 雨粒子下落
        if(rainGroup && rainGroup.visible && rainGroup.children[0]){
          const pts = rainGroup.children[0];
          const pos = pts.geometry.attributes.position;
          const vel = pts.userData.velocities;
          const yTop = pts.userData.yTop, yBot = pts.userData.yBot;
          const windX = pts.userData.windOffset || 0;
          for(let i = 0; i < vel.length; i++){
            pos.array[i*3+1] -= vel[i];
            pos.array[i*3]   += windX;
            if(pos.array[i*3+1] < yBot){
              pos.array[i*3+1] = yTop;
              pos.array[i*3]   = (Math.random() - 0.5) * pts.userData.range * 2;
              pos.array[i*3+2] = (Math.random() - 0.5) * pts.userData.range * 2;
            }
          }
          pos.needsUpdate = true;
        }
        renderer.render(scene, camera);
      }catch(err){
        console.error("[terrain3d] 渲染循环异常:", err);
        // 连续异常时降级：暂停渲染循环避免刷屏
        if(!animLoop._errCount) animLoop._errCount = 0;
        if(++animLoop._errCount > 5){
          renderer.setAnimationLoop(null);
          console.error("[terrain3d] 连续异常超过5次，已暂停渲染");
        }
      }
    }
    renderer.setAnimationLoop(animLoop);
  }

  /* ---------- 地形网格（顶点海拔着色） ---------- */
  function buildTerrain(){
    const hm = HM(), rows = hm.h, cols = hm.w, elev = hm.elev;
    const minE = hm.min_elev, maxE = hm.max_elev;
    const positions = new Float32Array(rows * cols * 3);
    const colors = new Float32Array(rows * cols * 3);
    const uvs = new Float32Array(rows * cols * 2);
    for(let i = 0; i < rows; i++){
      const lat = hm.lat_range[0] + (hm.lat_range[1] - hm.lat_range[0]) * i / (rows - 1);
      for(let j = 0; j < cols; j++){
        const lon = hm.lon_range[0] + (hm.lon_range[1] - hm.lon_range[0]) * j / (cols - 1);
        const idx = i * cols + j;
        positions[idx*3]   = lon2x(lon);
        positions[idx*3+1] = elev[idx] * VERT;
        positions[idx*3+2] = lat2z(lat);
        uvs[idx*2]     = j / (cols - 1);
        uvs[idx*2 + 1] = i / (rows - 1);
        const c = elevColor01((elev[idx] - minE) / (maxE - minE));
        colors[idx*3]   = c[0] / 255;
        colors[idx*3+1] = c[1] / 255;
        colors[idx*3+2] = c[2] / 255;
      }
    }
    const indices = [];
    for(let i = 0; i < rows - 1; i++){
      for(let j = 0; j < cols - 1; j++){
        const a = i*cols + j, b = a + 1, c = (i+1)*cols + j, d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    g.setIndex(indices);
    g.computeVertexNormals();
    // 自定义着色器：顶点色 + 可选卫星影像贴图 + 多光源（太阳光/天空/地面/轮廓光）+ 雾效 + 天气联动
    const m = new THREE.ShaderMaterial({
      uniforms: {
        fogColor: {value: new THREE.Color(0x4a6b8a)},
        fogDensity: {value: 0.0075},
        sunIntensity: {value: 1.0},
        ambientIntensity: {value: 1.0},
        wetness: {value: 0.0},
        satMap: {value: null},
        satMix: {value: 0.0},
        satMixTarget: {value: 0.0}
      },
      vertexShader: `
        attribute vec3 color;
        varying vec3 vColor;
        varying vec2 vUv;
        varying vec3 vNormal;
        varying vec3 vViewPosition;
        varying float vFogDepth;
        void main(){
          vColor = color;
          vUv = uv;
          vNormal = normalize(normalMatrix * normal);
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          vViewPosition = -mvPosition.xyz;
          vFogDepth = length(mvPosition.xyz);
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        uniform vec3 fogColor;
        uniform float fogDensity;
        uniform float sunIntensity;
        uniform float ambientIntensity;
        uniform float wetness;
        uniform sampler2D satMap;
        uniform float satMix;
        varying vec3 vColor;
        varying vec2 vUv;
        varying vec3 vNormal;
        varying vec3 vViewPosition;
        varying float vFogDepth;
        void main(){
          vec3 n = normalize(vNormal);
          vec3 v = normalize(vViewPosition);

          // 基础色：海拔顶点色 与 卫星影像 按比例混合
          vec3 satCol = texture2D(satMap, vUv).rgb;
          vec3 baseCol = mix(vColor, satCol, satMix);

          // 1) 主太阳光（左上 45°）
          vec3 sunDir = normalize(vec3(-0.55, 0.75, -0.35));
          float sunDiff = max(dot(n, sunDir), 0.0);

          // 2) 天空环境光（从上方，冷蓝）
          float skyDiff = max(dot(n, vec3(0.0, 1.0, 0.0)), 0.0);

          // 3) 地面反射（从下方，暖褐）
          float groundDiff = max(dot(n, vec3(0.0, -1.0, 0.0)), 0.0);

          // 4) 轮廓光（让山体边缘更立体）
          float rim = pow(1.0 - max(dot(n, v), 0.0), 2.8);

          // 5) 山谷/背坡自遮挡暗化（法线 y 分量越小越暗）
          float occlusion = 0.78 + 0.22 * max(n.y, 0.0);

          // 提升基础亮度，避免背光面死黑
          vec3 ambient  = vec3(0.50, 0.52, 0.56) * ambientIntensity;
          vec3 sunCol   = vec3(1.00, 0.94, 0.82) * sunDiff * 1.18 * sunIntensity;
          vec3 skyCol   = vec3(0.46, 0.58, 0.80) * skyDiff * 0.65 * ambientIntensity;
          vec3 groundCol= vec3(0.44, 0.34, 0.20) * groundDiff * 0.32;
          vec3 rimCol   = vec3(0.64, 0.76, 0.92) * rim * 0.32;

          vec3 lit = ambient + sunCol + skyCol + groundCol;
          // 颜色提亮，整体饱和度略降（baseCol = 顶点色/卫星影像混合）
          vec3 col = baseCol * lit * occlusion + rimCol;
          col = pow(col, vec3(0.86));

          // 湿润效果：雨天地面变暗，带轻微蓝青色调
          col = mix(col, col * vec3(0.58, 0.62, 0.68), wetness);

          // 6) 雾效混合
          float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
          col = mix(col, fogColor, clamp(fogFactor, 0.0, 1.0));

          gl_FragColor = vec4(col, 1.0);
        }
      `,
      side: THREE.DoubleSide,
      fog: false
    });
    const mesh = new THREE.Mesh(g, m);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = "terrain";
    terrainMaterial = m;  // 保存材质引用供天气联动更新 uniform
    return mesh;
  }

  /* ---------- 等高线（Marching Squares 复用 app.js contourSegments） ---------- */
  function buildContours(){
    const hm = HM(), rows = hm.h, cols = hm.w;
    const elev2d = [];
    for(let i = 0; i < rows; i++) elev2d.push(Array.prototype.slice.call(hm.elev, i*cols, (i+1)*cols));
    const pos = [];
    const lat0 = hm.lat_range[0], lat1 = hm.lat_range[1];
    const lon0 = hm.lon_range[0], lon1 = hm.lon_range[1];
    for(let lev = 700; lev <= 3000; lev += 300){
      if(lev < hm.min_elev || lev > hm.max_elev) continue;
      const segs = contourSegments(elev2d, lat0, lat1, lon0, lon1, lev);
      for(const sg of segs){
        const a = surfPt(sg[0][0], sg[0][1]);
        const b = surfPt(sg[1][0], sg[1][1]);
        pos.push(a.x, a.y + 0.03, a.z, b.x, b.y + 0.03, b.z);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    const m = new THREE.LineBasicMaterial({color: 0xffffff, transparent: true, opacity: 0.13});
    const line = new THREE.LineSegments(g, m);
    line.frustumCulled = false;
    return line;
  }

  /* ---------- 河流 ---------- */
  function buildRivers(){
    (TERR_G().rivers || []).forEach(rv => {
      const pts = rv.pts || [];
      if(pts.length < 2) return;
      const v3 = pts.map(p => surfPt(p[0], p[1]));
      const curve = new THREE.CatmullRomCurve3(v3, false, "centripetal", 0.5);
      const segs = Math.max(16, pts.length * 6);
      const r = 0.02;
      const body = new THREE.Mesh(
        new THREE.TubeGeometry(curve, segs, r, 6, false),
        new THREE.MeshLambertMaterial({color: 0x3b82d6, transparent: true, opacity: 0.72})
      );
      const core = new THREE.Mesh(
        new THREE.TubeGeometry(curve, segs, r * 0.45, 6, false),
        new THREE.MeshLambertMaterial({color: 0x9fd0ff, transparent: true, opacity: 0.85})
      );
      riversGroup.add(body, core);
    });
  }

  /* ---------- 道路（真实比例：高速≈26m宽，县乡道≈15m，路基/路面/中线三层） ---------- */
  const ROAD_STYLES = {
    "高速":   {base: 0.013, face: 0x8a929c, mid: 0xffffff},
    "国道":   {base: 0.012, face: 0xa8adb5, mid: 0xffffff},
    "省道":   {base: 0.011, face: 0xb6bbc1, mid: 0xffffff},
    "县道":   {base: 0.010, face: 0xbec3c9, mid: 0xffffff},
    "县乡道": {base: 0.008, face: 0xc4c9ce, mid: 0xeeeeee},
    "景区公路":{base: 0.009, face: 0xc9b28a, mid: 0xfff0c0}
  };
  function roadStyleOf(r){
    if(r.road_type && ROAD_STYLES[r.road_type]) return ROAD_STYLES[r.road_type];
    const n = r.name || "";
    if(n.includes("高速")) return ROAD_STYLES["高速"];
    if(n.includes("国道")) return ROAD_STYLES["国道"];
    if(n.includes("省道")) return ROAD_STYLES["省道"];
    if(n.includes("县道")) return ROAD_STYLES["县道"];
    if(n.includes("景区")) return ROAD_STYLES["景区公路"];
    return ROAD_STYLES["县乡道"];
  }
  function buildRoadLine(pts, style){
    const v3 = pts.map(p => surfPt(p[0], p[1]));
    if(v3.length < 2) return;
    const curve = new THREE.CatmullRomCurve3(v3, false, "centripetal", 0.5);
    const segs = Math.max(24, v3.length * 8);
    // 路基（暗色宽管，略微下压）
    const baseMesh = new THREE.Mesh(
      new THREE.TubeGeometry(curve, segs, style.base, 6, false),
      new THREE.MeshLambertMaterial({color: 0x0a0d12, transparent: true, opacity: 0.42})
    );
    baseMesh.position.y = -0.003;
    // 路面
    const faceMesh = new THREE.Mesh(
      new THREE.TubeGeometry(curve, segs, style.base * 0.55, 6, false),
      new THREE.MeshLambertMaterial({color: style.face})
    );
    faceMesh.receiveShadow = true;
    // 中线（细亮管）
    const midMesh = new THREE.Mesh(
      new THREE.TubeGeometry(curve, segs, style.base * 0.14, 5, false),
      new THREE.MeshLambertMaterial({color: style.mid})
    );
    midMesh.position.y = 0.001;
    roadsGroup.add(baseMesh, faceMesh, midMesh);
  }
  function buildRoads(){
    (TERR_G().roads || []).concat(TERR_G().roads_extra || []).forEach(r => {
      buildRoadLine(r.pts || [], roadStyleOf(r));
    });
  }

  /* ---------- 森林（程序生成树纹理 Sprite，按海拔带撒点） ---------- */
  function makeTreeTexture(kind){
    const cv = document.createElement("canvas");
    cv.width = 128; cv.height = 160;
    const ctx = cv.getContext("2d");
    // 树干
    ctx.fillStyle = kind === 2 ? "#5d4a33" : "#4a3826";
    ctx.fillRect(58, 96, 12, 40);
    ctx.fillStyle = kind === 2 ? "#7a6548" : "#5d4a33";
    ctx.fillRect(60, 96, 8, 40);
    // 树冠
    const cx = 64, cy = 66;
    if(kind === 0){
      // 阔叶：不规则冠簇 + 底部暗影
      const cols = [["#2a5f2e","#3d8a45","#57a65a"], ["#357238","#4f9c55","#6cb86e"], ["#3f7f44","#5aa860","#79c47c"]];
      const layers = [[64, 74, 36, 0], [40, 92, 25, 1], [88, 94, 25, 1], [58, 106, 27, 2], [78, 108, 22, 2]];
      for(const [lx, ly, rr, li] of layers){
        const g = ctx.createRadialGradient(lx-8, ly-10, 4, lx, ly, rr);
        g.addColorStop(0, cols[li][1]); g.addColorStop(1, cols[li][0]);
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(lx, ly, rr, 0, Math.PI * 2); ctx.fill();
      }
      // 冠底阴影（受光在左上，右下更暗）
      const sh = ctx.createLinearGradient(24, 60, 104, 136);
      sh.addColorStop(0, "rgba(10,30,12,0)");
      sh.addColorStop(1, "rgba(10,30,12,0.45)");
      ctx.globalCompositeOperation = "source-atop";
      ctx.fillStyle = sh;
      ctx.fillRect(0, 0, 128, 160);
      ctx.globalCompositeOperation = "source-over";
    } else if(kind === 1){
      // 针叶：五层下坠枝，冷杉形态
      const cols = ["#1f4a2c","#2c5f38","#3c7c4a","#57a06a","#6db87f"];
      for(let k = 0; k < 5; k++){
        const yTop = 26 + k * 17;
        const w = 14 + k * 6;              // 越往下越宽，呈下坠状
        const g = ctx.createLinearGradient(0, yTop, 0, yTop + 40);
        g.addColorStop(0, cols[Math.min(k + 1, 4)]);
        g.addColorStop(1, cols[Math.max(k - 1, 0)]);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(cx, yTop);
        ctx.lineTo(cx - w, yTop + 40);
        ctx.lineTo(cx + w, yTop + 40);
        ctx.closePath(); ctx.fill();
      }
    } else {
      // 高山灌丛：矮椭圆
      const g = ctx.createRadialGradient(cx-6, cy-14, 4, cx, cy, 34);
      g.addColorStop(0, "#9db86a"); g.addColorStop(1, "#5f7c3e");
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.ellipse(cx, cy, 30, 22, 0, 0, Math.PI * 2); ctx.fill();
    }
    return new THREE.CanvasTexture(cv);
  }
  function buildTrees(){
    const hm = HM();
    const lat0 = hm.lat_range[0], lat1 = hm.lat_range[1];
    const lon0 = hm.lon_range[0], lon1 = hm.lon_range[1];
    let seed = 20260814;
    const rnd = ()=>{ seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const mats = [
      new THREE.SpriteMaterial({map: makeTreeTexture(0), transparent: true, depthWrite: false, alphaTest: 0.35}),
      new THREE.SpriteMaterial({map: makeTreeTexture(1), transparent: true, depthWrite: false, alphaTest: 0.35}),
      new THREE.SpriteMaterial({map: makeTreeTexture(2), transparent: true, depthWrite: false, alphaTest: 0.35})
    ];
    const N = 3200;
    let placed = 0;
    for(let i = 0; i < N; i++){
      const lat = lat0 + rnd() * (lat1 - lat0);
      const lon = lon0 + rnd() * (lon1 - lon0);
      const e = elevAt(lat, lon);
      let density = 0;
      if(e >= 900 && e < 1900)      density = 0.18 + (e - 900) / 1000 * 0.14;
      else if(e >= 1900 && e < 2620) density = 0.38;
      else if(e >= 2620 && e < 2820) density = 0.18;
      else if(e >= 700 && e < 900)  density = 0.08;
      else if(e >= 2820)            density = 0.04;
      if(rnd() > density) continue;
      if(slopeDegAt(lat, lon) > 42) continue;
      let kind = e < 1400 ? 0 : (e < 2200 ? (rnd() < 0.55 ? 1 : 0) : (e >= 2700 ? 2 : 1));
      // 真实比例：树高约 25-35m（× 地形3倍垂直夸张 ≈ 0.06-0.1 单位）
      const s = 0.048 + rnd() * 0.04;
      const p = surfPt(lat, lon);
      const mat = mats[kind].clone();      // 每树独立材质，避免共享 rotation
      mat.rotation = rnd() * Math.PI;
      const sp = new THREE.Sprite(mat);
      sp.position.set(p.x, p.y + s * 0.62, p.z);
      sp.scale.set(s, s * 1.25, 1);
      sp.frustumCulled = true;
      treesGroup.add(sp);
      placed++;
    }
    return placed;
  }

  /* ---------- 哀牢山云雾层（半透明精灵，缓慢漂移） ---------- */
  function makeCloudTexture(){
    const cv = document.createElement("canvas");
    cv.width = 256; cv.height = 128;
    const ctx = cv.getContext("2d");
    const g = ctx.createRadialGradient(128, 64, 8, 128, 64, 110);
    g.addColorStop(0, "rgba(255,255,255,0.92)");
    g.addColorStop(0.35, "rgba(230,240,250,0.55)");
    g.addColorStop(0.7, "rgba(200,215,230,0.18)");
    g.addColorStop(1, "rgba(180,200,220,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 128);
    // 叠加噪点让云更自然
    for(let i = 0; i < 220; i++){
      const x = Math.random() * 256, y = Math.random() * 128;
      const r = Math.random() * 18 + 4;
      const gg = ctx.createRadialGradient(x, y, 0, x, y, r);
      gg.addColorStop(0, "rgba(255,255,255," + (Math.random() * 0.25 + 0.08) + ")");
      gg.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = gg;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.needsUpdate = true;
    return tex;
  }
  function buildClouds(){
    const hm = HM();
    const lat0 = hm.lat_range[0], lat1 = hm.lat_range[1];
    const lon0 = hm.lon_range[0], lon1 = hm.lon_range[1];
    const tex = makeCloudTexture();
    const mat = new THREE.SpriteMaterial({map: tex, transparent: true, depthWrite: false, opacity: 0.55});
    let seed = 20260815;
    const rnd = ()=>{ seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    // 山腰云雾带：海拔 1400-2400m 之间，多层分布
    for(let i = 0; i < 46; i++){
      const lat = lat0 + rnd() * (lat1 - lat0);
      const lon = lon0 + rnd() * (lon1 - lon0);
      const e = elevAt(lat, lon);
      // 云雾集中在 1400-2600m，山顶偶尔有
      const band = e >= 1400 && e <= 2600 ? 1 : (e > 2600 && e <= 3000 ? 0.35 : 0.12);
      if(rnd() > band) continue;
      const p = surfPt(lat, lon);
      const sp = new THREE.Sprite(mat.clone());
      const s = 1.2 + rnd() * 2.6;
      sp.scale.set(s * 1.8, s * 0.72, 1);
      sp.position.set(p.x + (rnd() - 0.5) * 2.2, p.y + 0.6 + rnd() * 1.4, p.z + (rnd() - 0.5) * 2.2);
      sp.userData.driftSpeed = 0.00012 + rnd() * 0.00022;
      sp.userData.driftPhase = rnd() * Math.PI * 2;
      sp.userData.baseX = sp.position.x;
      sp.userData.baseZ = sp.position.z;
      cloudsGroup.add(sp);
    }
    // 山顶高空云：少量大尺度
    for(let i = 0; i < 10; i++){
      const lat = lat0 + rnd() * (lat1 - lat0);
      const lon = lon0 + rnd() * (lon1 - lon0);
      const e = elevAt(lat, lon);
      if(e < 2200) continue;
      const p = surfPt(lat, lon);
      const sp = new THREE.Sprite(mat.clone());
      const s = 3.0 + rnd() * 3.2;
      sp.scale.set(s * 2.2, s * 0.9, 1);
      sp.position.set(p.x, p.y + 2.2 + rnd() * 1.8, p.z);
      sp.material.opacity = 0.38;
      sp.userData.driftSpeed = 0.00008 + rnd() * 0.00012;
      sp.userData.driftPhase = rnd() * Math.PI * 2;
      sp.userData.baseX = sp.position.x;
      sp.userData.baseZ = sp.position.z;
      cloudsGroup.add(sp);
    }
  }

  /* ---------- 3D 雨粒子系统 ---------- */
  function buildRain(){
    const N = 1500;
    const positions = new Float32Array(N * 3);
    const velocities = new Float32Array(N);
    const hm = HM();
    const cx = 0, cz = 0;
    const range = 14;  // 覆盖范围
    const yTop = 9, yBot = -1;
    for(let i = 0; i < N; i++){
      positions[i*3]   = cx + (Math.random() - 0.5) * range * 2;
      positions[i*3+1] = yBot + Math.random() * (yTop - yBot);
      positions[i*3+2] = cz + (Math.random() - 0.5) * range * 2;
      velocities[i] = 0.12 + Math.random() * 0.10;  // 下落速度
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const m = new THREE.PointsMaterial({
      color: 0xb8d4f0, size: 0.06, transparent: true, opacity: 0.55,
      depthWrite: false, sizeAttenuation: true
    });
    const pts = new THREE.Points(g, m);
    pts.userData.velocities = velocities;
    pts.userData.yTop = yTop;
    pts.userData.yBot = yBot;
    pts.userData.range = range;
    pts.frustumCulled = false;
    rainGroup.add(pts);
  }

  /* ---------- 天气驱动 3D 场景联动（核心创新） ----------
   * 将实时气象数据映射到 3D 场景：
   *   能见度 → 雾密度 + 背景色
   *   云量   → 太阳光强度/色温 + 云层不透明度
   *   降水   → 雨粒子 + 地形湿润着色 + 场景整体变暗
   *   风速   → 云层漂移速度 + 雨粒子倾斜
   * ---------------------------------------------------------------- */
  window.applyWeatherTo3D = function(w){
    if(!initialized || !scene) return;
    if(!w) return;
    weatherState = w;

    const vis    = w.vis != null ? w.vis : 10;       // km
    const cloud  = w.cloud != null ? w.cloud : 30;   // %
    const precip = w.precip != null ? w.precip : 0;  // mm/h
    const ws     = w.ws != null ? w.ws : 2;          // m/s
    const rh     = w.rh != null ? w.rh : 60;         // %

    // 1) 雾密度：能见度越低雾越浓
    let fogD;
    if(vis >= 10)      fogD = 0.005;
    else if(vis >= 5)  fogD = 0.010 + (10 - vis) * 0.003;
    else if(vis >= 2)  fogD = 0.025 + (5 - vis) * 0.012;
    else               fogD = 0.065 + (2 - vis) * 0.040;
    fogD = Math.min(fogD, 0.18);

    // 2) 场景背景色 & 雾色：晴天亮蓝灰 → 阴天灰蓝 → 雨天暗灰蓝 → 雾天乳灰
    let bgR, bgG, bgB;
    const cloudFactor = cloud / 100;
    const rainFactor = Math.min(precip / 10, 1);
    const fogFactor = vis < 2 ? 1 : vis < 5 ? 0.5 : 0;
    // 基色 0x4a6b8a = (74, 107, 138)
    bgR = 74 - cloudFactor * 18 - rainFactor * 22 + fogFactor * 40;
    bgG = 107 - cloudFactor * 12 - rainFactor * 18 + fogFactor * 35;
    bgB = 138 - cloudFactor * 8  - rainFactor * 10 + fogFactor * 25;
    const bgColor = new THREE.Color(bgR/255, bgG/255, bgB/255);
    scene.background = bgColor;
    scene.fog.color = bgColor;
    scene.fog.density = fogD;

    // 3) 太阳光强度 & 色温
    const sunInt = Math.max(0.15, 1.0 - cloudFactor * 0.65 - rainFactor * 0.25);
    const ambInt = Math.max(0.35, 1.0 - cloudFactor * 0.30 - rainFactor * 0.15);
    if(sunLight){
      sunLight.intensity = 1.55 * sunInt;
      // 色温：晴天暖白 → 阴天冷灰
      const sr = Math.round(255 - cloudFactor * 35 - rainFactor * 20);
      const sg = Math.round(242 - cloudFactor * 30 - rainFactor * 15);
      const sb = Math.round(216 - cloudFactor * 10 + rainFactor * 20);
      sunLight.color.setRGB(sr/255, sg/255, sb/255);
    }
    if(hemiLight) hemiLight.intensity = 0.65 * ambInt;

    // 4) 地形着色器 uniform 同步
    if(terrainMaterial){
      terrainMaterial.uniforms.fogColor.value = bgColor;
      terrainMaterial.uniforms.fogDensity.value = fogD;
      terrainMaterial.uniforms.sunIntensity.value = sunInt;
      terrainMaterial.uniforms.ambientIntensity.value = ambInt;
      // 湿润度：降水越大越湿
      terrainMaterial.uniforms.wetness.value = Math.min(precip / 8, 0.85);
    }

    // 5) 云层：不透明度 & 高度随天气变化
    if(cloudsGroup){
      const cloudOp = 0.30 + cloudFactor * 0.45 + rainFactor * 0.15;  // 0.30 ~ 0.90
      const cloudLower = rainFactor * 0.8 + fogFactor * 1.2;           // 云层下降量
      for(const sp of cloudsGroup.children){
        sp.material.opacity = Math.min(cloudOp, 0.95);
        sp.userData.driftSpeedMul = 1.0 + ws * 0.08;  // 风速影响漂移速度
        // 云层下降：降低 y 坐标
        if(sp.userData.baseY == null) sp.userData.baseY = sp.position.y;
        sp.position.y = sp.userData.baseY - cloudLower;
      }
    }

    // 6) 雨粒子：降水 > 0.1mm 时显示
    if(rainGroup){
      rainGroup.visible = precip > 0.1;
      if(rainGroup.visible && rainGroup.children[0]){
        const pts = rainGroup.children[0];
        const mat = pts.material;
        // 降水强度影响粒子数量（通过透明度模拟）和大小
        mat.opacity = Math.min(0.3 + precip * 0.06, 0.7);
        mat.size = 0.04 + Math.min(precip * 0.008, 0.06);
        // 风速影响雨倾斜（通过偏移 x）
        pts.userData.windOffset = ws * 0.003;
      }
    }

    // 7) 天气状态徽章
    const badge = $("weather3DBadge");
    if(badge){
      let icon = "☀️", label = "晴朗";
      if(precip > 0.1){ icon = "🌧️"; label = precip > 5 ? "大雨" : "有雨"; }
      else if(vis < 2){ icon = "🌫️"; label = "大雾"; }
      else if(cloud > 80){ icon = "☁️"; label = "阴天"; }
      else if(cloud > 40){ icon = "⛅"; label = "多云"; }
      badge.style.display = "block";
      badge.innerHTML = icon + " " + label + " · " + Math.round(w.temp||0) + "°C · 能见度 " + (vis != null ? vis + "km" : "—") +
        " · 云量 " + Math.round(cloud) + "%" +
        (precip > 0.1 ? " · 降水 " + Math.round(precip*10)/10 + "mm/h" : "");
    }
  };

  /* ---------- 地名悬浮标签（CanvasTexture Sprite + 引线） ---------- */
  const LABEL_COLORS = {
    county: "#ffe082", wp: "#a8ffbc", wpClosed: "#ff9e9e", forbid: "#ff7a7a",
    peak: "#e8eaf6", region: "#ffd54f", river: "#42a5f5", road: "#ffab40"
  };

  /* 地理地标（山峰 / 保护区 / 河流 / 道路 / 县名） */
  const GEO_LANDMARKS = [
    // —— 山峰 ——
    {lat:24.03, lon:101.02, name:"大雪锅山",   kind:"peak", note:"哀牢山最高峰 3137.6m · 核心区禁入"},
    {lat:24.07, lon:101.05, name:"小雪锅山",   kind:"peak", note:"海拔约2900m · 主脊西侧"},
    {lat:24.20, lon:100.97, name:"打雀山",     kind:"peak", note:"海拔约2700m · 鸟类迁徙通道"},
    {lat:24.38, lon:100.99, name:"北段主脊",   kind:"peak", note:"海拔2800m+ · 哀牢山北段分水岭"},
    {lat:24.52, lon:101.00, name:"北段高峰",   kind:"peak", note:"海拔约2600m · 接近徐家坝站"},
    // —— 保护区 / 区域 ——
    {lat:24.30, lon:101.00, name:"哀牢山国家级自然保护区", kind:"region", note:"核心区·缓冲区·实验区三级管理"},
    {lat:23.95, lon:100.98, name:"镇沅片区",   kind:"region", note:"千家寨周边 · 2021年事故区域 · 严禁进入"},
    {lat:24.55, lon:101.00, name:"徐家坝片区", kind:"region", note:"中科院哀牢山生态站 · 科研禁区"},
    // —— 县名 ——
    {lat:24.07, lon:101.75, name:"新平县",     kind:"county", note:"戛洒镇所属 · 哀牢山东麓"},
    {lat:24.69, lon:101.75, name:"双柏县",     kind:"county", note:"妥甸镇·县城 · 哀牢山北段东坡"},
    {lat:23.90, lon:101.10, name:"镇沅县",     kind:"county", note:"哀牢山西坡 · 千家寨所在地"},
    // —— 河流（取中段标注） ——
    {lat:24.08, lon:101.47, name:"平江河",     kind:"river", note:"哀牢山东坡主要水系"},
    {lat:24.25, lon:101.81, name:"元江",       kind:"river", note:"红河上游 · 哀牢山东界"},
    {lat:24.13, lon:100.91, name:"者干河",     kind:"river", note:"哀牢山西坡水系 · 汇入把边江"},
    // —— 道路 ——
    {lat:24.00, lon:101.52, name:"恩水公路",   kind:"road", note:"景区主线 · 戛洒→金山丫口"},
    {lat:24.42, lon:101.30, name:"哀牢山公路", kind:"road", note:"双柏段县乡道 · 沿山脊展线"},
    {lat:24.10, lon:101.65, name:"G227",      kind:"road", note:"国道227 · 新平段"},
  ];
  function makeLabelTexture(main, sub, color){
    const cv = document.createElement("canvas");
    const W = 960, H = 160;
    cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, W, H);
    // 更深的半透明底 + 加粗彩色边框，提升对比度
    ctx.fillStyle = "rgba(10,18,32,0.66)";
    const r = 20;
    ctx.beginPath();
    ctx.moveTo(r + 12, 16); ctx.arcTo(W - 12, 16, W - 12, H - 16, r);
    ctx.arcTo(W - 12, H - 16, 12, H - 16, r); ctx.arcTo(12, H - 16, 12, 16, r); ctx.arcTo(12, 16, W - 12, 16, r);
    ctx.closePath(); ctx.fill();
    ctx.lineWidth = 5; ctx.strokeStyle = color; ctx.stroke();
    // 文字发光/描边，远距离更清晰
    ctx.shadowColor = "rgba(0,0,0,0.85)";
    ctx.shadowBlur = 5;
    ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 2;
    ctx.textAlign = "center";
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 40px 'PingFang SC','Microsoft YaHei',sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText(main, W/2, sub ? 50 : 70);
    if(sub){
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      ctx.font = "22px 'PingFang SC','Microsoft YaHei',sans-serif";
      ctx.fillText(sub, W/2, 96);
    }
    // 重置阴影
    ctx.shadowColor = "transparent";
    return new THREE.CanvasTexture(cv);
  }
  function addLabel(lat, lon, main, sub, kind, note){
    const p = surfPt(lat, lon);
    const col = LABEL_COLORS[kind] || "#ffe082";
    // 根据类型和文字长度调整标签尺寸（sizeAttenuation=false 保证远距离也清晰可见）
    const mainLen = (main || "").length;
    let sw = 0.95, sh = 0.20, yOff = 0.72;
    if(kind === "peak"){ sw = 0.78; sh = 0.18; yOff = 0.66; }
    else if(kind === "river" || kind === "road"){ sw = 0.72; sh = 0.16; yOff = 0.56; }
    else if(kind === "region"){ sw = Math.min(2.0, 1.1 + mainLen * 0.085); sh = 0.24; yOff = 0.80; }
    else if(kind === "county" && mainLen > 4){ sw = 0.88; }
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeLabelTexture(main, sub, col), transparent: true, depthTest: true,
      sizeAttenuation: false
    }));
    sprite.position.set(p.x, p.y + yOff, p.z);
    // sizeAttenuation=false：标签保持固定屏幕大小；0.26 在清晰与遮挡之间取平衡
    sprite.scale.set(sw * 0.26, sh * 0.26, 1);
    sprite.userData = {lat, lon, main, sub, note, kind, baseScale: {x: sw * 0.26, y: sh * 0.26}};
    labelsGroup.add(sprite);
    // 引线（从标签底到地表）
    const lg = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(p.x, p.y + 0.08, p.z),
      new THREE.Vector3(p.x, p.y + yOff - 0.12, p.z)
    ]);
    const lineColor = kind === "peak" ? 0xe8eaf6 : (kind === "river" ? 0x42a5f5 : (kind === "region" ? 0xffd54f : 0xffffff));
    const line = new THREE.Line(lg, new THREE.LineBasicMaterial({color: lineColor, transparent: true, opacity: 0.5}));
    labelsGroup.add(line);
    // 山峰：在引线底部加一个小亮点标记
    if(kind === "peak"){
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(0.04, 8, 8),
        new THREE.MeshBasicMaterial({color: 0xe8eaf6})
      );
      dot.position.set(p.x, p.y + 0.06, p.z);
      labelsGroup.add(dot);
    }
  }
  function buildLabels(){
    // 1) 城镇标签
    (TERR_G().towns || []).forEach(t => {
      addLabel(t.lat, t.lon, t.name, (t.cls === "县城" ? "县城 · " : "") + Math.round(t.pop) + "万人", "county", t.cls);
    });
    // 2) 景区/站点标签
    (WAYPOINTS || []).forEach(wp => {
      const name = wp.name.replace(/\(.*?\)/g, "").replace(/景区$/, "").replace(/观景台$/, "");
      addLabel(wp.lat, wp.lon, name, "海拔 " + wp.elev + "m", wp.open ? "wp" : "wpClosed", wp.note);
    });
    // 3) 地理地标（山峰 / 保护区 / 河流 / 道路 / 县名）
    (GEO_LANDMARKS || []).forEach(g => {
      let sub = "";
      const col = LABEL_COLORS[g.kind] || "#ffe082";
      // 山峰：自动标注 DEM 实际海拔
      if(g.kind === "peak"){
        const e = elevAt(g.lat, g.lon);
        sub = "海拔 " + Math.round(e) + "m";
      }
      // 河流 / 道路 / 保护区：用预设 sub
      else if(g.kind === "river" || g.kind === "road"){
        sub = g.kind === "river" ? "河流" : "道路";
      } else if(g.kind === "region"){
        sub = "保护区";
      } else if(g.kind === "county" && g.note && g.note.includes("县城")){
        sub = "县城";
      }
      addLabel(g.lat, g.lon, g.name, sub, g.kind, g.note);
    });
  }

  /* ---------- 禁区（半透明红色面片 + 标签） ---------- */
  function buildForbiddenZones(){
    (FORBIDDEN_ZONES || []).forEach(z => {
      const pts = z.polygon.map(p => surfPt(p[0], p[1]));
      if(pts.length < 3) return;
      const pos = [];
      for(let i = 1; i < pts.length - 1; i++){
        pos.push(pts[0].x, pts[0].y + 0.06, pts[0].z);
        pos.push(pts[i].x, pts[i].y + 0.06, pts[i].z);
        pos.push(pts[i+1].x, pts[i+1].y + 0.06, pts[i+1].z);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
        color: 0xff3b30, transparent: true, opacity: 0.26, side: THREE.DoubleSide, depthWrite: false
      }));
      mesh.userData = {forbid: true, name: z.name, desc: z.desc};
      forbiddenGroup.add(mesh);
      // 中心点标签
      let clat = 0, clon = 0;
      z.polygon.forEach(p => { clat += p[0]; clon += p[1]; });
      clat /= z.polygon.length; clon /= z.polygon.length;
      addLabel(clat, clon, z.name.replace(/核心区|辖区|片区/g, ""), "⛔ 禁入", "forbid", z.desc);
    });
  }

  /* ---------- 旅游模式：3 条推荐徒步路线 ---------- */
  function buildTourRoutes(){
    const wp = {};
    (WAYPOINTS || []).forEach(w => wp[w.id] = w);
    const routes = [
      {name: "① 耳海环线 · 入门轻徒步", color: 0x4fc3f7, ids: ["gasa", "nanen"]},
      {name: "② 石门峡→茶马古道→金山原始森林", color: 0xffb74d, ids: ["shimen", "chama", "jinshan"]},
      {name: "③ 金山丫口观景 · 日出挑战线", color: 0xf48fb1, ids: ["jinshan", "jinshanyakou"]}
    ];
    routes.forEach(rt => {
      const pts = rt.ids.map(id => wp[id]).filter(Boolean);
      if(pts.length < 2) return;
      const v3 = pts.map(p => surfPt(p.lat, p.lon));
      const curve = new THREE.CatmullRomCurve3(v3, false, "centripetal", 0.5);
      tourCurves.push({name: rt.name, color: rt.color, curve});   // 供相机飞行
      const tube = new THREE.Mesh(
        new THREE.TubeGeometry(curve, 64, 0.014, 8, false),
        new THREE.MeshLambertMaterial({color: rt.color, emissive: rt.color, emissiveIntensity: 0.3})
      );
      tube.position.y = 0.012;
      tube.userData = {route: rt.name};
      routesGroup.add(tube);
      // 端点光点
      v3.forEach(v => {
        const dot = new THREE.Mesh(
          new THREE.SphereGeometry(0.03, 10, 10),
          new THREE.MeshBasicMaterial({color: rt.color})
        );
        dot.position.set(v.x, v.y + 0.1, v.z);
        routesGroup.add(dot);
      });
      // 中间标签
      const midLat = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
      const midLon = pts.reduce((s, p) => s + p.lon, 0) / pts.length;
      const mid = surfPt(midLat, midLon);
      const tSprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: makeLabelTexture(rt.name.replace(/^\d+\s*/, ""), "推荐徒步路线", "#" + rt.color.toString(16).padStart(6, "0")),
        transparent: true, depthTest: true, sizeAttenuation: false
      }));
      tSprite.position.set(mid.x, mid.y + 0.75, mid.z);
      tSprite.scale.set(0.42, 0.085, 1);
      routesGroup.add(tSprite);
    });
  }

  /* ---------- 3D 指北针 ---------- */
  function buildCompass(){
    const g = new THREE.Group();
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.05, 1.1, 8),
      new THREE.MeshBasicMaterial({color: 0x8fa3c0})
    );
    shaft.position.y = 0.55;
    const head = new THREE.Mesh(
      new THREE.ConeGeometry(0.13, 0.5, 10),
      new THREE.MeshBasicMaterial({color: 0xff5252})
    );
    head.position.y = 1.2;
    const nTex = makeLabelTexture("N", "", "#ff5252");
    const nSprite = new THREE.Sprite(new THREE.SpriteMaterial({map: nTex, transparent: true, sizeAttenuation: false}));
    nSprite.position.y = 1.65;
    nSprite.scale.set(0.14, 0.03, 1);
    g.add(shaft, head, nSprite);
    // 放置于地形西北角外
    const hm = HM();
    g.position.set(lon2x(hm.lon_range[0]) + 0.5, 1.4, lat2z(hm.lat_range[1]) - 0.4);
    scene.add(g);
  }

  /* ---------- 交互：hover 显示海拔/坡度/风险增强 ---------- */
  function onMouseMove(e){
    const dom = renderer.domElement;
    const rect = dom.getBoundingClientRect();
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);

    // 1) 标签 hover
    const labelHits = raycaster.intersectObjects(labelsGroup.children, false);
    if(labelHits.length){
      const u = labelHits[0].object.userData;
      if(u.main){
        showTooltip(e, u, true);
        return;
      }
    }
    // 2) 禁区 hover
    const forbHits = raycaster.intersectObjects(forbiddenGroup.children, false);
    if(forbHits.length && forbHits[0].object.userData.forbid){
      const u = forbHits[0].object.userData;
      showTooltip(e, {main: "⛔ " + u.name, sub: "", note: u.desc}, false);
      return;
    }
    // 3) 地形 hover
    const hits = raycaster.intersectObject(terrainMesh, false);
    if(hits.length){
      const pt = hits[0].point;
      const lon = HM().lon_range[0] + (pt.x + X0) / KX;
      const lat = HM().lat_range[0] + (pt.z + Z0) / KZ;
      const e = elevAt(lat, lon);
      const slope = slopeDegAt(lat, lon);
      let riskHtml = "";
      if(TR3D() && TR3D().grid_risk_3d){
        const rk = lat.toFixed(2) + "," + lon.toFixed(2);
        const r = TR3D().grid_risk_3d[rk];
        if(r){
          riskHtml = `<div style="margin-top:4px;color:#8fa3c0;font-size:11px">
            风 +${(r.wind_enhance*100).toFixed(0)}% · 雾 +${(r.fog_enhance*100).toFixed(0)}%
            · 泥石流 +${(r.debris_enhance*100).toFixed(0)}% · 雷电 +${(r.lightning_enhance*100).toFixed(0)}%</div>`;
        }
      }
      showTooltip(e, {
        main: `${lat.toFixed(3)}, ${lon.toFixed(3)}`,
        sub: `海拔 ${e.toFixed(0)}m · 坡度 ${slope.toFixed(1)}°`,
        note: "",
        extra: riskHtml
      }, false);
    } else {
      hideTooltip();
    }
  }
  function showTooltip(e, u, isLabel){
    const tt = $("three3DTooltip");
    if(!tt) return;
    const dom = renderer.domElement;
    const rect = dom.getBoundingClientRect();
    tt.innerHTML = `<div class="tip-main">${u.main}</div>` +
      (u.sub ? `<div class="tip-sub">${u.sub}</div>` : "") +
      (u.note ? `<div class="tip-note">${u.note}</div>` : "") +
      (u.extra || "");
    tt.style.display = "block";
    let x = e.clientX - rect.left + 16, y = e.clientY - rect.top + 16;
    if(x + 220 > rect.width) x = e.clientX - rect.left - 224;
    if(y + 120 > rect.height) y = e.clientY - rect.top - 110;
    tt.style.left = x + "px";
    tt.style.top = y + "px";
  }
  function hideTooltip(){
    const tt = $("three3DTooltip");
    if(tt) tt.style.display = "none";
  }

  /* ---------- 3D 点击：显示该点海拔/坡度/当地天气 ---------- */
  function nearestPlaceName(lat, lon){
    let best = null, bd = 1e9;
    const cands = [];
    (window.WAYPOINTS || []).forEach(wp => cands.push({name: wp.name.replace(/\(.*?\)/g,""), lat: wp.lat, lon: wp.lon}));
    GEO_LANDMARKS.forEach(g => cands.push({name: g.name, lat: g.lat, lon: g.lon}));
    for(const c of cands){
      const d = Math.hypot(c.lat - lat, c.lon - lon) * 111;
      if(d < bd){ bd = d; best = c; }
    }
    return best && bd < 14 ? best.name + (bd > 6 ? " 附近" : "") : "所选位置";
  }
  /* ---------- 景点一键聚焦（app.js 景点模块调用） ---------- */
  function fillClickInfo(lat, lon, nameOverride){
    const panel = $("three3DClickInfo");
    if(!panel) return;
    const e2 = elevAt(lat, lon);
    const slope = slopeDegAt(lat, lon);
    let w = null;
    try{ w = window.__weatherAt ? window.__weatherAt(lat, lon) : null; }catch(err){}
    const name = nameOverride || nearestPlaceName(lat, lon);
    const row = (k, v, col) => '<div class="ci-row"><span>'+k+'</span><b style="'+(col?'color:'+col+';':'')+'">'+v+'</b></div>';
    let rows = row("海拔", Math.round(e2) + " m") + row("坡度", slope.toFixed(1) + "°");
    if(w && w.series && w.series.length){
      const cur = w.series[0];
      const next24 = w.series.slice(0, 24);
      const totalP = next24.reduce((a,s)=>a+(s.precip||0), 0);
      const maxWg = Math.max(...next24.map(s=>s.wg||0));
      const maxT = Math.max(...next24.map(s=>s.temp)), minT = Math.min(...next24.map(s=>s.temp));
      const csp = (typeof window.__cloudSeaProb === "function") ? window.__cloudSeaProb(cur.rh, maxT - minT, cur.ws) : null;
      const tempCol = cur.temp >= 22 ? "#e8a35c" : cur.temp <= 5 ? "#62c4e8" : "#fff";
      rows += row("当前气温", cur.temp + "°C", tempCol);
      rows += row("湿度 / 云量", Math.round(cur.rh) + "% / " + Math.round(cur.cloud) + "%");
      rows += row("阵风", Math.round(maxWg*10)/10 + " m/s");
      rows += row("24h 降水", Math.round(totalP*10)/10 + " mm");
      rows += row("云海概率", csp != null ? csp + "%" : "—", csp != null && csp >= 70 ? "#62c4e8" : csp != null && csp >= 45 ? "#6fd39a" : "#fff");
      rows += row("强对流峰值", Math.round(w.peakP*100) + "%", w.peakP >= 0.5 ? "#f0646c" : w.peakP >= 0.3 ? "#e3cf7d" : "#6fd39a");
      rows += row("浓雾峰值", Math.round(w.peakF*100) + "%", w.peakF >= 0.5 ? "#f0646c" : w.peakF >= 0.3 ? "#e3cf7d" : "#6fd39a");
      rows += row("能见度", cur.vis != null ? cur.vis + " km" : "—");
    } else {
      rows += row("天气", "数据加载中…");
    }
    const h = panel.querySelector("#ciHead"), s = panel.querySelector("#ciSub");
    if(h) h.textContent = "📍 " + name;
    if(s) s.textContent = lat.toFixed(3) + "°N, " + lon.toFixed(3) + "°E";
    const rowsEl = document.getElementById("ciRows");
    if(rowsEl) rowsEl.innerHTML = rows;
    panel.style.display = "block";
  }
  window.flyToPlace = function(lat, lon, name, elev){
    const panel3d = $("terrain3DPanel");
    if(!initialized || !camera || !controls || !terrainMesh){
      // 3D 未就绪：确保面板可见并滚动过去
      if(panel3d) panel3d.style.display = "block";
      if(panel3d && panel3d.scrollIntoView) panel3d.scrollIntoView({behavior:"smooth", block:"start"});
      setTimeout(()=> window.flyToPlace && window.flyToPlace(lat, lon, name, elev), 800);
      return;
    }
    if(panel3d && panel3d.scrollIntoView) panel3d.scrollIntoView({behavior:"smooth", block:"start"});
    stopFly();
    const x = lon2x(lon), z = lat2z(lat);
    const y = elevAt(lat, lon) * VERT;
    const dist = Math.max(9, 7 + (elev||1500) / 700);
    const camPos = new THREE.Vector3(x + dist * 0.62, y + dist * 0.78, z + dist * 0.62);
    flyTo(camPos, new THREE.Vector3(x, y + 0.5, z));
    // 飞行到位后填充信息卡
    setTimeout(()=> fillClickInfo(lat, lon, name), 1450);
    // 高亮对应景点按钮
    document.querySelectorAll("#poiGrid .poi-btn").forEach(b=> b.classList.remove("active"));
    setTimeout(()=>{
      document.querySelectorAll("#poiGrid .poi-btn").forEach(b=>{
        if(b.textContent.indexOf(name) >= 0) b.classList.add("active");
      });
    }, 200);
  };

  function onTerrainClick(e){
    const dom = renderer.domElement;
    const rect = dom.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const my = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(new THREE.Vector2(mx, my), camera);
    const hits = raycaster.intersectObject(terrainMesh, false);
    if(!hits.length) return;
    const pt = hits[0].point;
    const lon = HM().lon_range[0] + (pt.x + X0) / KX;
    const lat = HM().lat_range[0] + (pt.z + Z0) / KZ;
    fillClickInfo(lat, lon, null);
  }
  window.closeClickInfo = function(){
    const panel = $("three3DClickInfo");
    if(panel) panel.style.display = "none";
  };

  /* ---------- 路线相机飞行（点击路线按钮后沿路线巡航） ---------- */
  let camAnimToken = 0;    // 相机动画令牌：新动画启动时令旧 flyTo 失效，避免两个动画争夺相机
  let fpFlying = false;    // 第一视角飞行中标志（渲染循环据此跳过 controls.update）
  function endFpFlight(){
    if(fpFlying){
      fpFlying = false;
      camera.fov = 50; camera.updateProjectionMatrix();
      controls.autoRotate = false;   // 飞行结束后停在用户可控视角，不再自动旋转
      controls.update();             // 交还 OrbitControls（它会从当前相机位置重新同步）
    }
  }
  function stopFly(){
    flyState = null;
    endFpFlight();
  }
  window.stopRouteFly = stopFly;
  function flyRoute(i){
    if(!initialized || !tourCurves.length) return;
    const rc = tourCurves[i];
    if(!rc) return;
    stopFly();
    ++camAnimToken;                  // 取消进行中的 flyTo 飞行动画
    // 显示路线并高亮按钮
    tourMode = true;
    routesGroup.visible = true;
    const tb = $("tourBtn"); if(tb) tb.classList.add("active");
    document.querySelectorAll("#three3DRoutes .rbtn").forEach((b, k)=> b.classList.toggle("active", k === i));
    // 采样曲线点
    const N = 240;
    const pts = [];
    for(let k = 0; k < N; k++) pts.push(rc.curve.getPoint(k / (N - 1)));
    const D = 12000;              // 全程 12 秒
    // 无人机视角：标准 FOV
    camera.fov = 50;
    camera.updateProjectionMatrix();
    controls.autoRotate = false;
    fpFlying = true;
    const t0 = performance.now();
    let last = -1;
    // 由世界坐标反查地形真实海拔（防止平滑曲线从山脊下方穿过）
    function groundY(x, z){
      const lon = HM().lon_range[0] + (x + X0) / KX;
      const lat = HM().lat_range[0] + (z + Z0) / KZ;
      return elevAt(lat, lon) * VERT;
    }
    function step(now){
      if(flyState !== step){ endFpFlight(); return; }
      const t = Math.min(1, (now - t0) / D);
      const idx = Math.floor(t * (N - 1));
      if(idx !== last){
        last = idx;
        const p = pts[idx];
        const nxt = pts[Math.min(N - 1, idx + 16)];
        // 无人机视角：相机悬于路线侧上方俯瞰路径；钳制在地形之上防穿模
        const eyeY = Math.max(p.y + 2.8, groundY(p.x + 1.4, p.z + 1.4) + 1.6);
        camera.position.set(p.x + 1.4, eyeY, p.z + 1.4);
        const tgY = Math.max(nxt.y + 0.9, groundY(nxt.x, nxt.z) + 0.5);
        controls.target.set(nxt.x, tgY, nxt.z);
        camera.lookAt(controls.target);
      }
      if(t < 1){ requestAnimationFrame(step); }
      else { flyState = null; endFpFlight(); }
    }
    flyState = step;
    requestAnimationFrame(step);
  }

  /* ---------- 卫星影像贴图（Esri World Imagery，官方瓦片服务支持 CORS） ---------- */
  let satLoaded = false, satOn = false;
  function lon2tileX(lon, z){ return (lon + 180) / 360 * Math.pow(2, z); }
  function lat2tileY(lat, z){
    const r = lat * Math.PI / 180;
    return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z);
  }
  function loadTile(url){
    return new Promise(res => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = ()=> res(img);
      img.onerror = ()=> res(null);
      img.src = url;
    });
  }
  async function loadSatellite(){
    if(satLoaded || !terrainMaterial) return;
    try{
      const hm = HM();
      const lat0 = hm.lat_range[0], lat1 = hm.lat_range[1];
      const lon0 = hm.lon_range[0], lon1 = hm.lon_range[1];
      // 自动选合适的缩放级别（瓦片总数 ≤ 64，兼顾清晰度与加载速度）
      let z = 13;
      for(; z >= 10; z--){
        const n = (Math.floor(lon2tileX(lon1,z)) - Math.floor(lon2tileX(lon0,z)) + 1)
                * (Math.floor(lat2tileY(lat0,z)) - Math.floor(lat2tileY(lat1,z)) + 1);
        if(n <= 64) break;
      }
      const xL = lon2tileX(lon0, z), xR = lon2tileX(lon1, z);
      const yT = lat2tileY(lat1, z), yB = lat2tileY(lat0, z);
      const W = 1024, H = Math.max(256, Math.round(W * (yB - yT) / (xR - xL)));
      const cv = document.createElement("canvas");
      cv.width = W; cv.height = H;
      const ctx = cv.getContext("2d");
      const tx0 = Math.floor(xL), tx1 = Math.floor(xR);
      const ty0 = Math.floor(yT), ty1 = Math.floor(yB);
      const jobs = [];
      for(let ty = ty0; ty <= ty1; ty++){
        for(let tx = tx0; tx <= tx1; tx++){
          jobs.push([tx, ty, loadTile(
            "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/" + z + "/" + ty + "/" + tx
          )]);
        }
      }
      const results = await Promise.all(jobs.map(j => j[2]));
      const okCount = results.filter(Boolean).length;
      if(okCount < jobs.length * 0.7){
        console.warn("[terrain3d] 卫星瓦片加载不足(" + okCount + "/" + jobs.length + ")，保留海拔着色");
        return;
      }
      jobs.forEach((j, k) => {
        const img = results[k];
        if(!img) return;
        const px0 = (j[0] - xL) / (xR - xL) * W;
        const px1 = (j[0] + 1 - xL) / (xR - xL) * W;
        const py0 = (j[1] - yT) / (yB - yT) * H;
        const py1 = (j[1] + 1 - yT) / (yB - yT) * H;
        ctx.drawImage(img, px0, py0, px1 - px0, py1 - py0);
      });
      const tex = new THREE.CanvasTexture(cv);
      tex.anisotropy = 4;
      terrainMaterial.uniforms.satMap.value = tex;
      satLoaded = true;
      window.toggleSatellite(true);   // 加载成功后默认开启（渐显）
      console.log("[terrain3d] 卫星影像贴图完成 z" + z + "，瓦片 " + okCount + "/" + jobs.length);
    }catch(err){
      console.warn("[terrain3d] 卫星影像加载失败，保留海拔着色:", err);
    }
  }
  window.toggleSatellite = function(force){
    if(!satLoaded) return;
    satOn = (typeof force === "boolean") ? force : !satOn;
    terrainMaterial.uniforms.satMixTarget.value = satOn ? 1 : 0;
    // 卫星影像自带真实森林纹理，开启时隐藏树精灵避免叠加混乱
    if(treesGroup) treesGroup.visible = !satOn;
    const b = $("satBtn");
    if(b) b.classList.toggle("active", satOn);
  };

  /* ---------- 旅游模式切换（相机飞行 + 显示路线） ---------- */
  function easeInOut(t){ return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2; }
  function flyTo(pos, target){
    const token = ++camAnimToken;   // 启动新动画，令旧的 flyTo 失效
    const fromPos = camera.position.clone();
    const fromTgt = controls.target.clone();
    const t0 = performance.now(), D = 1300;
    function step(now){
      if(token !== camAnimToken) return;   // 已被新动画取代，立即停止
      const t = Math.min(1, (now - t0) / D);
      const e = easeInOut(t);
      camera.position.lerpVectors(fromPos, pos, e);
      controls.target.lerpVectors(fromTgt, target, e);
      controls.update();
      if(t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }
  window.toggleTourMode = function(){
    if(!initialized) return;
    tourMode = !tourMode;
    routesGroup.visible = tourMode;
    if(!tourMode) stopFly();
    const btn = $("tourBtn");
    if(btn) btn.classList.toggle("active", tourMode);
    if(!tourMode){
      document.querySelectorAll("#three3DRoutes .rbtn").forEach(b=> b.classList.remove("active"));
    }
    // 景区标签在旅游模式下放大（基于 baseScale）
    labelsGroup.children.forEach(c => {
      if(c.isSprite && c.userData.baseScale && (c.userData.kind === "wp" || c.userData.kind === "wpClosed")){
        const s = c.userData.baseScale;
        const m = tourMode ? 1.35 : 1.0;
        c.scale.set(s.x * m, s.y * m, 1);
      }
    });
    if(tourMode){
      flyTo(new THREE.Vector3(-6.8, 5.6, 7.2), new THREE.Vector3(0, 2.2, 0));
    } else {
      flyTo(new THREE.Vector3(5.8, 5.0, 6.2), new THREE.Vector3(0, 1.6, 0));
    }
  };

  /* ---------- 开始探索哀牢山：第一视角自动巡航全部路线 ---------- */
  window.startExplore = function(){
    if(!initialized || !tourCurves.length) return;
    const btn = $("heroExploreBtn");
    if(!tourMode) toggleTourMode();
    let routeIdx = 0;
    btn.textContent = "🚁 无人机探索中… (" + (routeIdx+1) + "/" + tourCurves.length + ")";
    btn.disabled = true;
    function next(){
      if(routeIdx >= tourCurves.length){
        btn.textContent = "🚁 无人机探索哀牢山";
        btn.disabled = false;
        return;
      }
      flyRoute(routeIdx);
      routeIdx++;
      setTimeout(next, 13000);
    }
    next();
  };

  /* ---------- 窗口尺寸（debounce 防抖，避免连续 resize 卡顿） ---------- */
  var resizeTimer = null;
  function onResize(){
    if(resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function(){
      const c = $("three3DContainer");
      if(!c || !renderer) return;
      const w = c.clientWidth, h = c.clientHeight;
      if(w < 10 || h < 10) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    }, 150);
  }

  /* ---------- 对外入口（renderTerrain3D 调用，幂等） ---------- */
  window.initThreeTerrain = function(){
    const container = $("three3DContainer");
    if(!container) return;
    if(initialized) return;
    if(!window.THREE || !window.HEIGHT_MAP){
      container.innerHTML = `<div class="desc" style="padding:20px">⚠ Three.js 加载失败（网络原因），3D 地形暂不可用。</div>`;
      return;
    }
    try{
      calcGeo();
      buildScene();
      window.__threeScene = scene;
      window.__threeCamera = camera;
      window.__threeRenderer = renderer;
      window.__threeControls = controls;
      initialized = true;
      // 后台加载卫星影像贴图（不阻塞初始化，失败自动回退海拔着色）
      setTimeout(loadSatellite, 600);
    }catch(err){
      console.error("[terrain3d] init error:", err);
      container.innerHTML = `<div class="desc" style="padding:20px">⚠ 3D 地形初始化失败：${err.message}</div>`;
    }
  };

  /* ---- 页面卸载时清理 Three.js 资源，防止 WebGL 内存泄漏 ---- */
  window.addEventListener("beforeunload", function(){
    try{
      if(renderer){
        renderer.setAnimationLoop(null);
        renderer.dispose();
      }
      if(scene){
        scene.traverse(function(obj){
          if(obj.geometry) obj.geometry.dispose();
          if(obj.material){
            if(Array.isArray(obj.material)) obj.material.forEach(function(m){ m.dispose(); });
            else obj.material.dispose();
          }
        });
      }
    }catch(e){ /* 静默 */ }
  });
})();
