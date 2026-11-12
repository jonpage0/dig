import { build } from 'esbuild';
import { cp,mkdir,readFile,writeFile,rm } from 'node:fs/promises';
// The package's runtime/, beside dist/: the bundled service (dist/dig.mjs) and src/search/engine.mjs load it from there.
await rm('runtime',{recursive:true,force:true});
await mkdir('runtime/dist',{recursive:true});
// Keep the binding's ../bin path valid while bundling all JS dependencies, without node_modules in the package.
await build({entryPoints:['node_modules/onnxruntime-node/dist/index.js'],outfile:'runtime/dist/onnx.cjs',bundle:true,platform:'node',format:'cjs',target:'node22',minify:true,banner:{js:"const DIG_NATIVE_BINDING = require('node:path').join(__dirname, '../bin/napi-v6/darwin/arm64/onnxruntime_binding.node');"},plugins:[{name:'fixed-cpu-binding',setup(b){b.onLoad({filter:/onnxruntime-node\/dist\/binding\.js$/},async(args)=>{const source=await readFile(args.path,'utf8');const pattern=/require\(`\.\.\/bin\/napi-v6\/\$\{process\.platform\}\/\$\{process\.arch\}\/onnxruntime_binding\.node`\)/;if(!pattern.test(source))throw Error('ONNX binding path changed');return {contents:source.replace(pattern,'require(DIG_NATIVE_BINDING)'),loader:'js'};});}}]});
const dest='runtime/bin/napi-v6/darwin/arm64';await mkdir(dest,{recursive:true});
for(const file of ['onnxruntime_binding.node','libonnxruntime.1.dylib'])await cp(`node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/${file}`,`${dest}/${file}`);
await writeFile('Search-Runtime-LICENSE',await readFile('src/search/ONNX-Runtime-LICENSE'));
await writeFile('Search-Runtime-ThirdPartyNotices.txt',await readFile('src/search/ONNX-Runtime-ThirdPartyNotices.txt'));

if(process.platform==='darwin'&&process.arch==='arm64'){const {createRequire}=await import('node:module');const {resolve}=await import('node:path');const runtime=createRequire(import.meta.url)(resolve('runtime/dist/onnx.cjs'));if(typeof runtime.InferenceSession?.create!=='function')throw Error('Packaged ONNX Runtime failed its load check');}
