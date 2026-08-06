import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "node_modules/**", ".tmp/**", ".next/**", "playwright-report/**", "test-results/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["public/**/*.js", "app/**/*.ts", "app/**/*.tsx", "components/**/*.ts", "components/**/*.tsx", "lib/**/*.ts", "src/**/*.ts", "tests/**/*.ts", "scripts/**/*.ts", "eslint.config.js", "vitest.config.ts", "playwright.config.ts"],
    languageOptions: {
      globals: { document: "readonly", window: "readonly", history: "readonly", location: "readonly", fetch: "readonly", URLSearchParams: "readonly", FormData: "readonly", Event: "readonly" }
    }
  }
);
