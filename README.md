# DealFlow Builder

A local development workspace for creating, editing, checking, and previewing projects. This is the first runnable increment of an owner-controlled development platform, not the completed MVP. Read [DEALFLOW.md](DEALFLOW.md) for standing requirements and [implementation status](docs/IMPLEMENTATION_STATUS.md) for scope and verification.

The supported runtime is static HTML, CSS, and browser JavaScript. PostgreSQL stores project sources and durable operations. A separate preview worker serves project files; the control plane does not execute project code. Agent execution is unavailable until a real provider and isolated execution worker are connected.

## Local startup

Prerequisites: Node.js 24, npm, and PostgreSQL. Install dependencies with `npm ci`. Set environment variables in your process or an untracked local environment file. Never commit credentials. The npm app, migration, and test scripts load an optional `.env` file. A direct `node server/preview-worker.js` invocation uses the process environment; configure only worker variables for that process.

| Variable               | Purpose                                                    |
| ---------------------- | ---------------------------------------------------------- |
| `DATABASE_URL`         | PostgreSQL connection for the control plane and migrations |
| `HOST`                 | Control-plane bind address; default `127.0.0.1`            |
| `PORT`                 | Control-plane port; default `3000`                         |
| `PREVIEW_WORKER_URL`   | Worker URL reachable by the control plane                  |
| `PREVIEW_PUBLIC_URL`   | Worker URL reachable by the browser                        |
| `PREVIEW_WORKER_TOKEN` | Shared internal worker API credential; generate locally    |
| `PREVIEW_HOST`         | Worker bind address                                        |
| `PREVIEW_PORT`         | Worker port; use `3001` for local startup                  |

Run `npm run migrate`, then `npm start`. In a separate process, run `node server/preview-worker.js` with the worker token, host, and port configured. The control plane is at [localhost:3000](http://localhost:3000); the worker uses [localhost:3001](http://localhost:3001). Configure both preview URL variables accordingly. Give the worker only its own environment variables, not the database connection or control-plane credentials.

Alternatively, use Docker Compose. Set `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, and `PREVIEW_WORKER_TOKEN` locally before running `docker compose up --build`. Use URL-safe database credentials because Compose constructs the PostgreSQL connection URL. Compose starts PostgreSQL, applies migrations before starting the app, and runs the preview in a separate restricted container. Ports bind to loopback. Stop with `docker compose down`; the named database volume survives. Removing that volume deletes persisted projects.

## Try the journey

1. Create a project from the supported starter on the dashboard.
2. Open a file, edit its source, and save. Reload the page and inspect the saved file.
3. Start the preview. Save another change and update the preview to inspect the current source.
4. Run the available project checks and inspect their actual results and activity history.
5. Stop the preview and verify that the old preview URL no longer serves the project.

Concurrent saves use version checks. If another editor changes a file, resolve the conflict against the saved version instead of silently overwriting it. A project check is limited to the supported starter; it is not a claim that arbitrary imported applications have passed tests.

## Verification

```sh
npm ci
npm run check
npm test
npm run migrate
npm run test:browser
```

Unit/integration tests use `node --test --test-isolation=none test/*.test.js` (one process for compatibility with restricted Windows environments). PostgreSQL integration is explicitly skipped when `DATABASE_URL` is absent. Set it to a dedicated development/test database to exercise the complete suite. Browser verification uses Playwright: run `npx playwright install chromium` first and start the database, app, and preview worker. `BASE_URL` overrides the app URL; `PLAYWRIGHT_EXECUTABLE_PATH` selects an installed compatible browser. CI is configured to run checks against disposable PostgreSQL. There is no separate bundling build for the vanilla JavaScript application; `npm run build` checks its runnable JavaScript sources.

## Boundaries

This increment is for local, single-owner development. It has no multiuser authentication or authorization and must not be exposed to a network as a hosted service. Preview isolation here means a separate serving process/container and a separate browser origin, not a general-purpose sandbox for server code. Random public preview URLs are bearer access: treat them as private while active. Snapshots expire after one hour and are lost on worker restart. The UI polls preview status every 15 seconds while visible. Stop/update invalidates old URLs, but cannot retract a document already loaded in another browser; the builder removes its own frame. Never place secrets in project source.

The Compose worker image contains only static-serving code, has no database dependency or credentials, and uses a network separate from PostgreSQL. The worker API token must be at least 24 characters. Snapshot publication and the database transaction are not a distributed atomic commit: a failure between them can leave an inaccessible-to-the-builder snapshot until its one-hour expiry. Worker outages preserve access to saved source. The static checks inspect document structure and asset references only; they do not execute arbitrary project tests.

Safe independent Replit ZIP imports, broader runtimes, coordinated agents, full environment separation, production hardening, infrastructure definitions, and release/rollback automation remain backlog requirements. No production deployment or external service provisioning is included.
