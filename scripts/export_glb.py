#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""哀牢山地形 GLB 导出器（DEM → Mesh → Three.js → GLB 流程的离线端）

数据流：
  models/terrain_3d.json   (mesh_3d: vertices/faces/colors, 归一化低模)
      └──▶ models/terrain_3d.glb       低模（594 顶点 / 1092 面，含海拔配色顶点色，网站可下载）
  models/terrain_height.json (209×169 DEM 高度场, 35,321 顶点, 含地理范围)
      └──▶ models/terrain_dem_full.glb 高精地表（米制坐标, Blender/UE/GIS 用, --full 才生成）

浏览器端 Three.js 仍用程序化 Mesh 实时渲染（细节更足、可点击取天气）；
GLB 用于：离线查看 / Blender、Unity、UE 二次加工 / GIS 展示。

用法：
  /opt/anaconda3/bin/python3 scripts/export_glb.py            # 低模
  /opt/anaconda3/bin/python3 scripts/export_glb.py --full     # 低模 + 高精
依赖：pygltflib trimesh（已装入 anaconda python）
"""
import argparse
import json
import math
import os
import struct
import sys

try:
    import pygltflib
    from pygltflib import GLTF2, Asset, Buffer, BufferView, Accessor, Mesh as GtfMesh, \
        Primitive, Node, Scene, Material, PbrMetallicRoughness
except ImportError:
    sys.exit("缺少 pygltflib，请先: /opt/anaconda3/bin/python3 -m pip install pygltflib trimesh")

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")


def pad4(b: bytes) -> bytes:
    return b + b"\x00" * ((4 - len(b) % 4) % 4)


def build_glb(positions, colors_rgb, indices, extras, out_path):
    """positions: [x,y,z,...]; colors_rgb: [r,g,b,...]; indices: [a,b,c,...]"""
    n_vert = len(positions) // 3
    n_tri = len(indices) // 3
    assert len(colors_rgb) // 3 == n_vert, "顶点色数量必须等于顶点数"

    pos_b = pad4(struct.pack("<%df" % len(positions), *positions))
    col_b = pad4(struct.pack("<%df" % len(colors_rgb), *colors_rgb))
    idx_b = pad4(struct.pack("<%dI" % len(indices), *indices))

    blob = pos_b + col_b + idx_b
    off_pos, off_col, off_idx = 0, len(pos_b), len(pos_b) + len(col_b)

    buf = Buffer(byteLength=len(blob), uri=None)
    bv_pos = BufferView(buffer=0, byteOffset=off_pos, byteLength=len(pos_b), target=34962)
    bv_col = BufferView(buffer=0, byteOffset=off_col, byteLength=len(col_b), target=34962)
    bv_idx = BufferView(buffer=0, byteOffset=off_idx, byteLength=len(idx_b), target=34963)

    xs = positions[0::3]; ys = positions[1::3]; zs = positions[2::3]
    acc_pos = Accessor(bufferView=0, componentType=5126, count=n_vert, type="VEC3",
                       min=[min(xs), min(ys), min(zs)], max=[max(xs), max(ys), max(zs)])
    acc_col = Accessor(bufferView=1, componentType=5126, count=n_vert, type="VEC3")
    acc_idx = Accessor(bufferView=2, componentType=5125, count=len(indices), type="SCALAR")

    material = Material(
        name="ailaoshan_terrain",
        pbrMetallicRoughness=PbrMetallicRoughness(
            baseColorFactor=[1.0, 1.0, 1.0, 1.0],
            metallicFactor=0.0, roughnessFactor=1.0,
        ),
        extensions={"KHR_materials_unlit": {}},
        doubleSided=True,
    )
    primitive = Primitive(
        attributes={"POSITION": 0, "COLOR_0": 1},
        indices=2, material=0, mode=4,
    )
    mesh = GtfMesh(name="terrain", primitives=[primitive])
    node = Node(name="terrain", mesh=0)
    gltf = GLTF2(
        asset=Asset(version="2.0", generator="ailaoshan-weather export_glb.py"),
        scene=0,
        scenes=[Scene(nodes=[0])],
        nodes=[node],
        meshes=[mesh],
        materials=[material],
        buffers=[buf],
        bufferViews=[bv_pos, bv_col, bv_idx],
        accessors=[acc_pos, acc_col, acc_idx],
        extensionsUsed=["KHR_materials_unlit"],
        extensionsRequired=[],
        extras=extras,
    )
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    gltf.set_binary_blob(bytes(blob))   # GLB 二进制块（buffer uri=None 时 save_binary 从这里取数据）
    gltf.save_binary(out_path)
    return n_vert, n_tri


def export_lowres():
    src = os.path.join(ROOT, "models", "terrain_3d.json")
    out = os.path.join(ROOT, "models", "terrain_3d.glb")
    data = json.load(open(src, encoding="utf-8"))
    m = data["mesh_3d"]
    verts = [c for v in m["vertices"] for c in v]
    cols = [c for v in m["colors"] for c in v]
    idx = [i for f in m["faces"] for i in f]
    extras = {
        "region": data.get("region", ""),
        "model_name": data.get("model_name", ""),
        "build_time": data.get("build_time", ""),
        "n_vertices": m["n_vertices"], "n_faces": m["n_faces"],
        "elev_range": m["elev_range"], "lat_range": m["lat_range"], "lon_range": m["lon_range"],
        "note": "归一化坐标网格（与网页 3D 场景一致）；vertex color = 海拔配色",
    }
    nv, nt = build_glb(verts, cols, idx, extras, out)
    print(f"[低模] {out}  {nv} 顶点 / {nt} 面  {os.path.getsize(out) / 1024:.1f} KB")


def elevation_color(t):
    """海拔 → RGB 配色（与网页 3D 场景海拔配色一致）"""
    stops = [
        (0.00, (0.10, 0.28, 0.14)),   # <1000m 河谷雨林
        (0.19, (0.35, 0.59, 0.26)),   # 1000-1500 常绿阔叶林
        (0.39, (0.42, 0.52, 0.30)),   # 1500-2000 中山湿性常绿阔叶林
        (0.58, (0.55, 0.46, 0.33)),   # 2000-2500 苔藓矮林/灌丛
        (0.78, (0.66, 0.64, 0.58)),   # 2500-3000 山顶草甸/裸岩
        (1.00, (0.88, 0.88, 0.86)),   # 3000+ 裸岩
    ]
    for i in range(len(stops) - 1):
        t0, c0 = stops[i]
        t1, c1 = stops[i + 1]
        if t <= t1:
            k = 0 if t1 == t0 else (t - t0) / (t1 - t0)
            return tuple(round(c0[j] + (c1[j] - c0[j]) * k, 4) for j in range(3))
    return stops[-1][1]


def export_full():
    src = os.path.join(ROOT, "models", "terrain_height.json")
    out = os.path.join(ROOT, "models", "terrain_dem_full.glb")
    data = json.load(open(src, encoding="utf-8"))
    w, h = data["w"], data["h"]
    elev = data["elev"]                       # 35321 个 [elev,...] 行, 每行 w 个
    lat0, lat1 = data["lat_range"]
    lon0, lon1 = data["lon_range"]
    min_e, max_e = data["min_elev"], data["max_elev"]
    lat_c = (lat0 + lat1) / 2.0
    m_per_deg_lat = 110540.0
    m_per_deg_lon = 111320.0 * math.cos(math.radians(lat_c))

    positions, colors, indices = [], [], []
    for r in range(h):
        for c_ in range(w):
            e = elev[r * w + c_]
            x = (lon0 + (c_ / (w - 1)) * (lon1 - lon0) - lon0) * m_per_deg_lon
            z = (lat0 - (lat0 + (r / (h - 1)) * (lat1 - lat0))) * m_per_deg_lat
            positions += [x, float(e), z]
            colors += elevation_color((e - min_e) / (max_e - min_e))
            if r < h - 1 and c_ < w - 1:
                i = r * w + c_
                a, b, c2, d = i, i + 1, i + w, i + w + 1
                indices += [a, b, d, a, d, c2]
    extras = {
        "region": f"{lat0:.2f}~{lat1:.2f}N, {lon0:.2f}~{lon1:.2f}E",
        "model_name": data.get("model_name", ""),
        "build_time": data.get("build_time", ""),
        "grid": f"{w}x{h}", "elev_range": [min_e, max_e],
        "crs_note": "近似米制局部坐标(等距圆柱投影, 中心纬度 %.4f); Y=海拔米; 北向=-Z" % lat_c,
    }
    nv, nt = build_glb(positions, colors, indices, extras, out)
    print(f"[高精] {out}  {nv} 顶点 / {nt} 面  {os.path.getsize(out) / 1024 / 1024:.2f} MB")


def verify(path):
    try:
        import trimesh
        mesh = trimesh.load(path, force="mesh")
        nv = getattr(mesh, "vertex_count", len(mesh.vertices))
        nf = len(mesh.faces)
        print(f"[验证] trimesh 加载 OK: {nv} 顶点 / {nf} 面 / 包围盒 {mesh.bounds.tolist()}")
        return True
    except Exception as e:
        print(f"[验证] trimesh 加载失败: {e}")
        return False


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="哀牢山地形 GLB 导出")
    ap.add_argument("--full", action="store_true", help="同时导出高精 DEM 版 terrain_dem_full.glb")
    args = ap.parse_args()
    ok = True
    export_lowres()
    if args.full:
        export_full()
    ok = verify(os.path.join(ROOT, "models", "terrain_3d.glb")) and ok
    if args.full:
        ok = verify(os.path.join(ROOT, "models", "terrain_dem_full.glb")) and ok
    sys.exit(0 if ok else 1)
