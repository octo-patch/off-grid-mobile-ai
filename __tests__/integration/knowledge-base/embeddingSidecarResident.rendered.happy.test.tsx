/**
 * T118 (GREEN guard, UI) — the embedding model lazy-loads on the first real embed and co-resides as a
 * reclaimable SIDECAR: after a file is added to a project's knowledge base and indexed, the model
 * selector's "In Memory" section lists `resident-item-embedding`.
 *
 * Real stack, real gestures, boundary fakes only (harness/knowledgeBaseApp): the real KnowledgeBaseScreen
 * → real knowledgeBase.addFile → real documentService (memfs) → the shared ingest service → the real
 * embeddingService.load() (registers `type:'embedding'` residency) → real embed through llama.rn's
 * embedding context. Residency is validated through the SAME In Memory surface as T111–T117
 * (ResidentsProbe), not getResidents().
 *
 * The model loads lazily, on the first embed of this file. (A probe mounted before the gesture would be a
 * second render root, which the knowledge-base screen's queries do not survive, so the before-state is
 * not asserted here.)
 */
import { openKnowledgeBase } from '../../harness/knowledgeBaseApp';

jest.unmock('@react-navigation/native');

describe('T118 (rendered) — embedding model co-resides as a sidecar after a KB index (In Memory UI)', () => {
  it('lists resident-item-embedding once a document has been embedded into the knowledge base', async () => {
    const kb = await openKnowledgeBase();
    const React = require('react');
    const { ResidentsProbe } = require('../../harness/ResidentsProbe');
    kb.engine.seedText('/docs/Downloads/notes.txt', 'The capital of Zenland is Quixotic City. Bananas are yellow.');
    const openSelector = () => kb.rtl.render(React.createElement(ResidentsProbe, {}));

    // Real gesture: add the file → it is read and embedded in the background (lazy-loads the model).
    await kb.addFiles([{ path: '/docs/Downloads/notes.txt', name: 'notes.txt' }]);
    const status = await kb.statusOf('/docs/Downloads/notes.txt');
    await kb.rtl.waitFor(() => expect(status.props.children).toMatch(/· 1 page$/));

    // Result via the In Memory UI: the embedding model co-resides as a sidecar.
    const after = openSelector();
    await kb.rtl.waitFor(() => {
      expect(String(after.getByTestId('probe-residents').props.children)).toContain('embedding');
    }, { timeout: 4000 });
  });
});
