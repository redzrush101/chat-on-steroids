import { z } from 'zod';
import { REASONING_EFFORTS } from '../../shared/session.js';
import { toolDeclaration } from './tool-declarations.js';
import { getConfig } from '../config.js';
import { logWarn } from '../logger.js';
import {
  agentForCaller, agentFamiliesForCaller, reconcileAgentRequestOwners, noteAgentContextTokens,
  persistCriticalSwarmNow, PRIME_ID, requestWorkerBootstraps, requestWorkerRevivals,
  statusForCaller, stageFinishAgent, stageMessages, stageSpawn, swarmStateForCaller,
  type Caller
} from '../agents.js';
import { repairPrimeFromResumeShadow } from '../session/continuation.js';
import { currentCall, currentCaller } from './call-context.js';
import { awaitFreshCallOrigin, recordAgentMessage } from '../session/recorder.js';
import { findSessionByConversation } from '../session/store.js';
import { requestCorrelation } from '../session/correlation.js';
import {
  adoptAgent, fail, guard, IDENTITY_EVIDENCE_MS, PRIME_EVIDENCE_MS,
  SPAWN_EVIDENCE_MS, type SurfaceRegistrar
} from './kernel.js';

/** Agent calls own their caller proof, durable worker state, and message receipts. */
async function measureSleepingWorkers(caller: Caller): Promise<void> {
  const state = swarmStateForCaller(caller);
  if (state.agents.length === 0) return;
  for (const info of state.agents) {
    if (info.role !== 'worker' || info.state !== 'sleeping' || !info.conversationId) continue;
    const summary = await findSessionByConversation(info.conversationId, { requireUnique: true }).catch(() => null);
    if (summary) noteAgentContextTokens(info.conversationId, summary.contextTokens);
  }
  // Measurement is usually telemetry, but crossing the worker ceiling revokes durable revival
  // authority and can terminalize a parked worker. `status` also calls this helper, so there is
  // no later message/spawn acceptance barrier we can rely on: make every critical revision seen
  // through the end of measurement durable before publishing the resulting state to the model.
  try {
    if (!(await persistCriticalSwarmNow())) {
      throw new Error('the broker has no immediate durable persistence sink');
    }
  } catch (error) {
    throw new Error(
      `Worker context/revival state could not cross its durable barrier. Retry the agents call. (${error instanceof Error ? error.message : String(error)})`
    );
  }
}

/** Registers the multi-agent surface when the MCP core exposes agent tools. */
export function registerAgentsTool(reg: SurfaceRegistrar): void {
  reg.register(
    'agents',
    toolDeclaration('agents', () => ({
      title: 'Multi-agent run',
      description:
        'Run ChatGPT workers. Omit model and reasoning_effort unless the user explicitly requests an override; saved app defaults apply. Do not ask the user to choose them. Reuse a suitable sleeping worker with message before spawn. ' +
        'message: prime→worker or worker→prime; a free slot revives the same sleeping chat. Replies arrive with tool results; never poll. ' +
        'status: all active, sleeping/revivable and terminal/non-revivable workers in this prime’s durable history, including parked runs. finish: report the result, normally then sleep.',
      inputSchema: z.object({
        action: z.enum(['spawn', 'message', 'status', 'finish']).describe('What to do.'),
        run_id: z.string().uuid().optional().describe('Select your returned worker family when status lists several; never grants another caller’s workers.'),
        context: z
          .string()
          .max(4000)
          .optional()
          .describe(
            'spawn: shared instructions prepended to every task, e.g. repo, conventions, edit limits and validation.'
          ),
        workers: z
          .array(
            z.object({
              label: z.string().max(60).optional().describe('Short name shown to the user, e.g. "Security".'),
              task: z
                .string()
                .min(1)
                .max(4000)
                .describe(
                  'This worker\'s job: objective, relevant files, constraints and expected handoff.'
                ),
              model: z
                .string()
                .max(80)
                .optional()
                .describe(
                  'Omit unless explicitly requested by the user; app settings supply defaults. Use an exact account-observed model id or provider alias. Invalid overrides return observed ids before opening; the browser confirms availability before Send.'
                ),
              reasoning_effort: z
                .enum(REASONING_EFFORTS)
                .optional()
                .describe(
                  'Omit unless explicitly requested by the user; app settings supply defaults. Do not ask just to spawn a worker. This selects reasoning only, never a model.'
                )
            }).strict()
          )
          .min(1)
          .max(8)
          .optional()
          .describe(
            'spawn: fresh workers to create only after checking status for a suitable sleeping worker; revive one explicitly with message.'
          ),
        messages: z
          .array(
            z.object({
              to: z.string().min(1).max(40).describe('Recipient.'),
              text: z.string().min(1).max(4000).describe('What to say.')
            }).strict()
          )
          .min(1)
          .max(16)
          .optional()
          .describe(
            'message: atomic batch; prefer this to one call per recipient.'
          ),
        to: z
          .string()
          .min(1)
          .max(40)
          .optional()
          .describe('message: one recipient; messaging a sleeping worker wakes it.'),
        text: z.string().min(1).max(4000).optional().describe('message: what to say.'),
        result: z
          .string()
          .min(1)
          .max(4000)
          .optional()
          .describe(
            'finish: factual handoff under RESULT / CHANGES / VALIDATION / BLOCKERS.'
          )
      })
      .superRefine((input, ctx) => {
        const reject = (field: 'context' | 'workers' | 'messages' | 'to' | 'text' | 'result', message: string): void => {
          if (input[field] !== undefined) ctx.addIssue({ code: 'custom', path: [field], message });
        };
        if (input.action !== 'spawn') {
          reject('context', 'context is only valid with action=spawn');
          reject('workers', 'workers is only valid with action=spawn');
        }
        if (input.action !== 'message') {
          reject('messages', 'messages is only valid with action=message');
          reject('to', 'to is only valid with action=message');
          reject('text', 'text is only valid with action=message');
        }
        if (input.action !== 'finish') reject('result', 'result is only valid with action=finish');
      })
      .strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    })),
    async (input) => {
      // One clock for one MCP call. The dispatcher owns startedAt and the recorder later uses
      // that exact value to consume any page request reserved while proving caller identity.
      // Taking a second Date.now() here made callerNow reserve evidence under one timestamp
      // and recordToolCall look for it under another, leaving the first request permanently
      // reserved until TTL and breaking the very next worker control call.
      const startedAt = currentCall()?.startedAt ?? Date.now();
      return guard('agents', async () => {
        if (!reg.agentToolsLive) return reg.featureDisabled('Multi-agent mode', 'Multi-agent mode (experimental)');

        if (input.action === 'spawn') {
          if (!input.workers) return fail('agents action=spawn requires workers.');
          // Reserve under exact chat proof or the permitted transport request, atomically.
          // The request remains the reachable prime before browser attachment; later proof
          // changes its frontend projection without recreating workers or replaying spawn.
          const staged = stageSpawn({
            workers: input.workers,
            context: input.context ?? null,
            caller: await callerNow(startedAt, { exact: true, runId: input.run_id })
          });
          let accepted = false;
          try {
            let durable = false;
            try {
              durable = await persistCriticalSwarmNow();
            } catch (error) {
              throw new Error(
                `The worker run could not cross its durable acceptance barrier. The spawn was rolled back; retry this same request. (${error instanceof Error ? error.message : String(error)})`
              );
            }
            if (!durable) {
              throw new Error(
                'The worker run could not cross its durable acceptance barrier. The spawn was rolled back; retry this same request.'
              );
            }
            staged.commit();
            accepted = true;
          } catch (error) {
            if (!accepted) staged.rollback();
            throw error;
          }
          const { created, becamePrime, runId } = staged;
          if (currentCall()) currentCall()!.caller.runId = runId;
          // Browser tabs are a publication side effect, never part of planning. They become
          // visible only after the exact broker revision above is durable.
          requestWorkerBootstraps(created.map((worker) => worker.id), runId);
          await adoptAgent(PRIME_ID);
          const invited = created.filter((worker) => worker.state === 'invited');
          const sleeping = created.filter((worker) => worker.state === 'sleeping' && worker.revivable);
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  (becamePrime ? `This ${currentCaller().conversationId ? 'conversation' : 'request'} is now the prime agent of run ${runId}. ` : '') +
                  `${created.length} worker(s) matched: ${created.map((info) => `${info.id} (${info.label}, ${info.state}${info.model ? `, model ${info.model}` : ''}${info.reasoningEffort ? `, reasoning ${info.reasoningEffort}` : ''})`).join(', ')}. ` +
                  (invited.length > 0 ? 'New worker chats are opening with their briefs already in them. ' : '') +
                  (sleeping.length > 0
                    ? `${sleeping.map((worker) => worker.id).join(', ')} already finished that earlier piece and is sleeping in its existing chat; wake it with action=message instead of spawning a duplicate. `
                    : '') +
                  'Carry on with your own work — results and ' +
                  'messages arrive at the end of later tool results, so there is nothing to wait for and never anything ' +
                  'to poll. A short correction with action=message while a worker is still going is far cheaper than ' +
                  'the alternative.'
              }
            ],
            structuredContent: {
              action: 'spawn',
              run_id: runId,
              self: PRIME_ID,
              became_prime: becamePrime,
              workers: created.map((info) => ({ id: info.id, label: info.label, state: info.state, model: info.model, reasoning_effort: info.reasoningEffort }))
            }
          };
        }

        if (input.action === 'message') {
          // Two spellings of one operation. A single message is the common case and stays a
          // pair of scalars; `messages` is the same thing in bulk. Both in one call is a
          // request whose intended order nobody can read, so it is refused rather than
          // guessed at.
          const batch = input.messages ?? [];
          const single = input.to && input.text ? [{ to: input.to, text: input.text }] : [];
          if (batch.length > 0 && single.length > 0) {
            return fail('agents action=message takes either to+text or messages, not both.');
          }
          const items = batch.length > 0 ? batch : single;
          if (items.length === 0) return fail('agents action=message requires to and text, or a messages array.');
          // Before any slot is reserved: a sleeping worker whose chat has since crossed the
          // context ceiling is not revivable, and this is the call that would otherwise wake it.
          const caller = await callerNow(startedAt, { runId: input.run_id, member: true });
          await measureSleepingWorkers(caller);
          // One call, one identity resolution, one all-or-nothing delivery: a prime
          // redirecting its whole run cannot end up with two of its three messages sent.
          const staged = stageMessages(caller, items);
          let accepted = false;
          try {
            let durable = false;
            try {
              durable = await persistCriticalSwarmNow();
            } catch (error) {
              throw new Error(
                `The agent message could not cross its durable acceptance barrier. Nothing was queued; retry the same message request. (${error instanceof Error ? error.message : String(error)})`
              );
            }
            if (!durable) {
              throw new Error('The agent message could not cross its durable acceptance barrier. Nothing was queued; retry the same message request.');
            }
            staged.commit();
            accepted = true;
          } catch (error) {
            if (!accepted) staged.rollback();
            throw error;
          }
          const sent = staged.messages;
          const woken = staged.waking;
          // Reopening a sleeping worker's chat is a browser side effect, so it happens only
          // after the broker revision that reserved its slot is durable — exactly as a spawn's
          // tabs do. Nothing has been typed into that chat yet at this point.
          const runId = staged.runId;
          if (currentCall()) currentCall()!.caller.runId = runId;
          if (woken.length > 0 && runId) requestWorkerRevivals(woken, runId);
          for (const message of sent) await recordAgentMessage(message, 'sent', caller.conversationId);
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  `Queued for ${[...new Set(sent.map((message) => message.to))].join(', ')}.` +
                  (woken.length > 0
                    ? ` Waking ${woken.join(', ')} in ${woken.length === 1 ? 'the same chat' : 'their existing chats'}.`
                    : '')
              }
            ],
            structuredContent: {
              action: 'message',
              run_id: runId,
              queued: sent.map((message) => ({ to: message.to })),
              waking: woken
            }
          };
        }

        if (input.action === 'finish') {
          if (!input.result) {
            return fail(
              'agents action=finish requires result: the report the prime reads in your place — what you changed, what you verified and what is left. Send it as result and call finish again.'
            );
          }
          const staged = stageFinishAgent(await callerNow(startedAt, { runId: input.run_id, member: true }), input.result);
          let accepted = staged.repeat;
          try {
            if (!staged.repeat) {
              let durable = false;
              try {
                durable = await persistCriticalSwarmNow();
              } catch (error) {
                throw new Error(
                  `The worker finish could not cross its durable acceptance barrier. Nothing was published; retry the same finish result. (${error instanceof Error ? error.message : String(error)})`
                );
              }
              if (!durable) {
                throw new Error(
                  'The worker finish could not cross its durable acceptance barrier. Nothing was published; retry the same finish result.'
                );
              }
              staged.commit();
              accepted = true;
            }
          } catch (error) {
            if (!accepted) staged.rollback();
            throw error;
          }
          const { info, report, repeat } = staged;
          if (report) await recordAgentMessage(report, 'sent', info.conversationId);
          // A retry is answered as a retry. Repeating "marked finished" would read as a
          // second finish and invite the model to keep going until it gets a different
          // answer, which is how one lost result became a queue of identical reports.
          return {
            content: [
              {
                type: 'text' as const,
                text: repeat
                  ? `${info.id} was already ${info.state} and the prime agent already has that result, so nothing was ` +
                    'sent again. Stop working and stop calling tools.'
                  : info.state === 'finished'
                    ? `${info.id} is finished. The prime agent has your result. This chat has also reached its context ` +
                      'limit, so there will be no more work in it: stop working and stop calling tools.'
                    : `${info.id} reported and is now asleep but remains reusable. The prime agent has your result and ` +
                      'your worker slot is free. Stop working and stop calling tools; for related follow-up work the ' +
                      'prime should wake this same chat with agents action=message before spawning a replacement.'
              }
            ],
            structuredContent: { action: 'finish', self: info.id, state: info.state, repeat }
          };
        }

        // Status describes only this exact caller's family. No family is a normal empty
        // result, independent of whether another prime has workers; discovery grants no role.
        const caller = await callerNow(startedAt, { runId: input.run_id });
        await measureSleepingWorkers(caller);
        const status = statusForCaller(caller);
        const me = status.self;
        const state = status.state;
        const families = agentFamiliesForCaller(caller);
        const familyNotice = families.length > 1
          ? `\n\nYour worker families: ${families.map(family => `${family.run_id} (${family.running ? 'active' : 'retained'})`).join(', ')}. Use run_id to select a family; worker names are local to that family.`
          : '';
        if (!me) return {
          content: [{ type: 'text' as const, text: families.length
            ? `Select one of your worker families with run_id.${familyNotice}`
            : 'No workers or retained worker history belong to this caller. Use agents action=spawn if the task needs workers.' }],
          structuredContent: { action: 'status', run_id: null, self: null, agents: [], free_worker_slots: status.freeWorkerSlots,
            ...(families.length > 1 ? { available_runs: families } : {}) }
        };
        const failed = state.agents.filter((info) => info.state === 'failed');
        // The word the model reads here is the whole answer to "may I use this worker again".
        // A sleeping worker is not a spent one, and calling it finished in this table is what
        // sends a prime off to spawn a fourth chat for work its first worker already knows the
        // background to.
        const shown = (info: { state: string; revivable: boolean }): string =>
          info.state === 'sleeping'
            ? info.revivable
              ? 'sleeping (reusable; wake with action=message)'
              : 'sleeping'
            : info.state === 'waking'
              ? 'waking (your message is being delivered to its chat)'
              : info.state === 'finished'
                ? 'finished (not reusable)'
              : info.state;
        const asleep = state.agents.filter((info) => info.state === 'sleeping' && info.revivable);
        const slots = status.freeWorkerSlots;
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `You are ${me.id}.\n` +
                state.agents
                  .map(
                    (info) =>
                      `${info.id}  ${info.role}  ${shown(info)}  waiting ${info.pending}  ${info.label}` +
                      (info.model ? `  model ${info.model}` : '') +
                      (info.reasoningEffort ? `  reasoning ${info.reasoningEffort}` : '') +
                      (info.result
                        ? `\n    ${info.state === 'failed' ? 'failure' : info.state === 'finished' ? 'result' : 'latest result'}: ${info.result.slice(0, 300)}`
                        : '')
                  )
                  .join('\n') +
                (me.id === PRIME_ID
                  ? `\n\n${slots} of your worker slots ${slots === 1 ? 'is' : 'are'} free.` +
                    (asleep.length > 0
                      ? ` REUSE FIRST: ${asleep.map((info) => info.id).join(', ')} ${asleep.length === 1 ? 'is' : 'are'} asleep and ` +
                        'can be woken with agents action=message, in the chat they already have and with everything ' +
                        'they learned there still in it. For related follow-up work, do this before action=spawn' +
                        (slots === 0 ? ', once a slot frees up.' : '.')
                      : '')
                  : '') +
                // Said in words as well as in the table: a failed worker will not report, and
                // waiting for it is the mistake this line prevents.
                (failed.length > 0
                  ? `\n\n${failed.map((info) => info.id).join(', ')} will not report. Do that work yourself or wake ` +
                    'another worker; do not wait for them.'
                  : '') +
                // A status check is a glance, not a stopping point. Without this the table reads
                // like an answer to hand back to the user, and a prime that has just looked at its
                // workers stops mid-run to report what it saw.
                familyNotice + '\n\nThis is the current stats, keep working.'
            }
          ],
          structuredContent: {
            action: 'status',
            run_id: status.runId,
            self: me.id,
            free_worker_slots: slots,
            ...(families.length > 1 ? { available_runs: families } : {}),
            agents: state.agents.map((info) => ({
              id: info.id,
              role: info.role,
              label: info.label,
              model: info.model,
              reasoning_effort: info.reasoningEffort,
              state: info.state,
              revivable: info.revivable,
              waiting: info.pending,
              result: info.result ?? null
            }))
          }
        };
      });
    }
  );
}

/**
 * Who is making this `agents` call, established for this call alone.
 *
 * The prime holds no credential by design, and the dispatcher deliberately hands ordinary
 * tool calls no authority from "the only chat that has been active lately" — that is not
 * proof that the chat made this call, and stale page state once authenticated prime calls as
 * worker-1. So identity is proven here per call by joining ChatGPT's inbound MCP HTTP
 * `x-request-id` to the same request id reported from one concrete conversation's message
 * model. The page evidence may arrive just before or just after the MCP request; the id, not
 * timing, is the join. If its exact mate never appears, the broker refuses the operation.
 * Missing request-id evidence never falls back to a visible row, active/generating chat,
 * agent key, or recent browser state.
 *
 * The proven identity is then adopted for the rest of the call, so this result is recorded
 * against the right agent and carries the right inbox.
 */
async function callerNow(startedAt: number, options: { exact?: boolean; runId?: string; member?: boolean } = {}): Promise<Caller> {
  const base = currentCaller();
  // `exact` marks the one action that binds a run: spawn. It is the call whose refusal the
  // model cannot absorb, so it gets the longer ceiling; every other `agents` action can be
  // declined and asked again on the next tool call.
  const window = base.requestId ? (options.exact ? SPAWN_EVIDENCE_MS : IDENTITY_EVIDENCE_MS) : PRIME_EVIDENCE_MS;
  const allowRequest = Boolean(base.requestId && (currentCall()?.allowUnattributed ?? getConfig().multiAgent.allowUnattributedCalls));
  const requestOwnsTarget = !options.member || agentFamiliesForCaller(base).length > 0;
  const resolved =
    base.conversationId ??
    requestCorrelation(base.requestId)?.conversationId ??
    (allowRequest && requestOwnsTarget ? null : await awaitFreshCallOrigin('agents', startedAt, window, {
      ...options,
      // ChatGPT's own id for this request, when it sent one. It names the conversation
      // outright, so two workers calling at the same moment are no longer a hard case.
      requestId: base.requestId
    }));
  const caller: Caller = {
    ...base,
    conversationId: resolved,
    runId: options.runId
  };
  const call = currentCall();
  if (call) call.caller.runId = options.runId;
  if (resolved) {
    const call = currentCall();
    if (call) call.caller.conversationId = resolved;
    const proof = requestCorrelation(base.requestId);
    if (proof?.conversationId === resolved) {
      caller.sessionId = proof.sessionId;
      if (call) call.caller.sessionId = proof.sessionId;
    }
    // A pre-fix Compact & Resume can leave this exact app-opened replacement chat with its own
    // shadow session while the reusable-worker run is still bound to the source chat. Repair
    // only that durably-proven historical failure before membership is evaluated; unrelated
    // conversations still hit AGENTS_BUSY exactly as before.
    await repairPrimeFromResumeShadow(resolved);
  }
  if (!resolved && !allowRequest) {
    logWarn(
      base.requestId
        ? `agents caller not identified: no page evidence matched HTTP request ${base.requestId.slice(0, 20)}…`
        : 'agents caller not identified: this MCP request carried no request id and page evidence was insufficient'
    );
  }
  await reconcileAgentRequestOwners();
  await adoptAgent(agentForCaller(caller));
  return caller;
}
