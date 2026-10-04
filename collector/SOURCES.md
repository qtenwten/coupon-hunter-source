# Promo source registry 3.1

| Source | Scope | Interface | Runtime status |
|---|---|---|---|
| CouponAPI | AliExpress platform codes from subscribed feed | Documented incremental API; `COUPONAPI_KEY` | Adapter ready; disabled without key |
| Feedico | Catalog codes filtered to AliExpress | `POST /api/v1/catalog/coupons`; `FEEDICO_TOKEN` | Adapter ready; coverage unconfirmed without account token |
| AliGate | Seller coupons for explicit `store_num` | RapidAPI `/api/v2/seller/coupons` | Adapter ready; disabled without key and seller scope |
| SimplyCodes | Potential verified-code source | Public site states API/MCP exists | `REQUIRES_PROVIDER_ACCESS`; no scraping |
| AliExpress Open Platform | Official | Documented catalog reviewed | `NO_CONFIRMED_BUYER_PROMO_ENDPOINT`; seller marketing APIs are not treated as global buyer codes |
| Manual curated JSON | Maintainer data | Local JSON | Enabled, intentionally empty |
| Reddit | Community | Approved OAuth Data API only | Disabled; no HTML scraping |

Research references:

- CouponAPI incremental feed: https://couponapi.org/help/knowledgebase.php?article=59
- Feedico documentation: https://feedico.io/docs
- Feedico global catalog: https://feedico.io/global-coupon-api
- SimplyCodes API/MCP data statement: https://simplycodes.com/privacy
- AliGate API and seller coupons: https://aligate.io/
- AliExpress deprecated Affiliate API: https://open.alitrip.com/docs/doc.htm?articleId=118193&docType=1&treeId=674
- AliExpress seller marketing coupon API: https://developer.alibaba.com/docs/api.htm?apiId=33119

Ни один adapter не использует CAPTCHA bypass, proxy rotation, stealth browsing, login automation, private/undocumented AliExpress endpoints или HTML scraping coupon sites.
