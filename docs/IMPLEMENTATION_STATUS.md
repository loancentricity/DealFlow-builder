# Implementation status

Scope: first local, single-owner development increment. The full platform remains incomplete; owner acceptance is pending.

## Working and verified locally

- Create static starter projects from a responsive dashboard.
- Persist projects and versioned source files in PostgreSQL through a schema migration.
- Browse/edit/save/reload source, reject stale saves with HTTP 409, preserve the losing browser draft, and explicitly load the saved version to resolve a conflict.
- Start/update/stop a static preview served by a separate worker. Starter JavaScript runs in a sandboxed browser frame. Updating the counter source changed its behavior from +1 to +2 in browser verification.
- Persist actual static-check tasks, results, source versions, and structured operation events. Restore recorded checks after page reload.
- Read/edit saved projects when the preview worker is unavailable; reconcile expired/restarted previews.
- Agent-provider interface exists; execution is explicitly unavailable. No agent progress is simulated.

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
| Docker Compose | Images built and services started in CI. The first smoke check found that an internal-only network prevented host loopback access. The app/preview bridge is corrected; PostgreSQL remains isolated on its internal network. Full container browser verification is pending the latest CI result. Docker is not installed locally. |
| GitHub Actions | Run 34786766878 passed dependency install, syntax checks, PostgreSQL 17 migration/integration tests, and the full Playwright browser suite. A separate container startup/browser job is now configured; its result must be checked on the latest review commit. |

Screenshots accompany the task deliverables. They contain only a synthetic starter project. A separate frontend agent implemented the UI, a documentation agent prepared standing requirements/container configuration, and a QA agent supplied tests and review; the lead integrated and verified the result.

## Not yet built

Independent safe ZIP imports/readiness reports; broad runtime execution; connected AI agents, task scheduling/graphs, file locks, merge queue, and orchestration modes; hosted multiuser authentication/authorization; production security/compliance controls; staging/production separation and deployment/rollback; infrastructure-as-code, managed backups and restoration; worker pools/caches; mortgage application modules and vendor adapters. The standing requirements remain in `DEALFLOW.md`.

## Operational limits and next increment

Use only on loopback for one owner with synthetic data. Static checks inspect structure and local asset references; they are not arbitrary runtime tests. Project JavaScript executes only in the browser. Random preview URLs grant access while active. Worker snapshots are limited to 100, expire after one hour, and disappear on restart. Stop cannot retract a document already loaded in another browser. Publication and database commit are not distributed-atomic, so a failed operation may leave an orphan snapshot until expiry. The browser polls lifecycle state every 15 seconds while visible. Container restrictions do not establish a general-purpose server-code sandbox. No production deployment or paid resources are included.

After owner review, the next smallest increment is safe independent ZIP inventory/import for static projects: archive safety tests, secret-file exclusion, original source preservation, and per-project readiness reports before runtime expansion.
