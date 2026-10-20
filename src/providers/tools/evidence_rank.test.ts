import { beforeEach, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { createEvidenceSchemas } from "../evidence-schemas.js";
import { executeSource } from "../outcome.js";
import { registerSecret } from "../secrets.js";
import { buildEvidenceRequest, formatEvidence, evidence_rank, EVIDENCE_MODEL, RELEVANCE } from "./evidence_rank.js";
const ARGS = { question: "What does the experiment establish about captions?", candidates: [
  { id: "context", text: "A related background explanation.", reference: "https://example.test/context" },
  { id: "contradiction", text: "The experiment explicitly found no improvement.", reference: "retained/source.json" },
  { id: "other", text: "An unrelated caption font." },
], claim: "The experiment found an improvement." };
const prior = { fetch: globalThis.fetch, key: process.env.TYPESAFE_API_KEY, state: process.env.DIG_STATE_DIR };
let dir: string, calls: any[], retained: any[];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dig-evidence-test-")); process.env.DIG_STATE_DIR = dir;
  process.env.TYPESAFE_API_KEY = "typesafe-synthetic-offline-key"; calls=[];retained=[];
  globalThis.fetch = (async () => { throw Error("Unexpected live request in offline test"); }) as typeof fetch;
});
afterEach(async () => {
  globalThis.fetch=prior.fetch;
  for(const [k,v] of [["TYPESAFE_API_KEY",prior.key],["DIG_STATE_DIR",prior.state]]){if(v===undefined)delete process.env[k!];else process.env[k!]=v;}
  await rm(dir,{recursive:true,force:true});
});
const score = (level:number) => ({type:"score",score:level,confidence:1,legend:Object.fromEntries(RELEVANCE.map((v,i)=>[String(i),v])),probabilities:Object.fromEntries(RELEVANCE.map((_,i)=>[String(i),i===level?1:0]))});
const relation = (label:string) => ({type:"choice",choice:label,confidence:1,probabilities:Object.fromEntries(["supported","contradicted","insufficient"].map(k=>[k,k===label?1:0]))});
const response = () => ({model:EVIDENCE_MODEL,answers:{relevance_0:score(2),relevance_1:score(3),relevance_2:score(0),relation_0:relation("insufficient"),relation_1:relation("contradicted"),relation_2:relation("insufficient")},usage:{input_tokens:520,output_tokens:100}});
const ctx = (signal = new AbortController().signal) => ({directory:dir,worktree:dir,sessionID:"offline",abort:signal,keep:(...args:any[])=>retained.push(args)});
const run = (args:any=ARGS,signal?:AbortSignal) => executeSource(evidence_rank,args,ctx(signal));
function mock(handler:(init:RequestInit)=>Response|Promise<Response>){globalThis.fetch=(async(url:any,init:RequestInit={})=>{calls.push({url:String(url),init});return handler(init);}) as typeof fetch;}

test("public schema only accepts the narrow helper contract; IDs, caps and duplicates are enforced before HTTP",async()=>{
 const schema=createEvidenceSchemas(Type).evidence_rank;assert.equal(Value.Check(schema,ARGS),true);
 for(const extra of [{model:"jev-latest"},{threshold:.5},{url:"https://example.test"}])assert.equal(Value.Check(schema,{...ARGS,...extra}),false);
 const invalid=[{question:" "},{question:"a".repeat(4001)},{claim:""},{candidates:[]},{candidates:Array.from({length:33},(_,i)=>({id:`id${i}`,text:"x"}))},{candidates:[{id:"a",text:"x"},{id:"a",text:"y"}]},{candidates:[{id:"../a",text:"x"}]},{candidates:[{id:"a",text:"x".repeat(6001)}]},{candidates:[{id:"a",text:"x",reference:"r".repeat(513)}]}];
 for(const changes of invalid){assert.equal((await run({...ARGS,...changes})).status,"failed");}
 assert.equal(calls.length,0);
});
test("UTF-8 state limits reject oversized Unicode without truncation or provider access",async()=>{
 const result=await run({...ARGS,candidates:[{id:"a",text:"界".repeat(4000)},{id:"b",text:"界".repeat(4000)}]});
 assert.equal(result.status,"failed");assert.match(result.text,/24000 UTF-8 bytes/);assert.equal(calls.length,0);
});
test("request maps candidates by fixed internal indices, leaves references local and redacts known credentials before sending",async()=>{
 const secret="never-send-this-test-credential";registerSecret(secret);
 mock(init=>{const b=JSON.parse(String(init.body));assert.ok(!String(init.body).includes(secret));assert.ok(!String(init.body).includes("private-reference"));assert.deepEqual(Object.keys(b.questions),["relevance_0","relation_0"]);return Response.json({model:EVIDENCE_MODEL,answers:{relevance_0:score(3),relation_0:relation("supported")},usage:{input_tokens:50,output_tokens:20}});});
 const result=await run({question:`Does ${secret} appear?`,claim:secret,candidates:[{id:"original-id",text:secret,reference:"private-reference"}]});
 assert.equal(result.status,"success");assert.equal(result.details?.candidates[0].id,"original-id");assert.equal(result.details?.candidates[0].reference,"private-reference");
 assert.equal(calls[0].url,"https://api.typesafe.ai/v1/systemone");assert.equal(calls[0].init.redirect,"error");assert.equal(retained.length,1);
});
test("all candidates remain in original order while a separate code-derived order ranks contradictions highly",async()=>{
 mock(()=>Response.json(response()));const r=await run();
 assert.equal(r.status,"success");assert.deepEqual(r.details?.candidates.map((c:any)=>c.id),ARGS.candidates.map(c=>c.id));
 assert.deepEqual(r.details?.suggestedOrder,["contradiction","context","other"]);assert.equal(r.details?.candidates[1].claimRelation.relation,"contradicted");
 assert.equal(r.details?.cost,null);assert.equal(r.details?.knownCost,undefined);assert.ok(!JSON.stringify(r).includes(ARGS.candidates[0].text));
 assert.deepEqual(r.details?.usage,{input_tokens:520,output_tokens:100});assert.match(r.text,/not truth in the world/);
});
test("optional claim creates no relation questions and ties preserve caller order",()=>{
 const request=buildEvidenceRequest({question:ARGS.question,candidates:ARGS.candidates});assert.equal(Object.keys(request.body.questions).length,3);
 const r=formatEvidence({model:EVIDENCE_MODEL,answers:{relevance_0:score(2),relevance_1:score(2),relevance_2:score(2)},usage:{input_tokens:30,output_tokens:20}},request);
 assert.equal(r.status,"success");assert.deepEqual(r.details?.suggestedOrder,["context","contradiction","other"]);assert.ok(r.details?.candidates.every((c:any)=>c.claimRelation===null));
});
test("missing judgments preserve unscored candidates, never default zero or insufficient",()=>{
 const v:any=response();delete v.answers.relevance_1;delete v.answers.relation_1;
 const r=formatEvidence(v,buildEvidenceRequest(ARGS));assert.equal(r.status,"partial");assert.equal(r.details?.candidates[1].relevance,null);assert.equal(r.details?.candidates[1].claimRelation,null);
 assert.deepEqual(r.details?.suggestedOrder,["context","other","contradiction"]);assert.equal(r.details?.candidates.length,3);
});
test("malformed scores, distributions and claim labels are unknown rather than usable rankings",()=>{
 for(const invalid of [ {...score(2),score:Infinity},{...score(2),score:-1},{...score(2),confidence:1.1},{...score(2),probabilities:{0:0,1:0,2:.5,3:0}},{...score(2),legend:{0:"changed",1:RELEVANCE[1],2:RELEVANCE[2],3:RELEVANCE[3]}},{...score(2),score:3}]){
  const v:any=response();v.answers.relevance_0=invalid;const r=formatEvidence(v,buildEvidenceRequest(ARGS));assert.equal(r.status,"partial");assert.equal(r.details?.candidates[0].relevance,null);
 }
 for(const invalid of [{...relation("supported"),choice:"true"},{...relation("supported"),choice:"contradicted"},{...relation("supported"),probabilities:{supported:1,contradicted:0,unknown:0}}]){
  const v:any=response();v.answers.relation_0=invalid;assert.equal(formatEvidence(v,buildEvidenceRequest(ARGS)).details?.candidates[0].claimRelation,null);
 }
});
test("all invalid answers fail with every candidate still represented",()=>{
 const r=formatEvidence({model:EVIDENCE_MODEL,answers:{}},buildEvidenceRequest(ARGS));assert.equal(r.status,"failed");assert.equal(r.details?.candidates.length,3);assert.ok(r.details?.candidates.every((c:any)=>c.relevance===null));
});
test("unrequested keys, model mismatch or missing usage produce explicit partial results",()=>{
 for(const patch of [{model:"jev-other"},{usage:null},{answers:{...response().answers,injected_id:score(3)}}]){
  const r=formatEvidence({...response(),...patch},buildEvidenceRequest(ARGS));assert.equal(r.status,"partial");assert.equal(r.details?.candidates.length,3);assert.ok(r.details?.warnings.length);
 }
});
test("provider errors, invalid JSON and transport failures never retry or silently substitute",async()=>{
 for(const respond of [()=>Response.json({detail:"limit"},{status:429}),()=>Response.json({error:{message:"failure"}}),()=>new Response("not JSON"),()=>{throw Error("network");}]){
  calls=[];retained=[];mock(respond);const r=await run();assert.equal(r.status,"failed");assert.equal(calls.length,1);assert.equal(retained.length,1);assert.equal(r.details?.candidates.length,3);assert.equal(r.details?.cost,null);
 }
});
test("missing credentials stay optional and issue no request",async()=>{
 delete process.env.TYPESAFE_API_KEY;const r=await run();assert.equal(r.status,"failed");assert.match(r.text,/TYPESAFE_API_KEY/);assert.equal(calls.length,0);assert.equal(r.details?.candidates.length,3);
});
test("cancellation retains a received response and does not dispatch again",async()=>{
 const abort=new AbortController();mock(()=>{abort.abort();return Response.json(response());});const r=await run(ARGS,abort.signal);
 assert.equal(r.status,"cancelled");assert.equal(calls.length,1);assert.equal(retained.length,1);assert.equal(r.details?.cost,null);
});
