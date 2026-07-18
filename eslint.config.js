import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: [
      '.superpowers/**',
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-e2e/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      'packages/formats/*/gen/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...svelte.configs['flat/recommended'],
  {
    files: ['**/*.svelte'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
      },
    },
  },
];
