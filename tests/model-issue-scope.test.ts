/**
 * Regression tests for the recurring Cloudflare "Last request failed" card
 * mismatch (user Telegram 19191715 + 19194308: it recurred several times).
 *
 * Measured card state on the owner's connection: a 403 recorded for
 * @cf/deepseek-ai/deepseek-v4.1-flash-1017 ("not available on the Workers
 * Free plan") stayed on the card while "Current model: GLM-4.7-Flash", and
 * survived "Reload models". Source read showed why: the card issue was the
 * NEWEST failure across ALL models on the connection, never scoped to the
 * selected model, and request failures persist until a request to THAT
 * model succeeds - so every failed model marked the card forever.
 *
 * These tests pin the fixed behavior against the REAL model service with a
 * real database:
 *   1. while the failed model is selected, the card shows its failure;
 *   2. after switching selection A -> B, the card is clear (B never failed)
 *      and A's failure survives only on A's own model entry;
 *   3. the dispatched model id is the selected one (resolve/candidates), and
 *      automatic requests to the failed model A stay paused;
 *   4. the scoping survives a service reload (failures persist, card stays
 *      scoped to the selection).
 *
 * The 403 reason string is preserved verbatim from the owner's screenshot
 * (account identifier excluded).
 */
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';

const CLOUDFLARE_403 =
  'AiError: Model @cf/deepseek-ai/deepseek-v4.1-flash-1017 is not available on the Workers Free plan: ' +
  'Model @cf/deepseek-ai/deepseek-v4.1-flash-1017 is not available on the Workers Free plan. ' +
  'Upgrade to access this model: https://dash.cloudflare.com/?to=/:account/workers/plan';

const MODEL_A = '@cf/deepseek-ai/deepseek-v4.1-flash-1017';
const MODEL_B = 'glm-4.7-flash';

describe('model failure scoping', { skip: !process.env.TEST_DATABASE_URL }, () => {
  async function fixture(t: import('node:test').TestContext) {
    const { createModelService } = await import('../src/server/models.ts');
    const { createPiModelBackend } = await import('../src/providers/pi/models.ts');
    const schema = `test_issue_${randomUUID().replaceAll('-', '')}`;
    const root = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await root.query(`CREATE SCHEMA ${schema}`);
    const database = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
      max: 2,
      idleTimeoutMillis: 0,
    });
    const key = randomBytes(32);
    const keyStore = { id: 'fixture', configured: true, getKey: async () => key };
    const definitions = [MODEL_A, MODEL_B].map((id) => ({
      choice: {
        id,
        name: id,
        efforts: ['low', 'high'] as ('low' | 'high')[],
        images: false,
        contextWindow: 64_000,
      },
      spec: { input: ['text'] },
    }));
    const pi = createPiModelBackend({
      fetch: async () => {
        throw new Error('unexpected catalog fetch in failure-scoping fixture');
      },
    });
    const backend = {
      ...pi,
      catalog: async () => definitions,
      connectKey: async (_provider: string, credential: unknown) => ({
        credential,
        models: definitions,
      }),
    };
    const services: ReturnType<typeof createModelService>[] = [];
    const create = async (ownerId: string) => {
      const service = createModelService({
        database,
        ownerId,
        keyStore: keyStore as never,
        backend: backend as never,
        origin: 'http://127.0.0.1:4310',
      });
      await service.initialize();
      services.push(service);
      return service;
    };
    t.after(async () => {
      for (const service of services) await service.close();
      await database.end();
      await root.query(`DROP SCHEMA ${schema} CASCADE`);
      await root.end();
    });
    return { create };
  }

  test(
    'card issue follows the selected model; failures stay per model across reload',
    { timeout: 15_000 },
    async (t) => {
      const f = await fixture(t);
      const owner = await f.create('fixture-issue-scope-owner');
      await owner.addKey('groq', 'fixture-issue-scope-key');

      // Default selection lands on the first catalog model (A) - the same
      // path that picked DeepSeek on the owner's new Cloudflare connection.
      const initial = owner.view().selection!;
      assert.equal(initial.modelId, MODEL_A);

      // A request to A fails with the exact provider 403 the owner saw.
      const accessA = await owner.resolve();
      assert.equal(accessA.definition.choice.id, MODEL_A);
      const recordA = await accessA.prepareRequest!(MODEL_A, false);
      await recordA(CLOUDFLARE_403, 403);

      // While A is selected the card shows A's failure, verbatim.
      const cardA = owner.view().connections.find((row) => row.id === initial.connectionId)!;
      assert.ok(cardA.issue?.reason.includes('not available on the Workers Free plan'));

      // Switch selection A -> B (the owner's "Change model" to GLM).
      await owner.select({ connectionId: initial.connectionId, modelId: MODEL_B, effort: 'low' });
      const view = owner.view();
      assert.equal(view.selection!.modelId, MODEL_B);
      const card = view.connections.find((row) => row.id === initial.connectionId)!;

      // The card is clear: B never failed. Before the fix this still showed
      // A's 403 - the exact "Last request failed" / "Current model" mismatch.
      assert.equal(card.issue, undefined);
      // A's failure survives on A's own model entry, not on B's.
      const entryA = card.models.find((model) => model.id === MODEL_A)!;
      const entryB = card.models.find((model) => model.id === MODEL_B)!;
      assert.ok(entryA.issue?.reason.includes('not available on the Workers Free plan'));
      assert.equal(entryB.issue, undefined);
      assert.ok(owner.issue({ connectionId: card.id, modelId: MODEL_A }));
      assert.equal(owner.issue({ connectionId: card.id, modelId: MODEL_B }), undefined);

      // The dispatched model id is the selected one: resolve and candidates
      // both build the access from B, never from the failed A.
      const accessB = await owner.resolve();
      assert.equal(accessB.definition.choice.id, MODEL_B);
      const candidates = await owner.candidates(view.selection);
      assert.equal(candidates[0]!.definition.choice.id, MODEL_B);

      // Automatic requests to the failed A stay paused until A succeeds...
      await assert.rejects(
        accessB.prepareRequest!(MODEL_A, true),
        /Automatic requests to this model are paused/,
      );
      // ...while manual requests to B record cleanly and leave the card clear.
      const recordB = await accessB.prepareRequest!(MODEL_B, false);
      await recordB();
      assert.equal(
        owner.view().connections.find((row) => row.id === card.id)!.issue,
        undefined,
      );

      // The scoping survives a reload: failures persist per model, the card
      // still follows the selection ("Reload models" must not resurface A).
      const reloaded = await f.create('fixture-issue-scope-owner');
      const again = reloaded.view();
      assert.equal(again.selection!.modelId, MODEL_B);
      const reloadedCard = again.connections.find((row) => row.id === card.id)!;
      assert.equal(reloadedCard.issue, undefined);
      assert.ok(
        reloadedCard.models.find((model) => model.id === MODEL_A)!.issue?.reason.includes(
          'not available on the Workers Free plan',
        ),
      );
    },
  );
});

describe('failureScope classifier', () => {
  test('scopes credential-wide and per-model failures without universalizing 403', async () => {
    const { failureScope } = await import('../src/server/models.ts');
    // Rejected key / missing credits break every model on the connection.
    assert.equal(failureScope(401, 'HTTP 401; invalid api key'), 'connection');
    assert.equal(failureScope(402, 'HTTP 402; This request requires more credits.'), 'connection');
    // The measured Cloudflare case: per-model plan availability.
    assert.equal(
      failureScope(
        403,
        'HTTP 403; @cf/deepseek-ai/deepseek-v4.1-flash-1017 is not available on the Workers Free plan',
      ),
      'model',
    );
    // Any other 403 may be account-wide: never universalized to model scope.
    assert.equal(failureScope(403, 'HTTP 403; Forbidden'), 'connection');
    assert.equal(failureScope(403, 'HTTP 403; Country, region, or territory not supported'), 'model');
    // Ordinary per-model conditions.
    assert.equal(failureScope(500, 'HTTP 500; Synthetic outage.'), 'model');
    assert.equal(failureScope(undefined, 'fetch failed'), 'model');
  });
});
