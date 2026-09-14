# DealFlow Builder — standing engineering requirements

This public-safe specification preserves the product and engineering requirements. It intentionally excludes private account inventories and raw task conversations. The first runnable increment does not replace or complete these requirements.

## Product and ownership

Build an owner-controlled, Replit-like development platform with coordinated AI agents. The owner describes work, reviews previews, tests, gives plain-language corrections, and approves results. The platform organizes routine engineering: branches, containers, databases, CI/CD, infrastructure, and coordination. Prioritize design, correct functionality, reliability, speed, portability, ownership, and low operational burden.

GitHub is the permanent source of truth for code and project configuration. Document material architecture and product decisions in the repository and update this specification when foundations change. Use database migrations and auditable material actions. Reconstruct the system from source, infrastructure definitions, backups, configuration, and documented secrets restoration procedures. No unreviewed production deployment.

## Coordinated execution

The target is one persistent development organization, not disconnected chat sessions. A substantial job may use one lead/orchestrator, four to eight build agents where separable, two to four review/QA agents, specialists, and one final integration agent. Scale according to real resources and independent work; do not fabricate execution or impose an arbitrary low product ceiling. Specialists include UI, API, migrations, QA, security, infrastructure/AWS, accessibility, performance, mobile, integrations, documentation, and migration analysis.

Support Normal (economical), Hard (aggressive and preferred for substantial work), and War Room (maximum practical concurrency for major releases, migrations, incidents, or deadlines). Expose understandable progress without making the owner manage agents individually.

All agents share durable project/workspace identity, repository and commit state, task graph and dependencies, architecture decisions, file ownership/locks, agent status, build/test results, preview environments, merge queue, and event history. Structured events include `TASK_STARTED`, `TASK_COMPLETED`, `FILES_CHANGED`, `ARCHITECTURE_DECISION`, `DEPENDENCY_BLOCKED`, `TEST_FAILED`, `TEST_PASSED`, `READY_FOR_REVIEW`, `REVIEW_REJECTED`, and `READY_TO_MERGE`. Chat memory is not a coordination store.

Use isolated branches/worktrees and execution containers/workspaces, explicit scopes and acceptance criteria, dependency tracking, merge/rebase controls, and integration checks. Sequence overlapping files deliberately. Before integration, resolve conflicts, pass relevant checks, complete code review, and visually review UI changes. A replaceable provider interface must not imply an agent is connected when it is not.

## Speed and design

Optimize time to first visible change. Target warm worker pools, parallel launches, prebuilt snapshots, dependency/build caches, background indexing, incremental tests, full regression before merge, fast previews, and reusable development environments. Show meaningful actual progress instead of indefinite generic spinners.

Maintain a consistent design system for typography, spacing, buttons, inputs/forms, cards/tables, color, navigation, empty/loading/error states, responsive behavior, accessibility, and interactions. No dead controls, invented results, placeholder junk, unfinished screens, broken mobile layouts, or unexplained workflow gaps. Translate plain-language design criticism into actionable changes. Important screens need dedicated UI/UX review.

A meaningful feature requires correct behavior, intentional polished design, consistency, passing relevant and regression tests, and owner approval of the live result. Use screenshots/visual regression where practical. Browser QA covers navigation, core interactions, validation, loading/errors, responsiveness, and borrower/lender journeys when those applications are in scope. Functional QA should actively try to break changes. Security-sensitive and production-impacting work requires security review.

## Applications built on the platform

Mortgage/fintech applications are supported product requirements, not a substitute for building this development workspace. Their trust-first palette is navy `#0B1F3A`, action blue `#0057D9`, success green `#067647`, background `#F7F9FC`, white `#FFFFFF`, text `#1D2939`, and sparse urgency orange `#C94A00`. Blue denotes next action, green actual success, orange rare attention; final submit turns green only when complete. Borrower UX is warm, simple, plain-language, mobile-first, and low cognitive load with visible progress and small wins. Lender/loan-officer UX is denser and operational with fast access to detail. Both should feel precise, modern, premium, and trustworthy.

Borrower and lender applications share a controlled core: authentication, organizations, users, roles/personas, borrower/loan models, workflows, documents, notifications, audit trail, secure object/file storage, PostgreSQL, and an integration gateway. Use replaceable adapters for CIC/MeridianLink, Encompass, pricing, AUS, verification, e-sign, and additional providers. Avoid disconnected monoliths and vendor coupling.

## Full MVP backlog

- Project dashboard and creation; project templates; independent project import and safe Replit ZIP import.
- File tree and browser editor; real run/stop, disposable live previews, logs, and test runner.
- Agent orchestration hooks and coordinated execution with durable shared state.
- CI, Docker/PostgreSQL scaffolding, broader isolated runtimes, and infrastructure portability.
- Separate development, test, staging, and production environments.

The first supported runtime may be static HTML/CSS/browser JavaScript. This is not full-stack runtime support. Never execute imported/generated project code in the control plane or expose control-plane credentials to previews. Unsupported capabilities must be explicit rather than represented by fake activity, logs, checks, integrations, or URLs.

## Independent Replit migration

Import each project independently first. Preserve unfinished, experimental, and unused code initially. Inventory frontend/source, backend, manifests and lockfiles, database schema/migrations, environment variable names and purposes (never required secret values), assets, build/run commands, APIs/integrations, tests, documentation, and Replit-specific services. Classify findings as `KEEP`, `REPAIR`, `REFACTOR`, `REPLACE`, or `MISSING`; produce a per-project readiness report. Do not require the owner to categorize folders before analysis.

ZIP import must be safe: reject traversal/absolute paths and unsafe links; enforce archive expansion, count, and size limits; detect sensitive files without publishing their contents; never execute archive code during inspection. Separate each import from other projects and preserve source provenance. These controls are acceptance requirements for the future importer, not claims of implemented functionality.

## Security, infrastructure, and environments

Use synthetic data during initial development. Do not request passwords, private keys, production API/database secrets, recovery codes, or borrower PII in chat. Never commit secrets. Real consumer data requires dedicated production security/compliance hardening. Keep important actions auditable.

Target GitHub, Docker, PostgreSQL, AWS, Cloudflare, infrastructure-as-code such as Terraform, and a browser control plane. Use Cloudflare for appropriate DNS/edge/security/routing. Preserve existing domains, websites, and email; no unnecessary moves. Maintain owned source, migrations, container and infrastructure definitions, backups, configuration documentation, secrets restoration procedures, and replaceable services to avoid lock-in.

Development, test, staging, and production must remain separate. Keep production secrets out of dev/test, make previews disposable, deployments reproducible, and releases reversible. Do not purchase services, provision paid infrastructure, change DNS, deploy production, or merge without approval.

## Definition of done

For meaningful product work, require implemented code, passing tests/build/integration checks as applicable, UI/UX and visual-regression review, functional QA, appropriate security review, a real live preview, and owner acceptance. Record blockers honestly and distinguish implemented, verified, unverified, and not built. Preserve useful existing work and prepare reviewable changes. A working slice is not completion of the full platform.
