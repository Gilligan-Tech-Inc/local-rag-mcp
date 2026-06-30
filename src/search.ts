import type { RagDb } from './db.js';
import { blobToVector } from './db.js';
import { cosineSimilarity, embedText } from './embeddings.js';
import type { SearchHit, SearchMode, SearchResult } from './types.js';

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

async function vectorRows(db: RagDb, query: string, collection?: string, limit = 20): Promise<Map<number, { row: Row; score: number }>> {
  const queryVector = await embedText(query);
  const params: unknown[] = [];
  const where = collection ? 'WHERE d.collection = ?' : '';
  if (collection) params.push(collection);
  const rows = db
    .prepare(
      `SELECT c.id AS chunk_id, c.chunk_index, c.text, d.id AS document_id, d.title, d.source,
              d.collection, d.tags, e.vector
       FROM embeddings e
       JOIN chunks c ON c.id = e.chunk_id
       JOIN documents d ON d.id = c.document_id
       ${where}`,
    )
    .all(...params) as Row[];

  return new Map(
    rows
      .map((row) => ({ row, score: cosineSimilarity(queryVector, blobToVector(row.vector as Buffer)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(limit * 4, 50))
      .map(({ row, score }) => [row.chunk_id, { row, score }]),
  );
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

  if (requestedMode !== 'keyword') {
    try {
      vector = await vectorRows(db, query, args.collection, limit);
    } catch (err) {
      warning = err instanceof Error ? err.message : 'Vector search unavailable.';
    }
  }

  const actualMode = requestedMode === 'keyword' || vector.size === 0
    ? 'keyword'
    : lexical.size === 0 || requestedMode === 'vector'
      ? 'vector'
      : 'hybrid';

  const chunkIds = new Set([...lexical.keys(), ...vector.keys()]);
  const hits = Array.from(chunkIds).map((id) => {
    const l = lexical.get(id);
    const v = vector.get(id);
    const row = (l?.row ?? v?.row) as Row;
    const lexicalScore = l?.score ?? null;
    const vectorScore = v?.score ?? null;
    const final = actualMode === 'hybrid'
      ? (lexicalScore ?? 0) * 0.55 + (vectorScore ?? 0) * 0.45
      : actualMode === 'vector'
        ? (vectorScore ?? 0)
        : (lexicalScore ?? 0);
    return rowToHit(row, lexicalScore, vectorScore, final, query);
  });

  hits.sort((a, b) => b.score - a.score);

  return {
    query,
    requested_mode: requestedMode,
    mode_used: actualMode,
    warning: warning && requestedMode !== 'keyword' ? `Using ${actualMode} search: ${warning}` : null,
    results: hits.slice(0, limit),
  };
}
