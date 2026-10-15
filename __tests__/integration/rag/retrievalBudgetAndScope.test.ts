/**
 * Whose documents a project chat may read: its own project's knowledge base, never another's.
 *
 * A leak here means one client's contract quoted into another client's chat - the worst failure this app
 * can have, and completely silent. The scope is checked on both paths documents reach the model: the turn
 * itself (prepareTurnDocuments) and the model's own lookup during the turn (search_knowledge_base).
 *
 * How MUCH a turn may read (the budget) is the shared engine's rule (@offgrid/rag/documents
 * documentBudget), tested with the engine; the old phone-only budget code is gone.
 *
 * Everything runs for real over a REAL in-memory SQLite: the files are kept, read, indexed into the
 * document index and filed under their projects in rag.db. Only native leaves are stood in for
 * (harness/documentEngine).
 */
import { installNativeBoundary, GB } from '../../harness/nativeBoundary';
import { installDocumentEngine } from '../../harness/documentEngine';

async function withKnowledgeBases(files: { projectId: string; fileName: string; text: string }[]) {
  const boundary = installNativeBoundary({
    fs: true,
    ram: { platform: 'ios', totalBytes: 8 * GB, availBytes: 6 * GB },
  });
  const engine = installDocumentEngine(boundary.fs!);
  const { knowledgeBase } = require('../../../src/services/rag');
  const { prepareTurnDocuments } = require('../../../src/services/documents/chatTurn');
  const { executeToolCall } = require('../../../src/services/tools/handlers');
  for (const file of files) {
    const path = `/docs/Downloads/${file.fileName}`;
    engine.seedText(path, file.text);
    await knowledgeBase.addFile({ projectId: file.projectId, filePath: path, fileName: file.fileName, fileSize: file.text.length });
    await engine.indexed(await engine.documentIdOf(path));
  }
  return { prepareTurnDocuments, executeToolCall };
}

const TWO_CLIENTS = [
  { projectId: 'client-a', fileName: 'a.txt', text: 'Zenland capital is Quixotic City.' },
  { projectId: 'client-b', fileName: 'b.txt', text: 'Zenland capital is A SECRET FROM CLIENT B.' },
];

describe('what a project chat may read', () => {
  it('a turn reads its own project\'s knowledge base and never another\'s', async () => {
    const { prepareTurnDocuments } = await withKnowledgeBases(TWO_CLIENTS);

    const turn = await prepareTurnDocuments({
      conversationId: 'chat-a',
      projectId: 'client-a',
      question: 'zenland capital',
      systemPrompt: '',
      contextLength: 8192,
      isRemote: false,
    });

    // Both files match the question on content - only the project scope keeps them apart.
    const prompt = `${turn?.stable}\n${turn?.turn}`;
    expect(prompt).toMatch(/Quixotic City/);
    expect(prompt).not.toMatch(/SECRET FROM CLIENT B/);
    expect(turn?.sources.map((source: { name: string }) => source.name)).toEqual(['a.txt']);
  });

  it('the model\'s own knowledge-base search never returns another project\'s passages', async () => {
    const { executeToolCall } = await withKnowledgeBases(TWO_CLIENTS);

    const result = await executeToolCall({
      id: 'tc1',
      name: 'search_knowledge_base',
      arguments: { query: 'zenland capital' },
      context: { projectId: 'client-a' },
    });

    expect(result.content).toMatch(/Quixotic City/);
    expect(result.content).not.toMatch(/SECRET FROM CLIENT B/);
  });
});

describe('the search_knowledge_base tool when there is nothing to give the model', () => {
  it('says the knowledge base has nothing for the question rather than failing', async () => {
    const { executeToolCall } = await withKnowledgeBases(TWO_CLIENTS);

    const result = await executeToolCall({
      id: 'tc2',
      name: 'search_knowledge_base',
      arguments: { query: 'quarterly banana ledger audit' },
      context: { projectId: 'project-with-no-files' },
    });

    // An empty knowledge base is not an error. A tool error makes the model apologise for a broken tool
    // instead of simply answering from what it knows.
    expect(result.error).toBeFalsy();
    expect(result.content).toMatch(/No passages in the knowledge base match "quarterly banana ledger audit"/);
  });

  it('tells the model there is nothing to search when neither a chat nor a project is open', async () => {
    const { executeToolCall } = await withKnowledgeBases(TWO_CLIENTS);

    const result = await executeToolCall({
      id: 'tc3',
      name: 'search_knowledge_base',
      arguments: { query: 'zenland capital' },
      context: {},
    });

    // Told in prose, not handed a tool error: an error makes the model apologise for a broken tool, while
    // an empty result would let it tell the user their documents are missing.
    expect(result.error).toBeFalsy();
    expect(result.content).toMatch(/no chat or project to search/i);
  });
});
