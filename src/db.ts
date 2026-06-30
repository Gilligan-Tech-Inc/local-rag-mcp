import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { ensureDbDir, getDbPath } from './config.js';
import type { ChunkRecord, DocumentRecord, RagStats } from './types.js';

export type RagDb = Database.Database;

export function openDb(path = getDbPath()): RagDb {
  ensureDbDir(path);
  const db = new Database(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
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
  return db.prepare('DELETE FROM documents WHERE id = ?').run(id).changes > 0;
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
  return { documents, chunks, embeddings, collections };
}

export function vectorToBlob(vector: number[]): Buffer {
  const floats = new Float32Array(vector);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
}

export function blobToVector(blob: Buffer): number[] {
  const copy = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
  return Array.from(new Float32Array(copy));
}
