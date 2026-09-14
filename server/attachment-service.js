import { randomUUID } from 'node:crypto';
import { mkdir, open, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { resolve, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { invalid } from './domain.js';
import { json } from './http.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_UPLOAD=250*1024*1024, PROJECT_QUOTA=1024*1024*1024, CONTEXT_LIMIT=200000;
let uploads=0;
const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
function decode(bytes) { try { return decoder.decode(bytes); } catch { throw invalid('ZIP filenames must use UTF-8.'); } }
async function readAt(file,position,length) {
  const bytes=Buffer.alloc(length); let offset=0;
  while(offset<length) { const result=await file.read(bytes,offset,length-offset,position+offset); if(!result.bytesRead) throw invalid('ZIP entry exceeds the archive bounds.'); offset+=result.bytesRead; }
  return bytes;
}
function safePath(path) {
  if(!path || path.length>1024 || path.startsWith('/') || /[\\\x00-\x1f\x7f:]/.test(path) || path.replace(/\/$/,'').split('/').some(part=>!part || part==='.' || part==='..')) throw invalid('ZIP contains an unsafe path.');
}
function excluded(path) {
  return path.toLowerCase().split('/').some(part=>['node_modules','.git','.venv','venv','__pycache__'].includes(part) || /^\.env(?:\.|$)/.test(part) || /credential|secret|private[-_]?key|^keys?(?:\.|$)|\.(?:pem|p12|pfx|key)$/.test(part));
}
function hasSecret(content) { return /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b|\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/.test(content); }
function crc32(bytes) { let crc=0xffffffff; for(const byte of bytes) { crc^=byte; for(let bit=0;bit<8;bit++) crc=(crc>>>1)^((crc&1)?0xedb88320:0); } return (crc^0xffffffff)>>>0; }

// Validate metadata using positioned reads. Large entry payloads stay on disk.
async function inspectZip(file,size) {
  if(size<22) throw invalid('Invalid ZIP archive.');
  const tailStart=Math.max(0,size-65557),tail=await readAt(file,tailStart,size-tailStart); let end=-1;
  for(let at=tail.length-22;at>=0;at--) if(tail.readUInt32LE(at)===0x06054b50 && at+22+tail.readUInt16LE(at+20)===tail.length) {end=at;break;}
  if(end<0) throw invalid('ZIP end record is missing.');
  const count=tail.readUInt16LE(end+10),directorySize=tail.readUInt32LE(end+12),directoryOffset=tail.readUInt32LE(end+16),endOffset=tailStart+end;
  if(tail.readUInt16LE(end+4)||tail.readUInt16LE(end+6)||tail.readUInt16LE(end+8)!==count||count===65535||directoryOffset===0xffffffff||directorySize===0xffffffff) throw invalid('Multipart and ZIP64 attachments are unsupported.');
  if(count>20000) throw invalid('ZIP exceeds the 20,000-entry limit.',413);
  if(!count || directoryOffset+directorySize!==endOffset) throw invalid('Invalid ZIP directory.');
  let at=directoryOffset,expanded=0; const entries=[],names=new Set(),ranges=[];
  for(let index=0;index<count;index++) {
    if(at+46>endOffset) throw invalid('Invalid ZIP directory bounds.');
    const header=await readAt(file,at,46);
    if(header.readUInt32LE(0)!==0x02014b50) throw invalid('Invalid ZIP directory entry.');
    const flags=header.readUInt16LE(8),method=header.readUInt16LE(10),crc=header.readUInt32LE(16),compressed=header.readUInt32LE(20),bytes=header.readUInt32LE(24),nameLength=header.readUInt16LE(28),extraLength=header.readUInt16LE(30),commentLength=header.readUInt16LE(32),local=header.readUInt32LE(42);
    if(flags&0x41) throw invalid('Encrypted ZIP attachments are unsupported.');
    if(((header.readUInt32LE(38)>>>16)&0xf000)===0xa000) throw invalid('ZIP symlinks are not allowed.');
    if(![0,8].includes(method)) throw invalid('ZIP entries must use stored or deflated compression.');
    if(header.readUInt16LE(34)!==0 || !nameLength || nameLength>4096 || at+46+nameLength+extraLength+commentLength>endOffset) throw invalid('Invalid ZIP entry metadata.');
    expanded+=bytes; if(expanded>PROJECT_QUOTA) throw invalid('ZIP declares more than 1 GiB of expanded content.',413);
    const nameBytes=await readAt(file,at+46,nameLength),path=decode(nameBytes); safePath(path);
    const normalized=path.replace(/\/$/,''); if(names.has(normalized)) throw invalid('ZIP contains duplicate paths.'); names.add(normalized);
    if(local+30>directoryOffset) throw invalid('Invalid ZIP local entry bounds.');
    const localHeader=await readAt(file,local,30);
    const localNameLength=localHeader.readUInt16LE(26),localExtraLength=localHeader.readUInt16LE(28),start=local+30+localNameLength+localExtraLength;
    if(localHeader.readUInt32LE(0)!==0x04034b50 || localHeader.readUInt16LE(6)!==flags || localHeader.readUInt16LE(8)!==method || localNameLength!==nameLength || start+compressed>directoryOffset) throw invalid('ZIP local and central entries disagree.');
    if(!(await readAt(file,local+30,localNameLength)).equals(nameBytes)) throw invalid('ZIP filenames disagree.');
    if(!(flags&8) && (localHeader.readUInt32LE(14)!==crc || localHeader.readUInt32LE(18)!==compressed || localHeader.readUInt32LE(22)!==bytes)) throw invalid('ZIP entry sizes disagree.');
    if(method===0 && compressed!==bytes) throw invalid('Stored ZIP size is inconsistent.');
    ranges.push([local,start+compressed]);
    entries.push({path,bytes,compressed,method,crc,start,directory:path.endsWith('/')});
    at+=46+nameLength+extraLength+commentLength;
  }
  if(at!==endOffset) throw invalid('ZIP directory count is inconsistent.');
  ranges.sort((a,b)=>a[0]-b[0]); for(let i=1;i<ranges.length;i++) if(ranges[i][0]<ranges[i-1][1]) throw invalid('ZIP entries overlap.');
  return entries;
}

export function createAttachmentService({pool,storageRoot=process.env.ATTACHMENT_STORAGE_DIR || 'data/attachments'}) {
  const root=resolve(storageRoot);
  const publicRow=row=>({id:row.id,name:row.name,bytes:Number(row.bytes),status:'stored',created_at:row.created_at,download_url:`/api/projects/${row.project_id}/attachments/${row.id}/download`});
  const list=async projectId=>(await pool.query('SELECT id,project_id,name,bytes,created_at FROM attachments WHERE project_id=$1 ORDER BY created_at DESC',[projectId])).rows.map(publicRow);
  const diskPath=row=>{ if(!/^[0-9a-f-]{36}\.zip$/.test(row.disk_name)) throw invalid('Attachment storage reference is invalid.',500); return join(root,row.disk_name); };
  const handle=async(req,res,path)=>{
    const match=path.match(/^\/api\/projects\/([^/]+)\/attachments(?:\/([^/]+)\/download)?$/); if(!match) return false;
    const [,projectId,id]=match; if(!UUID.test(projectId)||(id&&!UUID.test(id))) throw invalid('Invalid identifier.');
    if(id && req.method==='GET') {
      const row=(await pool.query('SELECT * FROM attachments WHERE id=$1 AND project_id=$2',[id,projectId])).rows[0]; if(!row) throw invalid('Attachment not found.',404);
      const file=await open(diskPath(row),'r').catch(()=>{throw invalid('Attachment file is unavailable.',404);});
      await file.close();
      const filename=row.name.replace(/[^a-zA-Z0-9_.-]/g,'-');
      res.writeHead(200,{'Content-Type':'application/zip','Content-Length':row.bytes,'Content-Disposition':`attachment; filename="${filename}"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
      try { await pipeline(createReadStream(diskPath(row)),res); } catch { res.destroy(); }
      return true;
    }
    if(id) throw invalid('Method not allowed.',405);
    if(req.method==='GET') { if(!(await pool.query('SELECT id FROM projects WHERE id=$1',[projectId])).rowCount) throw invalid('Project not found.',404); json(res,200,{attachments:await list(projectId)}); return true; }
    if(req.method!=='POST') throw invalid('Method not allowed.',405);
    if(req.headers['content-type']?.split(';')[0]!=='application/zip') throw invalid('Expected a ZIP attachment.',415);
    if(Number(req.headers['content-length']||0)>MAX_UPLOAD) throw invalid('ZIP attachments are limited to 250 MiB.',413);
    if(uploads>=2) throw invalid('Two uploads are already in progress. Retry when one finishes.',429);
    let name; try { name=decodeURIComponent(req.headers['x-file-name']||req.headers['x-attachment-name']||'attachment.zip'); } catch { throw invalid('Invalid attachment name.'); }
    if(!name.trim() || name.length>200 || /[\x00-\x1f\x7f/\\]/.test(name)) throw invalid('Use a filename of 1–200 characters without path separators.');
    uploads++; let client,file,target,committed=false;
    try {
      if(!(await pool.query('SELECT id FROM projects WHERE id=$1',[projectId])).rowCount) throw invalid('Project not found.',404);
      const usage=(await pool.query('SELECT count(*)::int AS count,COALESCE(sum(bytes),0)::bigint AS bytes FROM attachments WHERE project_id=$1',[projectId])).rows[0];
      if(usage.count>=20) throw invalid('This project already has 20 attachments.',413);
      const remaining=PROJECT_QUOTA-Number(usage.bytes); if(remaining<=0) throw invalid('Project attachment storage exceeds 1 GiB.',413);
      await mkdir(root,{recursive:true}); const attachmentId=randomUUID(),disk_name=`${attachmentId}.zip`; target=join(root,disk_name); file=await open(target,'wx',0o600);
      let bytes=0;
      for await(const chunk of req) {
        bytes+=chunk.length; if(bytes>MAX_UPLOAD || bytes>remaining) throw invalid('Attachment or project storage limit exceeded.',413);
        let offset=0; while(offset<chunk.length) { const result=await file.write(chunk,offset,chunk.length-offset); offset+=result.bytesWritten; }
      }
      await file.close(); file=await open(target,'r'); const inventory=await inspectZip(file,bytes); await file.close(); file=null;
      // Keep the row lock short: uploads and positioned validation must not block project reads.
      client=await pool.connect(); await client.query('BEGIN');
      if(!(await client.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[projectId])).rowCount) throw invalid('Project not found.',404);
      const finalUsage=(await client.query('SELECT count(*)::int AS count,COALESCE(sum(bytes),0)::bigint AS bytes FROM attachments WHERE project_id=$1',[projectId])).rows[0];
      if(finalUsage.count>=20 || Number(finalUsage.bytes)+bytes>PROJECT_QUOTA) throw invalid('Project attachment count or storage limit exceeded.',413);
      const row=(await client.query('INSERT INTO attachments(id,project_id,name,bytes,disk_name,inventory) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[attachmentId,projectId,name.trim(),bytes,disk_name,JSON.stringify(inventory)])).rows[0];
      await client.query('INSERT INTO events(project_id,type,detail) VALUES($1,$2,$3)',[projectId,'ATTACHMENT_STORED',{message:'Stored ZIP attachment locally without extracting or executing it.',attachment_id:attachmentId,name:name.trim(),bytes}]);
      await client.query('COMMIT'); committed=true; json(res,201,{attachment:publicRow(row)}); return true;
    } catch(error) { if(client) await client.query('ROLLBACK').catch(()=>{}); throw error; }
    finally { if(file) await file.close().catch(()=>{}); if(target&&!committed) await unlink(target).catch(()=>{}); client?.release(); uploads--; }
  };
  const readContext=async(projectId,ids)=>{
    if(!Array.isArray(ids)||ids.length>20||ids.some(id=>typeof id!=='string'||!UUID.test(id))) throw invalid('Select valid project attachment identifiers.');
    const unique=[...new Set(ids)], result={attachments:[],truncated:false}; let used=0;
    for(const id of unique) {
      const row=(await pool.query('SELECT * FROM attachments WHERE id=$1 AND project_id=$2',[id,projectId])).rows[0]; if(!row) throw invalid('Attachment not found in this project.',404);
      const item={id:row.id,name:row.name,bytes:Number(row.bytes),inventory:[],snippets:[],validation:'ZIP structure checked; original archive is stored without execution.'};
      const file=await open(diskPath(row),'r').catch(()=>{throw invalid('Attachment file is unavailable.',404);});
      try {
        for(const entry of row.inventory) {
          if(entry.directory||excluded(entry.path)) continue;
          const metadata={path:entry.path,bytes:entry.bytes}; const cost=Buffer.byteLength(JSON.stringify(metadata));
          if(used+cost+2000>CONTEXT_LIMIT) {result.truncated=true;break;}
          item.inventory.push(metadata); used+=cost;
          if(!/\.(?:html|css|js|jsx|ts|tsx|json|md|txt|py|sql|yaml|yml|toml)$/i.test(entry.path)||entry.bytes>100000||entry.compressed>200000||used+entry.bytes+2000>CONTEXT_LIMIT) continue;
          try {
            const raw=await readAt(file,entry.start,entry.compressed);
            const bytes=entry.method===0?raw:inflateRawSync(raw,{maxOutputLength:Math.min(entry.bytes+1,100001)});
            if(bytes.length!==entry.bytes||crc32(bytes)!==entry.crc) continue;
            const content=decoder.decode(bytes); if(content.includes('\0')||hasSecret(content)) continue;
            const snippet={path:entry.path,content},size=Buffer.byteLength(JSON.stringify(snippet));
            if(used+size+2000>CONTEXT_LIMIT) {result.truncated=true;continue;}
            item.snippets.push(snippet); used+=size;
          } catch { /* Invalid/binary/corrupt entries remain inventory-only. */ }
        }
      } finally { await file.close(); }
      result.attachments.push(item);
    }
    // Metadata and JSON escaping are counted in the final wire budget as well.
    while(Buffer.byteLength(JSON.stringify(result))>CONTEXT_LIMIT) {
      result.truncated=true; const last=result.attachments.at(-1); if(last.snippets.length) last.snippets.pop(); else if(last.inventory.length) last.inventory.pop(); else result.attachments.pop();
    }
    return result;
  };
  return {handle,list,readContext};
}
