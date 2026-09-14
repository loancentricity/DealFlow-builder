import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import pg from 'pg';
import { createApp } from '../server/app.js';
import { createPreviewWorker } from '../server/preview-worker.js';
import { migrate } from '../server/migrate.js';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit=0;bit<8;bit++) crc = (crc>>>1)^((crc&1)?0xedb88320:0); }
  return (crc^0xffffffff)>>>0;
}
// Independent ZIP fixture encoder; production ZIP code is never used to construct attack inputs.
function zip(entries) {
  const local=[], central=[]; let offset=0;
  for (const entry of entries) {
    const name=Buffer.from(entry.name), raw=Buffer.from(entry.content??'');
    const method=entry.deflate?8:0, packed=entry.deflate?deflateRawSync(raw):raw;
    const flags=entry.flags??0, checksum=entry.checksum??crc32(raw);
    const head=Buffer.alloc(30); head.writeUInt32LE(0x04034b50); head.writeUInt16LE(20,4);
    head.writeUInt16LE(flags,6); head.writeUInt16LE(method,8); head.writeUInt32LE(checksum,14);
    head.writeUInt32LE(packed.length,18); head.writeUInt32LE(entry.size??raw.length,22); head.writeUInt16LE(name.length,26);
    local.push(head,name,packed);
    const dir=Buffer.alloc(46); dir.writeUInt32LE(0x02014b50); dir.writeUInt16LE(0x0314,4); dir.writeUInt16LE(20,6);
    dir.writeUInt16LE(flags,8); dir.writeUInt16LE(method,10); dir.writeUInt32LE(checksum,16);
    dir.writeUInt32LE(packed.length,20); dir.writeUInt32LE(entry.size??raw.length,24); dir.writeUInt16LE(name.length,28);
    dir.writeUInt32LE(entry.attributes??0,38); dir.writeUInt32LE(offset,42);
    central.push(dir,name); offset+=head.length+name.length+packed.length;
  }
  const directory=Buffer.concat(central), end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length,8); end.writeUInt16LE(entries.length,10);
  end.writeUInt32LE(directory.length,12); end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,directory,end]);
}

const testDatabase = process.env.DATABASE_URL;
const listen = async server => { server.listen(0,'127.0.0.1'); await once(server,'listening'); return `http://127.0.0.1:${server.address().port}`; };
const close = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); });

test('workspace files, independent copies, safe ZIP portability, and connection state', {skip:!testDatabase}, async t => {
  assert.match(new URL(testDatabase).pathname,/^\/dealflow_tests?$/,'workspace tests require the isolated dealflow_test or dealflow_tests database');
  const pool=new pg.Pool({connectionString:testDatabase});
  const projectIds=new Set(); let app,worker;
  t.after(async()=>{
    if(app?.listening) await close(app);
    if(worker?.listening) await close(worker);
    try { for(const id of projectIds) { await pool.query('DELETE FROM builds WHERE project_id=$1',[id]); await pool.query('DELETE FROM projects WHERE id=$1',[id]); } }
    finally { await pool.end(); }
  });
  await migrate(pool);
  const token=randomUUID(); worker=createPreviewWorker({token}); const workerUrl=await listen(worker);
  app=createApp({pool,workerUrl,workerToken:token,previewPublicUrl:workerUrl}); const base=await listen(app);
  const api=async(path,method='GET',body)=>{
    const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    const data=await response.json(); if(data.project?.id) projectIds.add(data.project.id);
    return {status:response.status,data};
  };
  const importZip=async(bytes,name='Synthetic archive import')=>{
    const response=await fetch(`${base}/api/import`,{method:'POST',headers:{'Content-Type':'application/zip','X-Project-Name':encodeURIComponent(name)},body:bytes});
    const data=await response.json(); if(data.project?.id) projectIds.add(data.project.id);
    return {status:response.status,data};
  };
  const created=await api('/api/projects','POST',{name:'Synthetic workspace test'});
  assert.equal(created.status,201); const id=created.data.project.id; const root=`/api/projects/${id}`;
  const detail=async()=>(await api(root)).data;

  await t.test('rename and versioned file changes leave a running snapshot unchanged',async()=>{
    assert.equal((await api(root,'PATCH',{name:'Renamed workspace fixture'})).status,200);
    assert.equal((await detail()).project.name,'Renamed workspace fixture');
    assert.equal((await api(`${root}/files`,'POST',{path:'extra.js',content:'// original extra source'})).status,201);
    assert.equal((await api(`${root}/files`,'POST',{path:'extra.js',content:'// duplicate overwrite'})).status,409);
    const started=await api(`${root}/preview`,'POST',{action:'start'}); assert.equal(started.status,200);
    const url=started.data.preview.url; const asset=new URL('extra.js',url);
    assert.equal(await (await fetch(asset)).text(),'// original extra source');
    const extra=(await detail()).files.find(file=>file.path==='extra.js');
    const entry=(await detail()).files.find(file=>file.path==='index.html');
    assert.equal((await api(`${root}/files`,'DELETE',{path:'index.html',version:entry.version})).status,400,'entry point cannot be deleted');
    assert.equal((await api(`${root}/files`,'PUT',{...extra,content:'// edited extra source'})).status,200);
    assert.equal((await api(`${root}/files`,'DELETE',{path:'extra.js',version:extra.version})).status,409);
    assert.equal((await api(`${root}/files`,'DELETE',{path:'extra.js',version:extra.version+1})).status,200);
    assert.equal((await detail()).files.some(file=>file.path==='extra.js'),false);
    assert.equal(await (await fetch(asset)).text(),'// original extra source','saved edits/deletion do not mutate running snapshot');
    assert.equal((await api(`${root}/preview`,'POST',{action:'update'})).status,200);
    const next=(await detail()).preview.url;
    assert.equal((await fetch(new URL('extra.js',next))).status,404);
    assert.equal((await fetch(url)).status,404);
  });

  await t.test('duplicate source is independent and does not bump original versions',async()=>{
    const before=(await detail()).files;
    const copied=await api(`${root}/duplicate`,'POST',{name:'Independent copy fixture'}); assert.equal(copied.status,201);
    const copyRoot=`/api/projects/${copied.data.project.id}`;
    const copy=(await api(copyRoot)).data;
    assert.deepEqual(copy.files.map(({path,content})=>({path,content})),before.map(({path,content})=>({path,content})));
    const html=copy.files.find(file=>file.path==='index.html');
    assert.equal((await api(`${copyRoot}/files`,'PUT',{...html,content:html.content+'\n<!-- independent duplicate -->'})).status,200);
    assert.deepEqual((await detail()).files,before);
  });

  await t.test('ZIP export imports as an independent project with exact source text',async()=>{
    const source=(await detail()).files;
    const exported=await fetch(base+root+'/export'); assert.equal(exported.status,200);
    assert.match(exported.headers.get('content-type'),/zip/);
    const bytes=Buffer.from(await exported.arrayBuffer()); assert.equal(bytes.readUInt32LE(0),0x04034b50);
    const imported=await importZip(bytes,'Roundtrip café'); assert.equal(imported.status,201);
    assert.equal(imported.data.project.name,'Roundtrip café'); assert.notEqual(imported.data.project.id,id);
    const result=(await api(`/api/projects/${imported.data.project.id}`)).data;
    assert.deepEqual(result.files.map(({path,content})=>({path,content})),source.map(({path,content})=>({path,content})));
  });

  await t.test('unsupported archive assets appear in warnings rather than executable source',async()=>{
    const imported=await importZip(zip([
      {name:'index.html',content:'<!doctype html><meta name="viewport" content="width=device-width"><h1>Imported fixture</h1>'},
      {name:'notes.txt',content:'Retain this item in the inventory.'},
      {name:'server.py',content:'raise Exception("must never execute")'},
      {name:'.env',content:'SYNTHETIC_SECRET=fixture'},
    ]));
    assert.equal(imported.status,201);
    assert.ok(imported.data.report.warnings.length>0);
    assert.equal(imported.data.report.imported_files,1);
    assert.equal(imported.data.report.skipped_files,3);
    const files=(await api(`/api/projects/${imported.data.project.id}`)).data.files;
    assert.deepEqual(files.map(file=>file.path),['index.html']);
  });

  await t.test('a single top-level archive folder is normalized',async()=>{
    const imported=await importZip(zip([{name:'fixture/index.html',content:'<h1>Nested root</h1>'},{name:'fixture/app.js',content:'// nested asset'}]));
    assert.equal(imported.status,201);
    assert.deepEqual((await api(`/api/projects/${imported.data.project.id}`)).data.files.map(file=>file.path),['app.js','index.html']);
  });

  await t.test('hostile archives are rejected atomically before project creation',async()=>{
    const valid={name:'index.html',content:'<h1>Fixture</h1>'};
    const attacks=[
      ['traversal',[valid,{name:'../escape.js',content:'bad'}]],
      ['absolute',[valid,{name:'/absolute.js',content:'bad'}]],
      ['Windows absolute',[valid,{name:'C:/escape.js',content:'bad'}]],
      ['backslash traversal',[valid,{name:'..\\escape.js',content:'bad'}]],
      ['duplicate',[valid,{...valid}]],
      ['symlink',[valid,{name:'link.js',content:'../../outside',attributes:(0xa1ff<<16)>>>0}]],
      ['encrypted',[{...valid,flags:1}]],
      ['corrupt checksum',[{...valid,checksum:123}]],
      ['oversized expansion',[{...valid,deflate:true,content:'A'.repeat(210000)}]],
      ['advertised bomb',[{...valid,deflate:true,size:0x7fffffff}]],
      ['wrong inflated size',[{...valid,deflate:true,size:1}]],
      ['too many source files',[valid,...Array.from({length:31},(_,index)=>({name:`file${index}.js`,content:'// fixture'}))]],
    ];
    for(const [name,entries] of attacks) {
      const before=(await pool.query('SELECT count(*)::int AS count FROM projects')).rows[0].count;
      const result=await importZip(zip(entries),`Rejected ${name}`);
      assert.ok([400,413,422].includes(result.status),`${name}: expected validation rejection, received ${result.status}: ${JSON.stringify(result.data)}`);
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM projects')).rows[0].count,before,`${name}: no partial project`);
    }
  });

  await t.test('connections reflect configured services without exposing secrets',async()=>{
    const result=await api('/api/connections'); assert.equal(result.status,200);
    assert.ok(Array.isArray(result.data.connections)); assert.ok(result.data.connections.length>0);
    assert.equal(JSON.stringify(result.data).includes(token),false);
    assert.equal(JSON.stringify(result.data).includes(testDatabase),false);
  });

  await t.test('active build protects sources against editor mutations',async()=>{
    const files=(await detail()).files, task=randomUUID(), build=randomUUID();
    await pool.query("INSERT INTO tasks(id,project_id,kind,status) VALUES($1,$2,'agent-build','running')",[task,id]);
    await pool.query("INSERT INTO builds(id,project_id,task_id,status,prompt,base_versions,source_files) VALUES($1,$2,$3,'queued',$4,$5,$6)",[build,id,task,'Synthetic active build fixture',Object.fromEntries(files.map(file=>[file.path,file.version])),JSON.stringify(files)]);
    try {
      assert.equal((await api(`${root}/files`,'POST',{path:'blocked.js',content:'// fixture'})).status,409);
      const existing=files.find(file=>file.path==='app.js');
      assert.equal((await api(`${root}/files`,'PUT',{...existing,content:'// blocked overwrite'})).status,409);
      assert.equal((await api(`${root}/files`,'DELETE',{path:existing.path,version:existing.version})).status,409);
      assert.deepEqual((await detail()).files,files);
    } finally {
      await pool.query('DELETE FROM builds WHERE id=$1',[build]);
      await pool.query('DELETE FROM tasks WHERE id=$1',[task]);
    }
  });
});
