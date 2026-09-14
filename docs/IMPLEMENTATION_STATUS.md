# Implementation status

Scope: early local, single-owner development increments. The full platform remains incomplete; owner acceptance is pending.

## Second increment — real generation and candidate preview verified

The owner journey now starts with a plain-language request and emphasizes preview review with continuous feedback and Discard; Code and technical checks are optional. A separate build-worker process uses the Responses API for generation and an independent source-review pass, with one correction attempt. It does not execute browser tests or generated server code. `OPENAI_API_KEY` belongs only to the build worker; its control-plane API uses a separate `BUILD_WORKER_TOKEN`.

Migration `002_builds.sql` adds durable build requests, captured source/version maps, candidate source, review/check results, leases, and worker availability. The API enforces one active build per project, heartbeat availability, authenticated claims, stale-lease rejection, and ten-minute running-job expiry. Continuing from a reviewed preview checks the entire captured version map atomically, preserves omitted source paths, and is idempotent. Discard preserves saved source and revokes only the candidate preview. Structure checks are computed by the control plane rather than trusted from the worker.

Sixteen local tests pass, including PostgreSQL lifecycle, provider contracts, lease renewal and preservation of generated files across correction passes. GitHub Actions run 34790113538 passed standard and container browser journeys on b94daf384fc46d5987b2a358f07b5799f4f219f8. The early API quota failure was resolved. The actual model worker generated and repaired a synthetic consumer-transfer prototype that passed source review and structural checks. In-app browser verification covered account exclusion, correction provenance, consent refusal, simulated transfer receipt, and selected fields in the destination preview. Its 22 executable synthetic policy checks passed. Owner acceptance remains pending; the latest interface continues through the next instruction rather than a Keep button. CI candidate tests use explicit fixtures and do not establish model quality.

Real-model testing exposed and fixed a repair assembly bug; a regression test proves corrections preserve earlier generated files. Generation now uses low reasoning effort, a 24,000-token output budget and a five-minute per-call timeout. Authenticated stage progress renews the ten-minute lease. The owner UI shows actual current stage and elapsed time without fabricated percentages.

## First increment — historical local verification

- Create static starter projects from a responsive dashboard.
- Persist projects and versioned source files in PostgreSQL through a schema migration.
- Browse/edit/save/reload source, reject stale saves with HTTP 409, preserve the losing browser draft, and explicitly load the saved version to resolve a conflict.
- Start/update/stop a static preview served by a separate worker. Starter JavaScript runs in a sandboxed browser frame. Updating the counter source changed its behavior from +1 to +2 in browser verification.
- Persist actual static-check tasks, results, source versions, and structured operation events. Restore recorded checks after page reload.
- Read/edit saved projects when the preview worker is unavailable; reconcile expired/restarted previews.
- At this checkpoint the agent-provider interface existed with execution unavailable. The second increment adds optional real worker execution as described above.

## Verification record - 2026-09-13

Environment: Node 24.19.0 on Windows; native PostgreSQL 18.4 bound to loopback for local testing. No alternative production database was substituted. Package scripts were invoked through the bundled pnpm/npm launcher because npm was absent from the default PATH.

| Check | Actual result |
| --- | --- |
| `npm install` | Passed; lockfile generated; 0 dependency vulnerabilities reported at installation |
| `npm ci` | Passed locally and in GitHub CI |
| `npm run build` | Passed (JavaScript syntax checks; this application has no bundle compilation step) |
| `node server/migrate.js` with `DATABASE_URL` set | Passed against native PostgreSQL; repeated by integration tests |
| `npm test` | 8 passed, 0 failed, 0 skipped against PostgreSQL |
| `node --test --test-isolation=none test/*.test.js` | 8 passed, including actual concurrent writers, persistence, worker outage/restart, lifecycle, validation, and Host/Origin defenses |
| `node test/browser.js` with installed Edge selected | Blocked before launch: Windows `spawn EPERM`; standalone Playwright suite remains unverified locally |
| In-app browser automation | Passed create, edit, save, reload, interactive preview, update, checks, stop; two-editor conflict preserved the losing draft and recovered the saved version |
| Stop verification | The old browser preview URL returned HTTP 404 after Stop |
| Desktop/mobile visual review | Actual screenshots captured at desktop width and 390px mobile; mobile document width 375px within 390px viewport; no horizontal page overflow; preview interaction verified on mobile |
| Docker Compose | Images built and services started in CI. The first smoke check found that an internal-only network prevented host loopback access. The app/preview bridge is corrected; PostgreSQL remains isolated on its internal network. First-increment container browser verification passed in run 34787140672. Docker is not installed locally. |
| GitHub Actions | Run 34786766878 passed dependency install, syntax checks, PostgreSQL 17 migration/integration tests, and the full Playwright browser suite. Run 34787140672 subsequently passed both standard and container browser jobs; second-increment results are tracked separately. |

Screenshots accompany the task deliverables. They contain only a synthetic starter project. A separate frontend agent implemented the UI, a documentation agent prepared standing requirements/container configuration, and a QA agent supplied tests and review; the lead integrated and verified the result.

## Not yet built

Full independent Replit preservation/readiness reports; broad runtime execution; full coordinated multi-agent orchestration, task scheduling/graphs, file locks, merge queue, and orchestration modes; hosted multiuser authentication/authorization; production security/compliance controls; staging/production separation and deployment/rollback; infrastructure-as-code, managed backups and restoration; worker pools/caches; mortgage application modules and vendor adapters. The standing requirements remain in `DEALFLOW.md`.

## Operational limits and next increment

Use only on loopback for one owner with synthetic data. Static checks inspect structure and local asset references; they are not arbitrary runtime tests. Project JavaScript executes only in the browser. Random preview URLs grant access while active. Worker snapshots are limited to 100, expire after one hour, and disappear on restart. Stop cannot retract a document already loaded in another browser. Publication and database commit are not distributed-atomic, so a failed operation may leave an orphan snapshot until expiry. The browser polls lifecycle state every two seconds for active builds and every 15 seconds while idle. Container restrictions do not establish a general-purpose server-code sandbox. No production deployment or paid resources are included.

The immediate next step is integration verification and owner review of the workspace and continuous-feedback journey. Full independent Replit preservation and broader runtimes remain subsequent increments.


## Workspace and multiple providers — latest increment

Implemented provider adapters and selection for OpenAI, Anthropic, DeepSeek, Google, Kimi, and Z.ai. The worker registry uses authenticated readiness probes only for configured providers; credentials remain outside the browser and control plane. Missing keys remain unavailable. The database records the selected provider with each build. Worker and provider availability is not proof of a successful generation or sufficient API credits.

Known focused result: `node --test --test-isolation=none test/provider.test.js test/providers.test.js test/build-worker.test.js` completed with **15 passed, 0 failed**. These deterministic tests cover adapter protocols/authentication, key aliases and model configuration, error redaction, no network calls for absent credentials, existing OpenAI behavior, and repair-file preservation. They do not verify live account access or generation through all six vendors.

The browser test has been adapted to the continuous-feedback interface: a subsequent instruction applies the reviewed candidate; reload retains the pending preview; Discard preserves saved sources; source edits during candidate review are rejected with 409; Discard preserves an unsent follow-up. Stale captured versions remain covered by the database integration tests. It explicitly switches mobile Conversation, Preview, and Tools views. `node --check test/browser.js` passed. GitHub Actions run 34792202694 on code commit 4d5c8d61288f07e32169474a2b0b17cd206ca06a passed the revised automated browser journey and the container browser journey. In-app browser inspection verified the three-pane desktop workspace, mobile Conversation/Preview/Tools navigation, actual connection states, and the optional Save this version control. Mobile page width was 390px at a 390px viewport, without page overflow; no browser console errors were observed.

Workspace/file/checkpoint tools and static ZIP operations are integrated with the app. The complete local test suite passed 35 tests with no failures or skips against a dedicated PostgreSQL test database. ZIP fixtures include corrupt checksums, traversal, links, encryption, duplicates, and expansion limits. Rename, duplicate, exact source roundtrip, snapshot immutability, checkpoint restore and active-build mutation protection are covered. Checkpoint source snapshots and exact version-map restore protections are implemented. Full Replit application preservation, unsupported runtime handling, orchestration, production publishing, and hosted authentication remain unbuilt; static ZIP support must not be described as full Replit migration.


The final regression also proves that applying a build cannot reuse a deleted file version and accept a stale draft. Checkpoints provides an optional Save this version action before exporting or capturing the latest candidate; sending another instruction remains sufficient to continue.

## Message ZIP attachments

ZIP files can be dropped onto the message textarea or selected with Attach ZIP, with actual upload progress and cancellation. Original archives stay with the same project; uploading preserves drafts and source files and works without an available AI provider. Limits are 250 MiB per ZIP, 1 GiB and 20 attachments per project, and two concurrent uploads. The dashboard static importer remains separate.

Migration 006 stores attachment metadata; originals stream into an ignored local directory or the dedicated Compose attachment volume. Structure, path, link, encryption, entry-count and advertised-expansion checks run before storage. No archive code executes. Selected text excerpts are bounded to a 200 KB context budget and filtered for common credential/dependency paths; selected entries receive size/CRC checks. Raw archives are not sent to models. Migration 007 freezes selected attachment context with each build; both generation and source review receive it.

Verification: 36 local tests passed with no skips, including a 6 MiB original that downloads byte-for-byte and survives an app restart, project scoping, invalid/oversized ZIP rejection, and filtered worker context. GitHub Actions run 34792696004 on b7bcac90c0762ca8bc6ea12a538d7703e4b89ffe passed standard and container browser journeys, including both the file picker and dropping a ZIP directly on the textarea while preserving the draft. Desktop/mobile in-app inspection confirmed the controls; an owner upload was visibly stored and a subsequent build started. Full 250 MiB transfer throughput was not benchmarked.

## General attachments and native media

The message composer now stores arbitrary file types (250 MiB each), detects media types from content, and queues multi-file drops with at most two concurrent transfers. Text excerpts remain bounded; PNG/JPEG/WebP and PDF references reach OpenAI, Anthropic, or Google through native content parts. Selected media has a combined 20 MiB input limit. GIF/unknown binaries and oversized media remain downloadable with explicit reader limitations. Raw file downloads are inert attachments. Migration 008 adds media types without modifying existing ZIP originals.

Media retrieval requires worker authentication, the active build lease, the selected attachment ID, and the correct project. Base64 bytes are excluded from ordinary text context. Forty local tests passed without skips, covering text/PNG/PDF/binary storage, exact originals, private media access, and native vendor request protocols. GitHub Actions run 34793039628 on 113c7767f034faa06626350e14a40989897d82f9 passed both standard and container browser journeys, including a three-file mixed batch through the two-transfer queue. The follow-up ZIP signature refinement passed the attachment integration regression locally; its separate CI is queued. Native image/PDF vendor protocols were verified against official documentation and mocked requests; live generation through every provider was not tested.
