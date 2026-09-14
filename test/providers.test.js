import test from "node:test";
import assert from "node:assert/strict";
import { createModelProvider, createProviderRegistry, providerDefinitions } from "../server/model-providers.js";
const result={summary:"Done",files:[{path:"index.html",content:"<html></html>"}]};
for(const id of ["anthropic","deepseek","google","kimi","zai"]) test(`${id} authenticates its actual protocol and parses generation/review`,async()=>{
  const calls=[];
  const definition=providerDefinitions.find(item=>item.id===id);
  const provider=createModelProvider({id,apiKey:"private-test-key",fetchImpl:async(url,options)=>{
    calls.push({url,options,body:options.body?JSON.parse(options.body):null});
    let value;
    if(!options.body) value=id==="google"?{name:`models/${definition.model}`}:{data:[{id:definition.model}]};
    else if(id==="anthropic") value={stop_reason:"end_turn",content:[{type:"text",text:JSON.stringify(result)}]};
    else if(id==="google") value={candidates:[{finishReason:"STOP",content:{parts:[{text:JSON.stringify(result)}]}}]};
    else value={choices:[{finish_reason:"stop",message:{content:JSON.stringify(result)}}]};
    return {ok:true,json:async()=>value};
  }});
  await provider.probe();
  assert.deepEqual(await provider.build({request:"Synthetic request"}),result);
  assert.deepEqual(await provider.review({files:result.files}),result);
  const generation=calls[1];
  assert.equal(generation.body.model || definition.model,definition.model);
  assert.equal(generation.options.redirect,"error");
  assert.ok(!generation.url.includes("private-test-key"));
  if(id==="anthropic") assert.equal(generation.options.headers["x-api-key"],"private-test-key");
  else if(id==="google") assert.equal(generation.options.headers["x-goog-api-key"],"private-test-key");
  else assert.equal(generation.options.headers.Authorization,"Bearer private-test-key");
});
test("registry contains six unavailable providers and never calls APIs without credentials",()=>{
  let calls=0;
  const registry=createProviderRegistry({env:{},fetchImpl:()=>{calls++;},openaiFactory:()=>{calls++;}});
  assert.equal(registry.length,6);
  assert.ok(registry.every(item=>!item.available && item.adapter===null));
  assert.equal(calls,0);
});
test("provider aliases/configuration select only the configured adapter",()=>{
  const registry=createProviderRegistry({env:{GOOGLE_API_KEY:"secret",GEMINI_MODEL:"custom-gemini"}});
  assert.equal(registry.find(item=>item.id==="google").model,"custom-gemini");
  assert.equal(registry.filter(item=>item.adapter).length,1);
  assert.ok(!JSON.stringify(registry).includes("secret"));
});
test("all provider HTTP, network and malformed-output errors redact upstream content",async()=>{
  for(const id of ["anthropic","deepseek","google","kimi","zai"]) {
    for(const fetchImpl of [async()=>({ok:false,status:401,json:async()=>({error:"secret-upstream"})}),async()=>{throw new Error("secret-upstream");},async()=>({ok:true,json:async()=>{throw new Error("secret-upstream");}})]) {
      const provider=createModelProvider({id,apiKey:"secret-key",fetchImpl});
      await assert.rejects(provider.build({}),error=>!error.message.includes("secret"));
    }
    assert.throws(()=>createModelProvider({id,apiKey:"secret",baseUrl:"http://example.com"}),/HTTPS/);
  }
});
