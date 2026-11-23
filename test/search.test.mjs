import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, mkdir, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeConfig,loadConfig,updateConfig } from '../src/config.mjs';
import { searchLibrary } from '../src/search/search.mjs';
import { SUPPORTED_PLATFORMS, assertSupportedPlatform, cleanupSearchTemps, embeddingText, isSupportedPlatform, passages, tokenCount } from '../src/search/engine.mjs';
import { buildSearchRuntime, selectPlatformFiles } from '../scripts/search-runtime.mjs';
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'dig-search-'));t.after(()=>rm(root,{recursive:true,force:true}));const c=await initializeConfig(root);const folder=join(c.library,'p/digs/one');await mkdir(folder,{recursive:true});await writeFile(join(folder,'dig.md'),'---\nquestion: "Gateway investigation"\nproject: '+JSON.stringify(root)+'\n---\n');const put=async(name,body,extra='')=>writeFile(join(folder,name),'---\ntitle: "Gateway report"\nsource: "x"\nagent: "x-judge"\ngenerated_at: "2026-10-29T10:00:00Z"\n'+extra+'---\n'+body);await put('x-judge.md','# Gateway report\n\n## Summary\nBrief summary.\n\n## Audit\nThe buried error E_CONN_581 appears at https://example.test/oauth/callback in a code block.\n```\nE_CONN_581\n```\n');return{root,c,folder,put};}
const search=(c,args,opts={})=>searchLibrary(c,{mode:'keyword',query:'E_CONN_581',...args},{checkConfig:false,...opts});
test('full-body code/URL matches return exact UTF-16 reader bounds and disabled-source research',async t=>{const{c}=await fixture(t);for(const query of ['E_CONN_581','https://example.test/oauth/callback']){const r=await search(c,{query});assert.equal(r.status,'complete');assert(r.hits.length);const h=r.hits[0];const full=await readFile(h.path,'utf8');assert.equal(full.slice(h.start,h.end),h.excerpt);assert.equal(h.read.offset,h.start);assert.equal(h.source,'x');assert.equal(r.coverage.searched_files,1);} });
test('within-file/filter intersections, unknown paths, timestamp validation and explicit no-match',async t=>{const{c,root}=await fixture(t);const r=await search(c,{file:'p/digs/one/x-judge.md',project:root,dig:'one',after:'2026-10-29T10:00:00Z',before:'2026-10-30T00:00:00Z'});assert.equal(r.hits.length,1);assert.deepEqual((await search(c,{query:'unfindableunique'})).hits,[]);assert.deepEqual((await search(c,{source:'github'})).hits,[]);await assert.rejects(search(c,{file:'p/digs/one/dig.md'}));await assert.rejects(search(c,{dig:'one'}));await assert.rejects(search(c,{project:root,dig:'does-not-exist'}),/Unknown dig in project/);await assert.rejects(search(c,{after:'2026-02-31T00:00:00Z'}));});
test('correction links hide only explicitly superseded reports and cycles remain visible with warnings',async t=>{const{c,put}=await fixture(t);await put('x-judge-2.md','## Body\nE_CONN_581 fixed.','supersedes: "x-judge.md"\n');let r=await search(c,{});assert.equal(r.coverage.eligible_files,1);assert(r.hits.every(h=>h.file.endsWith('x-judge-2.md')));r=await search(c,{include_superseded:true});assert.equal(r.coverage.eligible_files,2);await put('x-judge.md','E_CONN_581','supersedes: "x-judge-2.md"\n');r=await search(c,{});assert.equal(r.coverage.eligible_files,2);assert(r.warnings.some(w=>w.code==='correction_graph'));});
test('semantic off/unavailable is partial keyword fallback; successful vectors persist and are reused',async t=>{const{c}=await fixture(t);assert.equal((await search(c,{mode:'hybrid'})).warnings[0].code,'semantic_disabled');let n=0;const embedding=async()=>{n++;return Array.from({length:384},(_,i)=>i?0:1);};const enabled={...c,search:{semantic:true}};let r=await search(enabled,{mode:'hybrid'},{embedding});assert.equal(r.mode_used,'hybrid');const first=n;r=await search(enabled,{mode:'hybrid'},{embedding});assert.equal(n,first+1);assert.equal(r.status,'complete');r=await search(enabled,{mode:'hybrid'},{embedding:async()=>{throw Error('Unavailable');}});assert.equal(r.mode_used,'keyword');assert(r.hits.length);assert(r.warnings.some(w=>w.code==='semantic_unavailable'));});
test('corrupt cache rebuilds, symlink escapes refuse, deleted/changed content is not returned, cancellation preserves generation',async t=>{const{c,folder,root,put}=await fixture(t);let r=await search(c,{});const indexes=join(root,'search/indexes');const {readdir}=await import('node:fs/promises');const path=join(indexes,(await readdir(indexes))[0],'index.json');await writeFile(path,'broken');r=await search(c,{});assert(r.hits.length);await put('x-judge.md','## New\nreplacement only');assert.equal((await search(c,{})).hits.length,0);await symlink('/etc/passwd',join(folder,'escape.md'));r=await search(c,{query:'replacement'});assert.equal(r.coverage.skipped_files,1);const before=await readFile(path,'utf8');const ac=new AbortController();ac.abort();await assert.rejects(search(c,{}, {signal:ac.signal}));assert.equal(await readFile(path,'utf8'),before);});
test('passages cover long Unicode/code/audit content without token truncation or surrogate splits',()=>{const text='---\ntitle: "meta"\n---\n# Heading\n'+('😀 OAuth42/漢字 `.config`\n'.repeat(1000));const p=passages(text,'title');assert(p.length>10);for(const x of p){assert(tokenCount(embeddingText('title',x.heading,text.slice(x.start,x.end)))<=480);assert(!/[\uDC00-\uDFFF]/.test(text[x.start]));}for(let i=text.indexOf('# Heading');i<text.length;i++)if(text[i].trim())assert(p.some(x=>x.start<=i&&i<x.end));});
test('semantic setting uses one TOML field and rejects other values',async t=>{const{root}=await fixture(t);await updateConfig({search_semantic:true},root);assert.equal((await loadConfig(root)).search.semantic,true);await assert.rejects(updateConfig({search_semantic:'yes'},root));});
test('concurrent search writers publish valid generations and preserve matching vectors across scopes',async t=>{const{c,put}=await fixture(t);await put('github.md','## Body\nother E_CONN_581 evidence');const all=await Promise.all([search(c,{}),search(c,{file:'p/digs/one/github.md'})]);assert(all.every(r=>r.hits.length));assert((await search(c,{})).index_revision);});
test('changing a file during embedding rebuilds metadata and offsets once; repeated changes are partial',async t=>{const{c,put}=await fixture(t);let changed=false;const embedding=async()=>{if(!changed){changed=true;await put('x-judge.md','## Replacement\nNew_unique_details');}return Array.from({length:384},(_,i)=>i?0:1);};const r=await search({...c,search:{semantic:true}},{mode:'hybrid',query:'New_unique_details'},{embedding});assert(r.hits.length);assert(r.hits.every(h=>h.excerpt.includes('New_unique_details')));});
test('cache-write failure returns honest partial in-memory keyword results',async t=>{const{c,root}=await fixture(t);await writeFile(join(root,'search'),'blocks directory');const r=await search(c,{});assert(r.hits.length);assert.equal(r.index_revision,null);assert.equal(r.status,'partial');assert(r.warnings.some(w=>w.code==='cache_unavailable'));});

test('a search over an unchanged library writes no index; a changed file is indexed again',async t=>{const{c,root,put}=await fixture(t);const first=await search(c,{});const {readdir,stat}=await import('node:fs/promises');const indexes=join(root,'search/indexes'),folder=join(indexes,(await readdir(indexes))[0]),path=join(folder,'index.json');const before=await stat(path),bytes=await readFile(path,'utf8');const second=await search(c,{});assert.equal(second.index_revision,first.index_revision);assert.deepEqual(second.hits,first.hits);const after=await stat(path);assert.deepEqual([after.ino,after.mtimeMs],[before.ino,before.mtimeMs],'The second search wrote no index');assert.equal(await readFile(path,'utf8'),bytes);assert.deepEqual(await readdir(folder),['index.json']);await search(c,{file:'p/digs/one/x-judge.md'});assert.equal((await stat(path)).mtimeMs,before.mtimeMs,'A narrower scope over unchanged files writes nothing either');await put('x-judge.md','## Changed\nE_CONN_581 again, changed.');const third=await search(c,{});assert.notEqual(third.index_revision,first.index_revision);assert.notEqual(await readFile(path,'utf8'),bytes);});

test('startup removes crashed search temporary files and preserves live writers and research',async t=>{const{root}=await fixture(t);const folder=join(root,'search/indexes/fixture');await mkdir(folder,{recursive:true});const suffix='00000000-0000-4000-8000-000000000000.tmp';const dead=join(folder,'index.2147483647.'+suffix),live=join(folder,'index.'+process.pid+'.'+suffix),published=join(folder,'index.json');await Promise.all([dead,live,published].map(p=>writeFile(p,'preserve')));await cleanupSearchTemps(root);await assert.rejects(readFile(dead),{code:'ENOENT'});assert.equal(await readFile(live,'utf8'),'preserve');assert.equal(await readFile(published,'utf8'),'preserve');});
test('the packaged search runtime is the one at the package root, found from the sources and, by the same relative path, from the bundle in dist/',async()=>{
 const {existsSync}=await import('node:fs');const {pathToFileURL}=await import('node:url');const {RUNTIME}=await import('../src/search/engine.mjs');
 const packaged=pathToFileURL(join(process.cwd(),'runtime/dist/onnx.cjs')).href;
 assert.equal(RUNTIME,packaged);
 assert.equal(new URL('../runtime/dist/onnx.cjs',pathToFileURL(join(process.cwd(),'dist/dig.mjs'))).href,packaged,'dist/dig.mjs looks one folder up');
 assert(existsSync(new URL(packaged)));
 const bundle = await readFile(new URL(packaged), 'utf8');
 assert.match(bundle, /process\.platform,\s*process\.arch,\s*['"]onnxruntime_binding\.node['"]/);
 assert.equal(bundle.includes('darwin/arm64/onnxruntime_binding.node'), false, 'runtime/dist/onnx.cjs must resolve binding path dynamically');
 if(isSupportedPlatform()){const runtime=await import(RUNTIME);assert.equal(typeof (runtime.default??runtime).InferenceSession?.create,'function');}
});

test('local semantic search supports darwin/arm64 and linux/x64 and rejects other platforms clearly', () => {
 assert.deepEqual([...SUPPORTED_PLATFORMS], ['darwin/arm64', 'linux/x64']);
 for (const [platform, arch] of [['darwin', 'arm64'], ['linux', 'x64']]) {
  assert.equal(isSupportedPlatform(platform, arch), true, `${platform}/${arch}`);
  assert.doesNotThrow(() => assertSupportedPlatform(platform, arch));
 }
 for (const [platform, arch] of [['darwin', 'x64'], ['linux', 'arm64'], ['win32', 'x64']]) {
  assert.equal(isSupportedPlatform(platform, arch), false, `${platform}/${arch}`);
  assert.throws(() => assertSupportedPlatform(platform, arch), new RegExp(`macOS arm64 and Linux x64.*${platform}/${arch}.*Keyword search remains available`));
 }
});

test('search-runtime packages darwin/arm64 and linux/x64 bindings dynamically, preserves linux .so symlinks, and skips unsupported platforms', async t => {
 assert.deepEqual(selectPlatformFiles('darwin/arm64', ['onnxruntime_binding.node', 'libonnxruntime.1.dylib', 'libonnxruntime.1.30.0.dylib', 'other.dylib']), {
  binding: ['onnxruntime_binding.node'],
  libs: ['libonnxruntime.1.dylib'],
 });
 assert.deepEqual(selectPlatformFiles('linux/x64', ['onnxruntime_binding.node', 'libonnxruntime.so.1', 'libonnxruntime.so.1.30.0', 'libonnxruntime.so', 'README.txt']), {
  binding: ['onnxruntime_binding.node'],
  libs: ['libonnxruntime.so', 'libonnxruntime.so.1', 'libonnxruntime.so.1.30.0'],
 });
 assert.deepEqual(selectPlatformFiles('win32/x64', ['onnxruntime_binding.node', 'onnxruntime.dll']), { binding: [], libs: [] });

 const root = await mkdtemp(join(tmpdir(), 'dig-search-runtime-'));
 t.after(() => rm(root, { recursive: true, force: true }));

 // 1. Real linux/x64 files from node_modules/onnxruntime-node
 const linuxOut = join(root, 'linux-real');
 const linuxResult = await buildSearchRuntime({ root: linuxOut, packageRoot: process.cwd(), platform: 'linux', arch: 'x64', checkLoad: false, writeNotices: false });
 assert.deepEqual(linuxResult, { supported: true, platform: 'linux/x64', copied: ['onnxruntime_binding.node', 'libonnxruntime.so.1'], loadChecked: false });
 assert.deepEqual((await readdir(join(linuxOut, 'runtime/bin/napi-v6/linux/x64'))).sort(), ['libonnxruntime.so.1', 'onnxruntime_binding.node']);
 const onnxBundle = await readFile(join(linuxOut, 'runtime/dist/onnx.cjs'), 'utf8');
 assert.match(onnxBundle, /process\.platform,\s*process\.arch,\s*['"]onnxruntime_binding\.node['"]/);
 assert.equal(onnxBundle.includes('darwin/arm64/onnxruntime_binding.node'), false);

 // 2. Synthetic linux/x64 folder with versioned shared lib + symlink preserved verbatim
 const fakeBins = join(root, 'fake-bins');
 const fakeLinux = join(fakeBins, 'linux/x64');
 await mkdir(fakeLinux, { recursive: true });
 await writeFile(join(fakeLinux, 'onnxruntime_binding.node'), 'fake-binding');
 await writeFile(join(fakeLinux, 'libonnxruntime.so.1.30.0'), 'fake-so-binary');
 await symlink('libonnxruntime.so.1.30.0', join(fakeLinux, 'libonnxruntime.so.1'));
 const symOut = join(root, 'linux-symlink');
 const symResult = await buildSearchRuntime({ root: symOut, packageRoot: process.cwd(), binRoot: fakeBins, platform: 'linux', arch: 'x64', checkLoad: false, writeNotices: false });
 assert.deepEqual(symResult.copied, ['onnxruntime_binding.node', 'libonnxruntime.so.1', 'libonnxruntime.so.1.30.0']);
 const copiedLink = join(symOut, 'runtime/bin/napi-v6/linux/x64/libonnxruntime.so.1');
 assert.equal((await lstat(copiedLink)).isSymbolicLink(), true);
 assert.equal(await readlink(copiedLink), 'libonnxruntime.so.1.30.0');

 // 3. Real darwin/arm64 files from node_modules/onnxruntime-node
 const macOut = join(root, 'darwin-real');
 const macResult = await buildSearchRuntime({ root: macOut, packageRoot: process.cwd(), platform: 'darwin', arch: 'arm64', checkLoad: false, writeNotices: false });
 assert.deepEqual(macResult, { supported: true, platform: 'darwin/arm64', copied: ['onnxruntime_binding.node', 'libonnxruntime.1.dylib'], loadChecked: false });
 assert.deepEqual((await readdir(join(macOut, 'runtime/bin/napi-v6/darwin/arm64'))).sort(), ['libonnxruntime.1.dylib', 'onnxruntime_binding.node']);

 // 4. Unsupported platform skips native copy and load check gracefully
 const winOut = join(root, 'win-skip');
 const winResult = await buildSearchRuntime({ root: winOut, packageRoot: process.cwd(), platform: 'win32', arch: 'x64', writeNotices: false });
 assert.deepEqual(winResult, { supported: false, platform: 'win32/x64', copied: [], loadChecked: false });
 assert.deepEqual((await readdir(join(winOut, 'runtime'))).sort(), ['dist']);
});
