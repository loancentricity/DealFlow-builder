import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

const base = process.env.BASE_URL || "http://127.0.0.1:3000";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
    : {}),
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await mkdir("test-results", { recursive: true });
try {
  await page.goto(base);
  await page.locator("#new-project").click();
  const projectName = `Browser journey ${Date.now()}`;
  await page.locator("#project-name").fill(projectName);
  await page.locator("#create-submit").click();
  await page.locator("#workspace").waitFor({ state: "visible" });
  await page.locator("#toggle-code").click();
  await page.getByRole("button", { name: "index.html", exact: true }).click();
  const editor = page.getByLabel("Source code", { exact: true });
  const original = await editor.inputValue();
  const marker = `Browser saved ${Date.now()}`;
  await editor.fill(original.replace("Hello, builder.", marker));
  const saveResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().includes("/files"),
  );
  await page.locator("#save-file").click();
  assert.equal((await saveResponse).status(), 200);
  await page.waitForFunction(
    () =>
      document.querySelector("#save-state").textContent === "Saved · version 2",
  );
  await page.reload();
  await page.locator("#workspace").waitFor({ state: "visible" });
  await page.locator("#toggle-code").click();
  await page.getByRole("button", { name: "index.html", exact: true }).click();
  assert.match(await editor.inputValue(), new RegExp(marker));

  // A second client updates the same version. The browser must retain its draft.
  const list = await (await page.request.get(`${base}/api/projects`)).json();
  const project = (list.projects ?? list).find(
    (item) => item.name === projectName,
  );
  assert.ok(project);
  const detail = await (
    await page.request.get(`${base}/api/projects/${project.id}`)
  ).json();
  // Attach only this synthetic test project's own export. Uploading is available
  // without a model connection and must not submit or erase the message draft.
  const exportPath=await page.locator("#download-project").getAttribute("href");
  assert.ok(exportPath,"saved source export link exists");
  const exported=await page.request.get(new URL(exportPath,base).href);
  assert.equal(exported.status(),200);
  const attachmentName="synthetic-browser-source.zip";
  const unsent="Keep this unsent message while the ZIP uploads.";
  await page.locator("#build-prompt").fill(unsent);
  const attachmentResponse=page.waitForResponse(response=>response.request().method()==="POST"&&response.url().endsWith(`/projects/${project.id}/attachments`));
  await page.locator("#attachment-picker").setInputFiles({name:attachmentName,mimeType:"application/zip",buffer:await exported.body()});
  assert.equal((await attachmentResponse).status(),201);
  const attachmentChoice=page.getByLabel(`Use ${attachmentName} with message`,{exact:true});
  await attachmentChoice.waitFor({state:"visible"});
  assert.equal(await attachmentChoice.isChecked(),true);
  assert.equal(await page.locator("#build-prompt").inputValue(),unsent);
  const attached=(await (await page.request.get(`${base}/api/projects/${project.id}`)).json());
  assert.ok(attached.attachments.some(item=>item.name===attachmentName));
  assert.deepEqual(attached.files,detail.files,"attachment upload does not alter saved project source");
  const dropName = 'synthetic-dropped-source.zip';
  const dropped = await page.evaluateHandle(({bytes,name}) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], name, {type:'application/zip'}));
    return transfer;
  }, {bytes:[...await exported.body()],name:dropName});
  const dropResponse = page.waitForResponse(response => response.request().method()==='POST' && response.url().endsWith(`/projects/${project.id}/attachments`));
  await page.locator('#build-prompt').dispatchEvent('drop', {dataTransfer:dropped});
  assert.equal((await dropResponse).status(),201,'dropping onto the message textarea uploads a ZIP');
  await page.getByLabel(`Use ${dropName} with message`,{exact:true}).waitFor({state:'visible'});
  assert.equal(await page.locator('#build-prompt').inputValue(),unsent,'dropping preserves the typed message');
  await dropped.dispose();
  await page.locator("#build-prompt").fill("");
  const file = detail.files.find((file) => file.path === "index.html");
  const concurrent = await page.request.put(
    `${base}/api/projects/${project.id}/files`,
    {
      data: {
        path: file.path,
        content: file.content + "\n<!-- concurrent save -->",
        version: file.version,
      },
    },
  );
  assert.equal(concurrent.status(), 200);
  const draft = (await editor.inputValue()) + "\n<!-- local draft -->";
  await editor.fill(draft);
  const conflictResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().includes("/files"),
  );
  await page.locator("#save-file").click();
  assert.equal((await conflictResponse).status(), 409);
  await page.locator("#conflict").waitFor({ state: "visible" });
  assert.equal(await editor.inputValue(), draft);
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#load-latest").click();
  await page.waitForFunction(() =>
    document.querySelector("#code-editor").value.includes("concurrent save"),
  );

  // Saved previews auto-start when opened; publish the latest saved source.
  await page.locator("#update-preview").click();
  const frame = page.frameLocator("#preview-frame");
  await frame.getByRole("heading", { name: marker, exact: true }).waitFor();
  await frame
    .getByRole("button", { name: "Make it happen · 0", exact: true })
    .click();
  await frame
    .getByRole("button", { name: "Make it happen · 1", exact: true })
    .waitFor();
  const firstUrl = await page.locator("#preview-frame").getAttribute("src");
  await page.getByRole("button", { name: "app.js", exact: true }).click();
  await editor.fill(
    (await editor.inputValue()).replace("count += 1", "count += 2"),
  );
  const jsSave = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().includes("/files"),
  );
  await page.locator("#save-file").click();
  assert.equal((await jsSave).status(), 200);
  await page.locator("#update-preview").click();
  await frame
    .getByRole("button", { name: "Make it happen · 0", exact: true })
    .waitFor();
  await frame
    .getByRole("button", { name: "Make it happen · 0", exact: true })
    .click();
  await frame
    .getByRole("button", { name: "Make it happen · 2", exact: true })
    .waitFor();
  const liveUrl = await page.locator("#preview-frame").getAttribute("src");
  const checkResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/tests"),
  );
  await page.locator('[data-tool="activity"]').click();
  await page.locator("details.project-details > summary").click();
  await page.locator("#run-tests").click();
  assert.equal((await checkResponse).status(), 200);
  await page.waitForFunction(
    () =>
      document.querySelector("#notice").textContent ===
      "Starter checks passed and were recorded.",
  );
  await page.screenshot({
    path: "test-results/workspace-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-mobile-view="preview"]').click();
  await page.screenshot({
    path: "test-results/workspace-mobile.png",
    fullPage: true,
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    "mobile layout has no horizontal page overflow",
  );
  await page.locator("#stop-preview").click();
  await page.locator("#preview-empty").waitFor({ state: "visible" });
  assert.equal((await page.request.get(liveUrl)).status(), 404);
  assert.equal((await page.request.get(firstUrl)).status(), 404);
  if (process.env.BUILD_WORKER_TOKEN) {
    await candidateDecisionJourney(project.id);
  } else {
    console.log("SKIP: continuous-feedback browser journey requires BUILD_WORKER_TOKEN and an isolated test environment without a live build worker.");
  }
  await page.locator("#back-projects").click();
  await page.locator("#dashboard").waitFor({ state: "visible" });
  await page.screenshot({
    path: "test-results/dashboard-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.screenshot({
    path: "test-results/dashboard-desktop.png",
    fullPage: true,
  });
  assert.deepEqual(errors, [], "no uncaught browser errors");
  console.log(
    "PASS: create → edit → save → reload → synthetic ZIP attachment with preserved draft → concurrent conflict → interactive preview → update → checks → stop; desktop/mobile screenshots in test-results/.",
  );
} catch (error) {
  await page.screenshot({ path: "test-results/failure.png", fullPage: true });
  throw error;
} finally {
  await browser.close();
}

// Authenticated deterministic fixture for CI only. Never run alongside a live worker.
// This verifies owner decisions, not AI generation or the model provider.
async function candidateDecisionJourney(projectId) {
  const headers = { Authorization: `Bearer ${process.env.BUILD_WORKER_TOKEN}` };
  const internal = async (path, data) => {
    const response = await page.request.post(`${base}/internal/build-worker/${path}`, {headers,data});
    assert.equal(response.status(), 200, `test fixture worker ${path}`);
    return response.json();
  };
  const detail = async () => (await page.request.get(`${base}/api/projects/${projectId}`)).json();
  const heartbeat = () => internal("heartbeat", {name:"Browser test fixture (not AI)",ready:true});
  const publishCandidate = async (heading, expectedBaseHeading) => {
    await heartbeat();
    const source = await detail();
    const html = source.files.find(file => file.path === "index.html");
    const candidate = html.content.replace(/<h1>[^<]*<\/h1>/, `<h1>${heading}</h1>`);
    assert.notEqual(candidate,html.content);
    await page.reload();
    await page.locator("#workspace").waitFor({state:"visible"});
    await page.locator('[data-mobile-view="chat"]').click();
    await page.locator("#build-prompt").fill(`TEST FIXTURE ONLY: change the heading to ${heading}.`);
    const queuedResponse = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith(`/projects/${projectId}/builds`));
    await page.locator("#request-build").click();
    const queued = await queuedResponse;
    assert.equal(queued.status(),201);
    await page.locator("#build-progress").waitFor({state:"visible"});
    const {build:requested} = await queued.json();
    const {build:claimed} = await internal("claim",{});
    assert.equal(claimed.id,requested.id,"isolated fixture claims its own request");
    if (expectedBaseHeading) {
      assert.ok(claimed.source_files.find(file => file.path === "index.html").content.includes(expectedBaseHeading), "follow-up starts from the reviewed version without a Keep click");
      assert.ok(claimed.history.length > 0, "follow-up includes prior saved requests");
    }
    const baseline = (await detail()).files;
    const {build:reviewed} = await internal(`${claimed.id}/complete`, {
      lease_token:claimed.lease_token,
      files:[{path:"index.html",content:candidate}],
      summary:"Deterministic browser-test candidate, not an AI-generated result.",
      review:{approved:true,summary:"Explicit test fixture source-review decision."},
    });
    assert.equal(reviewed.status,"review");
    await page.locator("#cancel-build").waitFor({state:"visible",timeout:20000});
    await page.locator("#build-progress").waitFor({state:"hidden"});
    await page.locator('[data-mobile-view="preview"]').click();
    await page.frameLocator("#preview-frame").getByRole("heading",{name:heading,exact:true}).waitFor();
    assert.deepEqual((await detail()).files,baseline,"reviewing a candidate preserves saved source");
    return reviewed;
  };
  try {
    if (await page.locator("#toggle-code").getAttribute("aria-expanded") === "true") await page.locator("#toggle-code").click();
    await publishCandidate("Before follow-up fixture");
    await publishCandidate("Kept browser fixture", "Before follow-up fixture");
    const pending = await publishCandidate("Discarded browser fixture", "Kept browser fixture");
    const saved = (await detail()).files;
    assert.match(saved.find(file=>file.path==="index.html").content,/Kept browser fixture/);
    await page.reload();
    await page.locator("#workspace").waitFor({state:"visible"});
    await page.locator('[data-mobile-view="preview"]').click();
    await page.frameLocator("#preview-frame").getByRole("heading",{name:"Discarded browser fixture",exact:true}).waitFor();
    await page.locator('[data-mobile-view="chat"]').click();
    await page.locator("#cancel-build").click();
    await page.waitForFunction(() => document.querySelector("#notice").textContent === "Version discarded. Your saved website is unchanged.");
    assert.deepEqual((await detail()).files,saved,"discard preserves source contents and versions");
    assert.equal((await page.request.get(pending.preview_url)).status(),404);
    await page.locator('[data-mobile-view="preview"]').click();
    await page.frameLocator("#preview-frame").getByRole("heading",{name:"Kept browser fixture",exact:true}).waitFor();
    await page.screenshot({path:"test-results/owner-decisions-mobile.png",fullPage:true});

    // Active candidates prevent concurrent source writes. SQL-level stale-base
    // conflict coverage lives in builds.test.js; this tests the public guard.
    const protectedCandidate = await publishCandidate("Protected candidate fixture");
    const latest=(await detail()).files.find(file=>file.path==="index.html");
    const concurrent=await page.request.put(`${base}/api/projects/${projectId}/files`,{data:{...latest,content:latest.content+"\n<!-- newer saved source -->"}});
    assert.equal(concurrent.status(),409,"active candidate blocks concurrent source edits");
    assert.deepEqual((await detail()).files.find(file=>file.path==="index.html"),latest,"rejected save preserves source and version");
    await page.locator('[data-mobile-view="chat"]').click();
    const followup="Preserve this unsent follow-up while I discard this candidate.";
    await page.locator("#build-prompt").fill(followup);
    await page.locator("#cancel-build").click();
    await page.waitForFunction(()=>document.querySelector("#notice").textContent.includes("discarded"));
    assert.equal(await page.locator("#build-prompt").inputValue(),followup);
    assert.deepEqual((await detail()).files.find(file=>file.path==="index.html"),latest);
    assert.equal((await page.request.get(protectedCandidate.preview_url)).status(),404);
    await page.locator('[data-mobile-view="tools"]').click();
    await page.screenshot({path:"test-results/workspace-tools-mobile.png",fullPage:true});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),"mobile tools have no horizontal overflow");
    console.log("PASS: reviewed preview → follow-up autoapply → candidate reload → discard → active candidate blocks source edits; unsent prompt preserved; mobile conversation/preview/tools verified.");
  } finally {
    await internal("heartbeat",{name:"Browser test fixture (not AI)",ready:false,reason:"Browser fixture completed; no live AI provider was used."});
  }
}



