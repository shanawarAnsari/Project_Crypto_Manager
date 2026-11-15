import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const deepImportPattern = {
  group: ['@sunny/*/*'],
  message: 'Import packages through their public entry point only (no deep imports).',
};

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/coverage/**', '**/.turbo/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      'no-restricted-imports': ['error', { patterns: [deepImportPattern] }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // Engine modules expose a public interface (index.ts) only: no reaching into a sibling module's internals.
    files: ['apps/engine/src/modules/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            deepImportPattern,
            {
              group: ['../*/*'],
              message: 'Do not import another module internals; use its index.ts public interface.',
            },
          ],
        },
      ],
    },
  },
  {
    // Only the exchange-sdk may know an exchange exists; nothing else may reference Delta hosts directly.
    files: ['apps/**/*.{ts,tsx}', 'packages/{db,trading-core,risk-core}/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/delta\\.exchange/]',
          message: 'Exchange hosts belong in config / exchange-sdk only.',
        },
      ],
    },
  },
);
