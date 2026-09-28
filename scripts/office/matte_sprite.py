"""Rebuild a transparent sprite from two JPEG captures of it: on black (left, x=0) and on white (right, x=400)."""
import sys, json, numpy as np
from PIL import Image
from scipy import ndimage

def matte(path, w, h, out, target_h=None, y=0):
    im = np.asarray(Image.open(path).convert('RGB')).astype(np.float32)
    B = im[y:y+h, 0:w]
    W = im[y:y+h, 400:400 + w]
    a = 1.0 - (W - B).mean(axis=2) / 255.0
    a = np.clip((a - 0.04) / 0.92, 0, 1)            # clean JPEG noise near 0 / 1
    col = np.where(a[..., None] > 0.02, B / np.maximum(a[..., None], 1e-3), 0)
    col = np.clip(col, 0, 255)
    # keep the main figure (drops bits of neighbouring cells)
    lab, n = ndimage.label(a > 0.2)
    if n > 1:
        sizes = ndimage.sum(np.ones_like(a), lab, range(1, n + 1))
        keep = np.isin(lab, [i + 1 for i, s in enumerate(sizes) if s >= sizes.max() * 0.08])
        keep = ndimage.binary_dilation(keep, iterations=3)
        a = a * keep
    ys, xs = np.where(a > 0.05)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    rgba = np.dstack([col, a * 255])[y0:y1, x0:x1].astype(np.uint8)
    img = Image.fromarray(rgba, 'RGBA')
    if target_h and img.height > target_h:
        img = img.resize((round(img.width * target_h / img.height), target_h), Image.LANCZOS)
    img.save(out)
    return img.size

if __name__ == '__main__':
    jobs = json.load(open(sys.argv[1]))
    for j in jobs:
        print(j['out'], matte(j['file'], j['w'], j['h'], j['out'], j.get('target_h'), j.get('y', 0)))
