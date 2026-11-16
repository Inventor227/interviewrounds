// The big static files of a round (avatar models, clip libraries, the texture transcoder), fetched once into memory
// with byte progress, so a page can start them before the tap and the room picks them up when it loads.
//
// URLs carry a content version (`?v=`, from the build's list of public files, see vite.config.ts), so the server can
// let the browser keep them for a year: the next round loads them from the cache. A file the build did not list
// keeps its plain URL and revalidates.

import versions from 'virtual:ir-static';

export interface StaticFile {
  /** The first 16 hex digits of the file's SHA-256. */
  v: string;
  bytes: number;
}

const files: Record<string, StaticFile> = versions;

/** The versioned URL of a public file (unchanged when the build does not know it). */
export function versioned(url: string): string {
  const f = files[url];
  return f ? `${url}?v=${f.v}` : url;
}

/** The file's size from the build, or null. */
export function knownSize(url: string): number | null {
  return files[url.split('?')[0]!]?.bytes ?? null;
}

interface Entry {
  p: Promise<ArrayBuffer>;
  loaded: number;
  total: number | null;
}

const entries = new Map<string, Entry>();
/** Files downloaded in full on this page and their sizes (their bytes may be handed over already). */
const finished = new Map<string, number>();
const listeners = new Set<() => void>();
let notifyQueued = false;

function notify(): void {
  if (notifyQueued) return;
  notifyQueued = true;
  // At most one update per task: a fast download reads thousands of chunks.
  setTimeout(() => {
    notifyQueued = false;
    for (const l of [...listeners]) l();
  }, 50);
}

/** Calls back (batched) whenever a tracked download moves. */
export function onBytes(cb: () => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

async function download(url: string, e: Entry): Promise<ArrayBuffer> {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  // Content-Length is the compressed size when the server compresses; the stream gives the file's own bytes.
  if (e.total == null) {
    const len = Number(res.headers.get('content-length'));
    if (!res.headers.get('content-encoding') && len > 0) e.total = len;
  }
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = await res.arrayBuffer();
    e.loaded = buf.byteLength;
    notify();
    return buf;
  }
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    e.loaded += value.byteLength;
    notify();
  }
  const out = new Uint8Array(e.loaded);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  e.total = e.loaded;
  notify();
  return out.buffer;
}

/**
 * Starts (or joins) the download of a file into memory. A failed download is forgotten, so the next call tries again.
 * The bytes stay until take() hands them over.
 */
export function fetchBytes(url: string): Promise<ArrayBuffer> {
  let e = entries.get(url);
  if (!e) {
    const entry: Entry = { p: Promise.resolve(new ArrayBuffer(0)), loaded: 0, total: knownSize(url) };
    entry.p = download(url, entry);
    entry.p.then(
      (buf) => void finished.set(url, buf.byteLength),
      () => undefined,
    );
    entry.p.catch(() => {
      if (entries.get(url) === entry) entries.delete(url);
      notify();
    });
    entries.set(url, entry);
    e = entry;
  }
  return e.p;
}

/** Hands over a file fetched before (and forgets it: later rounds read it from the HTTP cache). Null when none. */
export function takeBytes(url: string): Promise<ArrayBuffer> | null {
  const e = entries.get(url);
  if (!e) return null;
  // Keep the entry until it settles, so progress still counts it; then let it go.
  void e.p.then(
    () => {
      if (entries.get(url) === e) entries.delete(url);
    },
    () => undefined,
  );
  return e.p;
}

/**
 * Bytes so far over the total for these files; total is null while any size is unknown. A file handed over already
 * counts in full; one not started yet counts as nothing.
 */
export function bytesProgress(urls: readonly string[]): { loaded: number; total: number | null } {
  let loaded = 0;
  let total: number | null = 0;
  for (const u of urls) {
    const e = entries.get(u);
    const got = finished.get(u);
    const size = e?.total ?? got ?? knownSize(u);
    if (size == null) total = null;
    else if (total != null) total += size;
    loaded += e ? e.loaded : (got ?? 0);
  }
  return { loaded, total };
}

/** Tests: forget everything. */
export function resetBytes(): void {
  entries.clear();
  finished.clear();
}
