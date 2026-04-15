# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial scaffold: plugin manifest, 7 skills, unit tests, CI matrix, JSON-Schema-validated brand config.

### Removed
- svgo dependency (unused — sharp's SVG rasterization is sufficient for Phase 1).

### Notes
- Dependency pins deviate from the original spec (plan): `vitest` bumped from `2.2.0` → `3.1.2` (major), `sharp` `0.34.1` → `0.34.5`, `playwright` `1.52.0` → `1.51.1`, `@axe-core/playwright` `4.10.2` → `4.10.1`. All substitutions are exact pins. Vitest 3 is API-compatible with the plan's usage (`defineConfig`, `test.include`, `coverage.provider: 'v8'`, `coverage.thresholds`).
