# Contributor instructions

Read `DEALFLOW.md`, `README.md`, and `docs/IMPLEMENTATION_STATUS.md` before implementation decisions. Inspect the repository, branch, commit state, existing implementation, and other contributors' changes; do not treat prior conversation claims as evidence that files exist.

- Build the development platform itself. Mortgage application requirements belong to applications built on the platform and must not replace its workspace mission.
- Preserve useful and unfinished work. Use reviewable isolated changes; no force pushes, destructive resets, merging to main, or production deployments without authorization.
- Keep architecture decisions and verified status in repository documentation. PostgreSQL changes require migrations.
- Use synthetic data. Never commit secrets, private account details, borrower data, private exports, or raw conversations. Public-safe engineering requirements are appropriate documentation.
- Keep project execution out of the control-plane process. Do not pass control-plane secrets to preview or agent workers. Unsupported agents/runtimes must appear unavailable, never simulated.
- Coordinate file ownership and dependencies before parallel work. Durable state, structured events, real checks, and conflict protection matter more than chat progress claims.
- Maintain accessible, responsive design and complete loading, empty, error, and conflict states. Review desktop and mobile screens after UI changes.
- Run checks appropriate to the change, including the complete create/edit/save/reload/preview/stop journey for relevant changes. Record exact commands, outcomes, screenshots, and blockers. Do not describe unexecuted tests as passing.
- Update implementation status before handoff. Preserve the entire MVP backlog; a first increment is not platform completion. Owner approval remains the product/design acceptance gate.
