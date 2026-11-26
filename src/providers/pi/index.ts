import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join, resolve } from 'node:path';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  InMemoryCredentialStore,
  isContextOverflow,
  isRecoverableLength,
  clampThinkingLevel,
  contentText,
  getCurrentTools,
  type AssistantMessage,
  type Context,
  type ToolResultMessage,
} from '@earendil-works/pi-ai';
import { Agent as Connections, Dispatcher1Wrapper, buildConnector } from 'undici';
import { Compile } from 'typebox/compile';
import {
  compact,
  convertToLlm,
  estimateTokens,
  serializeConversation,
  createAgentSession,
  createCodemodeExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ResourceLoader,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { createPiModelRuntime } from './models.ts';
import {
  promptStructuralComplexity,
  resolveSelectionEffort,
} from '../../shared/model-defaults.ts';
import { createTurnFallback, modelKey } from './fallback.ts';
import {
  estimateRequestTokens,
  estimatedRequestTokens,
  lastUserText,
  knownOutputQuota,
  noteObservedOutput,
  outputBudgetWaitMs,
  remainingOutputBudget,
  knownRequestQuota,
  learnOutputQuota,
  learnRequestQuota,
  noteObservedUsage,
  quotaPreflightError,
  retryableRateLimitWait,
} from './request-quota.ts';
import { modelContext } from './context.ts';
import { createContextOutput, toolOutputReference } from './context-output.ts';
import { audioContext, audioEntries, audioMessage, readsNativeAudio } from './audio.ts';
import { piModelTrace } from './traces.ts';
import type { ModelTraces } from '../../ports/traces.ts';
import type { ModelAccess } from '../../ports/models.ts';
import type { Agent, AgentEvent } from '../../ports/agent.ts';
import {
  closeInterruptedCalls,
  completeAssistantMessage,
  dropFailedInput,
  keptImages,
  openLocalSession,
  removedImage,
  recoveryContext,
  requestStart,
  startRequest,
} from './checkpoint.ts';
import { threadIdentity } from '../../ports/thread-identity.ts';
import { createPiUsageTracker, piUsageMetrics, usageId } from './usage.ts';
import { agentModels } from '../../shared/model-defaults.ts';
import { modelPricingSignature, type ModelSelection } from '../../shared/models.ts';
import { createSandbox, workspaceOutputs } from './sandbox.ts';
import { untrustedBlock } from '../../shared/untrusted.ts';
import { draft2020Schema } from '../../shared/json-schema.ts';
import { isPublicAddress, publicLookup } from '../agent-browser/network.ts';
import { turnRetryPolicy } from './retry-policy.ts';

function isFinalAnswer(signature: string | undefined) {
  if (!signature?.startsWith('{')) return false;
  try {
    const value = JSON.parse(signature);
    return value?.v === 1 && value.phase === 'final_answer';
  } catch {
    return false;
  }
}

function thinkingTitles(text: string) {
  return [...text.matchAll(/(?:^|\n)[ \t]*\*\*([^*\n]{2,80})\*\*[ \t]*(?=\n)/g)].map((match) =>
    match[1]!.trim(),
  );
}

function resources(
  systemPrompt: string,
  extensions: ReturnType<ResourceLoader['getExtensions']>,
): ResourceLoader {
  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

const webExtension = fileURLToPath(import.meta.resolve('pi-web-access/dist/index.js'));
const hiddenWebParameters = new Set(['workflow', 'proxy']);
const webRequests = new AsyncLocalStorage<Dispatcher1Wrapper>();
let webConnections: Dispatcher1Wrapper | undefined;

function publicWebRequests() {
  if (webConnections) return webConnections;
  const connect = buildConnector({ lookup: publicLookup() });
  webConnections = new Dispatcher1Wrapper(
    new Connections({
      connect: (options, callback) => {
        const host = options.hostname.replace(/^\[|\]$/g, '');
        if (isIP(host) && !isPublicAddress(host))
          return callback(new Error('Private network destinations are blocked.'), null);
        connect(options, callback);
      },
    }),
  );
  const send = globalThis.fetch;
  globalThis.fetch = ((input, init) => {
    const dispatcher = webRequests.getStore();
    return send(input, dispatcher ? ({ ...init, dispatcher } as RequestInit) : init);
  }) as typeof fetch;
  return webConnections;
}

function visibleWebParameters(record: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => !hiddenWebParameters.has(key)),
  );
}

function webParameters<T>(schema: T): T {
  const value = schema as { properties?: Record<string, unknown>; required?: string[] };
  if (!value.properties) return schema;
  return {
    ...value,
    properties: visibleWebParameters(value.properties),
    ...(value.required
      ? { required: value.required.filter((key) => !hiddenWebParameters.has(key)) }
      : {}),
  } as T;
}

const openSchema = { type: 'object', additionalProperties: true };

function validPatterns(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(validPatterns);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      if (key === '$schema') return [];
      if (key === 'pattern' && typeof item === 'string')
        try {
          new RegExp(item, 'u');
        } catch {
          return [];
        }
      return [[key, validPatterns(item)]];
    }),
  );
}

function toolSchema(schema: unknown) {
  const cleaned = validPatterns(schema) as { type?: unknown } | undefined;
  if (cleaned?.type !== 'object') return openSchema;
  try {
    Compile(cleaned as Parameters<typeof Compile>[0]);
    return cleaned;
  } catch {
    return openSchema;
  }
}

const imageStep = 8;
const warmCache = 5 * 60_000;
const longCache = 55 * 60_000;

const warmIdle = 31 * 60_000;

const webAccess = {
  toolActivation: 'eager',
  workflow: 'none',
  githubClone: { enabled: false },
  githubPrIssue: { enabled: false },
  video: { enabled: false },
  allowBrowserCookies: false,
  proxy: null,
};

function configureWebAccess(root: string) {
  process.env.PI_CODING_AGENT_DIR = root;
  const path = join(root, 'web-search.json');
  let saved = {};
  try {
    saved = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    saved = {};
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ ...saved, ...webAccess }, null, 2) + '\n', { mode: 0o600 });
}

type ModelUsage = { input?: number; output?: number; cost?: { total?: number } };

const promptCacheSecret = randomBytes(32);

function threadPromptCache(threadId: string) {
  const key = createHmac('sha256', promptCacheSecret).update(threadId).digest('base64url');
  return (pi: ExtensionAPI) => {
    pi.on('before_provider_request', ({ payload }) => {
      const request = payload as { prompt_cache_key?: unknown } | null;
      if (request?.prompt_cache_key) return { ...request, prompt_cache_key: key };
    });
  };
}

type CachedBlock = { type: string; text?: string; cache_control?: unknown };
type CachedRequest = {
  system?: CachedBlock[] | string;
  tools?: Array<Record<string, unknown>>;
  messages?: Array<{ role: string; content: string | CachedBlock[] }>;
};

function stableRequestCache(
  cached: { owner?: string; stable?: string[] },
  retention: 'short' | 'long',
  moveOwnerFirst = false,
) {
  const durable = retention === 'long' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
  const short = { type: 'ephemeral' };
  return (pi: ExtensionAPI) => {
    pi.on('before_provider_request', ({ payload }) => {
      const request = payload as CachedRequest | null;
      if (!request?.system || !Array.isArray(request.messages)) return;
      if (Array.isArray(request.system) && request.system.filter((b) => b.cache_control).length > 1)
        return;
      const prefixes = [...new Set(cached.stable ?? [])].sort((a, b) => a.length - b.length);
      const longest = prefixes.at(-1);
      const ordered = [...request.messages];
      if (moveOwnerFirst && cached.owner && longest) {
        const ownerAt = ordered.findIndex(
          (message) =>
            Array.isArray(message.content) &&
            message.content.length === 1 &&
            message.content[0]?.type === 'text' &&
            message.content[0].text === cached.owner,
        );
        const stableAt = ordered.findIndex(
          (message) =>
            Array.isArray(message.content) &&
            message.content.some(
              (block) =>
                block.type === 'text' &&
                typeof block.text === 'string' &&
                block.text.startsWith(longest),
            ),
        );
        if (
          stableAt >= 0 &&
          ownerAt === stableAt + 1 &&
          ordered[stableAt]?.role === 'user' &&
          ordered[ownerAt]?.role === 'user'
        ) {
          const [owner] = ordered.splice(ownerAt, 1);
          ordered.splice(stableAt, 0, owner!);
        }
      }
      const blocks = ordered.flatMap((message, at) =>
        Array.isArray(message.content)
          ? message.content.map((block, index) => ({ block, at, index }))
          : [],
      );
      const lastText = (match: (text: string) => boolean) =>
        blocks.findLast(({ block }) => block.type === 'text' && match(block.text ?? ''));
      const stable = longest
        ? lastText((text) => text.length > longest.length && text.startsWith(longest))
        : undefined;
      const found = cached.owner ? lastText((text) => text === cached.owner) : undefined;
      const owner =
        found &&
        stable &&
        (found.at < stable.at || (found.at === stable.at && found.index < stable.index))
          ? found
          : undefined;
      const messages = ordered.map((message, at) =>
        Array.isArray(message.content)
          ? {
              ...message,
              content: message.content.flatMap((block, index): CachedBlock[] => {
                const rolling = block.cache_control ? { cache_control: short } : {};
                if (owner?.at === at && owner.index === index)
                  return [{ ...block, cache_control: durable }];
                if (stable?.at === at && stable.index === index)
                  return [
                    ...prefixes.map((prefix, step) => ({
                      type: 'text',
                      text: prefix.slice(step ? prefixes[step - 1]!.length : 0),
                      cache_control: durable,
                    })),
                    {
                      ...block,
                      text: block.text!.slice(longest!.length),
                      ...(moveOwnerFirst ? { cache_control: short } : rolling),
                    },
                  ];
                return [{ ...block, ...rolling }];
              }),
            }
          : message,
      );
      return {
        ...request,
        ...(owner && Array.isArray(request.system)
          ? { system: request.system.map(({ cache_control: _, ...block }) => block) }
          : {}),
        ...(request.tools
          ? { tools: request.tools.map(({ cache_control: _, ...tool }) => tool) }
          : {}),
        messages,
      };
    });
  };
}

const ownerContextType = 'nod-owner-context';

function isOwnerContext(message: { role: string }) {
  return (
    message.role === 'custom' &&
    (message as { customType?: string }).customType === ownerContextType
  );
}

function ownerContextCopies(ownerContext: string | undefined) {
  return (pi: ExtensionAPI) => {
    pi.on('context', ({ messages }) => {
      if (!ownerContext || messages.some(isOwnerContext)) return;
      return {
        messages: [
          ...messages,
          {
            role: 'custom' as const,
            customType: ownerContextType,
            content: ownerContext,
            display: false,
            timestamp: Date.now(),
          },
        ],
      };
    });
    pi.on('session_before_compact', ({ preparation }) => {
      preparation.messagesToSummarize = preparation.messagesToSummarize.filter(
        (message) => !isOwnerContext(message),
      );
      preparation.turnPrefixMessages = preparation.turnPrefixMessages.filter(
        (message) => !isOwnerContext(message),
      );
    });
  };
}

function draft2020Tools(pi: ExtensionAPI) {
  pi.on('context_with_system', ({ messages }) => ({
    messages: messages.map((message) =>
      message.role === 'system' && message.toolsAdded
        ? {
            ...message,
            toolsAdded: message.toolsAdded.map((tool) => ({
              ...tool,
              parameters: draft2020Schema(tool.parameters) as typeof tool.parameters,
            })),
          }
        : message,
    ),
  }));
}

function recentImages(pi: ExtensionAPI) {
  pi.on('context', ({ messages }) => {
    const total = messages.reduce(
      (count, message) =>
        message.role === 'toolResult'
          ? count + message.content.filter((part) => part.type === 'image').length
          : count,
      0,
    );
    if (total <= keptImages + imageStep) return;
    const cut = Math.floor((total - keptImages) / imageStep) * imageStep;
    let seen = 0;
    return {
      messages: messages.map((message) =>
        message.role === 'toolResult' && message.content.some((part) => part.type === 'image')
          ? {
              ...message,
              content: message.content.map((part) =>
                part.type === 'image' && seen++ < cut
                  ? { type: 'text' as const, text: removedImage }
                  : part,
              ),
            }
          : message,
      ),
    };
  });
}

const keptResultCharacters = 2000;

function earlierResults(started: number) {
  const prune = <T extends { role: string }>(messages: T[]) =>
    messages.map((message) => {
      if (message.role !== 'toolResult') return message;
      const result = message as unknown as ToolResultMessage;
      if (result.timestamp >= started) return message;
      const size = contentText(result.content).length;
      return size > keptResultCharacters
        ? {
            ...message,
            content: [
              {
                type: 'text' as const,
                text: `This ${result.toolName} result (${size.toLocaleString('en-US')} characters) came from an earlier request and is no longer in context. If you need its details, read the source again. Never repeat an action only to see its result.`,
              },
            ],
          }
        : message;
    });
  return (pi: ExtensionAPI) => {
    pi.on('context', ({ messages }) => ({ messages: prune(messages) }));
    pi.on('session_before_compact', ({ preparation }) => {
      preparation.messagesToSummarize = prune(preparation.messagesToSummarize);
      preparation.turnPrefixMessages = prune(preparation.turnPrefixMessages);
    });
  };
}

function completeAssistantMessages(pi: ExtensionAPI) {
  pi.on('message_end', ({ message }) => {
    if (message.role !== 'assistant') return;
    const complete = completeAssistantMessage(message);
    if (complete !== message) return { message: complete };
  });
}

const tokenRateLimit = /\b(?:tokens? per (?:minute|day)|[tr]p[md])\b/i;

function planBilled(event: AgentEvent): AgentEvent {
  return event.type === 'model_usage'
    ? { ...event, costUsd: null, estimateUsd: event.costUsd, costSource: 'unavailable' }
    : event.type === 'provider_usage'
      ? {
          ...event,
          usage: {
            ...event.usage,
            costUsd: null,
            estimateUsd: event.usage.costUsd,
            pricing: 'unavailable',
          },
        }
      : event;
}

/**
 * Zero-definition protocol (NOD_TOOL_LOADOUT=zero, local review): the model's
 * ENTIRE reply must be one JSON object {"tool":"NAME","input":{...}} (a
 * ```json fence is tolerated). Anything else is a normal reply, not a
 * command - strict on purpose, so prose is never mistaken for a tool call.
 */
export function zeroToolCommand(
  reply: string,
): { tool: string; input?: Record<string, unknown> } | undefined {
  const unfenced = reply
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  if (!unfenced.startsWith('{') || !unfenced.endsWith('}')) return undefined;
  try {
    const parsed = JSON.parse(unfenced) as { tool?: unknown; input?: unknown };
    if (typeof parsed?.tool !== 'string' || !parsed.tool) return undefined;
    if (
      parsed.input !== undefined &&
      (typeof parsed.input !== 'object' || parsed.input === null || Array.isArray(parsed.input))
    )
      return undefined;
    return { tool: parsed.tool, input: parsed.input as Record<string, unknown> | undefined };
  } catch {
    return undefined;
  }
}

/**
 * On-demand discovery for the zero-definition protocol: rank the LOCAL
 * deferred-tool catalog by the query and return at most five name +
 * description + schema entries. This is the same definition data
 * nod_tool_search searches; only what was asked for enters the conversation.
 */
export function zeroToolCatalog(tools: ToolDefinition[], query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const ranked = tools
    .filter((tool) => tool.exposure === 'deferred')
    .map((tool) => {
      // Names + short purposes + argument NAMES only: full schemas (types,
      // constraints, descriptions) stay local. A call with wrong arguments
      // gets a compact validation error to correct against, so definitions
      // never ride any request.
      const parameters = tool.parameters as
        | { properties?: Record<string, unknown>; required?: string[] }
        | undefined;
      const entry = {
        name: tool.name,
        description: (tool.description ?? '').slice(0, 160),
        arguments: Object.keys(parameters?.properties ?? {}).map((key) =>
          parameters?.required?.includes(key) ? key : `${key}?`,
        ),
      };
      const haystack = `${tool.name} ${tool.description ?? ''}`.toLowerCase();
      const score = words.length ? words.filter((word) => haystack.includes(word)).length : 1;
      return { entry, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  return { tools: ranked.map((item) => item.entry) };
}

export function createPiAgent(options: {
  provider: string;
  resolve?: (choice?: ModelSelection) => Promise<ModelAccess | ModelAccess[]>;
  model?: string;
  apiKey?: string;
  sessionRoot: string;
  configRoot?: string;
  createSession?: typeof createAgentSession;
  traces?: ModelTraces;
}): Agent {
  configureWebAccess(options.configRoot ?? join(tmpdir(), 'nod-pi'));
  const active = new Map<
    Awaited<ReturnType<typeof createAgentSession>>['session'],
    () => Promise<void>
  >();
  let disposed = false;
  const warming = new Map<string, () => Promise<void>>();
  const turnModels = new Map<string, string>();
  return {
    async open(input) {
      if (disposed) throw new Error('The agent service has stopped.');
      const resolved = await options.resolve?.(input.model);
      const [access, ...backups] = resolved === undefined ? [] : [resolved].flat();
      const chain = access ? [access, ...backups] : [];
      const shared = () =>
        Math.max(
          0,
          chain.findIndex((item) => modelKey(item) === turnModels.get(input.turnId)),
        );
      let start = shared();
      if (input.automatic && access) {
        let failure: unknown;
        for (; start < chain.length; start++) {
          const item = chain[start]!;
          try {
            await item.prepareRequest?.(
              item.textModel?.definition.choice.id ?? item.definition.choice.id,
              true,
            );
            break;
          } catch (error) {
            failure ??= error;
          }
        }
        if (start === chain.length) throw failure;
      }
      if (!access && !options.apiKey)
        throw new Error('Configure the selected model provider to enable the assistant.');
      let billing = (_provider: string, _model: string) => access?.method;
      if (chain.some((item) => item.method === 'subscription')) {
        const observe = input.onEvent;
        input = {
          ...input,
          onEvent: (event) =>
            observe(
              (event.type === 'model_usage'
                ? billing(event.provider, event.model)
                : event.type === 'provider_usage'
                  ? billing(event.usage.provider, event.usage.model ?? '')
                  : undefined) === 'subscription'
                ? planBilled(event)
                : event,
            ),
        };
      }
      const sessionId = input.sessionId;
      const ephemeral = input.ephemeral === true;
      const directory = resolve(options.sessionRoot, threadIdentity(sessionId));
      await warming.get(directory)?.();
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const traces = options.traces;
      const runtimeOptions: Parameters<typeof createPiModelRuntime>[1] = {
        automatic: input.automatic,
        trace:
          traces &&
          ((call) => {
            if (traces.active())
              traces.record(
                piModelTrace(
                  call,
                  {
                    source: 'agent',
                    session_id: input.sessionId,
                    turn_id: input.turnId,
                    run_id: input.runId,
                    ...(input.parentRunId ? { parent_run_id: input.parentRunId } : {}),
                  },
                  input.ownerContext,
                ),
              );
          }),
        reportCacheUsage: (usage) =>
          input.onEvent({
            type: 'provider_usage',
            usage: { ...usage, turnId: input.turnId },
          }),
      };
      const connection = access
        ? await createPiModelRuntime(access, { ...runtimeOptions, readAudio: input.readAudio })
        : undefined;
      const runtime = connection
        ? connection.runtime
        : await ModelRuntime.create({
            credentials: new InMemoryCredentialStore(),
            modelsPath: null,
            refreshOnCreate: false,
            allowModelNetwork: false,
          });
      if (!access) await runtime.setRuntimeApiKey(options.provider, options.apiKey!);
      const modelId =
        access?.definition.choice.id ||
        options.model ||
        agentModels[options.provider as keyof typeof agentModels];
      const selectedModel =
        connection?.model ?? (modelId ? runtime.getModel(options.provider, modelId) : undefined);
      if (!selectedModel)
        throw new Error('The configured model is not present in the installed Pi catalog.');
      const { model, ...budget } = modelContext(
        selectedModel.provider === 'openai' &&
          selectedModel.api === 'openai-responses' &&
          selectedModel.id === agentModels.openai
          ? {
              ...selectedModel,
              samplingParams: {
                ...selectedModel.samplingParams,
                text: {
                  ...(selectedModel.samplingParams?.text as Record<string, unknown> | undefined),
                  verbosity: 'low',
                },
              },
            }
          : selectedModel,
        connection?.textModel,
      );
      if (budget.compact && input.compactInstructions)
        input = { ...input, ...input.compactInstructions };
      const output = createContextOutput(
        input.workspace,
        input.shouldStop,
        input.ownerContext?.split('\n', 1)[0],
      );
      let toolCallCount = 1;
      const boundedOutput = async (
        name: string,
        run: () => ReturnType<ToolDefinition['execute']>,
        signal?: AbortSignal,
        nested = false,
      ) => {
        let result;
        try {
          result = await run();
        } catch (error) {
          // Abort and stop must keep propagating untouched; any other thrown
          // tool error becomes an error tool-result so the model sees it -
          // and it must be bounded like any other result, or a huge error
          // message lands raw in the next request.
          const message = error instanceof Error ? error.message : String(error);
          if (
            nested ||
            signal?.aborted ||
            (error instanceof Error && error.name === 'AbortError') ||
            /turn was stopped/i.test(message)
          )
            throw error;
          result = {
            content: [{ type: 'text' as const, text: message }],
            isError: true,
          } as Awaited<ReturnType<ToolDefinition['execute']>>;
        }
        if (nested) return result;
        const text = result.content
          .flatMap((part) => (part.type === 'text' ? [part.text] : []))
          .join('\n');
        // Context-window budgets alone are too lax on a per-minute-limited
        // connection: the whole conversation is resent with every request,
        // and one unbounded memory read rejected a live follow-up at 11,530
        // requested tokens on a 7,000 ITPM connection. When a limit is
        // learned, a single tool result may use at most a quarter of it.
        const quotaKey = turnModels.get(input.turnId) ?? (access ? modelKey(access) : undefined);
        const learned = quotaKey ? knownRequestQuota(quotaKey) : undefined;
        const quotaTokenCap = learned ? Math.max(256, Math.floor(learned.limit / 4)) : Infinity;
        const maxBytes = Math.min(
          budget.toolOutput.maxBytes / toolCallCount,
          quotaTokenCap * 2,
        );
        const maxTokens = Math.min(budget.toolOutput.maxTokens / toolCallCount, quotaTokenCap);
        if (
          Buffer.byteLength(text) <= maxBytes &&
          estimateTokens({
            role: 'toolResult',
            toolCallId: '',
            toolName: name,
            content: result.content,
            isError: result.isError ?? false,
            timestamp: 0,
          }) <= maxTokens
        )
          return result;
        const saved = await output.save(
          result.content,
          Math.floor(budget.toolOutput.previewCharacters / toolCallCount),
          signal,
        );
        return {
          ...result,
          content: [
            {
              type: 'text' as const,
              text: result.isError ? saved : toolOutputReference(name, result.content, saved),
            },
          ],
        };
      };
      let idle = false;
      let activation: ExtensionAPI | undefined;
      const manager = ephemeral
        ? SessionManager.inMemory(directory)
        : openLocalSession(directory, input.contextRestart);
      dropFailedInput(manager);
      closeInterruptedCalls(manager);
      const prior = manager.buildSessionContext().messages;
      const last = prior.findLast((message) => message.role === 'assistant');
      const cachedAt = Math.max(
        last?.timestamp ?? 0,
        ...manager
          .getEntries()
          .flatMap((entry) =>
            entry.type === 'usage' &&
            entry.kind === 'cache_warm' &&
            entry.provider === model.provider &&
            [model.id, connection?.textModel?.id].includes(entry.model)
              ? [Date.parse(entry.timestamp)]
              : [],
          ),
      );
      const cold =
        !last ||
        Date.now() - cachedAt >= warmCache ||
        (last as { provider?: string }).provider !== model.provider ||
        ![model.id, connection?.textModel?.id].includes((last as { model?: string }).model);
      const restartable = input.restricted === true && input.newRequest === true;
      const priorTokens = restartable
        ? prior.reduce((total, message) => total + estimateTokens(message), 0)
        : 0;
      const restart =
        restartable &&
        prior.length > 0 &&
        (cold || priorTokens > budget.compaction.keepRecentTokens);
      const cached: { owner?: string; stable?: string[] } = { owner: input.ownerContext };
      const keepCache =
        restart &&
        model.api === 'anthropic-messages' &&
        last !== undefined &&
        Date.now() - last.timestamp < longCache;
      const scheduleCache = model.api === 'anthropic-messages' ? input.scheduleCache : undefined;
      if (keepCache || scheduleCache === 'long') {
        const stream = runtime.streamSimple.bind(runtime);
        runtime.streamSimple = (target, context, options) =>
          stream(target, context, { ...options, cacheRetention: 'long' });
      }
      const fallback =
        access && connection && backups.length
          ? createTurnFallback({
              primary: { access, connection, stream: runtime.streamSimple.bind(runtime) },
              backups,
              start,
              automatic: Boolean(input.automatic),
              connect: (backup) => createPiModelRuntime(backup, runtimeOptions),
              shared,
              switched: (at) => turnModels.set(input.turnId, modelKey(chain[at]!)),
              retrying: () => {
                const retry = settings.getRetrySettings();
                return retry.enabled && session.retryAttempt < retry.maxRetries;
              },
              moved: (from, to) =>
                input.onEvent({
                  type: 'fallback',
                  from: chain[from]!.definition.choice.name,
                  to: chain[to]!.definition.choice.name,
                }),
              failed: (message) => {
                const usage = observeUsage(message);
                if (usage) input.onEvent({ ...usage, pricingSignature: usagePricing(message) });
              },
            })
          : undefined;
      if (fallback) {
        runtime.streamSimple = fallback.stream;
        billing = fallback.method;
      }
      if (restart)
        manager.appendCompaction(
          'Earlier checks are saved outside this context. Use the current request and fresh source reads.',
          null,
          priorTokens,
        );
      if (input.newRequest && cold) startRequest(manager);
      const sandboxTools = input.restricted ? [] : createSandbox(input.workspace, input.timeZone);
      // Local-review minimal loadout (NOD_TOOL_LOADOUT=minimal): only
      // send_message, ask_user, nod_tool and nod_tool_search are declared;
      // every other capability (sandbox tools included) stays reachable
      // through the nod_tool gateway, which dispatches to the same mapped
      // definitions with their validation and execution paths unchanged.
      const minimalLoadout =
        process.env.NOD_TOOL_LOADOUT === 'minimal' && !input.restricted && !budget.compact;
      // Local-review ZERO-DEFINITION loadout (NOD_TOOL_LOADOUT=zero): no tool
      // schemas are declared at all. The system prompt carries only a compact
      // command protocol; the turn loop in prompt() parses one-JSON-object
      // replies, executes them locally through the same nod_tool gateway
      // (validation, approvals and output bounding unchanged), and feeds the
      // bounded result back. This measures the floor of the tools-isolation
      // architecture: definitions never ride the request unless retrieved.
      const zeroLoadout =
        process.env.NOD_TOOL_LOADOUT === 'zero' && !input.restricted && !budget.compact;
      const compactTools = [
        ...sandboxTools.map((tool) => tool.name),
        'nod_tool_search',
        ...['apps', 'send_message'].filter((name) =>
          input.tools.some((tool) => tool.name === name),
        ),
      ];
      const tools: ToolDefinition[] = [
        ...sandboxTools.map((definition): ToolDefinition => ({
          ...definition,
          ...(minimalLoadout
            ? {
                exposure: 'deferred' as const,
                namespace: {
                  name: 'workspace',
                  description: 'Workspace file and command tools.',
                },
              }
            : {}),
          execute: async (id, params, signal, onUpdate, context) => {
            params = structuredClone(params);
            const result = await input.runTool(
              definition.name,
              params,
              async (operation = signal) => {
                const callSignal =
                  operation && signal ? AbortSignal.any([signal, operation]) : operation;
                const output = await definition.execute(id, params, callSignal, onUpdate, context);
                const bounded = id.includes('/')
                  ? output
                  : await boundedOutput(definition.name, async () => output, callSignal);
                if (definition.name !== 'bash') return bounded;
                const exitCode = (output.structuredContent as { exit_code?: unknown } | undefined)
                  ?.exit_code;
                return {
                  ...bounded,
                  ...(Number.isInteger(exitCode) ? { exitCode: exitCode as number } : {}),
                  ...(bounded === output
                    ? {}
                    : {
                        commandOutput: output.content
                          .flatMap((part) => (part.type === 'text' ? [part.text] : []))
                          .join('\n'),
                      }),
                };
              },
              { nested: id.includes('/') },
            );
            return { ...result, details: result.details ?? {} };
          },
        })),
        ...input.tools.map((tool): ToolDefinition => ({
          name: tool.name === 'browser' ? 'nod_browser' : tool.name,
          label: tool.name.replaceAll('_', ' '),
          description: tool.description,
          parameters: (tool.name === 'send_message'
            ? {
                ...tool.parameters,
                properties: { ...(tool.parameters.properties as object), presentation: openSchema },
              }
            : tool.deferred
              ? toolSchema(tool.parameters)
              : tool.parameters) as ToolDefinition['parameters'],
          ...((!input.restricted && !tool.eager) ||
          tool.deferred ||
          budget.compact ||
          zeroLoadout ||
          (minimalLoadout && !['send_message', 'ask_user'].includes(tool.name))
            ? {
                exposure: 'deferred' as const,
                namespace: tool.deferred
                  ? { name: tool.deferred.namespace, description: tool.deferred.description }
                  : {
                      name: 'nod',
                      description: 'Nod tools for apps, browsers, files, memory and tasks.',
                    },
              }
            : { exposure: 'direct' as const }),
          executionMode: tool.parallel ? 'parallel' : 'sequential',
          execute: async (id, args, signal) => {
            const active = activation?.getActiveTools() ?? [];
            const companions =
              typeof tool.companions === 'function'
                ? tool.companions(args as Record<string, unknown>)
                : tool.companions;
            const missing = (budget.compact ? [] : (companions ?? [])).filter(
              (name) => !active.includes(name) && input.tools.some((item) => item.name === name),
            );
            if (missing.length) activation?.setActiveTools([...active, ...missing]);
            return {
              ...(await boundedOutput(
                tool.name,
                () =>
                  tool
                    .execute(args as Record<string, unknown>, { nested: id.includes('/') })
                    .then((result) => ({ ...result, details: result.details ?? {} })),
                signal,
                id.includes('/'),
              )),
              details: {},
            };
          },
        })),
      ];
      // Compact gateway: one small always-on schema that calls any deferred
      // tool by name, so a model that already knows the tool (from an earlier
      // search or earlier in the conversation) skips the search round trip,
      // and a minimal tool set can keep full capability without declaring
      // every schema. The dispatched call runs through the same mapped
      // definition as a direct call, so the target keeps its companions,
      // bounded output, validation, approvals and execution path.
      tools.push({
        name: 'nod_tool',
        label: 'nod tool',
        description:
          'Call one load-on-demand Nod tool by name with its arguments. Use nod_tool_search first to discover a tool and read its schema unless you already know them.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Name of the load-on-demand tool to call.' },
            args: { type: 'object', description: 'Arguments for that tool.' },
          },
          required: ['name', 'args'],
          additionalProperties: false,
        } as ToolDefinition['parameters'],
        exposure: zeroLoadout ? ('deferred' as const) : ('direct' as const),
        executionMode: 'sequential' as const,
        execute: async (id, args, signal, onUpdate, context) => {
          const { name, args: forwarded } = (args ?? {}) as {
            name?: string;
            args?: Record<string, unknown>;
          };
          const mapped = name === 'browser' ? 'nod_browser' : name;
          const target = tools.find((tool) => tool.name === mapped);
          if (!target || target.exposure !== 'deferred')
            throw new Error(
              `nod_tool calls load-on-demand tools by name; "${String(name)}" is not one. Use nod_tool_search to find loadable tools.`,
            );
          // Gateway-dispatched tools must pass the same output bounding as
          // direct calls: an unbounded result (a full memory read is ~7k
          // tokens on its own) re-inflates the very next request past the
          // connection's limit - measured live as a 413 at 11,530 requested
          // on a 7,000 ITPM connection.
          return boundedOutput(
            target.name,
            () => target.execute(id, (forwarded ?? {}) as never, signal, onUpdate, context),
            signal,
          );
        },
      });
      const guided = new Set<string>();
      const deferred =
        !input.restricted || budget.compact || input.tools.some((tool) => tool.deferred);
      const settings = SettingsManager.inMemory({
        compaction: budget.compaction,
        transport: 'sse',
        steeringMode: 'all',
        cacheWarming: input.keepWarm ? 'idle' : 'streaming',
        // Bounded retry for transient provider failures (e.g. 429 rate
        // limits): one retry with a jittered base delay, whether or not
        // backup models are configured, so a shared-pool throttle doesn't
        // fail the turn immediately.
        retry: turnRetryPolicy(),
      });
      const extensionLoader = new DefaultResourceLoader({
        cwd: input.workspace.path,
        agentDir: directory,
        settingsManager: SettingsManager.inMemory({}, { projectTrusted: false }),
        additionalExtensionPaths: input.restricted ? [] : [webExtension],
        extensionFactories: [
          (pi: ExtensionAPI) => {
            activation = pi;
          },
          ...(input.restricted
            ? []
            : [createCodemodeExtension({ inlineBudget: 0, models: false })]),
          ...(deferred
            ? [
                (pi: ExtensionAPI) =>
                  createToolSearchExtension()({
                    ...pi,
                    registerTool: (tool) =>
                      pi.registerTool({
                        ...tool,
                        name: 'nod_tool_search',
                        prepareLoadout: ({ declared }) => ({
                          hiddenDeclarations: declared
                            .filter(
                              (entry) => JSON.stringify(entry).length > model.contextWindow * 2,
                            )
                            .map((entry) => entry.name),
                        }),
                        description: tool.description
                          .replaceAll('tool_search', 'nod_tool_search')
                          .replace('Defaults to 8.', 'Defaults to 4.'),
                        execute: async (id, params, signal, update, context) => {
                          if (budget.compact) pi.setActiveTools(compactTools);
                          const result = await tool.execute(
                            id,
                            budget.compact
                              ? ({ ...(params as object), limit: 1 } as typeof params)
                              : // Keep each load small: every loaded schema is part of later
                                // requests, and a search usually wants one or two tools. The
                                // model can still pass a higher limit explicitly.
                                ({ limit: 4, ...(params as object) } as typeof params),
                            signal,
                            update,
                            context,
                          );
                          const loaded = (result.details as { loaded?: string[] } | undefined)
                            ?.loaded;
                          if (budget.compact && loaded?.length)
                            return {
                              ...result,
                              content: [
                                { type: 'text' as const, text: `Loaded: ${loaded.join(', ')}` },
                              ],
                            };
                          const guides = (loaded ?? []).flatMap((name) => {
                            const deferred = input.tools.find(
                              (tool) => tool.name === name,
                            )?.deferred;
                            if (!deferred?.guide || guided.has(deferred.namespace)) return [];
                            guided.add(deferred.namespace);
                            return [{ type: 'text' as const, text: deferred.guide }];
                          });
                          return guides.length
                            ? { ...result, content: [...result.content, ...guides] }
                            : result;
                        },
                      }),
                  }),
              ]
            : []),
          earlierResults(requestStart(manager)),
          recentImages,
          draft2020Tools,
          audioContext(manager, readsNativeAudio(model) && Boolean(input.readAudio)),
          threadPromptCache(input.threadId),
          ...(keepCache || scheduleCache
            ? [
                stableRequestCache(
                  cached,
                  keepCache ? 'long' : scheduleCache!,
                  Boolean(scheduleCache),
                ),
              ]
            : []),
          ownerContextCopies(input.ownerContext),
          (pi: ExtensionAPI) =>
            pi.on('session_before_compact', async ({ preparation, customInstructions, signal }) => {
              const selected = readsNativeAudio(model)
                ? (connection?.textModel ?? model)
                : (session.model ?? model);
              try {
                const result = await compact(
                  preparation,
                  selected,
                  undefined,
                  undefined,
                  customInstructions,
                  signal,
                  clampThinkingLevel(selected, 'off'),
                  session.agent.streamFunction,
                  undefined,
                  settings.getRetrySettings(),
                );
                return { compaction: result };
              } catch (error) {
                if (signal.aborted) return { cancel: true };
                const message = error instanceof Error ? error.message : String(error);
                if (
                  tokenRateLimit.test(message) ||
                  (!isContextOverflow({
                    stopReason: 'error',
                    errorMessage: message,
                    provider: selected.provider,
                  } as AssistantMessage) &&
                    compaction?.requests.at(-1)?.stopReason !== 'length')
                ) {
                  compaction!.error = `Compaction failed: ${message}`;
                  return { cancel: true };
                }
                const saved = await output.save(
                  [
                    {
                      type: 'text',
                      text: [
                        preparation.previousSummary ?? '',
                        serializeConversation(convertToLlm(preparation.messagesToSummarize)),
                        serializeConversation(convertToLlm(preparation.turnPrefixMessages)),
                      ].join('\n\n'),
                    },
                  ],
                  0,
                  signal,
                );
                const request = convertToLlm(preparation.turnPrefixMessages)
                  .filter((message) => message.role === 'user')
                  .map((message) => contentText(message.content))
                  .join('\n\n');
                const owner =
                  request.length > 1000
                    ? await output.save([{ type: 'text', text: request }], 1000, signal)
                    : request;
                return {
                  compaction: {
                    summary:
                      recoveryContext +
                      '\n' +
                      untrustedBlock('saved context', saved) +
                      (owner ? '\nCurrent request:\n' + owner : ''),
                    firstKeptEntryId: preparation.firstKeptEntryId,
                    tokensBefore: preparation.tokensBefore,
                  },
                };
              }
            }),
          (pi: ExtensionAPI) =>
            pi.on('cache_warming_decision', async () => {
              if (fallback?.switched()) return { action: 'stop' as const };
              try {
                await access?.prepareRequest?.(connection?.textModel?.id ?? model.id, true);
              } catch {
                return { action: 'stop' as const };
              }
              return idle && !(await input.keepWarm?.().catch(() => false))
                ? { action: 'stop' as const }
                : undefined;
            }),
          completeAssistantMessages,
        ],
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });
      await extensionLoader.reload();
      const extensions = extensionLoader.getExtensions();
      if (extensions.errors.length) throw new Error('The Pi extensions could not be loaded.');
      const connections = publicWebRequests();
      for (const extension of extensions.extensions) {
        const web = extension.path === webExtension;
        for (const [name, registered] of extension.tools) {
          const search = name === 'web_search';
          extension.tools.set(name, {
            ...registered,
            definition: {
              ...registered.definition,
              ...((!input.restricted || budget.compact) &&
              !['nod_tool_search', 'codemode'].includes(name)
                ? { exposure: 'deferred' as const, namespace: { name: web ? 'web' : 'workspace' } }
                : {}),
              ...(web
                ? {
                    parameters: webParameters(registered.definition.parameters),
                    executionMode: 'parallel' as const,
                  }
                : {}),
              ...(search
                ? {
                    description:
                      'Search the public web through the configured Pi provider. Use queries with 2-4 varied angles for broad research. Return source-linked results without a curator or a separate summary. Use includeContent only when full source text is needed.',
                  }
                : {}),
              execute: async (id, params, signal, onUpdate, context) => {
                const args = web
                  ? {
                      ...visibleWebParameters(params as Record<string, unknown>),
                      ...(search ? { workflow: 'none' } : {}),
                    }
                  : params;
                const result = await input.runTool(
                  name === 'nod_tool_search' ? 'tool_search' : name,
                  args,
                  () =>
                    boundedOutput(
                      name,
                      () =>
                        workspaceOutputs(
                          () =>
                            web
                              ? webRequests.run(connections, () =>
                                  registered.definition.execute(
                                    id,
                                    args,
                                    signal,
                                    onUpdate,
                                    context,
                                  ),
                                )
                              : registered.definition.execute(id, args, signal, onUpdate, context),
                          input.workspace,
                          signal,
                        ),
                      signal,
                      id.includes('/'),
                    ),
                  { nested: id.includes('/') },
                );
                const usage = (result as { usage?: ModelUsage }).usage;
                if (usage)
                  input.onEvent({
                    type: 'provider_usage',
                    usage: {
                      id: randomUUID(),
                      provider: 'codemode',
                      category: 'agent',
                      operation: 'models',
                      turnId: input.turnId,
                      status: 'succeeded',
                      durationMs: 0,
                      inputTokens: usage.input,
                      outputTokens: usage.output,
                      costUsd: Number.isFinite(usage.cost?.total) ? usage.cost!.total : null,
                      pricing: Number.isFinite(usage.cost?.total) ? 'sdk_estimate' : 'unavailable',
                    },
                  });
                return { ...result, details: result.details ?? {} };
              },
            },
          });
        }
      }
      const guidelines = [
        'Use sandbox tools to search and process referenced workspace files. Previews are incomplete. Read the source before using its facts.',
        ...new Set(
          [
            ...tools,
            ...extensions.extensions.flatMap((extension) =>
              [...extension.tools.values()].map((tool) => tool.definition),
            ),
          ]
            .filter((tool) => !budget.compact || tool.exposure !== 'deferred')
            .flatMap((tool) => tool.promptGuidelines ?? []),
        ),
      ];
      if (guidelines.some((rule) => rule.includes('codemode')))
        guidelines.push(
          'Codemode can call workspace, web, app and Nod tools. Every call keeps its normal validation, owner authority, approval and stop checks. Read schemas with searchTools or describeTool when needed. Await every call and inspect its result. Use direct tool calls when you need images.',
        );
      if (input.tools.some((tool) => tool.name === 'browser'))
        guidelines.push(
          'Use nod_browser for browser calls. In older procedures, browser means this tool.',
        );
      if (deferred) guidelines.push('Use nod_tool_search to load deferred tools.');
      if (zeroLoadout)
        guidelines.push(
          'No tools are declared in this chat. To use one, make your ENTIRE reply exactly one JSON object and nothing else: {"tool":"NAME","input":{...}}. Discover tool names and purposes with {"tool":"nod_tool_search","input":{"query":"what you need"}} - it returns no schemas. If a call fails, the error says which argument to fix: correct it and send the command again. Never claim you saved, changed or did something without an actual tool command and its result. Tool results arrive as user messages; then answer normally or send another command.',
        );
      const systemPrompt = guidelines.length
        ? `${input.systemPrompt}\n\nTool guidelines:\n${guidelines.map((rule) => `- ${rule}`).join('\n')}`
        : input.systemPrompt;
      let sessionModel = model;
      if (connection?.textModel && readsNativeAudio(model)) {
        const textModel = connection.textModel;
        const id = `nod/${model.id}`;
        runtime.registerVirtualModel({
          provider: model.provider,
          id,
          name: model.name,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          input: model.input,
          thinkingLevels: ['off'],
          route: ({ reason, thinkingLevel }) =>
            reason !== 'direct' && input.readAudio && audioEntries(manager).length
              ? { model, thinkingLevel }
              : { model: textModel, thinkingLevel: access?.textModel?.effort ?? thinkingLevel },
        });
        sessionModel = runtime.getModel(model.provider, id)!;
      }
      const loaded = new Set(
        getCurrentTools(
          manager.getBranch().flatMap((entry) => (entry.type === 'message' ? [entry.message] : [])),
        ).map((tool) => tool.name),
      );
      const directTools = [
        ...tools
          .filter((tool) => budget.compact || tool.exposure !== 'deferred' || loaded.has(tool.name))
          .map((tool) => tool.name),
        ...extensions.extensions.flatMap((extension) =>
          [...extension.tools.entries()]
            .filter(
              ([name, tool]) =>
                budget.compact || tool.definition.exposure !== 'deferred' || loaded.has(name),
            )
            .map(([name]) => name),
        ),
      ];
      // Zero-definition mode declares nothing: discovery and calls run
      // through the protocol loop below instead of provider-visible schemas.
      if (zeroLoadout) directTools.length = 0;
      // Turn-scoped loadout: the always-on set is everything with direct
      // exposure. Tools loaded on demand (nod_tool_search, companions) stay
      // active for the turn that loaded them and are evicted at the next
      // owner-turn boundary (see prompt below), so earlier discoveries do not
      // inflate every later request in a long conversation.
      const exposureOf = new Map<string, ToolDefinition['exposure']>([
        ...tools.map((tool) => [tool.name, tool.exposure] as const),
        ...extensions.extensions.flatMap((extension) =>
          [...extension.tools.entries()].map(
            ([name, tool]) => [name, tool.definition.exposure] as const,
          ),
        ),
      ]);
      const resumed = !restart && manager.buildSessionContext().messages.length > 0;
      const { session } = await (options.createSession ?? createAgentSession)({
        cwd: input.workspace.path,
        agentDir: directory,
        modelRuntime: runtime,
        model: sessionModel,
        thinkingLevel: access?.effort ?? 'high',
        tools: directTools.map((name) => `+${name}`),
        customTools: tools,
        noTools: 'builtin',
        resourceLoader: resources(systemPrompt, extensions),
        sessionManager: manager,
        settingsManager: settings,
      });
      if (budget.compact) session.setActiveToolsByName(compactTools);
      if (disposed) {
        session.dispose();
        throw new Error('The agent service has stopped.');
      }

      const prepare = session.agent.prepareRequest;
      session.agent.prepareRequest = async (request, signal) => {
        for (const { sourceEntry, messages } of manager.buildSessionProjection().entries) {
          if (messages.length !== 1) continue;
          const message = messages[0]!;
          const next = await output.bound(message, model.contextWindow / 2, signal);
          signal?.throwIfAborted();
          if (next === message || !('content' in next)) continue;
          if (sourceEntry.type === 'compaction')
            manager.appendCompaction(
              contentText(next.content),
              sourceEntry.firstKeptEntryId,
              sourceEntry.tokensBefore,
              sourceEntry.details,
            );
          else manager.appendContextEdit(sourceEntry.id, { content: next.content });
        }
        return (await prepare?.(request, signal)) ?? undefined;
      };

      const stream = session.agent.streamFunction;
      session.agent.streamFunction = async (target, context, options) => {
        // Single-connection turns have no fallback to preflight per candidate,
        // so refuse doomed requests and learn provider-reported limits here.
        const quotaKey = turnModels.get(input.turnId) ?? (access ? modelKey(access) : undefined);
        // Auto effort resolves HERE, per request, where the turn's actual
        // payload and the learned quotas are both visible: simple turns and
        // tight connections stay light, substantial tasks get the provider
        // default - without any extra classification call. Manual levels are
        // never touched (access.effortAuto is only set for stored 'auto').
        if (!fallback && quotaKey && access?.effortAuto) {
          session.setThinkingLevel(
            resolveSelectionEffort(access.provider, access.definition.choice, 'auto', {
              estimatedInputTokens: estimatedRequestTokens(quotaKey, context),
              structuralComplexity: promptStructuralComplexity(lastUserText(context)),
              inputQuotaPerMinute: knownRequestQuota(quotaKey)?.limit,
              outputQuotaPerMinute: knownOutputQuota(quotaKey)?.limit,
            }),
          );
        }
        if (!fallback && quotaKey) {
          const refused = quotaPreflightError(quotaKey, context);
          if (refused) throw refused;
        }
        // Never ask for more output than the connection's learned per-minute
        // output limit has left in this minute; the provider rejects
        // over-budget requests outright (measured live: OTPM Limit 1000,
        // Requested 1232). When too little is left to be useful, wait out
        // the window instead of knowingly overshooting the quota.
        if (!fallback && quotaKey) {
          const outputWait = outputBudgetWaitMs(quotaKey);
          if (outputWait > 0) {
            input.onEvent({
              type: 'retry',
              model: target.id,
              attempt: 1,
              attempts: 2,
              detail: 'waiting for the per-minute output limit to reset',
            });
            // Abortable: poll the turn's stop flag while the window resets so
            // a user cancel interrupts the wait instead of hanging 60s.
            const deadline = Date.now() + outputWait;
            while (Date.now() < deadline) {
              if (input.shouldStop?.()) throw new Error('The turn was stopped.');
              await new Promise((resolve) => setTimeout(resolve, Math.min(250, deadline - Date.now())));
            }
          }
        }
        const outputCap = quotaKey ? remainingOutputBudget(quotaKey) : undefined;
        const requestOptions =
          outputCap !== undefined && (options?.maxTokens === undefined || options.maxTokens > outputCap)
            ? { ...options, maxTokens: outputCap }
            : options;
        for (let attempt = 0; attempt < 2; attempt++) {
          let response;
          try {
            response = await stream(target, context, requestOptions);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!fallback && quotaKey) {
              // A 413 carries the provider's exact Requested count: use it to
              // correct the estimate that let the request through, or the
              // same oversize request would loop.
              const rejected = learnRequestQuota(quotaKey, message);
              if (rejected)
                noteObservedUsage(quotaKey, estimateRequestTokens(context), rejected.requested);
              learnOutputQuota(quotaKey, message);
            }
            // Per-minute pacing (429) is retryable at the provider's own hint;
            // the session retry misclassifies these as billing limits, and
            // per-request size rejections (413) carry no hint and never match.
            // Retrying resends this request only; already-executed tool
            // results stay in context and are not replayed.
            const wait = retryableRateLimitWait(message);
            if (wait === undefined || attempt === 1) throw error;
            input.onEvent({
              type: 'retry',
              model: target.id,
              attempt: attempt + 1,
              attempts: 2,
              detail: `rate limited, retrying in about ${Math.ceil(wait / 1000)}s`,
            });
            // Same abortable pattern as the output-window wait: a user
            // cancel interrupts the pacing wait instead of hanging.
            {
              const deadline = Date.now() + wait;
              while (Date.now() < deadline) {
                if (input.shouldStop?.()) throw new Error('The turn was stopped.');
                await new Promise((resolve) => setTimeout(resolve, Math.min(250, deadline - Date.now())));
              }
            }
            continue;
          }
          const result = await response.result();
          if (!fallback && quotaKey) {
            const rejected = learnRequestQuota(quotaKey, result.errorMessage);
            if (rejected)
              noteObservedUsage(quotaKey, estimateRequestTokens(context), rejected.requested);
            learnOutputQuota(quotaKey, result.errorMessage);
            // The provider's own count corrects our conservative estimate
            // for this connection, so a learned limit stops refusing
            // requests that actually fit (live: est ~7.2k vs real 4,011).
            const usage = result.usage as { input?: number; output?: number } | undefined;
            if (typeof usage?.input === 'number' && usage.input > 0 && !result.errorMessage)
              noteObservedUsage(quotaKey, estimateRequestTokens(context), usage.input);
            if (typeof usage?.output === 'number' && usage.output > 0)
              noteObservedOutput(quotaKey, usage.output);
          }
          const wait = retryableRateLimitWait(result.errorMessage);
          if (wait !== undefined && attempt < 1) {
            input.onEvent({
              type: 'retry',
              model: target.id,
              attempt: attempt + 1,
              attempts: 2,
              detail: `rate limited, retrying in about ${Math.ceil(wait / 1000)}s`,
            });
            {
              const deadline = Date.now() + wait;
              while (Date.now() < deadline) {
                if (input.shouldStop?.()) throw new Error('The turn was stopped.');
                await new Promise((resolve) => setTimeout(resolve, Math.min(250, deadline - Date.now())));
              }
            }
            continue;
          }
          if (compaction) compaction.requests.push(result);
          return response;
        }
        throw new Error('unreachable');
      };

      const finishTurn = session.agent.finishTurn;
      session.agent.finishTurn = async (turn, signal) => {
        const result = await finishTurn?.(turn, signal);
        if (
          input.shouldStop(
            turn.toolResults.map((result) => ({
              name: result.toolName,
              ...(result.isError
                ? {
                    error: result.content
                      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
                      .join('\n'),
                  }
                : {}),
            })),
          )
        )
          return { action: 'end' as const };
        if (
          input.nextMessages &&
          result?.action !== 'end' &&
          ['stop', 'toolUse'].includes(turn.message.stopReason)
        )
          for (const message of await input.nextMessages()) {
            if (message.audio && readsNativeAudio(model))
              await session.sendCustomMessage(
                audioMessage(message.text, message.images, message.audio),
                { deliverAs: 'steer' },
              );
            else await session.steer(message.text, message.images);
          }
        return result ?? undefined;
      };
      let textBlock: number | undefined;
      let thinking = { index: -1, text: '', scanned: 0 };
      let contextExhausted = false;
      let compaction:
        { id: string; started: number; error?: string; requests: AssistantMessage[] } | undefined;
      const auxiliarySeen = new Set(manager.getEntries().map((entry) => entry.id));
      const usagePricing = (usage: { provider: string; model: string } | undefined) => {
        const target =
          usage && (fallback?.model(usage) ?? runtime.getModel(usage.provider, usage.model));
        return modelPricingSignature(target?.cost, target?.api);
      };
      const observeUsage = createPiUsageTracker({
        sessionId: manager.getSessionId(),
        provider: model.provider,
        model: model.id,
        history: manager
          .getEntries()
          .flatMap((entry) =>
            entry.type === 'message' && entry.message.role === 'assistant' ? [entry.message] : [],
          ),
      });
      const unsubscribe = session.subscribe((event) => {
        if (event.type === 'compaction_start')
          compaction = { id: randomUUID(), started: performance.now(), requests: [] };
        if (event.type === 'compaction_end') {
          settings.applyOverrides({ compaction: budget.compaction });
          const target = readsNativeAudio(model) ? (connection?.textModel ?? model) : model;
          const error = compaction?.error ?? event.errorMessage;
          if (error && event.reason === 'overflow' && (compaction || !contextExhausted))
            input.onEvent({
              type: 'error',
              message: `${target.provider} / ${target.id}: ${error}`,
            });
          if (compaction)
            for (const [index, message] of (compaction.requests.length
              ? compaction.requests
              : [undefined]
            ).entries())
              input.onEvent({
                type: 'provider_usage',
                usage: {
                  id: usageId(manager.getSessionId(), `${compaction.id}:${index}`),
                  provider: message?.provider ?? target.provider,
                  category: 'agent',
                  operation: 'compaction',
                  model: message?.model ?? target.id,
                  turnId: input.turnId,
                  status: error ? 'failed' : event.aborted ? 'cancelled' : 'succeeded',
                  durationMs: message?.durationMs ?? performance.now() - compaction.started,
                  ...piUsageMetrics(message?.usage),
                  pricingSignature: usagePricing(message),
                },
              });
          compaction = undefined;
        }
        if (
          event.type === 'entry_appended' &&
          event.entry.type === 'usage' &&
          (!connection || event.entry.kind !== 'cache_warm') &&
          !auxiliarySeen.has(event.entry.id)
        ) {
          auxiliarySeen.add(event.entry.id);
          input.onEvent({
            type: 'provider_usage',
            usage: {
              id: usageId(manager.getSessionId(), event.entry.id),
              provider: event.entry.provider,
              category: 'agent',
              operation: event.entry.kind === 'cache_warm' ? 'cache_warm' : 'auxiliary',
              model: event.entry.model,
              turnId: input.turnId,
              status: 'succeeded',
              durationMs: 0,
              ...piUsageMetrics(event.entry.usage),
              pricingSignature: usagePricing(event.entry),
            },
          });
        }
        if (event.type === 'message_start' && event.message.role === 'assistant') {
          textBlock = undefined;
          thinking = { index: -1, text: '', scanned: 0 };
          input.onEvent({ type: 'message_start' });
        }
        if (event.type === 'turn_start') input.onEvent({ type: 'turn_start' });
        if (event.type === 'auto_retry_start')
          input.onEvent({
            type: 'retry',
            model: fallback?.current() ?? (session.model ?? model).name,
            attempt: event.attempt,
            attempts: event.maxAttempts,
          });
        if (event.type === 'message_update') {
          const update = event.assistantMessageEvent;
          if (update.type === 'text_start' || update.type === 'text_delta') {
            if (textBlock !== undefined && textBlock !== update.contentIndex) {
              input.onEvent({ type: 'message_end' });
              input.onEvent({ type: 'message_start' });
            }
            textBlock = update.contentIndex;
          }
          if (update.type === 'toolcall_start' && textBlock !== undefined) {
            input.onEvent({ type: 'message_end' });
            input.onEvent({ type: 'message_start' });
            textBlock = undefined;
          }
          if (update.type === 'text_delta')
            input.onEvent({ type: 'text_delta', text: update.delta });
          if (update.type === 'thinking_delta' || update.type === 'thinking_end') {
            if (thinking.index !== update.contentIndex)
              thinking = { index: update.contentIndex, text: '', scanned: 0 };
            thinking.text =
              update.type === 'thinking_end' ? `${update.content}\n` : thinking.text + update.delta;
            const end = thinking.text.lastIndexOf('\n') + 1;
            if (end > thinking.scanned) {
              for (const title of thinkingTitles(thinking.text.slice(thinking.scanned, end)))
                input.onEvent({ type: 'thinking', title });
              thinking.scanned = end;
            }
          }
        }
        if (event.type === 'message_end' && event.message.role === 'assistant') {
          const overflow = isContextOverflow(event.message, model.contextWindow);
          toolCallCount = Math.max(
            1,
            event.message.content.filter((part) => part.type === 'toolCall').length,
          );
          if (
            event.message.stopReason === 'error' &&
            tokenRateLimit.test(event.message.errorMessage ?? '')
          )
            settings.applyOverrides({ compaction: { enabled: false } });
          else if (overflow || isRecoverableLength(event.message, model.maxTokens)) {
            settings.applyOverrides({ compaction: { keepRecentTokens: 0 } });
          }
          const usage = observeUsage(event.message);
          if (usage) input.onEvent({ ...usage, pricingSignature: usagePricing(event.message) });
          if (event.message.stopReason === 'error')
            input.onEvent({
              type: 'error',
              message:
                fallback?.describe(event.message) ??
                `${event.message.provider} / ${event.message.model}: ${event.message.errorMessage?.trim() || 'The provider gave no reason.'}`,
              ...(overflow ? { contextExhausted: true } : {}),
            });
          if (event.message.stopReason === 'stop') {
            const blocks = event.message.content.filter((item) => item.type === 'text');
            const finalBlocks = blocks.filter((item) => isFinalAnswer(item.textSignature));
            input.onEvent({
              type: 'final',
              text: (finalBlocks.length ? finalBlocks : blocks).map((item) => item.text).join('\n'),
            });
          }
          const status = ['stop', 'toolUse'].includes(event.message.stopReason)
            ? 'succeeded'
            : event.message.stopReason === 'length'
              ? 'incomplete'
              : event.message.stopReason === 'error'
                ? 'failed'
                : event.message.stopReason === 'aborted'
                  ? 'cancelled'
                  : undefined;
          const tokens = event.message.usage;
          contextExhausted =
            overflow ||
            (status === 'incomplete' &&
              tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output >=
                model.contextWindow - budget.margin);
          input.onEvent({
            type: 'message_end',
            ...(status ? { status } : {}),
            ...(status === 'incomplete' && contextExhausted ? { contextExhausted: true } : {}),
          });
        }
      });
      const close = async () => {
        unsubscribe();
        session.dispose();
        active.delete(session);
      };
      const dispose = async () => {
        if (!input.parentRunId) turnModels.delete(input.turnId);
        if (disposed || !input.keepWarm || session.cacheWarmingStatus?.state === 'inactive')
          return close();
        idle = true;
        const release = async () => {
          clearTimeout(timer);
          if (warming.get(directory) === release) warming.delete(directory);
          await close();
        };
        const timer = setTimeout(() => void release(), warmIdle);
        timer.unref?.();
        warming.set(directory, release);
      };
      active.set(session, dispose);
      return {
        resumed,
        readsImages: model.input.includes('image'),
        readsAudio: readsNativeAudio(model) && Boolean(input.readAudio),
        compactContext: budget.compact,
        async prompt(text, images, audio, stablePrefixes) {
          cached.stable = stablePrefixes;
          // Evict on-demand tools at the owner-turn boundary: no tool call is
          // pending here, and mid-turn sequences (search, call, answer) keep
          // everything they loaded until the turn ends.
          // Tools are just-in-time in every loadout: all non-eager tools are
          // deferred behind the nod_tool gateway catalog and activate on use,
          // so a light turn needs no separate restriction here.
          if (!budget.compact)
            session.setActiveToolsByName(
              directTools.filter((name) => exposureOf.get(name) !== 'deferred'),
            );
          const owner = input.ownerContext;
          const copy = manager.buildSessionContext().messages.findLast(isOwnerContext);
          if (owner && (copy as { content?: unknown } | undefined)?.content !== owner)
            await session.sendCustomMessage(
              { customType: ownerContextType, content: owner, display: false },
              prior.length ? undefined : { deliverAs: 'nextTurn' },
            );
          try {
            if (audio && readsNativeAudio(model))
              await session.sendCustomMessage(audioMessage(text, images, audio), {
                triggerTurn: true,
              });
            else {
              await session.prompt(text, { images, expandPromptTemplates: false });
              if (zeroLoadout) {
                const gateway = tools.find((tool) => tool.name === 'nod_tool');
                for (let round = 0; round < 4 && !disposed && gateway; round++) {
                  if (input.shouldStop?.()) break;
                  const messages = manager.buildSessionContext().messages;
                  const last = messages.findLast(
                    (message) => (message as { role?: string }).role === 'assistant',
                  );
                  const lastContent = (last as { content?: unknown } | undefined)?.content;
                  if (process.env.NOD_BENCH_DEBUG)
                    console.error(
                      'zero-loop last message:',
                      JSON.stringify(last)?.slice(0, 400),
                    );
                  const reply =
                    typeof lastContent === 'string' || Array.isArray(lastContent)
                      ? contentText(lastContent as never).trim()
                      : '';
                  const command = zeroToolCommand(reply);
                  if (process.env.NOD_BENCH_DEBUG)
                    console.error('zero-loop reply:', reply.slice(0, 200));
                  if (!command) break;
                  let result: unknown;
                  try {
                    result =
                      command.tool === 'nod_tool_search'
                        ? zeroToolCatalog(tools, String(command.input?.query ?? ''))
                        : await gateway.execute(
                            `zero-${round}`,
                            { name: command.tool, args: command.input ?? {} } as never,
                            new AbortController().signal,
                            undefined as never,
                            undefined as never,
                          );
                  } catch (error) {
                    result = { error: error instanceof Error ? error.message : String(error) };
                  }
                  const resultContent = (result as { content?: unknown } | undefined)?.content;
                  const serialized =
                    typeof resultContent === 'string' || Array.isArray(resultContent)
                      ? contentText(resultContent as never)
                      : (JSON.stringify(result) ?? 'null');
                  if (process.env.NOD_BENCH_DEBUG)
                    console.error('zero-loop result:', serialized.slice(0, 200));
                  // Bounded like any tool result: an unbounded echo would
                  // re-inflate the very next request past the limit.
                  await session.prompt(
                    `Tool result (${command.tool}):\n${serialized.slice(0, 4000)}`,
                    { expandPromptTemplates: false },
                  );
                }
              }
            }
          } finally {
            settings.applyOverrides({ compaction: budget.compaction });
            if (dropFailedInput(manager)) session.refreshContext();
          }
        },
        async abort() {
          await session.abort();
        },
        dispose,
      };
    },
    async dispose() {
      disposed = true;
      await Promise.allSettled([...warming.values()].map((release) => release()));
      const results = await Promise.allSettled(
        [...active].map(async ([session, dispose]) => {
          try {
            await session.abort();
          } finally {
            await dispose();
          }
        }),
      );
      if (results.some((result) => result.status === 'rejected'))
        throw new Error('The agent service could not finish cleaning up its sessions.');
    },
  };
}
