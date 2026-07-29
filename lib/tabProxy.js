// Führt fetch()-Aufrufe im Kontext eines echten patreon.com-Tabs aus.
// Wichtig, weil: 1) Patreons CDN Cross-Origin-Anfragen aus der Extension-Seite
// (chrome-extension://...) per CORS blockt, und 2) Patreons Login-Cookies
// wegen SameSite=Lax/Strict bei einem Request von einer Extension-Seite aus
// gar nicht erst mitgeschickt würden. Innerhalb eines echten Patreon-Tabs
// bestehen beide Probleme nicht.

async function getOrCreatePatreonTab() {
  const tabs = await chrome.tabs.query({ url: "https://*.patreon.com/*" });
  if (tabs.length > 0) return { tab: tabs[0], created: false };
  const tab = await chrome.tabs.create({ url: "https://www.patreon.com/", active: false });
  await new Promise((resolve) => {
    function listener(tabId, info) {
      if (tabId === tab.id && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    // Sicherheitsnetz, falls "complete" nie sauber feuert
    setTimeout(resolve, 6000);
  });
  return { tab, created: true };
}

async function executeScriptWithTimeout(tabId, details, timeoutMs) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("Timeout during script execution"));
    }, timeoutMs);
  });
  const execPromise = chrome.scripting.executeScript({ target: { tabId }, ...details });
  return Promise.race([execPromise, timeoutPromise]).finally(() => clearTimeout(timer));
}

/**
 * Lädt eine Datei-URL als ArrayBuffer, ausgeführt im Kontext eines patreon.com-Tabs.
 * Meldet echten Lesefortschritt (Bytes vs. Content-Length) über
 * chrome.runtime-Nachrichten zurück, damit das Dashboard eine echte
 * Fortschrittsanzeige inkl. Geschwindigkeit zeigen kann.
 *
 * Achtung: für sehr große Dateien (lange Videos) speicherintensiv, da die Bytes
 * einmal komplett im Arbeitsspeicher landen. Für große Videos ist der
 * "Einzelne Dateien"-Modus (nativer chrome.downloads-Stream) die bessere Wahl.
 */
export async function fetchBytesViaPatreonTab(url, requestId) {
  const { tab, created } = await getOrCreatePatreonTab();
  try {
    const results = await executeScriptWithTimeout(
      tab.id,
      {
        func: async (u, reqId) => {
          try {
            const res = await fetch(u, { credentials: "include" });
            if (!res.ok) return { ok: false, status: res.status };
            const total = Number(res.headers.get("content-length")) || 0;
            const reader = res.body.getReader();
            const chunks = [];
            let received = 0;
            let lastReport = 0;
            // eslint-disable-next-line no-constant-condition
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value);
              received += value.length;
              const now = Date.now();
              if (now - lastReport > 200) {
                lastReport = now;
                try {
                  chrome.runtime.sendMessage({
                    type: "PA_DOWNLOAD_PROGRESS",
                    requestId: reqId,
                    received,
                    total,
                  });
                } catch (e) {
                  /* Empfänger evtl. nicht (mehr) da - ignorieren */
                }
              }
            }
            const buf = new Uint8Array(received);
            let offset = 0;
            for (const chunk of chunks) {
              buf.set(chunk, offset);
              offset += chunk.length;
            }
            try {
              chrome.runtime.sendMessage({
                type: "PA_DOWNLOAD_PROGRESS",
                requestId: reqId,
                received,
                total: total || received,
              });
            } catch (e) {
              /* ignorieren */
            }
            return { ok: true, buffer: buf.buffer };
          } catch (e) {
            return { ok: false, error: e?.message || "fetch fehlgeschlagen" };
          }
        },
        args: [url, requestId || ""],
      },
      45000
    );
    const result = results?.[0]?.result;
    if (!result || !result.ok) {
      throw new Error(
        `Datei konnte nicht geladen werden (${result?.status ? "HTTP " + result.status : result?.error || "unbekannter Fehler"})`
      );
    }
    return result.buffer;
  } finally {
    if (created) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

/**
 * Lädt die Kommentare eines Posts (bestes Bemühen - Patreons Kommentar-API
 * ist nicht offiziell dokumentiert und kann sich ändern; bei Fehlern wird
 * einfach eine leere Liste zurückgegeben statt den Download abzubrechen).
 */
export async function fetchCommentsRaw(numericPostId) {
  const { tab, created } = await getOrCreatePatreonTab();
  try {
    // We include commenter, replies, and replies.commenter to fetch creator answers and replies.
    const url =
      `https://www.patreon.com/api/posts/${numericPostId}/comments` +
      `?include=commenter,replies,replies.commenter&fields[comment]=body,created,reply_count&fields[user]=full_name&page[count]=100&sort=-created`;
    const results = await executeScriptWithTimeout(
      tab.id,
      {
        func: async (u) => {
          try {
            const res = await fetch(u, {
              credentials: "include",
              headers: { accept: "application/vnd.api+json" },
            });
            if (!res.ok) return { ok: false, status: res.status };
            return { ok: true, data: await res.json() };
          } catch (e) {
            return { ok: false, error: e?.message || "fetch failed" };
          }
        },
        args: [url],
      },
      10000
    );
    const result = results?.[0]?.result;
    if (!result || !result.ok) {
      return [];
    }
    const included = new Map();
    (result.data.included || []).forEach((i) => included.set(`${i.type}:${i.id}`, i));
    
    return (result.data.data || []).map((c) => {
      const authorRef = c.relationships?.commenter?.data;
      const author = authorRef ? included.get(`${authorRef.type}:${authorRef.id}`) : null;
      
      // Resolve replies
      const replyRefs = c.relationships?.replies?.data || [];
      const replies = replyRefs.map((ref) => {
        const replyObj = included.get(`${ref.type}:${ref.id}`);
        if (!replyObj) return null;
        const repAuthorRef = replyObj.relationships?.commenter?.data;
        const repAuthor = repAuthorRef ? included.get(`${repAuthorRef.type}:${repAuthorRef.id}`) : null;
        return {
          author: repAuthor?.attributes?.full_name || "?",
          date: replyObj.attributes?.created || null,
          body: replyObj.attributes?.body || "",
        };
      }).filter(Boolean);
      
      // Sort replies chronologically
      replies.sort((a, b) => {
        if (!a.date) return 1;
        if (!b.date) return -1;
        return new Date(a.date) - new Date(b.date);
      });

      return {
        author: author?.attributes?.full_name || "?",
        date: c.attributes?.created || null,
        body: c.attributes?.body || "",
        replies: replies,
      };
    });
  } catch {
    return [];
  } finally {
    if (created) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

/**
 * Fragt eine frische Post-Antwort von Patreons eigener API ab (im Tab-Kontext,
 * damit Cookies mitgeschickt werden) - genutzt, um abgelaufene, signierte
 * Download-URLs kurz vor dem eigentlichen Download zu erneuern.
 */
export async function refetchPostRaw(numericPostId) {
  const { tab, created } = await getOrCreatePatreonTab();
  try {
    const url =
      `https://www.patreon.com/api/posts/${numericPostId}` +
      `?include=media,images,audio,attachments` +
      `&fields[post]=content,teaser_text,post_file,embed,image,thumbnail_url` +
      `&fields[media]=download_url,mimetype,size_bytes,file_name,display`;
    const results = await executeScriptWithTimeout(
      tab.id,
      {
        func: async (u) => {
          try {
            const res = await fetch(u, {
              credentials: "include",
              headers: { accept: "application/vnd.api+json" },
            });
            if (!res.ok) return { ok: false, status: res.status };
            return { ok: true, data: await res.json() };
          } catch (e) {
            return { ok: false, error: e?.message || "fetch fehlgeschlagen" };
          }
        },
        args: [url],
      },
      10000
    );
    const result = results?.[0]?.result;
    if (!result || !result.ok) return null;
    return result.data;
  } finally {
    if (created) chrome.tabs.remove(tab.id).catch(() => {});
  }
}
