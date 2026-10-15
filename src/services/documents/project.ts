// ProjectDocumentsPort for the phone: a project's knowledge base, read by the shared turn service
// before the chat's own attachments, so every chat in the project answers from it.

import type { ProjectDocumentsPort } from '@offgrid/rag/documents';
import { useChatStore } from '../../stores/chatStore';
import { knowledgeBase } from '../rag';

export const projectDocuments: ProjectDocumentsPort = {
  async forProject(projectId) {
    return knowledgeBase.sourcesForProject(projectId);
  },
  async forConversation(conversationId) {
    const projectId = useChatStore
      .getState()
      .conversations.find(c => c.id === conversationId)?.projectId;
    return projectId ? knowledgeBase.sourcesForProject(projectId) : [];
  },
};
