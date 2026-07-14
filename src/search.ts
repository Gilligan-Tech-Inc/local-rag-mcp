import type { RagDb } from './db.js';
import { blobToVector, vecSearch } from './db.js';
import { cosineSimilarity, embedText } from './embeddings.js';
import type { SearchHit, SearchMode, SearchResult } from './types.js';

// Reciprocal Rank Fusion constant (Cormack et al. 2009). Fusing the *ranks* of the lexical
// and vector result lists — rather than blending their raw scores — is scale-free: bm25
// distances and cosine similarities live on different, incomparable scales, so a weighted
// sum of the two is only ever an arbitrary knob. RRF needs no such tuning.
const RRF_K = 60;

interface Row {
  chunk_id: number;
  chunk_index: number;
  text: string;
  document_id: number;
  title: string;
  source: string;
  collection: string;
  tags: string;
  rank?: number;
  vector?: Buffer;
  vec_dim?: number;
}

function parseTags(raw: string): string[] {
  try {
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

function ftsQuery(query: string): string {
  const terms = Array.from(query.matchAll(/[\p{L}\p{N}_]{2,}/gu)).map((m) => m[0]?.toLowerCase()).filter(Boolean) as string[];
  if (terms.length === 0) return query.replace(/"/g, '""');
  return terms.map((term) => `${term.replace(/"/g, '""')}*`).join(' OR ');
}

function makeSnippet(text: string, query: string): string {
  const firstTerm = query.split(/\s+/).find(Boolean)?.toLowerCase();
  if (!firstTerm) return text.slice(0, 280);
  const idx = text.toLowerCase().indexOf(firstTerm);
  const start = idx > 80 ? idx - 80 : 0;
  return (start > 0 ? '...' : '') + text.slice(start, start + 280) + (start + 280 < text.length ? '...' : '');
}

function rowToHit(row: Row, lexical: number | null, vector: number | null, final: number, query: string): SearchHit {
  return {
    document: {
      id: row.document_id,
      title: row.title,
      source: row.source,
      collection: row.collection,
      tags: parseTags(row.tags),
    },
    chunk: {
      id: row.chunk_id,
      chunk_index: row.chunk_index,
      text: row.text,
      snippet: makeSnippet(row.text, query),
    },
    score: final,
    score_parts: { lexical, vector, final },
  };
}

function keywordRows(db: RagDb, query: string, collection?: string, limit = 20): Map<number, { row: Row; score: number }> {
  const params: unknown[] = [ftsQuery(query)];
  const conditions: string[] = ['chunks_fts MATCH ?'];
  if (collection) {
    conditions.push('d.collection = ?');
    params.push(collection);
  }
  params.push(Math.max(limit * 4, 50));

  try {
    const rows = db
      .prepare(
        `SELECT c.id AS chunk_id, c.chunk_index, c.text, d.id AS document_id, d.title, d.source,
                d.collection, d.tags, bm25(chunks_fts) AS rank
         FROM chunks_fts
         JOIN chunks c ON c.id = chunks_fts.rowid
         JOIN documents d ON d.id = c.document_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY rank ASC
         LIMIT ?`,
      )
      .all(...params) as Row[];
    return new Map(rows.map((row) => [row.chunk_id, { row, score: 1 / (1 + Math.abs(row.rank ?? 0)) }]));
  } catch {
    const like = `%${query}%`;
    const likeParams: unknown[] = [like];
    const where = collection ? 'WHERE c.text LIKE ? AND d.collection = ?' : 'WHERE c.text LIKE ?';
    if (collection) likeParams.push(collection);
    likeParams.push(Math.max(limit * 4, 50));
    const rows = db
      .prepare(
        `SELECT c.id AS chunk_id, c.chunk_index, c.text, d.id AS document_id, d.title, d.source,
                d.collection, d.tags, 0 AS rank
         FROM chunks c JOIN documents d ON d.id = c.document_id
         ${where}
         ORDER BY d.updated_at DESC
         LIMIT ?`,
      )
      .all(...likeParams) as Row[];
    return new Map(rows.map((row) => [row.chunk_id, { row, score: 0.5 }]));
  }
}

async function vectorRows(
  db: RagDb,
  query: string,
  collection?: string,
  limit = 20,
): Promise<{ rows: Map<number, { row: Row; score: number }>; warning: string | null }> {
  const queryVector = await embedText(query);
  const qDim = queryVector.length;
  const overFetch = Math.max(limit * 4, 50);

  // Fast path: sqlite-vec ANN index. `vecSearch` returns null when the extension is unavailable
  // or the query dimension doesn't match the index, in which case we fall through to the JS scan.
  const knn = vecSearch(db, queryVector, overFetch);
  if (knn !== null) {
    const ids = knn.map((k) => k.chunk_id);
    const annMap = new Map<number, { row: Row; score: number }>();
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      const byId = new Map<number, Row>();
      const dbRows = db
        .prepare(
          `SELECT c.id AS chunk_id, c.chunk_index, c.text, d.id AS document_id, d.title, d.source,
                  d.collection, d.tags
           FROM chunks c JOIN documents d ON d.id = c.document_id
           WHERE c.id IN (${placeholders})`,
        )
        .all(...ids) as Row[];
      for (const r of dbRows) byId.set(r.chunk_id, r);
      // Preserve KNN order (distance ascending = vector rank) so RRF fusion sees the right ranks.
      for (const { chunk_id, distance } of knn) {
        const row = byId.get(chunk_id);
        if (!row) continue;
        if (collection && row.collection !== collection) continue;
        annMap.set(chunk_id, { row, score: 1 / (1 + distance) });
      }
    }
    return { rows: annMap, warning: null };
  }

  const params: unknown[] = [];
  const where = collection ? 'WHERE d.collection = ?' : '';
  if (collection) params.push(collection);
  const rows = db
    .prepare(
      `SELECT c.id AS chunk_id, c.chunk_index, c.text, d.id AS document_id, d.title, d.source,
              d.collection, d.tags, e.vector, e.dimension AS vec_dim
       FROM embeddings e
       JOIN chunks c ON c.id = e.chunk_id
       JOIN documents d ON d.id = c.document_id
       ${where}`,
    )
    .all(...params) as Row[];

  // Only vectors of the same dimensionality as the query are comparable. A different
  // dimension means a different embedding model — silently cosine-ing against them would
  // just return 0 and quietly poison recall, so we drop them and tell the caller.
  let skipped = 0;
  const comparable = rows.filter((row) => {
    if ((row.vec_dim ?? blobToVector(row.vector as Buffer).length) === qDim) return true;
    skipped++;
    return false;
  });
  const warning =
    skipped > 0
      ? `${skipped} stored ${skipped === 1 ? 'vector was' : 'vectors were'} skipped: their ` +
        `dimension differs from the current embedding model (${qDim}-d). Run ` +
        `rag_reindex with embeddings to rebuild them for consistent search.`
      : null;

  const map = new Map(
    comparable
      .map((row) => ({ row, score: cosineSimilarity(queryVector, blobToVector(row.vector as Buffer)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(limit * 4, 50))
      .map(({ row, score }) => [row.chunk_id, { row, score }]),
  );
  return { rows: map, warning };
}

export async function search(
  db: RagDb,
  args: { query: string; mode?: SearchMode; collection?: string; limit?: number },
): Promise<SearchResult> {
  const query = args.query.trim();
  if (!query) throw new Error('query is required');
  const requestedMode = args.mode ?? 'hybrid';
  const limit = args.limit ?? 10;

  const lexical = requestedMode === 'vector' ? new Map<number, { row: Row; score: number }>() : keywordRows(db, query, args.collection, limit);
  let vector = new Map<number, { row: Row; score: number }>();
  let warning: string | null = null;

  let dimWarning: string | null = null;
  if (requestedMode !== 'keyword') {
    try {
      const vres = await vectorRows(db, query, args.collection, limit);
      vector = vres.rows;
      dimWarning = vres.warning;
    } catch (err) {
      warning = err instanceof Error ? err.message : 'Vector search unavailable.';
    }
  }

  const actualMode = requestedMode === 'keyword' || vector.size === 0
    ? 'keyword'
    : lexical.size === 0 || requestedMode === 'vector'
      ? 'vector'
      : 'hybrid';

  // Both maps are built best-first (lexical ordered by bm25, vector by cosine desc), so a
  // key's insertion position is its rank in that list. Fuse those ranks with RRF for hybrid.
  const lexRank = new Map(Array.from(lexical.keys()).map((id, i) => [id, i + 1]));
  const vecRank = new Map(Array.from(vector.keys()).map((id, i) => [id, i + 1]));

  const chunkIds = new Set([...lexical.keys(), ...vector.keys()]);
  const hits = Array.from(chunkIds).map((id) => {
    const l = lexical.get(id);
    const v = vector.get(id);
    const row = (l?.row ?? v?.row) as Row;
    const lexicalScore = l?.score ?? null;
    const vectorScore = v?.score ?? null;
    const final = actualMode === 'hybrid'
      ? (lexRank.has(id) ? 1 / (RRF_K + lexRank.get(id)!) : 0) +
        (vecRank.has(id) ? 1 / (RRF_K + vecRank.get(id)!) : 0)
      : actualMode === 'vector'
        ? (vectorScore ?? 0)
        : (lexicalScore ?? 0);
    return rowToHit(row, lexicalScore, vectorScore, final, query);
  });

  hits.sort((a, b) => b.score - a.score);

  const messages: string[] = [];
  if (warning && requestedMode !== 'keyword') messages.push(`Using ${actualMode} search: ${warning}`);
  if (dimWarning) messages.push(dimWarning);

  return {
    query,
    requested_mode: requestedMode,
    mode_used: actualMode,
    warning: messages.length > 0 ? messages.join(' ') : null,
    results: hits.slice(0, limit),
  };
}
