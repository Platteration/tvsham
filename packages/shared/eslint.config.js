// typescript-eslint's recommended set over @eslint/js recommended, one config per
// workspace as CONVENTIONS.md asks; the compiled output is not linted.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(js.configs.recommended, ...tseslint.configs.recommended, {
  ignores: ['dist/**'],
});
