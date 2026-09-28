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
