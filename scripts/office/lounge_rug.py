import cv2 as cv, numpy as np
base_im=cv.imread('work5.png').astype(np.float32)
im=cv.imread('lng_lama.png').astype(np.float32); H,W=im.shape[:2]
obj=cv.imread('obj.png',0)>0
R=cv.imread('lama_mask.png',0)>0
Y,X=np.mgrid[0:H,0:W].astype(np.float32)
lum=im.mean(2)
k=(R|((X>930)&(X<1240)&(Y>530)&(lum>90)&~obj)).astype(np.float32)
lf=cv.GaussianBlur(lum*k,(0,0),22)/np.maximum(cv.GaussianBlur(k,(0,0),22),1e-3)
ref=np.median(lum[(X>940)&(X<1000)&(Y>560)&(Y<640)])
light=np.clip(lf/ref,0.7,1.35)[...,None]
# warm glow from the fireplace (upper right)
glow=np.exp(-(((X-1215)/90)**2+((Y-560)/60)**2))[...,None]
rng=np.random.default_rng(3)
cx,cy,rx,ry=1100,630,134,76
e=((X-cx)/rx)**2+((Y-cy)/ry)**2
rugm=(e<1)&~obj
fib=cv.GaussianBlur(rng.standard_normal((H,W)).astype(np.float32),(0,0),0.7)*5
lf2=cv.GaussianBlur(rng.standard_normal((H,W)).astype(np.float32),(0,0),6)*0.03
rug=np.array([142,178,214],np.float32)*np.clip(light*1.05,0.85,1.3)*(1+lf2[...,None])+fib[...,None]
rug=rug*(1+0.18*glow)+glow*np.array([-8,4,22],np.float32)
ring=(e>0.80)&(e<0.855); rug[ring]*=0.84
inner=(e>0.60)&(e<0.62); rug[inner]*=0.9
rug[e>0.955]*=0.8
aa=np.clip((1-e)/0.02,0,1)[...,None]*rugm[...,None]
out=rug*aa+im*(1-aa)
# shadows of the sofa and the table on the rug / floor
o=obj.astype(np.float32)
sh=cv.GaussianBlur(cv.warpAffine(o,np.float32([[1,0,5],[0,1,8]]),(W,H)),(0,0),6)*0.42
t=np.zeros((H,W),np.float32); cv.ellipse(t,(1160,650),(30,11),0,0,360,1,-1); sh=np.maximum(sh,cv.GaussianBlur(t,(0,0),4)*0.4)
sh*=(~obj)
out=out*(1-sh[...,None])
# walnut pedestal under the table top
ped=np.array([(1146,612),(1168,612),(1165,646),(1149,646)],np.int32)
pm=np.zeros((H,W),np.uint8); cv.fillPoly(pm,[ped],1); pm=(pm>0)&~obj
gx=np.clip((X-1146)/22,0,1)
wood=np.stack([38+26*gx,62+38*gx,100+48*gx],-1)
out[pm]=wood[pm]
cv.ellipse(out,(1157,646),(13,4),0,0,360,(34,52,80),-1,cv.LINE_AA)
cv.line(out,(1146,612),(1149,646),(30,27,26),1,cv.LINE_AA); cv.line(out,(1168,612),(1165,646),(30,27,26),1,cv.LINE_AA)
out[obj]=base_im[obj]
cv.imwrite('work6.png',np.clip(out,0,255).astype(np.uint8))
cv.imwrite('lng_vis.png',cv.resize(np.clip(out,0,255).astype(np.uint8)[520:749,920:1280],None,fx=3,fy=3))
