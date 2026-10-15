# Software Factory full-build pack v6.3

This is a specification pack, not implemented software. v6.3 preserves all v6.2 files and adds binding consumer-experience requirements 49–53, covering simple-mode workflow, verified previews, visual feedback, cost, recovery, delivery and test gates. See docs/00_START_HERE.md.

# Software Factory Full Build Pack v6.2

Full scope retained. Start with docs/00_START_HERE.md and docs/48_DETERMINISTIC_ACCEPTANCE_AND_HANDOFF.md. This archive contains specifications and **reference** SQL/OpenAPI contracts, not a built product. The reference contracts require expansion for all capability families before implementation acceptance.


Version 6.5 adds release evidence gates, immutable version-binding rules, concurrency policy and negative security/consumer test matrix. The ZIP contains specifications, not working application code.

For the TypeScript workspaces, `tsconfig.json` defines the shared strict compiler
options and references every app and package. Each workspace extends it and
includes its own source files. The root is a solution config with no source files;
`npx tsc --noEmit` checks that config, while `npm run typecheck` checks the source
in every workspace. Run `npm run typecheck && npm test` to verify changes.
