import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "node_modules/**", ".tmp/**", "playwright-report/**", "test-results/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["public/**/*.js"],
    languageOptions: {
      globals: { document: "readonly", window: "readonly", history: "readonly", location: "readonly", fetch: "readonly", URLSearchParams: "readonly", FormData: "readonly", Event: "readonly" }
    }
  }
);
