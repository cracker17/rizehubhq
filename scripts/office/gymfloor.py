import cv2 as cv, numpy as np, sys
im=cv.imread(sys.argv[1]).astype(np.float32); out=sys.argv[2]
poly=np.array([(0,470),(40,486),(80,503),(120,509),(143,515),(143,628),(120,638),(80,656),(40,667),(0,712)],np.int32)
m=np.zeros(im.shape[:2],np.uint8); cv.fillPoly(m,[poly],255)
H,W=m.shape; rng=np.random.default_rng(5)
ys,xs=np.mgrid[0:H,0:W].astype(np.float32)
speck=(rng.random((H,W))>0.985).astype(np.float32)*18
n=cv.GaussianBlur(rng.standard_normal((H,W)).astype(np.float32),(0,0),3)*4
# light from the lobby (lower right) and a soft vignette towards the back wall
g=np.clip(0.72+0.0035*(ys-480)+0.001*xs,0.7,1.3)
base=np.array([56,58,60],np.float32)
col=(base[None,None,:]*g[...,None])+n[...,None]+speck[...,None]
# rubber tile seams (~32 px) along the lobby's tile directions, and a shadow along the back wall
u=(xs*0.5-ys*1.0)/1.118; v=(xs*0.62+ys*1.0)/1.176
seam=((np.abs(((u/28.0)%1)-0.5)>0.47)|(np.abs(((v/28.0)%1)-0.5)>0.47)).astype(np.float32)
col=col*(1-0.28*seam[...,None])
top=np.interp(xs,[0,40,80,120,143],[470,486,503,509,515])
sh=np.clip((ys-top)/16.0,0,1)
col=col*(0.55+0.45*sh[...,None])
a=cv.GaussianBlur(m.astype(np.float32)/255,(0,0),1.0)[...,None]
res=col*a+im*(1-a)
cv.imwrite(out,np.clip(res,0,255).astype(np.uint8))
