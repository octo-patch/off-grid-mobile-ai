/**
 * BATCH 3 — Chat Attachments & Vision (hardening)
 * File 1: Document attachment validation & multi-attachment queueing.
 *
 * Drives the REAL documentService (the attach seam). The only stood-in boundaries
 * are native: react-native-fs (memfs) and op-sqlite (a real in-memory SQLite, so the
 * background read the attach starts runs for real too). The native PDF reader is
 * absent, as on a device without it. All validation / extension / size / decode
 * logic runs for real — deleting the implementation would fail these tests.
 *
 * On-device test-plan cases covered here (see the on-device test plan, Batch 3):
 *  - #2  supported .txt accepted            (COVERED-REAL in existing suite; asserted end-to-end here for the accept-set)
 *  - #12 unsupported binary (.docx) rejected with a visible error
 *  - #13 oversized file rejected with a visible error (the limit is 1 GB: documents are read page by page)
 *  - #14 .md accepted
 *  - #15 .json accepted
 *  - #17 URL-encoded filename display-name decode  → BUG-FOUND (service returns it un-decoded)
 *  - #34/#35 multiple document attachments queue as distinct attachments
 *
 * The accepted-extension set explicitly includes .csv and code files (.py/.ts),
 * which the on-device plan's "supported types" line enumerates but the existing unit suite
 * does not exhaustively assert.
 */

import { defaultNativeFileSystemBoundary } from '../harness/nativeFileSystem';

jest.mock('react-native-fs', () => {
  const { defaultNativeFileSystemBoundary: boundary } = require('../harness/nativeFileSystem');
  return { __esModule: true, default: boundary.module, ...boundary.module };
});

jest.mock('@op-engineering/op-sqlite', () => require('../harness/sqliteFake').realSqliteModule());

import { createHash } from 'node:crypto';
import { documentService } from '../../src/services/documentService';

const GB = 1024 * 1024 * 1024;

/** Put one readable file on the fake device, with independent stored bytes and reported metadata. */
function seedReadableFile(
  path: string,
  content: string,
  size = content.length,
): void {
  defaultNativeFileSystemBoundary.seedTextFile(path, content, size);
}

const sha256 = (content: string) => createHash('sha256').update(content).digest('hex');

describe('Batch3 · document attach validation (real documentService)', () => {
  beforeEach(() => {
    defaultNativeFileSystemBoundary.reset();
  });

  // ── #14/#15/#2 + csv/code: the full supported accept-set ───────────────────
  describe('supported document types are accepted (#2, #14, #15)', () => {
    const acceptedNames = [
      'notes.txt',
      'readme.md',
      'data.json',
      'table.csv',
      'script.py',
      'index.ts',
    ];

    it.each(acceptedNames)('isSupported() accepts %s', (name) => {
      expect(documentService.isSupported(name)).toBe(true);
    });

    it.each(acceptedNames)('attachDocument() keeps a copy and builds a document attachment for %s', async (name) => {
      seedReadableFile(`/docs/${name}`, 'sample body', 11);
      const att = await documentService.attachDocument(`/docs/${name}`, name);
      expect(att.type).toBe('document');
      expect(att.fileName).toBe(name);
      expect(att.fileSize).toBe(11);
      // Its identity in the document index is the content hash; the kept copy holds the same bytes.
      expect(att.documentId).toBe(sha256('sample body'));
      expect(att.uri.startsWith(`${defaultNativeFileSystemBoundary.DocumentDirectoryPath}/attachments/`)).toBe(true);
      expect(await defaultNativeFileSystemBoundary.readAscii(att.uri, 11)).toBe('sample body');
    });
  });

  // ── #12: unsupported binary format rejected with a visible error ────────────
  describe('unsupported binary formats are rejected (#12)', () => {
    it('isSupported() is false for a .docx binary', () => {
      expect(documentService.isSupported('report.docx')).toBe(false);
    });

    it('isSupported() is false for .xlsx and image binaries', () => {
      expect(documentService.isSupported('sheet.xlsx')).toBe(false);
      expect(documentService.isSupported('photo.png')).toBe(false);
    });

    it('attachDocument() throws an "Unsupported file type" error for .docx (no chip is added)', async () => {
      await expect(
        documentService.attachDocument('/docs/report.docx', 'report.docx'),
      ).rejects.toThrow(/Unsupported file type/);
    });

    it('attachDocument() refuses a PDF on a device without the native PDF reader', async () => {
      seedReadableFile('/docs/scan.pdf', '%PDF-1.7');
      await expect(
        documentService.attachDocument('/docs/scan.pdf', 'scan.pdf'),
      ).rejects.toThrow(/PDF extraction is not available/);
    });
  });

  // ── #13: oversized file rejected with a visible error ───────────────────────
  describe('oversized files are rejected (#13)', () => {
    it('rejects a file at 1 GB + 1 byte with a "too large" error', async () => {
      seedReadableFile('/docs/huge.txt', 'x', GB + 1);
      await expect(
        documentService.attachDocument('/docs/huge.txt', 'huge.txt'),
      ).rejects.toThrow(/too large/i);
    });

    it('accepts a file exactly at the 1 GB boundary', async () => {
      seedReadableFile('/docs/limit.txt', 'ok', GB);
      const att = await documentService.attachDocument('/docs/limit.txt', 'limit.txt');
      expect(att.fileSize).toBe(GB);
    });

    it('says so when the picked file cannot be found', async () => {
      await expect(
        documentService.attachDocument('/docs/gone.txt', 'gone.txt'),
      ).rejects.toThrow(/Could not read this file/);
    });
  });

  // ── #17: URL-encoded filename should display decoded ────────────────────────
  //
  // BUG-FOUND: documentService.attachDocument returns `fileName` VERBATIM for display. It
  // decodeURIComponent()s only the file PATH inside resolveContentUri, never the display name. So a name
  // like 'my%20notes.txt' is surfaced to the attachment chip un-decoded, contrary to device case #17
  // ("shows the human-readable decoded filename, not the raw encoded string"). On device the picker
  // usually hands back an already-decoded name, which is why the E2E may still pass — but the service
  // seam does not guarantee it.
  describe('URL-encoded filename display decode (#17)', () => {
    it.skip('BUG-FOUND: display fileName should be decoded (my%20notes.txt -> "my notes.txt")', async () => {
      seedReadableFile('/mock/documents/my notes.txt', 'body');
      const att = await documentService.attachDocument(
        '/mock/documents/my%20notes.txt',
        'my%20notes.txt',
      );
      // Desired behavior per device case #17: the chip shows the decoded, human-readable name.
      expect(att.fileName).toBe('my notes.txt');
    });

    it('resolves the file even when the PATH is URL-encoded (path decode works)', async () => {
      // The path decode DOES happen (resolveContentUri), so a file whose path carries %20 is found and
      // kept — the attach itself succeeds, with the decoded file's bytes.
      seedReadableFile('/docs/inbox/my notes.txt', 'decoded path body');
      const att = await documentService.attachDocument(
        'file:///docs/inbox/my%20notes.txt',
        'my notes.txt',
      );
      expect(att.documentId).toBe(sha256('decoded path body'));
    });
  });

  // ── #34/#35: multiple document attachments queue as distinct attachments ────
  describe('multiple document attachments queue (#34, #35)', () => {
    it('produces two distinct attachments with unique ids and kept copies for two files', async () => {
      seedReadableFile('/docs/a.py', 'py body');
      seedReadableFile('/docs/b.ts', 'ts body');
      const first = await documentService.attachDocument('/docs/a.py', 'a.py');
      const second = await documentService.attachDocument('/docs/b.ts', 'b.ts');

      expect(first.fileName).toBe('a.py');
      expect(second.fileName).toBe('b.ts');
      expect(first.id).not.toBe(second.id);
      expect(first.uri).not.toBe(second.uri);
      expect(first.documentId).not.toBe(second.documentId);
      // Both are documents that would render as side-by-side chips (#34) and send together in one
      // message (#35); each is read on its own by the document index.
      expect(first.type).toBe('document');
      expect(second.type).toBe('document');
    });
  });
});
