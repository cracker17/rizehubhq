"""Remove baked-in people, status pills and garbled labels from the reference office using LaMa (OpenCV zoo ONNX)."""
import cv2 as cv, numpy as np, sys, json
import os
S = os.environ.get('WORK', '.')  # folder holding lama.onnx
import os
src = cv.imread(os.environ.get('SRC','assets/office/reference-office.png'))
H, W = src.shape[:2]
import onnxruntime as ort
ort.set_default_logger_severity(3)
sess = ort.InferenceSession(f'{S}/lama.onnx', providers=['CPUExecutionProvider'])

# Regions in reference pixels. ('e', cx, cy, rx, ry) ellipse, ('r', x0, y0, x1, y1) rect, ('p', [[x,y],...]) polygon
REGIONS = json.load(open(os.environ.get('REG', f'{S}/regions.json')))

def mask_of(shapes, pad=0):
    m = np.zeros((H, W), np.uint8)
    for s in shapes:
        if s[0] == 'e':
            cv.ellipse(m, (int(s[1]), int(s[2])), (int(s[3]) + pad, int(s[4]) + pad), 0, 0, 360, 255, -1)
        elif s[0] == 'r':
            cv.rectangle(m, (int(s[1]) - pad, int(s[2]) - pad), (int(s[3]) + pad, int(s[4]) + pad), 255, -1)
        elif s[0] == 'p':
            cv.fillPoly(m, [np.array(s[1], np.int32)], 255)
    return m

def lama(img, m):
    ib = cv.dnn.blobFromImage(img, 1 / 255.0, (512, 512), (0, 0, 0), True, False)
    mb = cv.dnn.blobFromImage(m, 1.0, (512, 512), (0,), False, False)
    mb = (mb > 0).astype(np.float32)
    ib = ib * (1 - mb)
    out = sess.run(None, {'image': ib.astype(np.float32), 'mask': mb})[0][0].transpose(1, 2, 0)
    out = np.clip(out, 0, 255).astype(np.uint8)[..., ::-1].copy()
    return cv.resize(out, (img.shape[1], img.shape[0]), interpolation=cv.INTER_CUBIC)

out = src.copy()
only = sys.argv[1:]  # optional subset of region names
K = np.ones((5, 5), np.uint8)
GM = np.zeros((H, W), np.uint8)
for name, reg in REGIONS.items():
    if not only or name in only:
        GM |= cv.dilate(mask_of(reg['shapes']), K)
for name, reg in REGIONS.items():
    if only and name not in only:
        continue
    m = cv.dilate(mask_of(reg['shapes']), K)
    ys, xs = np.where(m > 0)
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    ctx = reg.get('ctx', 2.2)  # window = ctx x region size, square-ish, at least 96px
    size = int(max(x1 - x0, y1 - y0, 40) * ctx)
    size = max(size, int(reg.get("min", 256)))
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    wx0, wy0 = max(0, cx - size // 2), max(0, cy - size // 2)
    wx1, wy1 = min(W, wx0 + size), min(H, wy0 + size)
    wx0, wy0 = max(0, wx1 - size), max(0, wy1 - size)
    crop = out[wy0:wy1, wx0:wx1].copy(); mc = GM[wy0:wy1, wx0:wx1].copy()
    if mc.max() == 0:
        continue
    # work at 2x inside the window for detail when the window is small
    res = lama(crop, mc)
    alpha = cv.GaussianBlur((mc > 0).astype(np.float32), (7, 7), 0)[..., None]
    alpha = np.maximum(alpha, (mc > 0)[..., None].astype(np.float32))
    out[wy0:wy1, wx0:wx1] = (res * alpha + crop * (1 - alpha)).astype(np.uint8)
    GM[wy0:wy1, wx0:wx1] = 0
    print('done', name, (wx0, wy0, wx1, wy1))

cv.imwrite(os.environ.get('OUT', f'{S}/clean.png'), out)
# debug: mask overlay
dbg = src.copy()
allm = mask_of([s for r in REGIONS.values() for s in r['shapes']])
dbg[allm > 0] = (dbg[allm > 0] * 0.4 + np.array([0, 0, 255]) * 0.6).astype(np.uint8)
cv.imwrite(f'{S}/maskdbg.png', dbg)
