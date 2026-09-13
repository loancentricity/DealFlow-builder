import pg from "pg";
import { createApp } from "./app.js";
if (!process.env.DATABASE_URL)
  throw new Error(
    "DATABASE_URL is required. Apply PostgreSQL migrations before starting.",
  );
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 5000,
});
const server = createApp({
  pool,
  workerUrl: process.env.PREVIEW_WORKER_URL || "http://127.0.0.1:3001",
  workerToken: process.env.PREVIEW_WORKER_TOKEN,
  previewPublicUrl: process.env.PREVIEW_PUBLIC_URL || "http://127.0.0.1:3001",
});
server.listen(
  Number(process.env.PORT || 3000),
  process.env.HOST || "127.0.0.1",
  () => console.log("DealFlow Builder ready on the configured local port."),
);
async function stop() {
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
