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
