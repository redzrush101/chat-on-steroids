# Chat On Steroids

## Commands

Use Node 24 and the committed lockfile.

```sh
npm ci
npm run typecheck
npm test -- test/<file>.test.ts
npm run verify
npm run build
nix develop
nix flake check
```

`npm run verify` is the CI gate. Run the focused test file first, then the full gate for production changes. Packaging commands are in [docs/build.md](docs/build.md).

## Rules

- Inspect `git status --short` before editing. Preserve unrelated changes; do not reset, clean, or reformat the repository broadly.
- Find the owner of a behavior before changing it. Keep one owner for each durable fact and remove replaced branches instead of adding fallback state.
- Main owns permissions, local tools, sessions, and durable writes. The extension owns browser observation and actions. The renderer uses the preload API and does not access the filesystem or secrets.
- Keep local session IDs, ChatGPT conversation IDs, browser document IDs, project paths, outbox IDs, and worker runs separate. Reject unknown ownership instead of guessing.
- Async code must check that its owner and generation are still current before publishing a result.
- A composer insertion or UI click is not a delivery receipt. Record only evidence the app actually has.
- Tests must use temporary state and isolated ports. They must not contact an installed bridge or real user data.
- Add a focused regression test for a production bug. Test the public behavior and failure case; avoid testing private implementation details or duplicating another test.
- Do not add tests that sleep for real time when fake timers or injected clocks can prove the same behavior.
- Do not create worklogs, audit diaries, generated history, or documentation that repeats commits. Put rationale and validation in the commit or pull request.
- Update existing user or developer documentation when behavior changes. Add release notes only for a release.

## Ownership map

| Area | Files |
| --- | --- |
| Main process and permissions | `src/main/index.ts`, `src/main/config.ts`, `src/main/sandbox.ts`, `src/main/ipc.ts` |
| MCP and local tools | `src/main/mcp/`, `src/main/fsops.ts`, `src/main/exec.ts`, `src/main/projects.ts`, `src/main/workspace.ts` |
| Sessions and automation | `src/main/session/`, `src/main/goal.ts`, `src/main/agents.ts`, `src/shared/` |
| Browser bridge and extension | `src/main/bridge.ts`, `src/main/browser.ts`, `extension/` |
| Renderer and native desktop | `src/renderer/`, `src/main/computer/`, `native/` |
| Build and release | `scripts/`, `electron.vite.config.ts`, `electron-builder.yml`, `flake.nix`, `nix/package.nix`, `.github/workflows/` |
