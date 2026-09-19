# ChatGPT A/B renderer compatibility — 2026-09-19

## Problem

A September ChatGPT A/B variant moved the signed-in page onto a Codex-webview renderer. The
extension stayed paired and could still observe ordinary page identity such as the conversation
title, but its provider-facing DOM contract no longer matched the page. In that variant the app
could not reliably discover the composer, select model/reasoning settings, settle native sends,
or record/render ChatGPT responses.

The captured page removed the legacy anchors used by the extension: `#prompt-textarea`,
`section[data-testid^="conversation-turn"]`, `data-message-id`, `data-message-author-role`,
`.markdown`, and the old intelligence-picker test id. The replacement renderer exposes semantic
ChatGPT-owned anchors instead: `form[data-chatgpt-composer]`, `[data-composer-markdown]`,
role-suffixed `data-content-search-unit-key`, `data-markdown-text-style="assistant-message"`, and
`data-codex-intelligence-trigger` plus `data-selected-reasoning-effort`.

The network capture showed that the backend conversation path itself had not been replaced: the
page still used conversation prepare/init plus the conversation streaming endpoint and the normal
models/settings endpoints. That made the earliest failure the DOM/Fiber observation boundary, not
the app's durable outbox or bridge transport.

## Change

- `extension/chatgpt-dom.js` now recognizes both renderer families through one adapter. It finds
  the ProseMirror A/B composer, turns role-suffixed search units into logical user/assistant turns,
  reads the A/B assistant-prose marker, and keeps legacy hydration behavior unchanged.
- A/B user rows remain presentation-only until MAIN-world Fiber stamps the canonical provider
  message id. Send acceptance therefore keeps the existing exact-receipt rule instead of treating
  a search-unit key or composer clear as message identity.
- `extension/fiber.js` scans the A/B turn owners, stamps canonical user/assistant identities onto
  their rendered units, and reads the explicit A/B reasoning trigger while preserving the legacy
  picker path.
- Model/reasoning selection follows the provider's v2 picker state and maps provider effort names
  such as `standard` / `extended` to the app's Medium / High vocabulary. A Radix-controlled parent
  picker may portal the model-version radio list; the adapter follows the expanded row's own
  `aria-controls` to that submenu instead of guessing from unrelated open menus.
- `extension/content.js` now asks the DOM adapter for turn/authored-output/message identity rather
  than carrying legacy selectors itself. This includes the first bootstrap user message used by
  resume/worker folding.

## Regression coverage added

Focused fixtures cover the captured A/B composer and transcript shape, canonical Fiber stamping,
multiple assistant units in one exchange, hidden retained A/B trees falling back to the live legacy
renderer, closed and open A/B picker observation, a controlled picker with a portaled version
submenu, and preservation of a legacy conversation-turn section while `data-turn` is temporarily
absent during hydration. They also cover a retained hidden A/B composer appearing before a second,
live A/B composer, so same-renderer React handoffs cannot redirect send or picker observation to a
stale editor.

## Validation performed

- Compared the provider-facing selectors against the captured A/B page and the redacted endpoint
  behavior from the supplied NetLog.
- Re-audited the changed legacy paths alongside the A/B paths and corrected two review findings:
  legacy role-less hydration sections are preserved, and portaled model submenus are resolved by
  their exact control relationship.
- Used `nix-shell -p nodejs_24` as the JavaScript toolchain (Node 24.20.0, npm 11.19.0) and installed
  the locked dependencies with `npm ci`.
- The focused compatibility pass is green: `chatgpt-dom-input`, `fiber`, `model-picker-state`,
  `extension`, and `content-script` pass 1,148 / 1,148 tests after the final fixes.
- The first broad CI pass exposed four legacy DOM-adapter regressions caused by the combined
  assistant-prose selector. The adapter now preserves real-browser document order while retaining
  the exact legacy selector fallback expected by structural DOM shims; the legacy tests pass again.
- A fresh independent reviewer then found one same-renderer handoff edge case: a hidden A/B editor
  could precede the live A/B editor. Both isolated-world and MAIN-world helpers now scan all A/B
  editors and choose the first visible one. New regressions cover composer and picker observation.
- Final `npm run verify:ci` in the Nix shell exits 0: 204 test files passed and 13 skipped, with
  5,324 tests passed and 134 skipped; the separate shutdown suite passes 6 / 6. Privacy, notices,
  native-source and TypeScript gates also pass.
- `npm run build` and `git diff --check` pass. The production build emits only the repository's
  existing non-failing Vite dynamic/static import notices.
- The fresh independent reviewer returned **READY** with no remaining blocker in the reviewed A/B,
  legacy, send-identity, response-discovery, picker-ownership, or `content.js` boundary paths.

A live signed-in acceptance pass is still desirable before a release: exercise one native send,
one model/reasoning change, and one streamed response on the A/B renderer, plus a basic legacy
renderer smoke test. No browser-control surface was available for that interactive pass in this
session. The private capture contained live authentication material; no tokens, cookies, account
ids, conversation ids, or raw private capture content are stored in this repository or worklog.

## Live-capture follow-up

The first installed A/B build exposed two additional cold-attach failures. The page-model helper
could no longer read the moved private React picker owner, so desktop input stopped before Send
even though the closed composer explicitly showed High and the provider model catalog had already
been captured. Separately, replies that completed before MAIN-world observation attached were not
replayed, because the page had loaded conversation history before the fetch observer existed.

- Closed A/B selection can now be confirmed without opening the fragile private picker only when
  the provider-owned effort attribute, the exact requested model slug, the enabled provider model
  family/version, and an available provider preset all agree. Mismatched effort/family evidence
  remains fail-closed, and actual changes still use the native picker confirmation path.
- On initial bind and each exact conversation route transition, the isolated script requests one
  same-origin history snapshot. The MAIN-world observer validates the current route and UUID,
  deduplicates concurrent requests, fetches the ordinary conversation-history endpoint, and feeds
  the response through the existing bounded public-message projection. It does not poll and does
  not expose private analysis, tool metadata, credentials, or arbitrary response fields.
- The observer generation is now 3 so an extension reload supersedes the already-installed v2
  MAIN-world observer in open tabs.

The focused regression pass (`model-picker-state`, `usage-observer`, and `content-script`) passes
744 / 744 tests. Final `npm run verify:ci` exits 0 with 204 files passed and 13 skipped, 5,334 tests
passed and 134 skipped, plus 6 / 6 shutdown tests. Privacy, notice/native-source, TypeScript,
Electron-resolution, and `git diff --check` gates also pass.
