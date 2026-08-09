# Changelog

## [0.2.1](https://github.com/capawesome-team/revenue-sdk/compare/v0.2.0...v0.2.1) (2026-08-09)


### Bug Fixes

* **lemon-squeezy:** clear `trial_ends_at` on plan changes ([9f8b51f](https://github.com/capawesome-team/revenue-sdk/commit/9f8b51f667060e2a3daee119ea00efe0619224b3))

## [0.2.0](https://github.com/capawesome-team/revenue-sdk/compare/v0.1.0...v0.2.0) (2026-08-08)


### ⚠ BREAKING CHANGES

* **types:** WebhookEvent payload fields require narrowing on event.type; un-narrowed access no longer compiles.
* the provider response body moved from `RevenueError.cause` to a non-enumerable `RevenueError.responseBody`; `cause` now carries only the underlying JS error. Non-enumerability hides the body from `console.error`, `util.inspect`, `JSON.stringify` and Sentry, while `error.responseBody` remains a deliberate read. It is not redacted: the content is customer PII, which a secrets list cannot enumerate.

### Features

* add customers.create and customers.update ([9ae21ae](https://github.com/capawesome-team/revenue-sdk/commit/9ae21aea5597207a0088bf3f5d25467da6dad4e8))
* add license keys ([#5](https://github.com/capawesome-team/revenue-sdk/issues/5)) ([5b8bb65](https://github.com/capawesome-team/revenue-sdk/commit/5b8bb6520906926add2696f7eabd6468841f32aa))
* add pay-what-you-want checkouts and a customerMetadata capability ([6e57384](https://github.com/capawesome-team/revenue-sdk/commit/6e5738479628f32f199c1e570275cbb117e24161))
* add subscription pause and resume ([#2](https://github.com/capawesome-team/revenue-sdk/issues/2)) ([775d549](https://github.com/capawesome-team/revenue-sdk/commit/775d549ef2c10a2471d1bb4683c23cb49ee5b3a9))
* add the orders resource ([#6](https://github.com/capawesome-team/revenue-sdk/issues/6)) ([580cdeb](https://github.com/capawesome-team/revenue-sdk/commit/580cdeb184bc5f9c0c45426bfb200e6db0ce6dcc))
* add usage-based billing ([#4](https://github.com/capawesome-team/revenue-sdk/issues/4)) ([b77bf17](https://github.com/capawesome-team/revenue-sdk/commit/b77bf179e9ac5de4d154900b42c2dd605507e34b))
* add webhook event granularity, dedupe keys and checkout expiry ([d675cfa](https://github.com/capawesome-team/revenue-sdk/commit/d675cfae9467a86de7ae60129bb16a8fee2ce56f))
* support custom provider adapters ([4c37444](https://github.com/capawesome-team/revenue-sdk/commit/4c374445c5896702541cae48639ccfc00f6c0b07))
* **testing:** add signWebhook for webhook handler tests ([c4603c8](https://github.com/capawesome-team/revenue-sdk/commit/c4603c835babd0793d508087bf3a773d3453fe13))


### Bug Fixes

* **client:** retry rate limits without Retry-After and honor aborts ([a17348f](https://github.com/capawesome-team/revenue-sdk/commit/a17348f2e835f826375d1df9d0a6c39b5a3350eb))
* **dodo-payments:** redact the license key from error messages ([e2992da](https://github.com/capawesome-team/revenue-sdk/commit/e2992dad01e8a38d037af768cc31dfdaa6633328))
* **http:** preserve baseUrl path prefixes ([cbe1316](https://github.com/capawesome-team/revenue-sdk/commit/cbe13164539c52791db2ba00a8fd50c39c7f4adc))
* **lemon-squeezy:** dedupe first-payment webhooks, filter drafts, guard endTrial ([41d6743](https://github.com/capawesome-team/revenue-sdk/commit/41d67432d2db299ad5e0f1f2520adf690088c121))
* **polar:** map license activation-limit 403 to validation, redact the key ([9d8b8f7](https://github.com/capawesome-team/revenue-sdk/commit/9d8b8f7eaa22507db02d9ac66bd870d179f261c8))
* **stripe:** refuse plan changes when the subscription has no items ([b0b1873](https://github.com/capawesome-team/revenue-sdk/commit/b0b1873457d0b9aed11c64151d7526e4dcd1b0f4))


### Code Refactoring

* **types:** model WebhookEvent as a discriminated union ([0af4d12](https://github.com/capawesome-team/revenue-sdk/commit/0af4d125dd4a767de948fd9fab5de18ffd5b87ae))

## 0.1.0 (2026-08-06)


### Features

* **client:** add createClient with validation, capability gating, retry, and listAll ([0753090](https://github.com/capawesome-team/revenue-sdk/commit/0753090d3e774f1498c5e280efeb277eac6d9b57))
* **core:** add normalized types, http client, pagination, and webhook primitives ([1e2074c](https://github.com/capawesome-team/revenue-sdk/commit/1e2074cdadf49f945b0031ef6c73be5c413b30bf))
* **dodo-payments:** add Dodo Payments provider with checkout sessions and webhook verification ([0e7cda3](https://github.com/capawesome-team/revenue-sdk/commit/0e7cda315bd6acf0e40b233ea8758cb1a71f29f7))
* **lemon-squeezy:** add Lemon Squeezy provider with webhook verification and event parsing ([d7baec6](https://github.com/capawesome-team/revenue-sdk/commit/d7baec6bb2f708685dfef37c1208ca7c4fa996af))
* **paddle:** add Paddle provider with transaction checkouts and webhook verification ([11d4a3e](https://github.com/capawesome-team/revenue-sdk/commit/11d4a3ebd5ea63f67aa54180e20749da3547d451))
* **polar:** add Polar provider with webhook verification and event parsing ([f4d24c2](https://github.com/capawesome-team/revenue-sdk/commit/f4d24c24e548e59c6bc67f9db10ac164cf13ca7f))
* **stripe:** add Stripe provider with form encoder and webhook verification ([0095081](https://github.com/capawesome-team/revenue-sdk/commit/0095081e3f490c72e3a293291cc528c76d911303))
* **testing:** add in-memory provider on the testing subpath ([9a2f45c](https://github.com/capawesome-team/revenue-sdk/commit/9a2f45c5c1256ab7dc53232b18d59efb63fc06b2))


### Bug Fixes

* **build:** add unrun dev dependency required by tsdown config loading ([c9af08e](https://github.com/capawesome-team/revenue-sdk/commit/c9af08e75ce9126a8e33064b232ecd7dfa66fea8))
