module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/*.spec.ts'],
  verbose: true,
  // Compiles the app to dist/ once, before any test runs.
  // The e2e tests start the COMPILED app as a real child process.
  globalSetup: '<rootDir>/test/global-setup.js',
  testTimeout: 20000,
};
