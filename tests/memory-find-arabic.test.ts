import assert from 'node:assert/strict';
import test from 'node:test';
import { find, parse } from '../src/server/memory-tree.ts';

// Arabic recall regression: a natural query term must match stored tokens
// that carry a clitic prefix (definite article ال, or a preposition letter
// plus ال as in للطيران). Before normalization these queries missed.
function treeWith(text: string) {
  return parse(
    Buffer.from(
      JSON.stringify({
        enabled: true,
        entries: [
          {
            area: 'preferences',
            slug: 'flight-airline',
            text,
            origin: 'stated',
            updated: '2026-11-18T10:00:00.000Z',
            edited: '2026-11-18T10:00:00.000Z',
            sources: [],
          },
        ],
        archive: [],
      }),
    ),
  );
}

const tree = treeWith('يفضل مصر للطيران ودرجة رجال الأعمال في الرحلات الطويلة');

test('the natural Arabic query matches a token with a preposition+article clitic', () => {
  const hits = find(tree, 'طيران');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, 'preferences/flight-airline');
});

test('a query carrying the definite article matches the bare stored token', () => {
  const withArticle = parse(
    Buffer.from(
      JSON.stringify({
        enabled: true,
        entries: [
          {
            area: 'about',
            slug: 'work-rhythm',
            text: 'بيشتغل احسن في الصبح بدري',
            origin: 'stated',
            updated: '2026-11-20T10:00:00.000Z',
            edited: '2026-11-20T10:00:00.000Z',
            sources: [],
          },
        ],
        archive: [],
      }),
    ),
  );
  assert.equal(find(withArticle, 'الصبح').length, 1);
  assert.equal(find(withArticle, 'صبح').length, 1);
});

test('exact and prefix matching still work and unrelated terms still miss', () => {
  assert.equal(find(tree, 'مصر').length, 1);
  assert.equal(find(tree, 'flight').length, 1, 'slug words still match');
  assert.equal(find(tree, 'مراجعة').length, 0);
  assert.equal(find(tree, 'اليابان').length, 0);
});

test('short remainders are not over-stripped', () => {
  // "بال" would reduce below the useful length; it must stay intact and
  // must not match a query for the bare residue.
  assert.equal(find(tree, 'بال').length, 0);
});
