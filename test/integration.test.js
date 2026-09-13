import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createApp } from "../server/app.js";
import { createPreviewWorker } from "../server/preview-worker.js";
import { migrate } from "../server/migrate.js";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}
function close(server) {
  server.closeAllConnections?.();
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

test(
  "PostgreSQL project, conflict, audit, checks, and preview lifecycle",
  { skip: !process.env.DATABASE_URL },
  async (t) => {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    let app;
    let worker;
    let projectId;
    t.after(async () => {
      if (app?.listening) await close(app);
      if (worker?.listening) await close(worker);
      try {
        if (projectId)
          await pool.query("DELETE FROM projects WHERE id = $1", [projectId]);
      } finally {
        await pool.end();
      }
    });
    await migrate(pool);
    const token = randomUUID();
    worker = createPreviewWorker({ token });
    const workerUrl = await listen(worker);
    app = createApp({
      pool,
      workerUrl,
      workerToken: token,
      previewPublicUrl: workerUrl,
    });
    const base = await listen(app);
    async function api(path, method = "GET", body) {
      const response = await fetch(`${base}/api/projects${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, data: await response.json() };
    }

    const created = await api("", "POST", {
      name: `Integration ${randomUUID()}`,
    });
    assert.equal(created.status, 201);
    const id = created.data.project?.id ?? created.data.id;
    assert.ok(id);
    projectId = id;
    const detail = await api(`/${id}`);
    assert.equal(detail.status, 200);
    const file = detail.data.files.find((file) => file.path === "index.html");
    assert.ok(file, "starter has index.html");
    const content =
      '<!doctype html><html><body><h1>Persisted integration marker</h1><script>document.body.dataset.executed="yes"</script></body></html>';
    const saved = await api(`/${id}/files`, "PUT", {
      path: file.path,
      content,
      version: file.version,
    });
    assert.equal(saved.status, 200);
    const stale = await api(`/${id}/files`, "PUT", {
      path: file.path,
      content: "stale overwrite",
      version: file.version,
    });
    assert.equal(stale.status, 409);
    const reloaded = await api(`/${id}`);
    assert.equal(
      reloaded.data.files.find((file) => file.path === "index.html").content,
      content,
    );
    assert.ok(reloaded.data.events.length >= 2);
    assert.equal(reloaded.data.agent.available, false);

    const checks = await api(`/${id}/tests`, "POST", {});
    assert.equal(checks.status, 200);
    assert.equal(typeof checks.data.result.passed, "boolean");
    assert.ok(checks.data.result.checks.length > 0);
    const checked = await api(`/${id}`);
    assert.ok(
      checked.data.tasks.length > 0,
      "test operation persisted as a task",
    );

    const started = await api(`/${id}/preview`, "POST", { action: "start" });
    assert.equal(started.status, 200);
    const previewUrl = started.data.preview?.url ?? started.data.url;
    assert.ok(previewUrl);
    const previewResponse = await fetch(previewUrl);
    assert.equal(previewResponse.status, 200);
    assert.match(await previewResponse.text(), /Persisted integration marker/);
    assert.ok(
      previewResponse.headers.get("content-security-policy"),
      "preview response has sandboxing policy",
    );
    const latestFile = checked.data.files.find(
      (file) => file.path === "index.html",
    );
    assert.equal(
      (
        await api(`/${id}/files`, "PUT", {
          path: "index.html",
          content: content.replace(
            "Persisted integration marker",
            "Updated integration marker",
          ),
          version: latestFile.version,
        })
      ).status,
      200,
    );
    assert.equal(
      (await api(`/${id}/preview`, "POST", { action: "update" })).status,
      200,
    );
    const updated = await api(`/${id}`);
    assert.match(
      await (await fetch(updated.data.preview.url)).text(),
      /Updated integration marker/,
    );
    assert.equal(
      (await api(`/${id}/preview`, "POST", { action: "stop" })).status,
      200,
    );
    assert.equal((await fetch(updated.data.preview.url)).status, 404);
    assert.equal((await fetch(previewUrl)).status, 404);

    const beforeRace = (await api(`/${id}`)).data.files.find(
      (file) => file.path === "app.js",
    );
    const concurrentSaves = await Promise.all(
      ["A", "B"].map((marker) =>
        api(`/${id}/files`, "PUT", {
          path: "app.js",
          content: `// concurrent writer ${marker}`,
          version: beforeRace.version,
        }),
      ),
    );
    assert.deepEqual(
      concurrentSaves.map((result) => result.status).sort(),
      [200, 409],
      "exactly one simultaneous writer wins",
    );

    assert.equal(
      (await api(`/${id}/preview`, "POST", { action: "start" })).status,
      200,
    );
    const workerPort = worker.address().port;
    await close(worker);
    const duringOutage = await api(`/${id}`);
    assert.equal(
      duringOutage.status,
      200,
      "saved source remains accessible while preview worker is offline",
    );
    assert.equal(duringOutage.data.preview.unavailable, true);
    assert.ok(
      duringOutage.data.files.some((file) => file.path === "index.html"),
    );
    worker = createPreviewWorker({ token });
    worker.listen(workerPort, "127.0.0.1");
    await once(worker, "listening");
    const afterRestart = await api(`/${id}`);
    assert.equal(afterRestart.status, 200);
    assert.equal(afterRestart.data.preview.running, false);
    assert.ok(
      afterRestart.data.events.some(
        (event) => event.type === "PREVIEW_STOPPED",
      ),
    );
  },
);
