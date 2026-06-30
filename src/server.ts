import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RagDb } from './db.js';
import { deleteDocument, getChunks, getDocument, getStats, listDocuments, rebuildFts } from './db.js';
import { checkOllama } from './embeddings.js';
import { embedChunksBestEffort, ingestFile, ingestText } from './ingest.js';
import { search } from './search.js';

function jsonText(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

export function buildServer(db: RagDb): McpServer {
  const server = new McpServer(
    { name: 'local-rag-mcp', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'local-rag-mcp is a pure SQLite hybrid RAG knowledge base for AI coding agents. ' +
        'Use rag_ingest_text or rag_ingest_file to add documents. Use rag_search to retrieve cited chunks. ' +
        'Search uses SQLite FTS5 and, when local Ollama embeddings are available, vector similarity. ' +
        'If embeddings are unavailable, search falls back cleanly to keyword search. ' +
        'This server intentionally has no graph layer, no edges, and no relationship traversal.',
    },
  );

  server.registerTool(
    'rag_ingest_text',
    {
      title: 'Ingest text into local RAG',
      description: 'Add a text document to the local SQLite RAG database and chunk it for retrieval.',
      inputSchema: {
        title: z.string().min(1).max(300),
        text: z.string().min(1).max(2_000_000),
        source: z.string().max(1000).default(''),
        collection: z.string().max(128).default('default'),
        tags: z.array(z.string().max(64)).max(30).default([]),
        metadata: z.record(z.unknown()).default({}),
      },
    },
    async (args) => jsonText(await ingestText(db, args)),
  );

  server.registerTool(
    'rag_ingest_file',
    {
      title: 'Ingest a local file into local RAG',
      description: 'Add a local .md, .txt, or .json file to the SQLite RAG database.',
      inputSchema: {
        path: z.string().min(1).max(2000),
        title: z.string().max(300).optional(),
        collection: z.string().max(128).default('default'),
        tags: z.array(z.string().max(64)).max(30).default([]),
        metadata: z.record(z.unknown()).default({}),
      },
    },
    async (args) => jsonText(await ingestFile(db, args.path, args)),
  );

  server.registerTool(
    'rag_search',
    {
      title: 'Search local RAG',
      description: 'Search documents with hybrid FTS5 + optional local vector retrieval.',
      inputSchema: {
        query: z.string().min(1).max(1000),
        mode: z.enum(['keyword', 'vector', 'hybrid']).default('hybrid'),
        collection: z.string().max(128).optional(),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async (args) => jsonText(await search(db, args)),
  );

  server.registerTool(
    'rag_get_document',
    {
      title: 'Get a local RAG document',
      description: 'Fetch a document and, by default, its chunks.',
      inputSchema: {
        id: z.number().int().positive(),
        include_chunks: z.boolean().default(true),
      },
    },
    async (args) => {
      const document = getDocument(db, args.id);
      if (!document) return jsonText({ error: `Document ${args.id} not found.` });
      return jsonText({ document, chunks: args.include_chunks ? getChunks(db, args.id) : undefined });
    },
  );

  server.registerTool(
    'rag_list_documents',
    {
      title: 'List local RAG documents',
      description: 'List ingested documents, optionally by collection.',
      inputSchema: {
        collection: z.string().max(128).optional(),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      },
    },
    async (args) => jsonText(listDocuments(db, args)),
  );

  server.registerTool(
    'rag_delete_document',
    {
      title: 'Delete a local RAG document',
      description: 'Delete a document and cascade its chunks, FTS rows, and embeddings.',
      inputSchema: {
        id: z.number().int().positive(),
      },
    },
    async (args) => jsonText({ id: args.id, deleted: deleteDocument(db, args.id) }),
  );

  server.registerTool(
    'rag_reindex',
    {
      title: 'Reindex local RAG',
      description: 'Rebuild the SQLite FTS index and optionally fill missing embeddings.',
      inputSchema: {
        embeddings: z.boolean().default(false),
      },
    },
    async (args) => {
      const ftsRows = rebuildFts(db);
      const embed = args.embeddings ? await embedChunksBestEffort(db) : { count: 0, warning: null };
      return jsonText({ fts_rows: ftsRows, embeddings: embed.count, warning: embed.warning });
    },
  );

  server.registerTool(
    'rag_stats',
    {
      title: 'Local RAG stats',
      description: 'Show document, chunk, embedding, collection, and Ollama status.',
      inputSchema: {},
    },
    async () => jsonText({ stats: getStats(db), embeddings: await checkOllama() }),
  );

  return server;
}
