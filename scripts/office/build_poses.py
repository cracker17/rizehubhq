"""Extra pose sprites (assets/office/poses-src/<agent>_<pose>.png, Magnific, matted) → public sprites + manifest."""
import json, os
import numpy as np
from PIL import Image
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = f'{ROOT}/assets/office/poses-src'
PUB = f'{ROOT}/apps/dashboard/public/office'
man = json.load(open(f'{PUB}/manifest.json'))
SEATED = {'sofa_back': (0.42, 0.7)}
FIXED_AX = {'pingpong': 0.45, 'run': 0.47}  # wide stances: under the hips, not the back foot
for f in sorted(os.listdir(SRC)):
    who, pose = f[:-4].split('_', 1)
    im = Image.open(f'{SRC}/{f}').convert('RGBA')
    a = np.asarray(im)[..., 3]; ys, xs = np.where(a > 128)
    if pose in SEATED: ax, ay = SEATED[pose]
    else:
        foot = ys >= ys.max() - im.height * 0.13          # both feet: centre between them
        ax, ay = (float(xs[foot].min()) + float(xs[foot].max())) / 2 / im.width, 1.0
        ax = FIXED_AX.get(pose, ax)
    os.makedirs(f'{PUB}/sprites/{who}', exist_ok=True)
    im.save(f'{PUB}/sprites/{who}/{pose}.webp', quality=90, method=6)
    man['characters'][who]['poses'][pose] = {'src': f'/office/sprites/{who}/{pose}.webp', 'w': im.width, 'h': im.height, 'ax': round(ax, 3), 'ay': round(ay, 3)}
    print(who, pose, im.size, round(ax, 3), ay)
man['notes'] = man['notes'].split(' Extra poses')[0] + ' Extra poses (run, curl, foosball, sofa_back, pingpong: back views for the far side of the game tables and the lounge) come from a second Magnific sheet per agent (build_poses.py).'
json.dump(man, open(f'{PUB}/manifest.json', 'w'), indent=1)
