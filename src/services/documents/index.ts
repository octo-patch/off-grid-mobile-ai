// Composition root for documents on the phone (chat attachments and project knowledge bases): the
// shared ingest and turn services (@offgrid/rag/documents) wired to phone adapters. No rules live
// here; they are shared with desktop.

import {
  DocumentIngestService,
  DocumentTurnService,
  estimateTokens,
  type DocumentSource,
  type Scheduler,
} from '@offgrid/rag/documents';
import { useChatStore } from '../../stores/chatStore';
import logger from '../../utils/logger';
import { HOOKS, registerHook } from '../../bootstrap/hookRegistry';
import { conversationDocuments, referencedDocumentIds } from './conversation';
import { documentExtractor } from './extract';
import { documentEmbedder } from './models';
import { useDocumentProgressStore } from './progressStore';
import { projectDocuments } from './project';
import { documentKeywordSearch, documentStore, forgetConversationExclusions } from './store';

/** Indexing waits while a reply is generating, so it never slows an answer. */
const scheduler: Scheduler = {
  async yieldToForeground() {
    while (useChatStore.getState().isStreaming) await new Promise((resolve) => setTimeout(resolve, 500));
  },
};

const warn = (message: string, error: unknown): void => {
  logger.warn(`[Documents] ${message}:`, error instanceof Error ? error.message : error);
};

export const documentIngest = new DocumentIngestService({
  extract: documentExtractor,
  store: documentStore,
  scheduler,
  embed: documentEmbedder,
  onProgress: (progress) => useDocumentProgressStore.getState().report(progress),
  onWarning: warn,
});

export const documentTurns = new DocumentTurnService({
  ingest: documentIngest,
  store: documentStore,
  conversations: conversationDocuments,
  projects: projectDocuments,
  keyword: documentKeywordSearch,
  embed: documentEmbedder,
  countTokens: estimateTokens,
  onWarning: warn,
});

/** Start reading a document as soon as it is attached (or arrives by sync). */
export function startDocumentIngest(source: DocumentSource): void {
  documentIngest.ingest(source).catch(() => undefined);
}

/** Chats were deleted: drop their exclusions and the documents no other chat uses, now. */
export async function forgetUnreferencedDocuments(conversationIds: string[] = []): Promise<void> {
  try {
    for (const conversationId of conversationIds) forgetConversationExclusions(conversationId);
    await documentIngest.collectGarbage(await referencedDocumentIds(), 0);
  } catch (error) {
    warn('Removing documents of a deleted chat failed', error);
  }
}

// Deleted chats are announced by the chat store, which these services read (so it cannot import them).
registerHook(HOOKS.conversationsDeleted, (conversationIds: string[]) => {
  forgetUnreferencedDocuments(conversationIds).catch(() => undefined);
});

export { documentStore };
