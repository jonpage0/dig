import { Lexer } from 'marked';
import { Tokenizer } from '@huggingface/tokenizers';
import tokenizerData from './assets/tokenizer.json' with {type:'json'};
import tokenizerConfig from './assets/tokenizer_config.json' with {type:'json'};
import manifest from './assets/manifest.json' with {type:'json'};
import { createHash, randomUUID } from 'node:crypto';
import { readFile,mkdir,writeFile,rename,rm,readdir } from 'node:fs/promises';
import { dirname,join } from 'node:path';
export const MODEL={id:manifest.model,revision:manifest.revision,dtype:'q8',pooling:'cls',dimensions:384,normalized:true};
export const tokenizer=new Tokenizer(tokenizerData,tokenizerConfig);
export const hash=value=>createHash('sha256').update(value).digest('hex');
export const tokenCount=text=>tokenizer.encode(text).ids.length;
export const queryText=text=>'Represent this sentence for searching relevant passages: '+text;
export function embeddingText(title,heading,text){
 let context=[title,heading].filter(Boolean).join(' — ');
 if(tokenCount(context)>64){let low=0,high=context.length;while(low<high){const mid=Math.ceil((low+high)/2);if(tokenCount(context.slice(0,mid))<=64)low=mid;else high=mid-1;}context=context.slice(0,low);}
 return context+'\n'+text;
}
export function passages(text,title){
 let start=/^---\r?\n/.test(text)?(text.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0].length??0):0;
 let position=start; const headings=[]; for(const block of Lexer.lex(text.slice(start))){if(block.type==='heading')headings.push({at:position,label:block.text});position+=block.raw.length;}
 const result=[];
 while(start<text.length){
  let end=Math.min(text.length,start+1800);
  if(end<text.length&&/[\uDC00-\uDFFF]/.test(text[end]))end--;
  while(tokenCount(text.slice(start,end))>320){let n=start+Math.floor((end-start)*.85);if(n<=start)n=start+1;if(/[\uDC00-\uDFFF]/.test(text[n]))n--;end=Math.max(start+1,n);}
  if(end<text.length){const para=text.lastIndexOf('\n\n',end);if(para>start+(end-start)/2)end=para+2;}
  const heading=headings.filter(h=>h.at<=start).at(-1)?.label??null;
  while(tokenCount(embeddingText(title,heading,text.slice(start,end)))>480&&end>start+2)end--;
  if(/[\uDC00-\uDFFF]/.test(text[end]))end--;
  if(text.slice(start,end).trim())result.push({start,end,heading,vector:null});
  start=end;
 }
 return result;
}
let queue=Promise.resolve(),session=null,sessionPath=null,timer=null;
function serialized(task){const next=queue.then(task);queue=next.catch(()=>{});return next;}
async function verified(path,asset){try{const bytes=await readFile(path);return bytes.length===asset.bytes&&hash(bytes)===asset.sha256;}catch{return false;}}
export async function installAssets(state,signal){
 const base=join(state,'search/models',manifest.revision);
 for(const asset of manifest.files){
  signal?.throwIfAborted();const path=join(base,asset.path);if(await verified(path,asset))continue;
  await mkdir(dirname(path),{recursive:true});
  const response=await fetch(asset.url,{signal});if(!response.ok)throw Error('Model asset download failed: HTTP '+response.status);const bytes=Buffer.from(await response.arrayBuffer());
  if(bytes.length!==asset.bytes||hash(bytes)!==asset.sha256)throw Error('Model asset integrity check failed: '+asset.path);
  const temporary=path+'.'+process.pid+'.'+randomUUID()+'.tmp';try{await writeFile(temporary,bytes,{mode:0o600});signal?.throwIfAborted();await rename(temporary,path);}finally{await rm(temporary,{force:true});}
 }
 return join(base,'onnx/model_quantized.onnx');
}
export function embed(state,text,signal){return serialized(async()=>{
 signal?.throwIfAborted();clearTimeout(timer);
 if(process.platform!=='darwin'||process.arch!=='arm64')throw Error('Local semantic search is currently packaged for macOS arm64. Keyword search remains available.');
 const path=join(state,'search/models',manifest.revision,'onnx/model_quantized.onnx');
 if(!session||sessionPath!==path)await installAssets(state,signal);
 if(!session||sessionPath!==path){await session?.release();session=null;const runtime=await import(new URL('../runtime/dist/onnx.cjs',import.meta.url).href);session=await (runtime.default??runtime).InferenceSession.create(path,{executionProviders:['cpu'],intraOpNumThreads:4,interOpNumThreads:1});sessionPath=path;}
 const runtime=await import(new URL('../runtime/dist/onnx.cjs',import.meta.url).href);const ort=runtime.default??runtime;
 const encoded=tokenizer.encode(text);if(encoded.ids.length>480)throw Error('Embedding input exceeds 480 tokens');
 const n=encoded.ids.length,feeds={input_ids:new ort.Tensor('int64',BigInt64Array.from(encoded.ids,BigInt),[1,n]),attention_mask:new ort.Tensor('int64',BigInt64Array.from(encoded.attention_mask,BigInt),[1,n])};
 if(session.inputNames.includes('token_type_ids'))feeds.token_type_ids=new ort.Tensor('int64',new BigInt64Array(n),[1,n]);
 let output;
 try{output=await session.run(feeds);signal?.throwIfAborted();const t=output.last_hidden_state??Object.values(output)[0];const v=Array.from(t.data.slice(0,384)),norm=Math.hypot(...v);if(!Number.isFinite(norm)||!norm)throw Error('Invalid embedding');return v.map(x=>x/norm);}
 finally{for(const t of Object.values(output??{}))t.dispose();for(const t of Object.values(feeds))t.dispose();timer=setTimeout(()=>{void serialized(async()=>{await session?.release();session=null;sessionPath=null;});},60000);timer.unref();}
});}

// A crash leaves only derivative temporary files. Preserve any live writer,
// including another MCP process using the same state directory.
export async function cleanupSearchTemps(state){
 async function walk(directory){
  const entries=await readdir(directory,{withFileTypes:true}).catch(()=>[]);
  for(const entry of entries){
   const path=join(directory,entry.name);
   if(entry.isDirectory())await walk(path);
   else if(entry.isFile()){
    const match=entry.name.match(/\.(\d+)\.[0-9a-f-]{36}\.tmp$/);
    if(!match)continue;
    try{process.kill(Number(match[1]),0);}catch(error){if(error.code==='ESRCH')await rm(path,{force:true}).catch(()=>{});}
   }
  }
 }
 await walk(join(state,'search'));
}
