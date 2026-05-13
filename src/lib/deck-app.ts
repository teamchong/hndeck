/** TweetDeck-style HN deck app. */

import {
  fetchTopStoryBatch,
  fetchFeedStoryBatch,
  clearHNCache,
  hnFromSiteUrl,
  hnPermalink,
  hnUserUrl,
  hostOf,
  type HNStory,
} from "./hn-client";
import {
  addColumn,
  coerceDeck,
  defaultDeck,
  moveColumn,
  newColumnId,
  removeColumn,
  updateColumn,
  type Column,
  type Deck,
} from "./deck";
import { DeckRouter, type DeckAction, type DeckSink } from "./deck-sdk";
import { createDeckExecutor } from "./deck-executor";
import { buildDeckSystemPrompt, buildDeckUserPrompt } from "./deck-prompt";
import { checkAvailability, createSession, streamPrompt, type ModelStatus } from "./prompt-api";
import { classifyFailure, detectBrowser, guideContentFor, type GuideContent } from "./setup-guide";

const BATCH = 30;
const MIN_CURATED_CARDS = 8;
const AUTO_RELOAD_OPTIONS = [60_000, 5 * 60_000, 60 * 60_000] as const;
const DEFAULT_AUTO_RELOAD_MS = AUTO_RELOAD_OPTIONS[0];
const CARD_STALE_MS = 5 * 60_000;
const OPFS_STATE_FILE = "hn-deck-state-v1.json";
const OPFS_DOM_SNAPSHOT_FILE = "hn-deck-dom-v1.json";
const APP_CSS_ID = "hn-deck-app-css";
const CUSTOM_CSS_ID = "hn-deck-custom-css";
const THEME_VARS_CSS_ID = "hn-deck-theme-vars";
const CSS_VAR_NAMES = [
  "--bg",
  "--bg-2",
  "--bg-3",
  "--bg-tint",
  "--fg",
  "--fg-mid",
  "--fg-dim",
  "--orange",
  "--orange-dim",
  "--border",
  "--rule",
  "--green",
  "--red",
] as const;

interface ColumnItem {
  storyId: number;
  headline?: string;
  body?: string;
  lastRenderedAt: number;
}

interface DOM {
  status: HTMLElement;
  deck: HTMLElement;
  contextBox: HTMLTextAreaElement;
  sessionBox: HTMLInputElement;
  reloadEveryBtn: HTMLButtonElement;
  addColumnBtn: HTMLButtonElement;
  setupBanner: HTMLElement;
  setupTitle: HTMLElement;
  setupDetail: HTMLElement;
  setupBar: HTMLElement;
  setupFill: HTMLDivElement;
  setupPct: HTMLElement;
  setupBegin: HTMLButtonElement;
  setupRetry: HTMLButtonElement;
  setupSteps: HTMLElement;
  setupVerify: HTMLAnchorElement;
  columnDialog: HTMLDialogElement;
  columnTitle: HTMLInputElement;
  columnKind: HTMLSelectElement;
  columnPredicate: HTMLTextAreaElement;
  columnSave: HTMLButtonElement;
  columnCancel: HTMLButtonElement;
  columnClose: HTMLButtonElement;
  resetState: HTMLButtonElement;
}

interface ColumnRuntime {
  column: Column;
  el: HTMLElement;
  body: HTMLElement;
  topStatus: HTMLElement;
  sentinel: HTMLElement;
  cursor: number;
  loading: boolean;
  topRefreshing: boolean;
  topPull: number;
  topPullReset: number | null;
  hasMore: boolean;
}

interface AppState {
  deck: Deck;
  columns: Map<string, ColumnRuntime>;
  columnItems: Map<string, ColumnItem[]>;
  storyById: Map<number, HNStory>;
  readerContext: string;
  sessionPrompt: string;
  modelReady: boolean;
  routingCursor: number;
  routing: boolean;
  /** True while rendering cards from a Nano routing/polling pass. */
  markingFresh: boolean;
  autoReloadTimer: number | null;
  autoReloadMs: number;
  autoReloadEnabled: boolean;
  focusedColumnId: string | null;
  editingColumnId: string | null;
  mastheadTitle: string;
  mastheadSubtitle: string;
  mastheadTitleVisible: boolean;
  mastheadSubtitleVisible: boolean;
  customCSS: string;
  themeVars: Record<string, string>;
  persistTimer: number | null;
  domSnapshotTimer: number | null;
  domSnapshotRepairing: boolean;
  mastheadObserver?: MutationObserver;
  columnTitleObserver?: MutationObserver;
  deckStructureObserver?: MutationObserver;
  domSnapshotObserver?: MutationObserver;
  customCSSObserver?: MutationObserver;
  cssVarWatchTimer?: number;
  composeAbort?: AbortController;
}

interface PersistedState {
  deck: Deck;
  readerContext: string;
  sessionPrompt: string;
  autoReloadMs: number;
  autoReloadEnabled: boolean;
  mastheadTitle: string;
  mastheadSubtitle: string;
  mastheadTitleVisible: boolean;
  mastheadSubtitleVisible: boolean;
  customCSS: string;
  themeVars: Record<string, string>;
}

interface DOMSnapshot {
  documentAttributes: [string, string][];
  headHTML: string;
  bodyAttributes: [string, string][];
  bodyHTML: string;
}

interface DOMBaseline extends DOMSnapshot {
  bodyTemplate: HTMLTemplateElement;
}

export async function startDeckApp(): Promise<void> {
  try {
    await startDeckAppAsync();
  } catch (err) {
    console.error("[startDeckApp]", err);
    markAppReady();
    const banner = document.createElement("div");
    banner.style.cssText =
      "position:fixed;top:0;left:0;right:0;background:#ea4335;color:#fff;padding:12px;font:14px monospace;z-index:99999;white-space:pre-wrap;";
    banner.textContent = `[startDeckApp] ${err instanceof Error ? err.stack || err.message : String(err)}`;
    document.body.appendChild(banner);
  }
}

async function startDeckAppAsync(): Promise<void> {
  const baseline = createDOMBaseline();
  await applyPersistedDOMSnapshot();
  ensureCoreDOM(baseline);
  const dom = getDOM();
  const persisted = await loadPersistedState();
  const state: AppState = {
    deck: persisted?.deck ?? defaultDeck(),
    columns: new Map(),
    columnItems: new Map(),
    storyById: new Map(),
    readerContext: persisted?.readerContext ?? "",
    sessionPrompt: persisted?.sessionPrompt ?? "",
    modelReady: false,
    routingCursor: 0,
    routing: false,
    markingFresh: false,
    autoReloadTimer: null,
    autoReloadMs: persisted?.autoReloadMs ?? DEFAULT_AUTO_RELOAD_MS,
    autoReloadEnabled: persisted?.autoReloadEnabled ?? true,
    focusedColumnId: null,
    editingColumnId: null,
    mastheadTitle: persisted?.mastheadTitle ?? readMastheadTitle(),
    mastheadSubtitle: persisted?.mastheadSubtitle ?? readMastheadSubtitle(),
    mastheadTitleVisible: persisted?.mastheadTitleVisible ?? true,
    mastheadSubtitleVisible: persisted?.mastheadSubtitleVisible ?? true,
    customCSS: persisted?.customCSS ?? "",
    themeVars: persisted?.themeVars ?? {},
    persistTimer: null,
    domSnapshotTimer: null,
    domSnapshotRepairing: false,
  };

  syncAppOwnedControls(state, dom);
  applyMasthead(state);
  observeMastheadEdits(state);
  applyThemeVars(state.themeVars);
  observeCSSVarEdits(state);
  applyCustomCSS(state.customCSS);
  observeCustomCSSEdits(state);
  renderDeck(state, dom);
  updateReloadEveryButton(state, dom);
  bindCoreControls(state, dom);
  markAppReady();
  window.addEventListener("resize", () => updateDeckOverflowState(dom));
  void bootstrap(state, dom);
  exposeOperationalConsoleAPI(state);

  observeColumnTitleEdits(state, dom);
  observeDeckStructureEdits(state, dom);
  observeDOMSnapshotChanges(state, baseline);
  printDevToolsInstructions();
}

function markAppReady(): void {
  document.body.dataset.appReady = "true";
  window.setTimeout(() => document.getElementById("boot-loading")?.remove(), 250);
}

function createDOMBaseline(): DOMBaseline {
  const snapshot = readDOMSnapshot();
  const bodyTemplate = document.createElement("template");
  bodyTemplate.innerHTML = snapshot.bodyHTML;
  return { ...snapshot, bodyTemplate };
}

function readDOMSnapshot(): DOMSnapshot {
  return {
    documentAttributes: readAttributes(document.documentElement),
    headHTML: document.head?.innerHTML ?? "",
    bodyAttributes: readAttributes(document.body),
    bodyHTML: document.body?.innerHTML ?? "",
  };
}

function readAttributes(el: Element | null): [string, string][] {
  if (!el) return [];
  return Array.from(el.attributes, (attr) => [attr.name, attr.value]);
}

function applyAttributes(el: Element, attrs: [string, string][]): void {
  for (const attr of Array.from(el.attributes)) el.removeAttribute(attr.name);
  for (const [name, value] of attrs) el.setAttribute(name, value);
}

async function applyPersistedDOMSnapshot(): Promise<void> {
  const snapshot = await loadDOMSnapshot();
  if (!snapshot) return;
  if (document.documentElement) applyAttributes(document.documentElement, snapshot.documentAttributes);
  if (document.head) document.head.innerHTML = snapshot.headHTML;
  if (document.body) {
    applyAttributes(document.body, snapshot.bodyAttributes);
    document.body.innerHTML = snapshot.bodyHTML;
  }
}

async function loadDOMSnapshot(): Promise<DOMSnapshot | null> {
  try {
    const root = await getOPFSRoot();
    if (!root) return null;
    const handle = await root.getFileHandle(OPFS_DOM_SNAPSHOT_FILE);
    const parsed = JSON.parse(await (await handle.getFile()).text()) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const raw = parsed as Record<string, unknown>;
    return {
      documentAttributes: readPersistedAttributes(raw.documentAttributes),
      headHTML: typeof raw.headHTML === "string" ? raw.headHTML : "",
      bodyAttributes: readPersistedAttributes(raw.bodyAttributes),
      bodyHTML: typeof raw.bodyHTML === "string" ? raw.bodyHTML : "",
    };
  } catch {
    return null;
  }
}

function readPersistedAttributes(value: unknown): [string, string][] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is [string, string] => Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string",
  );
}

function ensureCoreDOM(baseline: DOMBaseline): void {
  let html = document.documentElement;
  if (!html) {
    html = document.createElement("html");
    document.appendChild(html);
  }
  if (!document.head) html.appendChild(document.createElement("head"));
  if (!document.body) html.appendChild(document.createElement("body"));

  ensureTopbar(baseline);
  const main = ensureMain(baseline);
  ensureChildElement("status", main, baseline);
  ensureChildElement("setup-banner", main, baseline);
  ensureChildElement("deck", main, baseline);
  ensureDialogWithChildren("about-dialog", ["about-close"], baseline);
  ensureDialogWithChildren("editor-dialog", ["editor-close", "editor-done", "reader-context", "session-prompt", "reset-state"], baseline);
  ensureDialogWithChildren("column-dialog", ["column-close", "column-title", "column-kind", "column-predicate", "column-save", "column-cancel"], baseline);
  ensureAppCSS(baseline);
}

function ensureTopbar(baseline: DOMBaseline): void {
  const required = ["reload-every-btn", "add-column-btn", "editor-btn", "about-btn"];
  const current = document.querySelector<HTMLElement>(".topbar");
  if (current && required.every((id) => document.getElementById(id))) return;
  const next = cloneBaselineElement<HTMLElement>(baseline, ".topbar");
  if (!next || !document.body) return;
  current?.remove();
  document.body.insertBefore(next, document.body.firstChild);
}

function ensureMain(baseline: DOMBaseline): HTMLElement {
  const current = document.querySelector<HTMLElement>(".main");
  if (current) return current;
  const next = cloneBaselineElement<HTMLElement>(baseline, ".main") ?? document.createElement("main");
  next.classList.add("main");
  document.body.appendChild(next);
  return next;
}

function ensureChildElement(id: string, parent: HTMLElement, baseline: DOMBaseline): HTMLElement {
  const existing = document.getElementById(id) as HTMLElement | null;
  if (existing) return existing;
  const next = cloneBaselineElement<HTMLElement>(baseline, `#${id}`) ?? document.createElement("div");
  next.id = id;
  parent.appendChild(next);
  return next;
}

function ensureDialogWithChildren(id: string, childIds: string[], baseline: DOMBaseline): void {
  const current = document.getElementById(id) as HTMLElement | null;
  if (current && childIds.every((childId) => document.getElementById(childId))) return;
  const next = cloneBaselineElement<HTMLElement>(baseline, `#${id}`);
  if (!next || !document.body) return;
  current?.remove();
  document.body.appendChild(next);
}

function cloneBaselineElement<T extends HTMLElement>(baseline: DOMBaseline, selector: string): T | null {
  return baseline.bodyTemplate.content.querySelector<T>(selector)?.cloneNode(true) as T | null;
}

function ensureAppCSS(baseline: DOMBaseline): void {
  const current = document.getElementById(APP_CSS_ID);
  const next = cloneBaselineElement<HTMLStyleElement>(baseline, `#${APP_CSS_ID}`);
  if (!next || !document.body) return;
  current?.remove();
  document.body.appendChild(next);
}

function getDOM(): DOM {
  const get = <T extends HTMLElement>(id: string): T => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Missing #${id}`);
    return el as T;
  };
  return {
    status: get("status"),
    deck: get("deck"),
    contextBox: get<HTMLTextAreaElement>("reader-context"),
    sessionBox: get<HTMLInputElement>("session-prompt"),
    reloadEveryBtn: get<HTMLButtonElement>("reload-every-btn"),
    addColumnBtn: get<HTMLButtonElement>("add-column-btn"),
    setupBanner: get("setup-banner"),
    setupTitle: get("setup-title"),
    setupDetail: get("setup-detail"),
    setupBar: get("setup-bar"),
    setupFill: get<HTMLDivElement>("setup-fill"),
    setupPct: get("setup-pct"),
    setupBegin: get<HTMLButtonElement>("setup-begin"),
    setupRetry: get<HTMLButtonElement>("setup-retry"),
    setupSteps: get("setup-steps"),
    setupVerify: get<HTMLAnchorElement>("setup-verify"),
    columnDialog: get<HTMLDialogElement>("column-dialog"),
    columnTitle: get<HTMLInputElement>("column-title"),
    columnKind: get<HTMLSelectElement>("column-kind"),
    columnPredicate: get<HTMLTextAreaElement>("column-predicate"),
    columnSave: get<HTMLButtonElement>("column-save"),
    columnCancel: get<HTMLButtonElement>("column-cancel"),
    columnClose: get<HTMLButtonElement>("column-close"),
    resetState: get<HTMLButtonElement>("reset-state"),
  };
}

function tryGetDOM(): DOM | null {
  try {
    return getDOM();
  } catch {
    return null;
  }
}

function syncAppOwnedControls(state: AppState, dom: DOM): void {
  if (dom.contextBox.value !== state.readerContext) dom.contextBox.value = state.readerContext;
  if (dom.sessionBox.value !== state.sessionPrompt) dom.sessionBox.value = state.sessionPrompt;
  updateReloadEveryButton(state, dom);
}

function bindCoreControls(state: AppState, dom: DOM): void {
  dom.contextBox.oninput = () => {
    state.readerContext = dom.contextBox.value;
    queuePersistState(state);
  };
  dom.sessionBox.oninput = () => {
    state.sessionPrompt = dom.sessionBox.value;
    queuePersistState(state);
  };
  dom.setupBegin.onclick = () => void beginModelDownload(state, dom);
  dom.setupRetry.onclick = () => void bootstrap(state, dom);
  dom.reloadEveryBtn.onclick = () => toggleAutoReload(state, dom);
  dom.addColumnBtn.onclick = () => openColumnDialog(state, dom, null);
  dom.columnKind.onchange = () => syncColumnPredicateState(dom);
  dom.columnSave.onclick = () => saveColumnDialog(state, dom);
  dom.columnCancel.onclick = () => closeColumnDialog(state, dom);
  dom.columnClose.onclick = () => closeColumnDialog(state, dom);
  dom.resetState.onclick = () => void resetPersistedState();
  dom.columnDialog.onclick = (ev) => {
    if (ev.target === dom.columnDialog) closeColumnDialog(state, dom);
  };
  wireDialogControls("about-dialog", "about-btn", "about-close");
  wireDialogControls("editor-dialog", "editor-btn", "editor-close", "editor-done");
}

function wireDialogControls(dialogId: string, openBtnId: string, closeBtnId: string, doneBtnId?: string): void {
  const dlg = document.getElementById(dialogId) as HTMLDialogElement | null;
  const openBtn = document.getElementById(openBtnId) as HTMLElement | null;
  const closeBtn = document.getElementById(closeBtnId) as HTMLElement | null;
  const doneBtn = doneBtnId ? document.getElementById(doneBtnId) as HTMLElement | null : null;
  if (!dlg || !openBtn) return;
  openBtn.onclick = () => {
    if (typeof dlg.showModal === "function") dlg.showModal();
    else dlg.setAttribute("open", "");
  };
  closeBtn && (closeBtn.onclick = () => dlg.close());
  doneBtn && (doneBtn.onclick = () => dlg.close());
  dlg.onclick = (ev) => {
    if (ev.target === dlg) dlg.close();
  };
}

function setStatus(dom: DOM, text: string, kind: "info" | "warn" | "error" = "info"): void {
  dom.status.textContent = text;
  dom.status.dataset.kind = kind;
  dom.status.hidden = kind === "info";
}

type SetupState =
  | { kind: "hidden" }
  | { kind: "begin" }
  | { kind: "downloading"; progress: number }
  | { kind: "guide"; content: GuideContent };

function setSetup(dom: DOM, s: SetupState): void {
  if (s.kind === "hidden") {
    dom.setupBanner.hidden = true;
    return;
  }
  dom.setupBanner.hidden = false;
  dom.setupBar.hidden = true;
  dom.setupPct.hidden = true;
  dom.setupBegin.hidden = true;
  dom.setupRetry.hidden = true;
  dom.setupSteps.hidden = true;
  dom.setupVerify.hidden = true;

  if (s.kind === "begin") {
    dom.setupTitle.textContent = "Gemini Nano isn't downloaded yet";
    dom.setupDetail.textContent = "Raw HN columns work now. Enable Nano to let your on-device editor route stories into custom columns.";
    dom.setupBegin.hidden = false;
    return;
  }
  if (s.kind === "downloading") {
    const pct = Math.round(Math.max(0, Math.min(100, s.progress * 100)));
    dom.setupTitle.textContent = "Downloading Gemini Nano…";
    dom.setupDetail.textContent = "First time only; Chrome caches it for future visits.";
    dom.setupBar.hidden = false;
    dom.setupPct.hidden = false;
    dom.setupFill.style.width = `${pct}%`;
    dom.setupPct.textContent = `${pct}%`;
    return;
  }

  dom.setupTitle.textContent = s.content.title;
  dom.setupDetail.innerHTML = s.content.intro;
  dom.setupSteps.hidden = false;
  dom.setupSteps.innerHTML = s.content.steps.map((x) => `<li>${x}</li>`).join("");
  if (s.content.verifyLink) {
    dom.setupVerify.hidden = false;
    dom.setupVerify.textContent = `${s.content.verifyLink.label} →`;
    dom.setupVerify.href = s.content.verifyLink.href;
  }
  dom.setupRetry.hidden = false;
}

async function bootstrap(state: AppState, dom: DOM): Promise<void> {
  setStatus(dom, "Loading Hacker News. Checking Nano in the background…");
  const status: ModelStatus = await checkAvailability();
  if (status.kind === "available") {
    state.modelReady = true;
    setSetup(dom, { kind: "hidden" });
    dom.contextBox.disabled = false;
    dom.sessionBox.disabled = false;
    setStatus(dom, "Nano is ready. Filling curated columns…");
    void routeUntilFilled(state, dom);
    return;
  }
  if (status.kind === "unsupported") {
    const info = detectBrowser();
    setSetup(dom, { kind: "guide", content: guideContentFor(classifyFailure(info, false, status.reason)) });
    setStatus(dom, "Raw columns are available. Nano setup required for routing.");
    return;
  }
  setSetup(dom, { kind: "begin" });
  setStatus(dom, "Raw columns are available. Nano needs one download before routing.");
}

async function beginModelDownload(state: AppState, dom: DOM): Promise<void> {
  setSetup(dom, { kind: "downloading", progress: 0 });
  try {
    const warmup = await createSession("Reply ok.", (p) => setSetup(dom, { kind: "downloading", progress: p }));
    warmup.destroy();
    state.modelReady = true;
    setSetup(dom, { kind: "hidden" });
    dom.contextBox.disabled = false;
    dom.sessionBox.disabled = false;
    setStatus(dom, "Nano is ready. Filling curated columns…");
    void routeUntilFilled(state, dom);
  } catch (err) {
    const info = detectBrowser();
    setSetup(dom, { kind: "guide", content: guideContentFor(classifyFailure(info, true, err instanceof Error ? err.message : String(err))) });
    setStatus(dom, "Nano download failed. Raw columns still work.", "error");
  }
}

function renderDeck(state: AppState, dom: DOM): void {
  dom.deck.innerHTML = "";
  state.columns.clear();
  for (const column of state.deck.columns) {
    const el = document.createElement("section");
    el.className = `deck-column deck-column--${column.kind}`;
    el.dataset.columnId = column.id;
    el.innerHTML = `
      <header class="deck-column__header">
        <h2 class="deck-column__title">${escapeHtml(column.title)}</h2>
        <div class="deck-column__actions">
          <button class="deck-column__btn deck-column__btn--edit" data-action="left" title="Move column left" aria-label="Move column left">←</button>
          <button class="deck-column__btn deck-column__btn--edit" data-action="right" title="Move column right" aria-label="Move column right">→</button>
          <button class="deck-column__btn" data-action="focus" title="Focus column" aria-label="Focus column">⛶</button>
          <button class="deck-column__btn deck-column__btn--edit" data-action="edit" title="Edit column" aria-label="Edit column">✎</button>
          <button class="deck-column__btn deck-column__btn--edit" data-action="remove" title="Remove column" aria-label="Remove column">×</button>
        </div>
      </header>
      <div class="deck-column__top-status" hidden>Release to refresh</div>
      <div class="deck-column__body"></div>
      <div class="deck-column__sentinel">Loading…</div>
    `;
    const topStatus = el.querySelector<HTMLElement>(".deck-column__top-status")!;
    const body = el.querySelector<HTMLElement>(".deck-column__body")!;
    const sentinel = el.querySelector<HTMLElement>(".deck-column__sentinel")!;
    const runtime: ColumnRuntime = {
      column,
      el,
      body,
      topStatus,
      sentinel,
      cursor: 0,
      loading: false,
      topRefreshing: false,
      topPull: 0,
      topPullReset: null,
      hasMore: true,
    };
    state.columns.set(column.id, runtime);
    dom.deck.appendChild(el);

    renderColumnCache(state, runtime);

    el.querySelector<HTMLElement>('[data-action="left"]')?.addEventListener("click", () => moveColumnInDeck(state, dom, column.id, -1));
    el.querySelector<HTMLElement>('[data-action="right"]')?.addEventListener("click", () => moveColumnInDeck(state, dom, column.id, 1));
    el.querySelector<HTMLElement>('[data-action="focus"]')?.addEventListener("click", () => toggleColumnFocus(state, dom, column.id));
    el.querySelector<HTMLElement>('[data-action="edit"]')?.addEventListener("click", () => editColumn(state, dom, column.id));
    el.querySelector<HTMLElement>('[data-action="remove"]')?.addEventListener("click", () => {
      state.deck = removeColumn(state.deck, column.id);
      queuePersistState(state);
      renderDeck(state, dom);
    });

    body.addEventListener("scroll", () => {
      resetAutoReloadTimer(state, dom);
      if (body.scrollTop + body.clientHeight >= body.scrollHeight - 240) {
        if (column.kind === "raw") void loadRawBatch(state, runtime);
        else void routeUntilFilled(state, dom);
      }
    });
    body.addEventListener("wheel", (ev) => {
      resetAutoReloadTimer(state, dom);
      if (body.scrollTop <= 0 && ev.deltaY < 0) {
        runtime.topPull += Math.abs(ev.deltaY);
        runtime.topStatus.hidden = false;
        runtime.topStatus.textContent = runtime.topPull >= 80 ? "Refreshing…" : "Pull to refresh";
        if (runtime.topPullReset !== null) window.clearTimeout(runtime.topPullReset);
        runtime.topPullReset = window.setTimeout(() => {
          runtime.topPull = 0;
          if (!runtime.topRefreshing) runtime.topStatus.hidden = true;
        }, 240);
        if (runtime.topPull >= 80) {
          runtime.topPull = 0;
          void refreshColumnFromTop(state, dom, runtime);
        }
      }
    }, { passive: true });

    if (column.kind === "raw") {
      if (getColumnItems(state, column.id).length === 0) void loadRawBatch(state, runtime);
      else runtime.sentinel.textContent = runtime.hasMore ? "Scroll for more" : "End of HN topstories";
    } else if (getColumnItems(state, column.id).length === 0) {
      renderCuratedEmpty(runtime);
    }
  }
  applyFocusState(state, dom);
  updateDeckOverflowState(dom);
}

function updateDeckOverflowState(dom: DOM): void {
  requestAnimationFrame(() => {
    const overflowing = dom.deck.scrollWidth > dom.deck.clientWidth + 1;
    dom.deck.classList.toggle("deck--overflowing", overflowing);
  });
}

function renderCuratedEmpty(runtime: ColumnRuntime): void {
  runtime.body.innerHTML = `
    <p class="deck-empty">
      Waiting for Nano routing. Once Nano is ready, stories matching
      this column's description will appear here automatically.
    </p>
  `;
  runtime.sentinel.textContent = "Not routed yet";
}

async function loadRawBatch(state: AppState, runtime: ColumnRuntime): Promise<void> {
  if (runtime.loading || !runtime.hasMore) return;
  runtime.loading = true;
  runtime.sentinel.textContent = "Loading more…";
  const batch = await fetchFeedStoryBatch(
    runtime.column.feed ?? "top",
    runtime.cursor,
    runtime.cursor + BATCH,
    undefined,
    { user: runtime.column.feedUser, month: runtime.column.feedMonth },
  );
  for (const story of batch.stories) {
    if (runtime.body.querySelector(`[data-story-id="${story.id}"]`)) continue;
    state.storyById.set(story.id, story);
    upsertColumnItem(state, runtime.column.id, { storyId: story.id, lastRenderedAt: Date.now() });
    runtime.body.appendChild(renderStoryCard(story));
  }
  runtime.cursor += BATCH;
  runtime.hasMore = batch.hasMore;
  runtime.loading = false;
  runtime.sentinel.textContent = runtime.hasMore ? "Scroll for more" : "End of HN topstories";
}

async function refreshColumnFromTop(state: AppState, dom: DOM, runtime: ColumnRuntime): Promise<void> {
  if (runtime.topRefreshing) return;
  runtime.topRefreshing = true;
  runtime.topStatus.hidden = false;
  runtime.topStatus.innerHTML = `<span class="deck-spinner" aria-hidden="true"></span> Refreshing…`;
  try {
    if (runtime.column.kind === "raw") {
      clearHNCache();
      const batch = await fetchFeedStoryBatch(
        runtime.column.feed ?? "top",
        0,
        BATCH,
        undefined,
        { user: runtime.column.feedUser, month: runtime.column.feedMonth },
      );
      const fragment = document.createDocumentFragment();
      let added = 0;
      for (const story of batch.stories) {
        state.storyById.set(story.id, story);
        const item = { storyId: story.id, lastRenderedAt: Date.now() };
        const existing = runtime.body.querySelector<HTMLElement>(`[data-story-id="${story.id}"]`);
        if (existing) {
          if (!shouldReplaceColumnItem(state, runtime.column.id, story.id)) continue;
          upsertColumnItem(state, runtime.column.id, item);
          existing.replaceWith(renderStoryCard(story, undefined, undefined, true));
          added++;
          continue;
        }
        upsertColumnItem(state, runtime.column.id, item, "prepend");
        fragment.appendChild(renderStoryCard(story, undefined, undefined, true));
        added++;
      }
      if (added > 0) runtime.body.prepend(fragment);
      runtime.sentinel.textContent = added > 0 ? `Added ${added} new` : "No new items";
      runtime.cursor = Math.max(runtime.cursor, BATCH);
      runtime.hasMore = batch.hasMore;
    } else {
      await routeFreshTopBatch(state, dom);
      runtime.sentinel.textContent = "Refreshed";
    }
  } finally {
    runtime.topRefreshing = false;
    runtime.topPull = 0;
    window.setTimeout(() => {
      if (!runtime.topRefreshing) runtime.topStatus.hidden = true;
    }, 700);
  }
}

async function routeNextBatch(state: AppState, dom: DOM): Promise<void> {
  if (!state.modelReady) {
    setStatus(dom, "Nano is not ready yet. Enable/download Nano first; raw Front page still works.", "warn");
    for (const rt of state.columns.values()) {
      if (rt.column.kind === "curated" && rt.body.querySelector(".deck-empty")) {
        rt.sentinel.textContent = "Nano not ready";
      }
    }
    return;
  }
  if (state.routing) return;
  state.routing = true;
  try {
    await routeOneBatch(state, dom);
  } finally {
    state.routing = false;
    scheduleAutoReload(state, dom);
  }
}

async function routeUntilFilled(state: AppState, dom: DOM): Promise<void> {
  if (!state.modelReady) {
    await routeNextBatch(state, dom);
    return;
  }
  if (state.routing) return;
  state.routing = true;
  try {
    markUnderfilledColumnsBusy(state);
    while (underfilledCuratedColumns(state).length > 0) {
      const missing = underfilledCuratedColumns(state).map((rt) => rt.column.title).join(", ");
      setStatus(dom, `Nano is still routing. Underfilled: ${missing}`);
      const hasMore = await routeOneBatch(state, dom);
      if (!hasMore) break;
    }
    const missing = underfilledCuratedColumns(state);
    if (missing.length === 0) {
      setStatus(dom, "Curated columns have a backlog. Scroll for rolling updates.");
      for (const rt of state.columns.values()) {
        if (rt.column.kind === "curated") rt.sentinel.textContent = "Scroll for rolling updates";
      }
    } else {
      setStatus(dom, `HN exhausted; still underfilled: ${missing.map((rt) => rt.column.title).join(", ")}`, "warn");
      for (const rt of missing) rt.sentinel.textContent = "HN exhausted";
    }
  } finally {
    state.routing = false;
    scheduleAutoReload(state, dom);
  }
}

async function routeOneBatch(
  state: AppState,
  dom: DOM,
  opts: { clearFirstBatch?: boolean; silent?: boolean } = {},
): Promise<boolean> {
  const clearFirstBatch = opts.clearFirstBatch ?? true;
  const silent = opts.silent ?? false;
  const curated = state.deck.columns.filter((c) => c.kind === "curated");
  if (curated.length === 0) return false;
  setRoutingVisuals(state, true);
  state.markingFresh = true;
  if (!silent) {
    setStatus(dom, `Routing stories ${state.routingCursor + 1}–${state.routingCursor + BATCH} through Nano…`);
  }

  const batch = await fetchTopStoryBatch(state.routingCursor, state.routingCursor + BATCH);
  for (const s of batch.stories) state.storyById.set(s.id, s);
  if (state.routingCursor === 0 && clearFirstBatch) {
    for (const col of curated) {
      const rt = state.columns.get(col.id);
      if (rt) rt.body.innerHTML = "";
    }
  }

  const sink: DeckSink = {
    enqueue(action) {
      renderDeckAction(state, action);
    },
    onSkip(reason) {
      console.warn("[deck] skipped", reason);
    },
  };
  const router = new DeckRouter(curated.map((c) => c.id), batch.stories.map((s) => s.id), sink);
  const executor = createDeckExecutor(router);
  const readerContext = [dom.contextBox.value.trim(), dom.sessionBox.value.trim() ? `Today's directive: ${dom.sessionBox.value.trim()}` : ""]
    .filter(Boolean)
    .join("\n");

  let session;
  try {
    session = await createSession(buildDeckSystemPrompt({ readerContext, columns: state.deck.columns, stories: batch.stories, batchStart: state.routingCursor }));
    for await (const chunk of streamPrompt(session, buildDeckUserPrompt())) executor.push(chunk);
    executor.end();
    state.routingCursor += BATCH;
    return batch.hasMore;
  } catch (err) {
    setStatus(dom, `Routing failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    return false;
  } finally {
    session?.destroy();
    state.markingFresh = false;
    setRoutingVisuals(state, false);
  }
}

async function routeFreshTopBatch(state: AppState, dom: DOM): Promise<void> {
  if (!state.modelReady || state.routing) return;
  state.routing = true;
  const previousCursor = state.routingCursor;
  try {
    clearHNCache();
    state.routingCursor = 0;
    await routeOneBatch(state, dom, { clearFirstBatch: false, silent: true });
  } finally {
    state.routingCursor = previousCursor;
    state.routing = false;
    scheduleAutoReload(state, dom);
  }
}

function scheduleAutoReload(state: AppState, dom: DOM): void {
  clearAutoReloadTimer(state);
  if (!state.autoReloadEnabled) return;
  state.autoReloadTimer = window.setTimeout(() => {
    void routeFreshTopBatch(state, dom);
  }, state.autoReloadMs);
  updateReloadEveryButton(state, dom);
}

function resetAutoReloadTimer(state: AppState, dom: DOM): void {
  if (!state.autoReloadEnabled) return;
  scheduleAutoReload(state, dom);
}

function clearAutoReloadTimer(state: AppState): void {
  if (state.autoReloadTimer !== null) {
    clearTimeout(state.autoReloadTimer);
    state.autoReloadTimer = null;
  }
}

function toggleAutoReload(state: AppState, dom: DOM): void {
  if (!state.autoReloadEnabled) {
    state.autoReloadEnabled = true;
    state.autoReloadMs = AUTO_RELOAD_OPTIONS[0];
    scheduleAutoReload(state, dom);
    return;
  }

  const idx = AUTO_RELOAD_OPTIONS.findIndex((ms) => ms === state.autoReloadMs);
  const next = idx + 1;
  if (next >= AUTO_RELOAD_OPTIONS.length) {
    state.autoReloadEnabled = false;
    clearAutoReloadTimer(state);
  } else {
    state.autoReloadMs = AUTO_RELOAD_OPTIONS[next];
    scheduleAutoReload(state, dom);
  }
  updateReloadEveryButton(state, dom);
}

function updateReloadEveryButton(state: AppState, dom: DOM): void {
  const label = state.autoReloadEnabled ? `Reload every ${formatReloadInterval(state.autoReloadMs)}` : "Auto reload off";
  dom.reloadEveryBtn.innerHTML = `<span aria-hidden="true">↻</span><span>${label}</span>`;
}

function formatReloadInterval(ms: number): string {
  if (ms === 60_000) return "1m";
  if (ms === 5 * 60_000) return "5m";
  if (ms === 60 * 60_000) return "1h";
  return `${Math.round(ms / 1000)}s`;
}

function underfilledCuratedColumns(state: AppState): ColumnRuntime[] {
  return Array.from(state.columns.values()).filter((rt) =>
    rt.column.kind === "curated" && visibleCardCount(rt) < MIN_CURATED_CARDS,
  );
}

function markUnderfilledColumnsBusy(state: AppState): void {
  for (const rt of underfilledCuratedColumns(state)) {
    rt.sentinel.textContent = "Nano routing…";
  }
}

function setRoutingVisuals(state: AppState, active: boolean): void {
  for (const rt of state.columns.values()) {
    if (rt.column.kind !== "curated") continue;
    rt.el.classList.toggle("deck-column--routing", active);
    if (active) {
      rt.sentinel.innerHTML = `<span class="deck-spinner" aria-hidden="true"></span> Nano routing…`;
    } else if (rt.sentinel.textContent?.includes("routing")) {
      rt.sentinel.textContent = "Scroll for rolling updates";
    }
  }
}

function renderDeckAction(state: AppState, action: DeckAction): void {
  if (action.kind === "drop") return;
  const rt = state.columns.get(action.columnId);
  if (!rt) return;
  if (action.kind === "note") {
    const p = document.createElement("p");
    p.className = "deck-note";
    p.textContent = action.text;
    rt.body.appendChild(p);
    return;
  }
  if (action.kind === "place") {
    const story = state.storyById.get(action.storyId);
    if (!story) return;
    if (!shouldReplaceColumnItem(state, rt.column.id, action.storyId)) return;
    const nextItem: ColumnItem = {
      storyId: story.id,
      headline: action.headline,
      body: action.body,
      lastRenderedAt: Date.now(),
    };
    upsertColumnItem(state, rt.column.id, nextItem);
    const card = renderStoryCard(story, action.headline, action.body, state.markingFresh);
    const existing = rt.body.querySelector<HTMLElement>(`[data-story-id="${story.id}"]`);
    if (existing) existing.replaceWith(card);
    else rt.body.appendChild(card);
    return;
  }
  // No subgroup UI. If Nano disobeys and emits cluster(), flatten it
  // into normal individual cards in that column.
  const stories = action.storyIds
    .filter((id) => !rt.body.querySelector(`[data-story-id="${id}"]`))
    .map((id) => state.storyById.get(id))
    .filter((s): s is HNStory => !!s);
  for (const story of stories) {
    if (!shouldReplaceColumnItem(state, rt.column.id, story.id)) continue;
    const body = `${action.title}: ${action.body}`;
    upsertColumnItem(state, rt.column.id, { storyId: story.id, body, lastRenderedAt: Date.now() });
    const card = renderStoryCard(story, undefined, body, state.markingFresh);
    const existing = rt.body.querySelector<HTMLElement>(`[data-story-id="${story.id}"]`);
    if (existing) existing.replaceWith(card);
    else rt.body.appendChild(card);
  }
}

function renderColumnCache(state: AppState, runtime: ColumnRuntime): void {
  const items = getColumnItems(state, runtime.column.id);
  if (items.length === 0) return;
  runtime.body.innerHTML = "";
  for (const item of items) {
    const story = state.storyById.get(item.storyId);
    if (!story) continue;
    runtime.body.appendChild(renderStoryCard(story, item.headline, item.body));
  }
  runtime.cursor = Math.max(runtime.cursor, items.length);
}

function getColumnItems(state: AppState, columnId: string): ColumnItem[] {
  let items = state.columnItems.get(columnId);
  if (!items) {
    items = [];
    state.columnItems.set(columnId, items);
  }
  return items;
}

function upsertColumnItem(
  state: AppState,
  columnId: string,
  item: ColumnItem,
  mode: "append" | "prepend" = "append",
): void {
  const items = getColumnItems(state, columnId);
  const idx = items.findIndex((x) => x.storyId === item.storyId);
  if (idx >= 0) {
    items[idx] = { ...items[idx], ...item };
    queuePersistState(state);
    return;
  }
  if (mode === "prepend") items.unshift(item);
  else items.push(item);
  queuePersistState(state);
}

function shouldReplaceColumnItem(state: AppState, columnId: string, storyId: number): boolean {
  const existing = getColumnItems(state, columnId).find((x) => x.storyId === storyId);
  if (!existing) return true;
  return Date.now() - existing.lastRenderedAt > CARD_STALE_MS;
}

async function loadPersistedState(): Promise<PersistedState | null> {
  try {
    const root = await getOPFSRoot();
    if (!root) return null;
    const handle = await root.getFileHandle(OPFS_STATE_FILE);
    const parsed = JSON.parse(await (await handle.getFile()).text()) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const raw = parsed as Record<string, unknown>;

    return {
      deck: coerceDeck(raw.deck),
      readerContext: typeof raw.readerContext === "string" ? raw.readerContext : "",
      sessionPrompt: typeof raw.sessionPrompt === "string" ? raw.sessionPrompt : "",
      autoReloadMs: typeof raw.autoReloadMs === "number" ? raw.autoReloadMs : DEFAULT_AUTO_RELOAD_MS,
      autoReloadEnabled: typeof raw.autoReloadEnabled === "boolean" ? raw.autoReloadEnabled : true,
      mastheadTitle: typeof raw.mastheadTitle === "string" ? raw.mastheadTitle : readMastheadTitle(),
      mastheadSubtitle: typeof raw.mastheadSubtitle === "string" ? raw.mastheadSubtitle : readMastheadSubtitle(),
      mastheadTitleVisible: typeof raw.mastheadTitleVisible === "boolean" ? raw.mastheadTitleVisible : true,
      mastheadSubtitleVisible: typeof raw.mastheadSubtitleVisible === "boolean" ? raw.mastheadSubtitleVisible : true,
      customCSS: typeof raw.customCSS === "string" ? raw.customCSS : "",
      themeVars: isStringRecord(raw.themeVars) ? raw.themeVars : {},
    };
  } catch {
    return null;
  }
}

function queuePersistState(state: AppState): void {
  if (state.persistTimer !== null) window.clearTimeout(state.persistTimer);
  state.persistTimer = window.setTimeout(() => {
    state.persistTimer = null;
    void persistStateNow(state);
  }, 250);
}

async function persistStateNow(state: AppState): Promise<void> {
  const root = await getOPFSRoot();
  if (!root) return;
  const snapshot = {
    deck: state.deck,
    readerContext: state.readerContext,
    sessionPrompt: state.sessionPrompt,
    autoReloadMs: state.autoReloadMs,
    autoReloadEnabled: state.autoReloadEnabled,
    mastheadTitle: state.mastheadTitle,
    mastheadSubtitle: state.mastheadSubtitle,
    mastheadTitleVisible: state.mastheadTitleVisible,
    mastheadSubtitleVisible: state.mastheadSubtitleVisible,
    customCSS: state.customCSS,
    themeVars: state.themeVars,
  };
  const handle = await root.getFileHandle(OPFS_STATE_FILE, { create: true });
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(snapshot));
  await writable.close();
}

function queueDOMSnapshotPersist(state: AppState, baseline: DOMBaseline): void {
  if (state.domSnapshotTimer !== null) window.clearTimeout(state.domSnapshotTimer);
  state.domSnapshotTimer = window.setTimeout(() => {
    state.domSnapshotTimer = null;
    void reconcileAndPersistDOMSnapshot(state, baseline);
  }, 350);
}

async function reconcileAndPersistDOMSnapshot(state: AppState, baseline: DOMBaseline): Promise<void> {
  if (state.domSnapshotRepairing) return;
  state.domSnapshotRepairing = true;
  try {
    ensureCoreDOM(baseline);
    const dom = tryGetDOM();
    if (dom) {
      bindCoreControls(state, dom);
      syncAppOwnedControls(state, dom);
      applyMasthead(state);
      applyThemeVars(state.themeVars);
      applyCustomCSS(state.customCSS);
      if (!deckStructureMatchesState(state, dom)) renderDeck(state, dom);
      observeMastheadEdits(state);
      observeColumnTitleEdits(state, dom);
      observeDeckStructureEdits(state, dom);
      observeCustomCSSEdits(state);
    }
    await persistDOMSnapshotNow();
  } finally {
    window.setTimeout(() => {
      state.domSnapshotRepairing = false;
    }, 0);
  }
}

async function persistDOMSnapshotNow(): Promise<void> {
  const root = await getOPFSRoot();
  if (!root) return;
  const handle = await root.getFileHandle(OPFS_DOM_SNAPSHOT_FILE, { create: true });
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(readDOMSnapshot()));
  await writable.close();
}

async function deletePersistedState(): Promise<void> {
  const root = await getOPFSRoot();
  if (!root) return;
  await Promise.all([removeOPFSEntryIfExists(root, OPFS_STATE_FILE), removeOPFSEntryIfExists(root, OPFS_DOM_SNAPSHOT_FILE)]);
}

async function removeOPFSEntryIfExists(root: FileSystemDirectoryHandle, name: string): Promise<void> {
  try {
    await root.removeEntry(name);
  } catch {
    /* no file */
  }
}

async function getOPFSRoot(): Promise<FileSystemDirectoryHandle | null> {
  const storage = navigator.storage as StorageManager & {
    getDirectory?: () => Promise<FileSystemDirectoryHandle>;
  };
  return storage.getDirectory ? storage.getDirectory() : null;
}

function renderStoryCard(story: HNStory, headline?: string, body?: string, fresh = false): HTMLElement {
  const el = document.createElement("article");
  el.className = ["deck-card", fresh ? "deck-card--fresh" : ""]
    .filter(Boolean)
    .join(" ");
  el.dataset.storyId = String(story.id);
  if (fresh) window.setTimeout(() => el.classList.remove("deck-card--fresh"), 45_000);
  const by = story.by ?? "unknown";
  const host = hostOf(story.url);
  const titleHref = story.url || hnPermalink(story.id);
  const comments = story.descendants ?? 0;
  const ts = story.time ? new Date(story.time * 1000) : null;
  const shortTime = ts ? relativeTime(ts) : "unknown time";
  const fullTime = ts ? formatFullTime(ts) : "unknown time";
  el.innerHTML = `
    <a class="deck-card__vote"
      href="${escapeAttr(hnPermalink(story.id))}"
      target="_blank" rel="noopener noreferrer"
      title="Open on HN to upvote">▲</a>
    <div class="deck-card__title-row">
      <img
        class="deck-card__favicon"
        src="${escapeAttr(faviconUrl(host))}"
        alt=""
        width="16"
        height="16"
        loading="lazy"
        referrerpolicy="no-referrer"
      />
      <h3 class="deck-card__title">
        <a class="deck-card__title-link"
          href="${escapeAttr(titleHref)}"
          target="_blank" rel="noopener noreferrer">${escapeHtml(headline || story.title)}</a>
      </h3>
    </div>
    <p class="deck-card__meta">
      <a href="${escapeAttr(hnFromSiteUrl(host))}" target="_blank" rel="noopener noreferrer">${escapeHtml(host)}</a>
      <span>·</span>
      <span>${story.score} pts</span>
      <span>·</span>
      <a href="${escapeAttr(hnPermalink(story.id))}" target="_blank" rel="noopener noreferrer">${comments} ${comments === 1 ? "comment" : "comments"}</a>
      <span>·</span>
      <span>by <a href="${escapeAttr(hnUserUrl(by))}" target="_blank" rel="noopener noreferrer">${escapeHtml(by)}</a></span>
      <span>·</span>
      <button class="deck-card__time" type="button" data-short="${escapeAttr(shortTime)}" data-full="${escapeAttr(fullTime)}" title="${escapeAttr(fullTime)}">${escapeHtml(shortTime)}</button>
    </p>
    ${body ? `<p class="deck-card__body">${escapeHtml(body)}</p>` : ""}
  `;
  const timeBtn = el.querySelector<HTMLButtonElement>(".deck-card__time");
  timeBtn?.addEventListener("click", () => {
    if (!timeBtn.dataset.full || !timeBtn.dataset.short) return;
    timeBtn.textContent = timeBtn.textContent === timeBtn.dataset.full
      ? timeBtn.dataset.short
      : timeBtn.dataset.full;
  });
  return el;
}

function editColumn(state: AppState, dom: DOM, id: string): void {
  openColumnDialog(state, dom, id);
}

function moveColumnInDeck(state: AppState, dom: DOM, id: string, direction: -1 | 1): void {
  state.deck = moveColumn(state.deck, id, direction);
  queuePersistState(state);
  renderDeck(state, dom);
}

function openColumnDialog(state: AppState, dom: DOM, id: string | null): void {
  state.editingColumnId = id;
  const col = id ? state.deck.columns.find((c) => c.id === id) : null;
  dom.columnTitle.value = col?.title ?? "Funny";
  dom.columnKind.value = col?.kind === "raw" ? (col.feed ?? "top") : "custom";
  dom.columnPredicate.value = col?.kind === "curated"
    ? col.description ?? ""
    : col?.feed === "user"
      ? col.feedUser ?? ""
      : col?.feed === "best-month"
        ? col.feedMonth ?? new Date().toISOString().slice(0, 7)
        : rawPredicateText(col?.feed ?? "top");
  syncColumnPredicateState(dom);
  if (typeof dom.columnDialog.showModal === "function") dom.columnDialog.showModal();
  else dom.columnDialog.setAttribute("open", "");
}

function closeColumnDialog(state: AppState, dom: DOM): void {
  state.editingColumnId = null;
  dom.columnDialog.close();
}

function saveColumnDialog(state: AppState, dom: DOM): void {
  const title = dom.columnTitle.value.trim();
  if (!title) return;
  const kind = dom.columnKind.value;
  const next: Omit<Column, "id"> =
    kind === "top" || kind === "new" || kind === "ask" || kind === "show"
      ? { kind: "raw", title, feed: kind, feedUser: undefined, feedMonth: undefined, description: undefined }
      : kind === "user"
        ? { kind: "raw", title, feed: "user", feedUser: dom.columnPredicate.value.trim(), feedMonth: undefined, description: undefined }
      : kind === "best-month"
        ? { kind: "raw", title, feed: "best-month", feedMonth: dom.columnPredicate.value.trim() || new Date().toISOString().slice(0, 7), feedUser: undefined, description: undefined }
      : {
          kind: "curated",
          title,
          description: dom.columnPredicate.value.trim() || "Stories matching this column's predicate.",
          feed: undefined,
          feedUser: undefined,
          feedMonth: undefined,
        };
  if (state.editingColumnId) {
    state.deck = updateColumn(state.deck, state.editingColumnId, next);
  } else {
    state.deck = addColumn(state.deck, { ...next, id: newColumnId() });
  }
  queuePersistState(state);
  closeColumnDialog(state, dom);
  renderDeck(state, dom);
  if (next.kind === "curated" && state.modelReady) {
    void routeUntilFilled(state, dom);
  }
}

function syncColumnPredicateState(dom: DOM): void {
  const isCustom = dom.columnKind.value === "custom";
  const needsParam = dom.columnKind.value === "user" || dom.columnKind.value === "best-month";
  dom.columnPredicate.disabled = !isCustom && !needsParam;
  if (!isCustom && !needsParam) dom.columnPredicate.value = rawPredicateText(dom.columnKind.value);
  if (dom.columnKind.value === "best-month" && !dom.columnPredicate.value.trim()) {
    dom.columnPredicate.value = new Date().toISOString().slice(0, 7);
  }
}

function rawPredicateText(feed: string): string {
  switch (feed) {
    case "new": return "Built-in Hacker News feed: newest stories.";
    case "ask": return "Built-in Hacker News feed: Ask HN discussions.";
    case "show": return "Built-in Hacker News feed: Show HN projects.";
    case "user": return "HN username";
    case "best-month": return "YYYY-MM";
    case "top":
    default: return "Built-in Hacker News feed: top stories.";
  }
}

function visibleCardCount(rt: ColumnRuntime): number {
  return rt.body.querySelectorAll(".deck-card").length;
}

function toggleColumnFocus(state: AppState, dom: DOM, id: string): void {
  state.focusedColumnId = state.focusedColumnId === id ? null : id;
  applyFocusState(state, dom);
  state.columns.get(id)?.el.scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" });
}

function applyFocusState(state: AppState, dom: DOM): void {
  dom.deck.classList.toggle("deck--focused", state.focusedColumnId !== null);
  for (const rt of state.columns.values()) {
    const focused = rt.column.id === state.focusedColumnId;
    const hidden = state.focusedColumnId !== null && !focused;
    rt.el.classList.toggle("deck-column--focused", focused);
    rt.el.classList.toggle("deck-column--dimmed", hidden);
    const btn = rt.el.querySelector<HTMLButtonElement>('[data-action="focus"]');
    if (btn) {
      btn.textContent = focused ? "↩" : "⛶";
      btn.title = focused ? "Back to deck" : "Focus column";
      btn.setAttribute("aria-label", btn.title);
    }
  }
  updateDeckOverflowState(dom);
}

function applyCustomCSS(css: string): void {
  let el = document.getElementById(CUSTOM_CSS_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = CUSTOM_CSS_ID;
    document.head.appendChild(el);
  }
  el.textContent = css;
}

function applyThemeVars(vars: Record<string, string>): void {
  let el = document.getElementById(THEME_VARS_CSS_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = THEME_VARS_CSS_ID;
    document.head.appendChild(el);
  }
  const lines = Object.entries(vars)
    .filter(([name, value]) => CSS_VAR_NAMES.includes(name as (typeof CSS_VAR_NAMES)[number]) && value.trim())
    .map(([name, value]) => `  ${name}: ${value};`);
  el.textContent = lines.length > 0 ? `:root {\n${lines.join("\n")}\n}` : "";
}

function readCSSVars(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement);
  const out: Record<string, string> = {};
  for (const name of CSS_VAR_NAMES) out[name] = cs.getPropertyValue(name).trim();
  return out;
}

function observeCSSVarEdits(state: AppState): void {
  if (state.cssVarWatchTimer !== undefined) window.clearInterval(state.cssVarWatchTimer);
  let last = readCSSVars();
  state.cssVarWatchTimer = window.setInterval(() => {
    const current = readCSSVars();
    let changed = false;
    for (const name of CSS_VAR_NAMES) {
      if (current[name] === last[name]) continue;
      state.themeVars[name] = current[name];
      changed = true;
    }
    if (changed) {
      last = current;
      applyThemeVars(state.themeVars);
      queuePersistState(state);
    }
  }, 600);
}

function readMastheadTitle(): string {
  return document.querySelector(".topbar__title")?.textContent?.trim() || document.title;
}

function readMastheadSubtitle(): string {
  return document.querySelector(".topbar__subtitle")?.textContent?.trim() || "";
}

function applyMasthead(state: AppState): void {
  const titleLink = document.querySelector<HTMLElement>(".topbar__title-link");
  const title = document.querySelector<HTMLElement>(".topbar__title");
  const subtitle = document.querySelector<HTMLElement>(".topbar__subtitle");
  if (!state.mastheadTitleVisible) titleLink?.remove();
  else if (title) title.textContent = state.mastheadTitle;
  if (!state.mastheadSubtitleVisible) subtitle?.remove();
  else if (subtitle) subtitle.textContent = state.mastheadSubtitle;
  document.title = state.mastheadTitle;
}

function observeMastheadEdits(state: AppState): void {
  state.mastheadObserver?.disconnect();
  const host = document.querySelector<HTMLElement>(".topbar__brand") ?? document.querySelector<HTMLElement>(".topbar");
  const sync = (): void => {
    const title = document.querySelector<HTMLElement>(".topbar__title");
    const subtitle = document.querySelector<HTMLElement>(".topbar__subtitle");
    let changed = false;
    if (!title && state.mastheadTitleVisible) {
      state.mastheadTitleVisible = false;
      changed = true;
    }
    if (title) {
      const nextTitle = title.textContent?.trim() || state.mastheadTitle;
      if (!state.mastheadTitleVisible || nextTitle !== state.mastheadTitle) {
        state.mastheadTitleVisible = true;
        state.mastheadTitle = nextTitle;
        document.title = nextTitle;
        changed = true;
      }
    }
    if (!subtitle && state.mastheadSubtitleVisible) {
      state.mastheadSubtitleVisible = false;
      changed = true;
    }
    if (subtitle) {
      const nextSubtitle = subtitle.textContent?.trim() ?? "";
      if (!state.mastheadSubtitleVisible || nextSubtitle !== state.mastheadSubtitle) {
        state.mastheadSubtitleVisible = true;
        state.mastheadSubtitle = nextSubtitle;
        changed = true;
      }
    }
    if (changed) queuePersistState(state);
  };
  const observer = new MutationObserver(sync);
  if (host) observer.observe(host, { childList: true, characterData: true, subtree: true });
  state.mastheadObserver = observer;
}

function observeColumnTitleEdits(state: AppState, dom: DOM): void {
  state.columnTitleObserver?.disconnect();
  const observer = new MutationObserver(() => {
    let changed = false;
    for (const el of dom.deck.querySelectorAll<HTMLElement>(".deck-column")) {
      const id = el.dataset.columnId;
      const title = el.querySelector<HTMLElement>(".deck-column__title")?.textContent?.trim();
      if (!id || !title) continue;
      const col = state.deck.columns.find((c) => c.id === id);
      if (col && col.title !== title) {
        col.title = title;
        changed = true;
      }
    }
    if (changed) queuePersistState(state);
  });
  observer.observe(dom.deck, { childList: true, characterData: true, subtree: true });
  state.columnTitleObserver = observer;
}

function observeDeckStructureEdits(state: AppState, dom: DOM): void {
  state.deckStructureObserver?.disconnect();
  let pendingRepair = false;
  const observer = new MutationObserver(() => {
    if (pendingRepair || deckStructureMatchesState(state, dom)) return;
    pendingRepair = true;
    window.requestAnimationFrame(() => {
      pendingRepair = false;
      if (!deckStructureMatchesState(state, dom)) renderDeck(state, dom);
    });
  });
  observer.observe(dom.deck, { childList: true });
  state.deckStructureObserver = observer;
}

function observeDOMSnapshotChanges(state: AppState, baseline: DOMBaseline): void {
  state.domSnapshotObserver?.disconnect();
  const observer = new MutationObserver(() => {
    if (state.domSnapshotRepairing) return;
    queueDOMSnapshotPersist(state, baseline);
  });
  observer.observe(document, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  state.domSnapshotObserver = observer;
  queueDOMSnapshotPersist(state, baseline);
}

function deckStructureMatchesState(state: AppState, dom: DOM): boolean {
  const children = Array.from(dom.deck.children);
  const columns = children.filter(
    (el): el is HTMLElement => el instanceof HTMLElement && el.classList.contains("deck-column"),
  );
  if (children.length !== columns.length) return false;
  if (columns.length !== state.deck.columns.length) return false;
  return columns.every((el, index) => el.dataset.columnId === state.deck.columns[index]?.id);
}

function observeCustomCSSEdits(state: AppState): void {
  state.customCSSObserver?.disconnect();
  const el = document.getElementById(CUSTOM_CSS_ID) as HTMLStyleElement | null;
  if (!el) return;
  const observer = new MutationObserver(() => {
    const css = el.textContent ?? "";
    if (css === state.customCSS) return;
    state.customCSS = css;
    queuePersistState(state);
  });
  observer.observe(el, { childList: true, characterData: true, subtree: true });
  state.customCSSObserver = observer;
}

function isStringRecord(x: unknown): x is Record<string, string> {
  if (!x || typeof x !== "object") return false;
  return Object.values(x as Record<string, unknown>).every((value) => typeof value === "string");
}

async function resetPersistedState(): Promise<void> {
  await deletePersistedState();
  window.location.reload();
}

function printDevToolsInstructions(): void {
  console.info(
    [
      "HNDeck DevTools customization",
      "────────────────────────────",
      "DOM and CSS edits auto-persist to OPFS as a page snapshot.",
      "On reload, HNDeck restores that snapshot first, then reapplies app-owned state:",
      "  • deck columns, column order, titles, and prompts",
      "  • reader context and today's directive",
      "  • live story/card regions and event wiring",
      "Use the column arrow buttons to reorder columns in app state.",
      "",
      "Useful selectors:",
      "  .deck-column, .deck-column__header, .deck-card, .deck-card__title, .deck-card__meta",
      "",
      "Reset persisted layout/settings:",
      "  Customize → Reset layout",
      "  or await hnDeck.resetLayout()",
      "",
      "Operational helpers:",
      "  hnDeck.state()      // readonly-ish snapshot for debugging",
      "  hnDeck.help()       // print this help",
      "  await hnDeck.resetLayout()",
    ].join("\n"),
  );
}

function exposeOperationalConsoleAPI(state: AppState): void {
  (window as unknown as { hnDeck: unknown }).hnDeck = {
    help: () => printDevToolsInstructions(),
    resetLayout: () => resetPersistedState(),
    state: () => ({
      deck: structuredClone(state.deck),
      readerContext: state.readerContext,
      sessionPrompt: state.sessionPrompt,
      autoReloadMs: state.autoReloadMs,
      autoReloadEnabled: state.autoReloadEnabled,
      mastheadTitle: state.mastheadTitle,
      mastheadSubtitle: state.mastheadSubtitle,
      customCSSLength: state.customCSS.length,
      themeVars: { ...state.themeVars },
      columnsRendered: state.columns.size,
      cachedStories: state.storyById.size,
    }),
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

function relativeTime(date: Date): string {
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  const minute = 60;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (seconds < minute) return "just now";
  if (seconds < hour) {
    const n = Math.floor(seconds / minute);
    return `${n} ${n === 1 ? "minute" : "minutes"} ago`;
  }
  if (seconds < day) {
    const n = Math.floor(seconds / hour);
    return `${n} ${n === 1 ? "hour" : "hours"} ago`;
  }
  const n = Math.floor(seconds / day);
  return `${n} ${n === 1 ? "day" : "days"} ago`;
}

function formatFullTime(date: Date): string {
  return date.toLocaleString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function faviconUrl(host: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`;
}
