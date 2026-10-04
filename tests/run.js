require('./parser.test');
require('./checkout.test');
require('./storage.test');
require('./promo-intelligence.test');
require('./promo-feed.test');
require('./feed-signature.test');
require('./production-feed.test');
require('../collector/tests/collector.test');
require('../collector/tests/feedico.test');
require('./page-adapter.test');
require('./safety.test');
require('./promo-tester.test');
require('./verifier-behavior.test');
require('./search.test');
require('./manifest.test');
require('./workflow.test');

require('./harness').run().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
