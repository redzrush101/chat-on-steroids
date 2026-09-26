/** Sandbox-aware adapter for the Codex patch runtime and its transactional rollback. */
import { rawPromises as fs } from '../rawfs.js';
import { formatBytes } from '../fsops.js';
import { SandboxError, isNativeWindowsPath } from '../sandbox.js';
import type { Capabilities, Root } from '../../shared/types.js';
import type { FileChange } from '../../shared/session.js';
import {
  ApplyPatchError,
  PatchParseError,
  executeApplyPatch,
  verifyApplyPatchArgs,
  type AppliedPatchDelta,
  type Hunk,
  type PatchPathResolver
} from '../codex/apply-patch/index.js';
import { DEFAULT_APPLY_PATCH_FILE_UPDATE_MODE } from '../codex/apply-patch/mode.js';
import { formatExecOutputForModel, newStreamOutput } from '../codex/exec-output.js';
import { DEFAULT_TRUNCATION_POLICY } from '../codex/manager.js';
import { lineDelta } from '../diffstat.js';
import { logInfo } from '../logger.js';
import { noteChanges } from './call-context.js';
import { fail, friendlyError, ok, resolveIn, type ToolResult } from './kernel.js';

// ---------------------------------------------------------------------------
// apply_patch adapter helpers
// ---------------------------------------------------------------------------

export function applyPatchErrorText(error: unknown, includeSourceContext = false): string {
  if (error instanceof ApplyPatchError && includeSourceContext && error.sourceContext) {
    return `${error.message}\n\n${error.sourceContext}`;
  }
  return error instanceof PatchParseError || error instanceof ApplyPatchError ? error.message : friendlyError(error);
}

interface ParsedPatchRun {
  result: ToolResult;
  content: string | null;
  exitCode: number | null;
}

/** Existing bytes kept so a failed model-facing patch can restore its pre-call state. */
interface PatchRollbackSnapshot {
  virtual: string;
  bytes: Buffer | null;
}

/** Keep the connector's atomicity promise bounded even when many large files are patched. */
const MAX_PATCH_ROLLBACK_BYTES = 64 * 1024 * 1024;

async function readOptionalPatchBytes(real: string): Promise<Buffer | null> {
  try {
    const stat = await fs.lstat(real);
    if (!stat.isFile()) throw new Error('apply_patch target changed from a file before execution');
    return await fs.readFile(real);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function capturePatchRollbackSnapshots(resolution: PatchResolution): Promise<Map<string, PatchRollbackSnapshot>> {
  const snapshots = new Map<string, PatchRollbackSnapshot>();
  let total = 0;
  for (const [real, virtual] of resolution.virtualPaths) {
    const bytes = await readOptionalPatchBytes(real);
    total += bytes?.length ?? 0;
    if (total > MAX_PATCH_ROLLBACK_BYTES) {
      throw new Error(
        `apply_patch touches more than ${formatBytes(MAX_PATCH_ROLLBACK_BYTES)} of existing file data; split it into smaller patches so atomic rollback stays bounded.`
      );
    }
    snapshots.set(real, { virtual, bytes });
  }
  return snapshots;
}

function samePatchState(left: Buffer | null, right: Buffer | null): boolean {
  if (left === null || right === null) return left === right;
  return left.equals(right);
}

function expectedPatchStates(
  snapshots: ReadonlyMap<string, PatchRollbackSnapshot>,
  delta: AppliedPatchDelta
): Map<string, Buffer | null> {
  const expected = new Map<string, Buffer | null>();
  for (const [real, snapshot] of snapshots) expected.set(real, snapshot.bytes);
  for (const { path: real, change } of delta.changes) {
    if (change.kind === 'add') {
      expected.set(real, Buffer.from(change.content, 'utf8'));
    } else if (change.kind === 'delete') {
      expected.set(real, null);
    } else if (change.movePath === null) {
      expected.set(real, Buffer.from(change.newContent, 'utf8'));
    } else {
      expected.set(real, null);
      expected.set(change.movePath, Buffer.from(change.newContent, 'utf8'));
    }
  }
  return expected;
}

/**
 * Best-effort transaction rollback for the connector's stronger contract around raw Codex.
 *
 * Only a path still equal to the state recorded in the runtime delta is rewritten. If another
 * process changed it concurrently, leave that user's newer data alone and report rollback as
 * incomplete instead of "restoring" over an identity we can no longer prove belongs to us.
 */
async function rollbackFailedPatch(
  snapshots: Map<string, PatchRollbackSnapshot>,
  delta: AppliedPatchDelta
): Promise<{ complete: boolean; note: string }> {
  const expected = expectedPatchStates(snapshots, delta);
  const problems: string[] = [];

  for (const [real, snapshot] of snapshots) {
    let current: Buffer | null;
    try {
      current = await readOptionalPatchBytes(real);
    } catch {
      problems.push(`${snapshot.virtual}: could not inspect current state`);
      continue;
    }
    if (samePatchState(current, snapshot.bytes)) continue;
    const patchState = expected.get(real) ?? null;
    if (!samePatchState(current, patchState)) {
      problems.push(`${snapshot.virtual}: changed outside the recorded patch state`);
      continue;
    }
    try {
      if (snapshot.bytes === null) await fs.rm(real, { force: true });
      else await fs.writeFile(real, snapshot.bytes);
    } catch {
      problems.push(`${snapshot.virtual}: restore failed`);
    }
  }

  // Prove the final state rather than assuming successful write/remove calls meant restoration.
  for (const [real, snapshot] of snapshots) {
    try {
      if (!samePatchState(await readOptionalPatchBytes(real), snapshot.bytes)) {
        if (!problems.some((problem) => problem.startsWith(`${snapshot.virtual}:`))) {
          problems.push(`${snapshot.virtual}: restore verification failed`);
        }
      }
    } catch {
      if (!problems.some((problem) => problem.startsWith(`${snapshot.virtual}:`))) {
        problems.push(`${snapshot.virtual}: restore verification failed`);
      }
    }
  }

  if (problems.length === 0) {
    delta.changes.splice(0);
    delta.exact = true;
    return { complete: true, note: 'All file changes from this failed patch were rolled back.' };
  }
  delta.exact = false;
  return { complete: false, note: `WARNING: failed patch rollback was incomplete: ${problems.join('; ')}` };
}

/** Shared execution path for the standalone tool and exec_command's upstream apply_patch intercept. */
export async function runParsedPatch(
  args: { patch: string; hunks: Hunk[]; workdir: string | null; environmentId: string | null },
  roots: readonly Root[],
  base: { real: string; virtual: string },
  caps?: Capabilities
): Promise<ParsedPatchRun> {
  if (caps !== undefined) {
    // Product permission gates around the otherwise ported Codex patch runtime. exec_command's
    // interception deliberately omits this extra gate because command execution already grants
    // shell-equivalent mutation ability, matching Codex's shell-tool interception path.
    const denial = patchCapabilityDenial(args.hunks, caps);
    if (denial !== null) return { result: fail(denial), content: null, exitCode: null };
  }

  // `invocation.rs` turns `cd foo && apply_patch ...` into `args.workdir = "foo"`. Resolve that
  // once against the selected exec environment, then clear it before handing the already-effective
  // cwd to the verifier/runtime. The patch text itself never contains this shell-level workdir.
  let effectiveBase = base;
  let effectiveArgs = args;
  if (args.workdir !== null) {
    try {
      // Preserve the shell gate from `cd dir && apply_patch`: interception must not execute a
      // patch that the submitted shell command would never have reached. The cwd must already
      // exist and be a directory; patch-created parents apply only to paths *inside* it.
      effectiveBase = await resolveIn(roots, args.workdir, { base: base.virtual });
      const stat = await fs.stat(effectiveBase.real);
      if (!stat.isDirectory()) {
        return { result: fail('apply_patch workdir must be an existing folder'), content: null, exitCode: null };
      }
    } catch (error) {
      return { result: fail(friendlyError(error)), content: null, exitCode: null };
    }
    effectiveArgs = { ...args, workdir: null };
  }

  // Every path the patch names is resolved through the connector environment up front, and the
  // synchronous resolver handed into the Codex port reads that table back.
  let resolution: PatchResolution;
  try {
    resolution = await resolvePatchPaths(roots, effectiveBase.virtual, effectiveArgs.hunks);
  } catch (error) {
    return { result: fail(friendlyError(error)), content: null, exitCode: null };
  }
  if (caps !== undefined) {
    try {
      const denial = await patchEffectCapabilityDenial(effectiveArgs.hunks, caps, resolution.resolve);
      if (denial !== null) return { result: fail(denial), content: null, exitCode: null };
    } catch (error) {
      return { result: fail(friendlyError(error)), content: null, exitCode: null };
    }
  }
  // Move-only is a separate permission from Edit. Upstream's default update mode normalizes
  // even context-only moves to LF, so a CRLF file would be byte-rewritten under Move alone.
  // Preserve line endings whenever Edit is unavailable; any real content change was already
  // rejected by patchCapabilityDenial before resolution.
  const patchUpdateMode = caps !== undefined && !caps.edit ? 'preserve_line_endings' : DEFAULT_APPLY_PATCH_FILE_UPDATE_MODE;

  try {
    await verifyApplyPatchArgs(
      effectiveArgs,
      effectiveBase.real,
      patchUpdateMode,
      resolution.resolve
    );
  } catch (error) {
    return {
      result: fail(`apply_patch verification failed: ${safePatchOutput(applyPatchErrorText(error, caps?.read === true), resolution)}`),
      content: null,
      exitCode: null
    };
  }

  let rollbackSnapshots: Map<string, PatchRollbackSnapshot> | null = null;
  if (caps !== undefined) {
    try {
      rollbackSnapshots = await capturePatchRollbackSnapshots(resolution);
    } catch (error) {
      return { result: fail(friendlyError(error)), content: null, exitCode: null };
    }
  }

  const execution = await executeApplyPatch({
    patch: effectiveArgs.patch,
    cwd: effectiveBase.real,
    updateFileMode: patchUpdateMode,
    resolvePath: resolution.resolve
  });
  let rollbackNote = '';
  if (execution.exitCode !== 0 && rollbackSnapshots !== null) {
    const rollback = await rollbackFailedPatch(rollbackSnapshots, execution.delta);
    rollbackNote = rollback.note;
  }
  const stdout = safePatchOutput(execution.stdout, resolution);
  const stderr = safePatchOutput(`${execution.stderr}${rollbackNote ? `${execution.stderr.endsWith('\n') || execution.stderr === '' ? '' : '\n'}${rollbackNote}\n` : ''}`, resolution);
  const aggregatedOutput = `${stdout}${stderr}`;
  const content = formatExecOutputForModel(
    {
      exitCode: execution.exitCode,
      stdout: newStreamOutput(stdout),
      stderr: newStreamOutput(stderr),
      aggregatedOutput: newStreamOutput(aggregatedOutput),
      durationMs: execution.durationMs,
      timedOut: false
    },
    DEFAULT_TRUNCATION_POLICY
  );

  noteChanges(patchFileChanges(execution.delta, resolution.virtualPaths));
  logInfo(`tool apply_patch (${execution.delta.changes.length} file(s), exit ${execution.exitCode})`);
  return {
    result: execution.exitCode === 0 ? ok(content) : fail(content),
    content,
    exitCode: execution.exitCode
  };
}

/** Product permission gates around the otherwise ported Codex patch runtime. */
function patchCapabilityDenial(hunks: readonly Hunk[], caps: Capabilities): string | null {
  for (const hunk of hunks) {
    if (hunk.kind === 'add_file') {
      if (!caps.create) return 'TOOL_DISABLED: this patch adds a file but Create files and folders is disabled.';
      continue;
    }
    if (hunk.kind === 'delete_file') {
      if (!caps.deleteFile) return 'TOOL_DISABLED: this patch deletes a file but Delete files is disabled.';
      continue;
    }

    // Current Codex rejects an entirely empty Update hunk, including a move-only one. A rename
    // can still be expressed with a context-only chunk (` old` == `new`), so distinguish that
    // no-op content check from a real rewrite and preserve this app's separate Move permission.
    const contentChange =
      hunk.movePath === null ||
      hunk.chunks.some(
        (chunk) =>
          chunk.oldLines.length !== chunk.newLines.length ||
          chunk.oldLines.some((line, index) => line !== chunk.newLines[index])
      );
    if (contentChange && !caps.edit) {
      return 'TOOL_DISABLED: this patch updates a file but Edit files is disabled.';
    }
    if (hunk.movePath !== null && !caps.move) {
      return 'TOOL_DISABLED: this patch moves a file but Move / rename is disabled.';
    }
  }
  return null;
}

/**
 * Permission checks whose answer depends on the filesystem effect rather than patch syntax.
 *
 * Codex intentionally lets `Add File` replace an existing regular file and lets a move replace
 * an occupied destination. Those are useful patch semantics, but in this product they are edits
 * to existing data, not "create" or pure "move" effects. Require Edit in addition to the syntax
 * permission before handing such a patch to the runtime.
 */
async function patchEffectCapabilityDenial(
  hunks: readonly Hunk[],
  caps: Capabilities,
  resolve: PatchPathResolver
): Promise<string | null> {
  const exists = async (target: string): Promise<boolean> => {
    try {
      await fs.lstat(target);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  };
  const samePath = (left: string, right: string): boolean =>
    process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;

  for (const hunk of hunks) {
    if (hunk.kind === 'add_file') {
      if (!caps.edit && (await exists(resolve(hunk.path, '')))) {
        return 'TOOL_DISABLED: this patch replaces an existing file but Edit files is disabled.';
      }
      continue;
    }
    if (hunk.kind !== 'update_file' || hunk.movePath === null || caps.edit) continue;
    const source = resolve(hunk.path, '');
    const destination = resolve(hunk.movePath, '');
    if (!samePath(source, destination) && (await exists(destination))) {
      return 'TOOL_DISABLED: this patch replaces an existing move destination but Edit files is disabled.';
    }
  }
  return null;
}

interface PatchResolution {
  resolve: PatchPathResolver;
  /** Real path -> safe virtual path, used only for recorder change evidence. */
  virtualPaths: Map<string, string>;
  /** Exact model-visible/real spellings that must never be echoed back as native paths. */
  displayRewrites: Map<string, string>;
}

function safePatchOutput(text: string, resolution: PatchResolution): string {
  let safe = text;
  const rewrites = [...resolution.displayRewrites].sort(([a], [b]) => b.length - a.length);
  for (const [from, to] of rewrites) {
    if (from === '' || from === to || !safe.includes(from)) continue;
    safe = safe.split(from).join(to);
  }
  return safe;
}

/**
 * Resolves every spelling before the Codex verifier/runtime sees it.
 *
 * Codex normally does `cwd.join(path)`. This connector must retain its approved-root boundary,
 * so the synchronous resolver handed into the port reads a table that was produced by the same
 * sandbox path resolver every other filesystem tool uses.
 */
async function resolvePatchPaths(
  roots: readonly Root[],
  baseVirtual: string,
  hunks: readonly Hunk[]
): Promise<PatchResolution> {
  const realBySpelling = new Map<string, string>();
  const virtualPaths = new Map<string, string>();
  const displayRewrites = new Map<string, string>();
  // The Codex verifier/runtime is sequential: a later hunk may legally read a path an earlier
  // Add/Move created, or may deliberately fail because an earlier Delete/Move removed it. Path
  // resolution has to model that same presence state instead of consulting only pre-patch disk.
  const pendingPresence = new Map<string, boolean>();
  const pathKey = (real: string): string => (process.platform === 'win32' ? real.toLowerCase() : real);

  const add = async (spelledPath: string, requireExisting: boolean): Promise<string> => {
    // First resolve the sandbox identity without requiring the leaf to exist. This gives later
    // hunks a stable real key even when the path exists only in the patch's simulated state.
    let resolved = await resolveIn(roots, spelledPath, { base: baseVirtual, allowMissing: true });
    const state = pendingPresence.get(pathKey(resolved.real));
    // An untouched initial Update/Delete keeps the old strict Not-found behaviour. Once an
    // earlier hunk has established presence/absence, the verifier owns the sequential verdict.
    if (requireExisting && state === undefined) {
      resolved = await resolveIn(roots, spelledPath, { base: baseVirtual, allowMissing: false });
    }
    realBySpelling.set(spelledPath, resolved.real);
    virtualPaths.set(resolved.real, resolved.virtual);
    displayRewrites.set(resolved.real, resolved.virtual);
    if (isNativeWindowsPath(spelledPath)) displayRewrites.set(spelledPath, resolved.virtual);
    return resolved.real;
  };

  for (const hunk of hunks) {
    if (hunk.kind === 'add_file') {
      const target = await add(hunk.path, false);
      pendingPresence.set(pathKey(target), true);
      continue;
    }
    if (hunk.kind === 'delete_file') {
      const target = await add(hunk.path, true);
      pendingPresence.set(pathKey(target), false);
      continue;
    }

    const source = await add(hunk.path, true);
    if (hunk.movePath === null) {
      pendingPresence.set(pathKey(source), true);
      continue;
    }
    const destination = await add(hunk.movePath, false);
    pendingPresence.set(pathKey(source), false);
    pendingPresence.set(pathKey(destination), true);
  }

  const resolve: PatchPathResolver = (spelledPath) => {
    const resolved = realBySpelling.get(spelledPath);
    if (resolved === undefined) {
      throw new SandboxError(`Patch path was not validated before use: ${spelledPath}`);
    }
    return resolved;
  };
  return { resolve, virtualPaths, displayRewrites };
}

function patchFileChanges(delta: AppliedPatchDelta, virtualPaths: ReadonlyMap<string, string>): FileChange[] {
  return delta.changes.map(({ path, change }) => {
    let realPath = path;
    let before: string;
    let after: string;
    if (change.kind === 'add') {
      before = change.overwrittenContent ?? '';
      after = change.content;
    } else if (change.kind === 'delete') {
      before = change.content;
      after = '';
    } else {
      realPath = change.movePath ?? path;
      before = change.oldContent;
      after = change.newContent;
    }
    const counts = lineDelta(before, after);
    return {
      path: virtualPaths.get(realPath) ?? '[unresolved patch path]',
      added: counts.added,
      removed: counts.removed,
      approximate: counts.approximate || !delta.exact
    };
  });
}
