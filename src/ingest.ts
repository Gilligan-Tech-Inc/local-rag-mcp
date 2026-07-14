import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { RagDb } from './db.js';
import { getDocument, hashContent, vecUpsert, vectorToBlob } from './db.js';
import { chunkText, estimateTokens } from './chunk.js';
import { embedText, getEmbedConfig } from './embeddings.js';
import type { IngestResult } from './types.js';

export interface IngestTextArgs {
  title: string;
  text: string;
  source?: string;
  collection?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  chunkSize?: number;
  overlap?: number;
}

export type IngestFileArgs = Omit<IngestTextArgs, 'text' | 'source'>;

export async function readSupportedFile(path: string): Promise<{ title: string; text: string }> {
  const ext = extname(path).toLowerCase();
  if (ext === '.md' || ext === '.txt') {
    return { title: basename(path), text: await readFile(path, 'utf8') };
  }
  if (ext === '.json') {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    return { title: basename(path), text: JSON.stringify(parsed, null, 2) };
  }
  if (ext === '.pdf') {
    // unpdf (pure-JS, wraps pdfjs) is loaded lazily so the heavy PDF stack only loads when a PDF
    // is actually ingested, keeping normal server/CLI startup fast.
    const buf = await readFile(path);
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await extractText(pdf, { mergePages: true });
    const clean = (Array.isArray(text) ? text.join('\n') : text).replace(/[ \t]+\n/g, '\n').trim();
    if (!clean) {
      throw new Error(
        `No extractable text found in PDF "${basename(path)}" — it may be a scanned/image-only PDF.`,
      );
    }
    return { title: basename(path), text: clean };
  }
  throw new Error(`Unsupported file type "${ext}". Supported: .md, .txt, .json, .pdf.`);
}

export async function ingestFile(
  db: RagDb,
  path: string,
  args: Partial<IngestFileArgs> = {},
): Promise<IngestResult> {
  const file = await readSupportedFile(path);
  return ingestText(db, {
    ...args,
    title: args.title ?? file.title,
    source: path,
    text: file.text,
  });
}

export async function ingestText(db: RagDb, args: IngestTextArgs): Promise<IngestResult> {
  const cleanText = args.text.trim();
  if (!cleanText) throw new Error('Cannot ingest empty text.');

  const pieces = chunkText(cleanText, { chunkSize: args.chunkSize, overlap: args.overlap });
  if (pieces.length === 0) throw new Error('Text produced no chunks.');

  const now = new Date().toISOString();
  const insert = db.transaction(() => {
    const docResult = db
      .prepare(
        `INSERT INTO documents (title, source, collection, tags, metadata, content_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        args.title.trim() || 'Untitled document',
        args.source ?? '',
        args.collection ?? 'default',
        JSON.stringify(args.tags ?? []),
        JSON.stringify(args.metadata ?? {}),
        hashContent(cleanText),
        now,
        now,
      );

    const documentId = Number(docResult.lastInsertRowid);
    const chunkInsert = db.prepare(
      `INSERT INTO chunks (document_id, chunk_index, text, char_count, token_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (let i = 0; i < pieces.length; i++) {
      const text = pieces[i] ?? '';
      chunkInsert.run(documentId, i, text, text.length, estimateTokens(text), now);
    }

    return documentId;
  });

  const documentId = insert();
  const embed = await embedChunksBestEffort(db, documentId);
  const document = getDocument(db, documentId);
  if (!document) throw new Error('Inserted document could not be read back.');

  return {
    document,
    chunks: pieces.length,
    embeddings: embed.count,
    warning: embed.warning,
  };
}

export async function embedChunksBestEffort(
  db: RagDb,
  documentId?: number,
): Promise<{ count: number; warning: string | null }> {
  const cfg = getEmbedConfig();
  const rows = db
    .prepare(
      `SELECT c.id, c.text
       FROM chunks c
       LEFT JOIN embeddings e ON e.chunk_id = c.id
       WHERE e.chunk_id IS NULL ${documentId ? 'AND c.document_id = ?' : ''}
       ORDER BY c.id`,
    )
    .all(...(documentId ? [documentId] : [])) as Array<{ id: number; text: string }>;

  let count = 0;
  let warning: string | null = null;
  const insert = db.prepare(
    `INSERT OR REPLACE INTO embeddings (chunk_id, provider, model, dimension, vector, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  for (const row of rows) {
    try {
      const vector = await embedText(row.text);
      insert.run(row.id, cfg.provider, cfg.model, vector.length, vectorToBlob(vector), new Date().toISOString());
      vecUpsert(db, row.id, vector); // mirror into the sqlite-vec ANN index when available (no-op otherwise)
      count++;
    } catch (err) {
      warning = err instanceof Error ? err.message : 'Embedding failed.';
      break;
    }
  }

  // If embedding succeeded, guard against a silently-mixed database: vectors from different
  // models (hence dimensions) cannot be compared, so warn the moment a mix appears.
  if (!warning) {
    const models = db
      .prepare('SELECT DISTINCT model, dimension FROM embeddings')
      .all() as Array<{ model: string; dimension: number }>;
    if (models.length > 1) {
      warning =
        `This database now holds embeddings from ${models.length} different models ` +
        `(${models.map((m) => `${m.model}:${m.dimension}d`).join(', ')}). Hybrid search only ` +
        `compares matching dimensions — run rag_reindex with embeddings to rebuild everything ` +
        `with the current model.`;
    }
  }

  return { count, warning };
}
