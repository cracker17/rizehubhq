"""Furniture / gym sprites → public/office/furniture (sheared onto the painting's iso grid, world scale).

Sources (assets/office/furniture-src) are Magnific renders matted from black/white captures. The painting's
grid is steeper than the renders' camera, so every sprite gets the same vertical-preserving shear
(x' = x, y' = C*x + D*y) before scaling; vertical edges stay vertical. The floor anchor is the lowest
opaque point (front leg / wheel). W and D are the footprint in grid tiles (x = long side for desks),
measured from the sprite's horizontal extent: going -x one tile moves 40.5 px left, going -y one tile
moves 37.8 px right (1x picture px)."""
import json, os
import numpy as np
from PIL import Image
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = f'{ROOT}/assets/office/furniture-src'
OUT = f'{ROOT}/apps/dashboard/public/office/furniture'
C, D = -0.148, 0.931
# The luxury / bedroom renders are true 2:1 iso; this shear maps their axes exactly onto the painting's grid
# (down-right slope 23.9/40.5, up-right slope -28/37.8) so they sit parallel to the walls and rugs.
TRUE_ISO = {'sofa', 'coffee_table', 'ceo_desk', 'bookshelf', 'bookshelf_m', 'floor_lamp', 'ceo_plant', 'bed', 'bed_sleep',
            'laptop_back', 'laptop_front', 'laptop_back_m', 'laptop_front_m', 'bath_toilet_m', 'bath_vanity', 'bath_shower'}
C_ISO, D_ISO = -0.07, 1.2
WORLD = 2  # background is 2x the 1x layout pixels
SCALE = {  # 1x picture px per source px
    'desk_dual': 0.45, 'desk_single': 0.45, 'desk_design': 0.45, 'desk_qa': 0.5, 'desk_exec': 0.45,
    'chair_ur': 0.2, 'chair_dl': 0.2, 'chair_dr': 0.2,
    'ceo_desk': 0.39, 'ceo_chair': 0.16, 'sofa': 0.36, 'coffee_table': 0.2, 'bookshelf': 0.34, 'ceo_plant': 0.25, 'floor_lamp': 0.3,
    'bed': 0.75, 'bed_sleep': 0.83, 'laptop_back': 0.58, 'laptop_front': 0.52, 'laptop_back_m': 0.58, 'laptop_front_m': 0.52, 'bookshelf_m': 0.34,
    'bath_toilet_m': 0.36, 'bath_vanity': 0.36, 'bath_shower': 0.42,
    'treadmill': 0.3, 'dumbbell_rack': 0.22, 'bench': 0.24, 'bike': 0.24, 'yoga_mat': 0.24, 'plant': 0.2,
}
SCREENS = {  # monitor faces in source px (TL, TR, BR, BL)
    'desk_dual': [[[86, 3], [172, 58], [172, 133], [86, 76]], [[179, 63], [263, 116], [262, 192], [179, 139]]],
    'desk_single': [[[103, 0], [227, 80], [226, 169], [102, 88]]],
}
def shear(im, s, C=C, D=D):
    w, h = im.size
    ys = [s*(C*x + D*y) for x in (0, w) for y in (0, h)]
    oy = -min(ys); H = int(np.ceil(max(ys) + oy)) + 1; Wn = int(np.ceil(s*w)) + 1
    a = (1/s, 0, 0, -C/(s*D), 1/(s*D), -oy/(s*D))
    return im.transform((Wn, H), Image.AFFINE, a, resample=Image.BICUBIC), oy
def fwd(x, y, s, oy, C=C, D=D): return [round(s*x, 2), round(s*(C*x + D*y) + oy, 2)]
os.makedirs(OUT, exist_ok=True)
man = {}
for name, s1 in SCALE.items():
    im = Image.open(f'{SRC}/{name}.png').convert('RGBA')
    a = np.asarray(im)[..., 3]; ys, xs = np.where(a > 128)
    ay = int(ys.max()); ax = float(xs[ys >= ay - 6].mean())
    s = s1 * WORLD
    cd = (C_ISO, D_ISO) if name in TRUE_ISO else (C, D)
    out, oy = shear(im, s, *cd)
    out.save(f'{OUT}/{name}.webp', quality=90, method=6)
    A = fwd(ax, ay, s, oy, *cd)
    W = (ax - xs.min()) * s1 / 40.5
    Dp = (xs.max() - ax) * s1 / 37.8
    e = {'src': f'/office/furniture/{name}.webp', 'w': out.width, 'h': out.height, 'ax': A[0], 'ay': A[1], 'W': round(W, 3), 'D': round(Dp, 3)}
    if name in SCREENS: e['screens'] = [[fwd(x, y, s, oy, *cd) for x, y in q] for q in SCREENS[name]]
    man[name] = e
    print(name, e['w'], e['h'], e['ax'], e['ay'], e['W'], e['D'])
json.dump({'version': 1, 'notes': 'Sheared furniture sprites (build_furniture.py). ax/ay = floor anchor in texture px; W/D = footprint in grid tiles.', 'items': man}, open(f'{OUT}/manifest.json', 'w'), indent=1)
