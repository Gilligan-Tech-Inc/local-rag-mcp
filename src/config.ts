import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';

export const DEFAULT_DB_PATH = join(homedir(), '.local-rag-mcp', 'rag.db');
export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
export const DEFAULT_EMBED_MODEL = 'nomic-embed-text';

export function getDbPath(): string {
  return process.env['LOCAL_RAG_DB'] || DEFAULT_DB_PATH;
}

export function ensureDbDir(path = getDbPath()): void {
  mkdirSync(dirname(path), { recursive: true });
}

export function getOllamaUrl(): string {
  return (process.env['LOCAL_RAG_OLLAMA_URL'] || DEFAULT_OLLAMA_URL).replace(/\/+$/, '');
}

export function getEmbedModel(): string {
  return process.env['LOCAL_RAG_EMBED_MODEL'] || DEFAULT_EMBED_MODEL;
}

export function embeddingsDisabled(): boolean {
  return process.env['LOCAL_RAG_DISABLE_EMBEDDINGS'] === '1';
}
