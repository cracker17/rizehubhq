"""Dev Team room edges after the gym extension (v5): one consistent concrete floor over the whole room (old part +
the part the gym extension revealed), and clean wall tops: the front-left low wall's cap (continuing to the window
wall) and the top rail of the glass partition on the front-right. Coordinates: OLD picture px (x offset E=450 in the
extended canvas). Usage: python3 fix_dev_edges.py in.png out.png"""
import os, sys
import numpy as np, cv2 as cv
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from iso import Mi, O
from floorsynth import hash2  # noqa: F401  (kept for parity with the other floor scripts)

E = 450
HERE = os.path.dirname(os.path.abspath(__file__))
BASE = lambda x: 302 - 0.62 * x            # window wall base (back-left)
FL_IN = lambda x: 362 + 0.541 * x          # front-left low wall: inner edge of its cap
FL_OUT = lambda x: 370 + 0.541 * x         # outer edge
CORNER = (186.0, FL_OUT(186.0))            # front corner: the glass partition starts here
RAIL_END = (403.0, 288.0)                  # top rail of the glass partition (up-right), ends at the dev door
XL = (362 - 302) / (-0.62 - 0.541)         # back-left corner (window base ∩ front-left wall), ~ -51.7
CAPC = np.array([56, 55, 58], np.float32)
INK = (30, 27, 26)

def P(x, y): return (x + E, y)
def fill(m, pts, v=255):
    cv.fillPoly(m, [np.array([[round((x + E) * 4), round(y * 4)] for x, y in pts], np.int32)], v, cv.LINE_AA, shift=2)
def ln(c, p, q, col=INK, th=1):
    cv.line(c, (round((p[0] + E) * 4), round(p[1] * 4)), (round((q[0] + E) * 4), round(q[1] * 4)), col, th, cv.LINE_AA, shift=2)

def main(src, out):
    img = cv.imread(src).astype(np.float32)
    H, W = img.shape[:2]
    # ---- the room's floor polygon (old px)
    m_old = cv.imread(f'{HERE}/mask-floor-dev.png', 0)
    floor = np.zeros((H, W), np.uint8)
    floor[:, E:E + m_old.shape[1]] = m_old
    poly = np.zeros((H, W), np.uint8)
    rail_y = lambda x: CORNER[1] + (RAIL_END[1] - CORNER[1]) * (x - CORNER[0]) / (RAIL_END[0] - CORNER[0])
    fill(poly, [(XL, BASE(XL)), (60, BASE(60)), (236, 188), (RAIL_END[0], RAIL_END[1]), CORNER, (XL, FL_OUT(XL))])
    floor = np.maximum(floor, poly)
    # keep painted things that stand on the floor out of the repaint: nothing (desks are sprites), but never paint
    # over the window wall (above its base line)
    ys, xs = np.mgrid[0:H, 0:W].astype(np.float32); xo = xs - E
    floor[ys < BASE(xo) - 0.5] = 0
    # ---- polished concrete laid out on the iso grid (same look as floorsynth.py's concrete)
    px, py = xo - O[0], ys - O[1]
    tx = Mi[0, 0] * px + Mi[0, 1] * py; ty = Mi[1, 0] * px + Mi[1, 1] * py
    rng = np.random.default_rng(7)
    n1 = cv.GaussianBlur(rng.standard_normal((H, W)).astype(np.float32), (0, 0), 6) * 0.9
    n2 = cv.GaussianBlur(rng.standard_normal((H, W)).astype(np.float32), (0, 0), 1.2) * 0.35
    f = 1 + n1 * 0.09 + n2 * 0.07
    jx = np.abs(((tx + 1.5) % 3.0) - 1.5); jy = np.abs(((ty + 1.5) % 3.0) - 1.5)
    f = f * np.where(np.minimum(jx, jy) < 0.02, 0.93, 1.0)
    # light: brighter by the windows (back-left), falling off towards the front; soft pools under the windows
    dwin = np.clip((ys - BASE(xo)) / 160.0, 0, 1)
    L = 1.08 - 0.16 * dwin
    L *= 1 - 0.22 * np.exp(-np.clip(ys - BASE(xo), 0, None) / 5.0)       # contact shadow at the window wall
    L *= 1 - 0.25 * np.exp(-np.clip(FL_IN(xo) - ys, 0, None) / 6.0)      # and at the front low wall
    # sample the base colour from the existing floor in the middle of the room
    mid = (floor > 0) & (xo > 60) & (xo < 200) & (ys > 250) & (ys < 380)
    base = np.median(img[mid].reshape(-1, 3), 0)
    col = base[None, None, :] * (f * L)[..., None] * np.array([0.99, 1.0, 1.02], np.float32)
    a = cv.GaussianBlur(floor.astype(np.float32) / 255, (0, 0), 0.6)[..., None]
    img = col * a + img * (1 - a)
    # ---- wall caps
    cap = np.zeros((H, W), np.uint8)
    fill(cap, [(XL, FL_IN(XL)), (CORNER[0] - 2, FL_IN(CORNER[0] - 2)), (CORNER[0] + 3, CORNER[1] - 3), CORNER, (XL, FL_OUT(XL))])
    ca = (cap / 255.0)[..., None]
    img = CAPC * ca + img * (1 - ca)
    ln(img, (XL, FL_IN(XL)), (CORNER[0] - 2, FL_IN(CORNER[0] - 2)), (96, 96, 100))      # lit top edge
    ln(img, (XL, FL_OUT(XL)), CORNER)
    ln(img, (XL, FL_IN(XL) - 0.5), (CORNER[0] - 2, FL_IN(CORNER[0] - 2) - 0.5))
    # glass partition top rail (dark aluminium, 3.5 px) from the corner up to the dev door
    rail = np.zeros((H, W), np.uint8)
    t = 3.5
    fill(rail, [(CORNER[0], CORNER[1] - t), RAIL_END, (RAIL_END[0], RAIL_END[1] + t), (CORNER[0], CORNER[1])])
    ra = (rail / 255.0)[..., None]
    img = np.array([40, 40, 44], np.float32) * ra + img * (1 - ra)
    ln(img, (CORNER[0], CORNER[1] - t), RAIL_END, (110, 110, 116))
    cv.imwrite(out, np.clip(img, 0, 255).astype(np.uint8))

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
