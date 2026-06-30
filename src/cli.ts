#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openDb } from './db.js';
import { getDbPath } from './config.js';
import { checkOllama } from './embeddings.js';
import { ingestFile } from './ingest.js';
import { search } from './search.js';
import { buildServer } from './server.js';
import { getStats } from './db.js';

function takeFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  args.splice(idx, value ? 2 : 1);
  return value;
}

function takeTags(args: string[]): string[] {
  const tags: string[] = [];
  let idx = args.indexOf('--tag');
  while (idx !== -1) {
    const value = args[idx + 1];
    if (value) tags.push(value);
    args.splice(idx, value ? 2 : 1);
    idx = args.indexOf('--tag');
  }
  return tags;
}

function help(): void {
  console.log(`local-rag-mcp

Usage:
  local-rag-mcp                 Start MCP stdio server
  local-rag-mcp serve           Start MCP stdio server
  local-rag-mcp init            Create/open the SQLite database
  local-rag-mcp ingest <path>   Ingest .md, .txt, or .json
  local-rag-mcp search <query>  Search the local RAG database
  local-rag-mcp stats           Show database stats
  local-rag-mcp doctor          Check database and Ollama status

Options:
  --collection <name>           Collection name (default: default)
  --tag <tag>                   Repeatable tag for ingest
  --limit <n>                   Search result limit

Environment:
  LOCAL_RAG_DB                  Default: ~/.local-rag-mcp/rag.db
  LOCAL_RAG_OLLAMA_URL          Default: http://127.0.0.1:11434
  LOCAL_RAG_EMBED_MODEL         Default: nomic-embed-text
  LOCAL_RAG_DISABLE_EMBEDDINGS  Set 1 to force keyword-only mode
`);
}

async function serve(): Promise<void> {
  const db = openDb();
  const server = buildServer(db);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args.shift() ?? 'serve';

  if (command === 'serve') return serve();
  if (command === '--help' || command === '-h' || command === 'help') {
    help();
    return;
  }

  const db = openDb();

  if (command === 'init') {
    console.log(JSON.stringify({ ok: true, db: getDbPath() }, null, 2));
    return;
  }

  if (command === 'doctor') {
    console.log(JSON.stringify({ db: getDbPath(), stats: getStats(db), embeddings: await checkOllama() }, null, 2));
    return;
  }

  if (command === 'stats') {
    console.log(JSON.stringify(getStats(db), null, 2));
    return;
  }

  if (command === 'ingest') {
    const path = args.shift();
    if (!path) throw new Error('ingest requires a path');
    const collection = takeFlag(args, '--collection') ?? 'default';
    const tags = takeTags(args);
    console.log(JSON.stringify(await ingestFile(db, path, { collection, tags }), null, 2));
    return;
  }

  if (command === 'search') {
    const collection = takeFlag(args, '--collection');
    const limitRaw = takeFlag(args, '--limit');
    const limit = limitRaw ? Number(limitRaw) : 10;
    const query = args.join(' ').trim();
    if (!query) throw new Error('search requires a query');
    console.log(JSON.stringify(await search(db, { query, collection, limit }), null, 2));
    return;
  }

  throw new Error(`Unknown command "${command}". Run local-rag-mcp --help.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
