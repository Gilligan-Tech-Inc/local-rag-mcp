# Contributing to claude-memory-rag (local-rag-mcp)

Thanks for your interest in improving this project — a pure-SQLite hybrid RAG MCP server
for AI coding agents. Contributions that make retrieval better, keep the dependency
surface small, or improve docs and install ergonomics are especially welcome.

## Scope

This project is a **local document/knowledge-base RAG** server: FTS5 keyword search plus
optional local Ollama vector embeddings, in one portable SQLite file. It intentionally has
**no graph layer, no edges, no hosted service**. Short, authoritative project memory
(rules, decisions, preferences) belongs in its sibling,
[`@gilligantechinc/claude-memory`](https://github.com/Gilligan-Tech-Inc/claude-memory).
Please open an issue before a large feature so we can confirm it fits the scope.

## Development setup

```bash
git clone https://github.com/Gilligan-Tech-Inc/local-rag-mcp.git
cd local-rag-mcp
npm install
npm run build
npm test
```

Requires Node.js 22 or 24. Vector features additionally require a local
[Ollama](https://ollama.com) with an embedding model (`ollama pull nomic-embed-text`);
tests mock Ollama, so you do **not** need it installed to run the suite.

- `npm run build` — compile TypeScript to `dist/`
- `npm run lint` — type-check with no emit
- `npm test` — build, then run the `node --test` suite against a throwaway database
- `npm run dev` — run the CLI/server from source with `tsx`

## Pull requests

1. Fork and create a branch from `main`.
2. Make your change with tests. All new behavior needs a test.
3. Ensure `npm run build`, `npm run lint`, and `npm test` all pass.
4. Add a `CHANGELOG.md` entry under **Unreleased**.
5. Open the PR and fill in the template. CI runs on Node 22 and 24 across Linux,
   macOS, and Windows — it must be green before merge.

## Style

- TypeScript, `strict` mode, no `any` unless truly unavoidable.
- Every SQL statement is a prepared statement with bound parameters.
- Keep the retrieval path honest: results carry document/source/score context for cited use.

## Reporting bugs

Use the issue templates. For anything security-sensitive, see [SECURITY.md](SECURITY.md)
and report privately instead of opening a public issue.

By contributing, you agree that your contributions are licensed under the project's
[Apache-2.0 License](LICENSE).
