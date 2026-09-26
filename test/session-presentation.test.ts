/** Pure session display and summarization behavior, independent of durable session setup. */

import { describe, expect, it } from 'vitest';
import { lineDelta, formatDelta } from '../src/main/diffstat.js';
import { emptyEvidence } from '../src/main/mcp/call-context.js';
import { summarizeToolCall } from '../src/main/session/summarize.js';
import {
  estimateTokens,
  eventTokens,
  foldProgress,
  tokenPressure,
  type SessionEvent,
  type ToolOutcome
} from '../src/shared/session.js';

const evidence = (patch: Partial<ReturnType<typeof emptyEvidence>> = {}) => ({ ...emptyEvidence(), ...patch });

// --------------------------------------------------------------- summaries

describe('tool summaries', () => {
  const summarize = (tool: string, args: unknown, patch: Partial<ReturnType<typeof emptyEvidence>> = {}, outcome: ToolOutcome = 'ok', durationMs = 10) =>
    summarizeToolCall({ tool, args, evidence: evidence(patch), outcome, durationMs, resultHead: 'head line' });

  /** The patch text a summary reads its intent off. */
  const patch = (header: string, path: string): string =>
    `*** Begin Patch\n*** ${header}: ${path}\n*** End Patch`;

  it('names one edited file and totals several', () => {
    const one = summarize('apply_patch', { patch: patch('Update File', '/p/src/a.ts') }, {
      changes: [{ path: '/p/src/a.ts', added: 18, removed: 4, approximate: false }]
    });
    expect(one.title).toBe('Edited src/a.ts');
    expect(one.metric).toBe('+18 −4');

    const many = summarize('apply_patch', { patch: patch('Update File', '/p/a.ts') }, {
      changes: [
        { path: '/p/a.ts', added: 40, removed: 9, approximate: false },
        { path: '/p/b.ts', added: 32, removed: 10, approximate: false }
      ]
    });
    expect(many.title).toBe('Edited 2 files');
    expect(many.metric).toBe('+72 −19');
  });

  it('marks an approximate diffstat rather than pretending it is exact', () => {
    const summary = summarize('apply_patch', { patch: patch('Update File', '/p/big.ts') }, {
      changes: [{ path: '/p/big.ts', added: 4000, removed: 3000, approximate: true }]
    });
    expect(summary.metric).toBe('~+4000 −3000');
  });

  // One tool now covers create, edit, move and delete, so the title has to come from what
  // the patch did. A timeline that said "Applied a patch" four times would be useless.
  it('tells creates, deletes and moves apart from the patch itself', () => {
    expect(summarize('apply_patch', { patch: patch('Add File', '/p/src/history.ts') }, {
      changes: [{ path: '/p/src/history.ts', added: 214, removed: 0, approximate: false }]
    })).toMatchObject({ title: 'Created src/history.ts', metric: '+214', kind: 'create' });

    expect(summarize('apply_patch', { patch: patch('Delete File', '/p/old-helper.ts') }, {
      changes: [{ path: '/p/old-helper.ts', added: 0, removed: 83, approximate: false }]
    })).toMatchObject({ title: 'Deleted old-helper.ts', metric: '−83', tone: 'warn', kind: 'delete' });

    const moved = summarize(
      'apply_patch',
      { patch: '*** Begin Patch\n*** Move to: /p/new.ts\n*** End Patch' },
      { changes: [{ path: '/p/new.ts', added: 0, removed: 0, approximate: false }] }
    );
    expect(moved).toMatchObject({ title: 'Moved new.ts', kind: 'move' });

    // A patch that both adds and updates is simply an edit; it must not claim to be a create.
    const mixed = summarize(
      'apply_patch',
      { patch: `${patch('Add File', '/p/a.ts')}\n*** Update File: /p/b.ts` },
      {
        changes: [
          { path: '/p/a.ts', added: 5, removed: 0, approximate: false },
          { path: '/p/b.ts', added: 1, removed: 1, approximate: false }
        ]
      }
    );
    expect(mixed.kind).toBe('edit');
  });

  it('describes a read by its paths and range', () => {
    expect(summarize('read', { paths: ['/p/tools.ts'], start_line: 200, end_line: 420 })).toMatchObject({
      title: 'Read tools.ts',
      detail: 'lines 200–420',
      metric: '221 lines'
    });
    expect(
      summarize('read', { paths: ['/p/tools.ts'], start_line: 200, end_line: 420 }, { detail: 'lines 200–237' })
    ).toMatchObject({ detail: 'lines 200–237', metric: '38 lines' });
    expect(summarize('read', { paths: ['/p/a.ts', '/p/b.ts', '/p/c.ts'] })).toMatchObject({
      title: 'Read 3 paths',
      detail: 'a.ts, b.ts, c.ts'
    });
  });

  it('reports how a command exited', () => {
    expect(summarize('exec_command', { cmd: 'npm run verify' }, { exitCode: 0, durationMs: 4800 })).toMatchObject({
      title: 'Ran npm run verify',
      metric: '✓ 4.8s',
      tone: 'good'
    });
    const failed = summarize('exec_command', { cmd: 'npm test' }, { exitCode: 1, durationMs: 900 });
    expect(failed.title).toContain('Command failed');
    expect(failed.metric).toBe('✕ exit 1');
    expect(failed.tone).toBe('bad');
    expect(summarize('exec_command', { cmd: 'sleep 100' }, { exitCode: null, timedOut: true }).metric).toBe(
      '✕ timed out'
    );
    expect(
      summarize('exec_command', { cmd: 'npm run verify' }, { exitCode: null, durationMs: 10_000 })
    ).toMatchObject({ title: 'Started npm run verify', metric: 'started', tone: 'neutral' });
  });

  it('says which way a session was interrupted', () => {
    expect(summarize('write_stdin', { session_id: 'p1', signal: 'kill' })).toMatchObject({
      title: 'Stopped session p1',
      tone: 'warn'
    });
    expect(summarize('write_stdin', { session_id: 'p1', signal: 'int' }).title).toBe('Interrupted session p1');
    expect(summarize('write_stdin', { session_id: 'p1', chars: 'y\n' }).title).toBe('Wrote to session p1');
    expect(summarize('write_stdin', { session_id: 'p1' }).title).toBe('Waited on session p1');
  });

  it('keeps the subject but not the claim when a call fails or is refused', () => {
    const refused = summarize('apply_patch', { patch: patch('Delete File', '/p/x.ts') }, {
      changes: [{ path: '/p/x.ts', added: 0, removed: 3, approximate: false }]
    }, 'tool_rejected');
    expect(refused.title).toBe('Refused to delete x.ts');
    expect(refused.metric).toBe('refused');
    expect(refused.tone).toBe('warn');

    const errored = summarize('apply_patch', { patch: patch('Update File', '/p/x.ts') }, {
      changes: [{ path: '/p/x.ts', added: 1, removed: 1, approximate: false }]
    }, 'tool_internal_error');
    expect(errored.title).toBe('Could not edit x.ts');
    expect(errored.metric).toBe('✕ failed');
    expect(errored.detail).toBe('head line');
    expect(errored.tone).toBe('bad');
  });

  it('says a failed call failed in words, for every tool family', () => {
    const cases: Array<[string, unknown, string]> = [
      ['read', { paths: ['/p/x.ts'] }, 'Could not read x.ts'],
      ['find', { query: 'todo' }, 'Could not search "todo"'],
      ['apply_patch', { patch: patch('Update File', '/p/x.ts') }, 'Could not apply a patch'],
      ['exec_command', { cmd: 'npm test' }, 'Could not run npm test'],
      ['observe', {}, 'Could not look at the screen'],
      ['agents', { action: 'spawn', workers: [{ task: 'a' }, { task: 'b' }] }, 'Could not create 2 worker agents'],
      [
        'agents',
        { action: 'message', messages: [{ to: 'worker-1', text: 'a' }, { to: 'worker-2', text: 'b' }] },
        'Could not message 2 agents'
      ],
      ['agents', { action: 'finish', result: 'done' }, 'Could not report the finished task'],
      ['some_future_tool', {}, 'Could not run some_future_tool']
    ];
    for (const [tool, args, title] of cases) {
      const summary = summarize(tool, args, {}, 'tool_internal_error');
      expect(summary.title, tool).toBe(title);
      // Nothing may still read as an accomplished action.
      expect(summary.title, tool).not.toMatch(/^(Read|Applied|Created|Searched|Ran|Messaged|Reported|Looked) /);
    }
  });

  it('reads the action out of the flat session and agents tools', () => {
    expect(summarize('agents', { action: 'spawn', workers: [{ task: 'a' }, { task: 'b' }] }).title).toBe(
      'Created 2 worker agents'
    );
    expect(summarize('agents', { action: 'message', to: 'worker-2' }).title).toBe('Messaged worker-2');
    expect(summarize('agents', { action: 'status' }).title).toBe('Checked agent status');
    expect(summarize('session', { action: 'search', query: 'tunnel' }).title).toBe(
      'Searched recordings "tunnel"'
    );
    expect(summarize('session', { action: 'search' }).title).toBe('Listed recent recordings');
    expect(summarize('session', { action: 'read', session_id: 'session-one' }).title).toBe(
      'Read a recorded session'
    );
    expect(summarize('session', { action: 'read', session_id: 'session-one', cursor: 'opaque' }).title).toBe(
      'Continued reading a recorded session'
    );
  });

  it('names the desktop action rather than saying "computer"', () => {
    expect(summarize('computer', { actions: [{ type: 'click_ref', ref: 'e1' }] })).toMatchObject({
      title: 'Clicked',
      kind: 'input'
    });
    // Clipboard-only work is not desktop input and should not read as if it were.
    expect(summarize('computer', { actions: [{ type: 'read_clipboard' }] })).toMatchObject({
      title: 'Read the clipboard',
      kind: 'clipboard'
    });
    expect(
      summarize('computer', { actions: [{ type: 'write_clipboard', text: 'x' }, { type: 'keypress', keys: ['ctrl', 'v'] }] })
    ).toMatchObject({ kind: 'input', detail: '2 actions' });
  });

  it('shows the command that actually ran instead of the words "a command"', () => {
    const single = summarize('exec_command', { cmd: 'Get-Process -Name node' }, { exitCode: 0, durationMs: 120 });
    expect(single.title).toBe('Ran Get-Process -Name node');

    const many = summarize(
      'exec_command',
      { cmd: '# find the build\r\nGet-ChildItem -Recurse -Filter *.log\nSelect-Object -First 5' },
      { exitCode: 0, durationMs: 120 }
    );
    // Comments are skipped, the first real line leads, and the rest is signalled.
    expect(many.title).toBe('Ran Get-ChildItem -Recurse -Filter *.log …');

    const long = summarize('exec_command', { cmd: `Write-Output ${'x'.repeat(200)}` }, { exitCode: 0 });
    expect(long.title.length).toBeLessThan(90);
    expect(long.title.endsWith('…')).toBe(true);

    expect(summarize('exec_command', {}, { exitCode: 1, durationMs: 5 }).title).toBe('Command failed a command');
  });

  it('falls back to the tool name rather than "Called tool"', () => {
    expect(summarize('some_future_tool', {}).title).toBe('Ran some_future_tool');
  });
});

// ---------------------------------------------------------------- diffstat

describe('line deltas', () => {
  it('counts a pure insertion and a pure deletion exactly', () => {
    expect(lineDelta('a\nb\n', 'a\nnew\nb\n')).toEqual({ added: 1, removed: 0, approximate: false });
    expect(lineDelta('a\nb\nc\n', 'a\nc\n')).toEqual({ added: 0, removed: 1, approximate: false });
  });

  it('counts a replacement as one added and one removed', () => {
    expect(lineDelta('a\nb\nc\n', 'a\nB\nc\n')).toEqual({ added: 1, removed: 1, approximate: false });
  });

  it('reports nothing for identical text, including a new file', () => {
    expect(lineDelta('same\n', 'same\n')).toEqual({ added: 0, removed: 0, approximate: false });
    expect(lineDelta('', 'one\ntwo\n')).toEqual({ added: 2, removed: 0, approximate: false });
    expect(formatDelta({ added: 0, removed: 0 })).toBeNull();
  });

  it('handles a reordered block without inventing changes', () => {
    const before = ['a', 'b', 'c', 'd', 'e'].join('\n');
    const after = ['a', 'c', 'b', 'd', 'e'].join('\n');
    expect(lineDelta(before, after)).toEqual({ added: 1, removed: 1, approximate: false });
  });

  it('counts sparse edits exactly even when they are thousands of lines apart', () => {
    const before = Array.from({ length: 4000 }, (_, i) => `line ${i}`);
    const after = [...before];
    after[10] = 'changed ten';
    after[3500] = 'changed thirty-five hundred';
    expect(lineDelta(before.join('\n'), after.join('\n'))).toEqual({
      added: 2,
      removed: 2,
      approximate: false
    });
  });

  it('normalizes CRLF/LF for sparse large-file counting', () => {
    const before = Array.from({ length: 3200 }, (_, i) => `line ${i}`);
    const after = [...before];
    after[5] = 'changed five';
    after[3000] = 'changed three thousand';
    expect(lineDelta(`${before.join('\r\n')}\r\n`, `${after.join('\n')}\n`)).toEqual({
      added: 2,
      removed: 2,
      approximate: false
    });
  });

  it('says so when a rewrite is too large to diff exactly', () => {
    const before = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join('\n');
    const after = Array.from({ length: 4000 }, (_, i) => `changed ${i}`).join('\n');
    const delta = lineDelta(before, after);
    expect(delta.approximate).toBe(true);
    expect(delta.added).toBe(4000);
  });

  it('formats the metric the way the timeline shows it', () => {
    expect(formatDelta({ added: 18, removed: 4 })).toBe('+18 −4');
    expect(formatDelta({ added: 214, removed: 0 })).toBe('+214');
    expect(formatDelta({ added: 0, removed: 83 })).toBe('−83');
  });
});

// ------------------------------------------------------------------ tokens

describe('token estimation', () => {
  it('is an explicit approximation of local text only', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('a'.repeat(4001))).toBe(1001);
  });

  it('weighs an event by the text actually kept', () => {
    const event = {
      seq: 1,
      time: 1,
      source: 'mcp',
      kind: 'tool_call',
      call: {
        callId: 'c1',
        tool: 'read_file',
        attribution: 'turn',
        args: { text: 'a'.repeat(400), truncated: false, chars: 400 },
        result: { text: 'b'.repeat(800), truncated: false, chars: 800 },
        outcome: 'ok',
        durationMs: 3,
        summary: { title: 'Read a.ts', tone: 'neutral', kind: 'read' }
      }
    } as SessionEvent;
    expect(eventTokens(event)).toBe(100 + 200 + Math.ceil('Read a.ts'.length / 4));
  });

  it('caps a truncated tool return independently of its preview and asset reference', () => {
    const event = { seq: 1, time: 1, source: 'mcp', kind: 'tool_call', call: {
      callId: 'full-result', tool: 'read', attribution: 'turn',
      args: { text: 'short preview with a recorder annotation', truncated: true, chars: 20001, assetId: 'args.txt' },
      result: { text: 'x'.repeat(8000) + ' [52306 characters stored as result.txt]', truncated: true, chars: 60306, assetId: 'result.txt' },
      outcome: 'ok', durationMs: 1, summary: { title: 'Read 3 paths', tone: 'neutral', kind: 'read' },
      assets: [{ id: 'result.txt', mimeType: 'text/plain', bytes: 60306 }]
    } } as SessionEvent;
    expect(eventTokens(event)).toBe(Math.ceil(20001 / 4) + 10000 + estimateTokens('Read 3 paths'));
    if (event.kind !== 'tool_call') throw new Error('fixture');
    delete event.call.result.assetId;
    event.call.result.text = 'Another bounded preview; overflow asset unavailable';
    expect(eventTokens(event)).toBe(Math.ceil(20001 / 4) + 10000 + estimateTokens('Read 3 paths'));
  });

  it.each([0, 39996, 40000, 40004, 524582])('caps inline MCP returns at the boundary (%i characters)', chars => {
    const event = { seq: 1, time: 1, source: 'mcp', kind: 'tool_call', call: {
      args: { text: 'a'.repeat(80000), truncated: false, chars: 80000 },
      result: { text: 'r'.repeat(chars), truncated: false, chars }, summary: { title: '' }
    } } as SessionEvent;
    expect(eventTokens(event)).toBe(20000 + Math.min(10000, Math.ceil(chars / 4)));
  });

  it.each([undefined, -1, NaN, Infinity, 2.5])('keeps legacy or malformed original lengths bounded by actual inline text (%s)', chars => {
    const event = { seq: 1, time: 1, source: 'extension', kind: 'user_message',
      message: { text: 'abcdefgh', truncated: true, chars } } as SessionEvent;
    expect(eventTokens(event)).toBe(2);
  });

  it('does not inflate the context advisory with transient progress captions', () => {
    const event = {
      seq: 1,
      time: 1,
      source: 'extension',
      kind: 'progress',
      message: { text: 'reasoning status '.repeat(100), truncated: false, chars: 1700 }
    } as SessionEvent;
    expect(eventTokens(event)).toBe(0);
  });

  it('counts a brokered agent message, which the model does read', () => {
    const event = {
      seq: 1,
      time: 1,
      source: 'app',
      kind: 'agent_message',
      messageId: 'm1',
      from: 'worker-1',
      to: 'prime',
      message: { text: 'r'.repeat(1200), truncated: false, chars: 1200 },
      delivery: 'delivered'
    } as SessionEvent;
    expect(eventTokens(event)).toBe(300);
  });

  it('grades pressure against the configured thresholds', () => {
    expect(tokenPressure(50_000, 180_000, 200_000).level).toBe('ok');
    expect(tokenPressure(185_000, 180_000, 200_000).level).toBe('large');
    expect(tokenPressure(220_000, 180_000, 200_000).level).toBe('huge');
  });
});

/**
 * The log is append-only, so a commentary line being written arrives as a run of records
 * under one id. Every reader that is not watching it live wants the opposite: the newest
 * text, once, where the line started.
 */
describe('folding redrawn commentary', () => {
  const progress = (seq: number, progressId: string, text: string, origin?: number): SessionEvent =>
    ({
      seq,
      time: seq,
      source: 'extension',
      kind: 'progress',
      progressId,
      ...(origin === undefined ? {} : { origin }),
      message: { text, truncated: false, chars: text.length }
    }) as SessionEvent;

  it('keeps a Stop request truthful when the page reports stopped without a final answer', () => {
    const pending: SessionEvent = { ...progress(2, 'finish-release:stop-one', 'Stop requested. ChatGPT has not yet confirmed that generation stopped.'), source: 'app', turnId: 'stop-one' };
    const stopped: SessionEvent = { seq: 4, time: 4, source: 'extension', kind: 'turn_end', turnId: 'stop-one', outcome: 'stopped' };
    const rows = [pending, stopped];
    const folded = foldProgress(rows);
    expect(folded).toHaveLength(2);
    expect(folded[0]).toEqual(pending);
    expect(foldProgress(folded)).toEqual(folded);
    expect(pending.kind === 'progress' && pending.message.text).toContain('not yet confirmed');
  });
  it.each(['completed', 'interrupted', 'error', 'unknown'])('does not confirm Stop from a %s outcome', outcome => {
    const pending: SessionEvent = { ...progress(2, 'finish-release:stop-one', 'Stop requested. Still unconfirmed.'), source: 'app', turnId: 'stop-one' };
    const end = { seq: 4, time: 4, source: 'extension', kind: 'turn_end', turnId: 'stop-one', outcome } as SessionEvent;
    expect(foldProgress([pending, end])[0]).toEqual(pending);
  });
  it('never lets another turn or app-authored terminal evidence confirm a pending Stop', () => {
    const pending: SessionEvent = { ...progress(2, 'finish-release:stop-one', 'Stop requested. Still unconfirmed.'), source: 'app', turnId: 'stop-one' };
    const other: SessionEvent = { seq: 4, time: 4, source: 'extension', kind: 'turn_end', turnId: 'other', outcome: 'stopped' };
    const synthetic: SessionEvent = { ...other, source: 'app', turnId: 'stop-one' };
    expect(foldProgress([pending, other, synthetic])[0]).toEqual(pending);
  });

  it('keeps the newest text at the earliest record’s position', () => {
    const folded = foldProgress([
      progress(1, 'p1', 'Monitoring'),
      progress(2, 'p2', 'Reading'),
      progress(3, 'p1', 'Monitoring the review', 1),
      progress(4, 'p1', 'Wrote the summary', 1)
    ]);

    expect(folded.map((event) => event.seq)).toEqual([1, 2]);
    expect(folded.map((event) => (event as { message: { text: string } }).message.text)).toEqual([
      'Wrote the summary',
      'Reading'
    ]);
  });

  it('leaves everything that is not identified commentary exactly where it was', () => {
    const events: SessionEvent[] = [
      { seq: 1, time: 1, source: 'extension', kind: 'turn_start' } as SessionEvent,
      progress(2, 'p1', 'first'),
      // No id: an older recording, or a page that would not take the stamp. Nothing to fold.
      {
        seq: 3,
        time: 3,
        source: 'extension',
        kind: 'progress',
        message: { text: 'unidentified', truncated: false, chars: 12 }
      } as SessionEvent,
      progress(4, 'p1', 'second', 2),
      { seq: 5, time: 5, source: 'extension', kind: 'turn_end', outcome: 'completed' } as SessionEvent
    ];

    const folded = foldProgress(events);
    expect(folded.map((event) => event.seq)).toEqual([1, 2, 3, 5]);
    expect(foldProgress(events)).toEqual(folded);
    // Non-destructive: the original array is untouched.
    expect(events).toHaveLength(5);
  });
});

/**
 * Where the store writes when nobody has told it where.
 *
 * `root` starts as the empty string, and `path.join('', id)` is a relative path — so an
 * uninitialised store did not fail, it wrote real session folders into the process's
 * working directory. Recording being off by default hid that completely. The moment it
 * was turned on, a test run started leaving recordings scattered through the repository,
 * and the only reason it was noticed was `git status`.
 */
