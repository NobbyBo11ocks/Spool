# Contributing

Thanks for helping. A few ground rules keep Spool reliable and on the right side of the line:

- **General-purpose only.** Spool recognises media by what a response *is* (content type, size, playlist syntax), not by which
  site it comes from. No per-site rules.
- **No DRM circumvention, no anti-obfuscation workarounds.** Protected streams stay refused.
- **Evidence over guesses.** Behaviour that depends on Chrome or on a spec is checked against the spec or measured in a real
  browser, and the test says which.

## Setup

```
npm install
npm test          # ESLint + unit/integration tests (~3 s)
```

End-to-end tests drive the real extension in Chrome for Testing; see the README for `CHROME_FOR_TESTING`.

```
npm run test:e2e
```

## Before you open a pull request

1. `npm test` and `npm run test:e2e` pass.
2. A bug fix comes with a test that fails without it. Engine and parser changes get a unit test in `tests/` (they run
   against real ffmpeg-generated streams); changes to the service worker, popup or downloader get an e2e test.
3. Keep the code in the style around it: small modules, `lib/` free of `chrome.*` and DOM so it stays testable in Node.
