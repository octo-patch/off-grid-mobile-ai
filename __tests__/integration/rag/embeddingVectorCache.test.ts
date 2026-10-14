/**
 * Knowledge-base search keeps decoded embedding vectors between chat turns. These tests pin what that must
 * never change: the chunks a search returns, their scores and their order (ties included), and how quickly
 * a write shows up in the next search.
 *
 * Everything runs over a REAL SQLite engine (node:sqlite), so documents, chunks and embedding BLOBs are
 * written and read back with the module's actual SQL. The only stand-in is the embedding MODEL (native
 * llama.rn), replaced by deterministic keyword vectors so cosine ranking is real rather than canned.
 *
 * The last block opens a database written by an older release (no indexes, optionally no sync_id column)
 * from a file, the way op-sqlite opens rag.db by name on a device, and checks it upgrades in place.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { installRealSqlite } from '../../harness/sqliteFake';

const KEYWORDS = ['solar', 'battery', 'inverter', 'ledger'];
const toVec = (text: string): number[] => {
  const lower = String(text).toLowerCase();
  return KEYWORDS.map(k => (lower.includes(k) ? 1 : 0));
};

/** The embedding model boundary: same surface as embeddingService, deterministic vectors. */
function installEmbeddingModel(): void {
  jest.doMock('../../../src/services/rag/embedding', () => ({
    embeddingService: {
      isLoaded: () => true,
      load: async () => undefined,
      unload: async () => undefined,
      getDimension: () => KEYWORDS.length,
      embed: async (text: string) => toVec(text),
      embedBatch: async (texts: string[]) => texts.map(toVec),
    },
  }));
}

type Chunk = { doc_id: number; name: string; content: string; position: number; score: number };
type RagDb = {
  ensureReady: () => Promise<void>;
  insertDocument: (doc: { projectId: string; name: string; path: string; size: number }) => number;
  insertChunks: (docId: number, chunks: { content: string; position: number }[]) => number[];
  insertEmbeddingsBatch: (entries: { chunkRowid: number; docId: number; embedding: number[] }[]) => void;
  getDocument: (docId: number) => { sync_id: string } | undefined;
};
type Rag = {
  ragDatabase: RagDb;
  ragService: {
    deleteDocument: (docId: number) => Promise<void>;
    toggleDocument: (docId: number, enabled: boolean) => Promise<void>;
    deleteProjectDocuments: (projectId: string) => Promise<void>;
    backfillEmbeddings: (projectId: string) => Promise<number>;
    setSyncedDocumentEnabled: (syncId: string, enabled: boolean) => Promise<void>;
    deleteSyncedDocument: (syncId: string) => Promise<void>;
    getDocumentsByProject: (projectId: string) => Promise<{ name: string }[]>;
  };
  search: (projectId: string, query: string, topK?: number) => Promise<Chunk[]>;
};

function requireRag(): Rag {
  const { ragDatabase } = require('../../../src/services/rag/database');
  const { ragService } = require('../../../src/services/rag');
  const { retrievalService } = require('../../../src/services/rag/retrieval');
  return {
    ragDatabase,
    ragService,
    search: async (projectId, query, topK = 10) =>
      (await retrievalService.search(projectId, query, topK)).chunks,
  };
}

async function freshRag(): Promise<Rag> {
  installRealSqlite();
  installEmbeddingModel();
  const rag = requireRag();
  await rag.ragDatabase.ensureReady();
  return rag;
}

/** Index a document through the real write path; `vectors` overrides the embedding per chunk. */
function addDocument(
  db: RagDb,
  projectId: string,
  name: string,
  texts: string[],
  vectors: number[][] = texts.map(toVec),
): number {
  const docId = db.insertDocument({ projectId, name, path: `/docs/${name}`, size: texts.join('').length });
  const rowIds = db.insertChunks(docId, texts.map((content, position) => ({ content, position })));
  db.insertEmbeddingsBatch(rowIds.map((chunkRowid, i) => ({ chunkRowid, docId, embedding: vectors[i] })));
  return docId;
}

const label = (chunks: Chunk[]) => chunks.map(c => `${c.name}#${c.position}`);

describe('repeated knowledge-base searches', () => {
  it('return exactly the same chunks, scores and tie order as the first search', async () => {
    const { ragDatabase, search } = await freshRag();
    // Two documents whose embeddings are written interleaved, all tying on the query, plus one weaker
    // match. Ties have always come back in the order the embeddings were stored, not grouped by document.
    const a = ragDatabase.insertDocument({ projectId: 'p1', name: 'a.txt', path: '/a', size: 1 });
    const b = ragDatabase.insertDocument({ projectId: 'p1', name: 'b.txt', path: '/b', size: 1 });
    const [a0, a1] = ragDatabase.insertChunks(a, [
      { content: 'solar one', position: 0 },
      { content: 'solar two', position: 1 },
    ]);
    const [b0, b1, b2] = ragDatabase.insertChunks(b, [
      { content: 'solar three', position: 0 },
      { content: 'solar four', position: 1 },
      { content: 'solar battery five', position: 2 },
    ]);
    const solar = [1, 0, 0, 0];
    ragDatabase.insertEmbeddingsBatch([
      { chunkRowid: b2, docId: b, embedding: [1, 1, 0, 0] },
      { chunkRowid: a0, docId: a, embedding: solar },
      { chunkRowid: b0, docId: b, embedding: solar },
      { chunkRowid: a1, docId: a, embedding: solar },
      { chunkRowid: b1, docId: b, embedding: solar },
    ]);

    const first = await search('p1', 'solar');
    const second = await search('p1', 'solar');
    const third = await search('p1', 'solar');

    expect(label(first)).toEqual(['a.txt#0', 'b.txt#0', 'a.txt#1', 'b.txt#1', 'b.txt#2']);
    expect(first.slice(0, 4).map(c => c.score)).toEqual([1, 1, 1, 1]);
    expect(first[4].score).toBeCloseTo(Math.SQRT1_2, 6);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it('respect topK the same way on every search', async () => {
    const { ragDatabase, search } = await freshRag();
    addDocument(ragDatabase, 'p1', 'a.txt', ['solar a', 'battery a', 'ledger a']);
    addDocument(ragDatabase, 'p1', 'b.txt', ['solar battery b', 'inverter b']);

    const first = await search('p1', 'solar battery', 2);
    const second = await search('p1', 'solar battery', 2);

    expect(label(first)).toEqual(['b.txt#0', 'a.txt#0']);
    expect(second).toEqual(first);
  });
});

describe('a write shows up in the very next search', () => {
  it('a newly indexed document', async () => {
    const { ragDatabase, search } = await freshRag();
    addDocument(ragDatabase, 'p1', 'a.txt', ['solar and battery']);
    expect(label(await search('p1', 'inverter'))).toEqual(['a.txt#0']);

    addDocument(ragDatabase, 'p1', 'b.txt', ['inverter manual']);

    expect(label(await search('p1', 'inverter'))).toEqual(['b.txt#0', 'a.txt#0']);
  });

  it('embeddings added to a document that was already searched', async () => {
    const { ragDatabase, search } = await freshRag();
    const docId = ragDatabase.insertDocument({ projectId: 'p1', name: 'a.txt', path: '/a', size: 1 });
    const [c0, c1] = ragDatabase.insertChunks(docId, [
      { content: 'solar intro', position: 0 },
      { content: 'ledger detail', position: 1 },
    ]);
    ragDatabase.insertEmbeddingsBatch([{ chunkRowid: c0, docId, embedding: toVec('solar intro') }]);
    expect(label(await search('p1', 'ledger'))).toEqual(['a.txt#0']);

    ragDatabase.insertEmbeddingsBatch([{ chunkRowid: c1, docId, embedding: toVec('ledger detail') }]);

    expect(label(await search('p1', 'ledger'))).toEqual(['a.txt#1', 'a.txt#0']);
  });

  it('a backfill that embeds a document indexed without embeddings', async () => {
    const { ragDatabase, ragService, search } = await freshRag();
    addDocument(ragDatabase, 'p1', 'a.txt', ['solar notes']);
    const legacy = ragDatabase.insertDocument({ projectId: 'p1', name: 'old.txt', path: '/old', size: 1 });
    ragDatabase.insertChunks(legacy, [{ content: 'battery notes', position: 0 }]);
    expect(label(await search('p1', 'battery'))).toEqual(['a.txt#0']);

    await ragService.backfillEmbeddings('p1');

    expect(label(await search('p1', 'battery'))).toEqual(['old.txt#0', 'a.txt#0']);
  });

  it('a document replaced by a new version', async () => {
    const { ragDatabase, ragService, search } = await freshRag();
    const old = addDocument(ragDatabase, 'p1', 'spec.txt', ['solar spec v1']);
    addDocument(ragDatabase, 'p1', 'other.txt', ['battery other']);
    expect((await search('p1', 'solar'))[0].content).toBe('solar spec v1');

    await ragService.deleteDocument(old);
    addDocument(ragDatabase, 'p1', 'spec.txt', ['solar spec v2', 'inverter appendix']);

    const after = await search('p1', 'solar');
    expect(after.map(c => c.content)).toEqual(['solar spec v2', 'battery other', 'inverter appendix']);
  });

  it('a deleted document, down to an empty knowledge base', async () => {
    const { ragDatabase, ragService, search } = await freshRag();
    const a = addDocument(ragDatabase, 'p1', 'a.txt', ['solar a']);
    const b = addDocument(ragDatabase, 'p1', 'b.txt', ['solar b']);
    expect(label(await search('p1', 'solar'))).toEqual(['a.txt#0', 'b.txt#0']);

    await ragService.deleteDocument(a);
    expect(label(await search('p1', 'solar'))).toEqual(['b.txt#0']);

    await ragService.deleteDocument(b);
    expect(await search('p1', 'solar')).toEqual([]);
    expect(await ragService.getDocumentsByProject('p1')).toEqual([]);
  });

  it('a document disabled and enabled again', async () => {
    const { ragDatabase, ragService, search } = await freshRag();
    const a = addDocument(ragDatabase, 'p1', 'a.txt', ['solar a', 'battery a']);
    addDocument(ragDatabase, 'p1', 'b.txt', ['solar b']);
    const before = await search('p1', 'solar');

    await ragService.toggleDocument(a, false);
    expect(label(await search('p1', 'solar'))).toEqual(['b.txt#0']);

    await ragService.toggleDocument(a, true);
    expect(await search('p1', 'solar')).toEqual(before);
  });

  it('enable, disable and delete arriving from sync', async () => {
    const { ragDatabase, ragService, search } = await freshRag();
    const a = addDocument(ragDatabase, 'p1', 'a.txt', ['solar a']);
    addDocument(ragDatabase, 'p1', 'b.txt', ['solar b']);
    const syncId = ragDatabase.getDocument(a)!.sync_id;
    expect(label(await search('p1', 'solar'))).toEqual(['a.txt#0', 'b.txt#0']);

    await ragService.setSyncedDocumentEnabled(syncId, false);
    expect(label(await search('p1', 'solar'))).toEqual(['b.txt#0']);

    await ragService.setSyncedDocumentEnabled(syncId, true);
    expect(label(await search('p1', 'solar'))).toEqual(['a.txt#0', 'b.txt#0']);

    await ragService.deleteSyncedDocument(syncId);
    expect(label(await search('p1', 'solar'))).toEqual(['b.txt#0']);
  });

  it('switching projects, and deleting one project\'s documents', async () => {
    const { ragDatabase, ragService, search } = await freshRag();
    addDocument(ragDatabase, 'p1', 'one.txt', ['solar for p1']);
    addDocument(ragDatabase, 'p2', 'two.txt', ['solar for p2']);

    const p1 = await search('p1', 'solar');
    expect(label(p1)).toEqual(['one.txt#0']);
    expect(label(await search('p2', 'solar'))).toEqual(['two.txt#0']);
    expect(await search('p1', 'solar')).toEqual(p1);

    await ragService.deleteProjectDocuments('p1');

    expect(await search('p1', 'solar')).toEqual([]);
    expect(label(await search('p2', 'solar'))).toEqual(['two.txt#0']);
  });
});

describe('opening rag.db written by an earlier release', () => {
  /** op-sqlite opens rag.db by name from app storage; here the same name maps to a file in a temp dir. */
  function fileBackedOpSqlite(dir: string) {
    const { DatabaseSync } = require('node:sqlite');
    const isArrayBuffer = (v: unknown) => Object.prototype.toString.call(v) === '[object ArrayBuffer]';
    return {
      open: ({ name }: { name: string }) => {
        const db = new DatabaseSync(path.join(dir, name));
        const executeSync = (sql: string, params: unknown[] = []) => {
          const bound = params.map(p => (isArrayBuffer(p) ? new Uint8Array(p as ArrayBuffer) : p));
          if (/^\s*(BEGIN|COMMIT|ROLLBACK|CREATE|ALTER|DROP)\b/i.test(sql) && bound.length === 0) {
            db.exec(sql);
            return { rows: [], rowsAffected: 0 };
          }
          const statement = db.prepare(sql);
          if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql)) {
            return { rows: statement.all(...bound), rowsAffected: 0 };
          }
          const info = statement.run(...bound);
          return { rows: [], insertId: Number(info.lastInsertRowid), rowsAffected: Number(info.changes) };
        };
        return {
          executeSync,
          execute: async (sql: string, params?: unknown[]) => executeSync(sql, params),
          close: () => db.close(),
        };
      },
    };
  }

  function writeLegacyDatabase(file: string, withSyncId: boolean): void {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE rag_documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ${withSyncId ? 'sync_id TEXT,' : ''}
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1
      );
      ${withSyncId ? 'CREATE UNIQUE INDEX idx_rag_documents_sync_id ON rag_documents(sync_id);' : ''}
      CREATE TABLE rag_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        doc_id INTEGER NOT NULL,
        position INTEGER NOT NULL,
        FOREIGN KEY (doc_id) REFERENCES rag_documents(id)
      );
      CREATE TABLE rag_embeddings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chunk_rowid INTEGER NOT NULL,
        doc_id INTEGER NOT NULL,
        embedding BLOB NOT NULL,
        FOREIGN KEY (chunk_rowid) REFERENCES rag_chunks(id),
        FOREIGN KEY (doc_id) REFERENCES rag_documents(id)
      );
    `);
    const docs: [string, string, number, string[]][] = [
      ['p1', 'manual.txt', 1, ['solar panel wiring', 'battery storage sizing']],
      ['p1', 'hidden.txt', 0, ['solar secret']],
      ['p2', 'books.txt', 1, ['ledger totals']],
    ];
    for (const [projectId, name, enabled, texts] of docs) {
      const docId = Number(
        db.prepare(
          withSyncId
            ? 'INSERT INTO rag_documents (sync_id, project_id, name, path, size, created_at, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)'
            : 'INSERT INTO rag_documents (project_id, name, path, size, created_at, enabled) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(...(withSyncId ? [`sync-${name}`] : []), projectId, name, `/docs/${name}`, 10, '2025-01-01T00:00:00.000Z', enabled)
          .lastInsertRowid,
      );
      texts.forEach((text, position) => {
        const chunkId = Number(
          db.prepare('INSERT INTO rag_chunks (content, doc_id, position) VALUES (?, ?, ?)')
            .run(text, docId, position).lastInsertRowid,
        );
        db.prepare('INSERT INTO rag_embeddings (chunk_rowid, doc_id, embedding) VALUES (?, ?, ?)')
          .run(chunkId, docId, new Uint8Array(new Float32Array(toVec(text)).buffer));
      });
    }
    db.close();
  }

  /** Every stored row except the sync_id the upgrade assigns to legacy documents. */
  function readStoredRows(file: string) {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(file);
    const rows = {
      documents: db.prepare('SELECT id, project_id, name, path, size, created_at, enabled FROM rag_documents ORDER BY id').all(),
      chunks: db.prepare('SELECT id, content, doc_id, position FROM rag_chunks ORDER BY id').all(),
      embeddings: db.prepare('SELECT id, chunk_rowid, doc_id, hex(embedding) AS embedding FROM rag_embeddings ORDER BY id').all(),
    };
    db.close();
    return JSON.parse(JSON.stringify(rows));
  }

  /** The column lists of every index on `table`, e.g. [['doc_id'], ['doc_id', 'position']]. */
  function indexedColumns(file: string, table: string): string[][] {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(file);
    const indexes = db.prepare('SELECT name FROM pragma_index_list(?)').all(table) as { name: string }[];
    const columns = indexes.map(({ name }) =>
      (db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno').all(name) as { name: string }[])
        .map(c => c.name),
    );
    db.close();
    return columns;
  }

  async function openApp(dir: string): Promise<Rag> {
    jest.resetModules();
    jest.doMock('@op-engineering/op-sqlite', () => fileBackedOpSqlite(dir));
    installEmbeddingModel();
    const rag = requireRag();
    await rag.ragDatabase.ensureReady();
    return rag;
  }

  it.each([
    ['without sync_id (stable)', false],
    ['with sync_id (beta)', true],
  ])('upgrades a database %s in place, keeping every row and gaining the lookup indexes', async (_label, withSyncId) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-upgrade-'));
    const file = path.join(dir, 'rag.db');
    writeLegacyDatabase(file, withSyncId);
    const before = readStoredRows(file);
    expect(indexedColumns(file, 'rag_embeddings')).toEqual([]);
    expect(indexedColumns(file, 'rag_chunks')).toEqual([]);

    const { search } = await openApp(dir);

    expect(readStoredRows(file)).toEqual(before);
    expect(indexedColumns(file, 'rag_embeddings')).toContainEqual(['doc_id']);
    expect(indexedColumns(file, 'rag_chunks')).toContainEqual(['doc_id', 'position']);
    expect(indexedColumns(file, 'rag_documents')).toContainEqual(['project_id', 'enabled']);

    // The upgraded data still answers searches, scoped and ranked as before.
    expect((await search('p1', 'battery')).map(c => c.content)).toEqual([
      'battery storage sizing',
      'solar panel wiring',
    ]);
    expect((await search('p2', 'ledger')).map(c => c.content)).toEqual(['ledger totals']);

    // Opening again (next launch) is a no-op for the schema and the data.
    const afterFirstOpen = readStoredRows(file);
    const reopened = await openApp(dir);
    expect(readStoredRows(file)).toEqual(afterFirstOpen);
    expect(indexedColumns(file, 'rag_embeddings').filter(c => c.join() === 'doc_id')).toHaveLength(1);
    expect((await reopened.search('p1', 'solar')).map(c => c.content)).toEqual([
      'solar panel wiring',
      'battery storage sizing',
    ]);
  });
});
