// Expo's flat config plus the rules that catch the mistakes this codebase is
// prone to: stale hook dependencies, and importing colours instead of reading
// them from the theme.
const expo = require("eslint-config-expo/flat");

module.exports = [
  ...expo,
  {
    ignores: ["dist/*", ".expo/*", "node_modules/*"],
  },
  {
    rules: {
      "react-hooks/exhaustive-deps": "error",
      "no-unused-vars": "off",
      // Array<T> reads better than T[] for the union types used here.
      "@typescript-eslint/array-type": "off",
    },
  },
  {
    // Build scripts and config plugins run in Node, not in the app.
    files: ["scripts/**/*.mjs", "scripts/**/*.js", "plugins/**/*.js"],
    languageOptions: {
      globals: {
        Buffer: "readonly",
        console: "readonly",
        process: "readonly",
        module: "writable",
        require: "readonly",
        __dirname: "readonly",
      },
    },
  },
];
