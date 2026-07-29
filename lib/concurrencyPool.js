// Kleine, abhaengigkeitsfreie Concurrency-Pool-Utility (Semaphore-Muster).
// Begrenzt, wie viele der uebergebenen async-Funktionen gleichzeitig laufen -
// weitere run()-Aufrufe warten in einer FIFO-Queue, bis ein Slot frei wird.
//
// Bewusst simpel gehalten (kein Cancel-Support hier drin): das jeweilige
// Item selbst prueft sein eigenes Cancel-Signal als allererste Aktion, sobald
// es tatsaechlich zu laufen beginnt (siehe downloader.js processItem()).
export function createPool(limit) {
  let active = 0;
  const queue = [];

  function next() {
    if (active >= limit || queue.length === 0) return;
    active++;
    const { fn, resolve, reject, onStart } = queue.shift();
    onStart?.();
    Promise.resolve()
      .then(fn)
      .then(
        (value) => {
          active--;
          resolve(value);
          next();
        },
        (err) => {
          active--;
          reject(err);
          next();
        }
      );
  }

  return {
    // onStart wird genau dann aufgerufen, wenn fn() tatsaechlich zu laufen
    // beginnt (nicht beim Einreihen) - die UI nutzt das, um zwischen
    // "Waiting..." (noch in der Queue) und "aktiv laedt" zu unterscheiden.
    run(fn, { onStart } = {}) {
      return new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject, onStart });
        next();
      });
    },
  };
}
