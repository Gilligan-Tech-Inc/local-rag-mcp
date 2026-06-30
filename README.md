# local-rag-mcp

> Pure SQLite hybrid RAG for AI coding agents. FTS5 plus optional local Ollama embeddings. No graph layer, no cloud dependency, one portable database file.

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Built with TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)

`local-rag-mcp` gives Claude, Codex, and VS Code MCP clients a small local knowledge base:
documents, chunks, full-text search, optional vector search, and cited retrieval results.

It intentionally does **not** implement a graph:

- no graph database
- no edge table
- no entity graph
- no relationship traversal
- no hidden hosted service

## Install

Use directly with MCP clients:

```json
{
  "mcpServers": {
    "local-rag": {
      "command": "npx",
      "args": ["-y", "@gilligan-tech.inc/local-rag-mcp"]
    }
  }
}
```

Or install globally for faster startup:

```bash
npm install -g @gilligan-tech.inc/local-rag-mcp
local-rag-mcp init
```

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
| `rag_ingest_file` | Ingest `.md`, `.txt`, or `.json` files |
| `rag_search` | Search with keyword, vector, or hybrid retrieval |
| `rag_get_document` | Fetch a document and its chunks |
| `rag_list_documents` | Page through ingested documents |
| `rag_delete_document` | Delete a document and its chunks/embeddings |
| `rag_reindex` | Rebuild FTS and optionally fill missing embeddings |
| `rag_stats` | Show database and embedding status |

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `LOCAL_RAG_DB` | `~/.local-rag-mcp/rag.db` | SQLite database path |
| `LOCAL_RAG_OLLAMA_URL` | `http://127.0.0.1:11434` | Local Ollama API URL |
| `LOCAL_RAG_EMBED_MODEL` | `nomic-embed-text` | Ollama embedding model |
| `LOCAL_RAG_DISABLE_EMBEDDINGS` | unset | Set `1` to force keyword-only mode |

## Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "local-rag": {
      "command": "npx",
      "args": ["-y", "@gilligan-tech.inc/local-rag-mcp"],
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
npx -y @gilligan-tech.inc/local-rag-mcp
```

The server uses stdio by default, so it fits MCP hosts that launch local tools.

## local-rag-mcp vs claude-memory

| Package | Use for |
|---------|---------|
| `@gilligan-tech.inc/claude-memory` | Persistent project memory, rules, decisions, preferences; keyword-only FTS5 |
| `@gilligan-tech.inc/local-rag-mcp` | Document/chunk knowledge base with hybrid keyword/vector retrieval |

They are siblings, not replacements. Keep durable agent instructions in `claude-memory`;
put larger reference docs, transcripts, specs, and knowledge-base material in `local-rag-mcp`.

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
