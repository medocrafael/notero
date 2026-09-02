import { getRawSyncedNotesMetadataFromAttachment } from '../src/content/data/item-data';
import { asLocalConnectionIdentity } from '../src/content/sync/note-sync-transaction/identity-v4';
import {
  StaleRootRevisionError,
  ZoteroTransactionalMetadataStoreV4,
} from '../src/content/sync/note-sync-transaction/metadata-store-adapter';
import { createIdleRecordV4 } from '../src/content/sync/note-sync-transaction/model-v4';
import { SYSTEM_RUNTIME_CLOCK } from '../src/content/sync/note-sync-transaction/runtime-clock';
import type { TargetIdentity } from '../src/content/sync/note-sync-transaction/types-v4';
import { ZoteroRuntimeAdapter } from '../src/content/sync/note-sync-transaction/zotero-runtime-adapter';

const SAFE_LABEL = 'SAFE TO DELETE — Notero FSM v2 runtime smoke';
const SYNTHETIC_PAGE_ID = '00000000000000000000000000000001';

type SmokeCheck = {
  detail: string;
  name: string;
  status: 'FAIL' | 'PASS';
};

type SmokeResult = {
  checks: SmokeCheck[];
  created: {
    attachmentID: Zotero.DataObjectID | null;
    noteID: Zotero.DataObjectID | null;
    parentID: Zotero.DataObjectID | null;
  };
  environment: 'dedicated-zotero-9.0.6-profile-only';
  label: typeof SAFE_LABEL;
  notionConnected: false;
  overall: 'FAIL' | 'PASS';
  scope: 'production-runtime-adapter-and-schema-v4-store';
  sqliteAccessed: false;
};

type ZoteroItemConstructor = new (itemType: string) => Zotero.Item;

function isZoteroItemConstructor(
  value: unknown,
): value is ZoteroItemConstructor {
  return typeof value === 'function';
}

function check(
  checks: SmokeCheck[],
  name: string,
  condition: boolean,
  detail: string,
): void {
  checks.push({ detail, name, status: condition ? 'PASS' : 'FAIL' });
  if (!condition) throw new Error(`${name}: ${detail}`);
}

async function createSyntheticObjects(): Promise<{
  attachment: Zotero.Item;
  note: Zotero.Item;
  parent: Zotero.Item;
}> {
  const itemConstructor: unknown = Reflect.get(Zotero, 'Item');
  if (!isZoteroItemConstructor(itemConstructor)) {
    throw new Error('Zotero.Item constructor is unavailable');
  }
  const Item = itemConstructor;
  const parent = new Item('journalArticle');
  parent.setField('title', SAFE_LABEL);
  await parent.saveTx({ skipNotifier: true });

  const note = new Item('note');
  note.parentID = parent.id;
  note.setNote(`<p>${SAFE_LABEL}</p><p>Synthetic metadata smoke only.</p>`);
  await note.saveTx({ skipNotifier: true });

  const attachment = await Zotero.Attachments.linkFromURL({
    parentItemID: parent.id,
    saveOptions: { skipNotifier: true },
    title: `${SAFE_LABEL} metadata`,
    url: `https://www.notion.so/${SYNTHETIC_PAGE_ID}`,
  });
  attachment.setNote(`<p>${SAFE_LABEL}</p>`);
  await attachment.saveTx({ skipNotifier: true });
  return { attachment, note, parent };
}

async function runNoteroZotero9RuntimeSmoke(): Promise<SmokeResult> {
  const checks: SmokeCheck[] = [];
  const result: SmokeResult = {
    checks,
    created: { attachmentID: null, noteID: null, parentID: null },
    environment: 'dedicated-zotero-9.0.6-profile-only',
    label: SAFE_LABEL,
    notionConnected: false,
    overall: 'FAIL',
    scope: 'production-runtime-adapter-and-schema-v4-store',
    sqliteAccessed: false,
  };

  try {
    const { attachment, note, parent } = await createSyntheticObjects();
    result.created = {
      attachmentID: attachment.id,
      noteID: note.id,
      parentID: parent.id,
    };

    const runtime = new ZoteroRuntimeAdapter();
    runtime.assertCapabilities(attachment);
    await runtime.reloadItems([attachment.id]);
    check(
      checks,
      'receiver-bound Items.reload',
      runtime.getItem(attachment.id).id === attachment.id,
      'Production adapter reloaded and retrieved the exact synthetic attachment.',
    );

    const directTransactionResult = await runtime.executeTransaction(
      async () => {
        check(
          checks,
          'receiver-bound DB.inTransaction',
          runtime.inTransaction(),
          'Production adapter observed the active Zotero DB transaction.',
        );
        await runtime.reloadItems([attachment.id]);
        return runtime.getItem(attachment.id).id;
      },
    );
    check(
      checks,
      'receiver-bound DB.executeTransaction',
      directTransactionResult === attachment.id,
      'Production adapter completed a transaction with an in-transaction reload.',
    );

    const target: TargetIdentity = {
      connectionID: asLocalConnectionIdentity(
        'zotero-9-isolated-runtime-smoke',
      ),
      databaseID: 'synthetic-database-runtime-smoke',
      identityType: 'legacy-local',
      libraryID: note.libraryID,
      noteItemKey: note.key,
      pageID: SYNTHETIC_PAGE_ID,
      parentItemKey: parent.key,
      workspaceID: 'synthetic-workspace-runtime-smoke',
    };
    const initial = createIdleRecordV4(target, SYSTEM_RUNTIME_CLOCK);
    const metadataBefore = getRawSyncedNotesMetadataFromAttachment(attachment);
    const store = new ZoteroTransactionalMetadataStoreV4(
      parent,
      note.key,
      initial,
      SYSTEM_RUNTIME_CLOCK,
      runtime,
    );
    const loaded = await store.load();
    check(
      checks,
      'metadata load',
      loaded.containerGeneration === 0 &&
        loaded.rootRevision === 0 &&
        loaded.record.revision === 0,
      'Fresh synthetic metadata loaded at root/note revision and container generation zero.',
    );

    const persisted = await store.persist(
      {
        noteRevision: loaded.record.revision,
        rootRevision: loaded.rootRevision,
      },
      loaded.record,
    );
    check(
      checks,
      'transactional reload/compare/merge/save',
      persisted.containerGeneration === 0 &&
        persisted.rootRevision === 1 &&
        persisted.record.revision === 1,
      'Production metadata store atomically advanced both revisions once.',
    );

    let staleWriterError: unknown;
    try {
      await store.persist(
        {
          noteRevision: loaded.record.revision,
          rootRevision: loaded.rootRevision,
        },
        loaded.record,
      );
    } catch (error) {
      staleWriterError = error;
    }
    check(
      checks,
      'stale root writer rejection',
      staleWriterError instanceof StaleRootRevisionError,
      'Production metadata store rejected the stale pre-commit root revision.',
    );

    const restartedStore = new ZoteroTransactionalMetadataStoreV4(
      parent,
      note.key,
      initial,
      SYSTEM_RUNTIME_CLOCK,
      new ZoteroRuntimeAdapter(),
    );
    const reloaded = await restartedStore.load();
    check(
      checks,
      'fresh adapter reload verification',
      reloaded.containerGeneration === 0 &&
        reloaded.rootRevision === 1 &&
        reloaded.record.revision === 1,
      'A fresh production adapter observed the exact committed revisions.',
    );
    await runtime.reloadItems([attachment.id]);
    const freshAttachment = runtime.getItem(attachment.id);
    const metadataAfter =
      getRawSyncedNotesMetadataFromAttachment(freshAttachment);
    check(
      checks,
      'production setNote/save persistence',
      Boolean(metadataAfter && metadataAfter !== metadataBefore),
      'The reviewed production store persisted schema-v4 metadata through the synthetic linked attachment.',
    );

    result.overall = 'PASS';
    Zotero.debug(`[Notero runtime smoke] ${JSON.stringify(result)}`);
    return result;
  } catch (error) {
    checks.push({
      detail:
        error instanceof Error
          ? `Smoke failed with ${error.name}`
          : 'Unknown smoke error',
      name: 'unhandled smoke failure',
      status: 'FAIL',
    });
    Zotero.debug(`[Notero runtime smoke] ${JSON.stringify(result)}`);
    return result;
  }
}

Object.assign(globalThis, { runNoteroZotero9RuntimeSmoke });
