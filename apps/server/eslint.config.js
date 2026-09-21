// typescript-eslint's recommended set over @eslint/js recommended, one config per
// workspace as CONVENTIONS.md asks; the compiled output is not linted.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(js.configs.recommended, ...tseslint.configs.recommended, {
  ignores: ['dist/**'],
}, {
  rules: {
    // Fires once on existing code (eval/run.ts: analyse() takes a model it never reads); visible, not fatal.
    '@typescript-eslint/no-unused-vars': 'warn',
  },
});
