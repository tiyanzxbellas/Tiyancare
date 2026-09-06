import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  History,
  Layers,
  RefreshCw,
  Star,
} from 'lucide-react';
import { doujindesuApi, DOUJINDESU_SITE_URL } from '../services/doujindesu';
import {
  chaptersFromManga,
  listFromResponse,
  mangaSiteUrl,
  normalizeChapter,
  normalizeManga,
  objectFromResponse,
  pagesFromChapter,
  sortChaptersForReading,
  type AnyRecord,
  type ChapterItem,
  type MangaItem,
} from '../utils/doujin';
import {
  findProgressChapter,
  getReadingProgress,
  saveReadingProgress,
  type ReadingProgressEntry,
} from '../utils/readingProgress';

interface DoujinReaderProps {
  /** Slug (preferred) or id of the title to open. */
  mangaKey: string;
  /** Card data we already have, shown while the detail request is in flight. */
  preview?: MangaItem;
  onBack: () => void;
}

/** Chapter page images are hotlink-protected upstream, so route them via the proxy. */
const pageImageSrc = (url: string): string =>
  /^https?:\/\//i.test(url) ? doujindesuApi.public.proxyImageUrl(url) : url;

/**
 * Upstream repeats the manga title in every chapter's `title` field, so the
 * number is the only reliable label ("Chapter 12", "Chapter 1", ...).
 */
const chapterLabel = (chapter: ChapterItem, fallbackIndex?: number): string => {
  if (chapter.number) return `Chapter ${chapter.number}`;
  if (chapter.title && chapter.title.trim()) return chapter.title.trim();
  return fallbackIndex !== undefined ? `Chapter ${fallbackIndex + 1}` : 'Chapter';
};

export const DoujinReader: React.FC<DoujinReaderProps> = ({ mangaKey, preview, onBack }) => {
  const [manga, setManga] = useState<MangaItem | null>(preview ?? null);
  const [chapters, setChapters] = useState<ChapterItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [activeChapter, setActiveChapter] = useState<ChapterItem | null>(null);
  const [pages, setPages] = useState<string[]>([]);
  const [loadingPages, setLoadingPages] = useState(false);
  const [pagesError, setPagesError] = useState<string | null>(null);

  // ------------------------------------------------------------- Reading memory
  /** True once this mount auto-opened the last-read chapter (run once per title). */
  const [resumed, setResumed] = useState(false);
  /** Page index the reader should scroll to once its images are mounted. */
  const restorePageRef = useRef<number | null>(null);
  /** Which page index is currently on screen (0-based). */
  const currentPageRef = useRef(0);
  const pagesContainerRef = useRef<HTMLDivElement | null>(null);

  /**
   * Chapters in reading order (oldest → newest), independent of the order the
   * API returns. Prev/Next navigation uses THIS list — the upstream order is
   * newest-first, which is what inverted the buttons before.
   */
  const chaptersForReading = useMemo(() => sortChaptersForReading(chapters), [chapters]);

  // Refreshed whenever the view switches (list ↔ chapter) so the "Lanjut
  // baca" banner and the last-read badge always reflect the stored progress.
  const savedProgress: ReadingProgressEntry | null = useMemo(
    () => getReadingProgress(mangaKey),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mangaKey, activeChapter]
  );

  const loadDetail = useCallback(async () => {
    if (!mangaKey) return;
    setLoading(true);
    setError(null);
    try {
      const raw = await doujindesuApi.public.getManga(mangaKey);
      const detail = objectFromResponse(raw);
      if (detail) setManga(normalizeManga(detail));

      let chapterList = chaptersFromManga(detail);
      if (!chapterList.length) {
        // Some builds return the chapters only from the list envelope root.
        chapterList = listFromResponse((raw as AnyRecord)?.chapters).map(normalizeChapter);
      }
      setChapters(chapterList);
    } catch (err: any) {
      const message = err?.message || 'Gagal memuat detail judul ini.';
      setError(
        /manga not found/i.test(message)
          ? 'Manga tidak ditemukan di DoujinDesu. Item ini mungkin sudah dipindahkan atau dihapus.'
          : message
      );
    } finally {
      setLoading(false);
    }
  }, [mangaKey]);

  useEffect(() => {
    setActiveChapter(null);
    setPages([]);
    setResumed(false);
    restorePageRef.current = null;
    currentPageRef.current = 0;
    loadDetail();
  }, [loadDetail]);

  const openChapter = useCallback(
    async (chapter: ChapterItem, resumePage = 0) => {
      if (!chapter.id) {
        setPagesError('Chapter ini tidak punya ID yang bisa dibuka.');
        setActiveChapter(chapter);
        setPages([]);
        restorePageRef.current = null;
        currentPageRef.current = 0;
        return;
      }
      setActiveChapter(chapter);
      setPages([]);
      setPagesError(null);
      setLoadingPages(true);
      restorePageRef.current = null;
      currentPageRef.current = 0;
      try {
        const raw = await doujindesuApi.public.getChapter(chapter.id);
        const detail = objectFromResponse(raw);
        const imageUrls = pagesFromChapter(detail);
        setPages(imageUrls);
        if (!imageUrls.length) {
          setPagesError('Halaman chapter tidak tersedia (mungkin butuh login atau VIP).');
        } else {
          const startPage = Math.min(Math.max(resumePage, 0), imageUrls.length - 1);
          currentPageRef.current = startPage;
          if (startPage > 0) restorePageRef.current = startPage;
          // Reading memory: remember this chapter (and page) as last-read.
          saveReadingProgress({
            mangaKey,
            mangaTitle: manga?.title,
            chapterId: chapter.id,
            chapterNumber: chapter.number,
            chapterLabel: chapterLabel(chapter),
            page: startPage,
            pageCount: imageUrls.length,
          });
        }
        // Fire-and-forget view counter; failures must not break the reader.
        doujindesuApi.interactions.viewChapter(chapter.id).catch(() => undefined);
      } catch (err: any) {
        setPagesError(err?.message || 'Gagal memuat halaman chapter.');
      } finally {
        setLoadingPages(false);
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    [mangaKey, manga?.title]
  );

  // Reading memory: as soon as the chapter list is available, open the
  // chapter the user last read so they continue exactly where they left off.
  // Runs once per mount — a manual "Daftar Chapter" back-button must not
  // be bounced straight back into the chapter.
  useEffect(() => {
    if (resumed || loading || chapters.length === 0 || activeChapter) return;
    setResumed(true);
    const entry = getReadingProgress(mangaKey);
    const chapter = findProgressChapter(chapters, entry);
    if (chapter) {
      openChapter(chapter, entry?.page ?? 0);
    }
  }, [resumed, loading, chapters, activeChapter, mangaKey, openChapter]);

  // Reading memory (part 2): track which page is on screen while reading and
  // persist it — throttled during scrolling, immediately when the tab is
  // hidden or closed — so the position survives refreshes and app exits.
  useEffect(() => {
    if (!activeChapter) return;

    let lastWrite = 0;
    const persist = (immediate: boolean) => {
      const now = Date.now();
      if (!immediate && now - lastWrite < 1500) return;
      lastWrite = now;
      saveReadingProgress({
        mangaKey,
        mangaTitle: manga?.title,
        chapterId: activeChapter.id,
        chapterNumber: activeChapter.number,
        chapterLabel: chapterLabel(activeChapter),
        page: currentPageRef.current,
        pageCount: pages.length || undefined,
      });
    };

    const onScroll = () => {
      const container = pagesContainerRef.current;
      if (!container) return;
      const marker = window.scrollY + window.innerHeight * 0.35;
      let idx = currentPageRef.current;
      container.querySelectorAll('img').forEach((img, i) => {
        const top = img.getBoundingClientRect().top + window.scrollY;
        if (top <= marker) idx = i;
      });
      if (idx !== currentPageRef.current) {
        currentPageRef.current = idx;
        persist(false);
      }
    };

    const persistNow = () => persist(true);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') persist(true);
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('pagehide', persistNow);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('pagehide', persistNow);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [activeChapter, mangaKey, manga?.title, pages.length]);

  /** Scrolls the reader to the remembered page once its image is mounted. */
  const handlePageImgRef = useCallback((el: HTMLImageElement | null, idx: number) => {
    if (!el || restorePageRef.current === null || idx !== restorePageRef.current) return;
    const scrollTo = () => {
      if (restorePageRef.current !== idx) return;
      restorePageRef.current = null;
      el.scrollIntoView({ block: 'center' });
    };
    if (el.complete && el.naturalHeight > 0) {
      requestAnimationFrame(scrollTo);
    } else {
      el.addEventListener('load', scrollTo, { once: true });
      el.addEventListener('error', scrollTo, { once: true });
    }
  }, []);

  const activeIndex = useMemo(
    () => chaptersForReading.findIndex((c) => c.id === activeChapter?.id),
    [chaptersForReading, activeChapter]
  );

  /** The chapter the stored progress points to, if it still exists. */
  const lastReadChapter = useMemo(
    () => findProgressChapter(chapters, savedProgress),
    [chapters, savedProgress]
  );

  const externalUrl = manga ? mangaSiteUrl(manga, DOUJINDESU_SITE_URL) : null;
  const synopsis =
    (manga?.synopsis as string) || (manga?.description as string) || (manga?.summary as string) || '';

  // ---------------------------------------------------------------- Reader
  if (activeChapter) {
    return (
      <div className="space-y-5 pb-24 animate-fade-in">
        <div className="flex items-center justify-between gap-3 sticky top-0 z-20 bg-dark-950/90 backdrop-blur py-3">
          <button
            onClick={() => { setActiveChapter(null); setPages([]); setPagesError(null); }}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-dark-900 border border-slate-800 text-xs font-bold text-slate-300 hover:text-white"
          >
            <ArrowLeft className="w-4 h-4" />
            Daftar Chapter
          </button>
          <div className="text-right min-w-0">
            <p className="text-xs font-bold text-white truncate">{manga?.title || 'Manga'}</p>
            <p className="text-[11px] text-slate-400 truncate">{chapterLabel(activeChapter)}</p>
          </div>
        </div>

        {loadingPages ? (
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="w-full h-[420px] rounded-xl bg-dark-850 animate-pulse" />
            ))}
          </div>
        ) : pagesError ? (
          <div className="p-8 rounded-2xl bg-rose-950/40 border border-rose-800 text-center space-y-4">
            <AlertCircle className="w-10 h-10 text-rose-500 mx-auto" />
            <p className="text-sm text-slate-300 max-w-md mx-auto">{pagesError}</p>
            <button
              onClick={() => openChapter(activeChapter)}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-brand-rose text-white text-xs font-bold"
            >
              <RefreshCw className="w-4 h-4" />
              Coba Lagi
            </button>
          </div>
        ) : (
          <div ref={pagesContainerRef} className="flex flex-col items-center gap-1 bg-dark-950">
            {pages.map((url, idx) => (
              <img
                key={`${url}-${idx}`}
                ref={(el) => handlePageImgRef(el, idx)}
                src={pageImageSrc(url)}
                alt={`Halaman ${idx + 1}`}
                loading={idx < 2 ? 'eager' : 'lazy'}
                referrerPolicy="no-referrer"
                className="w-full max-w-3xl h-auto"
              />
            ))}
          </div>
        )}

        {chaptersForReading.length > 1 && (
          <div className="flex items-center justify-center gap-3 pt-4 border-t border-slate-800">
            <button
              disabled={activeIndex <= 0}
              onClick={() => {
                if (activeIndex > 0) openChapter(chaptersForReading[activeIndex - 1]);
              }}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-dark-900 border border-slate-800 text-xs font-bold text-slate-300 disabled:opacity-40"
            >
              <ChevronLeft className="w-4 h-4" />
              <span className="flex flex-col items-start leading-tight">
                Sebelumnya
                <span className="text-[10px] font-semibold text-slate-500">
                  {activeIndex > 0
                    ? chapterLabel(chaptersForReading[activeIndex - 1], activeIndex - 1)
                    : 'Awal'}
                </span>
              </span>
            </button>
            <button
              disabled={activeIndex < 0 || activeIndex >= chaptersForReading.length - 1}
              onClick={() => {
                if (activeIndex >= 0 && activeIndex < chaptersForReading.length - 1) {
                  openChapter(chaptersForReading[activeIndex + 1]);
                }
              }}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-gradient-to-r from-brand-rose to-brand-pink text-white text-xs font-bold disabled:opacity-40"
            >
              <span className="flex flex-col items-start leading-tight">
                Selanjutnya
                <span className="text-[10px] font-semibold text-white/70">
                  {activeIndex >= 0 && activeIndex < chaptersForReading.length - 1
                    ? chapterLabel(chaptersForReading[activeIndex + 1], activeIndex + 1)
                    : 'Chapter terakhir'}
                </span>
              </span>
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>
    );
  }

  // ---------------------------------------------------------------- Detail
  return (
    <div className="space-y-6 pb-20 animate-fade-in">
      <button
        onClick={onBack}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-dark-900 border border-slate-800 text-xs font-bold text-slate-300 hover:text-white"
      >
        <ArrowLeft className="w-4 h-4" />
        Kembali
      </button>

      <div className="flex flex-col sm:flex-row gap-5">
        <div className="w-40 shrink-0 mx-auto sm:mx-0">
          <div className="aspect-[2/3] rounded-xl overflow-hidden bg-dark-850 border border-slate-800">
            {manga?.thumbnail || manga?.image ? (
              <img
                src={manga.thumbnail || manga.image}
                alt={manga.title || ''}
                referrerPolicy="no-referrer"
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                <BookOpen className="w-8 h-8 text-slate-600" />
              </div>
            )}
          </div>
        </div>

        <div className="flex-1 space-y-3 min-w-0">
          <h2 className="text-xl sm:text-2xl font-extrabold text-white">
            {manga?.title || (loading ? 'Memuat…' : 'Tanpa Judul')}
          </h2>
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            {manga?.type && (
              <span className="px-2 py-1 rounded-md bg-brand-pink/90 text-white font-bold uppercase">{manga.type}</span>
            )}
            {manga?.status && (
              <span className="px-2 py-1 rounded-md bg-dark-850 border border-slate-800 text-slate-300">{manga.status}</span>
            )}
            {manga?.score !== undefined && manga?.score !== null && manga.score !== '' && (
              <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-amber-500 text-dark-950 font-bold">
                <Star className="w-3 h-3 fill-dark-950" /> {manga.score}
              </span>
            )}
          </div>
          {synopsis && <p className="text-xs text-slate-300 leading-relaxed line-clamp-6">{synopsis}</p>}
          {externalUrl && (
            <a
              href={externalUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-[11px] text-slate-400 hover:text-brand-pink"
            >
              <ExternalLink className="w-3.5 h-3.5" /> Buka di situs asli
            </a>
          )}
        </div>
      </div>

      {/* Reading memory: jump straight back to the last-read chapter */}
      {savedProgress && !loading && !error && lastReadChapter && (
        <button
          onClick={() => openChapter(lastReadChapter, savedProgress.page ?? 0)}
          className="w-full flex items-center gap-3 px-4 py-3.5 rounded-2xl bg-gradient-to-r from-brand-rose/15 via-brand-pink/10 to-dark-900 border border-brand-rose/40 hover:border-brand-rose/70 transition-all text-left"
        >
          <div className="w-10 h-10 rounded-xl bg-brand-rose/20 border border-brand-rose/30 flex items-center justify-center shrink-0">
            <History className="w-5 h-5 text-brand-rose" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-extrabold text-white truncate">
              Lanjut baca: {savedProgress.chapterLabel || chapterLabel(lastReadChapter)}
            </p>
            <p className="text-[10px] text-slate-400 mt-0.5 truncate">
              Halaman {(savedProgress.page ?? 0) + 1}
              {typeof savedProgress.pageCount === 'number' ? ` dari ${savedProgress.pageCount}` : ''}
              {typeof savedProgress.updatedAt === 'number'
                ? ` · terakhir dibaca ${new Date(savedProgress.updatedAt).toLocaleDateString('id-ID', {
                    day: 'numeric',
                    month: 'short',
                  })}`
                : ''}
            </p>
          </div>
          <ChevronRight className="w-4 h-4 text-brand-rose shrink-0" />
        </button>
      )}

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-brand-pink" />
          <h3 className="text-sm font-extrabold text-white">Daftar Chapter</h3>
          {chapters.length > 0 && <span className="text-[11px] text-slate-500">({chapters.length})</span>}
        </div>

        {loading ? (
          <div className="space-y-2">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-11 rounded-xl bg-dark-850 animate-pulse" />
            ))}
          </div>
        ) : error ? (
          <div className="p-6 rounded-2xl bg-rose-950/40 border border-rose-800 text-center space-y-3">
            <AlertCircle className="w-10 h-10 text-rose-500 mx-auto" />
            <p className="text-sm text-slate-300">{error}</p>
            <button
              onClick={loadDetail}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-brand-rose text-white text-xs font-bold"
            >
              <RefreshCw className="w-4 h-4" /> Coba Lagi
            </button>
          </div>
        ) : chapters.length === 0 ? (
          <div className="p-8 rounded-2xl bg-dark-900 border border-slate-800 text-center space-y-2">
            <BookOpen className="w-10 h-10 text-slate-600 mx-auto" />
            <p className="text-xs text-slate-400">Belum ada chapter yang bisa dibaca untuk judul ini.</p>
          </div>
        ) : (
          <div className="grid gap-2">
            {chapters.map((chapter, idx) => {
              const isLastRead = Boolean(savedProgress?.chapterId && chapter.id === savedProgress.chapterId);
              return (
                <button
                  key={chapter.id || idx}
                  onClick={() => openChapter(chapter)}
                  className={`flex items-center justify-between gap-3 px-4 py-3 rounded-xl border text-left transition-all ${
                    isLastRead
                      ? 'bg-brand-rose/10 border-brand-rose/50 hover:border-brand-rose/70'
                      : 'bg-dark-900 border-slate-800 hover:border-brand-rose/60'
                  }`}
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <span className="text-xs font-semibold text-slate-100 truncate">
                      {chapterLabel(chapter, idx)}
                    </span>
                    {isLastRead && (
                      <span className="shrink-0 px-1.5 py-0.5 rounded-md bg-brand-rose/20 text-brand-rose text-[9px] font-bold uppercase tracking-wide">
                        Terakhir dibaca
                      </span>
                    )}
                  </span>
                  <span className="flex items-center gap-2 shrink-0">
                    {chapter.date && <span className="text-[10px] text-slate-500">{chapter.date.slice(0, 10)}</span>}
                    <ChevronRight className="w-4 h-4 text-slate-500" />
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
};
