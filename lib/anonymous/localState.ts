export type AnonymousWorkState = {
  seriesId: string; isBookmarked: boolean; isFavorite: boolean; translationCompleted: boolean;
  lastChapterId: string | null; lastPageNumber: number | null; updatedAt: string;
};
export type AnonymousReadingHistory = {
  seriesId: string; chapterId: string | null; lastPageNumber: number; lastReadAt: string;
};
const DB_NAME = "tradumanga-anonymous";
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("works")) db.createObjectStore("works", { keyPath: "seriesId" });
      if (!db.objectStoreNames.contains("history")) db.createObjectStore("history", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function saveAnonymousWork(state: AnonymousWorkState) {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => { const tx=db.transaction("works","readwrite"); tx.objectStore("works").put(state); tx.oncomplete=()=>resolve(); tx.onerror=()=>reject(tx.error); });
  db.close();
}
export async function saveAnonymousReading(state: AnonymousReadingHistory) {
  const db=await openDb(); const key=`${state.seriesId}:${state.chapterId??"none"}`;
  await new Promise<void>((resolve,reject)=>{const tx=db.transaction("history","readwrite");tx.objectStore("history").put({...state,key});tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);}); db.close();
}
async function readAll<T>(storeName:"works"|"history"):Promise<T[]> {
  const db=await openDb();
  return new Promise((resolve,reject)=>{const tx=db.transaction(storeName,"readonly");const request=tx.objectStore(storeName).getAll();request.onsuccess=()=>{db.close();resolve(request.result as T[])};request.onerror=()=>{db.close();reject(request.error)};});
}
export async function getAnonymousManifest() {
  if (typeof window==="undefined" || !("indexedDB" in window)) return {works:[],history:[]};
  return {works:await readAll<AnonymousWorkState>("works"),history:await readAll<AnonymousReadingHistory>("history")};
}
