import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
for (const dir of ["server", "public", "test", "scripts"]) {
  for (const file of await readdir(dir)) {
    if (!file.endsWith(".js")) continue;
    const result = spawnSync(process.execPath, ["--check", `${dir}/${file}`], {
      stdio: "inherit",
    });
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
console.log(
  "JavaScript syntax checks passed. Static assets require no compilation.",
);
