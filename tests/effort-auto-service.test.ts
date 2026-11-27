/**
 * Wiring tests for the Auto effort MODE against the REAL model service with
 * a real database:
 *   - PUT-level selection accepts 'auto' on a multi-level model and stores
 *     it as 'auto' (not silently resolved away);
 *   - the view exposes the stored mode AND the currently resolved level;
 *   - resolve() always yields a concrete level plus the effortAuto flag the
 *     request-time layer uses to adapt per payload;
 *   - 'auto' survives a service reload (selectDefault must not reset it);
 *   - 'auto' on a level-less model is rejected, never invented.
 */
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';

describe('auto effort mode wiring', { skip: !process.env.TEST_DATABASE_URL }, () => {
  async function fixture(t: import('node:test').TestContext) {
    const { createModelService } = await import('../src/server/models.ts');
    const { createPiModelBackend } = await import('../src/providers/pi/models.ts');
    const schema = `test_auto_${randomUUID().replaceAll('-', '')}`;
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
    const definitions = [
      {
        choice: {
          id: 'fixture-multi',
          name: 'Multi',
          efforts: ['low', 'high'] as ('low' | 'high')[],
          images: false,
          contextWindow: 64_000,
          pricing: { input: 0, output: 0 },
        },
        spec: { input: ['text'] },
      },
      {
        choice: {
          id: 'fixture-flat',
          name: 'Flat',
          efforts: [] as string[],
          images: false,
          contextWindow: 64_000,
        },
        spec: { input: ['text'] },
      },
    ];
    const pi = createPiModelBackend({
      fetch: async () => {
        throw new Error('unexpected catalog fetch in auto-effort fixture');
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
    "'auto' stores as a mode, resolves concrete, exposes both, survives reload",
    { timeout: 15_000 },
    async (t) => {
      const f = await fixture(t);
      const owner = await f.create('fixture-auto-owner');
      await owner.addKey('groq', 'fixture-auto-key');
      const connectionId = owner.view().selection!.connectionId;

      await owner.select({ connectionId, modelId: 'fixture-multi', effort: 'auto' });
      const view = owner.view();
      assert.equal(view.selection!.effort, 'auto');
      // Free model, no request signal yet: base resolution is the provider
      // default ('high' when supported), exposed for the card/picker.
      assert.equal(view.resolvedEffort, 'high');

      const access = await owner.resolve();
      assert.equal(access.effort, 'high');
      assert.equal(access.effortAuto, true);

      // Manual picks stay manual: no flag, no adaptation.
      await owner.select({ connectionId, modelId: 'fixture-multi', effort: 'low' });
      const manual = await owner.resolve();
      assert.equal(manual.effort, 'low');
      assert.equal(manual.effortAuto, undefined);
      assert.equal(owner.view().resolvedEffort, undefined);

      // 'auto' survives a reload: selectDefault must not reset the mode.
      await owner.select({ connectionId, modelId: 'fixture-multi', effort: 'auto' });
      const reloaded = await f.create('fixture-auto-owner');
      assert.equal(reloaded.view().selection!.effort, 'auto');
      assert.equal(reloaded.view().resolvedEffort, 'high');

      // 'auto' on a level-less model is rejected, never invented.
      await assert.rejects(
        owner.select({ connectionId, modelId: 'fixture-flat', effort: 'auto' }),
        /Choose an available model and effort/,
      );
    },
  );
});
