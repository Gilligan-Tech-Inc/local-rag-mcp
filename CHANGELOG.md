# Changelog

All notable changes to `@gilligantechinc/claude-memory-rag` (formerly
`@gilligan-tech/local-rag-mcp`) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0]

### Added
- **Scalable vector search via [`sqlite-vec`](https://github.com/asg017/sqlite-vec)** — an
  approximate-nearest-neighbour index replaces the O(n) in-Node cosine scan for large corpora.
  It's an **optional dependency**: if the extension can't load on your platform, search falls
  back transparently to the pure-JS cosine path with identical results (both use cosine, so
  ranking matches). `LOCAL_RAG_DISABLE_VEC=1` forces the JS path.
- **PDF ingest** — `rag_ingest_file` and the `ingest` CLI now accept `.pdf` (text extracted with
  [unpdf](https://github.com/unjs/unpdf), a pure-JS/no-native dependency).
- `rag_stats` / `doctor` report `vector_index` (`backend`, `available`, `dimension`, `indexed`).

### Changed
- `rag_reindex` now rebuilds the vector index alongside the FTS index.

## [0.2.0]

### Changed
- **Renamed the npm package to `@gilligantechinc/claude-memory-rag`** so it sits in the
  same scope and product family as `@gilligantechinc/claude-memory`. The old package
  `@gilligan-tech/local-rag-mcp` is deprecated with a pointer to the new name.
- The `local-rag-mcp` CLI binary name is retained; a `claude-memory-rag` binary alias
  was added.
- The MCP server now reports its version from `package.json` instead of a hardcoded
  string.

### Added
- Embedding-consistency guard: `rag_stats` now reports every distinct `embedding_models`
  signature; ingest warns when a mixed-dimension database is created; and vector search
  skips vectors whose dimension doesn't match the current model (instead of silently scoring
  them zero) and says so in the result `warning`.
- Continuous integration (GitHub Actions) building, type-checking, and testing on
  Node 22 and 24 across Linux, macOS, and Windows.
- Community health files: `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`,
  issue forms, and a pull-request template.
- Test covering the dimension guard end-to-end.

### Changed
- Hybrid search now fuses keyword and vector results with **Reciprocal Rank Fusion**
  instead of an unnormalized `0.55/0.45` weighted blend of scores on incomparable scales.

## [0.1.1] - 2026-06 (as `@gilligan-tech/local-rag-mcp`)

### Changed
- Adopted a publishable npm scope; updated the repository URL to GitHub.

## [0.1.0] - 2026-06 (as `@gilligan-tech/local-rag-mcp`)

### Added
- Initial release: pure SQLite hybrid RAG MCP server. FTS5 keyword search plus optional
  local Ollama vector embeddings, with graceful keyword-only fallback. Tools:
  `rag_ingest_text`, `rag_ingest_file`, `rag_search`, `rag_get_document`,
  `rag_list_documents`, `rag_delete_document`, `rag_reindex`, `rag_stats`. CLI with
  `init`, `ingest`, `search`, `stats`, and `doctor`.

[Unreleased]: https://github.com/Gilligan-Tech-Inc/local-rag-mcp/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/Gilligan-Tech-Inc/local-rag-mcp/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Gilligan-Tech-Inc/local-rag-mcp/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/Gilligan-Tech-Inc/local-rag-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Gilligan-Tech-Inc/local-rag-mcp/releases/tag/v0.1.0
