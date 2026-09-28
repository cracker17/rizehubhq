import numpy as np
U=np.array([40.5,23.9]); V=np.array([-37.8,28.0]); O=np.array([668,0.])
M=np.array([U,V]).T; Mi=np.linalg.inv(M)
def tile(p): return Mi@(np.array(p,float)-O)
def img(t,z=0): p=O+M@np.array(t,float); return np.array([p[0],p[1]-z])
