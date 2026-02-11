// ESLint configuration for NetMap
// Using .cjs because project is type: module
module.exports = {
  env: {
    es2022: true,
    node: true,
    browser: true
  },
  extends: [
    'eslint:recommended'
  ],
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module'
  },
  rules: {
    // Errors
    'no-unused-vars': ['warn', {
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_'
    }],
    'no-undef': 'error',

    // Best practices
    'prefer-const': 'warn',
    'no-var': 'error',
    'eqeqeq': ['warn', 'always', { null: 'ignore' }],

    // Allow empty catch blocks (intentional error swallowing in network code)
    'no-empty': ['error', { allowEmptyCatch: true }],

    // Allow control characters in regex (needed for ANSI/Telnet parsing)
    'no-control-regex': 'off',

    // Warn on useless escapes (some are intentional for clarity)
    'no-useless-escape': 'warn',

    // Allow function declarations inside blocks (legacy code pattern)
    'no-inner-declarations': 'off',

    // Style (handled by Prettier, so off)
    'semi': 'off',
    'quotes': 'off',
    'indent': 'off',
    'comma-dangle': 'off',

    // Allow console (it's a CLI app)
    'no-console': 'off',

    // Async
    'no-async-promise-executor': 'warn',
    'require-await': 'off'
  },
  ignorePatterns: [
    'node_modules/',
    'public/img/',
    '*.min.js',
    'dist/',
    '.worktrees/'
  ],
  globals: {
    // Browser globals for public/*.html inline scripts
    'fetch': 'readonly',
    'document': 'readonly',
    'window': 'readonly',
    'localStorage': 'readonly',
    'alert': 'readonly',
    'confirm': 'readonly',
    'vis': 'readonly'
  }
};
