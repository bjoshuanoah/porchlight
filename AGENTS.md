<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

---

# Porchlight Repository Contract

<!-- This section is PORCH-001's structural contract. It defines the monorepo ownership and layering rules that every contributor follows. It is the authoritative word on repo structure; the Turborepo guidance block above is a tooling note, not a repo contract. -->

## Monorepo map

```
porchlight/
├── apps/
│   ├── server/     # Express API transport + thin system health vertical (routes, controllers, service, model) — @porchlight/server (private)
│   └── web/        # Static SPA shell placeholder — @porchlight/web (private)
├── modules/
│   ├── identity/   # Identity domain: routes → controllers → services → models — @porchlight/identity (public)
│   └── social/     # Social domain: routes → controllers → services → models — @porchlight/social (public)
├── packages/
│   ├── shared/     # Domain-agnostic helpers/types shared across the module boundary — @porchlight/shared (public)
│   └── cli/        # porchlight CLI — global bin, the npm install surface (`npm install -g porchlight`) (public)
├── docs/           # Release verification instructions (signed supply-chain anchor)
├── .github/workflows/  # CI (lint/typecheck/build/test on Node 24) and Deploy (npm publish with provenance + signed GitHub Releases)
└── scripts/        # Build/lint/boundary-check/release tooling (not a published package)
```

## Module ownership map

Every domain module owns its complete route → controller → service → model path. Endpoints are traceable to exactly one owning module:

- `apps/server` routes/controllers call into `@porchlight/identity` and `@porchlight/social`; it performs no domain logic.
- `@porchlight/identity` owns all identity models and identity-only service logic.
- `@porchlight/social` owns all social models and social-only service logic.
- `@porchlight/shared` owns no domain models — only cross-domain-agnostic helpers.
- `packages/cli` (`porchlight`) is the global install surface and entrypoint; it performs no domain logic (domain behavior lands with the bring-up task) and imports no domain models.
- `apps/web` is a static shell; no server-side imports.

Cross-module rule: a module's implementation source tree is never imported by another module. A module may only import another module's **published public entry** (`@porchlight/<module>`) — never its internals (`.../models`, `.../src/...`), and never its models. `identity` and `social` share zero models and never import each other's internals. `@porchlight/shared` is the sole permitted cross-module import; `@porchlight/server` and `@porchlight/web` are private and never imported by name.

## Layer convention

Business logic lives exclusively in the service layer. Routes carry the REST and MCP transport surfaces; controllers are transport-specific factories that translate between HTTP and the domain; controllers call services; services own the models. Routes and controllers must never perform domain operations (no model reads/writes, no business rules).

```
route (REST/MCP surface)
   → controller (transport-specific)
      → service (business logic + models)   ← the only layer with domain state
```

## Testing requirements

- Every module ships co-located unit tests at `<module>/test/**` run with `node --test`.
- Integration-level (package-level) tests live under the package and cover cross-package behavior.
- `apps/server` ships MUI-less API contract tests proving the vertical slice (health, identity, social routes), plus a co-located unit test for the system health service.
- `npm run test` at the repo root runs `turbo run test` then the boundary check — it is the one command that runs the whole test matrix locally.
- `npm run lint` (turbo lint) runs ESLint per workspace against the root flat config; `npm run typecheck` (turbo typecheck) typechecks TS workspaces. CI runs `turbo run lint typecheck build test --affected` on Node 24, scoped to changed workspaces plus their dependents.
- Published releases are verified with `node scripts/release/verify-release.mjs` — instructions in `docs/release-verification.md`.

## Enforcement (CI)

`npm run boundary` (or `node scripts/boundary-check.mjs`) fails the build on:

1. a cross-module import (a module reaching into another module's source tree);
2. a module importing another module's models (identity/social share zero models); or
3. a model shared between the identity and social domains.

This check runs in CI on every push and pull request (`.github/workflows/ci.yml`).

## Contribution flow

1. Create an agent-owned branch off the repository default (`main`).
2. Make the change, add or update co-located tests, run `npm run test` and `npm run lint` locally and ensure both are green.
3. Open a pull request from the agent-owned branch onto `main`.
4. CI runs `turbo run lint typecheck build test --affected` (Node 24) plus the boundary check; merge once green.

## License surface

MIT is the license of record. `LICENSE` sits at the repo root; every published package declares `"license": "MIT"` and `"publishConfig": { "access": "public" }`. Node engine floor is `>= 24` across the monorepo. Every `npm publish` runs with provenance (`.npmrc` `publish-provenance=true`, attested by the deploy workflow's GitHub Actions OIDC token).

## Non-binding note

This contract governs the source layout and architecture of the Porchlight monorepo. It does not assert authority over the operator's local environment (machine, Node version) or over public-repository ownership/deployment decisions.
