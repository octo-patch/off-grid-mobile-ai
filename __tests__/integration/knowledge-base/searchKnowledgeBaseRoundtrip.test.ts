/**
 * GUARD (integration, REAL sqlite) — the search_knowledge_base tool round-trips against the real document
 * index: a user adds a PDF to the project's knowledge base, the model calls search_knowledge_base, and the
 * tool returns the real indexed passage as a cited `<source>` the answer can link to its page.
 *
 * Everything we own runs (knowledgeBase.addFile, documentService, the shared ingest service, the op-sqlite
 * store + FTS5, the turn service, the tool handler and its citation registry). Only native leaves are faked
 * (harness/documentEngine): the PDF reader reads the kept file from memfs, the embedding model answers
 * through llama.rn, and op-sqlite is a REAL node:sqlite engine.
 */
import { installNativeBoundary, GB } from '../../harness/nativeBoundary';
import { installDocumentEngine } from '../../harness/documentEngine';

describe('search_knowledge_base — real document-index round-trip (guard)', () => {
  it('returns the indexed passage, cited by page, when the model searches the knowledge base', async () => {
    const boundary = installNativeBoundary({ fs: true, ram: { platform: 'ios', totalBytes: 8 * GB, availBytes: 6 * GB } });
    const engine = installDocumentEngine(boundary.fs!);
    const { knowledgeBase } = require('../../../src/services/rag');
    const { executeToolCall } = require('../../../src/services/tools/handlers');
    const { parseSearchBlock } = require('@offgrid/rag/documents');

    engine.seedPdf('/docs/Downloads/zenland.pdf', [
      'Bananas are a yellow fruit. Weather is mild.',
      'The capital of Zenland is Quixotic City.',
    ]);
    // The user adds the document to the project's knowledge base; it is read in the background.
    await knowledgeBase.addFile({ projectId: 'p1', filePath: '/docs/Downloads/zenland.pdf', fileName: 'zenland.pdf', fileSize: 512 });
    await engine.indexed(await engine.documentIdOf('/docs/Downloads/zenland.pdf'));

    // The model calls the tool during a project chat.
    const result = await executeToolCall({
      id: 'tc1', name: 'search_knowledge_base', arguments: { query: 'what is the capital of Zenland?' },
      context: { projectId: 'p1' },
    });

    // The tool hands back the real page text, tagged so the answer cites page 2 of zenland.pdf.
    expect(result.error).toBeFalsy();
    const passages = parseSearchBlock(result.content);
    expect(passages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ document: 'zenland.pdf', page: 2, text: expect.stringMatching(/Quixotic City/) }),
      ]),
    );
  });
});
