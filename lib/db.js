// Kleine IndexedDB-Hülle. Kein Framework, damit es überall (Background + Dashboard) importierbar bleibt.

const DB_NAME = "patreon_archiver";
const DB_VERSION = 2;

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("creators")) {
        db.createObjectStore("creators", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("posts")) {
        const posts = db.createObjectStore("posts", { keyPath: "id" });
        posts.createIndex("creatorId", "creatorId", { unique: false });
        posts.createIndex("publishedAt", "publishedAt", { unique: false });
      }
      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

export async function upsertCreator(creator) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const store = tx(db, "creators", "readwrite");
    const getReq = store.get(creator.id);
    getReq.onsuccess = () => {
      const existing = getReq.result || {};
      const merged = { ...existing, ...creator, lastScanned: Date.now() };
      // Falls der neue Scan keine Mitgliedschaft ermitteln konnte (null/undefined),
      // eine früher erfolgreich ermittelte NICHT überschreiben.
      if ((creator.membership === null || creator.membership === undefined) && existing.membership) {
        merged.membership = existing.membership;
      }
      const putReq = store.put(merged);
      putReq.onsuccess = () => resolve(merged);
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

export async function getAllCreators() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = tx(db, "creators", "readonly").getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteCreator(creatorId) {
  const db = await openDB();
  const posts = await getPostsForCreator(creatorId);
  await Promise.all(posts.map((p) => deletePost(p.id)));
  return new Promise((resolve, reject) => {
    const req = tx(db, "creators", "readwrite").delete(creatorId);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function upsertPosts(posts) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const store = tx(db, "posts", "readwrite");
    let remaining = posts.length;
    if (remaining === 0) return resolve();
    posts.forEach((post) => {
      const getReq = store.get(post.id);
      getReq.onsuccess = () => {
        const existing = getReq.result || {};
        // Download-Status der bereits vorhandenen Dateien/Thumbnail/Video behalten
        const cleanUrl = (u) => u ? u.split("?")[0] : "";
        const isSameUrl = (ua, ub) => {
          if (!ua || !ub) return false;
          return cleanUrl(ua) === cleanUrl(ub);
        };

        const mergedFiles = (post.files || []).map((f) => {
          const old = (existing.files || []).find((of) => isSameUrl(of.url, f.url) || (of.filename && of.filename === f.filename));
          if (old) {
            return {
              ...f,
              downloaded: f.downloaded || old.downloaded,
              localPath: f.localPath || old.localPath,
              sizeBytes: f.sizeBytes || old.sizeBytes || null
            };
          }
          return f;
        });

        const mergedThumbnail = (() => {
          if (!post.thumbnail) return null;
          if (!existing.thumbnail) return post.thumbnail;
          const same = isSameUrl(post.thumbnail.url, existing.thumbnail.url);
          return {
            ...post.thumbnail,
            downloaded: same ? (post.thumbnail.downloaded || existing.thumbnail.downloaded) : post.thumbnail.downloaded,
            sizeBytes: post.thumbnail.sizeBytes || (same ? existing.thumbnail.sizeBytes : null) || null
          };
        })();

        const mergedVideo = (() => {
          if (!post.video) return null;
          if (!existing.video) return post.video;
          const same = isSameUrl(post.video.url, existing.video.url) || (post.video.filename && post.video.filename === existing.video.filename);
          return {
            ...post.video,
            downloaded: same ? (post.video.downloaded || existing.video.downloaded) : post.video.downloaded,
            sizeBytes: post.video.sizeBytes || (same ? existing.video.sizeBytes : null) || null
          };
        })();

        const merged = { ...existing, ...post, files: mergedFiles, thumbnail: mergedThumbnail, video: mergedVideo };
        const putReq = store.put(merged);
        putReq.onsuccess = () => {
          remaining -= 1;
          if (remaining === 0) resolve();
        };
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  });
}

export async function getPostsForCreator(creatorId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const idx = tx(db, "posts", "readonly").index("creatorId");
    const req = idx.getAll(IDBKeyRange.only(creatorId));
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function deletePost(postId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = tx(db, "posts", "readwrite").delete(postId);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function updateFileDownloadStatus(postId, fileUrl, status) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const store = tx(db, "posts", "readwrite");

    function applyUpdate(post) {
      if (!post) return resolve();
      post.files = (post.files || []).map((f) =>
        f.url === fileUrl ? { ...f, ...status } : f
      );
      if (post.thumbnail && post.thumbnail.url === fileUrl) {
        post.thumbnail = { ...post.thumbnail, ...status };
      }
      if (post.video && post.video.url === fileUrl) {
        post.video = { ...post.video, ...status };
      }
      const putReq = store.put(post);
      putReq.onsuccess = () => resolve(post);
      putReq.onerror = () => reject(putReq.error);
    }

    const getReq = store.get(postId);
    getReq.onsuccess = () => {
      let post = getReq.result;
      if (!post && typeof postId === "string" && !isNaN(postId)) {
        const numReq = store.get(Number(postId));
        numReq.onsuccess = () => applyUpdate(numReq.result);
        numReq.onerror = () => reject(numReq.error);
      } else if (!post && typeof postId === "number") {
        const strReq = store.get(String(postId));
        strReq.onsuccess = () => applyUpdate(strReq.result);
        strReq.onerror = () => reject(strReq.error);
      } else {
        applyUpdate(post);
      }
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

// Marks a post's description/comments ("extras") as downloaded.
// Used for text-only posts that have no files/thumbnail/video.
export async function updatePostExtrasDownloaded(postId, downloaded) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const store = tx(db, "posts", "readwrite");
    const getReq = store.get(postId);
    getReq.onsuccess = () => {
      const post = getReq.result;
      if (!post) return resolve();
      post.extrasDownloaded = downloaded;
      const putReq = store.put(post);
      putReq.onsuccess = () => resolve(post);
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}


const DEFAULT_SETTINGS = {
  id: "main",
  // Zielordner. Bevorzugt ein vollständiger Pfad über die Brücke (z.B.
  // "F:\ASSETS_02\PATREON"). Ist er leer, faellt der Download auf den
  // Chrome-Downloads-Ordner + Unterordner zurueck (nur wenn keine Bruecke da ist).
  customFullPath: "",
  subfolderPath: "PatreonArchiver", // nur relevant fuer den Downloads-Fallback
  videoQuality: "best",
  // Legacy-Felder (nicht mehr aktiv genutzt, aber fuer Rueckwaertskompatibilitaet belassen)
  downloadMode: "bridge",
  dirHandle: null,
  dirHandleName: null,
  naming: {
    datePosition: "none", // "prefix" | "suffix" | "none"
    includePostId: false,
  },
  // --- Neue Feature-Settings ---
  includeThumbnails: true, // Thumbnails mit herunterladen?
  includeComments: true, // Kommentare als .txt mit speichern?
  includeDescription: true, // Beschreibungstext als .txt mit speichern?
  askBeforeLargeFiles: false, // Vor grossen Dateien nachfragen? (Standard: aus)
  largeFileThresholdMB: 500, // Ab welcher Groesse gefragt wird (in MB)
  fetchSizesDuringScan: false, // Dateigroessen beim Scannen ermitteln
};

export async function getSettings() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = tx(db, "settings", "readonly").get("main");
    req.onsuccess = () => resolve({ ...DEFAULT_SETTINGS, ...(req.result || {}) });
    req.onerror = () => reject(req.error);
  });
}

export async function saveSettings(partial) {
  const db = await openDB();
  const current = await getSettings();
  const merged = {
    ...current,
    ...partial,
    naming: { ...current.naming, ...(partial.naming || {}) },
    id: "main",
  };
  return new Promise((resolve, reject) => {
    const req = tx(db, "settings", "readwrite").put(merged);
    req.onsuccess = () => resolve(merged);
    req.onerror = () => reject(req.error);
  });
}
