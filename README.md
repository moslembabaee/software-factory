# Software Factory full-build pack v6.3

This is a specification pack, not implemented software. v6.3 preserves all v6.2 files and adds binding consumer-experience requirements 49–53, covering simple-mode workflow, verified previews, visual feedback, cost, recovery, delivery and test gates. See docs/00_START_HERE.md.

# Software Factory Full Build Pack v6.2

Full scope retained. Start with docs/00_START_HERE.md and docs/48_DETERMINISTIC_ACCEPTANCE_AND_HANDOFF.md. This archive contains specifications and **reference** SQL/OpenAPI contracts, not a built product. The reference contracts require expansion for all capability families before implementation acceptance.


Version 6.5 adds release evidence gates, immutable version-binding rules, concurrency policy and negative security/consumer test matrix. The ZIP contains specifications, not working application code.

TypeScript workspaces extend `packages/tsconfig/base.json`. It enables strict
checking, exact optional properties, checked indexed access, unused-code checks,
and declaration checking. `tsconfig.base.json` and the package's `strict.json`
are compatibility aliases for that same configuration. Each source workspace
sets its own `rootDir` and `outDir`, so generated files stay in its ignored
`dist/` directory. The root `tsconfig.json` is a solution containing project
references; the config-only package is not a build target.

Run `npm install` to install the shared compiler and development tools, then:

- `npm run build` (or `npx tsc --build`) builds all referenced projects.
- `npm run typecheck` and `npm run lint:tsc` check every referenced workspace
  through the same incremental build. `tsc --noEmit` on the root solution alone
  does not traverse project references.
- `npm test` runs the TypeScript unit tests and a compiler regression check. The
  latter builds an isolated fixture using the real configurations, introduces
  an intentional type error in every source workspace, and checks that
  `lint:tsc` reports each one.
- `npm run lint` applies the TypeScript-ESLint strict type-checked flat preset.
- `npm run format` / `npm run format:check` use the shared `.prettierrc`.
- `npm run dev` starts the Fastify API with `tsx watch` and the API's strict
  TypeScript configuration. The runner transpiles; run `npm run typecheck` for
  compiler diagnostics.

New source workspaces should extend the shared base, set local build output
paths, and add their `tsconfig.json` to the root references. Add references to
upstream workspace projects as dependencies are introduced. Workspace compiler
configs also include local `*.config.ts` files; root tooling uses
`tsconfig.tools.json`. Run `npm run typecheck && npm test` to verify changes.
