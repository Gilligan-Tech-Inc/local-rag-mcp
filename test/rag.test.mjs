import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function withTempDb(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'local-rag-mcp-'));
  const dbPath = join(dir, 'rag.db');
  process.env.LOCAL_RAG_DB = dbPath;
  process.env.LOCAL_RAG_DISABLE_EMBEDDINGS = '1';
  try {
    return await fn({ dir, dbPath });
  } finally {
    delete process.env.LOCAL_RAG_DB;
    delete process.env.LOCAL_RAG_DISABLE_EMBEDDINGS;
    delete process.env.LOCAL_RAG_OLLAMA_URL;
    await rm(dir, { recursive: true, force: true });
  }
}

test('schema migration creates pure SQLite RAG tables and no graph tables', async () => {
  await withTempDb(async () => {
    const { openDb } = await import('../dist/db.js');
    const db = openDb();
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name").all();
    const names = rows.map((r) => r.name);
    assert.ok(names.includes('documents'));
    assert.ok(names.includes('chunks'));
    assert.ok(names.includes('chunks_fts'));
    assert.ok(names.includes('embeddings'));
    assert.ok(names.includes('settings'));
    assert.equal(names.some((name) => /edge|graph|node/i.test(name)), false);
    db.close();
  });
});

test('ingest text creates document chunks and keyword fallback search works', async () => {
  await withTempDb(async () => {
    const { openDb } = await import('../dist/db.js');
    const { ingestText } = await import('../dist/ingest.js');
    const { search } = await import('../dist/search.js');
    const db = openDb();
    const ingested = await ingestText(db, {
      title: 'Baikal action notes',
      text: 'Maya will import the generated ICS file into Baikal by Friday. Jonas verifies owner names.',
      collection: 'demo',
    });
    assert.equal(ingested.chunks, 1);
    assert.equal(ingested.embeddings, 0);
    assert.match(ingested.warning ?? '', /disabled/i);

    const result = await search(db, { query: 'Baikal owner names', collection: 'demo', mode: 'hybrid' });
    assert.equal(result.mode_used, 'keyword');
    assert.equal(result.results.length, 1);
    assert.match(result.results[0].chunk.text, /Baikal/);
    db.close();
  });
});

test('mocked Ollama embeddings are stored and hybrid search returns vector score', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'nomic-embed-text' }] }));
      return;
    }
    if (req.url === '/api/embeddings') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const input = JSON.parse(body).prompt || '';
        const seed = input.includes('Baikal') ? 1 : 0.5;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ embedding: [seed, 0.25, 0.75] }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    await withTempDb(async () => {
      delete process.env.LOCAL_RAG_DISABLE_EMBEDDINGS;
      process.env.LOCAL_RAG_OLLAMA_URL = `http://127.0.0.1:${port}`;
      const { openDb } = await import('../dist/db.js');
      const { ingestText } = await import('../dist/ingest.js');
      const { search } = await import('../dist/search.js');
      const db = openDb();
      const ingested = await ingestText(db, {
        title: 'Baikal action notes',
        text: 'Maya will import the generated ICS file into Baikal by Friday.',
      });
      assert.equal(ingested.embeddings, 1);

      const result = await search(db, { query: 'Baikal import', mode: 'hybrid' });
      assert.equal(result.mode_used, 'hybrid');
      assert.equal(result.results[0].score_parts.vector > 0, true);
      db.close();
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('delete removes document chunks embeddings and fts rows', async () => {
  await withTempDb(async () => {
    const { openDb, deleteDocument, getStats } = await import('../dist/db.js');
    const { ingestText } = await import('../dist/ingest.js');
    const db = openDb();
    const ingested = await ingestText(db, { title: 'Delete me', text: 'temporary searchable content' });
    assert.equal(deleteDocument(db, ingested.document.id), true);
    const stats = getStats(db);
    assert.equal(stats.documents, 0);
    assert.equal(stats.chunks, 0);
    assert.equal(stats.embeddings, 0);
    const ftsRows = db.prepare('SELECT COUNT(*) AS n FROM chunks_fts').get().n;
    assert.equal(ftsRows, 0);
    db.close();
  });
});

test('cli init ingest search stats and doctor work without Ollama', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'local-rag-cli-'));
  const dbPath = join(dir, 'rag.db');
  const docPath = join(dir, 'doc.md');
  await writeFile(docPath, '# Demo\n\nBaikal calendar tasks belong in local RAG.');
  const env = { ...process.env, LOCAL_RAG_DB: dbPath, LOCAL_RAG_DISABLE_EMBEDDINGS: '1' };

  try {
    for (const args of [
      ['dist/cli.js', 'init'],
      ['dist/cli.js', 'ingest', docPath],
      ['dist/cli.js', 'search', 'Baikal calendar'],
      ['dist/cli.js', 'stats'],
      ['dist/cli.js', 'doctor'],
    ]) {
      const res = spawnSync(process.execPath, args, { cwd: process.cwd(), env, encoding: 'utf8' });
      assert.equal(res.status, 0, `${args.join(' ')} failed: ${res.stderr}`);
      assert.match(res.stdout, /\{[\s\S]*\}/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('mcp stdio smoke ingests searches and gets documents', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'local-rag-mcp-stdio-'));
  const dbPath = join(dir, 'rag.db');
  const env = { ...process.env, LOCAL_RAG_DB: dbPath, LOCAL_RAG_DISABLE_EMBEDDINGS: '1' };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/cli.js', 'serve'],
    cwd: process.cwd(),
    env,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'local-rag-mcp-smoke', version: '0.0.0' }, { capabilities: {} });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);
    assert.ok(toolNames.includes('rag_ingest_text'));
    assert.ok(toolNames.includes('rag_search'));
    assert.ok(toolNames.includes('rag_get_document'));

    const ingest = await client.callTool({
      name: 'rag_ingest_text',
      arguments: {
        title: 'MCP smoke',
        text: 'Baikal MCP smoke searchable action item for Claude and Codex.',
        collection: 'smoke',
      },
    });
    const ingested = JSON.parse(ingest.content[0].text);
    assert.equal(ingested.document.title, 'MCP smoke');

    const searchResult = await client.callTool({
      name: 'rag_search',
      arguments: { query: 'Baikal smoke action', collection: 'smoke' },
    });
    const searchBody = JSON.parse(searchResult.content[0].text);
    assert.equal(searchBody.mode_used, 'keyword');
    assert.match(searchBody.results[0].chunk.text, /Baikal MCP smoke/);

    const docResult = await client.callTool({
      name: 'rag_get_document',
      arguments: { id: ingested.document.id },
    });
    const docBody = JSON.parse(docResult.content[0].text);
    assert.equal(docBody.document.title, 'MCP smoke');
    assert.equal(docBody.chunks.length, 1);
  } finally {
    await client.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
