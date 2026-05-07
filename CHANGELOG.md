# Changelog
## 1.16.1

### Bug Fixes 🐛

- (lib) Serialize git cache updates by @gricha in [#101](https://github.com/getsentry/dotagents/pull/101)

### Documentation 📚

- Update dotagents docs for install refresh flow by @gricha in [#100](https://github.com/getsentry/dotagents/pull/100)

## 1.16.0

- Update post-merge hook installation command by @jvanderwee in [#96](https://github.com/getsentry/dotagents/pull/96)

## 1.15.0

### New Features ✨

- (lib) Expose discovery, parsing, and tool-name primitives by @gricha in [#98](https://github.com/getsentry/dotagents/pull/98)

## 1.14.0

### Internal Changes 🔧

- Extract dotagents-lib as a separate workspace package by @gricha in [#97](https://github.com/getsentry/dotagents/pull/97)

## 1.13.0

### Internal Changes 🔧

- (install) Remove --force flag by @gricha in [3559490e](https://github.com/getsentry/dotagents/commit/3559490e250dce84a526207186febdb1ffa0a70e)
- Remove low-value tests and fix misleading names by @gricha in [d897964c](https://github.com/getsentry/dotagents/commit/d897964cd686e6e88662f2fd4824ea8c9e943a9b)
- Stop checking in managed skills by @gricha in [f2bf518b](https://github.com/getsentry/dotagents/commit/f2bf518b4e575d95769f8717f085e22f5a150fad)
- Remove dead type exports from public API by @gricha in [506742c2](https://github.com/getsentry/dotagents/commit/506742c2cc6857172abe974b613f998dfb553dac)
- Extract isInPlaceSkill to shared util by @gricha in [251ab53a](https://github.com/getsentry/dotagents/commit/251ab53a5684f946375e0f035d32285f17316d63)

## 1.12.0

### Bug Fixes 🐛

- (cache) Remove 24h TTL from git source cache by @gricha in [#92](https://github.com/getsentry/dotagents/pull/92)

## 1.11.0

### Bug Fixes 🐛

- (git) Force cached repo fetches by @gricha in [#89](https://github.com/getsentry/dotagents/pull/89)

## 1.10.0

### Bug Fixes 🐛

- (cache) Refresh unpinned repos after ref checkouts by @gricha in [#88](https://github.com/getsentry/dotagents/pull/88)

## 1.9.0

### Bug Fixes 🐛

- (sync) Prune stale managed skills during sync by @gricha in [#87](https://github.com/getsentry/dotagents/pull/87)

### Internal Changes 🔧

- Bump vite to fix security vulnerabilities by @gricha in [#85](https://github.com/getsentry/dotagents/pull/85)
- Bump transitive deps to fix security vulnerabilities by @gricha in [#84](https://github.com/getsentry/dotagents/pull/84)

## 1.8.0

### Internal Changes 🔧

- (config) Move minimum_release_age to top-level fields by @gricha in [6342cec3](https://github.com/getsentry/dotagents/commit/6342cec39304947fabebb823ad91ae541790009a)

## 1.7.0

### Internal Changes 🔧

- (update) Rename exclude to minimum_release_age_exclude by @gricha in [dd3e9cf1](https://github.com/getsentry/dotagents/commit/dd3e9cf169cb5173bf9463b8e3ed8db6b19b3f10)

## 1.6.0

### New Features ✨

- (update) Add minimum_release_age for unpinned git skills by @gricha in [#83](https://github.com/getsentry/dotagents/pull/83)

### Internal Changes 🔧

- (deps) Bump smol-toml from 1.6.0 to 1.6.1 by @dependabot in [#82](https://github.com/getsentry/dotagents/pull/82)
- Pin GitHub Actions to full-length commit SHAs by @joshuarli in [#81](https://github.com/getsentry/dotagents/pull/81)

