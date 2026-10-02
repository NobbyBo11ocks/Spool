// Static checks. The point is to catch what `node --check` can't: references to functions/variables that don't exist
// (a scripted edit once deleted `enrichHls`, and every HLS entry silently lost its label), duplicate declarations,
// and unused code.
import globals from 'globals';

const common = {
  ecmaVersion: 2023,
  globals: { ...globals.browser, ...globals.serviceworker, chrome: 'readonly', muxjs: 'readonly' },
};
const rules = {
  'no-undef': 'error',
  'no-redeclare': 'error',
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
  'no-use-before-define': ['error', { functions: false, classes: true, variables: false }],
  'no-dupe-keys': 'error',
  'no-unreachable': 'error',
  'no-constant-condition': ['error', { checkLoops: false }],
};

export default [
  { ignores: ['node_modules/**', 'extension/lib/vendor/**', '.chrome/**'] },
  { files: ['extension/**/*.js'], languageOptions: { ...common, sourceType: 'module' }, rules },
  // The content script is a classic script wrapped in an IIFE, not a module.
  { files: ['extension/content.js'], languageOptions: { ...common, sourceType: 'script' }, rules },
  {
    files: ['tests/**/*.js', 'tests/**/*.mjs', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.node, ...globals.browser, chrome: 'readonly' } },
    rules,
  },
];
