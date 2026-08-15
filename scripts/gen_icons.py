#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 PWA 图标：深绿底 + 山形剪影 + 太阳 + 云，输出 192/512 PNG"""
from PIL import Image, ImageDraw
import os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")
os.makedirs(OUT, exist_ok=True)

def make_icon(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    s = size / 512.0
    # 背景：深绿渐变（径向近似：多层圆）
    bg = Image.new("RGBA", (size, size))
    bgd = ImageDraw.Draw(bg)
    for i in range(60, 0, -1):
        r = size * (i / 60.0)
        t = i / 60.0
        col = (int(5 + 12 * (1 - t)), int(24 + 26 * (1 - t)), int(15 + 14 * (1 - t)), 255)
        bgd.ellipse([size/2 - r, size/2 - r, size/2 + r, size/2 + r], fill=col)
    img = bg
    d = ImageDraw.Draw(img)
    # 山形剪影（两座山）
    d.polygon([(0, 400*s), (150*s, 180*s), (250*s, 330*s), (330*s, 150*s), (512*s, 430*s), (0, 430*s)], fill=(26, 72, 36, 255))
    # 山顶雪
    d.polygon([(330*s, 150*s), (355*s, 205*s), (305*s, 205*s)], fill=(233, 231, 240, 255))
    # 太阳
    sun_c = (232, 163, 92, 255)
    d.ellipse([390*s, 60*s, 470*s, 140*s], fill=sun_c)
    # 云
    d.ellipse([60*s, 120*s, 150*s, 165*s], fill=(200, 215, 220, 160))
    d.ellipse([110*s, 100*s, 200*s, 145*s], fill=(200, 215, 220, 150))
    # 底部标签条
    d.rectangle([0, 445*s, 512*s, 512*s], fill=(10, 30, 20, 255))
    # 文字（简化为三个短线模拟）
    for i, w in enumerate([150, 90, 120]):
        x0 = 90*s + i * 0
        d.rounded_rectangle([(256 - w/2)*s, (460 + i*15)*s, (256 + w/2)*s, (460 + i*15 + 7)*s], radius=3*s, fill=(111, 211, 154, 220))
    img.save(os.path.join(OUT, f"icon-{size}.png"))
    print(f"icon-{size}.png saved")

make_icon(192)
make_icon(512)
print("done")
