// Compatibility entry point. The maintained suites live under tests/.
require('./tests/checkout.test');
require('./tests/storage.test');
require('./tests/safety.test');
require('./tests/promo-tester.test');
require('./tests/verifier-behavior.test');
require('./tests/harness').run().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
