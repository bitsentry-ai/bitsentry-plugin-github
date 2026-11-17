# GitHub plugin

`@bitsentry/plugin-github` is a BitSentry code plugin for GitHub repositories and issues. BitSentry loads it through `@bitsentry/plugin-sdk`, so its descriptor and action results are a public contract.

## What we never compromise on

- **Reads and writes are labeled honestly.** `list_organizations`, `list_projects`, `list_issues` and `query_issues` are `read`. `create_issue` is `write` and creates a real issue. Hosts gate writes on `riskLevel`, so any new action that changes GitHub must be `write`.
- **Credentials stay in auth.** The `accessToken` comes from host-managed auth. Never log it, return it in `data`, or put it in error summaries.
- **Correct results.** Pagination must not drop or double-count issues. The issues API also returns pull requests; those are skipped, and paging continues past them.

## The ways to hurt yourself

1. **Writing to real repositories.** Never run `create_issue`, or any action, against a real GitHub account unless the developer asks. Tests stub `fetch`.
2. **Unbounded requests.** Requests honor the host's `operation.signal` and `operation.deadlineAt`.
3. **Breaking the contract.** Renaming an action id, field key or result field breaks saved runbooks and hosts. Add, do not rename.

## Verifying

CI runs these. Run them before you push:

```sh
pnpm install --frozen-lockfile
pnpm run format
pnpm run lint
pnpm test
pnpm run build
pnpm pack --dry-run
pnpm knip
```

Behavior changes ship with a focused test in `src/plugin.spec.ts`. Bug fixes get a failing test first.

## Pull requests

- Never open a PR unless the developer asks. Branch from the latest `origin/main`.
- Titles and every commit subject are lowercase conventional commits: `fix(github): page past pull requests for issues`. `change-guardrails.yml` checks them.
- Body: `## Problem`, `## Change`, `## Tests`.
- Pushing a `v*` tag publishes a GitHub release. Keep `version` in `package.json` and the descriptor in step.
- Do not add `Co-Authored-By` lines or AI attribution footers.

## Where code lives

- `src/plugin.ts`: descriptor, auth fields (`accessToken`, `owner`, `repos`, `apiBase`), actions and the GitHub API client.
- `src/plugin.spec.ts`: Vitest tests.
- `scripts/eslint/`: the TypeScript 6 lint bridge.

## Taste

- Fail loudly and specifically. An empty result must mean "nothing found", not "the request failed".
- Comments say why. Plain language in summaries. No em-dashes.
