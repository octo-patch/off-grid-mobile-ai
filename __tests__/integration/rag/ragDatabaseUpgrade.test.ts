/**
 * Opening rag.db written by an earlier release, on the real SQLite engine (node:sqlite behind the
 * op-sqlite interface). Knowledge-base text now lives in the document index, so the upgrade keeps
 * every knowledge-base file row, gains the document_id column and its index, and drops the old
 * chunk and vector tables.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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
          .run(chunkId, docId, new Uint8Array(new Float32Array([1, 0, 0]).buffer));
      });
    }
    db.close();
  }

  function readDocuments(file: string) {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(file);
    const rows = db
      .prepare('SELECT id, project_id, name, path, size, created_at, enabled FROM rag_documents ORDER BY id')
      .all();
    db.close();
    return JSON.parse(JSON.stringify(rows));
  }

  function tables(file: string): string[] {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(file);
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
      t => t.name,
    );
    db.close();
    return names;
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

  it.each([
    ['without sync_id (stable)', false],
    ['with sync_id (beta)', true],
  ])('upgrades a database %s in place: file rows kept, old index tables dropped', async (_label, withSyncId) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-upgrade-'));
    const file = path.join(dir, 'rag.db');
    writeLegacyDatabase(file, withSyncId);
    const before = readDocuments(file);

    jest.resetModules();
    jest.doMock('@op-engineering/op-sqlite', () => fileBackedOpSqlite(dir));
    const { ragDatabase } = require('../../../src/services/rag/database');
    await ragDatabase.ensureReady();

    expect(readDocuments(file)).toEqual(before);
    expect(tables(file)).not.toContain('rag_chunks');
    expect(tables(file)).not.toContain('rag_embeddings');
    expect(indexedColumns(file, 'rag_documents')).toContainEqual(['document_id']);
    expect(indexedColumns(file, 'rag_documents')).toContainEqual(['project_id', 'enabled']);
    const documents = ragDatabase.getAllDocuments() as { sync_id: string; document_id: string | null }[];
    expect(documents).toHaveLength(3);
    expect(documents.every(d => !!d.sync_id && d.document_id === null)).toBe(true);
  });
});
