/** @type {import('jest').Config} */
export default {
  testEnvironment: 'node',
  transform: {},
  testMatch: ['**/test/**/*.test.js'],
  // '/vendor/*' absolute specifiers (e.g. '/vendor/purify.es.mjs') only resolve at
  // runtime via server.js's Express route (VENDOR_FILES) — there's no file on disk
  // at that path. Map them back to the real node_modules package so importing a
  // module under test doesn't throw "Cannot find module" (see test/sanitize.test.js).
  moduleNameMapper: {
    '^/vendor/purify\\.es\\.mjs$': '<rootDir>/node_modules/dompurify/dist/purify.es.mjs',
    '^/vendor/marked\\.esm\\.js$': '<rootDir>/node_modules/marked/lib/marked.esm.js',
  },
};
