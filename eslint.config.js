// Flat-config ESLint setup for the FlashAware monorepo.
//
// Goals (in priority order):
//   1. Catch floating promises in server alert/dispatch paths
//      (`@typescript-eslint/no-floating-promises`) — the original motivation
//      for adding a linter at all. A forgotten `await` in alertService or
//      riskEngine is a silent failure mode in a safety-of-life system.
//   2. Catch React hooks misuse (exhaustive-deps, rules-of-hooks).
//   3. Stay out of Prettier's way for stylistic concerns.
//
// Type-aware rules are scoped to `server/**` only — running them across
// `client/src/**` as well would double lint time without strong payoff,
// and the hooks rules already cover the client's biggest correctness gap.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';

const NODE_GLOBALS = {
  process: 'readonly',
  console: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  require: 'readonly',
  module: 'readonly',
  exports: 'readonly',
  global: 'readonly',
  Buffer: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  clearImmediate: 'readonly',
  NodeJS: 'readonly',
};

const BROWSER_GLOBALS = {
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  console: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  fetch: 'readonly',
  localStorage: 'readonly',
  sessionStorage: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  HTMLElement: 'readonly',
  HTMLButtonElement: 'readonly',
  HTMLInputElement: 'readonly',
  HTMLDivElement: 'readonly',
  Element: 'readonly',
  Event: 'readonly',
  KeyboardEvent: 'readonly',
  MouseEvent: 'readonly',
  CustomEvent: 'readonly',
  alert: 'readonly',
  confirm: 'readonly',
  prompt: 'readonly',
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      'server/client-dist/**',
      'client/dist/**',
      '.claude/**',
      '**/*.config.{js,ts,mjs,cjs}',
      'client/vite.config.ts',
      'server/vitest.config.ts',
      'server/vitest.integration.config.ts',
      'server/scripts/**',
      'ingestion/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Server (TypeScript) — Node runtime + type-aware rules for the alert/dispatch paths.
  {
    files: ['server/**/*.ts'],
    ignores: ['server/tests/**', 'server/scripts/**'],
    languageOptions: {
      globals: NODE_GLOBALS,
      parserOptions: {
        project: './server/tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { arguments: false, attributes: false } },
      ],
      // Server has a few legitimate lazy-`require()` calls in shutdown/startup
      // paths to avoid circular imports. Allow them.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  // CommonJS Node scripts (db/apply_schema.js etc.).
  {
    files: ['db/**/*.js', '**/*.cjs'],
    languageOptions: {
      globals: NODE_GLOBALS,
      sourceType: 'commonjs',
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  // ESM Node scripts under scripts/ (check-env-example.mjs etc.).
  {
    files: ['scripts/**/*.{js,mjs}'],
    languageOptions: {
      globals: NODE_GLOBALS,
      sourceType: 'module',
    },
  },

  // Client: React hooks correctness + browser globals.
  {
    files: ['client/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      globals: BROWSER_GLOBALS,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },

  // Pragmatic project-wide overrides.
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },

  // Tests: relax a few rules that get noisy in test fixtures.
  {
    files: ['**/tests/**/*.{ts,tsx}', '**/*.test.{ts,tsx}'],
    languageOptions: {
      globals: NODE_GLOBALS,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  // Must come last — turns off stylistic rules that fight Prettier.
  prettier,
);
