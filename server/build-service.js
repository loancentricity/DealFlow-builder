import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { invalid, validateFile, runStaticChecks } from "./domain.js";
import { json, readJson } from "./http.js";
import { providerDefinitions } from "./model-providers.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (value, max, label) => {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw invalid(`${label} must contain 1–${max} characters.`);
  return value.trim();
};
const versions = files => Object.fromEntries(files.map(f => [f.path, f.version]));
const sameVersions = (a,b) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => a[k] === b[k]);

export function createBuildService({ pool, workerToken, publishSnapshot, removeSnapshot, previewUrl, captureCheckpoint = async () => {} }) {
  const configured = typeof workerToken === "string" && workerToken.length >= 24;
  const tx = async fn => {
    const c = await pool.connect();
    try { await c.query("BEGIN"); const value = await fn(c); await c.query("COMMIT"); return value; }
    catch(e) { await c.query("ROLLBACK"); throw e; }
    finally { c.release(); }
  };
  const event = (c,b,type,message,extra={}) => c.query("INSERT INTO events(project_id,task_id,type,detail) VALUES($1,$2,$3,$4)", [b.project_id,b.task_id,type,{message,...extra}]);
  const display = b => {
    const { lease_token, source_files, candidate_files, ...safe } = b;
    return { ...safe, preview_url: b.snapshot_id && ["review","applied"].includes(b.status) ? previewUrl(b.snapshot_id) : null };
  };
  const expire = async () => tx(async c => {
    const expired = (await c.query("UPDATE builds SET status='failed',error='Build worker lease expired after ten minutes.',lease_token=NULL,updated_at=now(),completed_at=now() WHERE status='running' AND claimed_at < now()-interval '10 minutes' RETURNING *")).rows;
    for (const b of expired) {
      await c.query("UPDATE tasks SET status='failed',completed_at=now(),result=$2 WHERE id=$1", [b.task_id,{error:b.error}]);
      await event(c,b,"TASK_FAILED",b.error);
    }
  });
  const status = async (providerId) => {
    await expire();
    const b = (await pool.query("SELECT *, updated_at > now()-interval '30 seconds' AS fresh FROM build_worker_state WHERE id=1")).rows[0];
    const live=configured && b?.fresh;
    const providers=providerDefinitions.map(definition=>{
      const reported=b?.providers?.find(item=>item.id===definition.id);
      const legacy=!b?.providers?.length && definition.id==='openai' && b?.ready;
      const available=Boolean(live && (reported?.available || legacy));
      return {id:definition.id,name:definition.name,model:reported?.model || definition.model,available,reason:available?null:!configured?'A build worker token is not configured.':!live?'No recent build worker heartbeat.':reported?.reason || 'Provider is not configured on the build worker.'};
    });
    const selected=providerId?providers.find(item=>item.id===providerId):null;
    return {available:selected?selected.available:providers.some(item=>item.available),name:selected?.name || b?.name || 'External build worker',reason:selected?.reason || (providers.some(item=>item.available)?null:!live?'No recent build worker heartbeat.':b?.reason || 'No configured provider is available.'),providers};
  };
  const list = async projectId => (await pool.query("SELECT * FROM builds WHERE project_id=$1 ORDER BY created_at DESC LIMIT 30",[projectId])).rows.map(display);
  const lockProject = async (c,id) => { if (!(await c.query("SELECT id FROM projects WHERE id=$1 FOR UPDATE",[id])).rowCount) throw invalid("Project not found.",404); };
  const lockBuild = async (c,id,lease) => {
    const b=(await c.query("SELECT * FROM builds WHERE id=$1 FOR UPDATE",[id])).rows[0];
    if(!b) throw invalid("Build not found.",404);
    if (lease !== undefined && (b.status !== "running" || typeof lease !== "string" || !lease || b.lease_token !== lease || Date.now()-new Date(b.claimed_at).getTime()>600000)) throw invalid("Build lease is stale or invalid.",409);
    return b;
  };
  const cleanup = async id => { if(id) { try { await removeSnapshot(id); } catch { /* Snapshot cleanup can be retried without undoing a committed source change. */ } } };
  const handle = async (req,res,path) => {
    if(path === "/api/agent" && req.method === "GET") { json(res,200,await status()); return true; }
    const internal=path.startsWith("/internal/build-worker/");
    if(internal) {
      const supplied=Buffer.from(req.headers.authorization || "");
      const expected=Buffer.from(`Bearer ${workerToken || ""}`);
      if(!configured || supplied.length !== expected.length || !timingSafeEqual(supplied,expected)) throw invalid("Worker authentication required.",401);
      if(req.method !== "POST") throw invalid("Method not allowed.",405);
      const body=await readJson(req,1300000);
      if(path === "/internal/build-worker/heartbeat") {
        const name=text(body.name,100,"Worker name");
        if(typeof body.ready !== "boolean") throw invalid("Worker readiness must be a boolean.");
        const reason=body.reason == null ? null : text(body.reason,1000,"Reason");
        if(body.providers !== undefined && (!Array.isArray(body.providers) || body.providers.length>6)) throw invalid('Invalid provider availability.');
        const providers=(body.providers || []).map(item=>{
          const definition=providerDefinitions.find(def=>def.id===item?.id);
          if(!definition || typeof item.available!=='boolean') throw invalid('Invalid provider availability.');
          return {id:definition.id,name:definition.name,model:text(item.model,100,'Model'),available:item.available,reason:item.available?null:typeof item.reason==='string'?item.reason.slice(0,1000):'Provider is unavailable.'};
        });
        if(new Set(providers.map(item=>item.id)).size!==providers.length) throw invalid('Duplicate provider.');
        await pool.query("INSERT INTO build_worker_state(id,name,ready,reason,providers) VALUES(1,$1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET name=$1,ready=$2,reason=$3,providers=$4,updated_at=now()",[name,body.ready,reason,JSON.stringify(providers)]);
        json(res,200,{ok:true}); return true;
      }
      if(path === "/internal/build-worker/claim") {
        await expire();
        const build=await tx(async c => {
          const b=(await c.query("SELECT * FROM builds WHERE status='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1")).rows[0];
          if(!b) return null;
          const lease=randomBytes(32).toString("hex");
          await c.query("UPDATE builds SET status='running',lease_token=$2,claimed_at=now(),updated_at=now() WHERE id=$1",[b.id,lease]);
          await event(c,b,"TASK_STARTED","Build claimed by the external worker.");
          const history = (await c.query("SELECT prompt,summary FROM builds WHERE project_id=$1 AND status='applied' ORDER BY created_at DESC LIMIT 10", [b.project_id])).rows.reverse();
          return {id:b.id,project_id:b.project_id,provider:b.provider,prompt:b.prompt,source_files:b.source_files,history,lease_token:lease};
        });
        json(res,200,{build}); return true;
      }
      const m=path.match(/^\/internal\/build-worker\/([^/]+)\/(event|complete|fail)$/);
      if(!m || !uuid.test(m[1])) throw invalid("Worker endpoint not found.",404);
      if(typeof body.lease_token !== "string" || !body.lease_token) throw invalid("Build lease is required.",409);
      const [,id,operation]=m;
      let published;
      try {
        const build=await tx(async c => {
          const b=await lockBuild(c,id,body.lease_token);
          if(operation === "event") {
            const type=text(body.type,80,"Event type");
            if(!/^[A-Z][A-Z0-9_]*$/.test(type)) throw invalid("Invalid event type.");
            await event(c,b,type,text(body.message,2000,"Event message"));
            await c.query("UPDATE builds SET claimed_at=now(),updated_at=now() WHERE id=$1", [id]);
            return display(b);
          }
          if(operation === "fail") {
            const error=text(body.error,4000,"Build error");
            const next=(await c.query("UPDATE builds SET status='failed',error=$2,lease_token=NULL,updated_at=now(),completed_at=now() WHERE id=$1 RETURNING *",[id,error])).rows[0];
            await c.query("UPDATE tasks SET status='failed',completed_at=now(),result=$2 WHERE id=$1",[b.task_id,{error}]);
            await event(c,b,"TASK_FAILED",error); return display(next);
          }
          if(!Array.isArray(body.files) || body.files.length < 1 || body.files.length > 30) throw invalid("Provide 1–30 static source files.");
          const supplied=body.files.map(f => { const valid=validateFile({...f,version:1}); return {path:valid.path,content:valid.content}; });
          if(new Set(supplied.map(f=>f.path)).size!==supplied.length) throw invalid("Duplicate source paths are not allowed.");
          // Candidate output merges with the creation snapshot; omitted files are preserved.
          const merged=new Map(b.source_files.map(f=>[f.path,{path:f.path,content:f.content}]));
          for(const f of supplied) merged.set(f.path,f);
          const files=[...merged.values()];
          if(files.length>30 || files.reduce((n,f)=>n+Buffer.byteLength(f.content,"utf8"),0)>600000) throw invalid("Candidate exceeds the 30-file or 600 KB limit.");
          if(!body.review || typeof body.review.approved !== "boolean") throw invalid("An explicit review decision is required.");
          const review={approved:body.review.approved,summary:text(body.review.summary,4000,"Review summary")};
          const summary=text(body.summary,4000,"Build summary");
          const checks={...runStaticChecks(files),versions:b.base_versions};
          const accepted=review.approved && checks.passed;
          const snapshot=accepted ? randomBytes(32).toString("hex") : null;
          if(snapshot) { published=snapshot; await publishSnapshot(snapshot,files); }
          const error=accepted ? null : "Candidate did not pass review and static structure checks.";
          const next=(await c.query("UPDATE builds SET status=$2,candidate_files=$3,snapshot_id=$4,summary=$5,error=$6,checks=$7,review=$8,lease_token=NULL,updated_at=now(),completed_at=now() WHERE id=$1 RETURNING *",[id,accepted?"review":"failed",JSON.stringify(files),snapshot,summary,error,checks,review])).rows[0];
          await c.query("UPDATE tasks SET status=$2,result=$3,completed_at=now() WHERE id=$1",[b.task_id,accepted?"completed":"failed",{checks,review,summary}]);
          await event(c,b,checks.passed?"TEST_PASSED":"TEST_FAILED","Control plane ran static structure checks on the candidate.",{result:checks});
          await event(c,b,accepted?"READY_FOR_REVIEW":"REVIEW_REJECTED",accepted?"Candidate preview is ready for owner review.":error);
          return display(next);
        });
        json(res,200,{build}); return true;
      } catch(e) { if(published) await cleanup(published); throw e; }
    }
    const m=path.match(/^\/api\/projects\/([^/]+)\/builds(?:\/([^/]+)\/(apply|cancel))?$/);
    if(!m) return false;
    const [,projectId,buildId,operation]=m;
    if(!uuid.test(projectId) || (buildId && !uuid.test(buildId))) throw invalid("Invalid identifier.");
    if(!buildId && req.method === "GET") { json(res,200,{builds:await list(projectId)}); return true; }
    if(req.method !== "POST") throw invalid("Method not allowed.",405);
    if(!buildId) {
      const body=await readJson(req);
      const prompt=text(body.prompt,60000,"Build prompt");
      const providerId=body.provider || 'openai';
      if(!providerDefinitions.some(item=>item.id===providerId)) throw invalid('Choose a supported provider.');
      const agent=await status(providerId); if(!agent.available) throw invalid(agent.reason,503);
      const build=await tx(async c => {
        await lockProject(c,projectId);
        if((await c.query("SELECT id FROM builds WHERE project_id=$1 AND status IN ('queued','running','review')",[projectId])).rowCount) throw invalid("Finish or cancel the existing active build first.",409);
        const files=(await c.query("SELECT path,content,version FROM files WHERE project_id=$1 ORDER BY path",[projectId])).rows;
        const task=randomUUID(),id=randomUUID();
        await c.query("INSERT INTO tasks(id,project_id,kind,status) VALUES($1,$2,'agent-build','running')",[task,projectId]);
        const b=(await c.query("INSERT INTO builds(id,project_id,task_id,status,prompt,base_versions,source_files,provider) VALUES($1,$2,$3,'queued',$4,$5,$6,$7) RETURNING *",[id,projectId,task,prompt,versions(files),JSON.stringify(files),providerId])).rows[0];
        await event(c,b,"BUILD_QUEUED","Build request queued for the external worker."); return display(b);
      });
      json(res,201,{build}); return true;
    }
    let revoke;
    const result=await tx(async c => {
      await lockProject(c,projectId);
      const b=await lockBuild(c,buildId);
      if(b.project_id !== projectId) throw invalid("Build not found.",404);
      if(operation === "cancel") {
        if(b.status === "applied") throw invalid("An applied build cannot be cancelled.",409);
        if(b.status === "cancelled") return {build:display(b)};
        const current=(await c.query("SELECT snapshot_id FROM previews WHERE project_id=$1",[projectId])).rows[0]?.snapshot_id;
        if(b.snapshot_id && b.snapshot_id !== current) await removeSnapshot(b.snapshot_id);
        const next=(await c.query("UPDATE builds SET status='cancelled',lease_token=NULL,updated_at=now(),completed_at=now() WHERE id=$1 RETURNING *",[b.id])).rows[0];
        await c.query("UPDATE tasks SET status='failed',completed_at=now(),result=$2 WHERE id=$1",[b.task_id,{cancelled:true}]);
        await event(c,b,"BUILD_CANCELLED","Owner cancelled the build."); return {build:display(next)};
      }
      if(b.status === "applied") {
        const saved=(await c.query("SELECT snapshot_id FROM previews WHERE project_id=$1",[projectId])).rows[0];
        return {build:display(b),preview:saved?{running:true,url:previewUrl(saved.snapshot_id)}:{running:false,url:null}};
      }
      if(b.status !== "review" || !b.snapshot_id || !b.candidate_files) throw invalid("Build is not ready to apply.",409);
      const current=(await c.query("SELECT path,version FROM files WHERE project_id=$1",[projectId])).rows;
      if(!sameVersions(versions(current),b.base_versions)) throw invalid("Project sources changed after this build started. Candidate preserved; create a new build from current sources.",409);
      // Republish after a preview-worker restart before committing any source changes.
      await publishSnapshot(b.snapshot_id,b.candidate_files);
      await captureCheckpoint(c,projectId,'Before applying reviewed build');
      const historical=(await c.query("SELECT entry.key AS path, MAX(entry.value::integer) AS version FROM checkpoints CROSS JOIN LATERAL jsonb_each_text(source_versions) AS entry WHERE project_id=$1 GROUP BY entry.key",[projectId])).rows;
      const highest=new Map(historical.map(file=>[file.path,file.version]));
      for(const file of current) highest.set(file.path,Math.max(highest.get(file.path)||0,file.version));
      // A deleted path must never regain an old version and accept a stale draft.
      for(const f of b.candidate_files) {
        const version=(highest.get(f.path)||0)+1;
        if(version>2147483647) throw invalid('Source version limit reached.',409);
        await c.query("INSERT INTO files(project_id,path,content,version) VALUES($1,$2,$3,$4) ON CONFLICT(project_id,path) DO UPDATE SET content=$3,version=$4",[projectId,f.path,f.content,version]);
      }
      const old=(await c.query("SELECT snapshot_id FROM previews WHERE project_id=$1",[projectId])).rows[0]?.snapshot_id;
      if(old !== b.snapshot_id) revoke=old;
      await c.query("INSERT INTO previews(project_id,snapshot_id) VALUES($1,$2) ON CONFLICT(project_id) DO UPDATE SET snapshot_id=$2,updated_at=now()",[projectId,b.snapshot_id]);
      await c.query("UPDATE projects SET updated_at=now() WHERE id=$1",[projectId]);
      const next=(await c.query("UPDATE builds SET status='applied',updated_at=now() WHERE id=$1 RETURNING *",[b.id])).rows[0];
      await captureCheckpoint(c,projectId,'Applied reviewed build');
      await event(c,b,"FILES_CHANGED","Owner applied reviewed candidate sources.",{paths:b.candidate_files.map(f=>f.path)});
      await event(c,b,"BUILD_APPLIED","Reviewed candidate is now the saved project and current preview.");
      return {build:display(next),preview:{running:true,url:previewUrl(b.snapshot_id)}};
    });
    await cleanup(revoke);
    json(res,200,result); return true;
  };
  return {handle,status,list};
}
