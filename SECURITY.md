# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 1.x | Yes |
| 0.x | No. Upgrade to 1.x. |

## Reporting a vulnerability

Please report security issues privately through
[GitHub private vulnerability reporting](https://github.com/EthanY33/atelier/security/advisories/new)
rather than a public issue. Include the skill name, the input that triggers the problem, and what an attacker gains.

You can expect an acknowledgement within 72 hours. Fixes ship as a patch release with a `### Security` section in the [changelog](CHANGELOG.md), crediting the reporter unless you prefer otherwise.

## Scope

atelier runs locally with your user's permissions, on inputs you point it at. The areas that matter most:

- **Process spawning** (`html-to-video`, `lib/preflight.mjs`): binaries are resolved on `PATH` and spawned without a shell. Any path that reaches a shell is a bug.
- **Generated code** (`design-token-sync`): values from `brand.json` are emitted with `JSON.stringify` so they cannot escape a string literal in `tailwind.config.js` or `tokens.d.ts`.
- **Untrusted pages** (`runtime-ux-audit`, `accessibility-design-audit`, `og-card-generator`): the static audit never executes page JavaScript, only fetches same-origin subresources by default, and caps response size and time.
- **brand.json** is schema-validated on every load and save.

atelier sends no telemetry and makes no network requests other than the pages you ask it to audit or record.
