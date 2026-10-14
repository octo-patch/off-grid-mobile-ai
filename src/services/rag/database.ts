import { open } from '@op-engineering/op-sqlite';
import type { DB } from '@op-engineering/op-sqlite';
import type { Chunk } from './chunking';
import logger from '../../utils/logger';
import { generateId } from '../../utils/generateId';

export interface RagDocument {
  id: number;
  sync_id: string;
  project_id: string;
  name: string;
  path: string;
  size: number;
  created_at: string;
  enabled: number;
}

export interface RagSearchResult {
  doc_id: number;
  name: string;
  content: string;
  position: number;
  score: number;
}

interface StoredEmbedding {
  chunk_rowid: number;
  doc_id: number;
  name: string;
  content: string;
  position: number;
  embedding: Float32Array | number[];
}

/** Byte budget for decoded embedding vectors kept between searches; modest so phones stay comfortable. */
const EMBEDDING_CACHE_MAX_BYTES = 16 * 1024 * 1024;

const EMPTY_VECTOR = new Float32Array(0);

/** Realm-safe: a BLOB can arrive as an ArrayBuffer created in another JS realm. */
function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return Object.prototype.toString.call(value) === '[object ArrayBuffer]';
}

function sameIds(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** One document's decoded vectors, aligned with the rag_embeddings ids they were read from (ascending). */
interface DocumentVectors {
  ids: number[];
  vectors: Float32Array[];
  bytes: number;
}

/**
 * Least-recently-used, byte-bounded cache of decoded vectors per document.
 *
 * An entry is only served when its embedding ids match the ids the current search query returned for that
 * document. rag_embeddings rows are only ever inserted or deleted, never updated, and AUTOINCREMENT ids are
 * never reused, so a matching id list means identical vectors even if a write skipped invalidation.
 */
class DocumentVectorCache {
  private entries = new Map<number, DocumentVectors>();
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  get(docId: number): DocumentVectors | undefined {
    const entry = this.entries.get(docId);
    if (!entry) return undefined;
    this.entries.delete(docId);
    this.entries.set(docId, entry);
    return entry;
  }

  set(docId: number, entry: DocumentVectors): void {
    this.delete(docId);
    if (entry.bytes > this.maxBytes) return;
    this.entries.set(docId, entry);
    this.bytes += entry.bytes;
    while (this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.delete(oldest.value);
    }
  }

  delete(docId: number): void {
    const entry = this.entries.get(docId);
    if (!entry) return;
    this.entries.delete(docId);
    this.bytes -= entry.bytes;
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }
}

class RagDatabase {
  private db: DB | null = null;
  private ready = false;
  private vectorCache = new DocumentVectorCache(EMBEDDING_CACHE_MAX_BYTES);

  async ensureReady(): Promise<void> {
    if (this.ready) return;
    try {
      this.db = open({ name: 'rag.db' });
      this.db.executeSync(
        `CREATE TABLE IF NOT EXISTS rag_documents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sync_id TEXT,
          project_id TEXT NOT NULL,
          name TEXT NOT NULL,
          path TEXT NOT NULL,
          size INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1
        )`,
      );
      const columns = this.db.executeSync(
        "SELECT name FROM pragma_table_info('rag_documents')",
      );
      const hasSyncId = (
        (columns.rows ?? []) as unknown as { name: string }[]
      ).some(column => column.name === 'sync_id');
      if (!hasSyncId) {
        this.db.executeSync(
          'ALTER TABLE rag_documents ADD COLUMN sync_id TEXT',
        );
      }
      const legacyDocuments = this.db.executeSync(
        "SELECT id FROM rag_documents WHERE sync_id IS NULL OR sync_id = ''",
      );
      for (const document of (legacyDocuments.rows ?? []) as unknown as {
        id: number;
      }[]) {
        this.db.executeSync(
          'UPDATE rag_documents SET sync_id = ? WHERE id = ?',
          [generateId(), document.id],
        );
      }
      this.db.executeSync(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_rag_documents_sync_id ON rag_documents(sync_id)',
      );
      this.db.executeSync(
        `CREATE TABLE IF NOT EXISTS rag_chunks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          content TEXT NOT NULL,
          doc_id INTEGER NOT NULL,
          position INTEGER NOT NULL,
          FOREIGN KEY (doc_id) REFERENCES rag_documents(id)
        )`,
      );
      this.db.executeSync(
        `CREATE TABLE IF NOT EXISTS rag_embeddings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chunk_rowid INTEGER NOT NULL,
          doc_id INTEGER NOT NULL,
          embedding BLOB NOT NULL,
          FOREIGN KEY (chunk_rowid) REFERENCES rag_chunks(id),
          FOREIGN KEY (doc_id) REFERENCES rag_documents(id)
        )`,
      );
      this.db.executeSync(
        'CREATE INDEX IF NOT EXISTS idx_rag_embeddings_doc_id ON rag_embeddings(doc_id)',
      );
      this.db.executeSync(
        'CREATE INDEX IF NOT EXISTS idx_rag_chunks_doc_id_position ON rag_chunks(doc_id, position)',
      );
      this.db.executeSync(
        'CREATE INDEX IF NOT EXISTS idx_rag_documents_project_id_enabled ON rag_documents(project_id, enabled)',
      );
      this.ready = true;
    } catch (error) {
      logger.error('[RagDB] Failed to initialize:', error);
      throw error;
    }
  }

  private getDb(): DB {
    if (!this.db)
      throw new Error('RagDatabase not initialized. Call ensureReady() first.');
    return this.db;
  }

  insertDocument(doc: {
    projectId: string;
    name: string;
    path: string;
    size: number;
    syncId?: string;
    createdAt?: string;
    enabled?: boolean;
  }): number {
    const db = this.getDb();
    const result = db.executeSync(
      `INSERT INTO rag_documents
        (sync_id, project_id, name, path, size, created_at, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        doc.syncId ?? generateId(),
        doc.projectId,
        doc.name,
        doc.path,
        doc.size,
        doc.createdAt ?? new Date().toISOString(),
        doc.enabled === false ? 0 : 1,
      ],
    );
    if (result.insertId == null)
      throw new Error('Failed to insert document: no insertId returned');
    return result.insertId;
  }

  insertChunks(docId: number, chunks: Chunk[]): number[] {
    const db = this.getDb();
    this.vectorCache.delete(docId);
    const rowIds: number[] = [];
    db.executeSync('BEGIN');
    try {
      for (const chunk of chunks) {
        const result = db.executeSync(
          'INSERT INTO rag_chunks (content, doc_id, position) VALUES (?, ?, ?)',
          [chunk.content, docId, chunk.position],
        );
        if (result.insertId == null)
          throw new Error(
            `Failed to insert chunk at position ${chunk.position}`,
          );
        rowIds.push(result.insertId);
      }
      db.executeSync('COMMIT');
    } catch (e) {
      db.executeSync('ROLLBACK');
      throw e;
    }
    return rowIds;
  }

  private embeddingToBlob(embedding: number[]): ArrayBuffer {
    return new Float32Array(embedding).buffer;
  }

  /** A view over the BLOB's bytes; no element copy. */
  private blobToEmbedding(blob: any): Float32Array {
    if (isArrayBuffer(blob)) return new Float32Array(blob);
    if (isArrayBuffer(blob?.buffer)) return new Float32Array(blob.buffer);
    return EMPTY_VECTOR;
  }

  insertEmbeddingsBatch(
    entries: { chunkRowid: number; docId: number; embedding: number[] }[],
  ): void {
    const db = this.getDb();
    for (const entry of entries) this.vectorCache.delete(entry.docId);
    db.executeSync('BEGIN');
    try {
      for (const entry of entries) {
        db.executeSync(
          'INSERT INTO rag_embeddings (chunk_rowid, doc_id, embedding) VALUES (?, ?, ?)',
          [
            entry.chunkRowid,
            entry.docId,
            this.embeddingToBlob(entry.embedding),
          ],
        );
      }
      db.executeSync('COMMIT');
    } catch (e) {
      db.executeSync('ROLLBACK');
      throw e;
    }
  }

  getEmbeddingsByProject(projectId: string): StoredEmbedding[] {
    const db = this.getDb();
    // ORDER BY e.id keeps the order the unindexed query scanned in, so equal scores stay in the same order.
    const result = db.executeSync(
      `SELECT e.id AS embedding_id, e.chunk_rowid, e.doc_id, d.name, c.content, c.position
       FROM rag_embeddings e
       JOIN rag_chunks c ON e.chunk_rowid = c.id
       JOIN rag_documents d ON e.doc_id = d.id
       WHERE d.project_id = ? AND d.enabled = 1
       ORDER BY e.id`,
      [projectId],
    );
    const rows = (result.rows ?? []) as unknown as (Omit<
      StoredEmbedding,
      'embedding'
    > & { embedding_id: number })[];

    const idsByDoc = new Map<number, number[]>();
    for (const row of rows) {
      const ids = idsByDoc.get(row.doc_id);
      if (ids) ids.push(row.embedding_id);
      else idsByDoc.set(row.doc_id, [row.embedding_id]);
    }
    const vectorsByDoc = new Map<number, Float32Array[]>();
    for (const [docId, ids] of idsByDoc) {
      vectorsByDoc.set(docId, this.getDocumentVectors(docId, ids));
    }

    const nextIndexByDoc = new Map<number, number>();
    return rows.map(({ embedding_id: _embeddingId, ...row }) => {
      const index = nextIndexByDoc.get(row.doc_id) ?? 0;
      nextIndexByDoc.set(row.doc_id, index + 1);
      return { ...row, embedding: vectorsByDoc.get(row.doc_id)![index] };
    });
  }

  /** Decoded vectors for `ids` (ascending, all from `docId`), from the cache when it still matches. */
  private getDocumentVectors(docId: number, ids: number[]): Float32Array[] {
    const cached = this.vectorCache.get(docId);
    if (cached && sameIds(cached.ids, ids)) return cached.vectors;

    const result = this.getDb().executeSync(
      `SELECT e.id AS embedding_id, e.embedding
       FROM rag_embeddings e
       JOIN rag_chunks c ON e.chunk_rowid = c.id
       WHERE e.doc_id = ?
       ORDER BY e.id`,
      [docId],
    );
    const rows = (result.rows ?? []) as unknown as {
      embedding_id: number;
      embedding: unknown;
    }[];
    const loadedIds = rows.map(row => row.embedding_id);
    const vectors = rows.map(row => this.blobToEmbedding(row.embedding));
    if (sameIds(loadedIds, ids)) {
      const bytes = vectors.reduce((sum, vector) => sum + vector.byteLength, 0);
      this.vectorCache.set(docId, { ids: loadedIds, vectors, bytes });
      return vectors;
    }
    // The rows changed between the two reads; align by id and leave the cache alone.
    const byId = new Map<number, Float32Array>();
    loadedIds.forEach((id, i) => byId.set(id, vectors[i]));
    return ids.map(id => byId.get(id) ?? EMPTY_VECTOR);
  }

  hasEmbeddingsForDocument(docId: number): boolean {
    const db = this.getDb();
    const result = db.executeSync(
      'SELECT COUNT(*) as count FROM rag_embeddings WHERE doc_id = ?',
      [docId],
    );
    const rows = (result.rows ?? []) as unknown as { count: number }[];
    return rows.length > 0 && rows[0].count > 0;
  }

  getChunksByDocument(
    docId: number,
  ): { id: number; content: string; position: number }[] {
    const db = this.getDb();
    const result = db.executeSync(
      'SELECT id, content, position FROM rag_chunks WHERE doc_id = ? ORDER BY position',
      [docId],
    );
    return (result.rows ?? []) as unknown as {
      id: number;
      content: string;
      position: number;
    }[];
  }

  deleteDocument(docId: number): void {
    const db = this.getDb();
    this.vectorCache.delete(docId);
    db.executeSync('BEGIN');
    try {
      db.executeSync('DELETE FROM rag_embeddings WHERE doc_id = ?', [docId]);
      db.executeSync('DELETE FROM rag_chunks WHERE doc_id = ?', [docId]);
      db.executeSync('DELETE FROM rag_documents WHERE id = ?', [docId]);
      db.executeSync('COMMIT');
    } catch (e) {
      db.executeSync('ROLLBACK');
      throw e;
    }
  }

  getDocumentsByProject(projectId: string): RagDocument[] {
    const db = this.getDb();
    const result = db.executeSync(
      'SELECT id, sync_id, project_id, name, path, size, created_at, enabled FROM rag_documents WHERE project_id = ? ORDER BY created_at DESC',
      [projectId],
    );
    return (result.rows ?? []) as unknown as RagDocument[];
  }

  getAllDocuments(): RagDocument[] {
    const db = this.getDb();
    const result = db.executeSync(
      'SELECT id, sync_id, project_id, name, path, size, created_at, enabled FROM rag_documents ORDER BY created_at ASC',
    );
    return (result.rows ?? []) as unknown as RagDocument[];
  }

  getDocument(docId: number): RagDocument | undefined {
    const db = this.getDb();
    const result = db.executeSync(
      'SELECT id, sync_id, project_id, name, path, size, created_at, enabled FROM rag_documents WHERE id = ?',
      [docId],
    );
    return ((result.rows ?? []) as unknown as RagDocument[])[0];
  }

  getDocumentBySyncId(syncId: string): RagDocument | undefined {
    const db = this.getDb();
    const result = db.executeSync(
      'SELECT id, sync_id, project_id, name, path, size, created_at, enabled FROM rag_documents WHERE sync_id = ?',
      [syncId],
    );
    return ((result.rows ?? []) as unknown as RagDocument[])[0];
  }

  toggleEnabled(docId: number, enabled: boolean): void {
    const db = this.getDb();
    this.vectorCache.delete(docId);
    db.executeSync('UPDATE rag_documents SET enabled = ? WHERE id = ?', [
      enabled ? 1 : 0,
      docId,
    ]);
  }

  getChunksByProject(projectId: string, topK: number = 5): RagSearchResult[] {
    const db = this.getDb();
    const result = db.executeSync(
      `SELECT c.doc_id, d.name, c.content, c.position, 0 as score
       FROM rag_chunks c JOIN rag_documents d ON c.doc_id = d.id
       WHERE d.project_id = ? AND d.enabled = 1
       ORDER BY c.position LIMIT ?`,
      [projectId, topK],
    );
    return (result.rows ?? []) as unknown as RagSearchResult[];
  }

  deleteDocumentsByProject(projectId: string): void {
    const db = this.getDb();
    this.vectorCache.clear();
    db.executeSync('BEGIN');
    try {
      db.executeSync(
        'DELETE FROM rag_embeddings WHERE doc_id IN (SELECT id FROM rag_documents WHERE project_id = ?)',
        [projectId],
      );
      db.executeSync(
        'DELETE FROM rag_chunks WHERE doc_id IN (SELECT id FROM rag_documents WHERE project_id = ?)',
        [projectId],
      );
      db.executeSync('DELETE FROM rag_documents WHERE project_id = ?', [
        projectId,
      ]);
      db.executeSync('COMMIT');
    } catch (e) {
      db.executeSync('ROLLBACK');
      throw e;
    }
  }
}

export const ragDatabase = new RagDatabase();
