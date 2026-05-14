/**
 * Hacker News Firebase API client.
 *
 * HN's public read API is at https://hacker-news.firebaseio.com/v0/.
 * It's free, unauthenticated, fast, and CORS-enabled. We use it
 * directly from the browser, no proxy needed.
 *
 * Endpoints we touch:
 *   GET /topstories.json       → number[] of item ids, ordered by score
 *   GET /newstories.json       → number[] of item ids, ordered by time
 *   GET /item/{id}.json        → one item (story, comment, poll, job…)
 *
 * For the briefing we only care about stories: items where
 *   type === "story" && !dead && !deleted && (url || text).
 *
 * Caching strategy:
 *   - The top-stories list refreshes every few minutes upstream; we
 *     refetch on a manual "refresh" gesture, otherwise reuse.
 *   - Per-item fetches are cached in-memory for the session. Items
 *     don't change after posting except for score/descendants, and we
 *     only need them stable enough for one briefing pass.
 */

export interface HNStory {
  id: number;
  type: "story";
  by: string;
  time: number;             // unix seconds
  title: string;
  /** External URL for link-posts; absent for Ask-HN / pure-text. */
  url?: string;
  /** Inline text body (HTML) for Ask-HN / text-only posts. */
  text?: string;
  /** Up-votes net of flags. */
  score: number;
  /** Total comments. */
  descendants?: number;
  /** Comment ids on the root post. */
  kids?: number[];
}

export interface HNJob {
  id: number;
  type: "job";
  by: string;
  time: number;
  title: string;
  url?: string;
  text?: string;
}

export interface HNPoll {
  id: number;
  type: "poll";
  by: string;
  time: number;
  title: string;
  text?: string;
  score: number;
  descendants?: number;
  kids?: number[];
  parts?: number[];
}

export interface HNComment {
  id: number;
  type: "comment";
  by: string;
  time: number;
  text: string;
  parent?: number;
  kids?: number[];
}

/** Any displayable item in a column. */
export type HNFeedItem = HNStory | HNJob | HNPoll | HNComment;

export interface HNCommentNode {
  comment: HNComment;
  children: HNCommentNode[];
}

export interface HNCommentPreview {
  story: HNStory;
  comments: HNCommentNode[];
  total: number;
}

export type HNFeed = "top" | "new" | "ask" | "show" | "jobs" | "user" | "best-month" | "search" | "all";

export interface HNFeedOptions {
  /** HN username for feed === "user". */
  user?: string;
  /** Month in YYYY-MM for feed === "best-month". Empty = current month. */
  month?: string;
  /** Search query for feed === "search". */
  query?: string;
}

interface HNPollOpt {
  id: number;
  type: "pollopt";
  [k: string]: unknown;
}

type HNAnyItem = HNFeedItem | HNPollOpt;

const BASE = "https://hacker-news.firebaseio.com/v0";

/** In-memory per-session cache; the Firebase endpoint is fast but
 *  we still avoid the 200ms round-trip when re-rendering. */
const itemCache = new Map<number, HNFeedItem | null>();

/**
 * Cached top-stories id list. Refetched only when explicitly
 * invalidated (e.g. user clicks "Refresh"). Lets paginated batches
 * avoid hitting /topstories.json once per scroll-trigger.
 */
const feedIdsCache = new Map<string, { ids: number[]; fetchedAt: number }>();
let maxItemCache: { id: number; fetchedAt: number } | null = null;

/** How long the in-memory id list is considered fresh. The list
 *  itself is recomputed by HN every ~few minutes upstream; this
 *  matches that cadence so a long session re-fetches eventually. */
const TOP_IDS_TTL_MS = 5 * 60_000;

/**
 * Fetch the current top-stories id list. Cached for TOP_IDS_TTL_MS
 * so paginated batches don't re-hit the endpoint. Pass force=true
 * to refresh on user-driven refresh.
 */
export async function fetchTopStoryIds(
  signal?: AbortSignal,
  force = false,
): Promise<number[]> {
  return fetchFeedStoryIds("top", signal, force);
}

export async function fetchFeedStoryIds(
  feed: HNFeed,
  signal?: AbortSignal,
  force = false,
  opts: HNFeedOptions = {},
): Promise<number[]> {
  const key = feedCacheKey(feed, opts);
  const cached = feedIdsCache.get(key);
  if (!force && cached && Date.now() - cached.fetchedAt < TOP_IDS_TTL_MS) {
    return cached.ids;
  }
  if (feed === "user") {
    const username = opts.user?.trim();
    if (!username) return [];
    const r = await fetch(`${BASE}/user/${encodeURIComponent(username)}.json`, { signal });
    if (!r.ok) throw new Error(`HN user ${username}: HTTP ${r.status}`);
    const user = (await r.json()) as { submitted?: number[] } | null;
    const ids = Array.isArray(user?.submitted) ? user.submitted : [];
    feedIdsCache.set(key, { ids, fetchedAt: Date.now() });
    return ids;
  }
  if (feed === "best-month") {
    const stories = await fetchBestMonthStories(0, 500, signal, opts.month);
    const ids = stories.map((s) => s.id);
    for (const story of stories) itemCache.set(story.id, story);
    feedIdsCache.set(key, { ids, fetchedAt: Date.now() });
    return ids;
  }
  const r = await fetch(`${BASE}/${feedEndpoint(feed)}.json`, { signal });
  if (!r.ok) throw new Error(`HN topstories: HTTP ${r.status}`);
  const ids = (await r.json()) as number[];
  if (!Array.isArray(ids)) throw new Error(`HN ${feed}: response is not an array`);
  feedIdsCache.set(key, { ids, fetchedAt: Date.now() });
  return ids;
}

/** Clear cached state. Call on hard refresh. */
export function clearHNCache(): void {
  feedIdsCache.clear();
  itemCache.clear();
}

/**
 * Fetch one item by id. Returns null if the item is not a story
 * (comment / job / poll) or is dead/deleted. Those are not useful
 * for a story briefing.
 */
export async function fetchItem(id: number, signal?: AbortSignal): Promise<HNFeedItem | null> {
  if (itemCache.has(id)) return itemCache.get(id) ?? null;
  const r = await fetch(`${BASE}/item/${id}.json`, { signal });
  if (!r.ok) {
    itemCache.set(id, null);
    return null;
  }
  const raw = (await r.json()) as HNAnyItem | null;
  const item = normalizeItem(raw);
  itemCache.set(id, item);
  return item;
}

export async function fetchCommentPreview(
  storyId: number,
  signal?: AbortSignal,
  opts: { topLevel?: number; depth?: number; repliesPerComment?: number } = {},
): Promise<HNCommentPreview> {
  const item = await fetchItem(storyId, signal);
  if (!item || item.type !== "story") throw new Error("HN item is not a story.");
  const topLevel = opts.topLevel ?? 12;
  const depth = opts.depth ?? 2;
  const repliesPerComment = opts.repliesPerComment ?? 4;
  const ids = (item.kids ?? []).slice(0, topLevel);
  const comments = (await Promise.all(ids.map((id) => fetchCommentNode(id, depth, repliesPerComment, signal))))
    .filter((node): node is HNCommentNode => !!node);
  return { story: item, comments, total: item.descendants ?? item.kids?.length ?? comments.length };
}

async function fetchCommentNode(
  id: number,
  depth: number,
  repliesPerComment: number,
  signal?: AbortSignal,
): Promise<HNCommentNode | null> {
  const item = await fetchItem(id, signal);
  if (!item || item.type !== "comment") return null;
  const childIds = depth > 0 ? (item.kids ?? []).slice(0, repliesPerComment) : [];
  const children = (await Promise.all(childIds.map((childId) => fetchCommentNode(childId, depth - 1, repliesPerComment, signal))))
    .filter((node): node is HNCommentNode => !!node);
  return { comment: item, children };
}

/**
 * Fetch the first `count` stories from the top-stories list,
 * in parallel. Non-stories and dead items are skipped silently;
 * the returned list may be shorter than `count` if many fail.
 *
 * The order of the returned array matches the original id list
 * (so HN's own ranking is preserved).
 */
export async function fetchTopStories(
  count: number,
  signal?: AbortSignal,
): Promise<HNStory[]> {
  return fetchTopStorySlice(0, count, signal);
}

/**
 * Result of one batch fetch. Both the slice itself and the total
 * size of the upstream id list, so the caller can decide whether
 * there's more to load.
 */
export interface BatchResult<T extends HNFeedItem = HNFeedItem> {
  stories: T[];
  /** Total number of ids in the current top-stories list. */
  total: number;
  /** Whether more stories exist past the returned slice. */
  hasMore: boolean;
}

/**
 * Fetch the half-open range [start, end) from the top-stories list.
 * Used for infinite-scroll batching. The id list is cached so this
 * doesn't re-hit /topstories.json on every batch.
 *
 * Returns the parsed stories plus pagination metadata. Dead /
 * deleted items are dropped silently; the returned slice may be
 * shorter than (end - start).
 */
export async function fetchTopStorySlice(
  start: number,
  end: number,
  signal?: AbortSignal,
): Promise<HNStory[]> {
  const result = await fetchTopStoryBatch(start, end, signal);
  return result.stories;
}

/** Same as fetchTopStorySlice but also returns pagination metadata. */
export async function fetchTopStoryBatch(
  start: number,
  end: number,
  signal?: AbortSignal,
): Promise<BatchResult<HNStory>> {
  const result = await fetchFeedStoryBatch("top", start, end, signal);
  return { ...result, stories: result.stories.filter(isHNStory) };
}

export async function fetchFeedStoryBatch(
  feed: HNFeed,
  start: number,
  end: number,
  signal?: AbortSignal,
  opts: HNFeedOptions = {},
): Promise<BatchResult> {
  if (feed === "all") return fetchAllItemBatch(start, end, signal);
  if (feed === "search") return fetchSearchStoryBatch(opts.query ?? "", start, end, signal);
  if (feed === "best-month") {
    const stories = await fetchBestMonthStories(start, end, signal, opts.month);
    return { stories, total: 500, hasMore: stories.length >= end - start };
  }
  const ids = await fetchFeedStoryIds(feed, signal, false, opts);
  const clampedStart = Math.max(0, Math.min(start, ids.length));
  const clampedEnd = Math.max(clampedStart, Math.min(end, ids.length));
  const slice = ids.slice(clampedStart, clampedEnd);
  const items = await Promise.all(slice.map((id) => fetchItem(id, signal)));
  return {
    stories: items.filter((it): it is HNFeedItem => it !== null),
    total: ids.length,
    hasMore: clampedEnd < ids.length,
  };
}

async function fetchAllItemBatch(start: number, end: number, signal?: AbortSignal): Promise<BatchResult> {
  const max = await fetchMaxItemId(signal);
  const clampedStart = Math.max(0, Math.min(start, max));
  const clampedEnd = Math.max(clampedStart, Math.min(end, max));
  const ids: number[] = [];
  for (let id = max - clampedStart; id > max - clampedEnd && id > 0; id--) ids.push(id);
  const items = await Promise.all(ids.map((id) => fetchItem(id, signal)));
  return {
    stories: items.filter((item): item is HNFeedItem => item !== null && item.type !== "comment"),
    total: max,
    hasMore: clampedEnd < max,
  };
}

async function fetchMaxItemId(signal?: AbortSignal): Promise<number> {
  if (maxItemCache && Date.now() - maxItemCache.fetchedAt < TOP_IDS_TTL_MS) return maxItemCache.id;
  const r = await fetch(`${BASE}/maxitem.json`, { signal });
  if (!r.ok) throw new Error(`HN maxitem: HTTP ${r.status}`);
  const id = await r.json() as number;
  if (!Number.isFinite(id)) throw new Error("HN maxitem: response is not a number");
  maxItemCache = { id, fetchedAt: Date.now() };
  return id;
}

export async function fetchSearchStoryBatch(
  query: string,
  start: number,
  end: number,
  signal?: AbortSignal,
): Promise<BatchResult<HNStory>> {
  const q = query.trim();
  if (!q) return { stories: [], total: 0, hasMore: false };
  const hitsPerPage = Math.max(1, Math.min(100, end - start));
  const page = Math.max(0, Math.floor(start / hitsPerPage));
  const url =
    `https://hn.algolia.com/api/v1/search_by_date?tags=story` +
    `&query=${encodeURIComponent(q)}` +
    `&page=${page}` +
    `&hitsPerPage=${hitsPerPage}`;
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`HN Algolia search: HTTP ${r.status}`);
  const json = (await r.json()) as { hits?: AlgoliaHit[]; nbHits?: number; nbPages?: number; page?: number };
  const stories = (json.hits ?? [])
    .map(algoliaHitToStory)
    .filter((s): s is HNStory => !!s);
  const total = typeof json.nbHits === "number" ? json.nbHits : stories.length;
  const currentPage = typeof json.page === "number" ? json.page : page;
  const hasMore = typeof json.nbPages === "number"
    ? currentPage + 1 < json.nbPages
    : (page + 1) * hitsPerPage < total;
  return { stories, total, hasMore };
}

function feedEndpoint(feed: HNFeed): string {
  switch (feed) {
    case "top": return "topstories";
    case "new": return "newstories";
    case "ask": return "askstories";
    case "show": return "showstories";
    case "jobs": return "jobstories";
    case "user": return "user";
    case "best-month": return "beststories";
    case "search": return "search";
    case "all": return "maxitem";
  }
}

function feedCacheKey(feed: HNFeed, opts: HNFeedOptions): string {
  if (feed === "user") return `user:${opts.user?.trim() ?? ""}`;
  if (feed === "best-month") return `best-month:${normalizeMonth(opts.month)}`;
  if (feed === "search") return `search:${opts.query?.trim() ?? ""}`;
  if (feed === "all") return "all";
  return feed;
}

function normalizeMonth(month: string | undefined): string {
  if (month && /^\d{4}-\d{2}$/.test(month)) return month;
  return new Date().toISOString().slice(0, 7);
}

interface AlgoliaHit {
  objectID: string;
  title?: string;
  url?: string;
  author?: string;
  points?: number;
  num_comments?: number;
  created_at_i?: number;
  story_text?: string;
}

async function fetchBestMonthStories(
  start: number,
  end: number,
  signal: AbortSignal | undefined,
  month: string | undefined,
): Promise<HNStory[]> {
  const [year, monthNum] = normalizeMonth(month).split("-").map((n) => Number.parseInt(n, 10));
  const from = Math.floor(Date.UTC(year, monthNum - 1, 1) / 1000);
  const to = Math.floor(Date.UTC(monthNum === 12 ? year + 1 : year, monthNum === 12 ? 0 : monthNum, 1) / 1000);
  const hitsPerPage = Math.max(1, Math.min(1000, end));
  const url =
    `https://hn.algolia.com/api/v1/search?tags=story` +
    `&numericFilters=created_at_i>=${from},created_at_i<${to}` +
    `&hitsPerPage=${hitsPerPage}`;
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`HN Algolia monthly best: HTTP ${r.status}`);
  const json = (await r.json()) as { hits?: AlgoliaHit[] };
  return (json.hits ?? [])
    .map(algoliaHitToStory)
    .filter((s): s is HNStory => !!s)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(start, end);
}

function algoliaHitToStory(hit: AlgoliaHit): HNStory | null {
  const id = Number.parseInt(hit.objectID, 10);
  const title = hit.title?.trim();
  if (!Number.isInteger(id) || !title) return null;
  return {
    id,
    type: "story",
    by: hit.author ?? "unknown",
    time: hit.created_at_i ?? 0,
    title,
    url: hit.url || undefined,
    text: hit.story_text || undefined,
    score: hit.points ?? 0,
    descendants: hit.num_comments ?? 0,
  };
}

export function isHNStory(item: HNFeedItem): item is HNStory {
  return item.type === "story";
}

/** Strip HTML tags + decode the few entities HN actually emits. */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** Return the host portion of a URL for compact display. */
export function hostOf(url: string | undefined): string {
  if (!url) return "news.ycombinator.com";
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Origin HN permalink (comments page). */
export function hnPermalink(id: number): string {
  return `https://news.ycombinator.com/item?id=${id}`;
}

/** Origin HN user profile (submissions/comments page). */
export function hnUserUrl(username: string): string {
  return `https://news.ycombinator.com/user?id=${encodeURIComponent(username)}`;
}

/** Origin HN "from" page for a domain, e.g. /from?site=github.com. */
export function hnFromSiteUrl(host: string): string {
  return `https://news.ycombinator.com/from?site=${encodeURIComponent(host)}`;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function normalizeItem(raw: HNAnyItem | null): HNFeedItem | null {
  return normalizeStory(raw) ?? normalizeJob(raw) ?? normalizePoll(raw) ?? normalizeComment(raw);
}

function normalizeStory(raw: HNAnyItem | null): HNStory | null {
  if (!raw || typeof raw !== "object") return null;
  if (raw.type !== "story") return null;
  if ("dead" in raw && raw.dead) return null;
  if ("deleted" in raw && raw.deleted) return null;
  const r = raw as HNStory;
  if (typeof r.id !== "number" || typeof r.title !== "string") return null;
  return {
    id: r.id,
    type: "story",
    by: r.by ?? "unknown",
    time: typeof r.time === "number" ? r.time : 0,
    title: r.title,
    url: typeof r.url === "string" ? r.url : undefined,
    text: typeof r.text === "string" ? r.text : undefined,
    score: typeof r.score === "number" ? r.score : 0,
    descendants: typeof r.descendants === "number" ? r.descendants : 0,
    kids: Array.isArray(r.kids) ? r.kids : undefined,
  };
}

function normalizeJob(raw: HNAnyItem | null): HNJob | null {
  if (!raw || typeof raw !== "object") return null;
  if (raw.type !== "job") return null;
  if ("dead" in raw && raw.dead) return null;
  if ("deleted" in raw && raw.deleted) return null;
  const r = raw as unknown as HNJob;
  if (typeof r.id !== "number" || typeof r.title !== "string") return null;
  return {
    id: r.id,
    type: "job",
    by: r.by ?? "unknown",
    time: typeof r.time === "number" ? r.time : 0,
    title: r.title,
    url: typeof r.url === "string" ? r.url : undefined,
    text: typeof r.text === "string" ? r.text : undefined,
  };
}

function normalizePoll(raw: HNAnyItem | null): HNPoll | null {
  if (!raw || typeof raw !== "object") return null;
  if (raw.type !== "poll") return null;
  if ("dead" in raw && raw.dead) return null;
  if ("deleted" in raw && raw.deleted) return null;
  const r = raw as unknown as HNPoll;
  if (typeof r.id !== "number" || typeof r.title !== "string") return null;
  return {
    id: r.id,
    type: "poll",
    by: r.by ?? "unknown",
    time: typeof r.time === "number" ? r.time : 0,
    title: r.title,
    text: typeof r.text === "string" ? r.text : undefined,
    score: typeof r.score === "number" ? r.score : 0,
    descendants: typeof r.descendants === "number" ? r.descendants : 0,
    kids: Array.isArray(r.kids) ? r.kids : undefined,
    parts: Array.isArray(r.parts) ? r.parts : undefined,
  };
}

function normalizeComment(raw: HNAnyItem | null): HNComment | null {
  if (!raw || typeof raw !== "object") return null;
  if (raw.type !== "comment") return null;
  if ("dead" in raw && raw.dead) return null;
  if ("deleted" in raw && raw.deleted) return null;
  const r = raw as HNComment;
  if (typeof r.id !== "number" || typeof r.text !== "string") return null;
  return {
    id: r.id,
    type: "comment",
    by: r.by ?? "unknown",
    time: typeof r.time === "number" ? r.time : 0,
    text: r.text,
    parent: typeof r.parent === "number" ? r.parent : undefined,
    kids: Array.isArray(r.kids) ? r.kids : undefined,
  };
}
