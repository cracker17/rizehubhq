import cv2 as cv, numpy as np, sys
from iso import img
im=cv.imread(sys.argv[1]).astype(np.float32); band=cv.imread(sys.argv[2],0)>0; col=np.array(list(map(float,sys.argv[4].split(','))),np.float32)
t0,t1,u,hgt=map(float,sys.argv[5].split(','))
ys,xs=np.nonzero(band)
pa=img((t0,u)); pb=img((t1,u))
t=np.clip((xs-pa[0])/(pb[0]-pa[0]),0,1); by=pa[1]+(pb[1]-pa[1])*t; z=np.clip((by-ys)/hgt,0,1)
rng=np.random.default_rng(1)
c=col[None,:]*(0.9+0.1*z)[:,None]*(1+rng.standard_normal(len(ys))[:,None]*0.015)
c=np.where(((by-ys)<3)[:,None], c*0.62, c)
a=np.clip(1-(z-0.7)/0.3,0,1)[:,None]  # feather into the painting at the top
im[ys,xs]=c*a+im[ys,xs]*(1-a)
cv.imwrite(sys.argv[3],im.astype(np.uint8))
