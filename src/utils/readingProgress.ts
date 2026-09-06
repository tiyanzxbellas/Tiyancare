/**
 * Local "reading memory" for the Doujin reader.
 *
 * Persists — per title — the last chapter (and page) that was open in the
 * reader, so closing the tab/app and coming back drops the user right where
 * they left off instead of scrolling the chapter list from the top again.
 *
 * Everything lives in `localStorage` (same pattern as the NekoStream
 * bookmarks/history) — no account or network involved.
 */

import { parseChapterNumber, type ChapterItem } from './doujin';

export interface ReadingProgressEntry {
  /** `mangaLookupKey` of the title this progress belongs to. */
  mangaKey: string;
  mangaTitle?: string;
  chapterId?: string;
  chapterNumber?: string;
  chapterLabel?: string;
  /** 0-based index of the page that was on screen. */
  page: number;
  /** Page count of the chapter when the progress was saved. */
  pageCount?: number;
  /** Set by the store whenever the entry is written. */
  updatedAt: number;
}

/** Payload for `saveReadingProgress` — `updatedAt` is assigned by the store. */
export type ReadingProgressInput = Omit<ReadingProgressEntry, 'updatedAt'> & {
  updatedAt?: number;
};

const STORAGE_KEY = 'tiyancare_doujin_progress_v1';
const MAX_ENTRIES = 100;

const readMap = (): Record<string, ReadingProgressEntry> => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, ReadingProgressEntry>;
  } catch {
    return {};
  }
};

const writeMap = (map: Record<string, ReadingProgressEntry>): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Storage full / blocked (private mode) — reading memory just degrades
    // to "no memory" instead of throwing.
  }
};

export const getReadingProgress = (mangaKey: string): ReadingProgressEntry | null => {
  if (!mangaKey) return null;
  return readMap()[mangaKey] ?? null;
};

export const saveReadingProgress = (entry: ReadingProgressInput): void => {
  if (!entry?.mangaKey) return;
  const map = readMap();
  map[entry.mangaKey] = { ...entry, updatedAt: Date.now() };

  // Keep the store bounded: retain only the most recently read titles.
  const entries = Object.values(map);
  if (entries.length > MAX_ENTRIES) {
    entries.sort((a, b) => b.updatedAt - a.updatedAt);
    const keep = new Set(entries.slice(0, MAX_ENTRIES).map((e) => e.mangaKey));
    for (const key of Object.keys(map)) {
      if (!keep.has(key)) delete map[key];
    }
  }
  writeMap(map);
};

export const clearReadingProgress = (mangaKey?: string): void => {
  if (mangaKey) {
    const map = readMap();
    delete map[mangaKey];
    writeMap(map);
  } else {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }
};

/**
 * Resolves a saved progress back to a concrete chapter from a freshly
 * fetched list: first by chapter id, then by chapter number (the id can
 * change when upstream re-uploads a chapter).
 */
export const findProgressChapter = (
  chapters: ChapterItem[],
  entry: ReadingProgressEntry | null
): ChapterItem | null => {
  if (!entry || !chapters.length) return null;
  if (entry.chapterId) {
    const byId = chapters.find((c) => c.id && c.id === entry.chapterId);
    if (byId) return byId;
  }
  const target = entry.chapterNumber ? parseChapterNumber({ number: entry.chapterNumber }) : null;
  if (target !== null) {
    const byNumber = chapters.find((c) => parseChapterNumber(c) === target);
    if (byNumber) return byNumber;
  }
  return null;
};
