import { embeddingsDisabled, getEmbedModel, getOllamaUrl } from './config.js';

export interface EmbedConfig {
  provider: 'ollama';
  model: string;
  url: string;
}

export interface EmbedStatus {
  available: boolean;
  provider: 'ollama';
  model: string;
  url: string;
  warning: string | null;
}

export function getEmbedConfig(): EmbedConfig {
  return {
    provider: 'ollama',
    model: getEmbedModel(),
    url: getOllamaUrl(),
  };
}

export async function checkOllama(): Promise<EmbedStatus> {
  const cfg = getEmbedConfig();
  if (embeddingsDisabled()) {
    return { ...cfg, available: false, warning: 'Embeddings disabled by LOCAL_RAG_DISABLE_EMBEDDINGS=1.' };
  }

  try {
    const res = await fetch(`${cfg.url}/api/tags`, { method: 'GET' });
    if (!res.ok) {
      return { ...cfg, available: false, warning: `Ollama responded HTTP ${res.status}.` };
    }
    return { ...cfg, available: true, warning: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return { ...cfg, available: false, warning: `Ollama unavailable at ${cfg.url}: ${message}` };
  }
}

export async function embedText(text: string): Promise<number[]> {
  if (embeddingsDisabled()) {
    throw new Error('Embeddings disabled by LOCAL_RAG_DISABLE_EMBEDDINGS=1.');
  }

  const cfg = getEmbedConfig();
  const res = await fetch(`${cfg.url}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ model: cfg.model, prompt: text }),
  });

  if (!res.ok) {
    throw new Error(`Ollama embeddings failed: HTTP ${res.status}`);
  }

  const data = (await res.json()) as { embedding?: unknown };
  if (!Array.isArray(data.embedding) || data.embedding.some((v) => typeof v !== 'number')) {
    throw new Error('Ollama embeddings response did not contain a numeric embedding array.');
  }

  return data.embedding as number[];
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let a2 = 0;
  let b2 = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    a2 += av * av;
    b2 += bv * bv;
  }
  if (a2 === 0 || b2 === 0) return 0;
  return dot / (Math.sqrt(a2) * Math.sqrt(b2));
}
