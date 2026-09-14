import { inflateRawSync } from 'node:zlib';
import { invalid, validateFile } from './domain.js';

const ARCHIVE_LIMIT=5*1024*1024, ENTRY_LIMIT=1024*1024;
const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
function fail(message,status=400) { throw invalid(message,status); }
function crc32(bytes) {
  let crc=0xffffffff;
  for(const byte of bytes) { crc^=byte; for(let bit=0;bit<8;bit++) crc=(crc>>>1)^((crc&1)?0xedb88320:0); }
  return (crc^0xffffffff)>>>0;
}
function decode(bytes) { try { return decoder.decode(bytes); } catch { fail('Archive names and source files must use valid UTF-8.'); } }
function safeName(name) {
  if(!name || name.includes('\\') || name.startsWith('/') || /[\x00-\x1f\x7f:]/.test(name)) fail('Archive contains an unsafe path.');
  const path=name.endsWith('/')?name.slice(0,-1):name;
  if(!path || path.split('/').some(part=>!part || part==='.' || part==='..')) fail('Archive contains an unsafe path.');
  return path;
}
function excluded(path) {
  const parts=path.toLowerCase().split('/'), base=parts.at(-1);
  return parts.some(part=>['node_modules','.git'].includes(part)) || /^\.env(?:\.|$)/.test(base) || /(?:credential|secret|private[-_]?key|^keys?(?:\.|$))/.test(base) || /\.(?:pem|p12|pfx|key)$/.test(base);
}
function secretContent(content) {
  return /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b|\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/.test(content);
}

export function readArchive(input) {
  const bytes=Buffer.isBuffer(input)?input:Buffer.from(input);
  if(bytes.length>ARCHIVE_LIMIT) fail('ZIP archive exceeds the 5 MB limit.',413);
  if(bytes.length<22) fail('Invalid ZIP archive.');
  let end=-1;
  for(let at=bytes.length-22;at>=Math.max(0,bytes.length-65557);at--) {
    if(bytes.readUInt32LE(at)===0x06054b50 && at+22+bytes.readUInt16LE(at+20)===bytes.length) { end=at; break; }
  }
  if(end<0) fail('ZIP end record is missing or invalid.');
  const count=bytes.readUInt16LE(end+10), directorySize=bytes.readUInt32LE(end+12), directoryOffset=bytes.readUInt32LE(end+16);
  if(bytes.readUInt16LE(end+4)!==0 || bytes.readUInt16LE(end+6)!==0 || bytes.readUInt16LE(end+8)!==count || count===0xffff || directoryOffset===0xffffffff || directorySize===0xffffffff) fail('Multipart and ZIP64 archives are unsupported.');
  if(count>200) fail('Archive exceeds the 200-entry limit.',413);
  if(!count || directoryOffset+directorySize!==end) fail('Invalid ZIP directory.');
  const entries=[], names=new Set(), ranges=[]; let at=directoryOffset,total=0;
  for(let index=0;index<count;index++) {
    if(at+46>end || bytes.readUInt32LE(at)!==0x02014b50) fail('Invalid ZIP directory entry.');
    const flags=bytes.readUInt16LE(at+8),method=bytes.readUInt16LE(at+10),crc=bytes.readUInt32LE(at+16),compressed=bytes.readUInt32LE(at+20),size=bytes.readUInt32LE(at+24);
    const nameLength=bytes.readUInt16LE(at+28),extraLength=bytes.readUInt16LE(at+30),commentLength=bytes.readUInt16LE(at+32),localOffset=bytes.readUInt32LE(at+42);
    if(at+46+nameLength+extraLength+commentLength>end || bytes.readUInt16LE(at+34)!==0) fail('Invalid ZIP entry bounds.');
    if(flags&0x41) fail('Encrypted archives are unsupported.');
    if(![0,8].includes(method)) fail('Only stored and deflated ZIP entries are supported.');
    if(((bytes.readUInt32LE(at+38)>>>16)&0xf000)===0xa000) fail('Archive symlinks are not allowed.');
    if(size>ENTRY_LIMIT || compressed>ARCHIVE_LIMIT || total+size>ARCHIVE_LIMIT) fail('Expanded archive exceeds its size limit.',413);
    total+=size;
    const nameBytes=bytes.subarray(at+46,at+46+nameLength), name=decode(nameBytes), path=safeName(name);
    if(names.has(path)) fail('Archive contains duplicate paths.'); names.add(path);
    if(localOffset+30>directoryOffset || bytes.readUInt32LE(localOffset)!==0x04034b50) fail('Invalid ZIP local entry.');
    const localFlags=bytes.readUInt16LE(localOffset+6),localMethod=bytes.readUInt16LE(localOffset+8),localNameLength=bytes.readUInt16LE(localOffset+26),localExtraLength=bytes.readUInt16LE(localOffset+28);
    const dataStart=localOffset+30+localNameLength+localExtraLength,dataEnd=dataStart+compressed;
    if(dataEnd>directoryOffset || localFlags!==flags || localMethod!==method || !bytes.subarray(localOffset+30,localOffset+30+localNameLength).equals(nameBytes)) fail('ZIP local and directory entries disagree.');
    if(!(flags&8) && (bytes.readUInt32LE(localOffset+14)!==crc || bytes.readUInt32LE(localOffset+18)!==compressed || bytes.readUInt32LE(localOffset+22)!==size)) fail('ZIP local and directory sizes disagree.');
    if(ranges.some(([start,end])=>localOffset<end && dataEnd>start)) fail('Overlapping ZIP entries are not allowed.'); ranges.push([localOffset,dataEnd]);
    let content;
    try { content=method===0?bytes.subarray(dataStart,dataEnd):inflateRawSync(bytes.subarray(dataStart,dataEnd),{maxOutputLength:Math.min(size+1,ENTRY_LIMIT+1)}); }
    catch { fail('Archive entry cannot be safely expanded.'); }
    if(content.length!==size) fail('ZIP expanded size does not match its directory.');
    if(crc32(content)!==crc) fail('ZIP entry checksum is invalid.');
    entries.push({path,directory:name.endsWith('/'),content});
    at+=46+nameLength+extraLength+commentLength;
  }
  if(at!==end) fail('ZIP directory entry count is inconsistent.');
  const nonDirectories=entries.filter(entry=>!entry.directory);
  const common=nonDirectories[0]?.path.split('/')[0];
  const strip=common && nonDirectories.length && nonDirectories.every(entry=>entry.path.startsWith(common+'/'));
  const files=[],warnings=[]; let skipped=0,sourceBytes=0;
  for(const entry of nonDirectories) {
    const path=strip?entry.path.slice(common.length+1):entry.path;
    if(excluded(entry.path) || excluded(path)) { skipped++; warnings.push(`Skipped sensitive or dependency path: ${path}`); continue; }
    if(!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\.(html|css|js)$/.test(path)) { skipped++; warnings.push(`Unsupported file skipped; retain the original archive: ${path}`); continue; }
    if(entry.content.length>200000) fail('Static source file exceeds the 200 KB limit.',413);
    const content=decode(entry.content);
    if(secretContent(content)) { skipped++; warnings.push(`Skipped source containing a possible secret: ${path}`); continue; }
    sourceBytes+=entry.content.length;
    if(files.length>=30 || sourceBytes>600000) fail('Static source exceeds the 30-file or 600 KB limit.',413);
    validateFile({path,content,version:1}); files.push({path,content});
  }
  if(!files.some(file=>file.path==='index.html')) fail('A root index.html is required for the supported static runtime.');
  return {files,report:{warnings,imported_files:files.length,skipped_files:skipped,runtime:'static-web'}};
}

export function writeArchive(files) {
  if(!Array.isArray(files) || !files.length || files.length>30) fail('Export requires 1–30 static source files.');
  const local=[],central=[],names=new Set(); let offset=0,total=0;
  for(const file of files) {
    validateFile({...file,version:1}); if(names.has(file.path)) fail('Duplicate export paths.'); names.add(file.path);
    const name=Buffer.from(file.path),content=Buffer.from(file.content); total+=content.length;
    if(total>600000) fail('Static source exceeds the 600 KB limit.',413);
    const crc=crc32(content),head=Buffer.alloc(30); head.writeUInt32LE(0x04034b50); head.writeUInt16LE(20,4); head.writeUInt16LE(0x800,6);
    head.writeUInt32LE(crc,14); head.writeUInt32LE(content.length,18); head.writeUInt32LE(content.length,22); head.writeUInt16LE(name.length,26);
    local.push(head,name,content);
    const directory=Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20,4); directory.writeUInt16LE(20,6); directory.writeUInt16LE(0x800,8);
    directory.writeUInt32LE(crc,16); directory.writeUInt32LE(content.length,20); directory.writeUInt32LE(content.length,24); directory.writeUInt16LE(name.length,28); directory.writeUInt32LE(offset,42);
    central.push(directory,name); offset+=head.length+name.length+content.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length,8); end.writeUInt16LE(files.length,10); end.writeUInt32LE(directory.length,12); end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,directory,end]);
}
