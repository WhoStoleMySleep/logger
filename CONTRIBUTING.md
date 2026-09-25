# Contributing to @wsms/logger

Thanks for taking the time to contribute! :sparkles:

The following is a set of guidelines for contributing to **@wsms/logger**. These are mostly guidelines, not strict rules. Use your best judgment, and feel free to propose changes to this document in a pull request.

## How Can I Contribute?

### Reporting Bugs

- Use the **GitHub Issues** tracker
- Use a clear and descriptive title
- Describe the exact steps to reproduce the problem
- Provide specific examples (code snippets, log output, environment: Node version, OS)
- Describe the behavior you observed after following the steps
- Explain which behavior you expected to see instead and why

### Suggesting Enhancements

- Use GitHub Issues → choose the "Feature request" template
- Use a clear and descriptive title
- Provide as many details and examples as possible
- Describe the current behavior and the behavior you would like

### Pull Requests

1. Fork the repo and create your branch from `main`
2. Add or update tests for new and changed behavior (jest)
3. Ensure the suite passes: `npm test` and `npm run typecheck`
4. Run `npm run format` and `npm run lint`
5. If you touched the build, the entry points or `package.json`, run `npm run build && npm run smoke` — it packs the tarball and loads it the way a consumer would
6. Update README.md for behavior changes, and DESIGN.md when the reasoning behind a decision changes
7. Write conventional commits (feat:, fix:, perf:, chore:, …) — semantic-release reads them
8. Open the pull request against the `main` branch

We use **semantic-release** → please write conventional commits.

## Development Setup

```bash
git clone https://github.com/WhoStoleMySleep/logger.git
cd logger
npm install
npm run build      # tsup
npm test           # jest
npm run typecheck  # tsc, sources and tests
npm run lint       # biome check
npm run format     # biome format --write
npm run smoke      # load the packed tarball as a consumer
npm run bench      # throughput numbers
```

Git hooks (husky):

| Hook | What runs |
|---|---|
| `pre-commit` | `lint-staged` — biome lint and format on staged files |
| `commit-msg` | `commitlint` — the conventional-commit prefix |
| `pre-push` | `npm run typecheck` and the full test suite |

CI repeats lint, formatting, typecheck, tests, the build and the smoke test on
Node 18, 20, 22 and 24. Design decisions and known gaps live in
[DESIGN.md](DESIGN.md). 

Happy to review small & focused PRs.

Thank you! ♥
