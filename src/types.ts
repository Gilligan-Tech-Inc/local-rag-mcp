export type SearchMode = 'keyword' | 'vector' | 'hybrid';
export type ActualSearchMode = 'keyword' | 'vector' | 'hybrid';

export interface DocumentRecord {
  id: number;
  title: string;
  source: string;
  collection: string;
  tags: string[];
  metadata: Record<string, unknown>;
  content_hash: string;
  created_at: string;
  updated_at: string;
}

export interface ChunkRecord {
  id: number;
  document_id: number;
  chunk_index: number;
  text: string;
  char_count: number;
  token_count: number;
  created_at: string;
}

export interface SearchHit {
  document: Pick<DocumentRecord, 'id' | 'title' | 'source' | 'collection' | 'tags'>;
  chunk: Pick<ChunkRecord, 'id' | 'chunk_index' | 'text'> & { snippet: string };
  score: number;
  score_parts: {
    lexical: number | null;
    vector: number | null;
    final: number;
  };
}

export interface SearchResult {
  query: string;
  requested_mode: SearchMode;
  mode_used: ActualSearchMode;
  warning: string | null;
  results: SearchHit[];
}

export interface IngestResult {
  document: DocumentRecord;
  chunks: number;
  embeddings: number;
  warning: string | null;
}

export interface RagStats {
  documents: number;
  chunks: number;
  embeddings: number;
  collections: Array<{ collection: string; documents: number; chunks: number }>;
}
