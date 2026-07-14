# claude-memory-rag (local-rag-mcp)

> Pure SQLite hybrid RAG for AI coding agents. FTS5 plus optional local Ollama embeddings. No graph layer, no cloud dependency, one portable database file.

[![CI](https://github.com/Gilligan-Tech-Inc/local-rag-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Gilligan-Tech-Inc/local-rag-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@gilligantechinc/claude-memory-rag.svg)](https://www.npmjs.com/package/@gilligantechinc/claude-memory-rag)
[![npm downloads](https://img.shields.io/npm/dm/@gilligantechinc/claude-memory-rag.svg)](https://www.npmjs.com/package/@gilligantechinc/claude-memory-rag)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Built with TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)

**`@gilligantechinc/claude-memory-rag`** (CLI: `local-rag-mcp`, formerly
`@gilligan-tech/local-rag-mcp`) gives Claude, Codex, and VS Code MCP clients a small local
knowledge base: documents, chunks, full-text search, optional vector search, and cited
retrieval results.

It intentionally does **not** implement a graph:

- no graph database
- no edge table
- no entity graph
- no relationship traversal
- no hidden hosted service

## Install

Install globally:

```bash
npm install -g @gilligantechinc/claude-memory-rag
local-rag-mcp init
```

> The CLI binary is `local-rag-mcp` (a `claude-memory-rag` alias is also installed).

## Quick Start

```bash
local-rag-mcp init
local-rag-mcp ingest ./README.md --collection project
local-rag-mcp search "how do I configure this"
local-rag-mcp doctor
```

Search always works through SQLite FTS5. If Ollama is running locally and the embedding
model is available, ingest/search also use vector similarity.

```bash
ollama pull nomic-embed-text
```

## MCP Tools

| Tool | Purpose |
|------|---------|
| `rag_ingest_text` | Add text directly to the local RAG database |
| `rag_ingest_file` | Ingest `.md`, `.txt`, `.json`, or `.pdf` files |
| `rag_search` | Search with keyword, vector, or hybrid retrieval |
| `rag_get_document` | Fetch a document and its chunks |
| `rag_list_documents` | Page through ingested documents |
| `rag_delete_document` | Delete a document and its chunks/embeddings |
| `rag_reindex` | Rebuild the FTS and vector indexes, optionally filling missing embeddings |
| `rag_stats` | Show database, embedding, and vector-index status |

Ingest supports `.md`, `.txt`, `.json`, and `.pdf` (text is extracted from PDFs with
[unpdf](https://github.com/unjs/unpdf) — pure JS, no native build; scanned/image-only PDFs
have no extractable text).

## How retrieval works

Hybrid search fuses two result lists — SQLite FTS5/BM25 keyword hits and cosine-similarity
vector hits — with **Reciprocal Rank Fusion (RRF)**. RRF combines the *ranks* of each list
rather than their raw scores, so bm25 distances and cosine similarities (which live on
different, incomparable scales) never need an arbitrary weighting knob. When embeddings are
unavailable, search cleanly falls back to keyword-only.

Every result carries `score_parts` (`lexical`, `vector`, `final`) so the ranking is
transparent and auditable.

### Embedding consistency

Vectors are only comparable when they come from the same model (hence the same dimension).
If you change `LOCAL_RAG_EMBED_MODEL`, the database can end up mixing dimensions:

- `rag_stats` reports every distinct `embedding_models` signature present.
- Ingest warns the moment a mixed-dimension database is created.
- Search skips vectors whose dimension doesn't match the current model (instead of silently
  scoring them zero) and tells you.

To rebuild everything under one model, run `rag_reindex` with embeddings enabled.

### Scalable vector search (optional sqlite-vec, automatic fallback)

Vector search uses an approximate-nearest-neighbour index via
[`sqlite-vec`](https://github.com/asg017/sqlite-vec) when it's available, so retrieval scales
to large corpora instead of scanning every embedding in Node. `sqlite-vec` is an
**optional dependency** (prebuilt binaries, no compile): if it can't load on your platform,
the server transparently falls back to the pure-JS cosine scan — same results, just slower on
big collections. The two backends use the same cosine metric, so ranking is identical.

- `rag_stats.vector_index` reports the active `backend` (`sqlite-vec` or `js`) and how many
  vectors are indexed; `local-rag-mcp doctor` shows the same.
- Set `LOCAL_RAG_DISABLE_VEC=1` to force the JS path (useful for parity checks).
- The ANN index is single-dimension (one embedding model per database — see *Embedding
  consistency* above). `rag_reindex` rebuilds it.

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `LOCAL_RAG_DB` | `~/.local-rag-mcp/rag.db` | SQLite database path |
| `LOCAL_RAG_OLLAMA_URL` | `http://127.0.0.1:11434` | Local Ollama API URL |
| `LOCAL_RAG_EMBED_MODEL` | `nomic-embed-text` | Ollama embedding model |
| `LOCAL_RAG_DISABLE_EMBEDDINGS` | unset | Set `1` to force keyword-only mode |
| `LOCAL_RAG_DISABLE_VEC` | unset | Set `1` to force the pure-JS vector path (skip sqlite-vec) |

## Claude Desktop / Claude Code

After global install, use the CLI as the MCP stdio command:

```json
{
  "mcpServers": {
    "local-rag": {
      "command": "local-rag-mcp",
      "env": {
        "LOCAL_RAG_DB": "/absolute/path/to/rag.db"
      }
    }
  }
}
```

## Codex / VS Code MCP Clients

Use the same command:

```text
local-rag-mcp
```

The server uses stdio by default, so it fits MCP hosts that launch local tools.

## local-rag-mcp vs claude-memory

| Package | Use for |
|---------|---------|
| `@gilligantechinc/claude-memory` | Persistent project memory, rules, decisions, preferences; keyword-only FTS5 |
| `@gilligantechinc/claude-memory-rag` | Document/chunk knowledge base with hybrid keyword/vector retrieval |

They are siblings in the same family, not replacements. Keep durable agent instructions in
[`@gilligantechinc/claude-memory`](https://github.com/Gilligan-Tech-Inc/claude-memory); put
larger reference docs, transcripts, specs, and knowledge-base material here.

## Development

```bash
npm install
npm run build
npm run lint
npm test
npm pack
```

## License

Apache-2.0. Copyright Gilligan Tech Inc.
