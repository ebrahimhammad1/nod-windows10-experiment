/**
 * Candidate-branch tests for quota/rate-limit classification in
 * src/shared/model-quota.ts:
 *   - a bare 429 (e.g. a shared-pool rate limit with limit_source but no
 *     daily/zero-quota markers) is classified 'rate_limited', not dropped;
 *   - retryDelay is parsed into retryAfterMs for rate_limited too;
 *   - credits_depleted, zero_quota and daily_quota keep their exact kinds;
 *   - unrelated errors still yield no quota object.
 *
 * No network: pure string classification against the REAL module.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { modelQuotaFailure } from '../src/shared/model-quota.ts';

test('bare 429 from a shared pool is rate_limited, not dropped', () => {
  const result = modelQuotaFailure(
    'Provider returned error (HTTP 429) (limit_source: upstream_provider_shared_pool): too many requests',
  );
  assert.equal(result?.kind, 'rate_limited');
});

test('429 with a retry delay keeps the delay', () => {
  const result = modelQuotaFailure('HTTP 429 quota exceeded (retryDelay: 30s)');
  assert.equal(result?.kind, 'rate_limited');
  assert.equal(result?.retryAfterMs, 30_000);
});

test('retry delay beyond a week is ignored', () => {
  const result = modelQuotaFailure('HTTP 429 (retryDelay: 999999s)');
  assert.equal(result?.kind, 'rate_limited');
  assert.equal(result?.retryAfterMs, undefined);
});

test('zero quota still wins over rate_limited', () => {
  const result = modelQuotaFailure('HTTP 429 quotaValue: 0');
  assert.equal(result?.kind, 'zero_quota');
});

test('daily quota still wins over rate_limited', () => {
  const result = modelQuotaFailure('HTTP 429 GenerateRequestsPerDay quota exceeded');
  assert.equal(result?.kind, 'daily_quota');
});

test('credits depleted unchanged', () => {
  const result = modelQuotaFailure('prepayment credits are depleted');
  assert.equal(result?.kind, 'credits_depleted');
});

test('unrelated errors yield nothing', () => {
  assert.equal(modelQuotaFailure('connection refused'), undefined);
  assert.equal(modelQuotaFailure('HTTP 500 internal error'), undefined);
});
