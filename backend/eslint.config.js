import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import react from "eslint-plugin-react";
import globals from "globals";

// Browser globals stay scoped to the React entry points.
export default [
  { ignores: ["**/dist/**", "data/**", "**/coverage/**"] },
  js.configs.recommended,
  { files: ["**/*.js"], languageOptions: { globals: globals.node } },
  {
    files: ["frontend/src/**/*.js"],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["frontend/src/**/*.jsx"],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { "react-hooks": reactHooks, react },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "react/jsx-uses-vars": "error",
    },
  },
];
