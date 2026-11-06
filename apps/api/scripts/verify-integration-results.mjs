// Fails unless the required database integration suites executed, passed and were not skipped.
// Usage: node scripts/verify-integration-results.mjs <vitest-json-results-file>
import { readFileSync } from 'node:fs';

const REQUIRED = ['migrations', 'vector-column', 'health', 'mcp-e2e', 'usage-storage'];
const file = process.argv[2];
if (!file) {
  console.error('usage: verify-integration-results.mjs <results.json>');
  process.exit(2);
}
const results = JSON.parse(readFileSync(file, 'utf8'));
const problems = [];
for (const name of REQUIRED) {
  const suite = results.testResults.find((r) => r.name.endsWith(`/${name}.integration.spec.ts`));
  if (!suite) {
    problems.push(`${name}.integration.spec.ts did not run`);
    continue;
  }
  const tests = suite.assertionResults;
  const passed = tests.filter((t) => t.status === 'passed').length;
  if (suite.status !== 'passed' || tests.length === 0 || passed !== tests.length) {
    problems.push(`${name}.integration.spec.ts: ${passed}/${tests.length} tests passed (status ${suite.status}); skipped or failed tests are not allowed in CI`);
  }
}
if (problems.length) {
  console.error(`Required integration suites did not execute:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`Verified required integration suites executed and passed: ${REQUIRED.join(', ')}`);
