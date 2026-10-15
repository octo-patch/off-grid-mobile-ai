// Background reading and indexing progress per document, for attachment chips and the chat's
// Documents sheet.

import { create } from 'zustand';
import type { DocumentProgress } from '@offgrid/rag/documents';

interface DocumentProgressState {
  byId: Record<string, DocumentProgress>;
  report: (progress: DocumentProgress) => void;
}

export const useDocumentProgressStore = create<DocumentProgressState>((set) => ({
  byId: {},
  report: (progress) => set((state) => ({ byId: { ...state.byId, [progress.id]: progress } })),
}));

interface DocumentTurnStatusState {
  /** The live line a chat shows while its turn opens, searches and ranks documents (describeTurnStatus). */
  byConversation: Record<string, string>;
  set: (conversationId: string, text: string | null) => void;
}

export const useDocumentTurnStatusStore = create<DocumentTurnStatusState>((set) => ({
  byConversation: {},
  set: (conversationId, text) =>
    set((state) => {
      const byConversation = { ...state.byConversation };
      if (text) byConversation[conversationId] = text;
      else delete byConversation[conversationId];
      return { byConversation };
    }),
}));
