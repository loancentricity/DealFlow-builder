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
  lastPoll: 0,
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
  $("request-build").disabled = state.busy || Boolean(building);
  $("request-build").textContent = building ? "Working on your message…" : "Send ↗";
  for (const id of ["apply-build", "cancel-build"]) if ($(id)) $(id).disabled = state.busy;
  if (active?.status === "review") for (const id of ["start-preview", "update-preview", "stop-preview"]) $(id).disabled = true;
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
      state.buildKey = null;
      $("build-prompt").value = state.prompts.get(id) || "";
      setCodeVisible(false);
    }
    state.project = data;
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
    : candidate?.status === "review" && candidate.preview_url ? "Version to review" : running
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
    renderPreview();
    renderBuilds();
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
  document.querySelector(".files-panel").hidden = !visible;
  document.querySelector(".editor-panel").hidden = !visible;
  document.querySelector(".workbench").classList.toggle("code-visible", visible);
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
  $("edit-guidance").textContent = activeBuild()?.status === "review" ? `${guidance} Keep this version first to use it as the starting point. Your draft below will stay intact.` : guidance;
  $("build-prompt").placeholder = example;
  $("build-prompt").focus();
}));
function renderAvailability(agent) {
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
    $("workspace").prepend(progress);
  }
  progress.hidden = !job;
  if (job) {
    const latestEvent = (state.project.events || []).find(event => event.task_id === job.task_id && ["GENERATION_STARTED", "REVIEW_STARTED", "REPAIR_STARTED"].includes(event.type));
    const stages = { GENERATION_STARTED: "Creating your website", REVIEW_STARTED: "Reviewing the generated files", REPAIR_STARTED: "Correcting issues found in review" };
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(job.created_at).getTime()) / 1000));
    progress.replaceChildren(element("span", "build-spinner", ""), element("strong", "", stages[latestEvent?.type] || (job.status === "queued" ? "Waiting for the builder" : "Build in progress")), element("span", "", `${Math.floor(seconds / 60)}m ${seconds % 60}s elapsed · This page updates automatically.`));
  }
  const key = JSON.stringify(builds);
  if (state.buildKey === key) return;
  state.buildKey = key;
  const active = activeBuild();
  const latest = active || builds[0];
  const current = $("build-current"); current.replaceChildren(); current.hidden = !latest;
  const labels = { queued: "Your request is queued", running: "Building your idea", review: "A new version is ready", applied: "This version is yours", failed: "This build needs another try", cancelled: "Version discarded" };
  if (latest) {
    current.append(element("span", `build-state ${latest.status}`, latest.status === "review" ? "READY FOR YOUR REVIEW" : latest.status.toUpperCase()), element("h3", "", labels[latest.status] || latest.status));
    if (latest.summary) current.append(element("p", "", latest.summary));
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
      current.append(element("p", "", "Try the preview, then send your next instruction above to continue from this version. You can also keep it now or discard it."));
      const keep = element("button", "primary full", "Keep this version"); keep.id = "apply-build"; keep.addEventListener("click", () => decideBuild(latest, "apply")); current.append(keep);
    }
    if (["queued", "running", "review"].includes(latest.status)) {
      const cancel = element("button", "text-button discard-button", latest.status === "review" ? "Discard version" : "Cancel build"); cancel.id = "cancel-build"; cancel.addEventListener("click", () => decideBuild(latest, "cancel")); current.append(cancel);
    }
  }
  $("build-history").replaceChildren();
  if (!builds.length) $("build-history").append(element("p", "muted", "Your first idea starts here. Each request and result will be saved."));
  for (const build of builds) { const item = element("article", "request-item"); item.append(element("p", "", build.prompt), element("span", "", `${labels[build.status] || build.status} · ${date(build.created_at)}`)); $("build-history").append(item); }
}
async function requestBuild() {
  if (state.busy || ["queued", "running"].includes(activeBuild()?.status)) return;
  const prompt = $("build-prompt").value.trim();
  if (!prompt) { $("build-prompt").focus(); return; }
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
      const { build } = await api(projectApi("/builds"), { method: "POST", body: JSON.stringify({ prompt }) });
      state.project.builds = [build, ...(state.project.builds || [])];
      $("build-prompt").value = ""; state.prompts.delete(state.project.project.id);
      renderBuilds(); await refreshProject(); state.lastPoll = 0;
      const latest = (state.project.builds || []).find((item) => item.id === build.id) || build;
      if (latest.status === "failed") notice(buildFailureMessage(latest), true);
      else if (latest.status === "review") notice("Your new version is ready. Try the preview and decide whether to keep it.");
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
  if (action === "apply" && hasDrafts() && !confirm("You have unsaved code edits. Keep this generated version and discard those code drafts?")) return;
  await operation(async () => {
    const data = await api(projectApi(`/builds/${encodeURIComponent(build.id)}/${action}`), { method: "POST", body: "{}" });
    if (action === "apply") { state.buffers.clear(); state.path = null; state.previewUrl = null; if (data.preview) state.project.preview = data.preview; }
    await refreshProject();
    notice(action === "apply" ? "Version kept. Tell us what you would like to improve next." : "Version discarded. Your saved website is unchanged.");
  });
}
