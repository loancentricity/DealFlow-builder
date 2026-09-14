import test from "node:test";
import assert from "node:assert/strict";
import {
  validateFile,
  validateName,
  runStaticChecks,
  starterFiles,
} from "../server/domain.js";

test("file validation rejects traversal and unsupported executable files", () => {
  for (const path of [
    "../index.html",
    "/index.html",
    "a/../../index.html",
    "server.js.exe",
    "file\\index.html",
  ]) {
    assert.throws(
      () => validateFile({ path, content: "text", version: 1 }),
      (error) => error.status === 400,
    );
  }
});

test("file validation requires source text and a valid optimistic concurrency version", () => {
  for (const version of [0, -1, 1.5, "1", null]) {
    assert.throws(
      () => validateFile({ path: "index.html", content: "hello", version }),
      (error) => error.status === 400,
    );
  }
  assert.throws(
    () => validateFile({ path: "index.html", content: {}, version: 1 }),
    (error) => error.status === 400,
  );
  assert.doesNotThrow(() =>
    validateFile({ path: "index.html", content: "<h1>Hello</h1>", version: 1 }),
  );
});

test("project name validation accepts useful names and rejects empty or oversized names", () => {
  assert.doesNotThrow(() => validateName("Synthetic workshop"));
  for (const name of ["", "   ", null, "a".repeat(201)]) {
    assert.throws(
      () => validateName(name),
      (error) => error.status === 400,
    );
  }
});

test("static checks detect missing entry points without executing source", () => {
  const result = runStaticChecks([
    { path: "app.js", content: 'throw new Error("must never execute")' },
  ]);
  assert.equal(result.passed, false);
  assert.ok(result.checks.length > 0);
});

test("starter checks pass shipped files and reject missing or remote assets", () => {
  assert.equal(runStaticChecks(starterFiles).passed, true);
  const missing = runStaticChecks(
    starterFiles.filter((file) => file.path !== "styles.css"),
  );
  assert.equal(missing.passed, false);
  assert.equal(
    missing.checks.find((check) => check.name === "Local assets").passed,
    false,
  );
  const external = runStaticChecks(
    starterFiles.map((file) =>
      file.path === "index.html"
        ? {
            ...file,
            content: file.content.replace(
              "styles.css",
              "https://example.com/style.css",
            ),
          }
        : file,
    ),
  );
  assert.equal(external.passed, false);
  assert.equal(
    external.checks.find((check) => check.name === "Self-contained assets")
      .passed,
    false,
  );
});
