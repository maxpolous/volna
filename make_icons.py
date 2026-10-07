"""Генерим иконки «Волны»: градиентный фон + белая звуковая волна."""
import math
from PIL import Image, ImageDraw


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def make(size, maskable=False):
    img = Image.new("RGB", (size, size), (0, 0, 0))
    d = ImageDraw.Draw(img)
    c1, c2 = (255, 85, 0), (124, 77, 255)  # orange -> violet (диагональ)
    for y in range(size):
        for x in range(0, size, 1):
            pass
    # диагональный градиент построчно (быстро): смешиваем по (x+y)
    top = Image.new("RGB", (size, size))
    px = top.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            px[x, y] = lerp(c1, c2, t)
    img = top
    d = ImageDraw.Draw(img)

    # звуковая волна из вертикальных «палочек» по центру
    bars = 7
    pad = size * (0.26 if not maskable else 0.32)
    area_w = size - 2 * pad
    bw = area_w / (bars * 2 - 1)
    cx0 = pad
    cy = size / 2
    heights = [0.35, 0.6, 0.85, 1.0, 0.8, 0.55, 0.3]
    maxh = size * (0.30 if not maskable else 0.26)
    for i in range(bars):
        h = heights[i] * maxh
        x0 = cx0 + i * bw * 2
        x1 = x0 + bw
        y0 = cy - h
        y1 = cy + h
        r = bw / 2
        d.rounded_rectangle([x0, y0, x1, y1], radius=r, fill=(255, 255, 255))
    return img


def rounded(img, radius_ratio=0.22):
    from PIL import Image as I
    size = img.size[0]
    mask = I.new("L", (size, size), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([0, 0, size, size], radius=int(size * radius_ratio), fill=255)
    out = I.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


# PNG для PWA/Android (квадратные, скругление делает система)
make(192).save("static/icon-192.png")
make(512).save("static/icon-512.png")
# iOS apple-touch-icon: сам скруглит, даём квадрат
make(180).save("static/icon-180.png")
# maskable (с запасом по краям)
make(512, maskable=True).save("static/icon-maskable-512.png")
print("icons done")
