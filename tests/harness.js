const assert = require('node:assert/strict');

const tests = [];
let assertions = 0;

function test(name, fn) { tests.push({ name, fn }); }

const t = {
  equal(actual, expected, message) { assertions += 1; assert.equal(actual, expected, message); },
  ok(value, message) { assertions += 1; assert.ok(value, message); },
  match(value, pattern, message) { assertions += 1; assert.match(String(value), pattern, message); },
  deep(actual, expected, message) {
    assertions += 1;
    assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message);
  }
};

async function run() {
  for (const row of tests) {
    try { await row.fn(t); }
    catch (error) { error.message = `${row.name}: ${error.message}`; throw error; }
  }
  console.log(`Coupon Hunter tests: OK (${tests.length} scenarios, ${assertions} assertions)`);
}

module.exports = { test, run };
