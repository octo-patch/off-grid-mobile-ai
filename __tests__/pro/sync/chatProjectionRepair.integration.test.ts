import { installRealSqlite } from '../../harness/sqliteFake';

/**
 * Startup chat repair over the real op-log and the real SQLite op store (only the native binding is
 * replaced). The chat list here is the projection the repair writes into: conversations holding the
 * messages the op-log materialized, exactly what the user would see.
 */
type Conversation = { id: string; messages: Array<{ id: string; text: string }> };

const DESKTOP = 'desktop-device';
const PHONE = 'phone-device';

function chatList() {
  const conversations: Conversation[] = [];
  const materializer = {
    put(entity: string, entityId: string, fields: Record<string, unknown>) {
      if (entity === 'conversation') {
        if (!conversations.some(({ id }) => id === entityId))
          conversations.push({ id: entityId, messages: [] });
        return;
      }
      const conversation = conversations.find(
        ({ id }) => id === fields.conversation_id,
      );
      if (!conversation) return false;
      conversation.messages = conversation.messages.filter(
        ({ id }) => id !== entityId,
      );
      conversation.messages.push({ id: entityId, text: String(fields.content) });
      return true;
    },
    remove(entity: string, entityId: string) {
      for (const conversation of conversations)
        conversation.messages = conversation.messages.filter(
          ({ id }) => id !== entityId,
        );
    },
  };
  return { conversations, materializer };
}

const conversation = (id: string, lamport: number) => ({
  opId: `op-${id}-${lamport}`,
  entity: 'conversation',
  entityId: id,
  kind: 'put' as const,
  fields: { title: id },
  lamport,
  deviceId: DESKTOP,
  ts: lamport,
});

const message = (
  id: string,
  conversationId: string,
  lamport: number,
  over: Record<string, unknown> = {},
) => ({
  opId: `op-${id}-${lamport}`,
  entity: 'message',
  entityId: id,
  kind: 'put' as const,
  fields: {
    conversation_id: conversationId,
    role: 'assistant',
    content: `reply ${id}`,
    created_at: 1_700_000_000_000 + lamport,
  },
  lamport,
  deviceId: DESKTOP,
  ts: lamport,
  ...over,
});

const HISTORY = [
  conversation('c1', 1),
  conversation('c2', 2),
  message('m1', 'c1', 3),
  message('m2', 'c1', 4),
  message('m3', 'c2', 5),
  message('m4', 'c1', 6),
  // Resend on the phone: a concurrent, lower-clock delete still removes the reply for good.
  {
    opId: 'op-m4-delete',
    entity: 'message',
    entityId: 'm4',
    kind: 'delete' as const,
    lamport: 2,
    deviceId: PHONE,
    ts: 2,
  },
  // A row the chat projection cannot display is never replayed.
  message('m5', 'c2', 7, {
    fields: { conversation_id: 'c2', role: 'narrator', content: 'x', created_at: 1 },
  }),
];

function openSync() {
  const sync = require('@offgrid/sync');
  const { opStoreDriver } = require('../../../pro/sync/opStoreDriver');
  const {
    repairMissingChatProjection,
  } = require('../../../pro/sync/chatProjectionRepair');
  sync.migrateOpStore(opStoreDriver);
  let n = 0;
  const launch = (materializer: ReturnType<typeof chatList>['materializer']) =>
    new sync.OpLog({
      deviceId: PHONE,
      materializer,
      persist: (op: unknown) =>
        sync.persistOp(opStoreDriver, op, { lazyFields: true }),
      persisted: sync.loadWinningOps(opStoreDriver, { lazyFields: true }),
      persistedEntityVersionVector: sync.loadOpWatermarks(opStoreDriver),
      uuid: () => `phone-op-${++n}`,
      now: () => 1_700_000_000_000,
    });
  return { launch, repairMissingChatProjection };
}

const shown = (conversations: Conversation[]) =>
  Object.fromEntries(
    conversations.map(({ id, messages }) => [
      id,
      messages.map(({ id: messageId, text }) => `${messageId}:${text}`).sort(),
    ]),
  );

describe('chat projection repair at startup', () => {
  it('restores exactly the missing winners after a relaunch, duplicate delivery included', () => {
    installRealSqlite();
    const { launch, repairMissingChatProjection } = openSync();

    const before = chatList();
    const first = launch(before.materializer);
    first.ingest(HISTORY);
    first.ingest(HISTORY);
    expect(shown(before.conversations)).toEqual({
      c1: ['m1:reply m1', 'm2:reply m2'],
      c2: ['m3:reply m3', 'm5:x'],
    });

    // Relaunch with a chat list saved before most of the history arrived.
    const after = chatList();
    after.conversations.push({
      id: 'c1',
      messages: [{ id: 'm1', text: 'reply m1' }],
    });
    const log = launch(after.materializer);

    expect(
      repairMissingChatProjection(log, undefined, () => after.conversations),
    ).toBe(3);
    expect(shown(after.conversations)).toEqual({
      c1: ['m1:reply m1', 'm2:reply m2'],
      c2: ['m3:reply m3'],
    });
    expect(
      repairMissingChatProjection(log, undefined, () => after.conversations),
    ).toBe(0);
    expect(shown(after.conversations)).toEqual({
      c1: ['m1:reply m1', 'm2:reply m2'],
      c2: ['m3:reply m3'],
    });
  });

  it('repairs one conversation without touching the others', () => {
    installRealSqlite();
    const { launch, repairMissingChatProjection } = openSync();
    launch(chatList().materializer).ingest(HISTORY);

    const after = chatList();
    after.conversations.push(
      { id: 'c1', messages: [] },
      { id: 'c2', messages: [] },
    );
    const log = launch(after.materializer);

    expect(
      repairMissingChatProjection(log, 'c1', () => after.conversations),
    ).toBe(2);
    expect(shown(after.conversations)).toEqual({
      c1: ['m1:reply m1', 'm2:reply m2'],
      c2: [],
    });
  });
});
