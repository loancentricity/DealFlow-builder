export function invalid(message, status = 400) {
  return Object.assign(new Error(message), { status });
}
export function validateName(name) {
  if (typeof name !== "string" || !name.trim() || name.trim().length > 80)
    throw invalid("Use a project name between 1 and 80 characters.");
  return name.trim();
}
export function validateFile(file) {
  if (
    !file ||
    typeof file.path !== "string" ||
    !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\.(html|css|js)$/.test(file.path)
  )
    throw invalid(
      "Only safe relative HTML, CSS and JavaScript paths are supported.",
    );
  if (
    typeof file.content !== "string" ||
    Buffer.byteLength(file.content, "utf8") > 200000
  )
    throw invalid("Source files must be text and no larger than 200 KB.");
  if (!Number.isSafeInteger(file.version) || file.version < 1)
    throw invalid("A current file version is required.");
  return file;
}
export const starterFiles = [
  {
    path: "index.html",
    content:
      '<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>My first project</title>\n  <link rel="stylesheet" href="styles.css">\n</head>\n<body>\n  <main>\n    <span class="eyebrow">YOUR NEXT IDEA STARTS HERE</span>\n    <h1>Hello, builder.</h1>\n    <p>A small beginning. Room for something great.</p>\n    <button id="counter">Make it happen · 0</button>\n  </main>\n  <script src="app.js"></script>\n</body>\n</html>\n',
  },
  {
    path: "styles.css",
    content:
      "* { box-sizing: border-box; }\nbody { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #edf3fa; color: #0b1f3a; font-family: system-ui, sans-serif; padding: 32px; }\nmain { max-width: 620px; }\n.eyebrow { font-size: 11px; letter-spacing: .18em; font-weight: 700; color: #0057d9; }\nh1 { font-size: clamp(40px, 8vw, 76px); letter-spacing: -.06em; line-height: 1.05; margin: 24px 0; }\np { color: #475467; line-height: 1.7; }\nbutton { margin-top: 24px; border: 0; border-radius: 8px; background: #0057d9; color: white; padding: 16px 24px; font: inherit; cursor: pointer; }\nbutton:focus-visible { outline: 3px solid #c94a00; outline-offset: 4px; }\n",
  },
  {
    path: "app.js",
    content:
      'let count = 0;\nconst counter = document.querySelector("#counter");\ncounter.addEventListener("click", () => {\n  count += 1;\n  counter.textContent = `Make it happen · ${count}`;\n});\n',
  },
];
// Structural checks only. Project JavaScript is never evaluated in the control plane.
export function runStaticChecks(files) {
  const index = files.find((f) => f.path === "index.html");
  const refs = index
    ? [...index.content.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)].map(
        (m) => m[1],
      )
    : [];
  const local = refs.filter((r) => !/^(?:[a-z]+:|\/\/|#)/i.test(r));
  const checks = [
    {
      name: "Entry point",
      passed: Boolean(index?.content.trim()),
      detail: "A non-empty index.html is required.",
    },
    {
      name: "Viewport",
      passed: Boolean(
        index && /name\s*=\s*["']viewport["']/i.test(index.content),
      ),
      detail: "The entry point declares a viewport for mobile layouts.",
    },
    {
      name: "Local assets",
      passed: local.every((r) =>
        files.some((f) => f.path === r.replace(/^\.\//, "").split(/[?#]/)[0]),
      ),
      detail: "Referenced local assets exist in the project snapshot.",
    },
    {
      name: "Self-contained assets",
      passed: refs.every((r) => !/^(?:https?:|\/\/)/i.test(r)),
      detail: "Remote assets are unsupported and blocked by preview policy.",
    },
  ];
  return { passed: checks.every((c) => c.passed), checks };
}
