"""CEO en-suite bathroom (comfort room + shower) behind the CEO bedroom (v5).

The bedroom's back-left wall (t = BT0) is cut down to a low wall with a doorway, so the new room behind it is
visible: t in [RT0, BT0], u in [BU0, U0]. Only pixels that are the dark exterior, or the cut part of that wall, are
repainted, so everything in front (CEO suite slat wall, boardroom) keeps occluding the room. The fixtures (shower
corner, toilet, vanity) are sprites placed by the scene. Old-picture coords + E; tile coords from iso.py.
Usage: python3 extend_ceo_bath.py in.png out.png  (writes out.png.json with polygons for layout.json)"""
import os, sys, json
import numpy as np, cv2 as cv
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from iso import img, Mi, O

E = 450
RT0, BT0, BU0, U0 = 17.2, 19.9, -1.8, 2.2
WALL_H, LOW_H = 110, 14
DOOR = (0.25, 1.25)                      # doorway in the low wall (u range)
EXTERIOR = np.array([31, 21, 19], np.float32)
STONE = np.array([188, 196, 204], np.float32)   # BGR warm pale stone
WALLC = np.array([196, 204, 212], np.float32)
CAP = np.array([66, 66, 70], np.float32)
INK = (30, 27, 26)

def P(t, u, z=0.0):
    p = img((t, u), z); return float(p[0]) + E, float(p[1])

def fill(m, pts, v=255):
    cv.fillPoly(m, [np.array([[round(x * 4), round(y * 4)] for x, y in pts], np.int32)], v, cv.LINE_AA, shift=2)

def ln(c, p, q, col=INK, th=1):
    cv.line(c, (round(p[0] * 4), round(p[1] * 4)), (round(q[0] * 4), round(q[1] * 4)), col, th, cv.LINE_AA, shift=2)

def main(src, out):
    im = cv.imread(src).astype(np.float32)
    H, W = im.shape[:2]
    ys, xs = np.mgrid[0:H, 0:W].astype(np.float32)
    px, py = xs - E - O[0], ys - O[1]
    TX = Mi[0, 0] * px + Mi[0, 1] * py; TY = Mi[1, 0] * px + Mi[1, 1] * py
    rng = np.random.default_rng(9)
    L = np.empty((H, W, 3), np.float32); L[:] = EXTERIOR
    L += cv.GaussianBlur(rng.standard_normal((H, W)).astype(np.float32), (0, 0), 6)[..., None] * 6
    # floor: large-format stone tiles (0.8 tile), soft light from the frosted window, contact shadows
    fm = np.zeros((H, W), np.uint8); fill(fm, [P(RT0, BU0), P(BT0, BU0), P(BT0, U0), P(RT0, U0)])
    a = (TX - RT0) / 0.8; b = (TY - BU0) / 0.8
    joint = (np.abs(a - np.round(a)) < 0.035) | (np.abs(b - np.round(b)) < 0.035)
    n = cv.GaussianBlur(rng.standard_normal((H, W)).astype(np.float32), (0, 0), 3) * 0.035
    f = (1 + n) * np.where(joint, 0.86, 1.0)
    light = 1.02 - 0.03 * np.clip(TY - BU0, 0, 5) + 0.1 * np.exp(-(((TX - 18.4) / 0.9) ** 2 + ((TY - BU0 - 0.5) / 0.8) ** 2))
    sh = np.clip(np.minimum((TY - BU0) / 0.3, (TX - RT0) / 0.3), 0, 1)
    floor = STONE[None, None] * (f * light * (0.72 + 0.28 * sh))[..., None]
    fa = (fm / 255.0)[..., None]; L = floor * fa + L * (1 - fa)

    def wall(a_, b_, back, window=None):
        pa, pb = P(*a_), P(*b_)
        m = np.zeros((H, W), np.uint8); fill(m, [pa, pb, (pb[0], pb[1] - WALL_H), (pa[0], pa[1] - WALL_H)])
        t = np.clip((xs - pa[0]) / (pb[0] - pa[0]), 0, 1)
        by = pa[1] + (pb[1] - pa[1]) * t
        z = np.clip((by - ys) / WALL_H, 0, 1)
        col = WALLC[None, None] * (0.9 + 0.12 * z)[..., None]
        # tall tiles (subway, 3 rows per 110 px wall ... fine grid)
        along = t * np.hypot(pb[0] - pa[0], pb[1] - pa[1])
        g = ((np.abs(((along / 11.0) + 0.5 * (np.floor((by - ys) / 5.5) % 2)) % 1 - 0.5) > 0.46) | ((((by - ys) / 5.5) % 1) < 0.1))
        col = col * np.where(g, 0.9, 1.0)[..., None]
        col = np.where(((by - ys) < 3)[..., None], col * 0.7, col)
        ma = (m / 255.0)[..., None]
        L[:] = col * ma + L * (1 - ma)
        if window:
            w0, w1, z0, z1 = window
            q = [P(*((a_[0] + (b_[0] - a_[0]) * w0, a_[1] + (b_[1] - a_[1]) * w0)), z0), P(*((a_[0] + (b_[0] - a_[0]) * w1, a_[1] + (b_[1] - a_[1]) * w1)), z0),
                 P(*((a_[0] + (b_[0] - a_[0]) * w1, a_[1] + (b_[1] - a_[1]) * w1)), z1), P(*((a_[0] + (b_[0] - a_[0]) * w0, a_[1] + (b_[1] - a_[1]) * w0)), z1)]
            wm = np.zeros((H, W), np.uint8); fill(wm, q)
            wa = (wm / 255.0)[..., None]
            L[:] = np.array([236, 232, 226], np.float32) * wa + L * (1 - wa)   # frosted glass, lit from outside
            for i in range(4): ln(L, q[i], q[(i + 1) % 4], (40, 40, 44), 2)
            ln(L, ((q[0][0] + q[1][0]) / 2, (q[0][1] + q[1][1]) / 2), ((q[2][0] + q[3][0]) / 2, (q[2][1] + q[3][1]) / 2), (40, 40, 44), 1)
        # top cap
        dv = np.array(img((a_[0] + back[0] * 0.2, a_[1] + back[1] * 0.2))) - np.array(img(a_))
        q = [(pa[0], pa[1] - WALL_H), (pb[0], pb[1] - WALL_H), (pb[0] + dv[0], pb[1] - WALL_H + dv[1]), (pa[0] + dv[0], pa[1] - WALL_H + dv[1])]
        cm = np.zeros((H, W), np.uint8); fill(cm, q); ca = (cm / 255.0)[..., None]
        L[:] = CAP * ca + L * (1 - ca)
        cv.polylines(L, [np.array([[round(x * 4), round(y * 4)] for x, y in q], np.int32)], True, INK, 1, cv.LINE_AA, shift=2)
        ln(L, pa, pb)
        for p in (pa, pb): ln(L, p, (p[0], p[1] - WALL_H))
        return m
    wr = wall((RT0, BU0), (BT0, BU0), (0, -1), window=(0.55, 0.9, 62, 100))
    wl = wall((RT0, BU0), (RT0, U0), (-1, 0))
    # ---- which pixels to repaint
    region = np.zeros((H, W), np.uint8)
    fill(region, [P(RT0, BU0, WALL_H + 8), P(BT0, BU0, WALL_H + 8), P(BT0, BU0), P(BT0, U0), P(RT0, U0), P(RT0, U0, WALL_H + 8)])
    region = cv.dilate(region, np.ones((5, 5), np.uint8))
    dark = (np.abs(im - EXTERIOR).max(2) < 26)
    # the cut part of the bedroom's back-left wall (from LOW_H up to above its cap)
    cut = np.zeros((H, W), np.uint8)
    fill(cut, [P(BT0, BU0, LOW_H), P(BT0, U0, LOW_H), P(BT0 - 0.25, U0, WALL_H + 6), P(BT0 - 0.25, BU0, WALL_H + 6)])
    fill(cut, [P(BT0, BU0, LOW_H), P(BT0, U0, LOW_H), P(BT0, U0, WALL_H + 3), P(BT0, BU0, WALL_H + 3)])
    # keep the bedroom's glass partition line (u = U0) and the window wall line (u = BU0) posts intact: stop 3 px short
    use = ((region > 0) & dark) | (cut > 0)
    ua = cv.GaussianBlur(use.astype(np.float32), (0, 0), 0.5)[..., None]
    out = L * ua + im * (1 - ua)
    # the CEO suite's first window pane (t 18.9..19.9 on u = U0) now backs onto the bathroom: plain dark wall
    pane = np.zeros((H, W), np.uint8); fill(pane, [P(18.9, U0, 0), P(BT0, U0, 0), P(BT0, U0, WALL_H), P(18.9, U0, WALL_H)])
    pa_ = (pane / 255.0)[..., None]
    zz = np.clip((P(19.4, U0)[1] - ys) / WALL_H, 0, 1)[..., None]
    out = np.array([46, 44, 44], np.float32) * (0.95 + 0.1 * zz) * pa_ + out * (1 - pa_)
    dv = np.array(img((18.9, U0 + 0.2))) - np.array(img((18.9, U0)))
    capq = [P(18.9, U0, WALL_H), P(BT0, U0, WALL_H), (P(BT0, U0, WALL_H)[0] + dv[0], P(BT0, U0, WALL_H)[1] + dv[1]), (P(18.9, U0, WALL_H)[0] + dv[0], P(18.9, U0, WALL_H)[1] + dv[1])]
    capq = [P(18.9, U0, WALL_H), P(BT0, U0, WALL_H), (capq[1][0] - dv[0], capq[1][1] - dv[1]), (capq[0][0] - dv[0], capq[0][1] - dv[1])]
    cm = np.zeros((H, W), np.uint8); fill(cm, capq); ca = (cm / 255.0)[..., None]; out = CAP * ca + out * (1 - ca)
    for i in range(4): ln(out, capq[i], capq[(i + 1) % 4])
    ln(out, P(18.9, U0), P(18.9, U0, WALL_H)); ln(out, P(BT0, U0), P(BT0, U0, WALL_H))
    # ---- the low wall that is left (with a doorway) and its cap
    def low(u0, u1):
        q = [P(BT0, u0), P(BT0, u1), P(BT0, u1, LOW_H), P(BT0, u0, LOW_H)]
        m = np.zeros((H, W), np.uint8); fill(m, q); a = (m / 255.0)[..., None]
        nonlocal_out[0] = np.array([150, 162, 172], np.float32) * 0.92 * a + nonlocal_out[0] * (1 - a)
        dv = np.array(img((BT0 - 0.18, u0))) - np.array(img((BT0, u0)))
        c = [P(BT0, u0, LOW_H), P(BT0, u1, LOW_H), (P(BT0, u1, LOW_H)[0] + dv[0], P(BT0, u1, LOW_H)[1] + dv[1]), (P(BT0, u0, LOW_H)[0] + dv[0], P(BT0, u0, LOW_H)[1] + dv[1])]
        cm = np.zeros((H, W), np.uint8); fill(cm, c); ca = (cm / 255.0)[..., None]
        nonlocal_out[0] = CAP * ca + nonlocal_out[0] * (1 - ca)
        for i in range(4): ln(nonlocal_out[0], c[i], c[(i + 1) % 4])
        ln(nonlocal_out[0], P(BT0, u0), P(BT0, u1)); ln(nonlocal_out[0], P(BT0, u0), P(BT0, u0, LOW_H)); ln(nonlocal_out[0], P(BT0, u1), P(BT0, u1, LOW_H))
        return q, c
    nonlocal_out = [out]
    q1, c1 = low(BU0 + 0.05, DOOR[0])
    q2, c2 = low(DOOR[1], U0 - 0.05)
    out = nonlocal_out[0]
    cv.imwrite(out_path := out_file, np.clip(out, 0, 255).astype(np.uint8)) if False else None
    cv.imwrite(sys.argv[2], np.clip(out, 0, 255).astype(np.uint8))
    meta = {'door': [list(P(BT0, DOOR[0])), list(P(BT0, DOOR[1]))],
            'low_walls': [{'poly': [list(p) for p in q1 + c1[2:][::-1]], 'base': [list(P(BT0, BU0)), list(P(BT0, DOOR[0]))]},
                          {'poly': [list(p) for p in q2 + c2[2:][::-1]], 'base': [list(P(BT0, DOOR[1])), list(P(BT0, U0))]}]}
    json.dump(meta, open(sys.argv[2] + '.json', 'w'))

out_file = None
if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
