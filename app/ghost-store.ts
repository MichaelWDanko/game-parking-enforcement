import {
  decodeGhostRun,
  encodeGhostRun,
  type GhostRun,
} from "./daily-dispatch";

const DATABASE_NAME = "meter-mayhem-game";
const DATABASE_VERSION = 1;
const STORE_NAME = "ghosts";

function indexedDbFactory() {
  return typeof globalThis.indexedDB === "undefined" ? null : globalThis.indexedDB;
}

function openDatabase(factory: IDBFactory) {
  return new Promise<IDBDatabase | null>((resolve) => {
    let settled = false;
    const finish = (database: IDBDatabase | null) => {
      if (settled) {
        database?.close();
        return;
      }
      settled = true;
      resolve(database);
    };
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(DATABASE_NAME, DATABASE_VERSION);
    } catch {
      finish(null);
      return;
    }

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => finish(request.result);
    request.onerror = () => finish(null);
    request.onblocked = () => finish(null);
  });
}

function validatedGhost(value: unknown, challengeId: string, rulesetVersion?: number) {
  const run = decodeGhostRun(value);
  if (!run || run.challengeId !== challengeId) return null;
  if (rulesetVersion !== undefined && run.rulesetVersion !== rulesetVersion) return null;
  return run;
}

export async function loadPersonalBestGhost(
  challengeId: string,
  rulesetVersion?: number,
): Promise<GhostRun | null> {
  const factory = indexedDbFactory();
  if (!factory) return null;

  const database = await openDatabase(factory);
  if (!database) return null;

  try {
    return await new Promise<GhostRun | null>((resolve) => {
      let settled = false;
      const finish = (run: GhostRun | null) => {
        if (settled) return;
        settled = true;
        resolve(run);
      };

      let transaction: IDBTransaction;
      let request: IDBRequest<unknown>;
      try {
        transaction = database.transaction(STORE_NAME, "readonly");
        request = transaction.objectStore(STORE_NAME).get(challengeId);
      } catch {
        finish(null);
        return;
      }

      request.onsuccess = () => {
        finish(validatedGhost(request.result, challengeId, rulesetVersion));
      };
      request.onerror = () => finish(null);
      transaction.onabort = () => finish(null);
      transaction.onerror = () => finish(null);
    });
  } catch {
    return null;
  } finally {
    database.close();
  }
}

export async function savePersonalBestGhost(run: GhostRun): Promise<boolean> {
  let encoded: string;
  let candidate: GhostRun | null;
  try {
    encoded = encodeGhostRun(run);
    candidate = decodeGhostRun(encoded);
  } catch {
    return false;
  }
  if (!candidate) return false;
  const validCandidate = candidate;

  const factory = indexedDbFactory();
  if (!factory) return false;

  const database = await openDatabase(factory);
  if (!database) return false;

  try {
    return await new Promise<boolean>((resolve) => {
      let saved = false;
      let settled = false;
      const finish = (result: boolean) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      let transaction: IDBTransaction;
      let request: IDBRequest<unknown>;
      let store: IDBObjectStore;
      try {
        transaction = database.transaction(STORE_NAME, "readwrite");
        store = transaction.objectStore(STORE_NAME);
        request = store.get(validCandidate.challengeId);
      } catch {
        finish(false);
        return;
      }

      request.onsuccess = () => {
        const existingValue = request.result;
        const existing = decodeGhostRun(existingValue);

        if (
          existing &&
          (existing.challengeId !== validCandidate.challengeId ||
            existing.rulesetVersion !== validCandidate.rulesetVersion ||
            existing.score >= validCandidate.score)
        ) {
          return;
        }

        try {
          store.put(encoded, validCandidate.challengeId);
          saved = true;
        } catch {
          transaction.abort();
        }
      };
      request.onerror = () => finish(false);
      transaction.oncomplete = () => finish(saved);
      transaction.onabort = () => finish(false);
      transaction.onerror = () => finish(false);
    });
  } catch {
    return false;
  } finally {
    database.close();
  }
}
