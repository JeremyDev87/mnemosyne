import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "coverage/**",
      "node_modules/**",
      ".tmp/**",
      ".next/**",
      ".webpack/**",
      "out/**",
      "playwright-report/**",
      "test-results/**"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "src/**/*.tsx", "tests/**/*.ts", "e2e/**/*.ts", "playwright.config.ts", "eslint.config.mjs"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node }
    }
  },
  {
    files: ["*.cjs"],
    languageOptions: { globals: globals.node },
    rules: { "@typescript-eslint/no-require-imports": "off" }
  }
);
