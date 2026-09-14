import { randomUUID } from 'node:crypto';
import { invalid, validateName, validateFile } from './domain.js';
import { json, readJson } from './http.js';
import { readArchive, writeArchive } from './archive.js';

export async function requireIdle(client, id) {
  if ((await client.query("SELECT id FROM builds WHERE project_id=$1 AND status IN ('queued','running','review')", [id])).rowCount)
    throw invalid('Finish or discard the active build before changing source files.', 409);
}
export function validateSourceSet(files) {
  if (files.length > 30 || files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) > 600000)
    throw invalid('This runtime supports up to 30 source files and 600 KB per project.', 413);
}
export function createProjectService({ pool, tx, lock, event, checkpoints }) {
  const sources = async (client, id) => (await client.query('SELECT path,content,version FROM files WHERE project_id=$1 ORDER BY path', [id])).rows;
  const create = async (client, name, files, message) => {
    validateSourceSet(files);
    const id = randomUUID();
    const project = (await client.query('INSERT INTO projects(id,name) VALUES($1,$2) RETURNING *', [id,name])).rows[0];
    for (const file of files) await client.query('INSERT INTO files(project_id,path,content) VALUES($1,$2,$3)', [id,file.path,file.content]);
    await event(client,id,'PROJECT_CREATED',{message});
    await checkpoints.capture(client,id,'Initial saved source');
    return project;
  };
  const handle = async (req,res,path) => {
    if (path === '/api/import') {
      if (req.method !== 'POST') throw invalid('Method not allowed.',405);
      if (req.headers['content-type']?.split(';')[0] !== 'application/zip') throw invalid('Expected a ZIP archive.',415);
      let name;
      try { name = decodeURIComponent(req.headers['x-project-name'] || 'Imported project'); } catch { throw invalid('Invalid project name.'); }
      name = validateName(name);
      let size=0; const chunks=[];
      for await (const chunk of req) {
        size += chunk.length;
        if (size>5000000) throw invalid('ZIP archives must be 5 MB or smaller.',413);
        chunks.push(chunk);
      }
      const {files,report} = await readArchive(Buffer.concat(chunks));
      const project = await tx(async client=>{
        const project = await create(client,name,files,'Imported supported static source from a ZIP archive.');
        await event(client,project.id,'IMPORT_REPORT',{message:'Static ZIP import inventory. Keep the original archive for unsupported files.',...report});
        return project;
      });
      json(res,201,{project,report}); return true;
    }
    const match=path.match(/^\/api\/projects\/([0-9a-f-]{36})(?:\/(duplicate|export|files))?$/i);
    if (!match) return false;
    const [,id,action]=match;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw invalid('Invalid project identifier.');
    if (!action && req.method === 'PATCH') {
      const name=validateName((await readJson(req)).name);
      const project=await tx(async client=>{
        await lock(client,id);
        const project=(await client.query('UPDATE projects SET name=$2,updated_at=now() WHERE id=$1 RETURNING *',[id,name])).rows[0];
        await event(client,id,'PROJECT_RENAMED',{message:'Renamed project.',name}); return project;
      });
      json(res,200,{project}); return true;
    }
    if (action==='duplicate' && req.method==='POST') {
      const name=validateName((await readJson(req)).name);
      const project=await tx(async client=>{
        await lock(client,id);
        return create(client,name,await sources(client,id),'Created an independent copy of saved source.');
      });
      json(res,201,{project}); return true;
    }
    if (action==='export' && req.method==='GET') {
      const {project,files}=await tx(async client=>({project:await lock(client,id),files:await sources(client,id)}));
      const archive=await writeArchive(files);
      const filename=project.name.replace(/[^a-zA-Z0-9_-]/g,'-').slice(0,80)||'project';
      res.writeHead(200,{'Content-Type':'application/zip','Content-Disposition':`attachment; filename="${filename}.zip"`,'Content-Length':archive.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
      res.end(archive); return true;
    }
    if (action==='files' && ['POST','DELETE'].includes(req.method)) {
      const body=await readJson(req);
      const file=validateFile({...body,content:req.method==='DELETE'?'':body.content,version:req.method==='POST'?1:body.version});
      const result=await tx(async client=>{
        await lock(client,id); await requireIdle(client,id);
        const current=await sources(client,id), existing=current.find(item=>item.path===file.path);
        if (req.method==='POST') {
          if(existing) throw invalid('A file already exists at this path.',409);
          validateSourceSet([...current,file]);
          await checkpoints.capture(client,id,'Before adding a file');
          const version=(await client.query('SELECT COALESCE(MAX((source_versions ->> $2)::integer),0)+1 AS version FROM checkpoints WHERE project_id=$1 AND source_versions ? $2',[id,file.path])).rows[0].version;
          if (version>2147483647) throw invalid('Source version limit reached.',409);
          const created=(await client.query('INSERT INTO files(project_id,path,content,version) VALUES($1,$2,$3,$4) RETURNING path,content,version',[id,file.path,file.content,version])).rows[0];
          await event(client,id,'FILES_CHANGED',{path:file.path,message:`Added ${file.path}.`});
          await client.query('UPDATE projects SET updated_at=now() WHERE id=$1',[id]);
          return {file:created};
        }
        if(file.path==='index.html') throw invalid('The index.html entry point cannot be deleted.');
        if(!existing) throw invalid('File not found.',404);
        if(existing.version!==file.version) throw invalid('This file changed. Reload the saved version before deleting.',409);
        await checkpoints.capture(client,id,'Before deleting a file');
        await client.query('DELETE FROM files WHERE project_id=$1 AND path=$2',[id,file.path]);
        await client.query('UPDATE projects SET updated_at=now() WHERE id=$1',[id]);
        await event(client,id,'FILES_CHANGED',{path:file.path,message:`Deleted ${file.path}.`});
        return {ok:true};
      });
      json(res,req.method==='POST'?201:200,result); return true;
    }
    return false;
  };
  return {handle};
}
