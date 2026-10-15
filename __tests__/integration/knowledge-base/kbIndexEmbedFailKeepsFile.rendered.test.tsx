/**
 * When the embedding model fails while a knowledge-base file is being indexed, the file is NOT lost.
 *
 * The old engine aborted the whole add on an embedding failure (the add-document ABORT contract). The
 * document engine changed that decision: a file is keyword-searchable as soon as its passages are stored,
 * and vectors are a background extra that a later read fills in. So an embedding failure (the on-device
 * OOM) must leave the file listed, read, and answerable by keyword - with no error card asking the person
 * to add it again.
 *
 * Real stack over the device boundary (harness/knowledgeBaseApp): the real KnowledgeBaseScreen on a real
 * navigation stack, the real knowledge base, document engine and tool handler. The only failure injected
 * is native: llama.rn's embedding call rejects with the device's OOM.
 */
import { openKnowledgeBase } from '../../harness/knowledgeBaseApp';

jest.unmock('@react-navigation/native');

describe('KB index when the embedding model fails (rendered)', () => {
  it('keeps the file, shows it as read, offers no retry, and the model can still find it by keyword', async () => {
    const kb = await openKnowledgeBase();
    kb.engine.failEmbedding('OOM: embedding model ran out of memory');
    kb.engine.seedText('/docs/Downloads/report.txt', 'The quarterly report shows revenue grew in the eastern region.');

    await kb.addFiles([{ path: '/docs/Downloads/report.txt', name: 'report.txt' }]);

    // Listed, and read to the end: the status settles on its page count, not "Couldn't read".
    const status = await kb.statusOf('/docs/Downloads/report.txt');
    await kb.rtl.waitFor(() => expect(status.props.children).toMatch(/· 1 page$/));
    expect(kb.view.queryByTestId('kb-index-error-card')).toBeNull();
    expect(kb.view.queryByTestId('kb-index-retry')).toBeNull();

    // Without vectors, keyword search still hands the model the passage.
    const { executeToolCall } = require('../../../src/services/tools/handlers');
    const result = await executeToolCall({
      id: 'tc1',
      name: 'search_knowledge_base',
      arguments: { query: 'quarterly revenue eastern region' },
      context: { projectId: kb.project.id },
    });
    expect(result.content).toContain('revenue grew in the eastern region');
  });
});
