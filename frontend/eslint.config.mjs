import parser from "@typescript-eslint/parser";
import typescript from "@typescript-eslint/eslint-plugin";
import react from "eslint-plugin-react";

export default [
  { ignores: [".next/**", "node_modules/**", "public/**"] },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: { "@typescript-eslint": typescript, react },
    settings: { react: { version: "18.3" } },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "react/jsx-key": "error",
    },
  },
];
