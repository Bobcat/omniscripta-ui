// Service for managing FileSystemFileHandles in IndexedDB
// This allows persistent access to local files across reloads (with browser permission)

const DB_NAME = 'omniscripta_handles';
const STORE_NAME = 'handles';
const DB_VERSION = 1;

let _dbPromise = null;

function _openDB() {
    if (_dbPromise) return _dbPromise;

    _dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };

        request.onsuccess = (event) => {
            resolve(event.target.result);
        };

        request.onerror = (event) => {
            console.error("IndexedDB Error:", event.target.error);
            reject(event.target.error);
        };
    });
    return _dbPromise;
}

async function saveHandle(key, handle) {
    const db = await _openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.put(handle, key);

        req.onsuccess = () => resolve();
        req.onerror = (e) => reject(e.target.error);
    });
}

async function getHandle(key) {
    try {
        const db = await _openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const req = store.get(key);

            req.onsuccess = (e) => resolve(e.target.result);
            req.onerror = (e) => reject(e.target.error);
        });
    } catch (e) {
        console.warn("Error getting handle", e);
        return null;
    }
}

async function deleteHandle(key) {
    try {
        const db = await _openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const req = store.delete(key);

            req.onsuccess = () => resolve();
            req.onerror = (e) => reject(e.target.error);
        });
    } catch (e) {
        console.warn("Error deleting handle", e);
    }
}

export const FileHandleService = {
    saveHandle,
    getHandle,
    deleteHandle
};
