import { REASONING_EFFORTS } from '../shared/session.js';
/** Successful account choices survive restart; request/opening authority never does. */
import { randomUUID } from 'node:crypto';
import { wakeBrowserWork } from './browser-wake.js';
import { z } from 'zod';
import { logInfo } from './logger.js';
import type { ChatModelCatalog } from '../shared/chat-models.js';
import { readDurable, writeDurableSoon } from './durable.js';
const catalogModels = z.array(z.object({
  // Chat's family/version ids are provider-owned display identities. The 2026-09 picker
  // uses values such as "6 Astra" while aliases remain exact execution slugs.
  id: z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9._ -]+$/),
  label: z.string().trim().min(1).max(80),
  efforts: z.array(z.enum(REASONING_EFFORTS)).max(REASONING_EFFORTS.length),
  aliases: z.array(z.string().min(1).max(80).regex(/^[a-zA-Z0-9._-]+$/)).max(20).optional()
}).strict()).min(1).max(20);
const providerSnapshot = z.object({
  modelPickerVersion: z.number().int().min(1).max(10),
  defaultModelSlug: z.string().regex(/^[a-zA-Z0-9._-]{1,80}$/).optional(),
  models: z.array(z.object({
    slug: z.string().regex(/^[a-zA-Z0-9._-]{1,80}$/),
    title: z.string().trim().min(1).max(80),
    reasoningType: z.enum(['none', 'auto', 'reasoning']),
    configurableThinkingEffort: z.boolean(),
    thinkingEfforts: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/)).max(16),
    isWorkModeModel: z.boolean()
  }).strict()).min(1).max(80),
  versions: z.array(z.object({
    id: z.string().trim().min(1).max(80),
    label: z.string().trim().min(1).max(80),
    enabled: z.boolean(),
    slugs: z.array(z.string().regex(/^[a-zA-Z0-9._-]{1,80}$/)).max(24),
    presets: z.array(z.object({
      modelSlug: z.string().regex(/^[a-zA-Z0-9._-]{1,80}$/),
      lane: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
      title: z.string().trim().min(1).max(80),
      presetType: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
      thinkingEffort: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/).optional()
    }).strict()).max(32)
  }).strict()).min(1).max(30)
}).strict();
const observation = z.object({
  nonce: z.string().uuid(),
  error: z.enum(['picker_unavailable', 'picker_close_failed', 'model_unconfirmed', 'power_unknown', 'power_unconfirmed', 'power_changed', 'restore_failed', 'inspection_failed']).optional(),
  models: catalogModels.nullable(),
  providerSnapshot: providerSnapshot.optional()
}).strict();
type ProviderSnapshot = z.infer<typeof providerSnapshot>;
const effortRank = new Map(REASONING_EFFORTS.map((effort, index) => [effort, index]));
function providerEffort(native: string | undefined, lane: string, work: boolean): (typeof REASONING_EFFORTS)[number] | null {
  if (lane === 'instant') return 'none';
  if (lane === 'pro') return 'pro';
  const effort = native === 'min' ? 'low'
    : native === 'standard' ? 'medium'
    : native === 'extended' ? 'high'
    : native === 'max' ? (work ? 'max' : 'xhigh')
    : native === 'minimal' ? 'minimal'
    : native === 'low' ? 'low'
    : native === 'medium' ? 'medium'
    : native === 'high' ? 'high'
    : native === 'xhigh' ? 'xhigh'
    : native === 'ultra' ? 'ultra'
    : null;
  return effort && REASONING_EFFORTS.includes(effort) ? effort : null;
}
function normalizeProviderSnapshot(snapshot: ProviderSnapshot): z.infer<typeof catalogModels> | null {
  const rows = new Map(snapshot.models.map(model => [model.slug, model]));
  const groups = new Map<string, {
    label: string; efforts: Set<(typeof REASONING_EFFORTS)[number]>; aliases: Set<string>;
    preferred: string; rank: number;
  }>();
  const addAlias = (group: ReturnType<typeof groups.get>, alias: string | undefined) => {
    if (group && alias && /^[a-zA-Z0-9._-]{1,80}$/.test(alias) && group.aliases.size < 20) group.aliases.add(alias);
  };
  for (const version of snapshot.versions) {
    if (!version.enabled) continue;
    for (const preset of version.presets) {
      if (preset.presetType !== 'available' || !version.slugs.includes(preset.modelSlug)) continue;
      const row = rows.get(preset.modelSlug);
      if (!row) continue;
      const effort = providerEffort(preset.thinkingEffort, preset.lane, row.isWorkModeModel);
      if (!effort) continue;
      const rank = row.configurableThinkingEffort ? 0 : row.reasoningType === 'reasoning' ? 1 : effort === 'none' ? 2 : 3;
      let group = groups.get(row.title);
      if (!group) {
        group = { label: row.title, efforts: new Set(), aliases: new Set(), preferred: row.slug, rank };
        groups.set(row.title, group);
      }
      group.efforts.add(effort);
      addAlias(group, row.slug);
      if (rank < group.rank) { group.preferred = row.slug; group.rank = rank; }
      if (version.label === row.title && /^[a-zA-Z0-9._-]{1,80}$/.test(version.id)) addAlias(group, version.id);
    }
  }
  if (snapshot.defaultModelSlug) {
    const row = rows.get(snapshot.defaultModelSlug), group = row && groups.get(row.title);
    if (group) addAlias(group, snapshot.defaultModelSlug);
  }
  const models = [...groups.values()].slice(0, 20).map(group => ({
    id: group.preferred,
    label: group.label,
    efforts: REASONING_EFFORTS.filter(effort => group.efforts.has(effort))
      .sort((a, b) => (effortRank.get(a) ?? 99) - (effortRank.get(b) ?? 99)),
    aliases: [...group.aliases]
  })).filter(model => model.efforts.length > 0);
  return models.length ? models : null;
}
let catalog: ChatModelCatalog = { state: 'unknown', requestedAt: null, observedAt: null, models: [] };
let request: { nonce: string; expiresAt: number; allowOpen: boolean } | null = null;
let deadline: ReturnType<typeof setTimeout> | null = null;
let launch: { nonce: string; allowOpen: boolean; work: Promise<void> } | null = null;
let changed = (): void => {};
let wake: ((nonce: string, allowOpen: boolean) => Promise<void>) | null = null;
export async function restoreChatModels(): Promise<void> {
  const saved = z.object({ observedAt: z.number().finite().positive(), models: catalogModels }).strict().safeParse(await readDurable('chat-models'));
  if (!saved.success || request || catalog.state !== 'unknown') return;
  const models = saved.data.models;
  if (new Set(models.map(model => model.id)).size !== models.length || models.some(model => new Set(model.efforts).size !== model.efforts.length)) return;
  catalog = { state: 'ready', requestedAt: null, observedAt: saved.data.observedAt, models };
}
function failed(error: string): void {
  catalog = { ...catalog, state: catalog.models.length ? 'ready' : 'unavailable', error };
}
export function configureChatModelDiscovery(options: { changed: () => void; wake: (nonce: string, allowOpen: boolean) => Promise<void> }): void { changed = options.changed; wake = options.wake; }
function scheduleDeadline(at: number): void {
  if (deadline) clearTimeout(deadline);
  deadline = setTimeout(() => { deadline = null; expire(); changed(); wakeBrowserWork(); }, Math.max(0, at - Date.now()));
  deadline.unref?.();
}
function expire(): void {
  if (request && Date.now() >= request.expiresAt) { logInfo(`model discovery expired id=${request.nonce}`); request = null; failed('Model discovery timed out. Check ChatGPT is signed in, then retry.'); }
}
export function getChatModels(): ChatModelCatalog {
  expire(); return structuredClone(catalog);
}
export function requestChatModels(allowOpen = true): ChatModelCatalog {
  expire();
  if (!request) {
    const now = Date.now(); request = { nonce: randomUUID(), expiresAt: now + 120000, allowOpen };
    logInfo(`model discovery requested id=${request.nonce}`);
    catalog = { ...catalog, state: 'pending', requestedAt: now, error: undefined };
    scheduleDeadline(request.expiresAt);
    changed();
    wakeBrowserWork();
  } else if (allowOpen && !request.allowOpen) {
    // Explicit refresh promotes the existing nonce; it cannot create a competing request.
    request.allowOpen = true;
    wakeBrowserWork();
  }
  return getChatModels();
}
/** An explicit UI request starts only the local browser bridge, never MCP/tunnel exposure. */
export async function startChatModelDiscovery(allowOpen = true): Promise<ChatModelCatalog> {
  // Showing an existing app window is neither a refresh nor permission to open Chrome.
  if (!allowOpen && catalog.state !== 'unknown') return getChatModels();
  requestChatModels(allowOpen);
  const nonce = request!.nonce;
  if (!launch || launch.nonce !== nonce || (request!.allowOpen && !launch.allowOpen)) {
    const previous = launch?.nonce === nonce ? launch.work : null;
    const attempt = { nonce, allowOpen: request!.allowOpen, work: Promise.resolve() };
    const work = (async () => {
      try {
        if (previous) await previous;
        if (request?.nonce !== nonce) return;
        if (!wake) throw new Error('Model discovery is not ready');
        await wake(nonce, attempt.allowOpen);
        // Wake dispatch is separate from the exact model_catalog completion receipt.
        logInfo(`model discovery browser wake dispatched id=${nonce}`);
      }
      catch (error) {
        if (request?.nonce !== nonce) return;
        request = null;
        if (deadline) clearTimeout(deadline); deadline = null;
        failed(`${(error as Error).message}. Retry model discovery.`.slice(0, 240));
        changed(); wakeBrowserWork();
      }
    })();
    attempt.work = work;
    launch = attempt;
    void work.finally(() => { if (launch === attempt) launch = null; });
  }
  // The request deadline and observation own completion. OS wake is only dispatch;
  // an unresolved handoff must never hold the renderer's Refresh/Send promise.
  await Promise.resolve();
  return getChatModels();
}
export function pendingChatModelRequest(): { nonce: string; expiresAt: number; allowOpen: boolean } | null {
  expire(); return request ? { ...request } : null;
}
export function observeChatModels(raw: unknown): boolean {
  expire(); const parsed = observation.safeParse(raw);
  if (!parsed.success || !request || parsed.data.nonce !== request.nonce) return false;
  const models = parsed.data.providerSnapshot ? normalizeProviderSnapshot(parsed.data.providerSnapshot) : parsed.data.models;
  if (models && (new Set(models.map(model => model.id)).size !== models.length ||
    models.some(model => new Set(model.efforts).size !== model.efforts.length))) return false;
  logInfo(`model discovery observed id=${request.nonce} models=${models?.length ?? 0} elapsed_ms=${Date.now() - (catalog.requestedAt ?? Date.now())} error=${parsed.data.error ?? 'none'}`);
  const error = parsed.data.error === 'picker_unavailable'
    ? 'ChatGPT\'s native model picker could not be read. If your account shows only Think and no model picker, model discovery is not supported for that interface yet.'
    : 'ChatGPT model choices could not be read. Open ChatGPT in the selected browser and check its model picker, then retry.';
  if (models) {
    catalog = { ...catalog, state: 'ready', models, observedAt: Date.now(), error: undefined };
    writeDurableSoon('chat-models', { observedAt: catalog.observedAt, models });
  } else failed(error);
  request = null;
  if (deadline) clearTimeout(deadline); deadline = null;
  changed(); wakeBrowserWork(); return true;
}
export function resetChatModelsForTests(): void {
  if (deadline) clearTimeout(deadline); deadline = null; launch = null;
  request = null; catalog = { state: 'unknown', requestedAt: null, observedAt: null, models: [] };
}
