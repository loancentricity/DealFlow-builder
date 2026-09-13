import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createApp } from "../server/app.js";

test("control plane rejects hostile host, origin, and cross-site requests before database access", async (t) => {
  // No database is supplied: these perimeter checks must finish before accessing one.
  const server = createApp({ previewPublicUrl: "http://127.0.0.1:3001" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  );
  const port = server.address().port;
  const request = (headers) =>
    new Promise((resolve, reject) => {
      const req = http.get(
        { host: "127.0.0.1", port, path: "/api/projects", headers },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode));
        },
      );
      req.on("error", reject);
    });
  assert.equal(await request({ Host: "attacker.example" }), 403);
  assert.equal(await request({ Origin: "https://attacker.example" }), 403);
  assert.equal(await request({ Origin: "null" }), 403);
  assert.equal(await request({ "Sec-Fetch-Site": "cross-site" }), 403);
  const response = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
});
