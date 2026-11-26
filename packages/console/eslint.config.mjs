// Local flat config for the console workspace. ESLint resolves the nearest
// config to the cwd, so this (not the repo root config) governs `npm run
// lint` here. The console is the second browser workspace: its SPA runs on
// window/document globals, while its node --test suites stay node-scoped,
// so both global sets are declared (mirroring the repo root's apps/web
// override).
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
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
);
