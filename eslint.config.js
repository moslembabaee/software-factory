import { defineConfig, globalIgnores } from "eslint/config";
import { fileURLToPath } from "node:url";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier/flat";

export default defineConfig(
  globalIgnores([
    "**/dist/**",
    "**/build/**",
    "**/coverage/**",
    "**/*.d.ts",
    "**/src/**/*.js",
  ]),
  {
    files: ["**/*.ts", "**/*.tsx"],
    // Includes @typescript-eslint/strict plus rules that require type information.
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        project: [
          "./apps/*/tsconfig.json",
          "./packages/*/tsconfig.json",
          "./tsconfig.tools.json",
        ],
        tsconfigRootDir: fileURLToPath(new URL(".", import.meta.url)),
      },
    },
  },
  prettier,
);
