import { randomUUID, randomBytes } from "node:crypto";
import { invalid } from "./domain.js";
import { json, readJson } from "./http.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const versionMap = files => Object.fromEntries(files.map(file => [file.path, file.version]));
const metadata = row => ({ id: row.id, label: row.label, created_at: row.created_at, file_count: row.file_count });
const validateLabel = label => {
  if (typeof label !== "string" || !label.trim() || label.trim().length > 100)
    throw invalid("Checkpoint labels must contain 1–100 characters.");
  return label.trim();
};
const validateVersions = versions => {
  if (!versions || typeof versions !== "object" || Array.isArray(versions) ||
      Object.values(versions).some(version => !Number.isSafeInteger(version) || version < 1))
    throw invalid("Provide the complete current source version map.");
  return versions;
};
const sameVersions = (a, b) => Object.keys(a).length === Object.keys(b).length &&
  Object.keys(a).every(path => Object.hasOwn(b, path) && a[path] === b[path]);

export function createCheckpointService({ pool, publishSnapshot, removeSnapshot, previewUrl }) {
  const transaction = async operation => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  };
  const lockProject = async (client, projectId) => {
    if (!(await client.query("SELECT id FROM projects WHERE id=$1 FOR UPDATE", [projectId])).rowCount)
      throw invalid("Project not found.", 404);
  };
  const record = (client, projectId, type, detail) => client.query(
    "INSERT INTO events(project_id,type,detail) VALUES($1,$2,$3)", [projectId, type, detail],
  );
  const list = async projectId => (await pool.query(
    "SELECT id,label,created_at,file_count FROM checkpoints WHERE project_id=$1 ORDER BY created_at DESC,id DESC", [projectId],
  )).rows;

  // Call within the caller's transaction. Reentrant row locking coordinates with
  // file saves, build application, and restore without committing their work.
  const capture = async (client, projectId, label) => {
    const name = validateLabel(label);
    await lockProject(client, projectId);
    const files = (await client.query(
      "SELECT path,content,version FROM files WHERE project_id=$1 ORDER BY path", [projectId],
    )).rows;
    const saved = (await client.query(
      "INSERT INTO checkpoints(id,project_id,label,source_files,source_versions,file_count) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,label,created_at,file_count",
      [randomUUID(), projectId, name, JSON.stringify(files), versionMap(files), files.length],
    )).rows[0];
    await record(client, projectId, "CHECKPOINT_CREATED", {
      message: `Saved checkpoint: ${name}.`, checkpoint_id: saved.id, file_count: files.length,
    });
    return metadata(saved);
  };
  const cleanup = async id => {
    if (!id) return;
    try { await removeSnapshot(id); }
    catch { /* Disposable orphan snapshots expire; committed sources stay authoritative. */ }
  };
  const handle = async (req, res, path) => {
    const match = path.match(/^\/api\/projects\/([^/]+)\/checkpoints(?:\/([^/]+)\/restore)?$/);
    if (!match) return false;
    const [, projectId, checkpointId] = match;
    if (!uuid.test(projectId) || (checkpointId && !uuid.test(checkpointId))) throw invalid("Invalid identifier.");
    if (!checkpointId && req.method === "GET") {
      if (!(await pool.query("SELECT id FROM projects WHERE id=$1", [projectId])).rowCount)
        throw invalid("Project not found.", 404);
      json(res, 200, { checkpoints: await list(projectId) });
      return true;
    }
    if (req.method !== "POST") throw invalid("Method not allowed.", 405);
    const body = await readJson(req);
    if (!checkpointId) {
      const checkpoint = await transaction(client => capture(client, projectId, body.label));
      json(res, 201, { checkpoint });
      return true;
    }
    const expected = validateVersions(body.versions);
    let published, oldSnapshot;
    let result;
    try {
      result = await transaction(async client => {
        await lockProject(client, projectId);
        if ((await client.query(
          "SELECT id FROM builds WHERE project_id=$1 AND status IN ('queued','running','review')", [projectId],
        )).rowCount) throw invalid("Finish or discard the active build before restoring a checkpoint.", 409);
        const checkpoint = (await client.query(
          "SELECT * FROM checkpoints WHERE id=$1 AND project_id=$2", [checkpointId, projectId],
        )).rows[0];
        if (!checkpoint) throw invalid("Checkpoint not found.", 404);
        const current = (await client.query(
          "SELECT path,version FROM files WHERE project_id=$1 ORDER BY path", [projectId],
        )).rows;
        if (!sameVersions(versionMap(current), expected))
          throw invalid("Project sources changed. Reload the saved project before restoring; your current sources were preserved.", 409);
        const undo = await capture(client, projectId, `Before restore: ${checkpoint.label}`.slice(0, 100));
        // Historical maxima prevent deleted/recreated paths from reusing an old
        // version and accepting an old browser draft (the ABA problem).
        const historical = (await client.query(
          "SELECT entry.key AS path, MAX(entry.value::integer) AS version FROM checkpoints CROSS JOIN LATERAL jsonb_each_text(source_versions) AS entry WHERE project_id=$1 GROUP BY entry.key", [projectId],
        )).rows;
        const highest = new Map(historical.map(file => [file.path, file.version]));
        const files = checkpoint.source_files.map(file => ({
          path: file.path, content: file.content, version: (highest.get(file.path) || 0) + 1,
        }));
        if (files.some(file => file.version > 2147483647)) throw invalid("Source version limit reached.", 409);
        published = randomBytes(32).toString("hex");
        await publishSnapshot(published, files);
        oldSnapshot = (await client.query("SELECT snapshot_id FROM previews WHERE project_id=$1", [projectId])).rows[0]?.snapshot_id;
        await client.query("DELETE FROM files WHERE project_id=$1 AND NOT (path = ANY($2::text[]))", [projectId, files.map(file => file.path)]);
        for (const file of files) await client.query(
          "INSERT INTO files(project_id,path,content,version) VALUES($1,$2,$3,$4) ON CONFLICT(project_id,path) DO UPDATE SET content=$3,version=$4",
          [projectId, file.path, file.content, file.version],
        );
        await client.query(
          "INSERT INTO previews(project_id,snapshot_id) VALUES($1,$2) ON CONFLICT(project_id) DO UPDATE SET snapshot_id=$2,updated_at=now()", [projectId, published],
        );
        await client.query("UPDATE projects SET updated_at=now() WHERE id=$1", [projectId]);
        await record(client, projectId, "CHECKPOINT_RESTORED", {
          message: `Restored checkpoint: ${checkpoint.label}.`, checkpoint_id: checkpointId, undo_checkpoint_id: undo.id,
        });
        await record(client, projectId, "FILES_CHANGED", {
          message: "Restored saved checkpoint sources.", paths: files.map(file => file.path), versions: versionMap(files),
        });
        return { checkpoint: metadata(checkpoint), undo_checkpoint: undo, files,
          preview: { running: true, url: previewUrl(published) } };
      });
    } catch (error) {
      await cleanup(published);
      throw error;
    }
    await cleanup(oldSnapshot);
    json(res, 200, result);
    return true;
  };
  return { handle, list, capture };
}
