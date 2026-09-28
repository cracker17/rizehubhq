"""Widen the picture to the LEFT so the whole Gym (and the Dev Team's far corner) is visible.

Coordinates below are in the OLD picture's px (x may be negative); the output canvas is E px wider and the old
picture is pasted at x = E. Lines are the painting's own edges:
  dev window wall base  y = 297 - 0.57x   (building's back-left wall, windows + blinds, height 107)
  dev/gym divider cap   y = 371 + 0.54x   (dev floor ends here), gym-side face base y = 466 + 0.54x
  gym glass front base  y = 712 - 0.59x
  new far (front-left) cut wall base  y = 756 + 0.5x
Usage: python3 extend_gym.py in.png out.png"""
import sys
import numpy as np, cv2 as cv

E = 450
WALL_TOP = lambda x: 175 - 0.62 * x
WALL_BASE = lambda x: 302 - 0.62 * x
SL = 0.62
CAP = lambda x: 371 + 0.54 * x
DIV_BASE = lambda x: 466 + 0.54 * x
GLASS = lambda x: 712 - 0.59 * x
FAR = lambda x: 756 + 0.5 * x
EXTERIOR = np.array([31, 21, 19], np.float32)  # BGR, like extend_ceo
INK = (30, 27, 26)

def poly_mask(shape, pts):
    m = np.zeros(shape, np.uint8)
    cv.fillPoly(m, [np.array([[round((x + E) * 4), round(y * 4)] for x, y in pts], np.int32)], 255, cv.LINE_AA, shift=2)
    return m.astype(np.float32) / 255.0

def line(c, p, q, col=INK, th=1):
    cv.line(c, (round((p[0] + E) * 4), round(p[1] * 4)), (round((q[0] + E) * 4), round(q[1] * 4)), col, th, cv.LINE_AA, shift=2)

def shift_copy(c, dst_mask, dx, dy):
    """dst pixel <- canvas pixel at (x - dx, y - dy)."""
    H, W = c.shape[:2]
    M = np.float32([[1, 0, dx], [0, 1, dy]])
    moved = cv.warpAffine(c, M, (W, H), flags=cv.INTER_LINEAR, borderMode=cv.BORDER_REFLECT)
    a = dst_mask[..., None]
    c[:] = moved * a + c * (1 - a)

def main(src, out):
    old = cv.imread(src).astype(np.float32)
    H, w0 = old.shape[:2]
    W = w0 + E
    c = np.empty((H, W, 3), np.float32); c[:] = EXTERIOR
    rng = np.random.default_rng(3)
    c += cv.GaussianBlur(rng.standard_normal((H, W)).astype(np.float32), (0, 0), 6)[..., None] * 6
    c[:, E:] = old
    X0 = -E
    # corners
    xa = (466 - 302) / (-SL - 0.54)          # divider base ∩ wall base   (gym back-left)
    xb = (756 - 302) / (-SL - 0.5)           # far wall ∩ wall base      (gym front-left)
    xc = (756 - 712) / (-0.59 - 0.5)           # far wall ∩ glass          (gym front corner)
    xd = (371 - 302) / (-SL - 0.54)          # cap ∩ wall base           (dev corner)
    print('corners', xa, xb, xc, xd)
    # 1) back-left wall with windows: copy the dev window wall along its own direction (-1, 0.57), 210 px steps
    wall = poly_mask((H, W), [(24, WALL_TOP(24) - 1), (xb - 2, WALL_TOP(xb - 2) - 1), (xb - 2, WALL_BASE(xb - 2) + 1), (24, WALL_BASE(24) + 1)])
    for k in range(1, 4):
        dx = -200 * k
        seg = poly_mask((H, W), [(24 + dx, WALL_TOP(24 + dx) - 1), (24 + dx + 200, WALL_TOP(24 + dx + 200) - 1), (24 + dx + 200, WALL_BASE(24 + dx + 200) + 1), (24 + dx, WALL_BASE(24 + dx) + 1)]) * wall
        shift_copy(c, seg, dx, -SL * dx)
    # the old picture's plant + edge at x<24 in the wall band is replaced too (covered above for x<24)
    # 2) dev floor extension (between the window wall base and the divider cap): copy the floor 3 tiles along V
    fl = poly_mask((H, W), [(xd, CAP(xd)), (24, CAP(24)), (24, WALL_BASE(24)), (xd, WALL_BASE(xd))])
    for _ in range(3):
        shift_copy(c, fl, -113.4, 84.0)
    # 3) divider face (gym side) left of x=0: copy along the wall direction (1, 0.54) from the plain part x∈[0,90]
    face = poly_mask((H, W), [(xa - 2, CAP(xa - 2) + 6), (2, CAP(2) + 6), (2, DIV_BASE(2)), (xa - 2, DIV_BASE(xa - 2))])
    # plain concrete face (sampled from the painted face between the picture and the wall lamp)
    ys_, xs_ = np.mgrid[0:H, 0:W].astype(np.float32); xo = xs_ - E
    samp = (xo > 4) & (xo < 30) & (ys_ > CAP(xo) + 12) & (ys_ < DIV_BASE(xo) - 30)
    fc = np.median(c[samp].reshape(-1, 3), 0); print('face', fc)
    t = np.clip((ys_ - CAP(xo)) / np.maximum(DIV_BASE(xo) - CAP(xo), 1), 0, 1)
    fcol = fc[None, None, :] * (0.78 + 0.26 * np.sqrt(t)[..., None]) + cv.GaussianBlur(rng.standard_normal((H, W)).astype(np.float32), (0, 0), 1.2)[..., None] * 3
    # faint vertical panel joints every 40 px along the wall
    joint = (np.abs(((xo - 2) % 40) - 20) > 19.3).astype(np.float32)
    fcol = fcol * (1 - 0.12 * joint[..., None])
    c[:] = fcol * face[..., None] + c * (1 - face[..., None])
    # a long gym mirror on the divider (reflecting the windows: cool gradient + streaks, thin black frame)
    mx0, mx1 = -142, -14
    mq = [(mx0, CAP(mx0) + 18), (mx1, CAP(mx1) + 18), (mx1, DIV_BASE(mx1) - 10), (mx0, DIV_BASE(mx0) - 10)]
    mm = poly_mask((H, W), mq)
    tt = np.clip((ys_ - (CAP(xo) + 18)) / 70.0, 0, 1)
    mcol = np.array([150, 140, 128], np.float32)[None, None, :] * (1.08 - 0.25 * tt[..., None])
    streak = ((((xo - mx0) * 0.9 + (ys_ - CAP(xo)) * 0.6) % 46) < 7).astype(np.float32)
    mcol = mcol + streak[..., None] * 22
    c[:] = mcol * mm[..., None] + c * (1 - mm[..., None])
    for a_, b_ in zip(mq, mq[1:] + mq[:1]): line(c, a_, b_, (26, 24, 24), 2)
    for k in range(1, 4):
        xm = mx0 + (mx1 - mx0) * k / 4
        line(c, (xm, CAP(xm) + 18), (xm, DIV_BASE(xm) - 10), (40, 38, 38), 1)
    # divider cap band continues
    capm = poly_mask((H, W), [(xd, CAP(xd)), (2, CAP(2)), (2, CAP(2) + 6), (xd, CAP(xd) + 6)])
    c[:] = c * (1 - capm[..., None]) + np.array([62, 60, 62], np.float32) * capm[..., None]
    # 4) gym floor: rubber tiles over the whole new gym polygon (same pattern formula as gymfloor.py, old coords)
    gpoly = [(xa, DIV_BASE(xa)), (6, DIV_BASE(6)), (6, GLASS(6)), (xc, GLASS(xc)), (xb, FAR(xb))]
    gm = poly_mask((H, W), gpoly)
    ys, xs = np.mgrid[0:H, 0:W].astype(np.float32); xs -= E
    speck = (rng.random((H, W)) > 0.985).astype(np.float32) * 18
    n = cv.GaussianBlur(rng.standard_normal((H, W)).astype(np.float32), (0, 0), 3) * 4
    g = np.clip(0.72 + 0.0035 * (ys - 480) + 0.001 * xs, 0.62, 1.3)
    base = np.array([56, 58, 60], np.float32)
    col = base[None, None, :] * g[..., None] + n[..., None] + speck[..., None]
    u = (xs * 0.5 - ys * 1.0) / 1.118; v = (xs * 0.62 + ys * 1.0) / 1.176
    seam = ((np.abs(((u / 28.0) % 1) - 0.5) > 0.47) | (np.abs(((v / 28.0) % 1) - 0.5) > 0.47)).astype(np.float32)
    col = col * (1 - 0.28 * seam[..., None])
    sh = np.clip((ys - DIV_BASE(xs)) / 16.0, 0, 1) * np.clip((ys - WALL_BASE(xs)) / 12.0, 0, 1)
    col = col * (0.55 + 0.45 * sh[..., None])
    # window light pools on the floor (soft, in front of each window)
    for k in range(3):
        cx = xa - 60 - 95 * k
        cy = WALL_BASE(cx) + 30
        pool = np.exp(-(((xs - cx) / 45.0) ** 2 + ((ys - cy) / 18.0) ** 2))
        col = col * (1 + 0.25 * pool[..., None])
    c[:] = col * gm[..., None] + c * (1 - gm[..., None])
    # 5) far (front-left) cut wall: low wall with cap
    fw = poly_mask((H, W), [(xb, FAR(xb) - 12), (xc, FAR(xc) - 12), (xc, FAR(xc) + 4), (xb, FAR(xb) + 4)])
    c[:] = c * (1 - fw[..., None]) + np.array([66, 64, 66], np.float32) * fw[..., None]
    line(c, (xb, FAR(xb) - 12), (xc, FAR(xc) - 12)); line(c, (xb, FAR(xb) + 4), (xc, FAR(xc) + 4))
    line(c, (xb, FAR(xb) - 12), (xb, FAR(xb) + 4))
    # outlines: wall base, wall corner post, divider base
    line(c, (xb, WALL_BASE(xb)), (xa, WALL_BASE(xa)))
    line(c, (xb, WALL_TOP(xb)), (xb, WALL_BASE(xb)))
    line(c, (xb, WALL_TOP(xb)), (24, WALL_TOP(24)))
    line(c, (xa, DIV_BASE(xa)), (6, DIV_BASE(6)))
    line(c, (xa, CAP(xa)), (xa, DIV_BASE(xa)))
    line(c, (xd, CAP(xd)), (6, CAP(6)))
    cv.imwrite(out, np.clip(c, 0, 255).astype(np.uint8))

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
