// ESLint flat config (ESLint 10). DEV-ONLY: this and its devDependencies live in the
// private root package.json and are never installed with the plugin (which ships only
// plugins/claude-context/ and imports only `node:` built-ins).
//
// Recommended rules, with two allowances for this codebase's intentional patterns:
//   - empty catch blocks are deliberate best-effort cleanup (e.g. unlink a temp file)
//   - `const { updated_at, ...rest } = s` strips a field via a rest sibling
import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { ignoreRestSiblings: true }],
    },
  },
  // Vendored reference checkout and scratch space are not ours to lint.
  { ignores: ['claude-hud/', 'scratch/'] },
];
