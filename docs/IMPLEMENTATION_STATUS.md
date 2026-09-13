# Implementation status

Scope: early local, single-owner development increments. The full platform remains incomplete; owner acceptance is pending.

## Second increment — implemented; live generation blocked by API quota

The owner journey now starts with a plain-language request and emphasizes preview review with Keep/Discard; Code and technical checks are optional. A separate build-worker process uses the Responses API for generation and an independent source-review pass, with one correction attempt. It does not execute browser tests or generated server code. `OPENAI_API_KEY` belongs only to the build worker; its control-plane API uses a separate `BUILD_WORKER_TOKEN`.

Migration `002_builds.sql` adds durable build requests, captured source/version maps, candidate source, review/check results, leases, and worker availability. The API enforces one active build per project, heartbeat availability, authenticated claims, stale-lease rejection, and ten-minute running-job expiry. Keep checks the entire captured version map atomically, preserves omitted source paths, and is idempotent. Discard preserves saved source and revokes only the candidate preview. Structure checks are computed by the control plane rather than trusted from the worker.

Migration 002 and the nine PostgreSQL/domain/security/preview/build lifecycle tests passed locally. Six additional provider contract tests passed, including refusal, incomplete output and error-content redaction. In-app browser verification passed project creation and plain-language build submission through the actual application routes. The real Responses API returned HTTP 429 with credit_balance_exhausted / insufficient_quota. No AI-generated candidate or successful live Keep journey is claimed. The request and failure were persisted. Restore API credit and restart the build worker to verify successful live generation. Browser candidate tests use explicit synthetic worker fixtures; they do not establish model quality. Latest CI and screenshots are recorded with the review deliverable.

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

Independent safe ZIP imports/readiness reports; broad runtime execution; full coordinated multi-agent orchestration, task scheduling/graphs, file locks, merge queue, and orchestration modes; hosted multiuser authentication/authorization; production security/compliance controls; staging/production separation and deployment/rollback; infrastructure-as-code, managed backups and restoration; worker pools/caches; mortgage application modules and vendor adapters. The standing requirements remain in `DEALFLOW.md`.

## Operational limits and next increment

Use only on loopback for one owner with synthetic data. Static checks inspect structure and local asset references; they are not arbitrary runtime tests. Project JavaScript executes only in the browser. Random preview URLs grant access while active. Worker snapshots are limited to 100, expire after one hour, and disappear on restart. Stop cannot retract a document already loaded in another browser. Publication and database commit are not distributed-atomic, so a failed operation may leave an orphan snapshot until expiry. The browser polls lifecycle state every two seconds for active builds and every 15 seconds while idle. Container restrictions do not establish a general-purpose server-code sandbox. No production deployment or paid resources are included.

The immediate next step is to restore model API credit, restart the build worker, and verify generation, review, preview, Keep and a follow-up change using the real model. Safe independent ZIP inventory/import and broader runtimes remain subsequent increments.

