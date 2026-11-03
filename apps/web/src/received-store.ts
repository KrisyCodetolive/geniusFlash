// Fichiers reçus conservés dans le navigateur (IndexedDB) : ils restent lisibles après un rechargement,
// sans jamais être enregistrés dans les téléchargements de l’appareil sans l’accord de l’utilisateur.

export type StoredFile = {
  id: string;
  peerId: string;
  peerName: string;
  fileName: string;
  mimeType: string;
  time: number;
  blob: Blob;
};

const DB_NAME = 'geniussend';
const STORE = 'received-files';

let database: Promise<IDBDatabase> | null = null;

function openDatabase() {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  // Une ouverture ratée (navigation privée, stockage bloqué) pourra être retentée plus tard.
  database.catch(() => { database = null; });
  return database;
}

async function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = action(transaction.objectStore(STORE));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function saveReceivedFile(file: StoredFile) {
  // Sans cette demande, le navigateur peut vider le stockage quand l’appareil manque de place.
  void navigator.storage?.persist?.().catch(() => undefined);
  await run('readwrite', (store) => store.put(file));
}

export async function loadReceivedFiles() {
  const files = await run<StoredFile[]>('readonly', (store) => store.getAll());
  return files.sort((a, b) => a.time - b.time);
}

export async function deleteReceivedFile(id: string) {
  await run('readwrite', (store) => store.delete(id));
}
