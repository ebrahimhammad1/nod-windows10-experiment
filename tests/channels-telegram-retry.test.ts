/**
 * Candidate-branch tests for the bounded Telegram connect-timeout retry in
 * src/providers/chat-sdk/settings.ts:
 *   - first attempt always uses the platform default (no dispatcher);
 *   - exactly one retry, ONLY after UND_ERR_CONNECT_TIMEOUT, carries the
 *     IPv4-forced dispatcher;
 *   - abort timeouts, DNS/other errors, and HTTP error responses never retry;
 *   - an injected fetch (tests/embedding) is respected: retry still bounded,
 *     but no dispatcher is forced onto it;
 *   - failure wording is preserved character-for-character.
 *
 * No network: global fetch is stubbed with Response objects and undici-shaped
 * errors. These tests exercise the REAL verifier code, not a copy.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatSdkSetupVerifier } from '../src/providers/chat-sdk/settings.ts';

const TOKEN = '123456789:AAExAMPLEtokEN_-abc123';
const ME = {
  ok: true,
  result: { id: 123456789, is_bot: true, first_name: 'T', username: 't_bot' },
};
const WEBHOOK = { ok: true, result: { url: '' } };

function connectTimeout() {
  return new TypeError('fetch failed', {
    cause: Object.assign(new Error('Connect Timeout Error'), {
      code: 'UND_ERR_CONNECT_TIMEOUT',
    }),
  });
}

function stubFetch(plan: Array<() => Response | never>) {
  const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
  const fn = async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init: init as Record<string, unknown> });
    const step = plan[calls.length - 1];
    assert.ok(step, `unexpected extra fetch call #${calls.length} to ${url}`);
    return step();
  };
  return { fn: fn as typeof fetch, calls };
}

async function withFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const verifyTelegram = (verifier: ReturnType<typeof createChatSdkSetupVerifier>) =>
  verifier.verify('telegram', { botToken: TOKEN });

test('first-attempt success: single call, platform default (no dispatcher)', async () => {
  const { fn, calls } = stubFetch([() => jsonResponse(ME), () => jsonResponse(WEBHOOK)]);
  const result = await withFetch(fn, () => verifyTelegram(createChatSdkSetupVerifier()));
  assert.equal(calls.length, 2); // getMe + getWebhookInfo
  for (const call of calls) assert.ok(!('dispatcher' in call.init), 'dispatcher must not be set');
  assert.equal(result.environment.TELEGRAM_MODE, 'polling'); // no webhook URL input
  assert.equal(result.environment.TELEGRAM_BOT_TOKEN, TOKEN);
  assert.equal(result.summary.mode, 'polling');
  assert.equal(result.summary.accountHandle, '@t_bot');
});

test('connect timeout: retried exactly once, IPv4 dispatcher only on the retry', async () => {
  const { fn, calls } = stubFetch([
    () => jsonResponse(ME),
    () => { throw connectTimeout(); },
    () => jsonResponse(WEBHOOK),
  ]);
  const result = await withFetch(fn, () => verifyTelegram(createChatSdkSetupVerifier()));
  assert.equal(calls.length, 3);
  assert.ok(!('dispatcher' in calls[0].init), 'getMe default path');
  assert.ok(!('dispatcher' in calls[1].init), 'first getWebhookInfo default path');
  assert.ok('dispatcher' in calls[2].init, 'retry carries the IPv4 dispatcher');
  assert.equal(result.environment.TELEGRAM_MODE, 'polling');
});

test('both attempts time out: original wording preserved, no third attempt', async () => {
  const { fn, calls } = stubFetch([
    () => { throw connectTimeout(); },
    () => { throw connectTimeout(); },
  ]);
  const error = await withFetch(fn, () => verifyTelegram(createChatSdkSetupVerifier())).then(
    () => { throw new Error('should have failed'); },
    (caught: unknown) => caught as Error,
  );
  assert.equal(calls.length, 2, 'one retry only');
  assert.equal(error.message, 'verification_failed');
  assert.equal(
    (error as { details?: string }).details,
    'Telegram getMe could not be reached: UND_ERR_CONNECT_TIMEOUT.',
  );
});

test('abort timeout (15s) is NOT retried and keeps its own wording', async () => {
  const { fn, calls } = stubFetch([
    () => { throw Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' }); },
  ]);
  const error = await withFetch(fn, () => verifyTelegram(createChatSdkSetupVerifier())).then(
    () => { throw new Error('should have failed'); },
    (caught: unknown) => caught as Error,
  );
  assert.equal(calls.length, 1);
  assert.equal(
    (error as { details?: string }).details,
    'Telegram getMe could not be reached: timed out after 15 seconds.',
  );
});

test('other network errors (e.g. DNS) are NOT retried', async () => {
  const { fn, calls } = stubFetch([
    () => { throw new TypeError('fetch failed', {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.telegram.org'), { code: 'ENOTFOUND' }),
    }); },
  ]);
  const error = await withFetch(fn, () => verifyTelegram(createChatSdkSetupVerifier())).then(
    () => { throw new Error('should have failed'); },
    (caught: unknown) => caught as Error,
  );
  assert.equal(calls.length, 1);
  assert.equal(
    (error as { details?: string }).details,
    'Telegram getMe could not be reached: ENOTFOUND.',
  );
});

test('HTTP error responses are NOT retried; Telegram description is used', async () => {
  const { fn, calls } = stubFetch([
    () => jsonResponse({ ok: false, description: 'Unauthorized' }, 401),
  ]);
  const error = await withFetch(fn, () => verifyTelegram(createChatSdkSetupVerifier())).then(
    () => { throw new Error('should have failed'); },
    (caught: unknown) => caught as Error,
  );
  assert.equal(calls.length, 1);
  const details = (error as { details?: string }).details ?? '';
  assert.match(details, /Unauthorized/);
  assert.ok(!details.includes(TOKEN), 'token must not leak into the error');
});

test('injected fetch: retry still bounded to one, dispatcher never forced', async () => {
  const { fn, calls } = stubFetch([
    () => { throw connectTimeout(); },
    () => jsonResponse(ME),
    () => jsonResponse(WEBHOOK),
  ]);
  // note: with an injected fetch the FIRST call is the injected one; the
  // verifier must not attach its dispatcher to it even on the retry
  const verifier = createChatSdkSetupVerifier({ fetch: fn });
  const result = await verifyTelegram(verifier);
  assert.equal(calls.length, 3); // timeout, getMe... -> actually getMe retried then webhook
  for (const call of calls) assert.ok(!('dispatcher' in call.init));
  assert.equal(result.summary.mode, 'polling');
});

test('read-only flow: verify never calls setWebhook or any mutating method', async () => {
  const { fn, calls } = stubFetch([() => jsonResponse(ME), () => jsonResponse(WEBHOOK)]);
  await withFetch(fn, () => verifyTelegram(createChatSdkSetupVerifier()));
  const paths = calls.map((call) => new URL(call.url).pathname);
  assert.deepEqual(paths, [`/bot${TOKEN}/getMe`, `/bot${TOKEN}/getWebhookInfo`]);
});
