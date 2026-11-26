import { z } from 'zod';
import type { Pool } from 'pg';
import { withdrawnSql } from './turn-chain.ts';
export function activeThreadSql(alias = 'm') {
  return `${alias}.thread_id=(SELECT th.id FROM threads th WHERE th.owner_id=${alias}.owner_id AND th.archived_at IS NULL)`;
}

const inputSchema = z
  .object({
    query: z.string().trim().min(1).max(4000).optional(),
    before: z.uuid().optional(),
    cursor: z.uuid().optional(),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    around: z.uuid().optional(),
    order: z.enum(['relevance', 'newest']).default('relevance'),
    offset: z.number().int().min(0).optional(),
  })
  .refine((input) => input.query || input.around || input.from || input.to, {
    message: 'Search with query, from or to, or read around a result id.',
  })
  .refine((input) => !input.from || !input.to || input.from <= input.to, {
    message: 'The start date must not follow the end date.',
  });

export interface HistoryMessage {
  id: string;
  role: string;
  text: string;
  shortened: boolean;
  created_at: Date;
  match?: boolean;
}

export function createHistorySearch({
  pool,
  ownerId,
  standing = false,
}: {
  pool: Pick<Pool, 'query'>;
  ownerId: string;
  standing?: boolean;
}) {
  const kept = (alias: string) =>
    standing ? ` AND NOT (${alias}.role='user' AND ${withdrawnSql(alias)})` : '';
  // Execution-ack receipts are chat UI, not conversation: retrieval must not
  // return them, or a model quotes the receipt as if it were the reply.
  const notReceipt = (alias: string) =>
    ` AND (${alias}.stream_id IS NULL OR ${alias}.stream_id NOT LIKE 'ack:%')`;
  return async function search(raw: unknown) {
    const { query, before, cursor, from, to, around, order, offset } = inputSchema.parse(raw);
    if (around) {
      // Bounded window read: the target comes in TARGET_CHARS windows (continue
      // with offset=nextTargetOffset), context rows in short excerpts, and the
      // whole page under AROUND_TEXT_BYTES, dropping the farthest context rows
      // first. Originals stay complete in the DB; shortened flags, targetLength
      // and contextComplete keep the ranges honest.
      const TARGET_CHARS = 3000;
      const CONTEXT_CHARS = 600;
      const AROUND_TEXT_BYTES = 6000;
      const start = offset ?? 0;
      const { rows } = await pool.query<HistoryMessage & { target_length: number | null }>(
        `WITH target AS (
           SELECT m.created_at,m.id FROM messages m WHERE m.id=$2 AND m.owner_id=$1 AND m.hidden_at IS NULL AND ${activeThreadSql('m')}
           UNION ALL
           (SELECT m.created_at,m.id FROM turns u JOIN messages m ON m.turn_id=u.id AND m.owner_id=u.owner_id AND m.thread_id=u.thread_id
            WHERE u.id=$2 AND u.owner_id=$1 AND ${activeThreadSql('u')} AND m.hidden_at IS NULL${notReceipt('m')}
            ORDER BY m.created_at,m.id LIMIT 1)),
         hit AS (SELECT created_at,id FROM target LIMIT 1),
         nearby AS (
           (SELECT m.* FROM messages m,hit WHERE m.owner_id=$1 AND m.hidden_at IS NULL AND ${activeThreadSql('m')}${notReceipt('m')} AND (m.created_at,m.id)<(hit.created_at,hit.id) ORDER BY m.created_at DESC,m.id DESC LIMIT 5)
           UNION ALL (SELECT m.* FROM messages m,hit WHERE m.id=hit.id)
           UNION ALL (SELECT m.* FROM messages m,hit WHERE m.owner_id=$1 AND m.hidden_at IS NULL AND ${activeThreadSql('m')}${notReceipt('m')} AND (m.created_at,m.id)>(hit.created_at,hit.id) ORDER BY m.created_at,m.id LIMIT 5))
         SELECT id,role,CASE WHEN id=(SELECT id FROM hit) THEN substring(text from $3+1 for ${TARGET_CHARS}) ELSE left(text,${CONTEXT_CHARS}) END AS text,
           CASE WHEN id=(SELECT id FROM hit) THEN length(text)>$3+${TARGET_CHARS} ELSE length(text)>${CONTEXT_CHARS} END AS shortened,
           turn_id,created_at,
           CASE WHEN id=(SELECT id FROM hit) THEN length(text) END AS target_length FROM nearby ORDER BY created_at,id`,
        [ownerId, around, start],
      );
      if (!rows.length) throw new Error('This history result is unavailable.');
      const targetIndex = rows.findIndex((row) => row.target_length !== null);
      const target = targetIndex >= 0 ? rows[targetIndex]! : undefined;
      // Drop the farthest context rows, alternating sides, until the page fits.
      let bytes = rows.reduce((sum, row) => sum + Buffer.byteLength(row.text), 0);
      let contextComplete = true;
      const dropped = new Set<number>();
      for (;;) {
        if (bytes <= AROUND_TEXT_BYTES) break;
        const before = rows.findIndex((_, index) => index < targetIndex && !dropped.has(index));
        let after = -1;
        for (let index = rows.length - 1; index > targetIndex; index--)
          if (!dropped.has(index)) {
            after = index;
            break;
          }
        if (before < 0 && after < 0) break;
        const drop =
          before < 0
            ? after
            : after < 0
              ? before
              : targetIndex - before >= after - targetIndex
                ? before
                : after;
        dropped.add(drop);
        bytes -= Buffer.byteLength(rows[drop]!.text);
        contextComplete = false;
      }
      const kept = rows.filter((_, index) => !dropped.has(index));
      const nextTargetOffset =
        target && target.target_length! > start + TARGET_CHARS ? start + TARGET_CHARS : null;
      return {
        messages: kept.map(({ target_length: _target_length, ...row }) => row),
        complete: !nextTargetOffset,
        totalMatches: 1,
        nextCursor: null,
        ...(target ? { targetLength: target.target_length } : {}),
        ...(nextTargetOffset ? { nextTargetOffset } : {}),
        ...(contextComplete ? {} : { contextComplete: false }),
      };
    }
    const boundary = before
      ? (
          await pool.query<{ at: Date }>(
            `SELECT m.created_at AS at FROM messages m WHERE m.id=$2 AND m.owner_id=$1 AND m.hidden_at IS NULL AND ${activeThreadSql('m')}
           UNION ALL SELECT u.created_at FROM turns u WHERE u.id=$2 AND u.owner_id=$1 AND ${activeThreadSql('u')} LIMIT 1`,
            [ownerId, before],
          )
        ).rows[0]
      : undefined;
    if (before && !boundary) throw new Error('This history result is unavailable.');
    const terms = `WITH terms AS (SELECT replace(plainto_tsquery('simple',coalesce($2,''))::text,'&','|')::tsquery AS q,
      coalesce((SELECT time_zone FROM preferences WHERE owner_id=$1),'UTC') AS zone)`;
    const scope = (alias: string) =>
      `${alias}.owner_id=$1 AND ${activeThreadSql(alias)}
       AND ($3::timestamptz IS NULL OR (${alias}.created_at,${alias}.id)<($3,$4::uuid))
       AND ($5::date IS NULL OR (${alias}.created_at AT TIME ZONE terms.zone)::date>=$5)
       AND ($6::date IS NULL OR (${alias}.created_at AT TIME ZONE terms.zone)::date<=$6)`;
    const where = (alias: string, column: string) =>
      `${scope(alias)} AND ($2::text IS NULL OR to_tsvector('simple',${column}) @@ terms.q)`;
    const ordered = (alias: string, column: string) =>
      `${query && order === 'relevance' ? `ts_rank_cd(to_tsvector('simple',${column}),terms.q,1) DESC,` : ''}${alias}.created_at DESC,${alias}.id DESC`;
    const values = [
      ownerId,
      query ?? null,
      boundary?.at ?? null,
      before ?? null,
      from ?? null,
      to ?? null,
    ];
    let turns = await pool.query(
      `${terms} SELECT u.id,left(u.prompt,200) AS title,u.status,u.source,u.created_at,split_part(u.channel,':',1) AS channel
       FROM turns u CROSS JOIN terms WHERE ${where('u', 'u.prompt')} ORDER BY ${ordered('u', 'u.prompt')} LIMIT 15`,
      values,
    );
    let page = await pool.query<HistoryMessage & { place: string; total: number }>(
      // docs filters on the table column directly so the GIN index on
      // to_tsvector('simple',text) can serve the match; only matching rows get
      // their tsvector computed. corpus_count keeps the idf denominator over
      // the whole scoped thread (identical ranking to counting the old corpus
      // CTE) without a per-row tsvector over every message.
      `${terms},
       docs AS (
         SELECT m.id,m.owner_id,m.turn_id,m.role,m.text,m.created_at,to_tsvector('simple',m.text) AS v
         FROM messages m CROSS JOIN terms
         WHERE ${scope('m')} AND m.hidden_at IS NULL${kept('m')}${notReceipt('m')}
           AND ($2::text IS NULL OR to_tsvector('simple',m.text) @@ terms.q)),
       corpus_count AS (
         SELECT count(*) AS n FROM messages m CROSS JOIN terms WHERE ${scope('m')} AND m.hidden_at IS NULL${notReceipt('m')}),
       weights AS (
         SELECT w,ln(1+((SELECT n FROM corpus_count)-count(*)+0.5)/(count(*)+0.5)) AS idf
         FROM (SELECT DISTINCT lexeme AS w FROM unnest(tsvector_to_array(to_tsvector('simple',coalesce($2,'')))) lexeme) words
         JOIN docs ON docs.v @@ quote_literal(w)::tsquery GROUP BY w),
       scores AS (
         SELECT d.id,d.role,d.text,d.created_at,coalesce(sum(weights.idf),0) AS score
         FROM docs d LEFT JOIN weights ON d.v @@ quote_literal(weights.w)::tsquery
         GROUP BY d.id,d.role,d.text,d.created_at),
       ranked AS (
         SELECT id,role,text,created_at,row_number() OVER (ORDER BY ${query && order === 'relevance' ? 'score DESC,' : ''}created_at DESC,id DESC) AS place FROM scores),
       position AS (SELECT place FROM ranked WHERE id=$7::uuid),
       hits AS (SELECT * FROM ranked WHERE $7::uuid IS NULL OR place>(SELECT place FROM position) ORDER BY place LIMIT 21)
       SELECT hits.id,hits.role,left(hits.text,6000) AS text,length(hits.text)>6000 AS shortened,hits.created_at,hits.place,
         (SELECT count(*)::int FROM ranked) AS total FROM hits ORDER BY place`,
      [...values, cursor ?? null],
    );
    // Substring fallback: full-text search (config 'simple') matches whole
    // tokens, so a query word that appears only inside a larger token
    // (plural, prefix, punctuation-joined) finds nothing. When the primary
    // search returns no results at all, retry with per-term ILIKE matching
    // (terms of 2+ characters, OR'ed, ranked by rarity-weighted idf like the primary search).
    const fallbackTerms = (query ?? '')
      .split(/\s+/)
      .map((word) => word.trim())
      .filter((word) => word.length >= 2)
      .map((word) => `%${word.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
    let usedFallback = false;
    if (query && page.rows.length === 0 && turns.rows.length === 0 && fallbackTerms.length) {
      usedFallback = true;
      // Terms are passed as one array parameter ($2); each is an escaped
      // %term% pattern. Ranking mirrors the primary search: rarity-weighted
      // (idf) over the scoped corpus, newest first on ties.
      const fallbackValues = [
        ownerId,
        fallbackTerms,
        boundary?.at ?? null,
        before ?? null,
        from ?? null,
        to ?? null,
        cursor ?? null,
      ];
      const fscope = (alias: string) =>
        `${alias}.owner_id=$1 AND ${activeThreadSql(alias)}
         AND ($3::timestamptz IS NULL OR (${alias}.created_at,${alias}.id)<($3,$4::uuid))
         AND ($5::date IS NULL OR (${alias}.created_at AT TIME ZONE zone)::date>=$5)
         AND ($6::date IS NULL OR (${alias}.created_at AT TIME ZONE zone)::date<=$6)`;
      turns = await pool.query(
        `WITH z AS (SELECT coalesce((SELECT time_zone FROM preferences WHERE owner_id=$1),'UTC') AS zone),
         corpus AS MATERIALIZED (SELECT u.* FROM turns u CROSS JOIN z WHERE ${fscope('u')}),
         terms AS (SELECT t.term FROM unnest($2::text[]) AS t(term)),
         weights AS MATERIALIZED (
           SELECT terms.term,ln(1+((SELECT count(*) FROM corpus)-count(*)+0.5)/(count(*)+0.5)) AS idf
           FROM terms JOIN corpus ON corpus.prompt ILIKE terms.term ESCAPE '\' GROUP BY terms.term),
         scored AS (
           SELECT corpus.*,
             (SELECT coalesce(sum(weights.idf),0) FROM weights WHERE corpus.prompt ILIKE weights.term ESCAPE '\') AS score
           FROM corpus)
         SELECT id,left(prompt,200) AS title,status,source,created_at,split_part(channel,':',1) AS channel
         FROM scored WHERE score>0 ORDER BY score DESC,created_at DESC,id DESC LIMIT 15`,
        fallbackValues.slice(0, 6),
      );
      page = await pool.query<HistoryMessage & { place: string; total: number }>(
        `WITH z AS (SELECT coalesce((SELECT time_zone FROM preferences WHERE owner_id=$1),'UTC') AS zone),
         corpus AS MATERIALIZED (SELECT m.* FROM messages m CROSS JOIN z WHERE ${fscope('m')} AND m.hidden_at IS NULL${notReceipt('m')}),
         terms AS (SELECT t.term FROM unnest($2::text[]) AS t(term)),
         weights AS MATERIALIZED (
           SELECT terms.term,ln(1+((SELECT count(*) FROM corpus)-count(*)+0.5)/(count(*)+0.5)) AS idf
           FROM terms JOIN corpus ON corpus.text ILIKE terms.term ESCAPE '\' GROUP BY terms.term),
         scored AS (
           SELECT corpus.*,
             (SELECT coalesce(sum(weights.idf),0) FROM weights WHERE corpus.text ILIKE weights.term ESCAPE '\') AS score
           FROM corpus),
         ranked AS (
           SELECT id,role,text,created_at,row_number() OVER (ORDER BY score DESC,created_at DESC,id DESC) AS place
           FROM scored WHERE score>0),
         position AS (SELECT place FROM ranked WHERE id=$7::uuid),
         hits AS (SELECT * FROM ranked WHERE $7::uuid IS NULL OR place>(SELECT place FROM position) ORDER BY place LIMIT 21)
         SELECT id,role,left(text,6000) AS text,length(text)>6000 AS shortened,created_at,place,
           (SELECT count(*)::int FROM ranked) AS total FROM hits ORDER BY place`,
        fallbackValues,
      );
    }
    if (cursor && !page.rows.length && !usedFallback) {
      const { rows } = await pool.query(
        `${terms} SELECT m.id FROM messages m CROSS JOIN terms WHERE ${where('m', 'm.text')} AND m.hidden_at IS NULL${kept('m')}${notReceipt('m')} AND m.id=$7::uuid`,
        [...values, cursor],
      );
      if (!rows.length) throw new Error('This history cursor does not match the search.');
    }
    if (cursor && !page.rows.length && usedFallback) {
      const { rows } = await pool.query(
        `SELECT m.id FROM messages m
         WHERE m.id=$3::uuid AND m.owner_id=$1 AND ${activeThreadSql('m')} AND m.hidden_at IS NULL${notReceipt('m')}
           AND EXISTS (SELECT 1 FROM unnest($2::text[]) AS t(term) WHERE m.text ILIKE t.term ESCAPE '\')`,
        [ownerId, fallbackTerms, cursor],
      );
      if (!rows.length) throw new Error('This history cursor does not match the search.');
    }
    const picked = page.rows.slice(0, 20);
    const nextCursor = page.rows.length > 20 ? picked.at(-1)!.id : null;
    const { rows: messages } = await pool.query<HistoryMessage>(
      `WITH terms AS (SELECT replace(plainto_tsquery('simple',coalesce($4,''))::text,'&','|')::tsquery AS q),
       thread AS (
         SELECT m.id,m.owner_id,m.role,m.text,m.turn_id,m.created_at,row_number() OVER (ORDER BY m.created_at,m.id) AS n
         FROM messages m WHERE m.owner_id=$1 AND m.hidden_at IS NULL AND ${activeThreadSql('m')}${notReceipt('m')}),
       picked AS (SELECT t.n,ids.place,t.id FROM unnest($2::uuid[]) WITH ORDINALITY ids(id,place) JOIN thread t ON t.id=ids.id),
       shown AS (
         -- A row that is itself a match keeps its OWN rank place; only pure
         -- context rows inherit the best covering match's place. Without this
         -- min(p.place) lets an earlier-in-time match steal the rank of a
         -- better-ranked neighbour whose context window covers it, swapping
         -- the displayed order of matches.
         SELECT t.*,bool_or(p.id=t.id) AS match,
           coalesce(max(CASE WHEN p.id=t.id THEN p.place END),min(p.place)) AS place FROM thread t
         JOIN picked p ON t.n BETWEEN p.n-$3 AND p.n+$3 GROUP BY t.id,t.owner_id,t.role,t.text,t.turn_id,t.created_at,t.n)
       SELECT s.id,s.role,CASE WHEN length(s.text)<=1200 THEN s.text
         ELSE ts_headline('simple',s.text,terms.q,'StartSel="",StopSel="",MaxWords=60,MinWords=20,MaxFragments=3,FragmentDelimiter=" … "') END AS text,
         length(s.text)>1200 AS shortened,s.turn_id,s.created_at,s.place,
         split_part(COALESCE(u.channel,'web'),':',1) AS channel,s.match
       FROM shown s CROSS JOIN terms LEFT JOIN turns u ON u.id=s.turn_id AND u.owner_id=$1
       WHERE TRUE${kept('s')} ORDER BY s.place,s.n`,
      [ownerId, picked.map((row) => row.id), query ? 1 : 0, query ?? null],
    );
    // Keep one page inside the per-tool context budget: whole match blocks
    // (a match plus its surrounding rows) are added until the byte cap, and
    // the search continues with nextCursor, so no match is dropped for good.
    const PAGE_TEXT_BYTES = 6000;
    const blocks: {
      place: number;
      rows: typeof messages;
      bytes: number;
      matchId: string | null;
    }[] = [];
    for (const row of messages) {
      const place = Number((row as { place?: unknown }).place ?? -1);
      const last = blocks.at(-1);
      if (last && last.place === place) {
        last.rows.push(row);
        last.bytes += Buffer.byteLength(row.text);
        if (row.match) last.matchId = row.id;
      } else {
        blocks.push({
          place,
          rows: [row],
          bytes: Buffer.byteLength(row.text),
          matchId: row.match ? row.id : null,
        });
      }
    }
    let pageBytes = 0;
    let keptCount = blocks.length;
    for (const [index, block] of blocks.entries()) {
      if (index > 0 && pageBytes + block.bytes > PAGE_TEXT_BYTES) {
        keptCount = index;
        break;
      }
      pageBytes += block.bytes;
    }
    const keptBlocks = blocks.slice(0, keptCount);
    const lastMatch =
      [...keptBlocks].reverse().find((block) => block.matchId)?.matchId ?? null;
    // Truncation needs a valid continuation cursor: a ranked match id. When
    // no kept block has one (pathological), keep the whole page instead.
    const trimmed = keptCount < blocks.length && lastMatch;
    const pagedMessages = trimmed ? keptBlocks.flatMap((block) => block.rows) : messages;
    const pagedNext = trimmed ? lastMatch : nextCursor;
    // Bound the turn-title list the same way; turnsTruncated says how many
    // were left out so nothing is silently dropped.
    const TURNS_TITLE_BYTES = 1500;
    let titleBytes = 0;
    let keptTurns = 0;
    for (const row of turns.rows as Array<{ title?: string }>) {
      const size = Buffer.byteLength(row.title ?? '');
      if (keptTurns > 0 && titleBytes + size > TURNS_TITLE_BYTES) break;
      titleBytes += size;
      keptTurns++;
    }
    const turnsTruncated = turns.rows.length - keptTurns;
    return {
      turns: turns.rows.slice(0, keptTurns),
      messages: pagedMessages,
      complete: !pagedNext,
      totalMatches: page.rows[0]?.total ?? 0,
      nextCursor: pagedNext,
      ...(turnsTruncated ? { turnsTruncated } : {}),
    };
  };
}
