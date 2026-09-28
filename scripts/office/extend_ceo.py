"""Widen the office picture to the right and turn the old CEO corner + plant room into a wide CEO suite.

1x picture px, iso grid from iso.py (tile x = down-right, tile y = down-left). Everything whose floor tile is
inside the suite (T0 <= x <= T1, y >= U0) is repainted: fine walnut herringbone, a walnut-slat feature wall
(the neon RizeHub logo hangs on it, drawn live), the suite's back-left wall (the part that used to be the plant
room) and a low cut front wall at the building's new right edge. The old tiny CEO office's back wall, desk and
chair disappear under the new floor. Furniture, the frosted sliding door and the logo are drawn by the scene.
Usage: python3 extend_ceo.py in.png out.png"""
import os, sys
import numpy as np, cv2 as cv
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from iso import img, Mi, O
from floorsynth import herringbone, hash2

W_NEW, H = 1560, 749
T0, T1, U0 = 18.9, 23.8, 2.2
WALL_H = 110
WIN_Z0, WIN_Z1 = 12, 100    # window pane band on the back-right wall (height above the floor)
WINDOW_PANES = [(T0 + 0.18 + i * 0.98, T0 + 0.18 + i * 0.98 + 0.86) for i in range(5)]
DOOR = (5.75, 7.75)       # the CEO suite's sliding door (tile y range on the glass line)
RIZE_Y = 4.75             # the Game Hall's back (RIZE) wall
RIZE_WALL = np.array([96, 102, 112], np.float32)
EXTERIOR = np.array([31, 21, 19], np.float32)            # BGR
WALNUT = np.array([58, 90, 134], np.float32)             # BGR
CONCRETE = np.array([104, 113, 124], np.float32)         # BGR
SLAT = np.array([44, 72, 112], np.float32)
CAP = np.array([66, 66, 70], np.float32)
INK = (30, 27, 26)

def P(t, u, z=0.0):
    p = img((t, u), z); return float(p[0]), float(p[1])

def tiles(h, w, ss=1, x0=0, y0=0):
    ys, xs = np.mgrid[0:h * ss, 0:w * ss].astype(np.float32) / ss
    px, py = xs + x0 - O[0], ys + y0 - O[1]
    return Mi[0, 0] * px + Mi[0, 1] * py, Mi[1, 0] * px + Mi[1, 1] * py

def fill(mask, pts):
    cv.fillPoly(mask, [np.array([[round(x * 4), round(y * 4)] for x, y in pts], np.int32)], 255, lineType=cv.LINE_AA, shift=2)

def walnut_floor():
    ss = 3
    tx, ty = tiles(H, W_NEW, ss)
    pid, kind, edge, along = herringbone(tx, ty, wt=0.11, n=3)
    r = hash2(pid, pid // 5, 1); r2 = hash2(pid, pid // 3, 7)
    rng = np.random.default_rng(11)
    grain = np.sin(along * 38.0 + r2 * 30) * 0.035 + rng.standard_normal(tx.shape).astype(np.float32) * 0.03
    f = 0.82 + 0.3 * r + grain
    f *= 0.62 + 0.38 * np.clip(edge / 0.03, 0, 1) ** 0.7        # dark joints
    f = cv.resize(f.astype(np.float32), (W_NEW, H), interpolation=cv.INTER_AREA)
    tint = (r2 > 0.5).astype(np.float32)
    tint = cv.resize(cv.resize(tint, (W_NEW * ss // ss, H), interpolation=cv.INTER_AREA), (W_NEW, H))
    col = f[..., None] * WALNUT[None, None, :]
    return col

def wall(canvas, a, b, hgt, color, back=(0, -1), slats=0, grad=0.16, cap=True, base_dark=True):
    """Vertical wall on floor line a->b (tiles). `back` = tile direction of the wall's thickness (for the top cap)."""
    pa, pb = P(*a), P(*b)
    m = np.zeros(canvas.shape[:2], np.uint8)
    fill(m, [pa, pb, (pb[0], pb[1] - hgt), (pa[0], pa[1] - hgt)])
    ys, xs = np.nonzero(m)
    al = (m[ys, xs] / 255.0)[:, None]
    t = np.clip((xs - pa[0]) / (pb[0] - pa[0] if abs(pb[0] - pa[0]) > 1e-6 else 1e-6), 0, 1)
    by = pa[1] + (pb[1] - pa[1]) * t
    z = np.clip((by - ys) / hgt, 0, 1)
    col = color[None, :] * (1 - grad / 2 + grad * z)[:, None]
    rng = np.random.default_rng(5)
    col = col * (1 + rng.standard_normal(len(ys))[:, None] * 0.018)
    if slats:
        L = t * np.hypot(pb[0] - pa[0], pb[1] - pa[1])
        k = (L % slats) / slats
        col = col * (0.88 + 0.16 * np.sin(k * np.pi))[:, None]
        col = np.where((k < 0.12)[:, None], col * 0.55, col)
        # soft warm uplight at the foot of the slats and a cooler top
        col = col * (1 + 0.18 * np.exp(-((by - ys) / 14.0)))[:, None]
    if base_dark:
        col = np.where(((by - ys) < 4)[:, None], col * 0.6, col)
    canvas[ys, xs] = col * al + canvas[ys, xs] * (1 - al)
    if cap:
        dv = np.array(img((a[0] + back[0] * 0.2, a[1] + back[1] * 0.2))) - np.array(img(a))
        q = [(pa[0], pa[1] - hgt), (pb[0], pb[1] - hgt), (pb[0] + dv[0], pb[1] - hgt + dv[1]), (pa[0] + dv[0], pa[1] - hgt + dv[1])]
        cm = np.zeros_like(m); fill(cm, q)
        a2 = (cm / 255.0)[..., None]
        canvas[:] = CAP * a2 + canvas * (1 - a2)
        cv.polylines(canvas, [np.array([[round(x * 4), round(y * 4)] for x, y in q], np.int32)], True, INK, 1, cv.LINE_AA, shift=2)
    cv.line(canvas, (round(pa[0] * 4), round(pa[1] * 4)), (round(pb[0] * 4), round(pb[1] * 4)), INK, 1, cv.LINE_AA, shift=2)
    for p in (pa, pb):
        cv.line(canvas, (round(p[0] * 4), round(p[1] * 4)), (round(p[0] * 4), round((p[1] - hgt) * 4)), INK, 1, cv.LINE_AA, shift=2)
    return m

def main(src, out):
    old = cv.imread(src).astype(np.float32)
    h0, w0 = old.shape[:2]
    c = np.empty((H, W_NEW, 3), np.float32); c[:] = EXTERIOR
    # the painting's dark surround has a faint texture; carry it into the new strip
    rng = np.random.default_rng(2)
    c += cv.GaussianBlur(rng.standard_normal((H, W_NEW)).astype(np.float32), (0, 0), 6)[..., None] * 6
    c[:h0, :w0] = old

    TX, TY = tiles(H, W_NEW)
    # --- suite floor
    suite = np.zeros((H, W_NEW), np.uint8)
    fill(suite, [P(T0, U0), P(T1, U0), P(T1, 40), P(T0, 40)])
    floor = walnut_floor()
    # light: warm lamp pools + a neon wash near the feature wall, darker towards the front
    lx = np.exp(-(((TX - 22.9) ** 2) + ((TY - 3.3) ** 2)) / 1.6) * 0.35       # floor lamp by the sofa
    dl = np.exp(-(((TX - 20.2) ** 2) + ((TY - 4.1) ** 2)) / 1.2) * 0.2        # desk lamp
    neon = np.exp(-((TY - U0) / 0.9) ** 2) * np.exp(-((TX - 21.4) / 2.2) ** 2) * 0.22
    L = (0.92 + lx + dl - 0.03 * np.clip(TY - U0, 0, 8)).astype(np.float32)
    lit = floor * L[..., None]
    lit[..., 0] += neon * 90; lit[..., 2] += neon * 60                        # violet-blue from the logo
    # a large cream rug with a thin gold border under the lounge
    rug = (TX > 21.6) & (TX < 23.55) & (TY > 3.0) & (TY < 5.9)
    rin = (TX > 21.72) & (TX < 23.43) & (TY > 3.12) & (TY < 5.78)
    fib = cv.GaussianBlur(rng.standard_normal((H, W_NEW)).astype(np.float32), (0, 0), 0.7) * 6
    # navy wool with a gold border and a faint inner line + medallion
    inner_line = rin & ~((TX > 21.86) & (TX < 23.29) & (TY > 3.26) & (TY < 5.64)) & ((TX > 21.82) & (TX < 23.33) & (TY > 3.22) & (TY < 5.68))
    med = rin & (((TX - 22.575) / 0.55) ** 2 + ((TY - 4.45) / 0.9) ** 2 < 1)
    base = np.array([70, 44, 34], np.float32)
    lit[rin] = (base + fib[rin][:, None] * 0.8) * L[rin][:, None]
    lit[med] = (np.array([84, 58, 44], np.float32) + fib[med][:, None]) * L[med][:, None]
    lit[inner_line] = np.array([70, 150, 196], np.float32) * L[inner_line][:, None]
    lit[rug & ~rin] = np.array([60, 145, 190], np.float32) * L[rug & ~rin][:, None]
    # contact shadow along both back walls
    sh = np.clip(np.minimum((TY - U0) / 0.4, (TX - T0) / 0.4), 0, 1)
    lit *= (0.7 + 0.3 * sh)[..., None]
    a = (suite / 255.0)[..., None]
    c = lit * a + c * (1 - a)

    # --- walls
    # back-left wall where the plant room was: dark walnut slats behind the CEO's desk (the neon logo hangs here)
    wall(c, (T0, U0), (T0, 5.35), WALL_H, SLAT * 0.62, back=(-1, 0), slats=6, grad=0.25)
    # back-right wall: floor-to-ceiling windows (the sky and the city are drawn live in the panes)
    wall(c, (T0, U0), (T1, U0), WALL_H, np.array([46, 44, 44], np.float32), back=(0, -1), grad=0.1)
    pane = np.zeros((H, W_NEW), np.uint8)
    for (a0, a1) in WINDOW_PANES:
        fill(pane, [P(a0, U0, WIN_Z0), P(a1, U0, WIN_Z0), P(a1, U0, WIN_Z1), P(a0, U0, WIN_Z1)])
    pa_ = (pane / 255.0)[..., None]
    c = np.array([88, 60, 44], np.float32) * pa_ + c * (1 - pa_)
    # the doorway of the big sliding door (drawn live): what you see through it when it slides open —
    # the Game Hall floor and, higher up, its RIZE wall.
    door = np.zeros((H, W_NEW), np.uint8)
    fill(door, [P(T0, DOOR[0]), P(T0, DOOR[1]), P(T0, DOOR[1], WALL_H), P(T0, DOOR[0], WALL_H)])
    ys, xs = np.nonzero(door)
    # walk back along the view ray (tile -1,-1 per 51.9 px up) until the floor or the RIZE wall is hit
    tx0, ty0 = TX[ys, xs], TY[ys, xs]                    # floor tile if nothing were in the way
    gh = walnut_floor() * (np.array([102, 140, 190], np.float32) / WALNUT)[None, None, :] * 0.95
    for i, (x_, y_) in enumerate(zip(xs, ys)):
        t, u = tx0[i], ty0[i]
        if u >= RIZE_Y and t < T0:                      # Game Hall floor (its oak herringbone)
            c[y_, x_] = gh[y_, x_] * (0.85 + 0.15 * min(1, (u - RIZE_Y) / 1.5))
        else:
            # RIZE wall face (height of the pixel above its base line) or, above the wall, the wall's cap
            back = (RIZE_Y - u)                          # tiles behind the wall line along the ray
            z = back * 51.9
            c[y_, x_] = RIZE_WALL * (0.9 + 0.1 * min(1, z / 95)) if z < 95 else CAP * 0.9
    # soft shadow in the doorway
    a2 = cv.GaussianBlur(door.astype(np.float32) / 255, (0, 0), 1)[..., None]
    c = c * (1 - 0.12 * a2)
    # low front wall at the building's new right edge
    wall(c, (T1, U0), (T1, 40), 14, np.array([150, 160, 168], np.float32), back=(1, 0), grad=0.05)
    # the boardroom ends at the old picture edge: close it with a wall end
    x = w0 - 1
    cv.rectangle(c, (x - 1, 148), (x + 5, 362), (52, 50, 52), -1)
    cv.line(c, (x + 5, 148), (x + 5, 362), INK, 1, cv.LINE_AA)
    cv.line(c, (x - 1, 148), (x + 5, 148), INK, 1, cv.LINE_AA)
    cv.imwrite(out, np.clip(c, 0, 255).astype(np.uint8))

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
