/**
 * Flat config, ESLint 9 (CW012 §3.5).
 *
 * `npm run lint` has been broken since ESLint 9 became the installed version:
 * there was no config of any kind, in either format, so both workspaces exited
 * 2 without linting a line. A lint script that cannot run is worse than no lint
 * script, because it is quietly counted as a check.
 *
 * One config at the root covers both workspaces rather than one each, since the
 * only real difference between them is browser globals and JSX.
 *
 * DELIBERATELY NARROW. This is not the place to adopt a style guide: turning on
 * a recommended set would produce hundreds of findings across code that is
 * already live, and the useful signal would be lost in it. The rules below are
 * the ones that catch mistakes rather than preferences, so a finding is worth
 * reading. Widening it is a separate piece of work with its own review.
 */

const NODE_GLOBALS = {
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  queueMicrotask: 'readonly',
  fetch: 'readonly',
  FormData: 'readonly',
  Blob: 'readonly',
  AbortController: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
};

const BROWSER_GLOBALS = {
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  localStorage: 'readonly',
  sessionStorage: 'readonly',
  fetch: 'readonly',
  FormData: 'readonly',
  Blob: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  console: 'readonly',
  alert: 'readonly',
  // Injected at build time by `define` in packages/web/vite.config.js. Not a
  // browser global, but it is in scope in every web source file exactly as one.
  __BUILD_ID__: 'readonly',
};

/**
 * The shared rules. Every one of these is a bug, not a style: a reference to
 * something that does not exist, a value assigned and never read, a promise
 * whose rejection is unhandled, a `case` that falls into the next.
 */
const RULES = {
  'no-undef': 'error',
  'no-unused-vars': ['error', {
    // `catch {}` with no binding is already the idiom in this codebase; where a
    // binding is needed but unused, an underscore prefix says so on purpose.
    argsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
    caughtErrorsIgnorePattern: '^_',
  }],
  'no-const-assign': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-duplicate-case': 'error',
  'no-unreachable': 'error',
  'no-fallthrough': 'error',
  'no-self-compare': 'error',
  'no-unsafe-negation': 'error',
  'no-unsafe-optional-chaining': 'error',
  'require-atomic-updates': 'off', // too noisy against the await-heavy route handlers
  'no-async-promise-executor': 'error',
  'no-await-in-loop': 'off',       // the importers and the purge are sequential on purpose
  eqeqeq: ['error', 'smart'],
};

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/uploads/**',
      '**/*.timestamp-*.mjs',
    ],
  },

  // API and the operator tools: Node, ESM.
  {
    files: ['packages/api/**/*.js', 'tools/**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: NODE_GLOBALS,
    },
    rules: RULES,
  },

  // The test suite additionally has node:test's globals in scope.
  {
    files: ['packages/api/test/**/*.js'],
    languageOptions: {
      globals: { ...NODE_GLOBALS, describe: 'readonly', it: 'readonly', before: 'readonly', after: 'readonly' },
    },
  },

  // Web: browser globals, JSX.
  //
  // `no-unused-vars` ignores capitalised identifiers here, and that is a
  // limitation rather than a preference. ESLint's core rules do not treat a
  // reference from JSX as a use, so `<Card />` does not count as using the
  // imported `Card` and every component import in the codebase is reported.
  // Four hundred false positives would make the rule worth ignoring, which is
  // how a lint script quietly stops being a check. Lowercase names — locals,
  // handlers, destructured values — are still checked, which is where a real
  // unused variable turns up. Closing the gap properly means adding
  // `eslint-plugin-react` for `jsx-uses-vars`; that is a dependency decision,
  // not a config one, so it is left for whoever widens the rule set.
  {
    files: ['packages/web/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: BROWSER_GLOBALS,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      ...RULES,
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^[A-Z_]',
        caughtErrorsIgnorePattern: '^_',
      }],
    },
  },

  // Vite's own config runs in Node, not the browser.
  {
    files: ['packages/web/vite.config.js'],
    languageOptions: { globals: NODE_GLOBALS },
  },
];
