import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import pg from 'pg';
import { createApp } from '../server/app.js';
import { migrate } from '../server/migrate.js';

function crc32(bytes) {
  let crc=0xffffffff;
  for(const byte of bytes) { crc^=byte; for(let bit=0;bit<8;bit++) crc=(crc>>>1)^((crc&1)?0xedb88320:0); }
  return (crc^0xffffffff)>>>0;
}
// Independent stored-ZIP encoder: attack fixtures do not reuse production parsing.
function archive(entries) {
  const local=[],central=[];let offset=0;
  for(const entry of entries) {
    const name=Buffer.from(entry.name),raw=Buffer.from(entry.content || ''),flags=entry.flags || 0,checksum=crc32(raw);
    const head=Buffer.alloc(30);head.writeUInt32LE(0x04034b50);head.writeUInt16LE(20,4);head.writeUInt16LE(flags,6);
    head.writeUInt32LE(checksum,14);head.writeUInt32LE(raw.length,18);head.writeUInt32LE(raw.length,22);head.writeUInt16LE(name.length,26);
    const directory=Buffer.alloc(46);directory.writeUInt32LE(0x02014b50);directory.writeUInt16LE(0x0314,4);directory.writeUInt16LE(20,6);
    directory.writeUInt16LE(flags,8);directory.writeUInt32LE(checksum,16);directory.writeUInt32LE(raw.length,20);directory.writeUInt32LE(raw.length,24);
    directory.writeUInt16LE(name.length,28);directory.writeUInt32LE(offset,42);
    local.push(head,name,raw);central.push(directory,name);offset+=head.length+name.length+raw.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,directory,end]);
}
const connectionString=process.env.DATABASE_URL;
const listen=async server=>{server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${server.address().port}`;};
const close=server=>new Promise(resolve=>{server.closeAllConnections?.();server.close(resolve);});

test('ZIP attachments preserve large originals, enforce project scope, and exclude secret excerpts', {skip:!connectionString}, async t=>{
  assert.match(new URL(connectionString).pathname,/^\/dealflow_tests?$/,'attachment tests require an isolated test database');
  const schema=`attachment_test_${randomUUID().replaceAll('-','')}`;
  const setup=new pg.Pool({connectionString});
  try { await setup.query(`CREATE SCHEMA ${schema}`); } finally { await setup.end(); }
  const pool=new pg.Pool({connectionString,options:`-c search_path=${schema}`});
  const attachmentStorageRoot=await mkdtemp(join(tmpdir(),'dealflow-attachments-test-'));
  const ids=[];let app,base;
  const token=randomUUID();
  t.after(async()=>{
    if(app?.listening) await close(app);
    try { for(const id of ids) { await pool.query('DELETE FROM builds WHERE project_id=$1',[id]);await pool.query('DELETE FROM projects WHERE id=$1',[id]); } }
    finally {await pool.query(`DROP SCHEMA ${schema} CASCADE`);await pool.end();await rm(attachmentStorageRoot,{recursive:true,force:true});}
  });
  await migrate(pool);
  const start=async()=>{app=createApp({pool,workerUrl:'http://127.0.0.1:1',workerToken:randomUUID(),previewPublicUrl:'http://127.0.0.1:3001',buildWorkerToken:token,attachmentStorageRoot});base=await listen(app);};
  await start();
  const api=async(path,method='GET',body,headers={})=>{
    const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  };
  for(let index=0;index<2;index++) {const created=await api('/api/projects','POST',{name:`Synthetic attachment project ${index}`});assert.equal(created.status,201);ids.push(created.data.project.id);}
  const root=`/api/projects/${ids[0]}`;
  const upload=async(bytes,name='synthetic-original.zip',type='application/zip')=>{
    const response=await fetch(base+root+'/attachments',{method:'POST',headers:{'Content-Type':type,'X-File-Name':encodeURIComponent(name)},body:bytes});
    return {status:response.status,data:await response.json()};
  };
  const secret='SYNTHETIC_SECRET_MUST_NOT_REACH_BUILD';
  const bytes=archive([
    {name:'README.md',content:'Synthetic migration source. Preserve the unfinished work.'},
    {name:'src/app.js',content:'export const fixture = "safe source excerpt";'},
    {name:'.env',content:`PRIVATE_KEY=${secret}`},
    {name:'assets/large.bin',content:Buffer.alloc(6*1024*1024,0x5a)},
  ]);
  assert.ok(bytes.length>5*1024*1024);
  const uploaded=await upload(bytes);
  assert.equal(uploaded.status,201,JSON.stringify(uploaded.data));
  const attachment=uploaded.data.attachment;assert.ok(attachment.id);
  const downloadPath=attachment.download_url || `${root}/attachments/${attachment.id}/download`;
  const downloaded=await fetch(new URL(downloadPath,base));assert.equal(downloaded.status,200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),bytes,'download is byte-for-byte original');
  const listed=await api(`${root}/attachments`);assert.equal(listed.status,200);assert.equal(listed.data.attachments.length,1);
  assert.ok((await api(root)).data.attachments.some(item=>item.id===attachment.id));
  await close(app);await start();
  const persisted=await api(`${root}/attachments`);assert.equal(persisted.data.attachments[0].id,attachment.id);
  assert.deepEqual(Buffer.from(await (await fetch(new URL(downloadPath,base))).arrayBuffer()),bytes,'original survives a new app instance');
  const cross=await fetch(`${base}/api/projects/${ids[1]}/attachments/${attachment.id}/download`);assert.equal(cross.status,404);
  for(const bad of [Buffer.from('not a zip'),archive([{name:'../escape.js',content:'bad'}]),archive([{name:'secret.js',content:'encrypted',flags:1}])]) {
    const rejected=await upload(bad);assert.ok([400,413,422].includes(rejected.status),`unsafe archive rejected: ${rejected.status}`);
  }
  const oversized=await new Promise((resolve,reject)=>{
    const request=http.request(base+root+'/attachments',{method:'POST',headers:{'Content-Type':'application/zip','X-File-Name':'too-large.zip','Content-Length':String(250*1024*1024+1)}},response=>{response.resume();resolve(response.statusCode);});
    request.setTimeout(5000,()=>request.destroy(new Error('oversized header was not rejected before reading body')));request.on('error',reject);request.flushHeaders();
  });
  assert.equal(oversized,413,'oversized Content-Length rejects before allocating payload');
  const auth={Authorization:`Bearer ${token}`};
  assert.equal((await api('/internal/build-worker/heartbeat','POST',{name:'Attachment test fixture',ready:true},auth)).status,200);
  const foreign=await api(`/api/projects/${ids[1]}/builds`,'POST',{prompt:'Synthetic test request',attachment_ids:[attachment.id]});
  assert.ok([400,404].includes(foreign.status),'build cannot reference another project attachment');
  const queued=await api(`${root}/builds`,'POST',{prompt:'Inspect the attached synthetic source',attachment_ids:[attachment.id]});assert.equal(queued.status,201,JSON.stringify(queued.data));
  const claimed=await api('/internal/build-worker/claim','POST',{},auth);assert.equal(claimed.status,200);assert.equal(claimed.data.build.id,queued.data.build.id);
  assert.ok(claimed.data.build.attachments?.attachments?.length,'selected attachment context reaches the worker');
  const context=JSON.stringify(claimed.data.build.attachments);
  assert.ok(context.includes('safe source excerpt') || context.includes('Synthetic migration source'),'safe text is available as context');
  assert.ok(!context.includes(secret),'secret-file values never reach the build claim');
  assert.ok(context.length<200000,'large binary original is not included in model context');
  assert.equal((await api(`${root}/attachments`)).data.attachments.length,1,'failed uploads create no attachment rows');
  await api(`${root}/builds/${claimed.data.build.id}/cancel`,'POST',{});
  const fixtures = [
    {name:'notes.txt',type:'text/plain',data:Buffer.from('Synthetic plain text requirement: use a blue header.')},
    {name:'reference.png',type:'image/png',data:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1kAAAAASUVORK5CYII=','base64')},
    {name:'brief.pdf',type:'application/pdf',data:Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF')},
    {name:'opaque.bin',type:'application/octet-stream',data:Buffer.from([0,1,2,255])},
  ];
  const stored = [];
  for (const fixture of fixtures) {
    const result=await upload(fixture.data,fixture.name,fixture.type);
    assert.equal(result.status,201,JSON.stringify(result.data));
    assert.equal(result.data.attachment.media_type,fixture.type);
    const original=await fetch(new URL(result.data.attachment.download_url,base));
    assert.match(original.headers.get('content-disposition'),/^attachment;/);
    assert.deepEqual(Buffer.from(await original.arrayBuffer()),fixture.data);
    stored.push(result.data.attachment);
  }
  const mediaQueued=await api(`${root}/builds`,'POST',{prompt:'Use these synthetic text and visual references',attachment_ids:stored.map(item=>item.id)});
  assert.equal(mediaQueued.status,201);
  const mediaClaim=await api('/internal/build-worker/claim','POST',{},auth);
  const job=mediaClaim.data.build;
  assert.ok(JSON.stringify(job.attachments).includes('Synthetic plain text requirement'));
  assert.equal(job.attachments.media.length,2,'images and PDFs are represented as authenticated media references');
  assert.ok(!JSON.stringify(job.attachments).includes(fixtures[1].data.toString('base64')),'base64 is not put in text context');
  const mediaPath=`/internal/build-worker/${job.id}/media/${stored[1].id}`;
  assert.equal((await api(mediaPath,'POST',{lease_token:job.lease_token})).status,401);
  assert.equal((await api(mediaPath,'POST',{lease_token:'stale'},auth)).status,409);
  const delivered=await api(mediaPath,'POST',{lease_token:job.lease_token},auth);
  assert.equal(delivered.status,200);
  assert.equal(delivered.data.media.media_type,'image/png');
  assert.deepEqual(Buffer.from(delivered.data.media.data,'base64'),fixtures[1].data);
  const notSelected=await api(`/internal/build-worker/${job.id}/media/${attachment.id}`,'POST',{lease_token:job.lease_token},auth);
  assert.equal(notSelected.status,404);
});

