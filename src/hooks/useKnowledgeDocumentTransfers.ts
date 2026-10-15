import { useCallback, useEffect, useRef, useState } from 'react';
import { callHook, HOOKS } from '../bootstrap/hookRegistry';
import {
  knowledgeDocumentTransferKey,
  type KnowledgeDocumentTransfer,
} from '../services/sync/knowledgeDocumentTransfer';

const NO_TRANSFERS: KnowledgeDocumentTransfer[] = [];

function readTransfers(projectId: string): KnowledgeDocumentTransfer[] {
  return (
    callHook<KnowledgeDocumentTransfer[]>(
      HOOKS.syncKnowledgeTransfersSnapshot,
      projectId,
    ) ?? NO_TRANSFERS
  );
}

/**
 * Knowledge-base files of one project moving to or from a paired device.
 *
 * `onReceived` runs when an arriving file's transfer row goes away - the file is in the knowledge
 * base now, so the list should reload to show its own row. Free builds have no sync: the list is
 * always empty and nothing is called.
 */
export function useKnowledgeDocumentTransfers(
  projectId: string,
  onReceived?: () => void,
): {
  transfers: KnowledgeDocumentTransfer[];
  dismiss: (transfer: KnowledgeDocumentTransfer) => void;
} {
  const [transfers, setTransfers] = useState(() => readTransfers(projectId));
  const onReceivedRef = useRef(onReceived);
  onReceivedRef.current = onReceived;

  useEffect(() => {
    let receiving = new Set<string>();
    let shown = '';
    const refresh = (): void => {
      const next = readTransfers(projectId);
      const nextReceiving = new Set(
        next
          .filter(transfer => transfer.direction === 'receive')
          .map(knowledgeDocumentTransferKey),
      );
      const landed = [...receiving].some(key => !nextReceiving.has(key));
      receiving = nextReceiving;
      // Progress ticks for other projects reach this listener too; only redraw on a real change.
      const signature = JSON.stringify(next);
      if (signature !== shown) {
        shown = signature;
        setTransfers(next);
      }
      if (landed) onReceivedRef.current?.();
    };
    refresh();
    const unsubscribe = callHook<() => void>(
      HOOKS.syncKnowledgeTransfersSubscribe,
      refresh,
    );
    return () => unsubscribe?.();
  }, [projectId]);

  const dismiss = useCallback((transfer: KnowledgeDocumentTransfer) => {
    callHook(HOOKS.syncKnowledgeTransferDismiss, transfer);
    setTransfers(current =>
      current.filter(
        item =>
          knowledgeDocumentTransferKey(item) !==
          knowledgeDocumentTransferKey(transfer),
      ),
    );
  }, []);

  return { transfers, dismiss };
}
