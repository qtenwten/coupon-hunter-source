// Compatibility entry point. The maintained suites live under tests/.
require('./tests/search.test');
require('./tests/harness').run().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
