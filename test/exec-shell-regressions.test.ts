import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bindBundledRipgrep, execRecoveryHints, nonZeroExitIsBenign, repairPowerShellQuoting } from '../src/main/exec-hints.js';
import { deriveExecArgs, getShellByModelProvidedPath, withPosixPathPrefix } from '../src/main/codex/shell.js';
import {
  commandBatchExitIsBenign,
  commandBatchOutcome,
  composeCommandBatch,
  parseCommandBatchSections,
  projectCommandBatchNotes
} from '../src/main/codex/command-batch.js';
import { locateRipgrep } from '../src/main/ripgrep.js';
import { TempDirPool } from './helpers.js';

const tempDirs = new TempDirPool();
afterEach(async () => tempDirs.cleanup());
async function fixture() {
  return tempDirs.createWithFiles('cos-shell-regression-', {
    'sample.txt': 'history="older"\nLoad older\nnot a match\n',
    'second.txt': 'not a match\n'
  });
}

describe('native shell argument and batch parity', () => {
  // Every installed shell runs real child processes. macOS CI includes zsh; Linux
  // includes bash/sh. Windows exercises both PS generations when installed.
  for (const name of process.platform === 'win32' ? ['powershell', 'pwsh'] : ['bash', 'zsh', 'sh']) {
    const shell = getShellByModelProvidedPath(name);
    it.skipIf(!shell)(`${name}: preserves quotes followed by spaces and adjacent paths`, async () => {
      const cwd = await fixture();
      const original = String.raw`rg -n "history=\"older\"|Load older" sample.txt second.txt`;
      const repaired = repairPowerShellQuoting(original, shell!.shellType);
      if (shell!.shellType !== 'powershell') expect(repaired).toEqual({ cmd: original, notes: [] });
      const command = bindBundledRipgrep(repaired.cmd, shell!.shellType, locateRipgrep());
      const args = deriveExecArgs(shell!, command, false);
      const output = execFileSync(args[0]!, args.slice(1), { cwd, encoding: 'utf8', windowsHide: true });
      expect(output.trim().split(/\r?\n/)).toEqual(['sample.txt:1:history="older"', 'sample.txt:2:Load older']);
      const batch = composeCommandBatch([command, command], shell!.shellType);
      const batchArgs = deriveExecArgs(shell!, batch.command, false);
      const batched = execFileSync(batchArgs[0]!, batchArgs.slice(1), { cwd, encoding: 'utf8', windowsHide: true });
      expect(parseCommandBatchSections(batched, batch.marker).map(row => ({ exit: row.exitCode, text: row.text.trim() })))
        .toEqual([{ exit: 0, text: output.trim() }, { exit: 0, text: output.trim() }]);
    });
  }
});

it('uses complete framed command outcomes for benign and mixed batch reporting', () => {
  const marker = '0123456789abcdef01234567';
  const complete = [
    `--- command 1/2 --- [clf-batch:${marker}]`,
    'no matches',
    `--- exit code 1 --- [clf-batch:${marker}]`,
    `--- command 2/2 --- [clf-batch:${marker}]`,
    'found it',
    `--- exit code 0 --- [clf-batch:${marker}]`
  ].join('\n');
  const outcome = commandBatchOutcome(complete, marker, 2);
  expect(outcome.complete).toBe(true);
  expect(outcome.mixed).toBe(true);
  const projected = projectCommandBatchNotes(outcome, {
    benign: false,
    commandFor: (section) => `cmd ${section.index}`,
    benignNote: () => 'no matches',
    recoveryNotes: (_section, command) => [`recovery for ${command}`]
  });
  expect(projected).toEqual([
    'Batch: command 1 exited 1; the other command exited 0. The top-line exit code is the first non-zero one.',
    'Command 1: recovery for cmd 1'
  ]);
  expect(projectCommandBatchNotes(outcome, {
    benign: true,
    commandFor: (section) => `cmd ${section.index}`,
    benignNote: () => 'returned no matches',
    recoveryNotes: () => []
  })).toEqual(['Command 1: returned no matches']);
  expect(commandBatchExitIsBenign(complete, marker, 2, 1, (section) => section.text === 'no matches')).toBe(true);
  expect(commandBatchExitIsBenign(complete, marker, 2, 1, () => false)).toBe(false);
  expect(commandBatchExitIsBenign(complete.split('\n').slice(0, 3).join('\n'), marker, 2, 1, () => true)).toBe(false);
});

const zsh = getShellByModelProvidedPath('zsh');
it.skipIf(!zsh)('restores bundled command discovery after a login profile rewrites PATH', async () => {
  const dir = await fixture();
  const bundled = join(dir, "app's bundled tools");
  mkdirSync(bundled);
  writeFileSync(join(bundled, 'rg'), '#!/bin/sh\nprintf bundled-rg\n', { mode: 0o755 });
  writeFileSync(join(dir, '.zprofile'), 'export PATH=/usr/bin:/bin\n');
  const command = withPosixPathPrefix('command -v rg; rg; printf "\\n%s" "$PATH"', 'zsh', bundled);
  const args = deriveExecArgs(zsh!, command, true);
  const result = spawnSync(args[0]!, args.slice(1), { encoding: 'utf8', env: { ...process.env, ZDOTDIR: dir } });
  expect(result.status).toBe(0);
  expect(result.stdout.trim().split('\n')).toEqual([join(bundled, 'rg'), 'bundled-rg', `${bundled}:/usr/bin:/bin`]);
});

it('leaves other shell languages and missing bundled paths unchanged', () => {
  expect(withPosixPathPrefix('Get-Command rg', 'powershell', '/bundle')).toBe('Get-Command rg');
  expect(withPosixPathPrefix('where rg', 'cmd', '/bundle')).toBe('where rg');
  expect(withPosixPathPrefix('command -v rg', 'sh', null)).toBe('command -v rg');
});

it.skipIf(!zsh)('preserves native zsh unmatched-glob failure instead of reporting no search matches', async () => {
  const command = bindBundledRipgrep('rg needle missing/*.ts', 'zsh', locateRipgrep());
  const args = deriveExecArgs(zsh!, command, false);
  const result = spawnSync(args[0]!, args.slice(1), { cwd: await fixture(), encoding: 'utf8', windowsHide: true });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  const output = result.stdout + result.stderr;
  expect(output).toContain('no matches found');
  expect(nonZeroExitIsBenign(command, result.status!, output)).toBe(false);
});

it('does not reinterpret fixed-string flags, quoted flag spellings, or PCRE literal regions as regex escapes', () => {
  for (const command of [
    String.raw`rg -F "history=\"older|Load older" sample.txt`,
    String.raw`rg "history=\"older|Load older" -F sample.txt`,
    String.raw`rg "history=\"older|Load older" '--fixed-strings' sample.txt`,
    String.raw`rg "history=\"older|Load older" -iF sample.txt`,
    String.raw`rg "history=\"older|Load older" -e "foo\"|bar" -F sample.txt`,
    String.raw`rg "history=\"older|Load older" $options sample.txt`,
    String.raw`rg -P "\Qhistory=\"older\E|Load older" sample.txt`
  ]) expect(repairPowerShellQuoting(command, 'powershell').cmd).not.toContain('\\x22');
});

it('keeps the Windows repair out of POSIX shell syntax', () => {
  for (const shell of ['bash', 'zsh', 'sh'] as const) {
    const cmd = String.raw`rg "history=\"older|Load older" src/*.ts && printf '%s\n' done`;
    expect(repairPowerShellQuoting(cmd, shell)).toEqual({ cmd, notes: [] });
  }
});

it('explains zsh glob refusal without suggesting replay of earlier statements', () => {
  const output = 'zsh:1: no matches found: missing/*.ts';
  const hints = execRecoveryHints('rg needle missing/*.ts', output, 'zsh');
  expect(hints).toHaveLength(1);
  expect(hints[0]).toContain("rg -g '<glob>'");
  expect(hints[0]).toContain('Earlier statements may already have run');
  expect(hints[0]).not.toContain('PowerShell');
  expect(execRecoveryHints('rg needle sample.txt', 'sample.txt:1:zsh: no matches found:', 'zsh')).toEqual([]);
});
