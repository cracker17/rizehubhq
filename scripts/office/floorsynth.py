"""Repaint a room's visible floor: procedural material in the iso grid, lit by the painting's own
low-frequency light field (normalized convolution over the clean floor pixels)."""
import cv2 as cv, numpy as np, json, sys
from iso import Mi, O
def lowfield(src, known, sigma):
    k = known.astype(np.float32)
    num = cv.GaussianBlur(src.astype(np.float32) * k[..., None], (0, 0), sigma)
    den = cv.GaussianBlur(k, (0, 0), sigma)[..., None]
    return num / np.maximum(den, 1e-4)
def tiles(h, w, ss=2):
    ys, xs = np.mgrid[0:h*ss, 0:w*ss].astype(np.float32) / ss
    px, py = xs - O[0], ys - O[1]
    tx = Mi[0, 0]*px + Mi[0, 1]*py; ty = Mi[1, 0]*px + Mi[1, 1]*py
    return tx, ty
def hash2(a, b, c=0):
    h = (a.astype(np.int64) * 73856093) ^ (b.astype(np.int64) * 19349663) ^ (c * 83492791)
    return ((h % 10007) / 10007.0).astype(np.float32)
def herringbone(tx, ty, wt=0.18, n=4):
    a, b = tx / wt, ty / wt
    best_id = np.zeros(a.shape, np.int64); kind = np.zeros(a.shape, np.int8); edge = np.full(a.shape, 9.0, np.float32)
    along = np.zeros(a.shape, np.float32); found = np.zeros(a.shape, bool)
    for j in range(-6, 7):
        qa, qb = a - j*n, b + j*n
        k = np.floor(qb)            # H plank: y in [k,k+1], x in [k,k+n]
        inH = (qa >= k) & (qa < k + n) & ~found
        best_id[inH] = (k[inH]*131 + j*7919).astype(np.int64); kind[inH] = 0
        e = np.minimum.reduce([qb - k, k + 1 - qb, (qa - k) / n * 4, (k + n - qa) / n * 4])
        edge[inH] = np.minimum(qb - k, k + 1 - qb)[inH]; edge[inH] = np.minimum(edge[inH], np.minimum(qa - k, k + n - qa)[inH])
        along[inH] = (qa - k)[inH]; found |= inH
        k2 = np.floor(qa) - n       # V plank: x in [k+n,k+n+1], y in [k+1-n,k+1]
        inV = (qb >= k2 + 1 - n) & (qb < k2 + 1) & ~found
        best_id[inV] = (k2[inV]*131 + j*7919 + 50000).astype(np.int64); kind[inV] = 1
        edge[inV] = np.minimum(np.minimum(qa - (k2 + n), k2 + n + 1 - qa), np.minimum(qb - (k2 + 1 - n), k2 + 1 - qb))[inV]
        along[inV] = (qb - (k2 + 1 - n))[inV]; found |= inV
    return best_id, kind, edge, along
if __name__ == '__main__':
    src = cv.imread(sys.argv[1]); floor = cv.imread(sys.argv[2], 0) > 0; furn = cv.imread(sys.argv[3], 0) > 0
    mat = sys.argv[4]; out = sys.argv[5]
    H, W = floor.shape
    ys, xs = np.where(floor); x0, x1, y0, y1 = xs.min()-2, xs.max()+3, ys.min()-2, ys.max()+3
    sub = src[y0:y1, x0:x1]; fl = floor[y0:y1, x0:x1]; fu = cv.dilate(furn[y0:y1, x0:x1].astype(np.uint8), np.ones((9, 9), np.uint8)) > 0
    gray = cv.cvtColor(sub, cv.COLOR_BGR2GRAY)
    known = fl & ~fu & (gray > 60)
    k = known.astype(np.float32)
    lum = gray.astype(np.float32)
    num = cv.GaussianBlur(lum * k, (0, 0), 22); den = cv.GaussianBlur(k, (0, 0), 22)
    meanlum = float(lum[known].mean()); meancol = sub[known].reshape(-1, 3).mean(0)
    w = np.clip(den / 0.15, 0, 1)
    L = (num / np.maximum(den, 1e-4)) * w + meanlum * (1 - w)
    L = np.clip(L / meanlum, 0.75, 1.3)
    if mat == "parquet": meancol = np.array([72, 112, 158], np.float32)
    else:
        meancol = np.array([150, 159, 166], np.float32)
    light = L[..., None] * meancol[None, None, :]
    print('meancol', meancol, 'meanlum', meanlum, 'known', int(known.sum()))
    ss = 2
    tx, ty = tiles(y1 - y0, x1 - x0, ss); tx += 0; 
    # shift to absolute image coords
    tx2, ty2 = tiles(H, W, 1)  # unused, kept simple
    ys2, xs2 = np.mgrid[0:(y1-y0)*ss, 0:(x1-x0)*ss].astype(np.float32) / ss
    px, py = xs2 + x0 - O[0], ys2 + y0 - O[1]
    tx = Mi[0, 0]*px + Mi[0, 1]*py; ty = Mi[1, 0]*px + Mi[1, 1]*py
    rng = np.random.default_rng(7)
    if mat == 'parquet':
        pid, kind, edge, along = herringbone(tx, ty)
        r = hash2(pid, pid // 7, 1)
        shade = 0.86 + 0.24 * r                                  # plank-to-plank variation
        grain = np.sin(along * 9.0 + hash2(pid, pid, 3) * 20) * 0.03 + (rng.standard_normal(tx.shape) * 0.025)
        seam = np.clip(edge / 0.09, 0, 1) ** 0.6                 # dark joints
        f = (shade + grain) * (0.74 + 0.26 * seam)
        tint = np.stack([f * 1.0, f * 1.0, f * 1.0], -1)
    else:  # polished concrete
        n1 = cv.GaussianBlur(rng.standard_normal(tx.shape).astype(np.float32), (0, 0), 6) * 0.9
        n2 = cv.GaussianBlur(rng.standard_normal(tx.shape).astype(np.float32), (0, 0), 1.2) * 0.35
        f = 1 + n1 * 0.09 + n2 * 0.07
        # faint slab joints every 3 tiles
        jx = np.abs(((tx + 1.5) % 3.0) - 1.5); jy = np.abs(((ty + 1.5) % 3.0) - 1.5)
        joint = np.minimum(jx, jy) < 0.02
        f = f * np.where(joint, 0.93, 1.0)
        # daylight from the windows (low tile x) fades towards the door
        g = np.clip(1.10 - 0.035 * (tx + 2.8), 0.9, 1.12)
        f = f * g
        tint = np.stack([f * 0.99, f, f * 1.02], -1)
    tint = cv.resize(tint.astype(np.float32), (x1 - x0, y1 - y0), interpolation=cv.INTER_AREA)
    base = light.copy()
    if mat == 'parquet':
        # parquet: normalise the light field to the wood's mean so shading comes only from light
        pass
    res = np.clip(base * tint, 0, 255)
    a = cv.GaussianBlur(fl.astype(np.float32), (0, 0), 0.8)[..., None]
    comp = src.copy().astype(np.float32)
    comp[y0:y1, x0:x1] = res * a + comp[y0:y1, x0:x1] * (1 - a)
    cv.imwrite(out, comp.astype(np.uint8))
