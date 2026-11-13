import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {deflateSync} from 'node:zlib';
import {spawnSync} from 'node:child_process';
import {test,after} from 'node:test';
import {prepareImageDetail} from '../src/media-detail.js';
import {sniffImage} from '../src/media-normalize.js';
import {resolveFfmpeg,isFfmpegAvailable} from '../src/ffmpeg-resolve.js';

const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'qqb-detail-test-'));
after(()=>fs.rmSync(workspace,{recursive:true,force:true}));
const ffmpeg=resolveFfmpeg(),hasFfmpeg=isFfmpegAvailable();
const crcTable=Array.from({length:256},(_,n)=>{
  for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;
  return n>>>0;
});
function chunk(type,data) {
  const bytes=Buffer.concat([Buffer.from(type),data]);let crc=0xffffffff;
  for(const b of bytes)crc=crcTable[(crc^b)&255]^(crc>>>8);
  const out=Buffer.alloc(bytes.length+8);
  out.writeUInt32BE(data.length);bytes.copy(out,4);out.writeUInt32BE((crc^0xffffffff)>>>0,out.length-4);
  return out;
}
function png(width,height,{noise=false,alpha=false,quadrants=false}={}) {
  const channels=alpha?4:3,row=1+channels*width,data=Buffer.alloc(row*height);
  let random=123456789;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
    const p=y*row+1+x*channels;
    for(let c=0;c<3;c++) {
      random^=random<<13;random^=random>>>17;random^=random<<5;
      data[p+c]=noise?random&255:quadrants?(c===(x<width/2?0:2)?240:8):(x+y+c*71)%256;
    }
    if(alpha)data[p+3]=(x+y)%3?255:0;
  }
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);
  header[8]=8;header[9]=alpha?6:2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(data)),chunk('IEND',Buffer.alloc(0))]);
}
const source=png(2401,1501);
const real=options=>({skip:!hasFfmpeg,...options});
function encodeJpeg(bytes) {
  const input=path.join(workspace,'orientation-input.png'),output=path.join(workspace,'orientation-input.jpg');
  fs.writeFileSync(input,bytes);
  const r=spawnSync(ffmpeg,['-v','error','-y','-i',input,'-frames:v','1','-q:v','2',output],{windowsHide:true,stdio:'ignore',timeout:15000});
  assert.equal(r.status,0,'fixture JPEG must encode');return fs.readFileSync(output);
}
function withOrientation(jpeg,value) {
  const tiff=Buffer.alloc(26);tiff.write('II');tiff.writeUInt16LE(42,2);tiff.writeUInt32LE(8,4);
  tiff.writeUInt16LE(1,8);tiff.writeUInt16LE(0x112,10);tiff.writeUInt16LE(3,12);tiff.writeUInt32LE(1,14);tiff.writeUInt16LE(value,18);
  const payload=Buffer.concat([Buffer.from('Exif\0\0'),tiff]),header=Buffer.from([0xff,0xe1,0,0]);
  header.writeUInt16BE(payload.length+2,2);
  return Buffer.concat([jpeg.subarray(0,2),header,payload,jpeg.subarray(2)]);
}

await test('detail returns a small high-resolution original without the 1280 resize',async()=>{
  const result=await prepareImageDetail(source,'image/jpeg');
  assert.equal(result.ok,true,result.error);assert.equal(result.buffer,source);
  assert.equal(result.mimeType,'image/png');assert.equal(result.representation,'original');
  assert.deepEqual([result.width,result.height,result.originalWidth,result.originalHeight],[2401,1501,2401,1501]);
});

await test('detail validates normalized crop bounds before decoding',async()=>{
  for(const crop of [[],{x:0,y:0,width:0,height:1},{x:-0.1,y:0,width:.5,height:1},
    {x:.5,y:0,width:.51,height:1},{x:0,y:.9,width:1,height:.11},{x:1,y:0,width:.01,height:1},
    {x:NaN,y:0,width:1,height:1},{x:0,y:0,width:Infinity,height:1},{x:'0',y:0,width:1,height:1}]) {
    const result=await prepareImageDetail(source,'image/png',{crop});
    assert.equal(result.ok,false);assert.match(result.error,/crop/);assert.equal(result.buffer,null);
  }
});

await test('detail rejects oversized source bytes and decode dimensions',async()=>{
  assert.match((await prepareImageDetail(Buffer.alloc(32*1024*1024+1),'image/png')).error,/32MiB/);
  const bomb=Buffer.from(png(1,1));bomb.writeUInt32BE(10000,16);bomb.writeUInt32BE(10000,20);
  assert.match((await prepareImageDetail(bomb,'image/png')).error,/像素.*上限/);
  assert.equal((await prepareImageDetail(Buffer.from('not an image'),'image/png')).ok,false);
  assert.equal((await prepareImageDetail(source,'image/png',{maxModelBytes:0})).ok,false);
});

await test('detail reports unavailable ffmpeg while an untouched original remains readable',async()=>{
  const oldPath=process.env.PATH,oldFfmpeg=process.env.FFMPEG_PATH;
  try {
    process.env.PATH='';delete process.env.FFMPEG_PATH;
    const result=await prepareImageDetail(source,'image/png',{crop:{x:0,y:0,width:.5,height:1},tmpDir:workspace});
    assert.equal(result.ok,false);assert.match(result.error,/ffmpeg/i);
    assert.equal((await prepareImageDetail(source,'image/png')).representation,'original');
  } finally {
    if(oldPath===undefined)delete process.env.PATH;else process.env.PATH=oldPath;
    if(oldFfmpeg===undefined)delete process.env.FFMPEG_PATH;else process.env.FFMPEG_PATH=oldFfmpeg;
  }
});

await test('real ffmpeg crops at full resolution, including odd dimensions and outer edges',real(),async()=>{
  const result=await prepareImageDetail(source,'image/png',{crop:{x:0,y:0,width:1,height:1},ffmpegPath:ffmpeg,tmpDir:workspace});
  assert.equal(result.ok,true,result.error);assert.equal(result.representation,'crop');
  assert.deepEqual([result.width,result.height],[2401,1501]);
  const edge=await prepareImageDetail(source,'image/png',{crop:{x:.9,y:.9,width:.1,height:.1},ffmpegPath:ffmpeg,tmpDir:workspace});
  assert.equal(edge.ok,true,edge.error);assert.deepEqual([edge.width,edge.height],[241,151]);
});

await test('real ffmpeg recompresses a large opaque image without changing dimensions',real(),async()=>{
  const noisy=png(1701,1201,{noise:true});
  assert.ok(noisy.length>3*1024*1024);
  const result=await prepareImageDetail(noisy,'image/png',{ffmpegPath:ffmpeg,tmpDir:workspace});
  assert.equal(result.ok,true,result.error);assert.equal(result.representation,'reencoded');
  assert.ok(result.buffer.length<=3*1024*1024);
  assert.deepEqual([result.width,result.height],[1701,1201]);
  assert.deepEqual([sniffImage(result.buffer).width,sniffImage(result.buffer).height],[1701,1201]);
});

await test('real ffmpeg preserves alpha first and labels a necessary white-background JPEG',real(),async()=>{
  const small=await prepareImageDetail(png(101,79,{alpha:true}),'image/png',{
    crop:{x:0,y:0,width:1,height:1},ffmpegPath:ffmpeg,tmpDir:workspace});
  assert.equal(small.ok,true,small.error);assert.equal(small.mimeType,'image/png');
  const result=await prepareImageDetail(png(401,301,{noise:true,alpha:true}),'image/png',{
    maxModelBytes:150000,ffmpegPath:ffmpeg,tmpDir:workspace});
  assert.equal(result.ok,true,result.error);assert.equal(result.mimeType,'image/jpeg');
  assert.match(result.note,/透明背景已合成白色/);assert.deepEqual([result.width,result.height],[401,301]);
});

await test('real ffmpeg keeps EXIF orientation consistent before crop coordinates',real(),async()=>{
  const jpeg=withOrientation(encodeJpeg(png(240,120,{quadrants:true})),6);
  const result=await prepareImageDetail(jpeg,'image/jpeg',{
    crop:{x:0,y:0,width:1,height:.5},ffmpegPath:ffmpeg,tmpDir:workspace});
  assert.equal(result.ok,true,result.error);assert.deepEqual([result.originalWidth,result.originalHeight],[120,240]);
  assert.deepEqual([result.width,result.height],[120,120]);assert.match(result.note,/EXIF.*正向/);
  const file=path.join(workspace,'oriented-crop.jpg'),raw=path.join(workspace,'oriented-crop.rgb');fs.writeFileSync(file,result.buffer);
  const decoded=spawnSync(ffmpeg,['-v','error','-y','-i',file,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24',raw],{windowsHide:true,stdio:'ignore',timeout:15000});
  assert.equal(decoded.status,0);const pixel=fs.readFileSync(raw).subarray(3*(60*120+60),3*(60*120+60)+3);
  assert.ok(pixel[0]>200 && pixel[2]<30,'top-half crop of the upright image must select the red half');
});

await test('detail explicitly limits animated GIF and APNG reads to one frame',real(),async()=>{
  const head='47494638396101000100800000ffffff000000';
  const frame='21f9040100000000'+'2c0000000001000100000202440100';
  const gif=Buffer.from(head+frame+frame+'3b','hex');
  const result=await prepareImageDetail(gif,'image/gif',{ffmpegPath:ffmpeg,tmpDir:workspace});
  assert.equal(result.ok,true,result.error);assert.notEqual(result.representation,'original');
  assert.match(result.note,/动态图仅提供首帧/);assert.equal(sniffImage(result.buffer).animated,false);
  const anim=Buffer.alloc(8);anim.writeUInt32BE(2);
  const fakeApng=Buffer.concat([source.subarray(0,33),chunk('acTL',anim),source.subarray(33)]);
  const apng=await prepareImageDetail(fakeApng,'image/png',{ffmpegPath:ffmpeg,tmpDir:workspace});
  assert.notEqual(apng.representation,'original');
  assert.match(apng.ok?apng.note:apng.error,/动态图/);
});

await test('detail fails explicitly rather than shrinking when its byte budget is impossible',real(),async()=>{
  const result=await prepareImageDetail(source,'image/png',{maxModelBytes:100,ffmpegPath:ffmpeg,tmpDir:workspace});
  assert.equal(result.ok,false);assert.equal(result.buffer,null);assert.match(result.error,/crop/);
  assert.deepEqual([result.width,result.height],[2401,1501]);
});

await test('detail processing has one bounded timeout and cleans private workspaces',real(),async()=>{
  const result=await prepareImageDetail(source,'image/png',{crop:{x:0,y:0,width:1,height:1},
    timeoutMs:1,ffmpegPath:ffmpeg,tmpDir:workspace});
  assert.equal(result.ok,false);assert.match(result.error,/超时/);
  assert.equal(fs.readdirSync(workspace).some(name=>name.startsWith('qqb-image-detail-')),false);
});
