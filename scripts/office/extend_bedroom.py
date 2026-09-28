"""CEO bedroom behind the CEO suite (v5): widen the picture on the right and build a glass-walled bedroom
behind the suite's window wall, reached through a sliding glass door next to the remaining window.

Works on the gym-extended picture (the old 1560-px picture is at x offset E=450). Tile coords from iso.py.
Bedroom: t in [BT0, BT1], u in [BU0, U0]. The part of the suite's window wall in front of it becomes a
floor-to-ceiling glass partition (door gap DOOR_T left open: the scene draws and slides the leaf).
Usage: python3 extend_bedroom.py in.png out.png"""
import os, sys
import numpy as np, cv2 as cv
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from iso import img, Mi, O
from floorsynth import herringbone, hash2

E, R = 450, 170                 # left offset of the old picture, extra width on the right
BT0, BT1, BU0, U0 = 19.9, 23.8, -1.8, 2.2
WALL_H = 110
DOOR_T = (20.05, 20.85)
EXTERIOR = np.array([31, 21, 19], np.float32)
WALNUT = np.array([58, 90, 134], np.float32)
CAP = np.array([66, 66, 70], np.float32)
INK = (30, 27, 26)

def P(t, u, z=0.0):
    p = img((t, u), z); return float(p[0]) + E, float(p[1])

def fill(mask, pts, v=255):
    cv.fillPoly(mask, [np.array([[round(x * 4), round(y * 4)] for x, y in pts], np.int32)], v, lineType=cv.LINE_AA, shift=2)

def ln(c, p, q, col=INK, th=1):
    cv.line(c, (round(p[0] * 4), round(p[1] * 4)), (round(q[0] * 4), round(q[1] * 4)), col, th, cv.LINE_AA, shift=2)

def tiles(H, W, ss=1):
    ys, xs = np.mgrid[0:H * ss, 0:W * ss].astype(np.float32) / ss
    px, py = xs - E - O[0], ys - O[1]
    return Mi[0, 0] * px + Mi[0, 1] * py, Mi[1, 0] * px + Mi[1, 1] * py

def blend(c, m, col):
    a = (m.astype(np.float32) / 255.0)[..., None]
    c[:] = col * a + c * (1 - a)

def wall(c, a, b, hgt, color, back, slats=0, grad=0.16, cap=True):
    pa, pb = P(*a), P(*b)
    m = np.zeros(c.shape[:2], np.uint8); fill(m, [pa, pb, (pb[0], pb[1] - hgt), (pa[0], pa[1] - hgt)])
    ys, xs = np.nonzero(m)
    al = (m[ys, xs] / 255.0)[:, None]
    t = np.clip((xs - pa[0]) / (pb[0] - pa[0] if abs(pb[0] - pa[0]) > 1e-6 else 1e-6), 0, 1)
    by = pa[1] + (pb[1] - pa[1]) * t
    z = np.clip((by - ys) / hgt, 0, 1)
    col = color[None, :] * (1 - grad / 2 + grad * z)[:, None]
    rng = np.random.default_rng(5)
    col = col * (1 + rng.standard_normal(len(ys))[:, None] * 0.018)
    if slats:
        L = t * np.hypot(pb[0] - pa[0], pb[1] - pa[1]); k = (L % slats) / slats
        col = col * (0.88 + 0.16 * np.sin(k * np.pi))[:, None]
        col = np.where((k < 0.12)[:, None], col * 0.55, col)
    col = np.where(((by - ys) < 4)[:, None], col * 0.6, col)
    c[ys, xs] = col * al + c[ys, xs] * (1 - al)
    if cap:
        dv = np.array(img((a[0] + back[0] * 0.2, a[1] + back[1] * 0.2))) - np.array(img(a))
        q = [(pa[0], pa[1] - hgt), (pb[0], pb[1] - hgt), (pb[0] + dv[0], pb[1] - hgt + dv[1]), (pa[0] + dv[0], pa[1] - hgt + dv[1])]
        cm = np.zeros_like(m); fill(cm, q); blend(c, cm, CAP)
        cv.polylines(c, [np.array([[round(x * 4), round(y * 4)] for x, y in q], np.int32)], True, INK, 1, cv.LINE_AA, shift=2)
    ln(c, pa, pb)
    for p in (pa, pb): ln(c, p, (p[0], p[1] - hgt))
    return m

def main(src, out):
    old = cv.imread(src).astype(np.float32)
    H, w0 = old.shape[:2]
    W = w0 + R
    c = np.empty((H, W, 3), np.float32); c[:] = EXTERIOR
    rng = np.random.default_rng(4)
    c += cv.GaussianBlur(rng.standard_normal((H, W)).astype(np.float32), (0, 0), 6)[..., None] * 6
    c[:, :w0] = old
    TX, TY = tiles(H, W)
    # ---- floor (walnut herringbone like the suite), a cream rug under the bed, light from the windows
    ss = 3
    tx, ty = tiles(H, W, ss)
    pid, kind, edge, along = herringbone(tx, ty, wt=0.11, n=3)
    r = hash2(pid, pid // 5, 1); r2 = hash2(pid, pid // 3, 7)
    grain = np.sin(along * 38.0 + r2 * 30) * 0.035 + rng.standard_normal(tx.shape).astype(np.float32) * 0.03
    f = (0.82 + 0.3 * r + grain) * (0.62 + 0.38 * np.clip(edge / 0.03, 0, 1) ** 0.7)
    f = cv.resize(f.astype(np.float32), (W, H), interpolation=cv.INTER_AREA)
    floor = f[..., None] * WALNUT[None, None, :]
    L = 0.9 + 0.14 * np.exp(-((TY - BU0) / 1.4) ** 2) - 0.02 * np.clip(TY - BU0, 0, 6)
    lamp = np.exp(-(((TX - 21.25) ** 2) + ((TY - (BU0 + 0.6)) ** 2)) / 0.5) * 0.35   # bedside lamp
    L = L + lamp
    rug = (TX > 21.3) & (TX < 23.55) & (TY > -0.6) & (TY < 1.75)
    floor[rug] = (np.array([176, 190, 200], np.float32) + rng.standard_normal((int(rug.sum()), 1)).astype(np.float32) * 4)
    edge_r = rug & ~((TX > 21.38) & (TX < 23.47) & (TY > -0.52) & (TY < 1.67))
    floor[edge_r] = np.array([120, 136, 150], np.float32)
    lit = floor * L[..., None]
    sh = np.clip(np.minimum((TY - BU0) / 0.35, (TX - BT0) / 0.35), 0, 1)
    lit *= (0.72 + 0.28 * sh)[..., None]
    fm = np.zeros((H, W), np.uint8); fill(fm, [P(BT0, BU0), P(BT1, BU0), P(BT1, U0), P(BT0, U0)])
    blend(c, fm, lit)
    # ---- walls: back-right with windows (sky drawn live), back-left warm plaster with a slat panel behind the bed
    wall(c, (BT0, BU0), (BT1, BU0), WALL_H, np.array([46, 44, 44], np.float32), back=(0, -1), grad=0.1)
    panes = []
    for i in range(3):
        a0 = 20.05 + i * 1.25; a1 = a0 + 1.1
        q = [P(a0, BU0, 12), P(a1, BU0, 12), P(a1, BU0, 100), P(a0, BU0, 100)]
        pm = np.zeros((H, W), np.uint8); fill(pm, q); blend(c, pm, np.array([88, 60, 44], np.float32))
        panes.append([[round(x - 0, 1), round(y, 1)] for x, y in (q[3], q[2], q[1], q[0])])
    # walnut slat headboard panel on the back wall behind the bed (between the windows' sills and the floor)
    wall(c, (21.45, BU0 + 0.02), (23.65, BU0 + 0.02), 44, np.array([44, 72, 112], np.float32), back=(0, -1), slats=5, grad=0.2, cap=False)
    wall(c, (BT0, BU0), (BT0, U0), WALL_H, np.array([150, 162, 172], np.float32), back=(-1, 0), grad=0.2)
    # right edge of the building: low cut wall
    wall(c, (BT1, BU0), (BT1, U0), 14, np.array([150, 160, 168], np.float32), back=(1, 0), grad=0.05)
    # ---- glass partition along the suite's old window line (u = U0)
    g = np.zeros((H, W), np.uint8)
    segs = [(BT0, DOOR_T[0]), (DOOR_T[1], BT1)]
    for a0, a1 in segs:
        fill(g, [P(a0, U0), P(a1, U0), P(a1, U0, WALL_H), P(a0, U0, WALL_H)])
    ga = (g / 255.0)[..., None]
    tint = c * 0.82 + np.array([46, 40, 34], np.float32) * 0.18
    c[:] = tint * ga + c * (1 - ga)
    # soft reflections
    for a0, a1 in segs:                                 # one faint diagonal sheen per pane group
        tm = (a0 + a1) / 2
        ln(c, P(tm - 0.35, U0, 30), P(tm + 0.1, U0, 96), (196, 200, 204), 1)
    frame = (34, 32, 32)
    top0, top1 = P(BT0, U0, WALL_H), P(BT1, U0, WALL_H)
    ln(c, top0, top1, frame, 3)                         # head rail
    ln(c, P(BT0, U0), P(DOOR_T[0], U0), frame, 2); ln(c, P(DOOR_T[1], U0), P(BT1, U0), frame, 2)  # floor track
    posts = [BT0, DOOR_T[0], DOOR_T[1]] + [DOOR_T[1] + k * (BT1 - DOOR_T[1]) / 4 for k in range(1, 4)] + [BT1]
    for t in posts: ln(c, P(t, U0), P(t, U0, WALL_H), frame, 2)
    # a slim transom bar across the fixed panes
    for a0, a1 in segs: ln(c, P(a0, U0, 84), P(a1, U0, 84), frame, 1)
    cv.imwrite(out, np.clip(c, 0, 255).astype(np.uint8))
    import json
    json.dump({'width': W, 'panes': panes, 'door': [list(P(DOOR_T[0], U0)), list(P(DOOR_T[1], U0))],
               'glass_poly': [list(P(BT0, U0, WALL_H + 2)), list(P(BT1, U0, WALL_H + 2)), list(P(BT1, U0)), list(P(BT0, U0))],
               'glass_base': [list(P(BT0, U0)), list(P(BT1, U0))]}, open(out + '.json', 'w'))

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
