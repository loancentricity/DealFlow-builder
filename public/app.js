"use strict";
const $ = (id) => document.getElementById(id);
const state = {
  projects: [],
  project: null,
  path: null,
  buffers: new Map(),
  busy: false,
  loadToken: 0,
  previewUrl: null,
  syncEpoch: 0,
  polling: false,
  testKey: null,
};
function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}
function notice(message, error = false) {
  $("notice").textContent = message;
  $("notice").className = `notice${error ? " error" : ""}`;
  $("notice").hidden = !message;
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      typeof data.error === "string"
        ? data.error
        : `Request failed (${response.status}).`,
    );
    error.status = response.status;
    throw error;
  }
  return data;
}
function projectApi(suffix = "") {
  return `/api/projects/${encodeURIComponent(state.project.project.id)}${suffix}`;
}
function currentBuffer() {
  return state.buffers.get(state.path);
}
function hasDrafts() {
  return [...state.buffers.values()].some(
    (file) => file.content !== file.saved,
  );
}
function date(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf())
    ? "Time unavailable"
    : parsed.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}
function updateControls() {
  const running = Boolean(state.project?.preview?.running);
  const file = currentBuffer();
  $("save-file").disabled =
    state.busy || !file || file.content === file.saved || file.conflict;
  $("start-preview").disabled = state.busy || running;
  $("update-preview").disabled = state.busy || !running;
  $("stop-preview").disabled = state.busy || !running;
  $("run-tests").disabled = state.busy;
  $("refresh-project").disabled = state.busy;
  $("load-latest").disabled = state.busy;
  $("save-state").textContent = file
    ? file.conflict
      ? "Conflict · draft preserved"
      : file.content !== file.saved
        ? "Unsaved changes"
        : `Saved · version ${file.version}`
    : "";
  $("conflict").hidden = !file?.conflict;
}
async function operation(callback) {
  if (state.busy) return;
  state.syncEpoch++;
  state.busy = true;
  updateControls();
  try {
    await callback();
  } catch (error) {
    notice(error.message, true);
  } finally {
    state.busy = false;
    updateControls();
  }
}
async function loadProjects() {
  const { projects } = await api("/api/projects");
  state.projects = projects;
  renderProjects();
}
function renderProjects() {
  $("project-count").textContent = state.projects.length;
  $("library-caption").textContent =
    `${state.projects.length} ${state.projects.length === 1 ? "project" : "projects"}`;
  $("project-nav").replaceChildren();
  $("project-grid").replaceChildren();
  if (!state.projects.length) {
    $("project-nav").append(
      element("p", "nav-empty", "Your next idea starts here."),
    );
    const empty = element("div", "empty-card");
    empty.append(
      element("h3", "", "A clean slate. A working starter."),
      element(
        "p",
        "",
        "Create your first project to start editing and previewing your work.",
      ),
    );
    const button = element(
      "button",
      "secondary",
      "+ Create your first project",
    );
    button.addEventListener("click", showCreate);
    empty.append(button);
    $("project-grid").append(empty);
  }
  for (const project of state.projects) {
    const nav = element(
      "button",
      `project-link${state.project?.project.id === project.id ? " selected" : ""}`,
      project.name,
    );
    nav.addEventListener("click", () => openProject(project.id));
    $("project-nav").append(nav);
    const card = element("button", "project-card");
    const top = element("div", "card-top");
    top.append(
      element("span", "project-symbol", "</>"),
      element("span", "card-type", "STATIC STARTER"),
    );
    card.append(
      top,
      element("h3", "", project.name),
      element("p", "", `Edited ${date(project.updated_at)}`),
      element("span", "card-arrow", "Open workspace ↗"),
    );
    card.addEventListener("click", () => openProject(project.id));
    $("project-grid").append(card);
  }
}
function showCreate() {
  $("create-error").hidden = true;
  $("create-dialog").showModal();
  $("project-name").focus();
}
function showDashboard() {
  if (state.busy) return;
  state.syncEpoch++;
  $("dashboard").hidden = false;
  $("workspace").hidden = true;
  $("breadcrumb-name").textContent = "Projects";
  history.replaceState(null, "", location.pathname);
  notice("");
  loadProjects().catch((error) => notice(error.message, true));
}
async function openProject(id) {
  if (state.busy) return;
  if (
    state.project?.project.id !== id &&
    hasDrafts() &&
    !confirm(
      "You have unsaved changes. Discard those drafts and open another project?",
    )
  )
    return;
  state.syncEpoch++;
  const token = ++state.loadToken;
  notice("Opening project…");
  try {
    const data = await api(`/api/projects/${encodeURIComponent(id)}`);
    if (token !== state.loadToken) return;
    if (state.project?.project.id !== id) {
      state.buffers.clear();
      state.path = null;
      state.testKey = null;
    }
    state.project = data;
    syncBuffers(data.files);
    renderWorkspace();
    $("dashboard").hidden = true;
    $("workspace").hidden = false;
    history.replaceState(null, "", `#project=${encodeURIComponent(id)}`);
    notice("");
  } catch (error) {
    if (token === state.loadToken) notice(error.message, true);
  }
}
function syncBuffers(files) {
  for (const file of files) {
    const buffer = state.buffers.get(file.path);
    if (!buffer || buffer.content === buffer.saved)
      state.buffers.set(file.path, {
        ...file,
        saved: file.content,
        conflict: false,
      });
    else if (buffer.version !== file.version) buffer.conflict = true;
  }
  if (!state.path) state.path = files[0]?.path || null;
}
async function refreshProject() {
  const data = await api(projectApi());
  state.project = data;
  syncBuffers(data.files);
  renderWorkspace();
}
function renderWorkspace() {
  $("project-title").textContent = state.project.project.name;
  $("breadcrumb-name").textContent = state.project.project.name;
  $("file-count").textContent = state.project.files.length;
  $("file-tree").replaceChildren();
  for (const file of state.project.files) {
    const button = element(
      "button",
      `file-button${state.path === file.path ? " selected" : ""}`,
      file.path,
    );
    button.setAttribute(
      "aria-current",
      state.path === file.path ? "true" : "false",
    );
    button.addEventListener("click", () => {
      state.path = file.path;
      renderWorkspace();
    });
    $("file-tree").append(button);
  }
  const buffer = currentBuffer();
  $("editor-path").textContent = state.path || "Choose a file";
  if ($("code-editor").value !== (buffer?.content || ""))
    $("code-editor").value = buffer?.content || "";
  $("code-editor").disabled = !buffer;
  renderPreview();
  $("agent-reason").textContent =
    state.project.agent?.reason ||
    "Connect an agent provider and isolated worker to enable coordinated execution.";
  renderEvents();
  restoreTestResults();
  renderProjects();
  updateControls();
}
function renderPreview() {
  const preview = state.project.preview;
  const running = Boolean(
    !preview?.unavailable && preview?.running && preview.url,
  );
  $("preview-status").textContent = preview?.unavailable
    ? "Unavailable"
    : running
      ? "Running"
      : "Stopped";
  $("preview-dot").classList.toggle("live", running);
  $("preview-empty").querySelector("h3").textContent = preview?.unavailable
    ? "Preview unavailable."
    : "Your work, running.";
  $("preview-empty").querySelector("p").textContent = preview?.unavailable
    ? preview.reason ||
      "The preview worker could not be reached. Your saved source is still available."
    : "Start a preview to see the saved version of your project.";
  $("preview-frame").hidden = !running;
  $("preview-empty").hidden = running;
  if (running && state.previewUrl !== preview.url) {
    $("preview-frame").src = preview.url;
    state.previewUrl = preview.url;
  }
  if (!running) {
    $("preview-frame").removeAttribute("src");
    state.previewUrl = null;
  }
}
function renderTestResult(result) {
  $("test-results").replaceChildren(
    element(
      "p",
      "",
      result.passed ? "All checks passed." : "Some checks failed.",
    ),
  );
  for (const check of result.checks) {
    const row = element("div", `check${check.passed ? "" : " failed"}`);
    row.append(
      element("strong", "", `${check.passed ? "✓" : "×"} ${check.name}`),
      element("small", "", check.detail),
    );
    $("test-results").append(row);
  }
}
function restoreTestResults() {
  const task = (state.project.tasks || [])
    .filter(
      (item) =>
        item.kind === "static-checks" && Array.isArray(item.result?.checks),
    )
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
  const key = task
    ? `${task.id}:${task.completed_at || task.created_at}`
    : "none";
  if (state.testKey === key) return;
  state.testKey = key;
  if (task) {
    renderTestResult(task.result);
    $("test-results").prepend(
      element(
        "p",
        "muted",
        `Last recorded run · ${date(task.completed_at || task.created_at)}`,
      ),
    );
  } else
    $("test-results").replaceChildren(
      element("p", "muted", "No recorded checks yet."),
    );
}
function renderEvents() {
  $("activity-list").replaceChildren();
  if (!state.project.events.length) {
    const li = element("li");
    li.append(element("span", "muted", "No recorded activity yet."));
    $("activity-list").append(li);
  }
  for (const event of state.project.events) {
    const li = element("li");
    const body = element("div");
    body.append(
      element(
        "span",
        "event-title",
        event.type
          .replaceAll("_", " ")
          .toLowerCase()
          .replace(/^./, (c) => c.toUpperCase()),
      ),
    );
    const detail =
      typeof event.detail === "string"
        ? event.detail
        : [
            event.detail?.message,
            event.detail?.path,
            event.detail?.version !== undefined
              ? `Version ${event.detail.version}`
              : null,
          ]
            .filter(Boolean)
            .join(" · ");
    if (detail) body.append(element("span", "event-detail", detail));
    body.append(element("time", "event-time", date(event.created_at)));
    li.append(element("span", "event-marker"), body);
    $("activity-list").append(li);
  }
}
async function saveFile() {
  const buffer = currentBuffer();
  if (!buffer || $("save-file").disabled) return;
  const path = state.path;
  const content = buffer.content;
  const version = buffer.version;
  await operation(async () => {
    try {
      const { file } = await api(projectApi("/files"), {
        method: "PUT",
        body: JSON.stringify({ path, content, version }),
      });
      buffer.saved = file.content;
      buffer.version = file.version;
      buffer.conflict = false;
      await refreshProject();
      notice("File saved. Update your preview to see the change.");
    } catch (error) {
      if (error.status === 409) {
        buffer.conflict = true;
        updateControls();
      }
      throw error;
    }
  });
}
async function previewAction(action) {
  await operation(async () => {
    notice(
      action === "stop" ? "Stopping preview…" : "Preparing isolated preview…",
    );
    const { preview } = await api(projectApi("/preview"), {
      method: "POST",
      body: JSON.stringify({ action }),
    });
    state.project.preview = preview;
    if (action === "update" && preview?.url) {
      state.previewUrl = null;
      $("preview-frame").removeAttribute("src");
    }
    renderWorkspace();
    await refreshProject();
    notice(
      action === "stop"
        ? "Preview stopped."
        : action === "update"
          ? "Preview updated with saved files."
          : "Preview is running in an isolated static runtime.",
    );
  });
}
$("code-editor").addEventListener("input", () => {
  const buffer = currentBuffer();
  if (buffer) buffer.content = $("code-editor").value;
  updateControls();
});
$("code-editor").addEventListener("keydown", (event) => {
  if (event.key === "Tab" && !event.shiftKey) {
    event.preventDefault();
    const editor = event.target;
    editor.setRangeText(
      "  ",
      editor.selectionStart,
      editor.selectionEnd,
      "end",
    );
    editor.dispatchEvent(new Event("input"));
  }
});
$("editor-help").textContent = "Tab to indent · Shift+Tab to leave editor";
document.addEventListener("keydown", (event) => {
  if (
    (event.ctrlKey || event.metaKey) &&
    event.key.toLowerCase() === "s" &&
    !$("workspace").hidden
  ) {
    event.preventDefault();
    saveFile();
  }
});
window.addEventListener("beforeunload", (event) => {
  if (hasDrafts()) {
    event.preventDefault();
    event.returnValue = "";
  }
});
for (const id of ["new-project", "sidebar-create", "use-starter"])
  $(id).addEventListener("click", showCreate);
for (const id of ["dashboard-button", "back-projects"])
  $(id).addEventListener("click", showDashboard);
$("close-dialog").addEventListener("click", () => $("create-dialog").close());
$("create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = $("project-name").value.trim();
  if (!name) {
    $("project-name").setCustomValidity("Enter a project name.");
    $("project-name").reportValidity();
    return;
  }
  $("create-submit").disabled = true;
  $("create-submit").textContent = "Creating project…";
  $("create-error").hidden = true;
  try {
    const { project } = await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    $("create-dialog").close();
    $("project-name").value = "";
    await loadProjects();
    await openProject(project.id);
  } catch (error) {
    $("create-error").textContent = error.message;
    $("create-error").hidden = false;
  } finally {
    $("create-submit").disabled = false;
    $("create-submit").textContent = "Create project →";
  }
});
$("project-name").addEventListener("input", () =>
  $("project-name").setCustomValidity(""),
);
$("save-file").addEventListener("click", saveFile);
for (const action of ["start", "update", "stop"])
  $(`${action}-preview`).addEventListener("click", () => previewAction(action));
$("refresh-project").addEventListener("click", () =>
  operation(async () => {
    await refreshProject();
    notice("Project refreshed. Unsaved drafts are preserved.");
  }),
);
$("load-latest").addEventListener("click", () => {
  if (
    !confirm(
      "Replace this draft with the latest saved file? Copy any changes you want to keep before continuing.",
    )
  )
    return;
  operation(async () => {
    const path = state.path;
    const data = await api(projectApi());
    const file = data.files.find((item) => item.path === path);
    if (file)
      state.buffers.set(path, {
        ...file,
        saved: file.content,
        conflict: false,
      });
    state.project = data;
    syncBuffers(data.files);
    renderWorkspace();
    notice("Latest saved version loaded.");
  });
});
$("run-tests").addEventListener("click", () =>
  operation(async () => {
    $("test-results").replaceChildren(
      element("p", "muted", "Running starter checks…"),
    );
    try {
      const { result } = await api(projectApi("/tests"), {
        method: "POST",
        body: "{}",
      });
      renderTestResult(result);
      await refreshProject();
      notice(
        result.passed
          ? "Starter checks passed and were recorded."
          : "Starter checks found issues. Review the results.",
        !result.passed,
      );
    } catch (error) {
      $("test-results").replaceChildren(
        element("p", "form-error", `Checks could not run: ${error.message}`),
      );
      throw error;
    }
  }),
);
async function initialize() {
  const results = await Promise.allSettled([
    api("/api/health"),
    loadProjects(),
  ]);
  $("health-label").textContent =
    results[0].status === "fulfilled"
      ? "Control plane online"
      : "Connection unavailable";
  $("health-dot").classList.toggle("live", results[0].status === "fulfilled");
  if (results[1].status === "rejected") {
    $("project-grid").replaceChildren(
      element(
        "div",
        "empty-card",
        "Projects could not be loaded. Check the server connection and reload this page.",
      ),
    );
    $("project-nav").replaceChildren(
      element("p", "nav-empty", "Projects unavailable"),
    );
    $("library-caption").textContent = "Unavailable";
    notice(results[1].reason.message, true);
    return;
  }
  if (location.hash.startsWith("#project=")) {
    let id;
    try {
      id = decodeURIComponent(location.hash.slice(9));
    } catch {
      notice("The project address is invalid.", true);
      return;
    }
    await openProject(id);
  }
}
initialize();
// Poll only lifecycle and durable activity: never replace a focused editor or its drafts.
setInterval(async () => {
  if (
    document.hidden ||
    $("workspace").hidden ||
    !state.project ||
    state.busy ||
    state.polling
  )
    return;
  const id = state.project.project.id;
  const epoch = state.syncEpoch;
  const token = state.loadToken;
  const stillCurrent = () =>
    !state.busy &&
    !document.hidden &&
    !$("workspace").hidden &&
    state.project?.project.id === id &&
    state.syncEpoch === epoch &&
    state.loadToken === token;
  state.polling = true;
  try {
    const data = await api(`/api/projects/${encodeURIComponent(id)}`);
    if (!stillCurrent()) return;
    state.project.preview = data.preview;
    state.project.tasks = data.tasks;
    state.project.events = data.events;
    renderPreview();
    restoreTestResults();
    renderEvents();
    updateControls();
    $("health-label").textContent = "Control plane online";
    $("health-dot").classList.add("live");
  } catch (error) {
    if (!stillCurrent()) return;
    state.project.preview = {
      running: false,
      unavailable: true,
      reason: `Preview status could not be refreshed: ${error.message}`,
    };
    renderPreview();
    updateControls();
    $("health-label").textContent = "Connection unavailable";
    $("health-dot").classList.remove("live");
  } finally {
    state.polling = false;
  }
}, 15000);
