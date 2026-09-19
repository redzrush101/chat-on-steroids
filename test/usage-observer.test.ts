import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const script = readFileSync(new URL('../extension/usage.js', import.meta.url), 'utf8');
function harness() {
  const posts: Array<Record<string, any>> = [];
  let now = Date.parse('2026-09-05T12:00:00Z');
  class Clock extends Date { static override now() { return now; } }
  let response: unknown;
  let nextBodyGate: Promise<void> | null = null;
  const timers = new Map<number, { at: number; run: () => void }>();
  let timerId = 0;
  const listeners = new Map<string, Array<{ handler: (event: unknown) => void; once: boolean }>>();
  const document = { readyState: 'loading' };
  class Socket {
    static OPEN = 1;
    handlers: Array<(event: { data: string }) => void> = [];
    constructor(readonly url: string) {}
    addEventListener(type: string, listener: (event: { data: string }) => void) { if (type === 'message') this.handlers.push(listener); }
    receive(data: unknown) { for (const listener of this.handlers) listener({ data: JSON.stringify(data) }); }
  }
  const window = {
    WebSocket: Socket,
    fetch: (..._args: unknown[]) => Promise.resolve(response),
    postMessage: (data: unknown) => posts.push(JSON.parse(JSON.stringify(data))),
    addEventListener: (type: string, handler: (event: unknown) => void, options?: { once?: boolean }) => {
      const rows = listeners.get(type) ?? [];
      rows.push({ handler, once: options?.once === true });
      listeners.set(type, rows);
    }
  };
  const dispatch = (type: string, event: unknown) => {
    const rows = listeners.get(type) ?? [];
    listeners.set(type, rows.filter(row => !row.once));
    for (const row of rows) row.handler(event);
  };
  runInNewContext(script, { window, document, location: { origin: 'https://chatgpt.com' }, URL, Date: Clock, TextDecoder,
    setTimeout: (run: () => void, ms: number) => { timers.set(++timerId, { at: now + ms, run }); return timerId; },
    clearTimeout: (id: number) => timers.delete(id) });
  async function feed(data: unknown, url = 'https://chatgpt.com/backend-api/wham/usage', init: Record<string, unknown> = {}) {
    let done: () => void = () => {};
    const inspected = new Promise<void>(resolve => { done = resolve; });
    let read = false;
    const bodyGate = nextBodyGate; nextBodyGate = null;
    const body = new TextEncoder().encode(JSON.stringify(data));
    response = { url, ok: true, headers: { get: () => 'application/json' }, clone: () => ({ body: { getReader: () => ({
      read: async () => { await bodyGate; return read ? { done: true } : (read = true, { done: false, value: body }); },
      cancel: async () => { done(); }
    }) } }) };
    const expectedResponse = response;
    const returned = await window.fetch('/endpoint', { headers: { Authorization: 'private-test-value' }, ...init });
    expect(returned).toBe(expectedResponse);
    if (new URL(url).origin === 'https://chatgpt.com' &&
        /^\/backend-api\/(wham\/usage|conversation\/init|conversation\/prepare|models|conversation(?:s)?\/[0-9a-f-]{36})$/.test(new URL(url).pathname)) await inspected;
    else await new Promise(resolve => setTimeout(resolve, 0));
  }
  async function feedSse(chunks: string[], init: Record<string, unknown> = { method: 'POST' }, url = 'https://chatgpt.com/backend-api/conversation') {
    let done: () => void = () => {};
    const inspected = new Promise<void>(resolve => { done = resolve; });
    let at = 0;
    response = {
      url,
      ok: true,
      headers: { get: () => 'text/event-stream; charset=utf-8' },
      clone: () => ({ body: { getReader: () => ({
        read: async () => at < chunks.length
          ? { done: false, value: new TextEncoder().encode(chunks[at++]!) }
          : { done: true },
        cancel: async () => { done(); }
      }) } })
    };
    const returned = await window.fetch('/backend-api/conversation', init);
    expect(returned).toBe(response);
    if (String(init.method || 'GET').toUpperCase() === 'POST' && new URL(url).origin === 'https://chatgpt.com' && /^\/backend-api\/(?:f\/)?conversation$/.test(new URL(url).pathname)) await inspected;
    else await new Promise(resolve => setTimeout(resolve, 0));
  }
  return {
    posts,
    nativeSocket: Socket,
    socket: (url = 'wss://ws.chatgpt.com/ws') => new window.WebSocket(url),
    feed,
    feedSse,
    openSse: async () => {
      let resolve: (value: unknown) => void = () => {};
      let cancelled = false, clones = 0;
      const reader = {
        read: () => new Promise(done => { resolve = done; }),
        cancel: async () => { cancelled = true; resolve({ done: true }); }
      };
      response = { url: 'https://chatgpt.com/backend-api/f/conversation', ok: true,
        headers: { get: () => 'text/event-stream' },
        clone: () => { clones++; return { body: { getReader: () => reader } }; } };
      await window.fetch('/backend-api/f/conversation', { method: 'POST' });
      return { push: (data: unknown) => resolve({ done: false, value: new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`) }),
        get cancelled() { return cancelled; }, get clones() { return clones; } };
    },
    hide: () => dispatch('pagehide', {}),
    replaceFetch: (wrapExisting = false) => {
      const previous = window.fetch;
      const replacement = (...args: unknown[]) => wrapExisting ? previous(...args) : Promise.resolve(response);
      window.fetch = replacement;
      return replacement;
    },
    ready: () => { document.readyState = 'interactive'; dispatch('DOMContentLoaded', {}); },
    currentFetch: () => window.fetch,
    holdNextBody: () => { let release = () => {}; nextBodyGate = new Promise<void>(resolve => { release = resolve; }); return () => release(); },
    advance: (ms: number) => { now += ms; for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.run(); } },
    request: (source: unknown = window, origin = 'https://chatgpt.com') => dispatch('message', { source, origin, data: { type: 'cos-usage-request' } })
  };
}

describe('MAIN-world usage projection', () => {
  it('observes the Pro socket handoff with exact inner/outer conversation proof and shares HTTP deduplication', async () => {
    const h = harness(), socket = h.socket();
    expect(socket).toBeInstanceOf(h.nativeSocket);
    const conversation_id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const frame = `data: ${JSON.stringify({ conversation_id, message: { metadata: { request_id: 'wfr_socket' } } })}\n\n`;
    const envelope = [{ type: 'message', payload: { type: 'conversation-turn-stream', payload: {
      type: 'stream-item', conversation_id, encoded_item: frame
    } } }];
    socket.receive(envelope); socket.receive(envelope);
    expect(h.posts).toHaveLength(1);
    await h.feedSse([frame]);
    expect(h.posts).toHaveLength(1);
    h.request(); expect(h.posts).toHaveLength(2);
  });
  it('rejects foreign sockets, contradictory envelopes and request IDs hidden in model text', () => {
    const h = harness(), socket = h.socket();
    const conversation_id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const envelope = (value: unknown, owner = conversation_id) => [{ type: 'message', payload: {
      type: 'conversation-turn-stream', payload: { type: 'stream-item', conversation_id: owner,
        encoded_item: `data: ${JSON.stringify(value)}\n\n` }
    } }];
    const value = { conversation_id, message: { metadata: { request_id: 'wfr_exact' } } };
    h.socket('wss://chatgpt.com.evil.test/ws').receive(envelope(value));
    socket.receive(envelope(value, '11111111-2222-3333-4444-555555555555'));
    socket.receive(envelope({ conversation_id, message: { content: JSON.stringify(value) } }));
    socket.receive(envelope(value).concat(Array(33).fill({})));
    expect(h.posts).toHaveLength(0);
  });
  it('listens beyond five minutes, deduplicates and replays bounded ID evidence, then cancels at fifteen minutes', async () => {
    const h = harness();
    const stream = await h.openSse();
    h.advance(6 * 60_000);
    expect(stream.cancelled).toBe(false);
    const event = { conversation_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', metadata: { request_id: 'wfr_late' } };
    stream.push(event);
    await Promise.resolve(); await Promise.resolve();
    expect(h.posts).toHaveLength(1);
    stream.push(event);
    await Promise.resolve(); await Promise.resolve();
    expect(h.posts).toHaveLength(1);
    h.request();
    expect(h.posts).toHaveLength(2);
    expect(h.posts[1]).toEqual(h.posts[0]);
    h.advance(9 * 60_000);
    expect(stream.cancelled).toBe(true);
    h.hide(); h.request();
    expect(h.posts).toHaveLength(2);
  });
  it('bounds concurrent response clones and releases them on page exit', async () => {
    const h = harness();
    const a = await h.openSse(), b = await h.openSse(), c = await h.openSse();
    expect([a.clones, b.clones, c.clones]).toEqual([1, 1, 0]);
    h.hide();
    expect(a.cancelled && b.cancelled).toBe(true);
  });
  it('retains supported model counts without requiring a reset timestamp', async () => {
    const h = harness();
    await h.feed({ model_limits: [{ model_slug: 'model-a', remaining: 3 }, { model_slug: 'model-b', remaining: 0, resets_after: 'invalid' }, { model_slug: 'unknown' }] });
    expect(h.posts[0]?.rows).toEqual([
      expect.objectContaining({ model: 'model-a', remaining: 3, resetAt: null }),
      expect.objectContaining({ model: 'model-b', remaining: 0, resetAt: null })
    ]);
  });
  it('rejects an older response completing after a newer recognized snapshot, even within one millisecond', async () => {
    const h = harness();
    const release = h.holdNextBody();
    const old = h.feed({ limits_progress: [{ model_slug: 'old-model', remaining: 3 }] });
    await h.feed({ limits_progress: [] });
    release(); await old;
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]?.rows).toEqual([]);
    h.request();
    expect(h.posts[1]?.rows).toEqual([]);
  });
  it('preserves invocation time and does not let unrelated newer responses suppress quota evidence', async () => {
    const h = harness();
    const release = h.holdNextBody();
    const old = h.feed({ limits_progress: [{ model_slug: 'model-a', remaining: 3 }] });
    h.advance(2000);
    await h.feed({ models: [] }, 'https://chatgpt.com/backend-api/models');
    release(); await old;
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]?.observedAt).toBe(Date.parse('2026-09-05T12:00:00Z'));
  });
  it('projects shared percentage windows without copying credentials or inventing a model balance', async () => {
    const h = harness();
    await h.feed({ access_token: 'secret', email: 'private@example.test', rate_limit: { primary_window: { used_percent: 25, reset_at: 1900000000, limit_window_seconds: 18000 } } });
    expect(h.posts).toEqual([{ type: 'cos-usage', observedAt: expect.any(Number), rows: [{ model: 'Shared usage', scope: 'shared', remaining: null, remainingPercent: 75, resetAt: 1900000000000, windowSeconds: 18000 }] }]);
    expect(JSON.stringify(h.posts)).not.toMatch(/secret|private|Authorization/);
  });

  it('keeps model and feature evidence separate', async () => {
    const h = harness();
    await h.feed({ conversation_detail_metadata: { limits_progress: [{ feature_name: 'deep-research', remaining: 5 }, { model_slug: 'gpt-example', remaining: 2 }], model_limits: [{ model_slug: 'gpt-exhausted', resets_after: '2030-01-01T00:00:00Z' }] } }, 'https://chatgpt.com/backend-api/conversation/init');
    expect(h.posts[0]?.rows).toEqual([
      expect.objectContaining({ model: 'gpt-exhausted', scope: 'model', remaining: null }),
      expect.objectContaining({ model: 'deep-research', scope: 'feature', remaining: 5 }),
      expect.objectContaining({ model: 'gpt-example', scope: 'model', remaining: 2 })
    ]);
  });

  it('ignores foreign and unrelated responses, invalid counts and oversized payloads', async () => {
    const h = harness();
    const valid = { rate_limit: { primary_window: { used_percent: 20 } } };
    await h.feed(valid, 'https://example.test/backend-api/wham/usage');
    await h.feed(valid, 'https://chatgpt.com/backend-api/conversations');
    await h.feed({ limits_progress: [{ model_slug: 'gpt-example', remaining: -2 }, { model_slug: 'gpt-other', remaining: '3' }], rate_limit: { primary_window: { used_percent: 101 } } });
    await h.feed({ ...valid, padding: 'x'.repeat(513 * 1024) });
    expect(h.posts).toEqual([{ type: 'cos-usage', observedAt: expect.any(Number), rows: [] }]);
  });

  it('does not emit zero reset timestamps or durations rejected by the app schema', async () => {
    const h = harness();
    await h.feed({ rate_limit: { primary_window: { used_percent: 20, reset_at: 0, limit_window_seconds: 0 } } });
    expect(h.posts[0]?.rows[0]).toMatchObject({ remainingPercent: 80, resetAt: null, windowSeconds: null });
  });

  it('only replays to an exact same-page request', async () => {
    const h = harness();
    await h.feed({ rate_limit: { primary_window: { used_percent: 20 } } });
    h.request({}, 'https://chatgpt.com');
    h.request(undefined, 'https://example.test');
    expect(h.posts).toHaveLength(1);
    h.advance(600000);
    h.request();
    expect(h.posts).toHaveLength(2);
    expect(h.posts[1]?.observedAt).toBe(h.posts[0]?.observedAt);
  });

  it('projects a bounded picker-v2 model snapshot without treating it as quota data', async () => {
    const h = harness();
    await h.feed({
      model_picker_version: 2,
      default_model_slug: 'gpt-5-6',
      account_email: 'private@example.test',
      models: [
        { slug: 'gpt-5-6', title: 'GPT-5.6 Sol', reasoning_type: 'auto', configurable_thinking_effort: false, thinking_efforts: [], is_work_mode_model: false, private: 'drop' },
        { slug: 'gpt-5-6-instant', title: 'GPT-5.6 Sol', reasoning_type: 'none', configurable_thinking_effort: false, thinking_efforts: [], is_work_mode_model: false },
        { slug: 'gpt-5-6-thinking', title: 'GPT-5.6 Sol', reasoning_type: 'reasoning', configurable_thinking_effort: true,
          thinking_efforts: [{ thinking_effort: 'standard', extra: 'drop' }, { thinking_effort: 'extended' }], is_work_mode_model: false },
        { slug: 'gpt-5-6-t-mini', title: 'GPT-5.6 Luna', reasoning_type: 'reasoning', configurable_thinking_effort: false,
          thinking_efforts: [{ thinking_effort: 'standard' }], is_work_mode_model: false }
      ],
      versions: [{
        id: '5.6', display_text_for_intelligence: 'GPT-5.6 Sol', enabled: true,
        slugs: ['gpt-5-6', 'gpt-5-6-instant', 'gpt-5-6-thinking', 'gpt-5-6-t-mini'],
        intelligence_presets: [
          { model_slug: 'gpt-5-6-instant', lane: 'instant', title: 'Instant', preset_type: 'available' },
          { model_slug: 'gpt-5-6-thinking', lane: 'thinking', title: 'Medium', preset_type: 'available', thinking_effort: 'standard' },
          { model_slug: 'gpt-5-6-thinking', lane: 'thinking', title: 'High', preset_type: 'available', thinking_effort: 'extended' },
          { model_slug: 'gpt-5-6-t-mini', lane: 'thinking', title: 'Medium', preset_type: 'available', thinking_effort: 'standard' }
        ],
        private_version_state: 'drop'
      }]
    }, 'https://chatgpt.com/backend-api/models');
    expect(h.posts).toEqual([expect.objectContaining({
      type: 'cos-model-snapshot',
      observedAt: expect.any(Number),
      snapshot: expect.objectContaining({
        modelPickerVersion: 2,
        defaultModelSlug: 'gpt-5-6',
        models: expect.arrayContaining([
          expect.objectContaining({ slug: 'gpt-5-6-thinking', title: 'GPT-5.6 Sol', thinkingEfforts: ['standard', 'extended'] })
        ]),
        versions: [expect.objectContaining({
          id: '5.6',
          label: 'GPT-5.6 Sol',
          enabled: true,
          presets: expect.arrayContaining([
            { modelSlug: 'gpt-5-6-thinking', lane: 'thinking', title: 'Medium', presetType: 'available', thinkingEffort: 'standard' }
          ])
        })]
      })
    })]);
    expect(JSON.stringify(h.posts)).not.toMatch(/private@example|private_version_state|"private"/);
    await h.feed({ conversation_detail_metadata: { model_limits: [], limits_progress: [] } }, 'https://chatgpt.com/backend-api/conversation/prepare');
    expect(h.posts.at(-1)).toEqual({ type: 'cos-usage', observedAt: expect.any(Number), rows: [] });
  });

  it('bounds the complete projection and rejects labels that could carry private or executable text', async () => {
    const h = harness();
    await h.feed({ limits_progress: [{ model_slug: 'private@example.test', remaining: 3 }, { feature_name: '<script>secret</script>', remaining: 5 }] });
    expect(h.posts[0]?.rows).toEqual([]);
    await h.feed({
      model_limits: Array.from({ length: 45 }, (_, i) => ({ model_slug: `model-${i}`, resets_after: '2030-01-01T00:00:00Z' })),
      limits_progress: Array.from({ length: 45 }, (_, i) => ({ feature_name: `feature-${i}`, remaining: 3 })),
      rate_limit: { primary_window: { used_percent: 20 } }
    });
    expect(h.posts[1]?.rows).toHaveLength(80);
    expect(JSON.stringify(h.posts)).not.toMatch(/private@example|<script>/);
  });

  it('publishes an exact conversation/request pair from a chunked live response before React renders it', async () => {
    const h = harness();
    const conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    await h.feedSse([
      `data: {"conversation_id":"${conversationId}","message":{"metadata":{"request_`,
      'id":"wfr_early_exact"},"content":{"parts":["private prompt and tool args"]}}}\n\n',
      `data: {"conversation_id":"${conversationId}","message":{"metadata":{"request_id":"wfr_early_exact"}}}\n\n`,
      `data: {"conversation_id":"${conversationId}","message":{"metadata":{"request_id":"wfr_second"}}}\n\n`
    ]);

    expect(h.posts).toEqual([
      { type: 'cos-request-origin', conversationId, requestIds: ['wfr_early_exact'], observedAt: expect.any(Number) },
      { type: 'cos-request-origin', conversationId, requestIds: ['wfr_second'], observedAt: expect.any(Number) }
    ]);
    expect(JSON.stringify(h.posts)).not.toContain('private prompt');
    expect(JSON.stringify(h.posts)).not.toContain('tool args');
  });

  it('projects public authored messages from the provider stream without private analysis or metadata', async () => {
    const h = harness();
    const conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const final = {
      conversation_id: conversationId,
      message: {
        id: '11111111-2222-4333-8444-555555555555',
        author: { role: 'assistant' },
        recipient: 'all',
        channel: 'final',
        content: { content_type: 'text', parts: ['Visible answer'] },
        create_time: 1_800_000_000.25,
        end_turn: true,
        status: 'finished_successfully',
        metadata: {
          working_turn_id: 'turn-1',
          turn_exchange_id: 'exchange-1',
          private_secret: 'must-not-cross'
        }
      }
    };
    const hidden = {
      conversation_id: conversationId,
      message: {
        id: '66666666-7777-4888-8999-aaaaaaaaaaaa',
        author: { role: 'assistant' },
        channel: 'analysis',
        content: { content_type: 'text', parts: ['private reasoning'] }
      }
    };
    await h.feedSse([
      `data: ${JSON.stringify(hidden)}\n\n`,
      `data: ${JSON.stringify(final)}\n\n`
    ]);
    expect(h.posts).toEqual([{
      type: 'cos-stream-message',
      conversationId,
      observedAt: expect.any(Number),
      live: true,
      message: {
        role: 'assistant',
        messageId: '11111111-2222-4333-8444-555555555555',
        providerMessageId: '11111111-2222-4333-8444-555555555555',
        state: 'final',
        final: true,
        text: 'Visible answer',
        authoredAt: 1_800_000_000_250
      }
    }]);
    expect(JSON.stringify(h.posts)).not.toMatch(/private reasoning|private_secret|must-not-cross/);
  });

  it('keeps connector result metadata out of the public assistant transcript', async () => {
    const h = harness();
    const conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const result = {
      conversation_id: conversationId,
      message: {
        id: '11111111-2222-4333-8444-555555555555',
        author: { role: 'assistant' },
        recipient: 'all',
        channel: 'final',
        content: { content_type: 'text', parts: ['connector result must stay tool activity'] },
        metadata: { invoked_resource: { app_name: 'private-app', resource_uri: 'tool://private' } }
      }
    };
    await h.feedSse(['data: ' + JSON.stringify(result) + '\n\n']);
    expect(h.posts).toEqual([]);
  });

  it('projects only the current branch from an existing conversation history response', async () => {
    const h = harness();
    const conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const history = {
      id: conversationId,
      current_node: 'a2',
      mapping: {
        root: { id: 'root', parent: null, message: null },
        u1: { id: 'u1', parent: 'root', message: {
          id: '11111111-1111-4111-8111-111111111111', author: { role: 'user' }, create_time: 1_800_000_000,
          content: { content_type: 'text', parts: ['Question'] }
        } },
        a1: { id: 'a1', parent: 'u1', message: {
          id: '22222222-2222-4222-8222-222222222222', author: { role: 'assistant' }, recipient: 'all', channel: 'final',
          create_time: 1_800_000_001, end_turn: true, status: 'finished_successfully',
          content: { content_type: 'text', parts: ['Chosen answer'] }
        } },
        alternate: { id: 'alternate', parent: 'u1', message: {
          id: '33333333-3333-4333-8333-333333333333', author: { role: 'assistant' }, recipient: 'all', channel: 'final',
          content: { content_type: 'text', parts: ['Unselected retry'] }
        } },
        a2: { id: 'a2', parent: 'a1', message: {
          id: '44444444-4444-4444-8444-444444444444', author: { role: 'assistant' }, recipient: 'all', channel: 'commentary',
          content: { content_type: 'text', parts: ['Public commentary'] }
        } }
      }
    };
    await h.feed(history, `https://chatgpt.com/backend-api/conversations/${conversationId}?num_turns=10&include_has_versions=true`);
    expect(h.posts.filter(row => row.type === 'cos-stream-message').map(row => row.message.text))
      .toEqual(['Question', 'Chosen answer', 'Public commentary']);
    expect(JSON.stringify(h.posts)).not.toContain('Unselected retry');
  });

  it('reattaches after the page runtime replaces fetch during startup', async () => {
    const h = harness();
    const replacement = h.replaceFetch();
    expect(h.currentFetch()).toBe(replacement);
    h.ready();
    expect(h.currentFetch()).not.toBe(replacement);
    const conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

    await h.feedSse([`data: {"conversation_id":"${conversationId}","metadata":{"request_id":"wfr_after_runtime_wrap"}}\n\n`]);

    expect(h.posts).toEqual([
      { type: 'cos-request-origin', conversationId, requestIds: ['wfr_after_runtime_wrap'], observedAt: expect.any(Number) }
    ]);
  });

  it('preserves a page wrapper that delegates to the earlier observer without recursion or duplicate inspection', async () => {
    const h = harness();
    h.replaceFetch(true);
    h.ready();
    const conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    await h.feedSse([`data: {"conversation_id":"${conversationId}","metadata":{"request_id":"wfr_nested_wrapper"}}\n\n`]);
    expect(h.posts).toEqual([
      { type: 'cos-request-origin', conversationId, requestIds: ['wfr_nested_wrapper'], observedAt: expect.any(Number) }
    ]);
  });

  it('supports the f/conversation endpoint and bounds request ids to sixteen per stream', async () => {
    const h = harness();
    const conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    await h.feedSse(Array.from({ length: 20 }, (_, i) =>
      'data: ' + JSON.stringify({ conversation_id: conversationId, message: { metadata: { request_id: 'wfr_limit_' + i } } }) + '\r\n\r\n'
    ), { method: 'POST' }, 'https://chatgpt.com/backend-api/f/conversation');
    expect(h.posts).toHaveLength(16);
  });

  it('does not turn quoted text, tool arguments or cross-event identifiers into ownership', async () => {
    const h = harness();
    const a = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    for (const event of [
      { conversation_id: a, tool_arguments: { request_id: 'wfr_argument' } },
      { conversation_id: a, message: { content: { parts: ['{"request_id":"wfr_quoted"}'] } } },
      { conversation_id: a },
      { metadata: { request_id: 'wfr_separate_event' } }
    ]) await h.feedSse(['data: ' + JSON.stringify(event) + '\n\n']);
    await h.feedSse(['data: ' + JSON.stringify({ conversation_id: a, metadata: { request_id: 'wfr_foreign' } }) + '\n\n'],
      { method: 'POST' }, 'https://example.com/backend-api/conversation');
    expect(h.posts).toEqual([]);
  });

  it('ignores non-POST, foreign, malformed and contradictory stream identity', async () => {
    const h = harness();
    const a = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const b = '11111111-2222-4333-8444-555555555555';
    await h.feedSse([`data: {"conversation_id":"${a}","request_id":"wfr_get"}\n\n`], { method: 'GET' });
    await h.feedSse([`data: {"conversation_id":"${a}","request_id":"not-a-workflow"}\n\n`]);
    await h.feedSse([`data: {"conversation_id":"${a}","nested":{"conversation_id":"${b}"},"request_id":"wfr_conflict"}\n\n`]);
    expect(h.posts).toEqual([]);
  });
});
