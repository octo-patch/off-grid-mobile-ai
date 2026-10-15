/**
 * BATCH 9 — Knowledge Base add → read → answerable round-trip, and the lifecycle around it.
 *
 * on-device test-plan lines 1409-1549 (Knowledge Base cases 11-30). The knowledge base keeps WHICH files
 * belong to a project (rag.db); the shared document engine reads, indexes and searches them (documents.db),
 * the same engine chat attachments use. These cases drive the real knowledgeBase end to end and judge it by
 * what the user gets back: the list, and what a project chat can read.
 *
 * Everything above the native line is real: knowledgeBase, documentService (keeps a copy of the file),
 * the shared ingest + turn services, both SQLite stores. The ONLY stand-ins are native (harness/
 * documentEngine): op-sqlite is a real in-memory node:sqlite, the filesystem is memfs, the PDF reader reads
 * the kept file, the embedding model answers through llama.rn.
 */
import { installNativeBoundary, GB } from '../harness/nativeBoundary';
import { installDocumentEngine } from '../harness/documentEngine';

const PROJECT = 'proj-energy';
const SOLAR_DOC = 'Solar panels on the roof convert sunlight to electricity for the house.';
const BATTERY_DOC = 'The home battery stores excess energy for use overnight.';

function setup() {
  const boundary = installNativeBoundary({ fs: true, ram: { platform: 'ios', totalBytes: 8 * GB, availBytes: 6 * GB } });
  const engine = installDocumentEngine(boundary.fs!);
  const { knowledgeBase } = require('../../src/services/rag');
  const { documentService } = require('../../src/services/documentService');
  const { documentStore } = require('../../src/services/documents/store');
  const { prepareTurnDocuments } = require('../../src/services/documents/chatTurn');
  const { useChatStore } = require('../../src/stores/chatStore');
  const fs = boundary.fs!;

  /** Put a file in Downloads and add it to the project, the way the picker hands it over. */
  const add = async (fileName: string, text: string, projectId = PROJECT) => {
    const path = `/docs/Downloads/${fileName}`;
    engine.seedText(path, text);
    const id: number = await knowledgeBase.addFile({ projectId, filePath: path, fileName, fileSize: text.length });
    await engine.indexed(await engine.documentIdOf(path));
    return id;
  };
  /** What a project chat reads on its next question. */
  const projectReads = async (question: string, projectId = PROJECT): Promise<string> => {
    const turn = await prepareTurnDocuments({
      conversationId: `chat-${projectId}`,
      projectId,
      question,
      systemPrompt: '',
      contextLength: 8192,
      isRemote: false,
    });
    return turn ? `${turn.stable}\n${turn.turn}` : '';
  };
  return { engine, fs, knowledgeBase, documentService, documentStore, useChatStore, add, projectReads };
}

describe('BATCH 9 — KB add → read → answerable round-trip', () => {
  it('lists an added document with its name and size, and a project chat can read it (case 14/15/16/17)', async () => {
    const h = setup();
    await h.add('solar.txt', SOLAR_DOC);

    const docs = await h.knowledgeBase.getDocumentsByProject(PROJECT);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ name: 'solar.txt', size: SOLAR_DOC.length, enabled: 1 });
    // The knowledge base keeps its own copy, so the row survives the original leaving Downloads.
    expect(docs[0].path).toMatch(/^\/docs\/attachments\//);
    await h.fs.module.unlink('/docs/Downloads/solar.txt');

    expect(await h.projectReads('How does the house get electricity?')).toContain(SOLAR_DOC);
  });

  it('a document switched off is not read; switched on again, it is (case 19/20)', async () => {
    const h = setup();
    const docId = await h.add('solar.txt', SOLAR_DOC);
    expect(await h.projectReads('solar panels')).toContain(SOLAR_DOC);

    await h.knowledgeBase.toggleDocument(docId, false);
    expect((await h.knowledgeBase.getDocumentsByProject(PROJECT))[0].enabled).toBe(0);
    expect(await h.projectReads('solar panels')).not.toContain(SOLAR_DOC);

    await h.knowledgeBase.toggleDocument(docId, true);
    expect(await h.projectReads('solar panels')).toContain(SOLAR_DOC);
  });

  it('removing a document drops its row, its kept copy and its index entry (case 25/26)', async () => {
    const h = setup();
    const docId = await h.add('solar.txt', SOLAR_DOC);
    const [row] = await h.knowledgeBase.getDocumentsByProject(PROJECT);
    expect(await h.fs.exists(row.path)).toBe(true);
    expect(await h.documentStore.getDocument(row.document_id)).not.toBeNull();

    await h.knowledgeBase.deleteDocument(docId);

    // Empty list, nothing on disk, nothing left in the index for a chat to read.
    expect(await h.knowledgeBase.getDocumentsByProject(PROJECT)).toHaveLength(0);
    expect(await h.fs.exists(row.path)).toBe(false);
    await waitFor(async () => (await h.documentStore.getDocument(row.document_id)) === null);
    expect(await h.projectReads('solar panels')).toBe('');
  });

  it('keeps the index entry of a removed file a chat still uses', async () => {
    const h = setup();
    const docId = await h.add('solar.txt', SOLAR_DOC);
    const [row] = await h.knowledgeBase.getDocumentsByProject(PROJECT);
    // The same file is attached in a chat.
    h.engine.seedText('/docs/Downloads/solar-copy.txt', SOLAR_DOC);
    const attachment = await h.documentService.attachDocument('/docs/Downloads/solar-copy.txt', 'solar-copy.txt');
    const chatId = h.useChatStore.getState().createConversation('model-1', 'Energy');
    h.useChatStore.getState().addMessage(chatId, { role: 'user', content: 'see file', attachments: [attachment] });
    expect(attachment.documentId).toBe(row.document_id);

    await h.knowledgeBase.deleteDocument(docId);

    // The chat can still read it: removing it from the project did not pull it from under the chat.
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(await h.documentStore.getDocument(row.document_id)).not.toBeNull();
  });

  it('deleting a project\'s documents removes every one of them, and only that project\'s', async () => {
    const h = setup();
    await h.add('solar.txt', SOLAR_DOC);
    await h.add('battery.txt', BATTERY_DOC);
    await h.add('other.txt', 'Another project keeps this.', 'proj-other');

    await h.knowledgeBase.deleteProjectDocuments(PROJECT);

    expect(await h.knowledgeBase.getDocumentsByProject(PROJECT)).toHaveLength(0);
    expect(await h.projectReads('solar battery')).toBe('');
    expect(await h.knowledgeBase.getDocumentsByProject('proj-other')).toHaveLength(1);
  });

  it('can add a document after the list was fully cleared (case 27)', async () => {
    const h = setup();
    const firstId = await h.add('first.txt', SOLAR_DOC);
    await h.knowledgeBase.deleteDocument(firstId);
    expect(await h.knowledgeBase.getDocumentsByProject(PROJECT)).toHaveLength(0);

    await h.add('second.txt', BATTERY_DOC);

    const docs = await h.knowledgeBase.getDocumentsByProject(PROJECT);
    expect(docs.map((doc: { name: string }) => doc.name)).toEqual(['second.txt']);
  });

  it('rejects adding the same file twice, by name or by content (dedupe guard)', async () => {
    const h = setup();
    await h.add('dup.txt', SOLAR_DOC);

    await expect(h.add('dup.txt', SOLAR_DOC)).rejects.toThrow('already in the knowledge base');
    // The same bytes under another name are the same document.
    await expect(h.add('renamed.txt', SOLAR_DOC)).rejects.toThrow('already in the knowledge base');
    expect(await h.knowledgeBase.getDocumentsByProject(PROJECT)).toHaveLength(1);
  });

  it('a pasted note becomes a document of its own that a chat can read', async () => {
    const h = setup();
    await h.knowledgeBase.addPastedText({ projectId: PROJECT, title: 'Wifi', text: 'The office wifi password is on the fridge.' });

    const docs = await h.knowledgeBase.getDocumentsByProject(PROJECT);
    expect(docs).toHaveLength(1);
    expect(docs[0].name).toMatch(/\.txt$/);
    await h.engine.indexed(docs[0].document_id);
    expect(await h.projectReads('Where is the wifi password?')).toContain('on the fridge');
  });
});

describe('BATCH 9 — KB rejects unsupported / oversized docs (real DocumentService)', () => {
  it('rejects an unsupported file type (.exe)', async () => {
    const h = setup();
    h.fs.seedFile('/docs/Downloads/malware.exe', 2048);

    await expect(
      h.knowledgeBase.addFile({ projectId: PROJECT, filePath: '/docs/Downloads/malware.exe', fileName: 'malware.exe', fileSize: 2048 }),
    ).rejects.toThrow('Unsupported file type');
    expect(await h.knowledgeBase.getDocumentsByProject(PROJECT)).toHaveLength(0);
  });

  it('rejects a file larger than 1 GB, and accepts one far over the old 5 MB limit', async () => {
    const h = setup();
    h.engine.seedText('/docs/Downloads/huge.txt', 'too big', 1024 * 1024 * 1024 + 1);
    h.engine.seedText('/docs/Downloads/big.txt', SOLAR_DOC, 50 * 1024 * 1024);

    await expect(
      h.knowledgeBase.addFile({ projectId: PROJECT, filePath: '/docs/Downloads/huge.txt', fileName: 'huge.txt', fileSize: 0 }),
    ).rejects.toThrow('File is too large');
    await h.knowledgeBase.addFile({ projectId: PROJECT, filePath: '/docs/Downloads/big.txt', fileName: 'big.txt', fileSize: 0 });

    const docs = await h.knowledgeBase.getDocumentsByProject(PROJECT);
    expect(docs.map((doc: { name: string; size: number }) => [doc.name, doc.size])).toEqual([['big.txt', 50 * 1024 * 1024]]);
  });
});

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition never held');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
