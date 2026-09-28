import cv2 as cv, numpy as np, sys, onnxruntime as ort
ort.set_default_logger_severity(3)
sess = ort.InferenceSession('lama.onnx', providers=['CPUExecutionProvider'])
img = cv.imread(sys.argv[1]); M = cv.imread(sys.argv[2], 0) > 0; out = sys.argv[3]; ctx = float(sys.argv[4]) if len(sys.argv) > 4 else 2.4
H, W = M.shape
def lama(crop, m):
    ib = cv.dnn.blobFromImage(crop, 1/255.0, (512, 512), (0,0,0), True, False)
    mb = (cv.dnn.blobFromImage(m.astype(np.uint8)*255, 1.0, (512, 512), (0,), False, False) > 0).astype(np.float32)
    o = sess.run(None, {'image': (ib*(1-mb)).astype(np.float32), 'mask': mb})[0][0].transpose(1,2,0)
    o = np.clip(o,0,255).astype(np.uint8)[..., ::-1]
    return cv.resize(o, (crop.shape[1], crop.shape[0]), interpolation=cv.INTER_AREA)
n, lab, st, _ = cv.connectedComponentsWithStats(M.astype(np.uint8))
for i in range(1, n):
    x, y, w, h, a = st[i]
    size = int(max(w, h, 48) * ctx); size = max(size, 128)
    cx, cy = x + w//2, y + h//2
    x0, y0 = max(0, cx - size//2), max(0, cy - size//2); x1, y1 = min(W, x0 + size), min(H, y0 + size); x0, y0 = max(0, x1 - size), max(0, y1 - size)
    crop = img[y0:y1, x0:x1].copy(); mc = M[y0:y1, x0:x1]
    res = lama(crop, mc)
    al = cv.GaussianBlur(mc.astype(np.float32), (5, 5), 0)[..., None]; al = np.maximum(al, mc[..., None])
    img[y0:y1, x0:x1] = (res*al + crop*(1-al)).astype(np.uint8)
    M[y0:y1, x0:x1] &= False
    print('cc', i, (x, y, w, h))
cv.imwrite(out, img)
