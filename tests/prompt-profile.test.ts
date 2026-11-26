import test from 'node:test';
import assert from 'node:assert/strict';
import { systemPrompt } from '../src/runtime/prompt.ts';

const workspace: any = {
  path: '/tmp/ws',
  instructions: 'Fixture workspace only.',
  exec: async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }),
};

function withProfile(value: string | undefined, fn: () => void) {
  const before = process.env.NOD_PROMPT_PROFILE;
  if (value === undefined) delete process.env.NOD_PROMPT_PROFILE;
  else process.env.NOD_PROMPT_PROFILE = value;
  try {
    fn();
  } finally {
    if (before === undefined) delete process.env.NOD_PROMPT_PROFILE;
    else process.env.NOD_PROMPT_PROFILE = before;
  }
}

test('default profile is unchanged by the headless gate', () => {
  withProfile(undefined, () => {
    const p = systemPrompt(workspace, undefined, undefined, false, true);
    assert.match(p, /Write like a friendly colleague/);
    assert.match(p, /apps SEARCH_TOOLS returns schemas/);
    assert.match(p, /Guides: connected-apps/);
    assert.match(p, /Read the nod guide/);
  });
});

test('headless trims tone, apps and guide routing but keeps language, safety and semantics', () => {
  withProfile('headless', () => {
    const p = systemPrompt(workspace, undefined, undefined, false, true);
    // trimmed
    assert.doesNotMatch(p, /Write like a friendly colleague/);
    assert.doesNotMatch(p, /apps SEARCH_TOOLS returns schemas/);
    assert.doesNotMatch(p, /Read the nod guide/);
    // kept: owner language expectation
    assert.match(p, /conversation's language/);
    assert.match(p, /sourceWording|Translate outside content/);
    // kept: safety and execution semantics
    assert.match(p, /Complete requested work with tools\. The server obtains approval/);
    assert.match(p, /Only memory_learn writes notes from owner messages/);
    assert.match(p, /Requests carry JSON data/);
    assert.match(p, /Check saved login metadata first/);
    assert.match(p, /skills read, and schedules-and-watches before scheduling/);
  });
});

test('headless is measurably smaller in every mode', () => {
  const sizes: Record<string, [number, number]> = {};
  for (const compact of [false, true]) {
    withProfile(undefined, () => {
      sizes[`d${compact}`] = [Buffer.byteLength(systemPrompt(workspace, undefined, undefined, false, compact)), 0];
    });
    withProfile('headless', () => {
      sizes[`d${compact}`][1] = Buffer.byteLength(systemPrompt(workspace, undefined, undefined, false, compact));
    });
    const [base, headless] = sizes[`d${compact}`];
    assert.ok(headless < base, `compact=${compact}: ${headless} !< ${base}`);
    console.log(`compact=${compact}: default ${base} B -> headless ${headless} B (saved ${base - headless} B)`);
  }
});
