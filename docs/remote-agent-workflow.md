# Remote-agent development workflow

AffiliateOS uses a PR-first workflow so repository changes can be controlled and reviewed remotely while local tooling remains available for deeper development and database testing.

## Standard change flow

1. Start from the latest `main`.
2. Create one isolated branch for the task.
3. Make the smallest focused change that preserves existing contracts.
4. Validate with the repository checks:
   - `npm test`
   - `npm run typecheck`
   - `npm run build`
   - `npm run db:check`
5. Open a pull request against `main` with the validation and security checklist completed.
6. Review the diff and CI results before merging.
7. Merge only the reviewed PR; do not commit feature work directly to `main`.
8. Delete or stop using the task branch after merge.

## Production-safety rules

- Never add API keys, OAuth tokens, passwords, private keys, or other secrets to source, migrations, fixtures, or `.env.example`.
- Keep provider integrations behind explicit interfaces and use only approved official APIs/OAuth flows for live integrations.
- Treat credential references as opaque deployment metadata; resolve secrets through deployment infrastructure.
- Do not claim an external marketplace or social account is live unless a real, authorized provider connection has been configured and verified.
- Database migrations are append-only after release: add a new migration rather than rewriting an applied migration.
- Run `npm run db:verify` against a disposable or release-validation PostgreSQL instance before enabling traffic for a release.

## CI contract

`.github/workflows/ci.yml` runs the same four repository validation commands for pushes to `main` and pull requests targeting `main`. CI is the merge gate for repository-level correctness; deployment-specific controls such as TLS, secret-manager wiring, rate limiting, tracing, backups, and production credentials belong to the target hosting environment.

## Scope of remote work

Remote changes should stay small enough to review from a mobile device. Larger domain changes should be split into independently testable PRs. When a task depends on an external provider approval or credential, land the provider-neutral contract first and defer the live adapter until the deployment prerequisites exist.
