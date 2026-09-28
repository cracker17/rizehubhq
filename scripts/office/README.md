# Office art pipeline

How the painted office in `apps/dashboard/public/office/` was made. Re-run these only to rebuild the art.

## Background (`office-bg.webp`)
Source: `assets/office/reference-office.png` (the approved reference picture, 1337×749).

1. People, status pills and the garbled baked-in labels are removed with LaMa inpainting
   (`inpainting_lama_2025jan.onnx` from github.com/opencv/opencv_zoo, run with onnxruntime):
   ```bash
   pip install onnxruntime opencv-python-headless numpy
   WORK=/tmp/office SRC=assets/office/reference-office.png REG=scripts/office/regions-pass1.json OUT=/tmp/office/p1.png python3 scripts/office/clean_background.py
   WORK=/tmp/office SRC=/tmp/office/p1.png REG=scripts/office/regions-pass2.json OUT=/tmp/office/p2.png python3 scripts/office/clean_background.py
   WORK=/tmp/office SRC=/tmp/office/p2.png REG=scripts/office/regions-pass3.json OUT=/tmp/office/p3.png python3 scripts/office/clean_background.py
   ```
   All masked regions are filled with one global mask, otherwise LaMa copies the remaining people
   into the holes.
2. Empty chairs were composited back at the desks whose chairs were hidden by a person (a Design
   Studio chair, mirrored). Result: `assets/office/office-bg.png` (1x).
3. `office-bg.webp` = 2x Lanczos upscale + light unsharp mask, WebP q88.

Room names, the doormat text, the wall screens and the approval bubble are HTML overlays
(`OfficeMap.tsx`), positioned from `apps/dashboard/office/layout.json`.

## Characters (`sprites/<agent>/<pose>.webp`)
One Magnific pose sheet per character (GPT 2 model, 2:1, 2k, transparent background; 8 poses in a
2×4 grid: stand, walk, stand_back, walk_back, sit_type, coffee, sofa, action). Each pose is cut out
of the sheet and matted from two captures (on black and on white) with `matte_sprite.py`, scaled so
the standing pose is 380 px tall, and listed in `public/office/manifest.json` with its floor anchor.

To add an agent: generate a sheet with the same prompt layout, add `sprites/<agent-id>/`, add the
manifest entry, and give the agent a desk (`agents.desk = {"id": "<seat id>"}` or the
`assignments` block in `layout.json`).

## Furniture rebuild (v3: sprite desks, chairs, gym)
The painted desks/chairs in the Dev Team and Growth & Sales rooms were removed and replaced by sprites so
people can sit at every desk and chairs can move:

1. **Floors**: the old furniture was on the floor, so those floors are repainted instead of inpainted
   (LaMa smears large holes): `floorsynth.py` fills a floor polygon (`mask-floor-*.png`) with a
   procedural material laid out on the iso grid (`iso.py`: herringbone parquet for Growth & Sales,
   polished concrete for the Dev Team), lit by the painting's own low-frequency light:
   ```bash
   python3 floorsynth.py office-bg.png mask-floor-growth.png mask-old-furniture.png parquet s1.png
   python3 floorsynth.py s1.png mask-floor-dev.png mask-old-furniture.png concrete s2.png
   python3 lamacc.py s2.png mask-furniture-leftovers.png s3.png 2.6   # small leftovers on walls/glass
   ```
   (`lamacc.py` inpaints each connected mask component in its own window; it needs `lama.onnx`.)
   The design and QA chairs were inpainted the same way (they are sprites now too).
2. **Gym**: the dark room left of the Lounge became a glass-fronted gym: `gymfloor.py` paints its rubber
   floor over the old low wall; the glass front and its door are drawn by the scene (`glassWalls`, `doors`
   in layout.json). A lobby plant in front of the new door was inpainted.
3. **Sprites** (Magnific, matted like the characters): `assets/office/furniture-src/*.png` →
   `build_furniture.py` → `public/office/furniture/` (sheared onto the painting's grid, world scale, with
   floor anchor, footprint in tiles and monitor quads). Placed by `furniture` in layout.json.
4. **Extra poses** (`assets/office/poses-src`, a second Magnific sheet per agent: treadmill run, dumbbell
   curl, foosball / ping-pong / sofa seen from behind) → `build_poses.py` → sprites + manifest.
5. **Portraits**: one Magnific sheet of seven painted head-and-shoulders portraits, cropped to
   `public/office/portraits/<agent>.webp` (used by `<Avatar id=…>` everywhere in the dashboard).

Depth: desks and occluders (`occluders` in layout.json: pieces of the picture such as the Dev Team's glass
front, the lounge sofa back, the boardroom table) are drawn as thin vertical slices sorted by their floor
line, so a person can be in front of one end of a desk and behind the other.

## CEO suite + sliding doors (v4)
- The painted glass door leaves were inpainted out (`mask-doors_mask.png`); the scene draws the leaves and
  slides them open. The Growth & Sales floor was redone (`mask-floor_gs2.png`, `contact.py` for the
  contact shadow along the walls, `wallband.py` for the wall base behind the old desks).
- `extend_ceo.py` widens the picture to 1560 px and paints the CEO suite (floor, window wall, slat wall,
  the doorway view into the Game Hall). Luxury furniture sprites (executive desk, leather chair, sofa, marble
  table, bookshelf, plant, arc lamp) are a Magnific sheet, matted and built by `build_furniture.py`.
