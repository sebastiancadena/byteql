# IBM Plex font provenance

The Trace Workspace design bundles three IBM Plex faces as local WOFF2 assets. They are loaded
through `FontFace` in `src/lib/ui/fonts.ts` before the application publishes readiness, so the
running app never issues a font request. No CSS `@font-face` rule references a remote URL, and no
font service is contacted at runtime — see `docs/privacy.md` and `apps/web/e2e/privacy.spec.ts`.

## Upstream

- Repository: <https://github.com/IBM/plex>
- Revision: `bf260093582f04622aacc1e9f9ca604d7ccd0c42` (committed 2026-07-30)
- Sans source directory: `packages/plex-sans/fonts/complete/woff2`
- Mono source directory: `packages/plex-mono/fonts/complete/woff2`
- License: SIL Open Font License 1.1, preserved verbatim as `LICENSE.txt`

Downloads used the immutable revision above
(`https://raw.githubusercontent.com/IBM/plex/bf260093582f04622aacc1e9f9ca604d7ccd0c42/...`), not a
branch reference. Only the three faces the design actually uses are vendored; the complete family
is deliberately not added.

## Files

| File                         | Face                    | SHA-256                                                            |
| ---------------------------- | ----------------------- | ------------------------------------------------------------------ |
| `IBMPlexSans-Regular.woff2`  | Sans 400, version 3.327 | `ba711a3085ff9f27440b6b9c4550cfc47c97bf36591d5da958b975bb3add8c1a` |
| `IBMPlexSans-SemiBold.woff2` | Sans 600, version 3.327 | `f78048030eab62e860efa39a0df79e2e5581bf122eb95b9bc42c0b8a4988d205` |
| `IBMPlexMono-Regular.woff2`  | Mono 400, version 2.327 | `ba204497f16b6d334cee9d1e963a831b73e3a56e1d6300a8489d18df7214b350` |
| `LICENSE.txt`                | OFL 1.1                 | `7e6b2818edbd8f6a01ae80641cc8f16a51080d08fb4e532be3a0b6f74adb07da` |

Verify with `sha256sum` from this directory.
