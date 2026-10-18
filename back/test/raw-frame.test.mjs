import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { parseRawFrame, encodeRawFrame, RAW_PACKET_BYTES, LatestFrames } from '../src/raw-frame.ts';
export function packet(id = 1, color = 0xf800) {
 const bytes=new Uint8Array(RAW_PACKET_BYTES), v=new DataView(bytes.buffer);
 bytes.set([83,67,70,87,2,1]);v.setUint16(6,160);v.setUint16(8,120);v.setUint32(10,id);
 for(let i=16;i<bytes.length;i+=2){bytes[i]=color&255;bytes[i+1]=color>>>8;}
 return bytes;
}
test('RGB565LE red/green/blue become decodable QQVGA JPEGs with original uint32 IDs',async()=>{
 for(const [id,color,channel] of [[0xffffffff,0xf800,0],[0,0x07e0,1],[1,0x001f,2]]){
  const raw=packet(id,color), parsed=parseRawFrame(raw.buffer);assert.equal(parsed.id,id);assert.equal(parsed.pixels.buffer,raw.buffer);
  const jpeg=encodeRawFrame(parsed);assert.equal(new DataView(jpeg.buffer).getUint32(0),id);
  const image=sharp(jpeg.subarray(4)), meta=await image.metadata();assert.equal(meta.format,'jpeg');assert.equal(meta.width,160);assert.equal(meta.height,120);
  const pixels=await image.raw().toBuffer();for(let c=0;c<3;c++)assert.ok(c===channel?pixels[c]>=240:pixels[c]<=15,`${color.toString(16)} channel ${c}: ${pixels[c]}`);
 }
});
test('raw v2 rejects bad magic/version/format/dimensions/flags and nonexact lengths',()=>{
 assert.equal(parseRawFrame(new ArrayBuffer(0)),null);
 for(const offset of [0,1,2,3,4,5,6,7,8,9,14,15]){const b=packet();b[offset]^=1;assert.equal(parseRawFrame(b.buffer),null,`offset ${offset}`);}
 for(const length of [8,RAW_PACKET_BYTES-1,RAW_PACKET_BYTES+1,160*120*2,320*240*2+16])assert.equal(parseRawFrame(new ArrayBuffer(length)),null);
 const jpeg=new Uint8Array([0,0,0,1,255,216,255,217]);assert.equal(parseRawFrame(jpeg.buffer),null);
 assert.throws(()=>encodeRawFrame({id:1,pixels:new Uint8Array(2)}),/invalid_raw_frame/);
});
test('latest queue bounds retained frames per device, releases replaced/cancelled streams and preserves fairness',()=>{
 const q=new LatestFrames();for(let i=0;i<10000;i++)assert.equal(q.put('a',{id:i}),i!==0);
 assert.equal(q.size,1);q.put('b',{id:1});assert.deepEqual(q.take(),{id:9999});
 q.put('a',{id:10000});assert.deepEqual(q.take(),{id:1});assert.equal(q.cancel('a'),true);assert.equal(q.size,0);assert.equal(q.take(),undefined);
});

function cameraBigEndian(raw) {
 const copy=raw.slice();
 for(let i=16;i<copy.length;i+=2)[copy[i],copy[i+1]]=[copy[i+1],copy[i]];
 return copy;
}
test('explicit big-endian camera compatibility produces exactly the canonical LE JPEG for color bars and gradients',()=>{
 const raw=packet(0xffffffff), view=new DataView(raw.buffer);
 const colors=[0xf800,0x07e0,0x001f,0xffff,0,0xffe0,0x07ff,0xf81f];
 for(let y=0;y<120;y++)for(let x=0;x<160;x++){
  const n=Math.round(x*255/159);
  const color=y<40?colors[Math.floor(x/20)]:y<80?((n>>3)<<11)|((n>>2)<<5)|(n>>3):((n>>3)<<11)|(Math.round((y-80)*63/39)<<5)|16;
  view.setUint16(16+(y*160+x)*2,color,true);
 }
 const camera=cameraBigEndian(raw), original=camera.slice();
 const le=parseRawFrame(raw.buffer), be=parseRawFrame(camera.buffer);
 assert.ok(be,'compatibility still requires a structurally valid format-1 packet');
 const expected=encodeRawFrame(le);
 assert.deepEqual(encodeRawFrame(le,'little'),expected,'default remains LE');
 assert.deepEqual(encodeRawFrame(be,'big'),expected,'explicit camera override restores identical JPEG and frame ID');
 assert.deepEqual(camera,original,'decode leaves the camera packet unchanged');
 assert.notDeepEqual(encodeRawFrame(be),expected,'mislabeled BE does not trigger automatic detection');
 assert.deepEqual(encodeRawFrame(le),expected,'byte order is per call, not global encoder state');
});
test('mislabeled camera BE red stays incorrect by default and is red only with the explicit big profile',async()=>{
 const be=parseRawFrame(cameraBigEndian(packet(7,0xf800)).buffer);
 const wrong=await sharp(encodeRawFrame(be).subarray(4)).raw().toBuffer();
 const fixed=await sharp(encodeRawFrame(be,'big').subarray(4)).raw().toBuffer();
 assert.ok(wrong[0]<20 && wrong[2]>180,'BE red interpreted as LE becomes predominantly blue');
 assert.ok(fixed[0]>=240 && fixed[1]<=15 && fixed[2]<=15,'explicit profile restores red');
 assert.throws(()=>encodeRawFrame(be,'automatic'),/invalid_rgb565_byte_order/);
 assert.throws(()=>encodeRawFrame({id:1,pixels:new Uint8Array(2)},'big'),/invalid_raw_frame/);
});
