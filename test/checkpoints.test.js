import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { migrate } from "../server/migrate.js";
import { createCheckpointService } from "../server/checkpoint-service.js";
import { json } from "../server/http.js";

const connectionString = process.env.DATABASE_URL;
const testDatabase = connectionString && /test/i.test(new URL(connectionString).pathname);
test("Checkpoint restore replaces files, preserves undo, and prevents stale/ABA saves", {skip: !testDatabase}, async t => {
  const pool = new pg.Pool({connectionString});
  let server;
  const id = randomUUID();
  t.after(async () => {
    if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await pool.query("DELETE FROM projects WHERE id=$1", [id]);
    await pool.end();
  });
  await migrate(pool);
  await pool.query("INSERT INTO projects(id,name) VALUES($1,'Checkpoint test')", [id]);
  await pool.query("INSERT INTO files(project_id,path,content) VALUES($1,'index.html','original')", [id]);
  const snapshots = new Map();
  const service = createCheckpointService({pool,
    publishSnapshot: async (key, files) => snapshots.set(key, files),
    removeSnapshot: async key => snapshots.delete(key),
    previewUrl: key => `http://preview/p/${key}/index.html`,
  });
  server = http.createServer(async (req,res) => {
    try { if (!(await service.handle(req,res,new URL(req.url,"http://local").pathname))) json(res,404,{}); }
    catch (error) { json(res,error.status || 500,{error:error.message}); }
  });
  server.listen(0,"127.0.0.1"); await once(server,"listening");
  const base = `http://127.0.0.1:${server.address().port}/api/projects/${id}/checkpoints`;
  const post = async (suffix,body) => { const response=await fetch(base+suffix,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}); return {status:response.status,data:await response.json()}; };
  const checkpoint=(await post("",{label:"Original"})).data.checkpoint;
  assert.equal(checkpoint.file_count,1);
  assert.equal(Object.hasOwn(checkpoint,"source_files"),false);
  await pool.query("UPDATE files SET content='changed',version=5 WHERE project_id=$1",[id]);
  await pool.query("INSERT INTO files(project_id,path,content,version) VALUES($1,'extra.js','extra',9)",[id]);
  const before=(await post("",{label:"With extra"})).data.checkpoint;
  const stale=await post(`/${checkpoint.id}/restore`,{versions:{"index.html":1}});
  assert.equal(stale.status,409);
  assert.equal((await pool.query("SELECT content FROM files WHERE project_id=$1 AND path='index.html'",[id])).rows[0].content,"changed");
  const restored=await post(`/${checkpoint.id}/restore`,{versions:{"index.html":5,"extra.js":9}});
  assert.equal(restored.status,200);
  assert.deepEqual(restored.data.files.map(f=>f.path),["index.html"]);
  assert.equal(restored.data.files[0].content,"original");
  assert.equal(restored.data.files[0].version,6);
  assert.ok(restored.data.undo_checkpoint.id);
  const recreated=await post(`/${before.id}/restore`,{versions:{"index.html":6}});
  assert.equal(recreated.status,200);
  assert.equal(recreated.data.files.find(f=>f.path==="extra.js").version,10);
  assert.equal(snapshots.size,1);
  const task=randomUUID();
  await pool.query("INSERT INTO tasks(id,project_id,kind,status) VALUES($1,$2,'test','running')",[task,id]);
  await pool.query("INSERT INTO builds(id,project_id,task_id,status,prompt,base_versions,source_files) VALUES($1,$2,$3,'queued','test','{}','[]')",[randomUUID(),id,task]);
  const blocked=await post(`/${checkpoint.id}/restore`,{versions:Object.fromEntries(recreated.data.files.map(f=>[f.path,f.version]))});
  assert.equal(blocked.status,409);
  const listed=await service.list(id);
  assert.ok(listed.length>=4);
  assert.ok(listed.every(row=>!Object.hasOwn(row,"source_files")&&!Object.hasOwn(row,"source_versions")));
});
