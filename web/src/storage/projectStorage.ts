import type { DocumentState } from "@app/shared-types";

const DB_NAME = "wasm-photoshop-mvp";
const DB_VERSION = 1;
const STORE_NAME = "projects";

export interface StoredProject {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  width: number;
  height: number;
  state: DocumentState;
  flattenedPng: ArrayBuffer;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);
    const request = action(store);

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function saveProject(project: Omit<StoredProject, "id" | "createdAt" | "updatedAt">) {
  const now = new Date().toISOString();
  const record: StoredProject = {
    ...project,
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
  };
  await withStore("readwrite", (store) => store.put(record));
  return record;
}

export async function updateProject(
  id: string,
  payload: Pick<StoredProject, "name" | "width" | "height" | "state" | "flattenedPng">,
) {
  const current = await loadProject(id);
  if (!current) {
    throw new Error("Project not found");
  }
  const record: StoredProject = {
    ...current,
    ...payload,
    updatedAt: new Date().toISOString(),
  };
  await withStore("readwrite", (store) => store.put(record));
  return record;
}

export function listProjects(): Promise<StoredProject[]> {
  return withStore("readonly", (store) => store.getAll());
}

export function loadProject(id: string): Promise<StoredProject | undefined> {
  return withStore("readonly", (store) => store.get(id));
}

export async function deleteProject(id: string): Promise<void> {
  await withStore("readwrite", (store) => store.delete(id));
}
