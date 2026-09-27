# Compact workspace UI, 2026-09-27

Branch: `feat/compact-workspace-ui`. The shared tree was clean before the branch and edits.

## Change

- Replaced the default dark wash and decorative sidebar edge with flat surfaces, a divider,
  denser project/session rows and an active setup-profile footer. Saved appearance settings
  remain authoritative.
- Reflowed the composer into project Git context, text editor and controls. Branch/change
  labels come from the existing read-only project Git owner, with exact selection fencing and
  no partial totals from truncated snapshots. The retained project association still works
  after ungrouping; recorded edits and a manual refresh update the context while Files is closed.
  The context can be dismissed for its current session/draft and restored from the toolbar.
  Review opens the existing Changes dock. The sidebar Files shortcut is disabled without a project.
- Made recorded tool rows compact. Arguments and results are expandable; a genuine unified
  diff result renders with old/new line numbers and add/delete colors. Successful edits also
  load their exact historical before/after asset on row expansion and render a bounded inline
  diff; larger reviews remain in the existing dock. The parser preserves hunk lines whose
  content starts with `++` or `--` and caps DOM work. Line-ending changes use the full review
  viewer so the inline diff cannot silently omit that difference. Edit rows show the delta once.
- Kept assistant text byte-for-byte. An affected saved message contains contractions
  without inserted spaces, so the observed apostrophe gap occurs after recording. The default
  font stack now resolves `system-ui` before Linux's Segoe UI fallback, which on this host maps
  to Noto Sans CJK KR; transcript tracking and line height are normalised.

## Validation

- `git diff --check`: passed.
- Nix Node 22 toolchain, `npm ci --ignore-scripts`, `npm run typecheck`: passed.
- Focused Vitest: appearance, IPC, tool result, renderer HTML, and changed renderer layout,
  locale and timeline assertions passed. Renderer tests cover an existing project chat's Git
  context, a late snapshot after selection changes, retained ungrouped workspaces, and a recorded
  edit while Files is closed. The first full `npm run verify` found
  seven stale expectations in those suites; they were updated for the requested design. The
  second full run passed 6,203 ordinary and six isolated tests, before the two Git tests and
  final spinner CSS adjustment. That full run passed 6,207 ordinary and six isolated tests.
- After inline historical diffs, typecheck and the focused tool-result/timeline suites passed
  214 tests. The full suite and build are rerun below before completion.
- `npm run build`: passed after the final test run. `scripts/verify-composer-layout.cjs` in Electron passed: the editor
  grows to 220 px, scrolls on long input and returns to its compact height when cleared.
- The isolated sidebar Electron script's stale fixture lacked `commandAllowlist`; that fixture
  was repaired. Its pointer/keyboard and row geometry checks then passed through the screenshot
  step, where Electron returned `UnknownVizError`. The appearance script hit the same renderer
  capture error. No installed-app or signed-in provider check was performed.

## Boundary

The app has no local authority to auto-accept ChatGPT tool approvals and no native speech
input/PR publishing flow. The UI uses its existing attach, model and Git review controls
instead of showing switches or receipts for actions it cannot perform. The screenshot's outer
focused-window stroke appears to be the desktop window manager; it is absent from renderer CSS.
