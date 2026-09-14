import http from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID, randomBytes } from "node:crypto";
import {
  invalid,
  validateName,
  validateFile,
  starterFiles,
  runStaticChecks,
} from "./domain.js";
import { createBuildService } from "./build-service.js";
import { createCheckpointService } from "./checkpoint-service.js";
import { createProjectService, requireIdle, validateSourceSet } from "./project-service.js";
import { json, readJson } from "./http.js";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function createApp({
  pool,
  workerUrl,
  workerToken,
  previewPublicUrl,
  buildWorkerToken,
}) {
  const worker = async (path, method = "GET", body) => {
    if (!workerUrl || !workerToken)
      throw invalid("Preview worker is not configured.", 503);
    let response;
    try {
      response = await fetch(`${workerUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${workerToken}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw invalid(
        "Preview worker is unavailable. Start the worker and retry.",
        503,
      );
    }
    if (!response.ok && response.status !== 404)
      throw invalid(
        "Preview worker rejected the operation. Check worker configuration and capacity.",
        503,
      );
    return response;
  };
  const tx = async (fn) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  };
  const event = (client, project, type, detail, task = null) =>
    client.query(
      "INSERT INTO events(project_id,type,detail,task_id) VALUES($1,$2,$3,$4)",
      [project, type, detail, task],
    );
  const lock = async (client, id) => {
    const { rows } = await client.query(
      "SELECT * FROM projects WHERE id=$1 FOR UPDATE",
      [id],
    );
    if (!rows[0]) throw invalid("Project not found.", 404);
    return rows[0];
  };
  const publicPreview = (id) => ({
    running: true,
    url: `${previewPublicUrl.replace(/\/$/, "")}/p/${id}/index.html`,
  });
  const checkpoints = createCheckpointService({
    pool,
    publishSnapshot: (id, files) => worker("/internal/snapshots", "POST", { id, files }),
    removeSnapshot: id => worker(`/internal/snapshots/${id}`, "DELETE"),
    previewUrl: id => publicPreview(id).url,
  });
  const builds = createBuildService({
    pool, workerToken: buildWorkerToken,
    captureCheckpoint: checkpoints.capture,
    publishSnapshot: (id, files) => worker("/internal/snapshots", "POST", { id, files }),
    removeSnapshot: id => worker(`/internal/snapshots/${id}`, "DELETE"),
    previewUrl: id => publicPreview(id).url,
  });
  const projects = createProjectService({ pool, tx, lock, event, checkpoints });
  const server = http.createServer(async (req, res) => {
    try {
      // A local single-owner app: reject hostile Host/Origin values and DNS rebinding.
      const authority = req.headers.host || "";
      if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(authority))
        throw invalid("This development server requires a loopback host.", 403);
      const origin = req.headers.origin;
      if (origin && origin !== `http://${authority}`)
        throw invalid("Cross-origin requests are not allowed.", 403);
      if (req.headers["sec-fetch-site"] === "cross-site")
        throw invalid("Cross-site requests are not allowed.", 403);
      const path = new URL(req.url, `http://${authority}`).pathname;
      if (await builds.handle(req, res, path)) return;
      if (await checkpoints.handle(req, res, path)) return;
      if (await projects.handle(req, res, path)) return;
      if (path === '/api/connections' && req.method === 'GET') {
        const agent = await builds.status();
        let database = false, preview = false;
        try { await pool.query('SELECT 1'); database = true; } catch { /* status only */ }
        try { await worker(`/internal/snapshots/${'0'.repeat(64)}`); preview = true; } catch { /* status only */ }
        return json(res, 200, { connections: [
          ...(agent.providers || []).map(provider => ({ id: provider.id, name: provider.name, status: provider.available ? 'Available' : 'Unavailable', detail: provider.available ? `Worker ready · ${provider.model}` : provider.reason })),
          { id: 'postgresql', name: 'Project storage', status: database ? 'Connected' : 'Unavailable', detail: 'PostgreSQL stores saved source, conversation, and checkpoints.' },
          { id: 'preview', name: 'Product previews', status: preview ? 'Connected' : 'Unavailable', detail: 'Separate static preview worker.' },
          { id: 'cloudflare', name: 'Cloudflare domains', status: 'Not connected here', detail: 'Existing domain configuration remains with Cloudflare. Domain management is not connected to this workspace.' },
          { id: 'outlook', name: 'Outlook email', status: 'Not connected here', detail: 'Application email requires its own authorized Outlook connection. Sending email is not yet available in this static runtime.' },
        ] });
      }
      if (path === "/api/health" && req.method === "GET") {
        try {
          await pool.query("SELECT 1");
          return json(res, 200, { status: "ok", database: "postgresql" });
        } catch {
          throw invalid(
            "PostgreSQL is unavailable. Check DATABASE_URL and apply migrations.",
            503,
          );
        }
      }
      if (path === "/api/projects" && req.method === "GET")
        return json(res, 200, {
          projects: (
            await pool.query("SELECT * FROM projects ORDER BY updated_at DESC")
          ).rows,
        });
      if (path === "/api/projects" && req.method === "POST") {
        const name = validateName((await readJson(req)).name);
        const project = await tx(async (c) => {
          const id = randomUUID();
          const project = (
            await c.query(
              "INSERT INTO projects(id,name) VALUES($1,$2) RETURNING *",
              [id, name],
            )
          ).rows[0];
          for (const f of starterFiles)
            await c.query(
              "INSERT INTO files(project_id,path,content) VALUES($1,$2,$3)",
              [id, f.path, f.content],
            );
          await event(c, id, "PROJECT_CREATED", {
            template: "static-web",
            message: "Created from the static web starter.",
          });
          await checkpoints.capture(c, id, 'Initial saved source');
          return project;
        });
        return json(res, 201, { project });
      }
      const match = path.match(
        /^\/api\/projects\/([^/]+)(?:\/(files|preview|tests))?$/,
      );
      if (match) {
        const [, id, action] = match;
        if (!uuid.test(id)) throw invalid("Invalid project identifier.");
        if (!action && req.method === "GET") {
          const data = await tx(async (c) => {
            const project = await lock(c, id);
            let preview = { running: false, url: null };
            const saved = (
              await c.query("SELECT * FROM previews WHERE project_id=$1", [id])
            ).rows[0];
            if (saved) {
              try {
                const response = await worker(
                  `/internal/snapshots/${saved.snapshot_id}`,
                );
                if (response.ok) preview = publicPreview(saved.snapshot_id);
                else {
                  await c.query("DELETE FROM previews WHERE project_id=$1", [
                    id,
                  ]);
                  await event(c, id, "PREVIEW_STOPPED", {
                    message: "Preview expired or worker restarted.",
                  });
                }
              } catch (e) {
                if (e.status !== 503) throw e;
                preview = {
                  running: false,
                  url: null,
                  unavailable: true,
                  reason: e.message,
                };
              }
            }
            return {
              project,
              preview,
              files: (
                await c.query(
                  "SELECT path,content,version FROM files WHERE project_id=$1 ORDER BY path",
                  [id],
                )
              ).rows,
              tasks: (
                await c.query(
                  "SELECT * FROM tasks WHERE project_id=$1 ORDER BY created_at DESC LIMIT 30",
                  [id],
                )
              ).rows,
              events: (
                await c.query(
                  "SELECT type,detail,created_at,task_id FROM events WHERE project_id=$1 ORDER BY id DESC LIMIT 100",
                  [id],
                )
              ).rows,
            };
          });
          data.agent = await builds.status();
          data.builds = await builds.list(id);
          data.checkpoints = await checkpoints.list(id);
          data.storage = { file_count: data.files.length, bytes: data.files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) };
          return json(res, 200, data);
        }
        if (action === "files" && req.method === "PUT") {
          const f = validateFile(await readJson(req));
          const file = await tx(async (c) => {
            await lock(c, id);
            await requireIdle(c, id);
            const sources = (await c.query('SELECT path,content FROM files WHERE project_id=$1', [id])).rows;
            validateSourceSet(sources.map(source => source.path === f.path ? f : source));
            await checkpoints.capture(c, id, 'Before saving a file');
            const updated = await c.query(
              "UPDATE files SET content=$3, version=version+1 WHERE project_id=$1 AND path=$2 AND version=$4 RETURNING path,content,version",
              [id, f.path, f.content, f.version],
            );
            if (!updated.rowCount) {
              const exists = (
                await c.query(
                  "SELECT version FROM files WHERE project_id=$1 AND path=$2",
                  [id, f.path],
                )
              ).rowCount;
              throw invalid(
                exists
                  ? "This file changed in another session. Your draft is preserved; load the saved version before retrying."
                  : "File not found.",
                exists ? 409 : 404,
              );
            }
            await c.query("UPDATE projects SET updated_at=now() WHERE id=$1", [
              id,
            ]);
            await event(c, id, "FILES_CHANGED", {
              path: f.path,
              version: updated.rows[0].version,
              message: `Saved ${f.path}.`,
            });
            return updated.rows[0];
          });
          return json(res, 200, { file });
        }
        if (action === "tests" && req.method === "POST") {
          const result = await tx(async (c) => {
            await lock(c, id);
            const task = randomUUID();
            await c.query(
              "INSERT INTO tasks(id,project_id,kind,status) VALUES($1,$2,'static-checks','running')",
              [task, id],
            );
            await event(
              c,
              id,
              "TASK_STARTED",
              { message: "Running static structure checks on saved files." },
              task,
            );
            const files = (
              await c.query(
                "SELECT path,content,version FROM files WHERE project_id=$1",
                [id],
              )
            ).rows;
            const result = {
              ...runStaticChecks(files),
              versions: Object.fromEntries(
                files.map((f) => [f.path, f.version]),
              ),
            };
            await c.query(
              "UPDATE tasks SET status=$2,result=$3,completed_at=now() WHERE id=$1",
              [task, result.passed ? "completed" : "failed", result],
            );
            await event(
              c,
              id,
              result.passed ? "TEST_PASSED" : "TEST_FAILED",
              {
                message: `${result.checks.filter((c) => c.passed).length}/${result.checks.length} static checks passed. These are not runtime tests.`,
                result,
              },
              task,
            );
            return result;
          });
          return json(res, 200, { result });
        }
        if (action === "preview" && req.method === "POST") {
          const { action: operation } = await readJson(req);
          if (!["start", "update", "stop"].includes(operation))
            throw invalid("Choose start, update or stop.");
          const preview = await tx(async (c) => {
            await lock(c, id);
            const old = (
              await c.query(
                "SELECT snapshot_id FROM previews WHERE project_id=$1",
                [id],
              )
            ).rows[0]?.snapshot_id;
            if (operation === "stop") {
              if (old) await worker(`/internal/snapshots/${old}`, "DELETE");
              await c.query("DELETE FROM previews WHERE project_id=$1", [id]);
              await event(c, id, "PREVIEW_STOPPED", {
                message: "Stopped the static preview.",
              });
              return { running: false, url: null };
            }
            const files = (
              await c.query(
                "SELECT path,content,version FROM files WHERE project_id=$1",
                [id],
              )
            ).rows;
            const snapshot = randomBytes(32).toString("hex");
            await worker("/internal/snapshots", "POST", {
              id: snapshot,
              files,
            });
            if (old) await worker(`/internal/snapshots/${old}`, "DELETE");
            await c.query(
              "INSERT INTO previews(project_id,snapshot_id) VALUES($1,$2) ON CONFLICT(project_id) DO UPDATE SET snapshot_id=$2,updated_at=now()",
              [id, snapshot],
            );
            await event(
              c,
              id,
              operation === "start" ? "PREVIEW_STARTED" : "PREVIEW_UPDATED",
              {
                message: `${operation === "start" ? "Started" : "Updated"} isolated static preview.`,
                versions: Object.fromEntries(
                  files.map((f) => [f.path, f.version]),
                ),
              },
            );
            return publicPreview(snapshot);
          });
          return json(res, 200, { preview });
        }
        throw invalid("Method not allowed.", 405);
      }
      if (
        req.method === "GET" &&
        ["/", "/index.html", "/app.js", "/styles.css"].includes(path)
      ) {
        const file = path === "/" ? "index.html" : path.slice(1);
        const content = await readFile(
          new URL(`../public/${file}`, import.meta.url),
        );
        res.writeHead(200, {
          "Content-Type": `${{ html: "text/html", js: "text/javascript", css: "text/css" }[file.split(".").pop()]}; charset=utf-8`,
          "Content-Security-Policy": `default-src 'self'; script-src 'self'; style-src 'self'; frame-src ${new URL(previewPublicUrl).origin}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "Cache-Control": "no-store",
        });
        return res.end(content);
      }
      throw invalid("Not found.", 404);
    } catch (e) {
      if (!e.status) console.error("Request failed:", e.code || e.name);
      json(res, e.status || 500, {
        error: e.status
          ? e.message
          : "The operation failed. Check the database connection and migrations, then retry.",
      });
    }
  });
  server.requestTimeout = 10000;
  return server;
}
