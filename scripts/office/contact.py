import cv2 as cv, numpy as np, sys
from iso import Mi, O
im=cv.imread(sys.argv[1]).astype(np.float32); m=cv.imread(sys.argv[2],0)>0
edges=[tuple(map(float,e.split(':'))) for e in sys.argv[4].split(',')]  # axis:value  (x or y line)
H,W=m.shape; ys,xs=np.mgrid[0:H,0:W].astype(np.float32)
px,py=xs-O[0],ys-O[1]; tx=Mi[0,0]*px+Mi[0,1]*py; ty=Mi[1,0]*px+Mi[1,1]*py
s=np.ones((H,W),np.float32)
for ax,v in edges:
    d=np.abs((tx if ax==0 else ty)-v)
    s*=0.62+0.38*np.clip(d/0.45,0,1)**0.8
s=np.where(m,s,1.0)
im*=s[...,None]
cv.imwrite(sys.argv[3],np.clip(im,0,255).astype(np.uint8))
