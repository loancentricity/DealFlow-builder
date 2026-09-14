# DealFlow Builder

A local development workspace for creating, editing, checking, and previewing projects. This is an early runnable increment of an owner-controlled development platform, not the completed MVP. Read [DEALFLOW.md](DEALFLOW.md) for standing requirements and [implementation status](docs/IMPLEMENTATION_STATUS.md) for scope and verification.

The supported runtime is static HTML, CSS, and browser JavaScript. PostgreSQL stores project sources and durable operations. A separate preview worker serves project files; the control plane does not execute project code. An optional separate build worker calls the selected provider API to generate candidate source, then requests an independent source-review pass. Owners continue by sending plain-language messages. Sending feedback on a reviewed preview saves that version as the starting point before requesting the next change; Discard remains available for unwanted candidates. Builder availability reflects an actual configured worker heartbeat; unavailable execution is never simulated.

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

## Optional AI build workers and providers

Configure `BUILD_WORKER_TOKEN` on the control plane and build worker; use a separately generated token of at least 24 characters, distinct from `PREVIEW_WORKER_TOKEN`. Configure provider API keys only in the build worker process. Do not put that key in the control-plane `.env`, browser, project source, or preview worker environment. Model calls send the requested change and source snapshot to the configured model API; use synthetic projects and an account authorized for this usage.

Start the app with the build token, then start a separate process with only the build token and model settings and run `npm run build-worker`. `BUILD_CONTROL_URL` defaults to `http://127.0.0.1:3000` and must target a loopback host. `OPENAI_BASE_URL` optionally selects an HTTPS model API endpoint; `OPENAI_MODEL` defaults to `gpt-6-astra`. Availability requires model access and a recent ready heartbeat. The worker can make one correction pass after review. Generation and source review are API calls, not browser tests or runtime execution.

The checked-in Compose setup supports the manual source/preview workflow; it does not start an AI build worker. To connect a host build worker to a containerized app, explicitly pass the same `BUILD_WORKER_TOKEN` to the app container using a local Compose override and point the host worker at the published loopback app URL. Keep `OPENAI_API_KEY` exclusively in the host worker process.

## Try the owner journey

1. Create a project and describe the desired product or change in plain language.
2. With an available worker, submit the request and follow recorded build/review activity.
3. Inspect the candidate preview and send the next instruction in the same message box. This saves the reviewed candidate, then builds from those files with up to ten recent applied requests as context. Discard cancels the candidate without changing saved source. Sending a new instruction waits while another generation is running.
4. If another edit changed any source since generation began, continuing rejects the stale candidate rather than overwriting newer work. Discard it and request a new build from current source.

Candidates, request history, review results, and source versions persist in PostgreSQL. Generated paths merge with the captured source snapshot; omitted files are preserved. The Code view and technical checks remain available as optional tools. Candidate previews are disposable, while their source is retained. A review approval is an AI source review and structural check result, not proof that browser behavior works.

## Try the manual source journey

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


## Provider configuration

The selector offers OpenAI, Anthropic, DeepSeek, Google, Kimi, and Z.ai. Availability requires a configured worker credential and a successful authenticated provider probe; missing credentials never become a simulated connection. The adapters are implemented, but a configured credential does not establish available credits or a successful generation. This implementation task has not verified live builds through every provider.

| Provider | Worker-only credential variables | Model override | Default model |
| --- | --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | `OPENAI_MODEL` | `gpt-6-astra` |
| Anthropic | `ANTHROPIC_API_KEY` | `ANTHROPIC_MODEL` | `claude-sonnet-5` |
| DeepSeek | `DEEPSEEK_API_KEY` | `DEEPSEEK_MODEL` | `deepseek-flash` |
| Google | `GEMINI_API_KEY` or `GOOGLE_API_KEY` | `GOOGLE_MODEL` or `GEMINI_MODEL` | `gemini-2.5-flash` |
| Kimi | `MOONSHOT_API_KEY` or `KIMI_API_KEY` | `KIMI_MODEL` | `kimi-k2.5` |
| Z.ai | `ZAI_API_KEY` | `ZAI_MODEL` | `glm-5.1` |

Each provider accepts an optional matching `*_BASE_URL` HTTPS endpoint override. Google also accepts `GEMINI_BASE_URL`. A custom endpoint receives that provider's key and submitted project source, so configure only an endpoint you trust. Credentials stay in the separate worker environment. Z.ai availability uses a small authenticated completion because its documented interface does not provide the model-list route used by other adapters; that probe can incur API usage. Other adapters probe model-access endpoints. Build and review use the selected provider; the independent reviewer is a separate model call, not a separate model vendor or browser execution.

Protocols follow the official [OpenAI structured output documentation](https://developers.openai.com/api/docs/guides/structured-outputs), [Anthropic Messages API](https://platform.claude.com/docs/en/api/messages/create), [DeepSeek JSON mode](https://api-docs.deepseek.com/guides/json_mode/), [Google structured output documentation](https://ai.google.dev/gemini-api/docs/structured-output), [Kimi Chat API](https://platform.kimi.ai/docs/api/chat), and [Z.ai Chat API](https://docs.z.ai/api-reference/llm/chat-completion). Provider defaults are configuration choices, not a guarantee of account access.

## Workspace tools and preservation

The workspace separates conversation, preview, and tools on mobile. Tools expose projects, files, storage information, checkpoints, connections, and source ZIP download. File operations and checkpoint restore preserve version-conflict protection. Restore captures the current state for undo, replaces the checkpoint's full file set, and assigns new versions rather than reusing old checkpoint versions. Active builds must be finished or discarded before restore.

ZIP import/export targets the supported static HTML/CSS/JavaScript project format. It does not establish full Replit runtime compatibility or lossless preservation of arbitrary application archives. Broader independent Replit migration must retain unsupported and unfinished source, inventory manifests/databases/assets/integrations, identify secret-file handling, and produce readiness reports before execution. That full preservation and runtime workflow remains backlog. Check the current implementation status for verification of the workspace and ZIP increment.

