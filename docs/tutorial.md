# Local RAG MCP Tutorial

`local-rag-mcp` is a local hybrid RAG server for AI coding agents. It stores everything in
one SQLite file and exposes retrieval through MCP.

## 1. Install

```bash
npm install -g @gilligantechinc/claude-memory-rag
local-rag-mcp init
```

## 2. Add Documents

```bash
local-rag-mcp ingest ./docs/architecture.md --collection my-app
local-rag-mcp ingest ./notes/customer-call.md --collection calls --tag transcript
local-rag-mcp ingest ./contracts/master-agreement.pdf --collection legal
```

Supported file types:

- `.md`
- `.txt`
- `.json`
- `.pdf` (text is extracted automatically; scanned/image-only PDFs have no extractable text)

## 3. Search Locally

```bash
local-rag-mcp search "deployment rules for production"
```

If Ollama is available, search combines FTS5 keyword retrieval with vector similarity
(fused with Reciprocal Rank Fusion). When the optional `sqlite-vec` extension is present,
vector search uses a scalable ANN index; otherwise it falls back to an in-Node cosine scan
with identical results. If Ollama is not available, the same command falls back to keyword
search and returns a warning. Run `local-rag-mcp doctor` to see the active vector backend.

## 4. Use With Claude, Codex, Or VS Code

Add this MCP server block:

```json
{
  "mcpServers": {
    "local-rag": {
      "command": "local-rag-mcp"
    }
  }
}
```

Then ask your agent:

> Search my local RAG for the deployment notes.

The agent should call `rag_search` and return cited chunks.

## 5. Optional Ollama Embeddings

```bash
ollama pull nomic-embed-text
local-rag-mcp doctor
```

To force keyword-only mode:

```bash
LOCAL_RAG_DISABLE_EMBEDDINGS=1 local-rag-mcp search "auth notes"
```

## Design Boundary

This project is intentionally not a graph system. There are no edges, nodes, entity
relationships, graph traversal, or relationship maps. It is documents, chunks, FTS5,
optional vectors, and ranked retrieval.
