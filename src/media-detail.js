// Detail reads preserve source resolution. Only an explicit crop changes dimensions.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {resolveFfmpeg} from './ffmpeg-resolve.js';
import {sniffImage} from './media-normalize.js';

const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_MODEL_BYTES = 3 * 1024 * 1024;
const MAX_PIXELS = 64_000_000;
const MAX_EDGE = 32768;
const DEFAULT_TIMEOUT_MS = 25000;
const MIME = {jpeg:'image/jpeg',png:'image/png',gif:'image/gif',webp:'image/webp'};

function tiffOrientation(bytes) {
  if (bytes.subarray(0,6).equals(Buffer.from('Exif\0\0'))) bytes=bytes.subarray(6);
  if (bytes.length<8) return 1;
  const little=bytes.toString('ascii',0,2)==='II';
  if (!little && bytes.toString('ascii',0,2)!=='MM') return 1;
  const u16=p=>little?bytes.readUInt16LE(p):bytes.readUInt16BE(p);
  const u32=p=>little?bytes.readUInt32LE(p):bytes.readUInt32BE(p);
  if (u16(2)!==42) return 1;
  const ifd=u32(4);
  if (ifd<8 || ifd+2>bytes.length) return 1;
  const count=Math.min(u16(ifd),1024);
  for (let i=0;i<count;i++) {
    const p=ifd+2+12*i;
    if (p+12>bytes.length) break;
    if (u16(p)===0x112 && u16(p+2)===3 && u32(p+4)===1) {
      const value=u16(p+8);
      return value>=1 && value<=8?value:1;
    }
  }
  return 1;
}

// Inspect metadata without invoking a decoder or retaining EXIF in the result.
function imageMetadata(buffer,info) {
  let orientation=1, animated=info.animated, alpha=info.alpha;
  if (info.format==='jpeg') {
    for (let p=2;p+4<=buffer.length;) {
      if (buffer[p]!==0xff) break;
      const marker=buffer[p+1];
      if (marker===0xda || marker===0xd9) break;
      if (marker===0xff) {p++;continue;}
      if (marker===0x01 || marker>=0xd0 && marker<=0xd8) {p+=2;continue;}
      const size=buffer.readUInt16BE(p+2);
      if (size<2 || p+2+size>buffer.length) break;
      if (marker===0xe1 && buffer.toString('ascii',p+4,p+10)==='Exif\0\0') {
        orientation=tiffOrientation(buffer.subarray(p+4,p+2+size));
      }
      p+=2+size;
    }
  } else if (info.format==='png') {
    for (let p=8;p+12<=buffer.length;) {
      const size=buffer.readUInt32BE(p), end=p+12+size;
      if (end>buffer.length) break;
      const tag=buffer.toString('ascii',p+4,p+8);
      if (tag==='eXIf') orientation=tiffOrientation(buffer.subarray(p+8,p+8+size));
      if (tag==='acTL') animated=true;
      if (tag==='tRNS') alpha=true;
      p=end;
      if (tag==='IEND') break;
    }
  } else if (info.format==='webp') {
    for (let p=12;p+8<=buffer.length;) {
      const size=buffer.readUInt32LE(p+4),end=p+8+size;
      if (end>buffer.length) break;
      const tag=buffer.toString('ascii',p,p+4);
      if (tag==='EXIF') orientation=tiffOrientation(buffer.subarray(p+8,end));
      if (tag==='ANIM' || tag==='ANMF' || tag==='VP8X' && size>=1 && (buffer[p+8]&2)) animated=true;
      p=end+(size&1);
    }
  }
  return {orientation,animated,alpha};
}

function checkedCrop(crop,width,height) {
  if (crop==null) return null;
  if (typeof crop!=='object' || Array.isArray(crop)) throw Error('crop 必须是归一化矩形 {x,y,width,height}');
  const {x,y,width:w,height:h}=crop;
  if (![x,y,w,h].every(n=>typeof n==='number' && Number.isFinite(n)) ||
      x<0 || y<0 || w<=0 || h<=0 || x>1 || y>1 || w>1 || h>1 || x+w>1 || y+h>1) {
    throw Error('crop 坐标须为 0..1 的有限数字，宽高须大于 0，整个区域必须位于图片内');
  }
  const left=Math.floor(x*width),top=Math.floor(y*height);
  return {x:left,y:top,width:Math.ceil((x+w)*width)-left,height:Math.ceil((y+h)*height)-top};
}

function orientationFilters(orientation) {
  return {2:['hflip'],3:['hflip','vflip'],4:['vflip'],5:['transpose=clock','hflip'],
    6:['transpose=clock'],7:['transpose=clock','vflip'],8:['transpose=cclock']}[orientation] || [];
}

function runFfmpeg(executable,args,timeoutMs) {
  return new Promise(resolve=>{
    let child,timedOut=false,settled=false,timer;
    const done=result=>{if(!settled){settled=true;clearTimeout(timer);resolve(result);}};
    try {child=spawn(executable,args,{windowsHide:true,stdio:'ignore'});}
    catch {done({ok:false,error:'无法启动 ffmpeg，无法处理原图或裁剪'});return;}
    timer=setTimeout(()=>{timedOut=true;try{child.kill('SIGKILL');}catch{}},timeoutMs);
    child.once('error',error=>done({ok:false,error:error.code==='ENOENT'
      ?'找不到 ffmpeg，请配置 FFMPEG_PATH 后再读取原图或裁剪'
      :'ffmpeg 不可用，无法处理原图或裁剪'}));
    // Wait for process exit before removing its private workspace.
    child.once('close',code=>done(timedOut?{ok:false,error:'原图处理超时，请缩小 crop 区域后重试'}
      :code===0?{ok:true}:{ok:false,error:`ffmpeg 图片处理失败（退出码 ${code}）` }));
  });
}

/**
 * Prepare a full-resolution still or a crop in upright-image coordinates.
 * No implicit resize is permitted. Animated inputs produce one explicitly labelled frame.
 */
export async function prepareImageDetail(buffer,mimeType,{crop,maxModelBytes=MAX_MODEL_BYTES,
  ffmpegPath=null,tmpDir=null,timeoutMs=DEFAULT_TIMEOUT_MS}={}) {
  let width=0,height=0,originalWidth=0,originalHeight=0;
  const representation=crop==null?'reencoded':'crop';
  const failure=error=>({ok:false,buffer:null,mimeType:null,representation,width,height,
    originalWidth,originalHeight,note:'',error});
  if (!Buffer.isBuffer(buffer) || !buffer.length) return failure('图片字节为空');
  if (buffer.length>MAX_SOURCE_BYTES) return failure('原图超过 32MiB 源文件上限，未尝试解码');
  if (!Number.isFinite(maxModelBytes) || maxModelBytes<1 || !Number.isFinite(timeoutMs) || timeoutMs<1) {
    return failure('图片输出字节上限和超时必须为正数');
  }
  const budget=Math.min(MAX_MODEL_BYTES,Math.floor(maxModelBytes));
  const duration=Math.min(60000,Math.floor(timeoutMs));
  let info,metadata,region;
  try {
    info=sniffImage(buffer);
    if (!info || !MIME[info.format]) return failure('无法识别支持的原图格式（JPEG、PNG、GIF 或 WebP）');
    if (info.width>MAX_EDGE || info.height>MAX_EDGE || info.width*info.height>MAX_PIXELS) {
      return failure('原图超过 6400 万像素或单边 32768 像素解码上限');
    }
    metadata=imageMetadata(buffer,info);
    const swap=metadata.orientation>=5;
    originalWidth=swap?info.height:info.width;originalHeight=swap?info.width:info.height;
    width=originalWidth;height=originalHeight;
    region=checkedCrop(crop,originalWidth,originalHeight);
    if (region) {width=region.width;height=region.height;}
  } catch(error) {return failure(error.message || '原图元数据无效');}
  if (!region && !metadata.animated && metadata.orientation===1 && buffer.length<=budget && info.format!=='gif') {
    return {ok:true,buffer,mimeType:MIME[info.format],representation:'original',width,height,
      originalWidth,originalHeight,note:`原图 ${width}×${height}，保留原始字节与分辨率`};
  }

  const started=Date.now(),filters=orientationFilters(metadata.orientation);
  if (region) filters.push(`crop=${width}:${height}:${region.x}:${region.y}:exact=1`);
  const ffmpeg=resolveFfmpeg({ffmpegPath});
  let workspace;
  try {
    const base=tmpDir?path.resolve(tmpDir):os.tmpdir();
    fs.mkdirSync(base,{recursive:true});
    workspace=fs.mkdtempSync(path.join(base,'qqb-image-detail-'));
    const input=path.join(workspace,`input.${info.format==='jpeg'?'jpg':info.format}`);
    fs.writeFileSync(input,buffer,{mode:0o600});
    // Preserve transparency with PNG first. A needed JPEG fallback explicitly
    // identifies its white background; neither choice changes source resolution.
    const jpegAttempts=[2,4,6,8].map(quality=>({ext:'jpg',quality,flatten:metadata.alpha}));
    const attempts=metadata.alpha?[{ext:'png'},...jpegAttempts]:jpegAttempts;
    let lastError='保持分辨率重编码后仍超过图片传输上限';
    for (const [index,attempt] of attempts.entries()) {
      const remaining=duration-(Date.now()-started);
      if (remaining<=0) return failure('原图处理超时，请缩小 crop 区域后重试');
      const output=path.join(workspace,`output-${index}.${attempt.ext}`);
      const args=['-v','error','-nostdin','-y','-max_alloc','268435456','-max_pixels',String(MAX_PIXELS),'-threads','1',
        '-filter_threads','1','-filter_complex_threads','1','-protocol_whitelist','file,pipe','-noautorotate','-i',input,
        '-map_metadata','-1','-an','-sn','-dn','-frames:v','1','-threads','1'];
      if (attempt.flatten) {
        const foreground=[...filters,'format=rgba'].join(',');
        args.push('-filter_complex',`[0:v]${foreground}[fg];color=c=white:s=${width}x${height}:r=1,format=rgba[bg];`+
          '[bg][fg]overlay=shortest=1:format=auto[out]','-map','[out]');
      } else {
        args.push('-map','0:v:0');
        if (filters.length) args.push('-vf',filters.join(','));
      }
      if (attempt.ext==='png') args.push('-c:v','png','-compression_level','9','-pix_fmt','rgba');
      else args.push('-c:v','mjpeg','-q:v',String(attempt.quality),'-pix_fmt','yuvj444p');
      args.push('-fs',String(budget+1),output);
      const result=await runFfmpeg(ffmpeg,args,remaining);
      if (!result.ok) return failure(metadata.animated?`${result.error}；这是动态图，未提供完整动画`:result.error);
      const size=fs.statSync(output).size;
      if (size>0 && size<=budget) {
        const out=fs.readFileSync(output),actual=sniffImage(out);
        if (!actual || actual.width!==width || actual.height!==height) return failure('编码输出尺寸不符合原图或裁剪尺寸，未返回图片');
        const notes=[region?`原图 ${originalWidth}×${originalHeight}，局部裁剪 ${width}×${height}，未缩放`
          :`原图 ${originalWidth}×${originalHeight}，保持分辨率重编码，未缩放`];
        if (metadata.orientation!==1) notes.push('已统一 EXIF 显示方向，crop 坐标以正向图片为准');
        if (attempt.ext==='jpg') notes.push('JPEG 有损重编码');
        if (attempt.flatten) notes.push('透明背景已合成白色');
        if (metadata.animated) notes.push('动态图仅提供首帧，不代表已查看整段动画');
        return {ok:true,buffer:out,mimeType:attempt.ext==='png'?'image/png':'image/jpeg',representation,
          width,height,originalWidth,originalHeight,note:notes.join('；')};
      }
      fs.unlinkSync(output);
    }
    return failure(`${lastError}（${(budget/1024/1024).toFixed(2)}MiB），请用 crop 读取更小区域`);
  } catch {return failure('原图处理失败，未返回降清图片；请检查 ffmpeg 或使用更小的 crop 区域');}
  finally {if(workspace)try{fs.rmSync(workspace,{recursive:true,force:true});}catch{}}
}
