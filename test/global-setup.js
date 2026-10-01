// Runs once before all tests: compile the app so e2e tests can start the real thing.
const { execSync } = require('child_process');

module.exports = async () => {
  execSync('npx tsc -p tsconfig.build.json', { stdio: 'inherit' });
};
