// ESLint 9 flat config for the porchlight monorepo (PORCH-002 ac-1 lint task).
// One config at the repo root; each workspace's `lint` script (`eslint .`)
// resolves this config by walking up directories.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      // Ephemeral test workspace: apps/web's brand-lockup test builds and
      // removes it mid-run; turbo runs lint and test concurrently, and an
      // eslint traversal inside its brief lifetime fails with a scandir
      // ENOENT race (CI flake observed on clean runners). The test's
      // sibling code stub (.lockup-stub.mjs) rides the same brief lifetime
      // and the same race (seen as an eslint "open /apps/web/test/
      // .lockup-stub.mjs" ENOENT on a clean runner) — ignored as well.
      "apps/web/test/.tmp-lockup/**",
      "apps/web/test/.lockup-stub.mjs",
      // The bundled render sweeps build their module copy into .tmp<task>
      // directories mid-run and remove them at the suite's end; turbo runs
      // lint and test concurrently, and an eslint traversal inside that
      // brief lifetime races the same way the lockup one did.
      "apps/web/test/.tmp*/**",
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.es2024,
      },
    },
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // apps/web is the one browser workspace: the SPA runs on window/document
    // globals the node-scoped defaults do not define. Node globals stay
    // available for its scripts and node --test suites.
    files: ["apps/web/**"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
  },
);