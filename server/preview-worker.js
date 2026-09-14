import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { json, readJson } from "./http.js";
import { invalid, validateFile } from "./domain.js";
const types = { html: "text/html", css: "text/css", js: "text/javascript" };
const policy =
  "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; worker-src 'none'";
export function createPreviewWorker({ token }) {
  if (!token || token.length < 24)
    throw new Error(
      "PREVIEW_WORKER_TOKEN must contain at least 24 characters.",
    );
  const snapshots = new Map();
  const lifetime = 60 * 60 * 1000;
  const sweep = () => {
    for (const [id, snapshot] of snapshots)
      if (Date.now() - snapshot.created > lifetime) snapshots.delete(id);
  };
  const timer = setInterval(sweep, 60000).unref();
  const server = http.createServer(async (req, res) => {
    try {
      const path = new URL(req.url, "http://worker").pathname;
      if (path.startsWith("/internal/")) {
        const auth = Buffer.from(req.headers.authorization || "");
        const expected = Buffer.from(`Bearer ${token}`);
        if (auth.length !== expected.length || !timingSafeEqual(auth, expected))
          throw invalid("Unauthorized.", 401);
        sweep();
        if (path === "/internal/snapshots" && req.method === "POST") {
          const body = await readJson(req, 1300000);
          if (
            !/^[a-f0-9]{64}$/.test(body.id || "") ||
            !Array.isArray(body.files) ||
            body.files.length > 30 ||
            body.files.length < 1
          )
            throw invalid("Invalid snapshot.");
          if (snapshots.size >= 100 && !snapshots.has(body.id))
            throw invalid(
              "Preview capacity reached. Stop an existing preview.",
              503,
            );
          const files = new Map();
          for (const file of body.files) {
            validateFile({ ...file, version: file.version || 1 });
            files.set(file.path, file.content);
          }
          if (!files.has("index.html"))
            throw invalid("index.html is required.");
          snapshots.set(body.id, { files, created: Date.now() });
          return json(res, 201, { id: body.id });
        }
        const match = path.match(/^\/internal\/snapshots\/([a-f0-9]{64})$/);
        if (match && req.method === "DELETE") {
          snapshots.delete(match[1]);
          return json(res, 200, { stopped: true });
        }
        if (match && req.method === "GET")
          return json(res, snapshots.has(match[1]) ? 200 : 404, {
            running: snapshots.has(match[1]),
          });
        throw invalid("Not found.", 404);
      }
      if (req.method !== "GET") throw invalid("Method not allowed.", 405);
      const match = path.match(/^\/p\/([a-f0-9]{64})\/(.+)$/);
      sweep();
      const file = match && snapshots.get(match[1])?.files.get(match[2]);
      if (file === undefined || file === false || file === null)
        throw invalid("Preview stopped, expired, or file not found.", 404);
      res.writeHead(200, {
        "Content-Type": `${types[match[2].split(".").pop()]}; charset=utf-8`,
        "Content-Security-Policy": policy,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Permissions-Policy":
          "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
      });
      res.end(file);
    } catch (e) {
      json(res, e.status || 500, {
        error: e.status ? e.message : "Preview worker failed.",
      });
    }
  });
  server.on("close", () => clearInterval(timer));
  server.requestTimeout = 10000;
  return server;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  // Deliberately no database client, shell, child process, eval, or control-plane configuration.
  const server = createPreviewWorker({
    token: process.env.PREVIEW_WORKER_TOKEN,
  });
  server.listen(
    Number(process.env.PREVIEW_PORT || 3001),
    process.env.PREVIEW_HOST || "127.0.0.1",
    () => console.log("Static preview worker ready."),
  );
}
