import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID, randomBytes } from 'node:crypto';
import pg from 'pg';
import { createBuildService } from '../server/build-service.js';
import { createPreviewWorker } from '../server/preview-worker.js';
import { starterFiles } from '../server/domain.js';
import { migrate } from '../server/migrate.js';
import { createApp } from '../server/app.js';

const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; };
const close = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); });

test('applying a build cannot reuse a deleted file version and accept a stale draft', {skip:!process.env.DATABASE_URL}, async t=>{
  const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
  let app,worker,projectId;
  t.after(async()=>{
    if(app?.listening) await close(app);
    if(worker?.listening) await close(worker);
    try { if(projectId) { await pool.query('DELETE FROM builds WHERE project_id=$1',[projectId]); await pool.query('DELETE FROM projects WHERE id=$1',[projectId]); } }
    finally { await pool.end(); }
  });
  await migrate(pool);
  const token=randomUUID(); worker=createPreviewWorker({token}); const workerUrl=await listen(worker);
  app=createApp({pool,workerUrl,workerToken:token,previewPublicUrl:workerUrl}); const base=await listen(app);
  const api=async(path,method='GET',body)=>{
    const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  };
  const project=await api('/api/projects','POST',{name:'Deleted-path build regression'}); assert.equal(project.status,201);
  projectId=project.data.project.id; const root=`/api/projects/${projectId}`;
  const added=await api(`${root}/files`,'POST',{path:'extra.js',content:'// old browser source'}); assert.equal(added.status,201);
  const oldVersion=added.data.file.version;
  assert.equal((await api(`${root}/files`,'DELETE',{path:'extra.js',version:oldVersion})).status,200);
  const files=(await api(root)).data.files, task=randomUUID(),build=randomUUID();
  const candidate=[...files.map(({path,content})=>({path,content})),{path:'extra.js',content:'// reviewed replacement'}];
  // Seed a reviewed fixture directly: this test concerns application/versioning, not generation.
  await pool.query("INSERT INTO tasks(id,project_id,kind,status) VALUES($1,$2,'agent-build','completed')",[task,projectId]);
  await pool.query("INSERT INTO builds(id,project_id,task_id,status,prompt,base_versions,source_files,candidate_files,snapshot_id) VALUES($1,$2,$3,'review',$4,$5,$6,$7,$8)",[build,projectId,task,'Synthetic reviewed replacement',Object.fromEntries(files.map(file=>[file.path,file.version])),JSON.stringify(files),JSON.stringify(candidate),randomBytes(32).toString('hex')]);
  assert.equal((await api(`${root}/builds/${build}/apply`,'POST',{})).status,200);
  const replacement=(await api(root)).data.files.find(file=>file.path==='extra.js');
  assert.ok(replacement.version>oldVersion,'recreated source receives a strictly newer version');
  assert.equal((await api(`${root}/files`,'PUT',{path:'extra.js',content:'// stale overwrite',version:oldVersion})).status,409);
  assert.equal((await api(root)).data.files.find(file=>file.path==='extra.js').content,'// reviewed replacement');
});

test('real PostgreSQL build queue authenticates workers, reviews candidates, protects source versions, and cancels leases', { skip: !process.env.DATABASE_URL }, async t => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const projectId = randomUUID();
  let server, worker, originalWorker;
  t.after(async () => {
    if (server?.listening) await close(server);
    if (worker?.listening) await close(worker);
    try {
      await pool.query('DELETE FROM builds WHERE project_id=$1', [projectId]);
      await pool.query('DELETE FROM projects WHERE id=$1', [projectId]);
      if (originalWorker) await pool.query('UPDATE build_worker_state SET name=$1,ready=$2,reason=$3,updated_at=$4 WHERE id=1',[originalWorker.name,originalWorker.ready,originalWorker.reason,originalWorker.updated_at]);
      else await pool.query('DELETE FROM build_worker_state WHERE id=1 AND name=$1',['Synthetic test worker']);
    }
    finally { await pool.end(); }
  });
  await migrate(pool);
  originalWorker = (await pool.query('SELECT * FROM build_worker_state WHERE id=1')).rows[0];
  await pool.query('INSERT INTO projects(id,name) VALUES($1,$2)', [projectId, 'Test-only worker contract fixture']);
  for (const file of starterFiles) await pool.query('INSERT INTO files(project_id,path,content) VALUES($1,$2,$3)', [projectId,file.path,file.content]);
  const token = randomBytes(32).toString('hex');
  worker = createPreviewWorker({ token });
  const workerUrl = await listen(worker);
  const callWorker = async (path, method, body) => {
    const response = await fetch(workerUrl + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    assert.ok(response.ok);
  };
  const service = createBuildService({ pool, workerToken: token,
    publishSnapshot: (id,files) => callWorker('/internal/snapshots', 'POST', {id,files}),
    removeSnapshot: id => callWorker(`/internal/snapshots/${id}`, 'DELETE'),
    previewUrl: id => `${workerUrl}/p/${id}/index.html`,
  });
  server = http.createServer(async (req,res) => {
    try { if (await service.handle(req,res,new URL(req.url,'http://local').pathname)) return; res.writeHead(404).end(); }
    catch(error) { res.writeHead(error.status || 500, {'Content-Type':'application/json'}).end(JSON.stringify({error:error.message})); }
  });
  const base = await listen(server);
  const request = async (path,body,auth=false,method='POST') => {
    const response = await fetch(base + path, {method,headers:{'Content-Type':'application/json',...(auth?{Authorization:`Bearer ${token}`}:{})},body:method === 'GET'?undefined:JSON.stringify(body ?? {})});
    return {status:response.status,data:await response.json()};
  };
  const internal = '/internal/build-worker';
  const builds = `/api/projects/${projectId}/builds`;
  assert.equal((await request(`${internal}/heartbeat`,{name:'Synthetic test worker',ready:true})).status,401);
  assert.equal((await request(`${internal}/claim`,{})).status,401);
  assert.equal((await request(`${internal}/heartbeat`,{name:'Synthetic test worker',ready:true},true)).status,200);
  assert.equal((await request('/api/agent',undefined,false,'GET')).data.available,true);
  const create = async (prompt = 'Test fixture only: update starter heading.') => {
    const result = await request(builds,{prompt});
    assert.equal(result.status,201); return result.data.build;
  };
  const claim = async () => (await request(`${internal}/claim`,{},true)).data.build;
  const complete = async (build, extra={}) => request(`${internal}/${build.id}/complete`,{
    lease_token:build.lease_token,
    files:[{path:'index.html',content:starterFiles.find(f=>f.path==='index.html').content.replace('Hello, builder.','Reviewed fixture output')}],
    summary:'Deterministic output supplied by this integration test, not an AI provider.',
    review:{approved:true,summary:'Test fixture review decision.'},...extra,
  },true);

  assert.equal((await request(builds,{prompt:'x'.repeat(60001)})).status,400);
  const queued = await create('x'.repeat(60000));
  assert.equal(queued.prompt.length,60000);
  assert.equal((await request(builds,{prompt:'Duplicate active build'})).status,409);
  const claimed = await claim();
  assert.equal(claimed.id,queued.id);
  assert.equal(claimed.source_files.length,3);
  const publicBuilds = (await request(builds,undefined,false,'GET')).data.builds;
  assert.equal('lease_token' in publicBuilds[0],false);
  assert.equal('source_files' in publicBuilds[0],false);
  assert.equal((await complete(claimed,{lease_token:'stale-token'})).status,409);
  await pool.query("UPDATE builds SET claimed_at=now()-interval '9 minutes' WHERE id=$1", [claimed.id]);
  assert.equal((await request(`${internal}/${claimed.id}/event`, {lease_token:claimed.lease_token,type:'REVIEW_STARTED',message:'Test-only review stage.'},true)).status,200);
  assert.equal((await pool.query("SELECT claimed_at>now()-interval '10 seconds' AS renewed FROM builds WHERE id=$1",[claimed.id])).rows[0].renewed,true,'authenticated stage progress renews an unexpired lease');
  const reviewed = await complete(claimed);
  assert.equal(reviewed.status,200);
  assert.equal(reviewed.data.build.status,'review');
  assert.match(await (await fetch(reviewed.data.build.preview_url)).text(),/Reviewed fixture output/);
  assert.equal((await pool.query('SELECT content FROM files WHERE project_id=$1 AND path=$2',[projectId,'index.html'])).rows[0].content,starterFiles[0].content,'review does not change saved sources');
  const applied = await request(`${builds}/${claimed.id}/apply`);
  assert.equal(applied.status,200);
  assert.equal(applied.data.build.status,'applied');
  const saved = (await pool.query('SELECT path,content,version FROM files WHERE project_id=$1',[projectId])).rows;
  assert.equal(saved.length,3,'omitted files remain present');
  assert.equal(saved.find(f=>f.path==='styles.css').content,starterFiles.find(f=>f.path==='styles.css').content);
  assert.match(saved.find(f=>f.path==='index.html').content,/Reviewed fixture output/);
  assert.equal((await request(`${builds}/${claimed.id}/apply`)).status,200);
  assert.deepEqual((await pool.query('SELECT path,version FROM files WHERE project_id=$1 ORDER BY path',[projectId])).rows,saved.map(({path,version})=>({path,version})).sort((a,b)=>a.path.localeCompare(b.path)),'double apply does not bump versions');
  assert.equal((await request(`${builds}/${claimed.id}/cancel`)).status,409);

  await create();
  const conflicting = await claim();
  const candidate = await complete(conflicting);
  await pool.query('UPDATE files SET version=version+1,content=content || $2 WHERE project_id=$1 AND path=$3',[projectId,'\n/* concurrent edit */','styles.css']);
  assert.equal((await request(`${builds}/${conflicting.id}/apply`)).status,409);
  assert.equal((await fetch(candidate.data.build.preview_url)).status,200,'conflicted candidate remains reviewable');
  assert.equal((await request(`${builds}/${conflicting.id}/cancel`)).status,200);
  assert.equal((await fetch(candidate.data.build.preview_url)).status,404,'cancel revokes candidate preview');

  await create();
  const cancelled = await claim();
  assert.equal((await request(`${builds}/${cancelled.id}/cancel`)).status,200);
  assert.equal((await complete(cancelled)).status,409,'cancel invalidates worker lease');

  await create();
  const rejected = await claim();
  const rejection = await complete(rejected,{review:{approved:false,summary:'Rejected fixture review.'}});
  assert.equal(rejection.data.build.status,'failed');
  assert.equal(rejection.data.build.preview_url,null);
  assert.equal((await request(`${builds}/${rejected.id}/apply`)).status,409);
});
