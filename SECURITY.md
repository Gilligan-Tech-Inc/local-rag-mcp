# Security Policy

## Reporting a vulnerability

Please report security issues **privately**. Do not open a public GitHub issue for a
vulnerability.

- Preferred: open a private advisory at
  <https://github.com/Gilligan-Tech-Inc/local-rag-mcp/security/advisories/new>.
- Or email **security@gilligantechinc.com** with details and reproduction steps.

We aim to acknowledge reports within 3 business days and to ship a fix or mitigation
for confirmed issues as quickly as is practical.

## Scope and threat model

claude-memory-rag (local-rag-mcp) is a **local-first** tool. It:

- stores all data in a local SQLite database (default `~/.local-rag-mcp/rag.db`);
- talks only to a **local** Ollama instance (default `http://127.0.0.1:11434`) and only
  when embeddings are enabled — it makes no other network calls and needs no account;
- runs as a stdio MCP subprocess launched by your MCP host (Claude Code / Claude Desktop /
  other MCP clients).

Reports we are most interested in:

- SQL injection or FTS query handling that can read/write outside the intended rows;
- path handling around `LOCAL_RAG_DB` or `rag_ingest_file` paths that could read/write
  outside the intended location;
- SSRF-style issues via `LOCAL_RAG_OLLAMA_URL` if it is pointed at a non-local host;
- any code path that unexpectedly executes shell commands.

## Supported versions

The latest published minor version receives security fixes. Please upgrade before
reporting to confirm the issue still reproduces.
