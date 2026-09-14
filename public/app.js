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
  prompts: new Map(),
  buildKey: null,
  historyProjectId: null,
  lastPoll: 0,
  tool: "library",
  toolKey: null,
  importing: false,
  providers: new Map(),
  providerKey: null,
  attachmentSelections: new Map(),
  uploads: new Map(),
  attachmentKey: null,
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
  const active = activeBuild();
  const building = active && ["queued", "running"].includes(active.status);
  const selectedProvider = (state.project?.agent?.providers || []).find(provider => provider.id === $("build-provider").value);
  const uploading = [...state.uploads.values()].some(upload => upload.projectId === state.project?.project.id && upload.status === 'uploading');
  $("request-build").disabled = state.busy || Boolean(building) || uploading || selectedProvider?.available === false;
  $("request-build").textContent = building ? "Working on your message…" : uploading ? "Uploading attachments…" : "Send ↗";
  for (const id of ["apply-build", "cancel-build"]) if ($(id)) $(id).disabled = state.busy;
  if (active?.status === "review") for (const id of ["start-preview", "update-preview", "stop-preview"]) $(id).disabled = true;
  document.querySelectorAll('[data-restore-checkpoint]').forEach(button => { button.disabled = state.busy || Boolean(active); });
  $("delete-file").disabled = state.busy || !file;
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
      element("h3", "", "Every great project starts with an idea."),
      element(
        "p",
        "",
        "Describe your website, see it take shape, and make it your own.",
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
      element("span", "card-type", "WEBSITE"),
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
  renderLibrary();
}
function showCreate() {
  $("create-error").hidden = true;
  $("create-dialog").showModal();
  $("project-name").focus();
}
function showDashboard() {
  if (state.busy) return;
  state.syncEpoch++;
  document.body.classList.remove("workspace-open");
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
      state.buildKey = null;
      state.attachmentKey = null;
      $("attachment-errors").textContent = '';
      $("build-prompt").value = state.prompts.get(id) || "";
      setCodeVisible(false);
    }
    state.project = data;
    document.body.classList.add("workspace-open");
    syncBuffers(data.files);
    renderWorkspace();
    $("dashboard").hidden = true;
    $("workspace").hidden = false;
    history.replaceState(null, "", `#project=${encodeURIComponent(id)}`);
    notice("");
    if (!data.preview?.running && !data.preview?.unavailable && !activeBuild()) await previewAction("start");
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
  renderBuilds();
  renderTools();
  renderAttachments();
  restoreTestResults();
  renderProjects();
  updateControls();
}
function renderPreview() {
  const candidate = activeBuild();
  const preview = candidate?.status === "review" && candidate.preview_url ? { running: true, url: candidate.preview_url } : state.project.preview;
  const running = Boolean(
    !preview?.unavailable && preview?.running && preview.url,
  );
  $("preview-status").textContent = preview?.unavailable
    ? "Unavailable"
    : candidate?.status === "review" && candidate.preview_url ? "Latest version" : running
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
  $("version-label").textContent = (state.project.builds || []).some((build) => build.status === "applied") ? "Your saved version" : "Starter · ready for your idea";
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
    const brief = $("project-brief").value.trim();
    const { project } = await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    $("create-dialog").close();
    $("project-name").value = "";
    $("project-brief").value = "";
    if (brief) state.prompts.set(project.id, brief);
    await loadProjects();
    await openProject(project.id);
    if (brief && state.project?.project.id === project.id) await requestBuild();
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
    api("/api/agent"),
  ]);
  $("health-label").textContent =
    results[0].status === "fulfilled"
      ? "Control plane online"
      : "Connection unavailable";
  $("health-dot").classList.toggle("live", results[0].status === "fulfilled");
  if (results[2].status === "fulfilled") renderAvailability(results[2].value);
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
  const active = activeBuild();
  const delay = active && ["queued", "running"].includes(active.status) ? 2000 : 15000;
  if (Date.now() - state.lastPoll < delay) return;
  state.lastPoll = Date.now();
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
    state.project.builds = data.builds;
    state.project.agent = data.agent;
    state.project.checkpoints = data.checkpoints;
    state.project.storage = data.storage;
    state.project.attachments = data.attachments;
    renderPreview();
    renderBuilds();
    renderTools();
    renderAttachments();
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
}, 2000);

function activeBuild() {
  return (state.project?.builds || []).find((build) => ["queued", "running", "review"].includes(build.status));
}
function setCodeVisible(visible) {
  if (visible) openTool("files");
  else if (state.tool === "files") openTool("library");
  $("toggle-code").textContent = visible ? "Hide code" : "Code";
  $("toggle-code").setAttribute("aria-expanded", String(visible));
}
$("toggle-code").addEventListener("click", () => setCodeVisible($("toggle-code").getAttribute("aria-expanded") !== "true"));
$("build-prompt").addEventListener("input", () => { if (state.project) state.prompts.set(state.project.project.id, $("build-prompt").value); });
$("build-form").addEventListener("submit", (event) => { event.preventDefault(); requestBuild(); });
const editGuides = {
  add: ["What feature or page should we add?", "Add a page that explains the service and lets visitors start the readiness flow."],
  change: ["What should look or read differently?", "Change the homepage colors and make the main message easier to understand."],
  modify: ["Which existing step or behavior should change?", "Modify the transfer flow so people can go back and edit their selection before confirming."],
  improve: ["What should work better for your users?", "Improve the mobile layout and make the next step clearer on every screen."],
};
document.querySelectorAll("[data-edit-action]").forEach(button => button.addEventListener("click", () => {
  const [guidance, example] = editGuides[button.dataset.editAction];
  document.querySelectorAll("[data-edit-action]").forEach(item => item.setAttribute("aria-pressed", String(item === button)));
  $("edit-guidance").textContent = guidance;
  $("build-prompt").placeholder = example;
  $("build-prompt").focus();
}));
function renderAvailability(agent) {
  renderProviders(agent);
  const available = Boolean(agent?.available);
  $("builder-status").textContent = available ? "Builder connected" : "Builder not connected";
  $("builder-dot").classList.toggle("live", available);
  $("builder-reason").textContent = available ? "Ready to turn your requests into a version you can review." : agent?.reason || "The builder is unavailable. Your idea will stay here so you can try again when it connects.";
  $("agent-status").textContent = available ? "Connected" : "Unavailable";
  $("agent-reason").textContent = agent?.reason || (available ? agent.name || "Builder connected." : "No builder is connected.");
}
function renderBuilds() {
  renderAvailability(state.project.agent);
  const builds = state.project.builds || [];
  const job = builds.find(build => ["queued", "running"].includes(build.status));
  let progress = $("build-progress");
  if (!progress) {
    progress = element("section", "build-progress"); progress.id = "build-progress";
    progress.setAttribute("role", "status"); progress.setAttribute("aria-live", "polite");
    $("build-current").before(progress);
  }
  progress.hidden = !job;
  if (job) {
    const latestEvent = (state.project.events || []).find(event => event.task_id === job.task_id && ["GENERATION_STARTED", "REVIEW_STARTED", "REPAIR_STARTED"].includes(event.type));
    const stages = { GENERATION_STARTED: "Creating your website", REVIEW_STARTED: "Reviewing the generated files", REPAIR_STARTED: "Correcting issues found in review" };
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(job.created_at).getTime()) / 1000));
    progress.replaceChildren(element("span", "build-spinner", ""), element("strong", "", stages[latestEvent?.type] || (job.status === "queued" ? "Waiting for the builder" : "Build in progress")), element("span", "", `${Math.floor(seconds / 60)}m ${seconds % 60}s elapsed`));
  }
  const key = JSON.stringify(builds);
  if (state.buildKey === key) return;
  state.buildKey = key;
  const active = activeBuild();
  const latest = active || builds[0];
  const current = $("build-current"); current.replaceChildren(); current.hidden = !latest;
  current.classList.toggle("completed", Boolean(latest && ["review", "applied", "cancelled"].includes(latest.status)));
  const labels = { queued: "Request queued", running: "Building", review: "Preview updated", applied: "Saved", failed: "Build failed", cancelled: "Cancelled" };
  if (latest) {
    current.append(element("span", `build-state ${latest.status}`, labels[latest.status] || latest.status));
    if (latest.error) current.append(element("p", "form-error", buildFailureMessage(latest)));
    if (latest.status === "failed") {
      notice(buildFailureMessage(latest), true);
      const retry = element("button", "secondary full", "Edit and try again");
      retry.addEventListener("click", () => {
        const draft = $("build-prompt").value.trim();
        if (draft && draft !== latest.prompt && !confirm("Replace your current idea draft with this request?")) return;
        $("build-prompt").value = latest.prompt;
        state.prompts.set(state.project.project.id, latest.prompt);
        $("build-prompt").focus();
        notice("Your request is ready to edit. Choose Build my idea when you want to try again.");
      });
      current.append(retry);
    }
    if (["queued", "running"].includes(latest.status)) current.append(element("p", "", latest.status === "queued" ? "Your request is saved and waiting for the builder." : "The builder is working on your request. The result will appear here when it is ready."));
    const checks = Array.isArray(latest.checks) ? latest.checks : latest.checks?.checks;
    if (checks?.length) {
      const details = element("details", "build-checks"); details.append(element("summary", "", `${checks.filter((check) => check.passed).length} of ${checks.length} checks passed`));
      for (const check of checks) details.append(element("p", "", `${check.passed ? "✓" : "×"} ${check.name}${check.detail ? ` — ${check.detail}` : ""}`));
      current.append(details);
    }
    const review = typeof latest.review === "string" ? latest.review : latest.review?.summary;
    if (review) current.append(element("p", "", review));
    if (latest.status === "review") {
      current.append(element("p", "", "Try your latest preview. Send another message to keep building from here."));
    }
    if (["queued", "running", "review"].includes(latest.status)) {
      const cancel = element("button", "text-button discard-button", latest.status === "review" ? "Discard version" : "Cancel build"); cancel.id = "cancel-build"; cancel.addEventListener("click", () => decideBuild(latest, "cancel")); current.append(cancel);
    }
  }
  const history = $("build-history");
  const firstOpen = state.historyProjectId !== state.project.project.id;
  const previousScroll = history.scrollTop;
  const nearBottom = history.scrollHeight - previousScroll - history.clientHeight < 80;
  const expandedMessages = new Set([...history.querySelectorAll('details[open][data-message-id]')].map(detail => detail.dataset.messageId));
  state.historyProjectId = state.project.project.id;
  history.replaceChildren();
  if (!builds.length) { const welcome = element("div", "conversation-welcome"); welcome.append(element("span", "", "✧"), element("h3", "", "What will you make?"), element("p", "", "Describe your idea below. Your messages, changes, and results will stay together here.")); history.append(welcome); }
  for (const build of [...builds].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))) {
    const message = element("article", "chat-message user-message"); message.append(element("strong", "message-author", "You"));
    if (build.prompt.length > 500) {
      const fullMessage = element("details", "long-message"); fullMessage.dataset.messageId = build.id;
      fullMessage.open = expandedMessages.has(build.id);
      const summary = element("summary"); summary.append(element("span", "message-excerpt", `${build.prompt.slice(0, 220).trim()}…`), element("span", "message-expand-label", "Read full message"));
      fullMessage.append(summary, element("p", "full-message-text", build.prompt)); message.append(fullMessage);
      fullMessage.addEventListener("toggle", () => { summary.querySelector('.message-expand-label').textContent = fullMessage.open ? 'Collapse message' : 'Read full message'; });
    } else message.append(element("p", "", build.prompt));
    message.append(element("time", "", date(build.created_at))); history.append(message);
    if (build.summary || build.error || ["queued", "running", "cancelled"].includes(build.status)) {
      const reply = element("article", `chat-message assistant-message ${build.status}`); reply.append(element("strong", "message-author", "✧ DealFlow"));
      reply.append(element("p", "", build.error ? buildFailureMessage(build) : build.summary || (build.status === "queued" ? "Your request is saved and waiting for the builder." : build.status === "running" ? "The builder is working on this request." : "This request was cancelled.")));
      reply.append(element("span", "message-status", labels[build.status] || build.status)); history.append(reply);
    }
  }
  if (firstOpen) {
    const projectId = state.project.project.id;
    requestAnimationFrame(() => { if (state.project?.project.id === projectId) history.scrollTop = history.scrollHeight; });
  } else history.scrollTop = nearBottom ? history.scrollHeight : previousScroll;
}
async function requestBuild() {
  if (state.busy || ["queued", "running"].includes(activeBuild()?.status)) return;
  const prompt = $("build-prompt").value.trim();
  if (!prompt) { notice('Add a message telling the builder what you would like it to do with your project or attached ZIPs.'); $("build-prompt").focus(); return; }
  if ([...state.uploads.values()].some(upload => upload.projectId === state.project.project.id && upload.status === 'uploading')) { notice('Wait for your ZIP uploads to finish before sending the message.'); return; }
  await operation(async () => {
    notice("Sending your idea to the builder…");
    try {
      const candidate = activeBuild();
      if (candidate?.status === "review") {
        if (hasDrafts()) throw new Error("Save or resolve your code edits before continuing from this preview.");
        const agent = await api("/api/agent");
        if (!agent.available) throw new Error(agent.reason || "The builder is unavailable.");
        await api(projectApi(`/builds/${encodeURIComponent(candidate.id)}/apply`), { method: "POST", body: "{}" });
        state.buffers.clear(); state.path = null;
        await refreshProject();
      }
      const provider = $("build-provider").value || "openai";
      const providerStatus = (state.project.agent?.providers || []).find(item => item.id === provider);
      if (providerStatus?.available === false) throw new Error(providerStatus.reason || `${providerStatus.name} is not configured.`);
      const selected = state.attachmentSelections.get(state.project.project.id) || new Set();
      const attachment_ids = [...selected];
      const { build } = await api(projectApi("/builds"), { method: "POST", body: JSON.stringify({ prompt, provider, attachment_ids }) });
      state.project.builds = [build, ...(state.project.builds || [])];
      $("build-prompt").value = ""; state.prompts.delete(state.project.project.id);
      renderBuilds(); await refreshProject(); state.lastPoll = 0;
      const latest = (state.project.builds || []).find((item) => item.id === build.id) || build;
      if (latest.status === "failed") notice(buildFailureMessage(latest), true);
      else if (latest.status === "review") notice("Your preview is updated. Send your next message to continue.");
      else notice("Your request is saved. The builder's progress and result will appear below.");
    } catch (error) { notice(`${error.message} Your idea is preserved below.`, true); }
  });
}
function buildFailureMessage(build) {
  const error = typeof build.error === "string" ? build.error : "";
  if (/credit_balance_exhausted|insufficient_quota|credit balance/i.test(error)) return "The builder's AI account has no available credits. Your request is saved, but the build could not finish. Credits must be restored before trying again.";
  return error || "The builder could not finish this request. Your request is saved so you can edit it and try again.";
}
async function decideBuild(build, action) {
  if (action === "apply" && hasDrafts() && !confirm("You have unsaved code edits. Save this generated version and discard those code drafts?")) return;
  await operation(async () => {
    const data = await api(projectApi(`/builds/${encodeURIComponent(build.id)}/${action}`), { method: "POST", body: "{}" });
    if (action === "apply") { state.buffers.clear(); state.path = null; state.previewUrl = null; if (data.preview) state.project.preview = data.preview; }
    await refreshProject();
    notice(action === "apply" ? "Version saved. You can download it or create a checkpoint now." : "Version discarded. Your saved website is unchanged.");
  });
}

// Workspace tools reuse the same editor and durable project state.
for (const selector of ['.files-panel', '.editor-panel']) {
  const panel = document.querySelector(selector); panel.hidden = false; $('source-tool-host').append(panel);
}
$('activity-tool-host').append(document.querySelector('.project-details'));
$('agent-tool-host').append(document.querySelector('.agent-panel'));
document.body.dataset.mobilePanel = 'preview';
function openTool(tool) {
  state.tool = tool;
  document.querySelectorAll('[data-tool]').forEach(button => {
    const selected = button.dataset.tool === tool;
    button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
    $(`tool-${button.dataset.tool}`).hidden = !selected;
  });
  $('toggle-code').textContent = tool === 'files' ? 'Hide code' : 'Code';
  $('toggle-code').setAttribute('aria-expanded', String(tool === 'files'));
  if (matchMedia('(max-width: 800px)').matches) setMobileView('tools');
  if (tool === 'connections') loadConnections();
}
function setMobileView(view) {
  document.body.dataset.mobilePanel = view;
  document.querySelectorAll('[data-mobile-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mobileView === view)));
}
document.querySelectorAll('[data-mobile-view]').forEach(button => button.addEventListener('click', () => setMobileView(button.dataset.mobileView)));
document.querySelectorAll('[data-tool]').forEach(button => {
  button.addEventListener('click', () => openTool(button.dataset.tool));
  button.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const buttons = [...document.querySelectorAll('[data-tool]')];
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (buttons.indexOf(button) + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    openTool(buttons[index].dataset.tool); buttons[index].focus();
  });
});
$('publish-project').addEventListener('click', () => openTool('publish'));
$('library-search').addEventListener('input', renderLibrary);
function renderLibrary() {
  const list = $('tool-project-list'); if (!list) return;
  const query = $('library-search').value.trim().toLowerCase();
  const projects = state.projects.filter(project => project.name.toLowerCase().includes(query));
  list.replaceChildren();
  for (const project of projects) {
    const button = element('button', `library-project${project.id === state.project?.project.id ? ' selected' : ''}`);
    button.append(element('span', 'library-icon', '◇'), element('span', '', project.name));
    button.addEventListener('click', () => openProject(project.id)); list.append(button);
  }
  if (!projects.length) list.append(element('p', 'muted', query ? 'No matching projects.' : 'No projects yet.'));
}
function renderTools() {
  if (!state.project) return;
  const storage = state.project.storage;
  $('storage-summary').textContent = storage ? `${storage.file_count} files · ${Number(storage.bytes || 0).toLocaleString()} bytes` : `${state.project.files.length} files`;
  $('download-project').href = projectApi('/export');
  renderSavePreview();
  if (document.activeElement !== $('rename-name')) $('rename-name').value = state.project.project.name;
  const checkpoints = state.project.checkpoints || [];
  const key = JSON.stringify([state.project.project.id, checkpoints, Boolean(activeBuild())]);
  if (state.toolKey === key) return;
  state.toolKey = key; $('checkpoint-list').replaceChildren();
  if (!checkpoints.length) $('checkpoint-list').append(element('p', 'muted', 'No checkpoints yet. Save your first one above.'));
  for (const checkpoint of checkpoints) {
    const item = element('article', 'checkpoint-item'); item.append(element('strong', '', checkpoint.label), element('span', '', `${checkpoint.file_count} files · ${date(checkpoint.created_at)}`));
    const restore = element('button', 'secondary compact', 'Restore'); restore.dataset.restoreCheckpoint = checkpoint.id; restore.disabled = Boolean(activeBuild()) || state.busy;
    restore.title = activeBuild() ? 'Finish or cancel the active build before restoring.' : `Restore ${checkpoint.label}`;
    restore.addEventListener('click', () => restoreCheckpoint(checkpoint)); item.append(restore); $('checkpoint-list').append(item);
  }
}
$('rename-form').addEventListener('submit', event => {
  event.preventDefault(); const name = $('rename-name').value.trim(); if (!name) return;
  operation(async () => { await api(projectApi(), { method: 'PATCH', body: JSON.stringify({ name }) }); await refreshProject(); await loadProjects(); notice('Project renamed.'); });
});
$('duplicate-form').addEventListener('submit', async event => {
  event.preventDefault(); const name = $('duplicate-name').value.trim(); if (!name) return;
  let copy;
  await operation(async () => { const data = await api(projectApi('/duplicate'), { method: 'POST', body: JSON.stringify({ name }) }); copy = data.project; $('duplicate-name').value = ''; await loadProjects(); notice(`Created ${copy.name}.`); });
  if (copy) await openProject(copy.id);
});
$('add-file-form').addEventListener('submit', event => {
  event.preventDefault(); const path = $('new-file-path').value.trim(); if (!path) return;
  operation(async () => { const { file } = await api(projectApi('/files'), { method: 'POST', body: JSON.stringify({ path, content: '' }) }); state.path = file.path; $('new-file-path').value = ''; await refreshProject(); notice(`Created ${file.path}.`); });
});
$('delete-file').addEventListener('click', () => {
  const file = currentBuffer(); if (!file || state.busy) return;
  if (!confirm(`Delete ${state.path}?${file.content !== file.saved ? ' Its unsaved draft will also be removed.' : ''} Save a checkpoint first if you may want it back.`)) return;
  operation(async () => { const path = state.path; await api(projectApi('/files'), { method: 'DELETE', body: JSON.stringify({ path, version: file.version }) }); state.buffers.delete(path); state.path = null; await refreshProject(); notice(`Deleted ${path}.`); });
});
$('checkpoint-form').addEventListener('submit', event => {
  event.preventDefault(); const label = $('checkpoint-label').value.trim(); if (!label) return;
  operation(async () => { await api(projectApi('/checkpoints'), { method: 'POST', body: JSON.stringify({ label }) }); $('checkpoint-label').value = ''; await refreshProject(); notice('Checkpoint saved from your saved project files.'); });
});
async function restoreCheckpoint(checkpoint) {
  if (activeBuild() || state.busy) return;
  if (!confirm(`Restore checkpoint “${checkpoint.label}”? This replaces your current project files${hasDrafts() ? ' and discards your unsaved code drafts' : ''}.`)) return;
  await operation(async () => {
    const versions = Object.fromEntries(state.project.files.map(file => [file.path, file.version]));
    await api(projectApi(`/checkpoints/${encodeURIComponent(checkpoint.id)}/restore`), { method: 'POST', body: JSON.stringify({ versions }) });
    state.buffers.clear(); state.path = null; state.previewUrl = null; await refreshProject();
    try { await api(projectApi('/preview'), { method: 'POST', body: JSON.stringify({ action: state.project.preview?.running ? 'update' : 'start' }) }); await refreshProject(); notice(`Restored “${checkpoint.label}” and refreshed the preview.`); }
    catch (error) { notice(`Restored “${checkpoint.label}”. The preview could not restart: ${error.message}`, true); }
  });
}
async function loadConnections() {
  $('connections-list').replaceChildren(element('p', 'muted', 'Checking connections…'));
  try {
    const { connections } = await api('/api/connections'); $('connections-list').replaceChildren();
    if (!connections.length) $('connections-list').append(element('p', 'muted', 'No services are connected.'));
    for (const connection of connections) {
      const item = element('article', 'connection-item'); item.append(element('strong', '', connection.name), element('span', '', connection.status), element('p', 'muted', connection.detail)); $('connections-list').append(item);
    }
  } catch (error) { $('connections-list').replaceChildren(element('p', 'form-error', `Connections could not be checked: ${error.message}`)); }
}
$('refresh-connections').addEventListener('click', loadConnections);
$('import-project').addEventListener('click', () => $('import-zip').click());
$('import-zip').addEventListener('change', async () => {
  const file = $('import-zip').files[0]; if (!file || state.importing) return;
  state.importing = true; $('import-project').disabled = true; $('import-project').textContent = 'Importing…';
  try {
    const name = file.name.replace(/\.zip$/i, '').slice(0, 80) || 'Imported project';
    const { project, report } = await api('/api/import', { method: 'POST', body: file, headers: { 'Content-Type': 'application/zip', 'X-Project-Name': encodeURIComponent(name) } });
    await loadProjects(); await openProject(project.id);
    const warnings = report?.warnings || [];
    notice(`Imported ${project.name}.${warnings.length ? ` ${warnings.join(' ')}` : ' Your source is saved as an independent project.'}`);
  } catch (error) { notice(`Import failed: ${error.message}`, true); }
  finally { state.importing = false; $('import-project').disabled = false; $('import-project').textContent = 'Import ZIP'; $('import-zip').value = ''; }
});
function renderProviders(agent) {
  const providers = agent?.providers || [{ id: 'openai', name: 'OpenAI', available: Boolean(agent?.available), reason: agent?.reason }];
  const projectId = state.project?.project.id || 'dashboard';
  const choice = state.providers.get(projectId) || 'openai';
  const key = JSON.stringify([projectId, choice, providers]);
  if (state.providerKey === key) return;
  state.providerKey = key; $('build-provider').replaceChildren();
  for (const provider of providers) {
    const option = element('option', '', `${provider.name}${provider.model ? ` · ${provider.model}` : ''}${provider.available ? '' : ' · Not configured'}`);
    option.value = provider.id; option.disabled = !provider.available; option.selected = provider.id === choice;
    $('build-provider').append(option);
  }
  if (!providers.some(provider => provider.id === choice)) {
    const missing = element('option', '', `${choice} · Unavailable`); missing.value = choice; missing.disabled = true; missing.selected = true; $('build-provider').append(missing);
  }
  const selected = providers.find(provider => provider.id === choice);
  $('provider-reason').textContent = selected?.available ? '' : selected?.reason || 'This provider is not connected. Choose an available provider or check Connections.';
}
$('build-provider').addEventListener('change', () => {
  if (state.project) state.providers.set(state.project.project.id, $('build-provider').value);
  state.providerKey = null; renderProviders(state.project?.agent); updateControls();
});
function renderSavePreview() {
  let section = $('checkpoint-preview');
  if (!section) {
    section = element('section', 'checkpoint-preview'); section.id = 'checkpoint-preview';
    section.append(element('strong', '', 'Latest preview'), element('p', 'muted', 'Save this preview to your project before downloading it or making a checkpoint. You can also continue by sending another message.'));
    const save = element('button', 'primary compact', 'Save this version'); save.id = 'apply-build';
    save.addEventListener('click', () => { const candidate = activeBuild(); if (candidate?.status === 'review') decideBuild(candidate, 'apply'); });
    section.append(save); $('tool-checkpoints').prepend(section);
  }
  const candidate = activeBuild();
  section.hidden = candidate?.status !== 'review';
  $('apply-build').hidden = candidate?.status !== 'review';
  $('apply-build').disabled = state.busy || candidate?.status !== 'review';
}

const MAX_ATTACHMENT_BYTES = 250 * 1024 * 1024;
function attachmentSize(bytes) { return `${(Number(bytes) / (1024 * 1024)).toFixed(Number(bytes) < 1024 * 1024 ? 2 : 1)} MiB`; }
function attachmentError(message) { $('attachment-errors').append(element('p', 'form-error', message)); }
function renderAttachments() {
  if (!state.project) return;
  const projectId = state.project.project.id;
  const attachments = state.project.attachments || [];
  const selected = state.attachmentSelections.get(projectId) || new Set();
  state.attachmentSelections.set(projectId, selected);
  const key = JSON.stringify([projectId, attachments, [...selected]]);
  if (key !== state.attachmentKey) {
    state.attachmentKey = key;
    const list = $('attachment-list'); const scrollTop = list.scrollTop; list.replaceChildren();
    for (const attachment of attachments) {
      const card = element('article', 'attachment-card');
      const header = element('div', 'attachment-card-heading'); header.append(element('strong', '', attachment.name), element('span', '', attachmentSize(attachment.bytes)));
      const status = element('span', 'attachment-status', 'Stored with project');
      const label = element('label', 'attachment-selection');
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(attachment.id); checkbox.setAttribute('aria-label', `Use ${attachment.name} with message`);
      checkbox.addEventListener('change', () => { if (checkbox.checked) selected.add(attachment.id); else selected.delete(attachment.id); state.attachmentKey = JSON.stringify([projectId, state.project?.project.id === projectId ? state.project.attachments || [] : attachments, [...selected]]); });
      label.append(checkbox, element('span', '', 'Use with message')); card.append(header, status, label);
      if (attachment.download_url) { const link = element('a', 'attachment-download', 'Download'); link.href = attachment.download_url; link.download = attachment.name; card.append(link); }
      list.append(card);
    }
    list.scrollTop = scrollTop;
  }
  renderUploads();
}
function renderUploads() {
  const list = $('upload-list'); const scrollTop = list.scrollTop; list.replaceChildren();
  for (const upload of state.uploads.values()) {
    if (upload.projectId !== state.project?.project.id || upload.status === 'stored') continue;
    const card = element('article', 'upload-card'); card.dataset.uploadId = upload.id; card.append(element('strong', '', upload.name));
    if (upload.status === 'uploading') {
      const progress = document.createElement('progress'); progress.max = upload.bytes; progress.value = upload.loaded; progress.setAttribute('aria-label', `Uploading ${upload.name}`);
      const detail = upload.loaded >= upload.bytes ? 'Transfer complete · storing with project…' : `${attachmentSize(upload.loaded)} of ${attachmentSize(upload.bytes)} uploaded`;
      const cancel = element('button', 'text-button', 'Cancel upload'); cancel.type = 'button'; cancel.addEventListener('click', () => upload.xhr.abort());
      card.append(progress, element('span', 'upload-detail', detail), cancel);
    } else {
      card.append(element('span', upload.status === 'error' ? 'form-error' : '', upload.message));
      const dismiss = element('button', 'text-button', 'Dismiss'); dismiss.type = 'button'; dismiss.addEventListener('click', () => { state.uploads.delete(upload.id); renderUploads(); }); card.append(dismiss);
    }
    list.append(card);
  }
  list.scrollTop = scrollTop;
}
async function refreshAttachmentMetadata(projectId) {
  try {
    const data = await api(`/api/projects/${encodeURIComponent(projectId)}`);
    if (state.project?.project.id !== projectId) return;
    state.project.attachments = data.attachments || []; state.syncEpoch++; renderAttachments();
  } catch { /* Upload status remains visible; the ordinary project refresh can retry. */ }
}
function uploadAttachment(file) {
  if (!state.project) return;
  if (!/\.zip$/i.test(file.name)) { attachmentError(`${file.name}: choose a ZIP file. Zip folders before attaching them.`); return; }
  if (file.size > MAX_ATTACHMENT_BYTES) { attachmentError(`${file.name}: ZIP files must be 250 MiB or smaller.`); return; }
  if (!file.size) { attachmentError(`${file.name}: this file is empty. Choose a ZIP that contains your project.`); return; }
  const projectId = state.project.project.id; const xhr = new XMLHttpRequest();
  const upload = { id: crypto.randomUUID(), projectId, name: file.name, bytes: file.size, loaded: 0, status: 'uploading', xhr };
  state.uploads.set(upload.id, upload); renderUploads(); updateControls();
  const finishError = (message, status = 'error') => { upload.status = status; upload.message = message; renderUploads(); updateControls(); refreshAttachmentMetadata(projectId); };
  xhr.open('POST', `/api/projects/${encodeURIComponent(projectId)}/attachments`);
  xhr.setRequestHeader('Content-Type', 'application/zip'); xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
  xhr.responseType = 'json'; xhr.timeout = 10 * 60 * 1000;
  xhr.upload.addEventListener('progress', event => {
    upload.loaded = event.loaded;
    const card = [...$('upload-list').children].find(item => item.dataset.uploadId === upload.id);
    const progress = card?.querySelector('progress'); if (!progress) return;
    progress.value = upload.loaded;
    card.querySelector('.upload-detail').textContent = upload.loaded >= upload.bytes ? 'Transfer complete · storing with project…' : `${attachmentSize(upload.loaded)} of ${attachmentSize(upload.bytes)} uploaded`;
  });
  xhr.addEventListener('load', () => {
    const data = xhr.response || {};
    if (xhr.status < 200 || xhr.status >= 300) { finishError(typeof data.error === 'string' ? data.error : `Upload failed (${xhr.status}).`); return; }
    if (!data.attachment?.id) { finishError('The upload response was incomplete. Refresh the project to check whether the ZIP was stored.'); return; }
    upload.status = 'stored'; state.uploads.delete(upload.id);
    const selected = state.attachmentSelections.get(projectId) || new Set(); selected.add(data.attachment.id); state.attachmentSelections.set(projectId, selected);
    if (state.project?.project.id === projectId) { state.syncEpoch++; state.project.attachments = [data.attachment, ...(state.project.attachments || []).filter(item => item.id !== data.attachment.id)]; renderAttachments(); updateControls(); }
  });
  xhr.addEventListener('error', () => finishError('Upload failed because the connection was interrupted. Check your connection and try again.'));
  xhr.addEventListener('timeout', () => finishError('Upload timed out after 10 minutes. Check the stored attachments before trying again.'));
  xhr.addEventListener('abort', () => finishError('Upload cancelled. If the transfer already finished, its file may still appear below.', 'cancelled'));
  xhr.send(file);
}
$('attach-zip').addEventListener('click', () => $('attachment-picker').click());
$('attachment-picker').addEventListener('change', () => { $('attachment-errors').replaceChildren(); for (const file of $('attachment-picker').files) uploadAttachment(file); $('attachment-picker').value = ''; });
let attachmentDragDepth = 0;
function isFileDrag(event) { return [...(event.dataTransfer?.types || [])].includes('Files'); }
$('build-form').addEventListener('dragenter', event => { if (!isFileDrag(event)) return; event.preventDefault(); attachmentDragDepth++; $('build-form').classList.add('attachment-drop-active'); });
$('build-form').addEventListener('dragover', event => { if (!isFileDrag(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; });
$('build-form').addEventListener('dragleave', event => { if (!isFileDrag(event)) return; attachmentDragDepth = Math.max(0, attachmentDragDepth - 1); if (!attachmentDragDepth) $('build-form').classList.remove('attachment-drop-active'); });
$('build-form').addEventListener('drop', event => {
  if (!isFileDrag(event)) return;
  event.preventDefault(); attachmentDragDepth = 0; $('build-form').classList.remove('attachment-drop-active'); $('attachment-errors').replaceChildren();
  const items = [...(event.dataTransfer.items || [])].filter(item => item.kind === 'file');
  if (!items.length) { for (const file of event.dataTransfer.files) uploadAttachment(file); return; }
  for (const item of items) { const entry = item.webkitGetAsEntry?.(); if (entry?.isDirectory) { attachmentError(`${entry.name}: Zip the folder first.`); continue; } const file = item.getAsFile(); if (file) uploadAttachment(file); }
});
