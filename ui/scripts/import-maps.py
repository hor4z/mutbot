#!/usr/bin/env python3
"""Export local MU client data for the read-only radar. Requires Pillow + numpy.
Layouts and texture order mirror mu/src/common/terrain and libs/mu/getTerrainData.
No game server access and no changes to the original files.
"""
from pathlib import Path
import argparse, json, struct, shutil, re, hashlib
import numpy as np
from PIL import Image

ap=argparse.ArgumentParser();ap.add_argument('--source',default=str(Path.home()/'self/mu/public/game-assets'));ap.add_argument('--skip-textures',action='store_true');ap.add_argument('--worlds',default='1,2,3,4,5,7,8,9,10,11,34,52');args=ap.parse_args()
source=Path(args.source);out=Path(__file__).resolve().parents[2]/'assets/radar';out.mkdir(parents=True,exist_ok=True)
KEY=bytes([0xd1,0x73,0x52,0xf6,0xd2,0x9a,0xcb,0x27,0x3e,0xaf,0x59,0x31,0x37,0xb3,0xe7,0xa2])
def decrypt(b):
 d=bytearray(len(b));key=0x5e
 for i,v in enumerate(b):d[i]=((v^KEY[i%16])-key)&255;key=(v+0x3d)&255
 return bytes(d)
def attrs(b):
 d=bytearray(decrypt(b))
 for i in range(len(d)):d[i]^=[0xfc,0xcf,0xab][i%3]
 if d[0]!=0 or d[2]!=255 or d[3]!=255:raise ValueError('Invalid terrain attribute header')
 if len(d)==65540:return bytes(d[4:])
 if len(d)==131076:return np.frombuffer(d[4:],dtype='<u2').astype('u1').tobytes()
 raise ValueError('Invalid terrain attribute length')
base=['TileGrass01','TileGrass02','TileGround01','TileGround02','TileGround03','TileWater01','TileWood01','TileRock01','TileRock02']
def tile_names(w):
 names=base+([f'TileRock{i:02}' for i in range(3,8)] if w in [3,52] else ['TileRock03','TileRock04'] if w not in [1,2,11] else [])
 if w==4:names[1]='TileGrass01';names[3]='TileGround01'
 if w==8:names[3]='TileGround01';names[5]='TileGrass01'
 if w==11:names=['TileGrass01']
 return names
ranges=[(0,13,'Tree'),(20,8,'Grass'),(30,5,'Stone'),(40,3,'StoneStatue'),(44,3,'Tomb'),(50,2,'FireLight'),(56,2,'MerchantAnimal'),(65,3,'SteelWall'),(69,6,'StoneWall'),(75,4,'StoneMuWall'),(81,4,'Fence'),(91,3,'Cannon'),(96,2,'Sign'),(98,4,'Carriage'),(102,2,'Straw'),(106,4,'Well'),(115,5,'House'),(121,6,'HouseWall'),(127,3,'HouseEtc'),(130,3,'Light'),(140,7,'Furniture'),(151,3,'Beer')]
singles={43:'SteelStatue',52:'Bonfire',55:'DoungeonGate',58:'TreasureDrum',59:'TreasureChest',60:'Ship',68:'SteelDoor',80:'Bridge',85:'BridgeStone',90:'StreetLight',95:'Curtain',105:'Waterspout',110:'Hanging',111:'Stair',120:'Tent',150:'Candle'}
def model_name(w,id):
 if w==1:
  for start,count,prefix in ranges:
   if start<=id<start+count:return f'{prefix}{id-start+1:02}.glb'
  if id in singles:return singles[id]+'01.glb'
 return f'Object{id+1:02}.glb'

def bake(w,folder,mapping):
 # 16 pixels/tile, original repeat scale and bilinear blend at the four tile vertices.
 size=4096;scale=16;names=tile_names(w);textures=[]
 for name in names:
  p=folder/(name+'.jpg')
  if p.exists():im=Image.open(p).convert('RGB')
  else:
   p=folder/(name+'.OZJ')
   if not p.exists():textures.append(None);continue
   import io
   b=p.read_bytes();im=Image.open(io.BytesIO(b[b.index(b'\xff\xd8'):])).convert('RGB')
  textures.append(np.asarray(im))
 l1=np.frombuffer(mapping[2:65538],dtype='u1').reshape(256,256);l2=np.frombuffer(mapping[65538:131074],dtype='u1').reshape(256,256);alpha=np.frombuffer(mapping[131074:196610],dtype='u1').reshape(256,256)
 # Work in strips to avoid large temporary arrays.
 atlas=np.empty((size,size,3),dtype='u1');xp=(np.arange(size)+.5)/scale;xi=np.minimum(xp.astype(int),255);xf=xp-xi
 for start in range(0,size,128):
  yp=(np.arange(start,min(start+128,size))+.5)/scale;yi=np.minimum(yp.astype(int),255);yf=yp-yi
  aa=(alpha[yi[:,None],xi]*(1-xf)+alpha[yi[:,None],np.minimum(xi+1,255)]*xf)*(1-yf[:,None])+(alpha[np.minimum(yi+1,255)[:,None],xi]*(1-xf)+alpha[np.minimum(yi+1,255)[:,None],np.minimum(xi+1,255)]*xf)*yf[:,None];aa=aa[:,:,None]/255
  channels=[]
  for layer in (l1,l2):
   ids=layer[yi[:,None],xi];rgb=np.zeros((len(yp),size,3),dtype='f4')
   for j,t in enumerate(textures):
    if t is None:continue
    mask=ids==j
    if not mask.any():continue
    h,width=t.shape[:2];repeat=h/4 if h==256 else h
    tx=(np.floor(xp/256*repeat*width).astype(int)%width);ty=(np.floor(yp/256*repeat*h).astype(int)%h)
    sampled=t[ty[:,None],tx];rgb[mask]=sampled[mask]
   channels.append(rgb)
  # Missing secondary layer (255) means no overlay.
  aa=np.where((l2[yi[:,None],xi]<len(textures))[:,:,None],aa,0)
  atlas[start:start+len(yp)]=np.clip(channels[0]*(1-aa)+channels[1]*aa,0,255).astype('u1')
 # Original baked lighting, sampled in the same y*256+x order as the client.
 light=folder/'TerrainLight.jpg'
 if light.exists():
  lighting=np.asarray(Image.open(light).convert('RGB').resize((size,size),Image.Resampling.BILINEAR),dtype='f4')/255
  atlas=np.clip(atlas.astype('f4')*lighting,0,255).astype('u1')
 Image.fromarray(atlas).save(out/f'world{w}/ground.webp','WEBP',quality=86,method=5)

catalog={};report=[]
for w in map(int,args.worlds.split(',')):
 folder=source/f'World{w}';files=[folder/f'EncTerrain{w}.{ext}' for ext in ['att','map','obj']];height=folder/'TerrainHeight.OZB'
 if not all(p.exists() for p in files+[height]):print('Skipped world',w,'incomplete source');continue
 dest=out/f'world{w}';dest.mkdir(parents=True,exist_ok=True);(dest/'models').mkdir(exist_ok=True)
 h=height.read_bytes();assert len(h)>=1084+65536;h=h[1084:1084+65536];flags=attrs(files[0].read_bytes());(dest/'terrain.bin').write_bytes(b'MUR1'+struct.pack('<I',w)+h+flags)
 mapping=decrypt(files[1].read_bytes());assert len(mapping)>=196610
 if not args.skip_textures or not (dest/'ground.webp').exists():bake(w,folder,mapping)
 obj=decrypt(files[2].read_bytes());version,mapid,count=struct.unpack_from('<BBH',obj);assert len(obj)>=4+30*count
 models={};objects=[];missing=set()
 for i in range(count):
  id,x,y,z,rx,ry,rz,sc=struct.unpack_from('<h7f',obj,4+i*30);name=model_name(w,id);p=source/f'Object{w}'/name
  if not p.exists() or p.stat().st_size<20:missing.add(id);continue
  if not all(np.isfinite(v) for v in [x,y,z,rx,ry,rz,sc]) or sc<=0:continue
  if name not in models:shutil.copyfile(p,dest/'models'/name);models[name]=f'models/{name}'
  objects.append([name,round(x/100,5),round(y/100,5),round(z/100,5),round(rx,4),round(ry,4),round(rz,4),round(sc,5)])
 versionhash=hashlib.sha256(b''.join(p.read_bytes() for p in files)+h).hexdigest()[:12]
 manifest={'version':versionhash,'world':w,'size':256,'heightScale':.015,'terrain':'terrain.bin','texture':'ground.webp','objects':objects,'models':models,'sourceObjectCount':count,'missingObjectTypes':sorted(missing),'source':'Local MU client game-assets'}
 (dest/'map.json').write_text(json.dumps(manifest,separators=(',',':'))+'\n');catalog[str(w)]={'url':f'world{w}/map.json','version':versionhash};report.append({'world':w,'objects':len(objects),'total':count,'models':len(models),'missingTypes':sorted(missing),'heightRange':[min(h)*.015,max(h)*.015]});print(report[-1],flush=True)
(out/'catalog.json').write_text(json.dumps(catalog,indent=2)+'\n');(out/'import-report.json').write_text(json.dumps(report,indent=2)+'\n')
