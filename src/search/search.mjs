import { readdir,realpath,readFile,mkdir,writeFile,rename,rm,stat } from 'node:fs/promises';
import { join,resolve,dirname,isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { frontMatter,readLibraryFile } from '../library.mjs';
import { reportSources,ALL_MODULES } from '../providers/modules.ts';
import { loadConfig } from '../config.mjs';
import { MODEL,hash,passages,tokenCount,queryText,embeddingText,embed } from './engine.mjs';
import { knownSecrets,redactText } from '../providers/secrets.ts';
const vector=z.array(z.number().finite()).length(384).refine(v=>Math.abs(Math.hypot(...v)-1)<.0001).nullable();
const passage=z.object({start:z.number().int().nonnegative(),end:z.number().int().positive(),heading:z.string().nullable(),vector}).strict().refine(p=>p.end>p.start);
const cacheSchema=z.object({format:z.literal(1),library:z.string(),generation:z.string().uuid(),model:z.object({id:z.literal(MODEL.id),revision:z.literal(MODEL.revision),dtype:z.literal('q8'),pooling:z.literal('cls'),dimensions:z.literal(384),normalized:z.literal(true)}).strict(),chunker:z.literal('markdown-v1'),files:z.array(z.object({file:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/),passages:z.array(passage)}).strict())}).strict();
const terms=text=>(text.toLowerCase().match(/[\p{L}\p{N}_]+/gu)??[]);
const date=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
const compare=(a,b)=>b.score-a.score||a.file.localeCompare(b.file)||a.start-b.start||a.end-b.end;
const validTime=value=>/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,19)===value.slice(0,19);
async function dirs(path){try{return await readdir(path,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return[];throw e;}}
export async function searchLibrary(config,args,{signal,embedding=embed,checkConfig=true,retried=false}={}){
 const mode=args.mode??'hybrid',limit=args.limit??10,query=args.query.trim();
 if(!query||query.length>2000||tokenCount(queryText(query))>480)throw Error('query must be 1–2000 characters and at most 480 model tokens including its prefix');
 for(const key of ['after','before'])if(args[key]&&!validTime(args[key]))throw Error(key+' must be a valid UTC ISO timestamp');
 if(args.after&&args.before&&Date.parse(args.after)>=Date.parse(args.before))throw Error('after must be before before');
 if(args.dig&&!args.project)throw Error('dig requires project');
 if(args.project&&(!isAbsolute(args.project)||!(await stat(args.project)).isDirectory()))throw Error('project must be an existing absolute directory');
 const project=args.project?await realpath(args.project):null;
 let library;try{library=await realpath(config.library);}catch(e){if(e.code!=='ENOENT')throw e;if(args.file)throw Error('Selected library does not exist');library=resolve(config.library);}
 const warnings=[];const warn=(code,message)=>{message=redactText(message,knownSecrets());if(!warnings.some(w=>w.code===code&&w.message===message))warnings.push({code,message});};
 const docs=[];
 for(const dir of await dirs(library)){
  if(!dir.isDirectory()||dir.isSymbolicLink())continue;
  for(const dig of await dirs(join(library,dir.name,'digs'))){
   if(!dig.isDirectory()||dig.isSymbolicLink())continue;
   const prefix=join(dir.name,'digs',dig.name);let meta={},metaError=null;
   try{meta=frontMatter((await readLibraryFile(config,join(prefix,'dig.md'),0,Number.MAX_SAFE_INTEGER)).text);}catch(e){metaError=e;}
   const entries=await dirs(join(library,prefix));
   for(const f of entries){
    if(!f.name.endsWith('.md')||f.name==='dig.md'||(!f.isFile()&&!f.isSymbolicLink()))continue;
    const file=join(prefix,f.name);let read,head={},error=metaError;
    try{read=await readLibraryFile(config,file,0,Number.MAX_SAFE_INTEGER);head=frontMatter(read.text);}catch(e){error=e;}
    const kind=f.name==='answer.md'?'answer':'report';let p=typeof meta.project==='string'?meta.project:null;
    if(p){try{p=await realpath(p);}catch{p=resolve(p);}}
    const doc={file,path:read?.path??join(library,file),project:p,dig:dig.name,kind,source:kind==='answer'?null:head.source??null,method:kind==='answer'?null:head.agent??null,title:head.title??read?.text.match(/^# (.+)$/m)?.[1]??meta.question??f.name,question:meta.question??'',at:date(kind==='answer'?head.finished_at:head.generated_at),superseded:false,replaces:head.supersedes??null,text:read?.text,error};

    docs.push(doc);
   }
  }
 }
 if(args.dig&&!docs.length){const exists=await dirs(join(library));let found=false;for(const d of exists)if(d.isDirectory()){try{const m=frontMatter((await readLibraryFile(config,join(d.name,'digs',args.dig,'dig.md'),0,Number.MAX_SAFE_INTEGER)).text);if(resolve(m.project??'')===project)found=true;}catch{}}if(!found)throw Error('Unknown dig in project');}
 // Correction links have authority only inside the same saved question.
 for(const d of docs){
  const chain=[];let current=d;let invalid=false;
  while(current?.replaces){
   const target=docs.find(x=>x.project===d.project&&x.dig===d.dig&&x.file.split('/').at(-1)===current.replaces);
   if(!target||chain.includes(target)||target===d){invalid=true;break;}chain.push(target);current=target;
  }
  if(invalid)warn('correction_graph','Invalid correction chain in '+d.file);else for(const old of chain)old.superseded=true;
 }
 let selected=docs.filter(d=>(args.include_superseded||!d.superseded)&&(!project||d.project===project)&&(!args.dig||d.dig===args.dig)&&(!args.source||d.source===args.source)&&(!args.after||d.at&&Date.parse(d.at)>=Date.parse(args.after))&&(!args.before||d.at&&Date.parse(d.at)<Date.parse(args.before)));
 if(args.file){const named=await readLibraryFile(config,args.file,0,1);if(!docs.some(d=>d.file===named.file))throw Error('file must name a report or answer matching this scope');selected=selected.filter(d=>d.file===named.file);}
 const eligible=selected.length,state=dirname(config.path),directory=join(state,'search/indexes',hash(library)),indexPath=join(directory,'index.json');
 let old=null;try{old=cacheSchema.parse(JSON.parse(await readFile(indexPath,'utf8')));if(old.library!==library||new Set(old.files.map(f=>f.file)).size!==old.files.length)old=null;}catch{}
 const indexed=[],rows=[];let skipped=0;const useSemantic=mode==='hybrid'&&config.search?.semantic;let semanticWorking=Boolean(useSemantic),queryVector=null;
 if(mode==='hybrid'&&!useSemantic)warn('semantic_disabled','Semantic search is disabled. Enable local semantic search in Dig settings for the pinned model download.');
 if(useSemantic){try{queryVector=await embedding(state,queryText(query),signal);}catch(e){signal?.throwIfAborted();semanticWorking=false;warn('semantic_unavailable',e.message);}}
 for(const d of selected){
  signal?.throwIfAborted();if(d.error){skipped++;warn('unreadable_file','Cannot read '+d.file);continue;}
  if(!d.project||d.kind==='report'&&!reportSources(ALL_MODULES).includes(d.source)||d.method!==null&&typeof d.method!=='string'||typeof d.title!=='string'||typeof d.question!=='string'){skipped++;warn('invalid_metadata','Invalid research metadata in '+d.file);continue;}
  for(let attempt=0;attempt<2;attempt++){
   if(attempt)d.text=(await readLibraryFile(config,d.path,0,Number.MAX_SAFE_INTEGER)).text;
   const sha256=hash(Buffer.from(d.text)),parts=passages(d.text,d.title),cached=old?.files.find(f=>f.file===d.file&&f.sha256===sha256);
   for(const p of parts){const previous=cached?.passages.find(x=>x.start===p.start&&x.end===p.end&&x.heading===p.heading);p.vector=cached?.passages.length===parts.length?previous?.vector??null:null;
    if(semanticWorking&&!p.vector){try{p.vector=await embedding(state,embeddingText(d.title,p.heading,d.text.slice(p.start,p.end)),signal);}catch(e){signal?.throwIfAborted();semanticWorking=false;warn('semantic_unavailable',e.message);}}
   }
   const fresh=await readLibraryFile(config,d.path,0,Number.MAX_SAFE_INTEGER).catch(()=>null);
   if(!fresh||hash(Buffer.from(fresh.text))!==sha256){if(!retried)return searchLibrary(config,args,{signal,embedding,checkConfig,retried:true});skipped++;warn('changed_during_search','File kept changing: '+d.file);break;}
   indexed.push({file:d.file,sha256,passages:parts});for(const p of parts)rows.push({...d,...p});break;
  }
 }
 if(eligible&&skipped===eligible)throw Error('No eligible research file could be searched');
 const cache={format:1,library,generation:randomUUID(),model:MODEL,chunker:'markdown-v1',files:[...indexed,...(old?.files??[]).filter(f=>!indexed.some(x=>x.file===f.file)&&docs.some(d=>d.file===f.file&&!d.error))]};let index_revision=null;
 signal?.throwIfAborted();const tmp=join(directory,'index.'+process.pid+'.'+randomUUID()+'.tmp');
 try{await mkdir(directory,{recursive:true});const bytes=JSON.stringify(cache);await writeFile(tmp,bytes,{mode:0o600});signal?.throwIfAborted();await rename(tmp,indexPath);index_revision=hash(bytes);}catch(e){signal?.throwIfAborted();semanticWorking=false;warn('cache_unavailable','Search cache could not be saved');}finally{await rm(tmp,{force:true}).catch(()=>{});}
 const termsByRow=rows.map(r=>terms([r.title,r.heading,r.text.slice(r.start,r.end)].filter(Boolean).join('\n'))),df=new Map();
 for(const t of termsByRow)for(const w of new Set(t))df.set(w,(df.get(w)??0)+1);
 const avg=termsByRow.reduce((n,t)=>n+t.length,0)/Math.max(rows.length,1),keys=[...new Set(terms(query))];
 const lexical=rows.map((r,i)=>{const tf=new Map();for(const w of termsByRow[i])tf.set(w,(tf.get(w)??0)+1);let score=0;for(const w of keys){const f=tf.get(w)??0;score+=Math.log(1+(rows.length-(df.get(w)??0)+.5)/((df.get(w)??0)+.5))*f*2.2/(f+1.2*(.25+.75*termsByRow[i].length/(avg||1)));}return {...r,score,index:i};}).filter(r=>r.score>0).sort(compare).slice(0,100);
 const dense=semanticWorking?rows.map((r,i)=>({...r,index:i,score:r.vector?queryVector.reduce((n,x,j)=>n+x*r.vector[j],0):-Infinity})).filter(r=>Number.isFinite(r.score)).sort(compare).slice(0,100):[];
 const rankings=new Map();for(const [kind,list] of [['keyword',lexical],['semantic',dense]])list.forEach((r,n)=>{const x=rankings.get(r.index)??{...r,score:0,matched_by:[]};x.score+=semanticWorking?1/(61+n):r.score;x.matched_by.push(kind);rankings.set(r.index,x);});
 const chosen=[];for(const r of [...rankings.values()].sort(compare)){if(chosen.filter(x=>x.file===r.file).length>=3||chosen.some(x=>x.file===r.file&&x.start<r.end&&r.start<x.end))continue;chosen.push(r);if(chosen.length===limit)break;}
 const hits=[];for(const r of chosen){const fresh=await readLibraryFile(config,r.path,0,Number.MAX_SAFE_INTEGER).catch(()=>null);if(!fresh||hash(Buffer.from(fresh.text))!==hash(Buffer.from(r.text))){if(!retried)return searchLibrary(config,args,{signal,embedding,checkConfig,retried:true});warn('changed_during_search','File changed before result return: '+r.file);continue;}
  let end=Math.min(r.end,r.start+2400);if(/[\uDC00-\uDFFF]/.test(r.text[end]))end--;
  hits.push(Object.fromEntries(Object.entries({file:r.file,path:r.path,project:r.project,dig:r.dig,kind:r.kind,source:r.source,method:r.method,title:r.title,question:r.question,at:r.at,superseded:r.superseded,heading:r.heading,start:r.start,end,excerpt:r.text.slice(r.start,end),score:r.score,matched_by:r.matched_by,read:{file:r.path,offset:r.start,limit:end-r.start}})));
 }
 if(checkConfig){const current=await loadConfig(state);if(resolve(current.library)!==resolve(config.library))throw Error('Library changed during search; search again in the selected library');}

 return {status:warnings.length?'partial':'complete',mode_requested:mode,mode_used:semanticWorking?'hybrid':'keyword',library,index_revision,coverage:{eligible_files:eligible,searched_files:eligible-skipped,skipped_files:skipped,semantic_passages:semanticWorking?rows.filter(r=>r.vector).length:0,lexical_passages:rows.length},warnings,hits};
}
