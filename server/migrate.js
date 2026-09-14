import pg from "pg";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
export async function migrate(pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(20260913)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const dir = new URL("./migrations/", import.meta.url);
    for (const name of (await readdir(dir))
      .filter((n) => n.endsWith(".sql"))
      .sort()) {
      if (
        (
          await client.query(
            "SELECT name FROM schema_migrations WHERE name=$1",
            [name],
          )
        ).rowCount
      )
        continue;
      await client.query(await readFile(new URL(name, dir), "utf8"));
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [
        name,
      ]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await migrate(pool);
    console.log("PostgreSQL migrations applied.");
  } finally {
    await pool.end();
  }
}
