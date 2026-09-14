import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { runBuildWorker } from "../server/build-worker.js";
import { starterFiles } from "../server/domain.js";

test("a repair preserves generated files omitted from the correction response", async () => {
  const abort = new AbortController();
  let claimed = false, completed, calls = 0, reviews = 0;
  const server = http.createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    let data = { ok: true };
    if (req.url.endsWith("/claim")) {
      data = { build: claimed ? null : { id: "fixture", prompt: "Synthetic test", source_files: starterFiles, attachments: [{name:'reference.zip',files:[{path:'README.md',content:'Synthetic attachment requirement'}]}], lease_token: "fixture-lease" } };
      claimed = true;
    }
    if (req.url.endsWith("/complete")) { completed = body; abort.abort(); }
    if (req.url.endsWith("/fail")) { abort.abort(); assert.fail(body.error); }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(data));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const html = starterFiles[0].content.replace("Hello, builder.", "Generated application");
  try {
    await runBuildWorker({ appUrl: `http://127.0.0.1:${server.address().port}`, token: "test-only-build-worker-token", signal: abort.signal,
      provider: {
        probe: async () => {},
        build: async input => {
          assert.equal(input.attachments[0].name, 'reference.zip');
          calls++;
          if (calls === 1) return { summary: "First generated version", files: [{ path: "index.html", content: html }] };
          assert.equal(input.source_files.find(file => file.path === "index.html").content, html);
          return { summary: "Corrected JavaScript", files: [{ path: "app.js", content: "/* corrected test fixture */" }] };
        },
        review: async input => { assert.equal(input.attachments[0].files[0].content, 'Synthetic attachment requirement'); return { approved: ++reviews === 2, summary: "Test-only review decision." }; },
      },
    });
    assert.equal(calls, 2);
    assert.equal(completed.files.find(file => file.path === "index.html").content, html);
    assert.equal(completed.files.find(file => file.path === "app.js").content, "/* corrected test fixture */");
    assert.equal(completed.files.find(file => file.path === "styles.css").content, starterFiles[1].content);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
