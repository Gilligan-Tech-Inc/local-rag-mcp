import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { ensureDbDir, getDbPath, vecDisabled } from './config.js';
import type { ChunkRecord, DocumentRecord, RagStats } from './types.js';

export type RagDb = Database.Database;

// Per-connection vector-index state: whether the sqlite-vec extension loaded, and the fixed
// dimension of the vec_chunks table once it exists. Kept in a WeakMap so multiple open DBs
// (e.g. in tests) don't clobber a shared global.
const vecState = new WeakMap<RagDb, { available: boolean; dim: number | null }>();

// Best-effort, synchronous load of the optional sqlite-vec extension. Returns false (and never
// throws) when the optionalDependency isn't installed, can't load on this platform, or is
// disabled via LOCAL_RAG_DISABLE_VEC — the caller then uses the pure-JS cosine fallback.
function tryLoadVec(db: RagDb): boolean {
  if (vecDisabled()) return false;
  try {
    const require = createRequire(import.meta.url);
    const sqliteVec = require('sqlite-vec') as { load: (db: RagDb) => void };
    sqliteVec.load(db);
    db.prepare('SELECT vec_version()').get();
    return true;
  } catch {
    return false;
  }
}

export function openDb(path = getDbPath()): RagDb {
  ensureDbDir(path);
  const db = new Database(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  const available = tryLoadVec(db);
  vecState.set(db, { available, dim: available ? readVecDim(db) : null });
  return db;
}

export function isVecAvailable(db: RagDb): boolean {
  return vecState.get(db)?.available ?? false;
}

// Reads the dimension the vec_chunks table was created with (null if it doesn't exist yet).
function readVecDim(db: RagDb): number | null {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'vec_dim'")
    .get() as { value: string } | undefined;
  if (!row) return null;
  const has = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vec_chunks'")
    .get();
  return has ? Number(row.value) : null;
}

// A vec0 table has a fixed dimension chosen at creation. Create it lazily the first time we see
// an embedding, keyed by the implicit rowid = chunk id. Returns the table's dimension, or null
// if vec is unavailable or the requested dimension conflicts with an existing table (that
// vector then simply isn't ANN-indexed and is handled by the JS fallback + dimension guard).
function ensureVecTable(db: RagDb, dim: number): number | null {
  const state = vecState.get(db);
  if (!state?.available) return null;
  if (state.dim === null) {
    // cosine metric so the ANN ranking matches the JS cosineSimilarity fallback exactly.
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(embedding float[${dim}] distance_metric=cosine)`);
    setSetting(db, 'vec_dim', String(dim));
    state.dim = dim;
  }
  return state.dim === dim ? dim : null;
}

// Insert/replace a chunk's vector in the ANN index. No-op unless vec is available and the
// dimension matches the index. Chunk ids must bind as true integers (BigInt) for vec0.
export function vecUpsert(db: RagDb, chunkId: number, vector: number[]): void {
  if (ensureVecTable(db, vector.length) !== vector.length) return;
  db.prepare('INSERT OR REPLACE INTO vec_chunks(rowid, embedding) VALUES (?, ?)').run(
    BigInt(chunkId),
    vectorToBlob(vector),
  );
}

export function vecDelete(db: RagDb, chunkId: number): void {
  const state = vecState.get(db);
  if (!state?.available || state.dim === null) return;
  db.prepare('DELETE FROM vec_chunks WHERE rowid = ?').run(BigInt(chunkId));
}

// KNN over the ANN index. Returns chunk_id + distance (ascending = nearest), or null to signal
// the caller to fall back to the JS scan (vec unavailable, no index yet, or dimension mismatch).
export function vecSearch(
  db: RagDb,
  queryVector: number[],
  k: number,
): Array<{ chunk_id: number; distance: number }> | null {
  const state = vecState.get(db);
  if (!state?.available || state.dim === null || state.dim !== queryVector.length) return null;
  return db
    .prepare(
      'SELECT rowid AS chunk_id, distance FROM vec_chunks WHERE embedding MATCH ? AND k = ? ORDER BY distance',
    )
    .all(vectorToBlob(queryVector), k) as Array<{ chunk_id: number; distance: number }>;
}

// Rebuild the ANN index from the embeddings table. Picks the most common embedding dimension as
// the index dimension (vec0 tables are single-dimension). Returns the number of vectors indexed.
export function rebuildVec(db: RagDb): number {
  const state = vecState.get(db);
  if (!state?.available) return 0;
  db.exec('DROP TABLE IF EXISTS vec_chunks');
  const dimRow = db
    .prepare('SELECT dimension, COUNT(*) AS c FROM embeddings GROUP BY dimension ORDER BY c DESC LIMIT 1')
    .get() as { dimension: number; c: number } | undefined;
  if (!dimRow) {
    state.dim = null;
    db.prepare("DELETE FROM settings WHERE key = 'vec_dim'").run();
    return 0;
  }
  const dim = dimRow.dimension;
  db.exec(`CREATE VIRTUAL TABLE vec_chunks USING vec0(embedding float[${dim}] distance_metric=cosine)`);
  setSetting(db, 'vec_dim', String(dim));
  state.dim = dim;
  const insert = db.prepare('INSERT OR REPLACE INTO vec_chunks(rowid, embedding) VALUES (?, ?)');
  const rows = db
    .prepare('SELECT chunk_id, vector FROM embeddings WHERE dimension = ?')
    .all(dim) as Array<{ chunk_id: number; vector: Buffer }>;
  let n = 0;
  for (const r of rows) {
    insert.run(BigInt(r.chunk_id), r.vector);
    n++;
  }
  return n;
}

export function migrate(db: RagDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      title        TEXT NOT NULL,
      source       TEXT NOT NULL DEFAULT '',
      collection   TEXT NOT NULL DEFAULT 'default',
      tags         TEXT NOT NULL DEFAULT '[]',
      metadata     TEXT NOT NULL DEFAULT '{}',
      content_hash TEXT NOT NULL DEFAULT '',
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      text        TEXT NOT NULL,
      char_count  INTEGER NOT NULL,
      token_count INTEGER NOT NULL,
      created_at  TEXT NOT NULL,
      UNIQUE(document_id, chunk_index)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts
      USING fts5(title, source, collection, tags, text);

    CREATE TABLE IF NOT EXISTS embeddings (
      chunk_id   INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
      provider   TEXT NOT NULL,
      model      TEXT NOT NULL,
      dimension  INTEGER NOT NULL,
      vector     BLOB NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_documents_collection ON documents(collection);
    CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id, chunk_index);
    CREATE INDEX IF NOT EXISTS idx_embeddings_model ON embeddings(provider, model);

    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, title, source, collection, tags, text)
        SELECT new.id, d.title, d.source, d.collection, d.tags, new.text
        FROM documents d WHERE d.id = new.document_id;
    END;

    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      DELETE FROM chunks_fts WHERE rowid = old.id;
    END;

    CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
      DELETE FROM chunks_fts WHERE rowid = old.id;
      INSERT INTO chunks_fts(rowid, title, source, collection, tags, text)
        SELECT new.id, d.title, d.source, d.collection, d.tags, new.text
        FROM documents d WHERE d.id = new.document_id;
    END;

    CREATE TRIGGER IF NOT EXISTS documents_fts_au
    AFTER UPDATE OF title, source, collection, tags ON documents BEGIN
      DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE document_id = new.id);
      INSERT INTO chunks_fts(rowid, title, source, collection, tags, text)
        SELECT c.id, new.title, new.source, new.collection, new.tags, c.text
        FROM chunks c WHERE c.document_id = new.id;
    END;
  `);

  db.pragma('user_version = 1');
  setSetting(db, 'schema_version', '1');
}

export function hashContent(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function setSetting(db: RagDb, key: string, value: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO settings (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, now);
}

function jsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function rowToDocument(row: Record<string, unknown>): DocumentRecord {
  return {
    id: row['id'] as number,
    title: row['title'] as string,
    source: row['source'] as string,
    collection: row['collection'] as string,
    tags: jsonParse<string[]>(row['tags'] as string, []),
    metadata: jsonParse<Record<string, unknown>>(row['metadata'] as string, {}),
    content_hash: row['content_hash'] as string,
    created_at: row['created_at'] as string,
    updated_at: row['updated_at'] as string,
  };
}

export function rowToChunk(row: Record<string, unknown>): ChunkRecord {
  return {
    id: row['id'] as number,
    document_id: row['document_id'] as number,
    chunk_index: row['chunk_index'] as number,
    text: row['text'] as string,
    char_count: row['char_count'] as number,
    token_count: row['token_count'] as number,
    created_at: row['created_at'] as string,
  };
}

export function getDocument(db: RagDb, id: number): DocumentRecord | null {
  const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToDocument(row) : null;
}

export function getChunks(db: RagDb, documentId: number): ChunkRecord[] {
  const rows = db
    .prepare('SELECT * FROM chunks WHERE document_id = ? ORDER BY chunk_index')
    .all(documentId) as Record<string, unknown>[];
  return rows.map(rowToChunk);
}

export function listDocuments(
  db: RagDb,
  args: { collection?: string; limit?: number; offset?: number } = {},
): { documents: DocumentRecord[]; total: number } {
  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (args.collection) {
    conditions.push('collection = ?');
    params.push(args.collection);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM documents ${where}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(`SELECT * FROM documents ${where} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as Record<string, unknown>[];
  return { documents: rows.map(rowToDocument), total };
}

export function deleteDocument(db: RagDb, id: number): boolean {
  // chunks/embeddings cascade via FK, but the vec0 ANN index is not FK-linked — capture the
  // chunk ids first and remove them from the index explicitly.
  const chunkIds = db
    .prepare('SELECT id FROM chunks WHERE document_id = ?')
    .all(id) as Array<{ id: number }>;
  const deleted = db.prepare('DELETE FROM documents WHERE id = ?').run(id).changes > 0;
  if (deleted) for (const c of chunkIds) vecDelete(db, c.id);
  return deleted;
}

export function rebuildFts(db: RagDb): number {
  db.prepare('DELETE FROM chunks_fts').run();
  const info = db.prepare(
    `INSERT INTO chunks_fts(rowid, title, source, collection, tags, text)
     SELECT c.id, d.title, d.source, d.collection, d.tags, c.text
     FROM chunks c JOIN documents d ON d.id = c.document_id`,
  ).run();
  return info.changes;
}

export function getStats(db: RagDb): RagStats {
  const documents = (db.prepare('SELECT COUNT(*) AS n FROM documents').get() as { n: number }).n;
  const chunks = (db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n;
  const embeddings = (db.prepare('SELECT COUNT(*) AS n FROM embeddings').get() as { n: number }).n;
  const collections = db
    .prepare(
      `SELECT d.collection, COUNT(DISTINCT d.id) AS documents, COUNT(c.id) AS chunks
       FROM documents d LEFT JOIN chunks c ON c.document_id = d.id
       GROUP BY d.collection ORDER BY d.collection`,
    )
    .all() as Array<{ collection: string; documents: number; chunks: number }>;
  const embedding_models = db
    .prepare(
      `SELECT provider, model, dimension, COUNT(*) AS count
       FROM embeddings GROUP BY provider, model, dimension ORDER BY count DESC`,
    )
    .all() as Array<{ provider: string; model: string; dimension: number; count: number }>;

  const available = isVecAvailable(db);
  const dim = readVecDim(db);
  const indexed =
    available && dim !== null
      ? (db.prepare('SELECT COUNT(*) AS n FROM vec_chunks').get() as { n: number }).n
      : 0;
  const vector_index = {
    backend: (available ? 'sqlite-vec' : 'js') as 'sqlite-vec' | 'js',
    available,
    dimension: dim,
    indexed,
  };

  return { documents, chunks, embeddings, collections, embedding_models, vector_index };
}

export function vectorToBlob(vector: number[]): Buffer {
  const floats = new Float32Array(vector);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
}

export function blobToVector(blob: Buffer): number[] {
  const copy = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
  return Array.from(new Float32Array(copy));
}
