import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, stat, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const exec=promisify(execFile);
export const MAX_AUDIO_BYTES=8*1024*1024;
export const MAX_AUDIO_SECONDS=120;
export interface AudioCodec { prepare(path:string,mime?:string):Promise<Buffer>; opus(bytes:Buffer):Promise<Buffer> }
const limits={timeout:30_000,maxBuffer:64*1024,windowsHide:true};
export class LightweightAudio implements AudioCodec {
  async prepare(path:string,mime?:string):Promise<Buffer>{
    const meta=await stat(path);if(!meta.isFile()||meta.size>MAX_AUDIO_BYTES)throw new Error("音频超过 8MB 限制。");
    const dir=await mkdtemp(join(tmpdir(),"audio-"));
    try {
      let input=path;
      if(mime==="audio/silk"){
        input=join(dir,"silk.wav");
        // Short-lived process: no persistent decoder/model; enforce duration before WASM allocation.
        const silkModule=import.meta.resolve("silk-wasm");
        const script=`import {readFile,writeFile} from 'node:fs/promises';import {decode,getDuration,isSilk} from ${JSON.stringify(silkModule)};
          const bytes=await readFile(process.argv[1]);const duration=getDuration(bytes);
          if(bytes.length>8388608||!isSilk(bytes)||duration<=0||duration>120000)throw Error('invalid audio');
          const r=await decode(bytes,16000);if(r.duration>120000||r.data.length>3840000)throw Error('audio too long');
          const h=Buffer.alloc(44);h.write('RIFF');h.writeUInt32LE(36+r.data.length,4);h.write('WAVEfmt ',8);h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(16000,24);h.writeUInt32LE(32000,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(r.data.length,40);
          await writeFile(process.argv[2],Buffer.concat([h,r.data]),{mode:384});`;
        await exec(process.execPath,["--max-old-space-size=96","--input-type=module","-e",script,path,input],limits);
      }
      const probe=await exec("ffprobe",["-v","error","-protocol_whitelist","file,pipe","-show_entries","format=duration","-of","default=noprint_wrappers=1:nokey=1",input],limits);
      const duration=Number(probe.stdout.trim());if(!Number.isFinite(duration)||duration<=0||duration>MAX_AUDIO_SECONDS)throw new Error("音频超过 120 秒或无法确认时长。");
      const output=join(dir,"input.wav");
      await exec("ffmpeg",["-nostdin","-v","error","-threads","1","-protocol_whitelist","file,pipe","-i",input,"-t","120","-vn","-ac","1","-ar","16000","-c:a","pcm_s16le","-fs",String(MAX_AUDIO_BYTES),output],limits);
      return await readFile(output);
    }catch(error){if(error instanceof Error&&/音频/.test(error.message))throw error;throw new Error("音频格式无法解码或转码超时，请检查 ffmpeg/ffprobe 与 SILK 依赖。");}
    finally{await rm(dir,{recursive:true,force:true});}
  }
  async opus(bytes:Buffer):Promise<Buffer>{
    if(bytes.length>MAX_AUDIO_BYTES)throw new Error("合成音频过大。");
    const dir=await mkdtemp(join(tmpdir(),"tts-"));
    try {
      const input=join(dir,"source.wav"),output=join(dir,"voice.ogg");await writeFile(input,bytes,{mode:0o600});
      const probe=await exec("ffprobe",["-v","error","-protocol_whitelist","file,pipe","-show_entries","format=duration","-of","default=noprint_wrappers=1:nokey=1",input],limits);
      const duration=Number(probe.stdout.trim());if(!Number.isFinite(duration)||duration<=0||duration>MAX_AUDIO_SECONDS)throw new Error("合成音频超过 120 秒。");
      await exec("ffmpeg",["-nostdin","-v","error","-threads","1","-protocol_whitelist","file,pipe","-i",input,"-vn","-ac","1","-ar","48000","-c:a","libopus","-b:a","32k","-fs",String(MAX_AUDIO_BYTES),output],limits);
      return await readFile(output);
    }finally{await rm(dir,{recursive:true,force:true});}
  }
}
