/**
 * Shared helpers for the DoujinDesu views.
 *
 * The upstream API is undocumented and has shipped several different response
 * envelopes over time, so every reader here is deliberately tolerant: it looks
 * for a list/field under any of the known key spellings instead of assuming a
 * single shape (an assumption that previously produced empty grids and broken
 * links).
 */

export type AnyRecord = Record<string, any>;

/** Extracts the first array found in a response envelope. */
export const listFromResponse = (payload: unknown): AnyRecord[] => {
  if (Array.isArray(payload)) return payload as AnyRecord[];
  if (!payload || typeof payload !== 'object') return [];

  const source = payload as AnyRecord;
  for (const key of ['data', 'items', 'rows', 'results', 'manga', 'mangas', 'posts']) {
    if (Array.isArray(source[key])) return source[key];
  }
  for (const key of ['data', 'result', 'response']) {
    if (source[key] && typeof source[key] === 'object') {
      const nested = listFromResponse(source[key]);
      if (nested.length) return nested;
    }
  }
  return [];
};

/** Unwraps `{ data: {...} }` / `{ result: {...} }` style single-object envelopes. */
export const objectFromResponse = (payload: unknown): AnyRecord | null => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const source = payload as AnyRecord;
  for (const key of ['data', 'manga', 'chapter', 'result', 'response']) {
    const nested = source[key];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      return nested as AnyRecord;
    }
  }
  return source;
};

export const numberFromResponse = (payload: unknown, fallback: number): number => {
  if (!payload || typeof payload !== 'object') return fallback;
  const source = payload as AnyRecord;
  const value =
    source.total ?? source.totalItems ?? source.count ?? source.pagination?.total ?? source.meta?.total;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

export interface MangaItem extends AnyRecord {
  /** Database identifier (often a UUID). Never use it to build a site URL. */
  id?: string;
  /** Human-readable URL segment used by the public website. */
  slug?: string;
  title?: string;
  type?: string;
  thumbnail?: string;
  image?: string;
  score?: number | string;
  status?: string;
}

const firstString = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when the value looks like an opaque id rather than a website slug. */
export const looksLikeId = (value?: string): boolean =>
  !value || UUID_RE.test(value) || /^\d+$/.test(value);

/**
 * Featured items are not manga records: their own `id` identifies the
 * featured slot and the manga target is only exposed as `link_url`, for
 * example `/manga/get-out-of-here`. Pull the real slug out of that link so a
 * featured card does not request `/manga/<featured-item-id>` and receive
 * "Manga not found".
 */
export const mangaSlugFromLink = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim()) continue;

    try {
      const pathname = new URL(value.trim(), 'https://doujin.invalid').pathname;
      const match = pathname.match(/(?:^|\/)manga\/([^/]+)\/?$/i);
      if (match?.[1]) return decodeURIComponent(match[1]);
    } catch {
      // Ignore malformed optional links and continue with the next alias.
    }
  }
  return undefined;
};

export const normalizeManga = (item: AnyRecord): MangaItem => {
  const linkedSlug = mangaSlugFromLink(item.link_url, item.link, item.url, item.permalink);
  // On featured records `item.id` belongs to the featured slot, so pair its
  // linked slug with `manga_id`. Keep the normal id order for regular records.
  const id = firstString(
    linkedSlug ? item.manga_id : undefined,
    linkedSlug ? item.mangaId : undefined,
    item.id,
    item._id,
    item.manga_id,
    item.mangaId,
    item.uuid
  );
  const slug = firstString(item.slug, item.post_name, item.permalink_slug, item.url_slug)
    || linkedSlug;

  return {
    ...item,
    id,
    slug,
    title: firstString(item.title, item.name, item.post_title, item.manga_title, item.title_en),
    type: firstString(item.type, item.manga_type, item.post_type),
    thumbnail: firstString(
      item.thumbnail,
      item.thumbnail_url,
      item.image_url,
      item.cover_url,
      item.cover,
      item.cover_image,
      item.poster,
      item.featured_image,
      item.image
    ),
    image: firstString(item.image, item.image_url, item.cover_url, item.cover, item.cover_image, item.poster),
    score: item.score ?? item.rating ?? item.average_rating,
    status: firstString(item.status, item.post_status),
  };
};

/**
 * Identifier used for API lookups. Prefer the slug because `/manga/{slug}`
 * is the documented lookup, but fall back to the id when no slug is exposed.
 */
export const mangaLookupKey = (item: Pick<MangaItem, 'slug' | 'id'>): string =>
  item.slug || item.id || '';

/**
 * Public website URL for a title, or `null` when we only know its internal id.
 * The website routes by slug, so linking `/manga/<uuid>` renders its 404 page —
 * in that case we simply don't offer the external link.
 */
export const mangaSiteUrl = (
  item: Pick<MangaItem, 'slug' | 'id'>,
  siteUrl: string
): string | null => (item.slug && !looksLikeId(item.slug) ? `${siteUrl}/manga/${item.slug}` : null);

export interface ChapterItem extends AnyRecord {
  id?: string;
  title?: string;
  number?: string;
  date?: string;
}

export const normalizeChapter = (item: AnyRecord): ChapterItem => {
  const number = firstString(item.number, item.chapter_number, item.chapter, item.ch);
  return {
    ...item,
    id: firstString(item.id, item._id, item.chapter_id, item.chapterId, item.uuid, item.slug),
    title: firstString(item.title, item.name, item.chapter_title) || (number ? `Chapter ${number}` : undefined),
    number,
    date: firstString(item.created_at, item.createdAt, item.date, item.updated_at, item.published_at),
  };
};

/** Pulls the chapter list out of a manga detail payload. */
export const chaptersFromManga = (detail: AnyRecord | null): ChapterItem[] => {
  if (!detail) return [];
  for (const key of ['chapters', 'chapter', 'chapterList', 'chapter_list', 'episodes']) {
    if (Array.isArray(detail[key])) return (detail[key] as AnyRecord[]).map(normalizeChapter);
  }
  return [];
};

/**
 * Numeric position of a chapter in the series ("1", "1.5", "Chapter 12" →
 * 12 / 1.5). Returns `null` when no number can be extracted.
 */
export const parseChapterNumber = (chapter: Pick<ChapterItem, 'number'>): number | null => {
  if (chapter.number === undefined || chapter.number === null) return null;
  const match = String(chapter.number).trim().match(/\d+(?:\.\d+)?/);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
};

/**
 * Orders chapters by reading sequence (chapter 1 first), regardless of the
 * order upstream returns them in. DoujinDesu is observed to serve the list
 * newest-first, which previously inverted the reader's "Sebelumnya" /
 * "Selanjutnya" buttons — navigation must never depend on the array order.
 *
 * Chapters without a parseable number fall back to their publish date, then
 * to their position in the original list.
 */
export const sortChaptersForReading = (chapters: ChapterItem[]): ChapterItem[] => {
  return chapters
    .map((chapter, index) => ({ chapter, index }))
    .sort((a, b) => {
      const numA = parseChapterNumber(a.chapter);
      const numB = parseChapterNumber(b.chapter);
      if (numA !== null && numB !== null && numA !== numB) return numA - numB;
      const dateA = a.chapter.date ? Date.parse(a.chapter.date) : Number.NaN;
      const dateB = b.chapter.date ? Date.parse(b.chapter.date) : Number.NaN;
      if (Number.isFinite(dateA) && Number.isFinite(dateB) && dateA !== dateB) return dateA - dateB;
      return a.index - b.index;
    })
    .map((entry) => entry.chapter);
};

/**
 * Pulls the page image URLs out of a chapter payload. Pages have appeared as
 * plain string arrays, as objects with an `url`/`image` field, and nested under
 * `content_urls` (the current API) / `images` / `pages` / `content`.
 */
export const pagesFromChapter = (chapter: AnyRecord | null): string[] => {
  if (!chapter) return [];

  const candidates: unknown[] = [];
  for (const key of ['content_urls', 'images', 'pages', 'page_images', 'image_urls', 'content', 'data']) {
    if (Array.isArray(chapter[key])) candidates.push(...(chapter[key] as unknown[]));
  }

  const urls = candidates
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (entry && typeof entry === 'object') {
        const record = entry as AnyRecord;
        return firstString(record.url, record.image, record.image_url, record.src, record.file, record.path);
      }
      return undefined;
    })
    .filter((url): url is string => Boolean(url));

  return urls;
};
