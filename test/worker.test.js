import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { createPreviewWorker } from "../server/preview-worker.js";

test("preview snapshots require credentials for mutation and disappear on deletion", async (t) => {
  const token = randomBytes(32).toString("hex");
  const worker = createPreviewWorker({ token });
  worker.listen(0, "127.0.0.1");
  await once(worker, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        worker.closeAllConnections?.();
        worker.close(resolve);
      }),
  );
  const base = `http://127.0.0.1:${worker.address().port}`;
  const id = randomBytes(32).toString("hex");
  const payload = JSON.stringify({
    id,
    files: [
      { path: "index.html", content: "<h1>Isolated preview</h1>" },
      { path: "app.js", content: 'throw new Error("server must not execute")' },
    ],
  });
  const request = (path, method, body, authenticated = true) =>
    fetch(base + path, {
      method,
      body,
      headers: {
        "Content-Type": "application/json",
        ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
  assert.equal(
    (await request("/internal/snapshots", "POST", payload, false)).status,
    401,
  );
  assert.ok((await request("/internal/snapshots", "POST", payload)).ok);
  assert.equal(
    (
      await request(
        "/internal/snapshots",
        "POST",
        JSON.stringify({
          id,
          files: [{ path: "../index.html", content: "escape" }],
        }),
      )
    ).status,
    400,
  );
  const visible = await fetch(`${base}/p/${id}/index.html`);
  assert.equal(visible.status, 200);
  assert.match(await visible.text(), /Isolated preview/);
  assert.match(visible.headers.get("content-security-policy"), /sandbox/);
  assert.equal(visible.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await fetch(`${base}/p/${id}/missing.html`)).status, 404);
  assert.equal(
    (await fetch(`${base}/p/${id}/%2e%2e/%2e%2e/internal/snapshots`)).status,
    401,
  );
  assert.equal(
    (await request(`/internal/snapshots/${id}`, "DELETE", undefined, false))
      .status,
    401,
  );
  assert.ok((await request(`/internal/snapshots/${id}`, "DELETE")).ok);
  assert.equal((await fetch(`${base}/p/${id}/index.html`)).status, 404);
});
