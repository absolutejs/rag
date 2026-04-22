import globals from "globals";
import tseslint from "typescript-eslint";
import absolutePlugin from "eslint-plugin-absolute";
import promisePlugin from "eslint-plugin-promise";

export default [
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "build/**",
      ".rag/**",
      ".github/**",
    ],
    linterOptions: {
      reportUnusedDisableDirectives: "off",
    },
  },
  {
    files: ["**/*.{ts,tsx,js,mjs,cjs}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
      globals: {
        ...globals.node,
        ...globals.browser,
        Bun: "readonly",
      },
    },
    plugins: {
      absolute: absolutePlugin,
      promise: promisePlugin,
    },
    rules: {
      "no-debugger": "error",
      "no-duplicate-case": "error",
      "no-dupe-else-if": "error",
      "no-unreachable": "error",
      "no-unsafe-finally": "error",
    },
  },
];
