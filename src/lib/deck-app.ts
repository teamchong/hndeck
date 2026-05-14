/** Column-based HN deck app. */

import {
  fetchFeedStoryBatch,
  fetchCommentPreview,
  clearHNCache,
  hnFromSiteUrl,
  hnPermalink,
  hnUserUrl,
  hostOf,
  stripHtml,
  type HNFeedItem,

  type HNFeed,
  type HNCommentNode,
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
  type ColumnSource,
  type Deck,
} from "./deck";
import { buildSourceFilterSystemPrompt, buildSourceFilterUserPrompt } from "./deck-prompt";
import { createPromptBus, type PromptBus } from "./prompt-bus";
import { checkAvailability, createSession, type ModelStatus } from "./prompt-api";
import { classifyFailure, detectBrowser, guideContentFor, type GuideContent } from "./setup-guide";

const BATCH = 30;
const AUTO_RELOAD_OPTIONS = [60_000, 5 * 60_000, 60 * 60_000] as const;
const DEFAULT_AUTO_RELOAD_MS = AUTO_RELOAD_OPTIONS[0];
const CARD_STALE_MS = 5 * 60_000;
const OPFS_STATE_FILE = "hn-deck-state-v1.json";
const OPFS_DOM_SNAPSHOT_FILE = "hn-deck-dom-v1.json";
const OPFS_FILTER_CACHE_FILE = "hn-deck-filter-cache-v1.json";
const APP_CSS_ID = "hn-deck-app-css";
const CUSTOM_CSS_ID = "hn-deck-custom-css";
const THEME_VARS_CSS_ID = "hn-deck-theme-vars";
const DROP_PLACEHOLDER_ID = "deck-column-drop-placeholder";
const SOURCE_FILTER_CACHE_VERSION = "v4";
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
  lastRenderedAt: number;
}

interface DOM {
  status: HTMLElement;
  deck: HTMLElement;
  instructionsBox: HTMLTextAreaElement;
  searchBtn: HTMLButtonElement;
  searchDialog: HTMLDialogElement;
  searchClose: HTMLButtonElement;
  searchForm: HTMLFormElement;
  searchInput: HTMLInputElement;
  searchMeta: HTMLElement;
  addColumnBtn: HTMLButtonElement;
  setupBanner: HTMLElement;
  setupTitle: HTMLElement;
  setupDetail: HTMLElement;
  setupBar: HTMLElement;
  setupFill: HTMLDivElement;
  setupPct: HTMLElement;
  setupBegin: HTMLButtonElement;
  setupRetry: HTMLButtonElement;
  setupDismiss: HTMLButtonElement;
  setupSteps: HTMLElement;
  setupVerify: HTMLAnchorElement;
  columnDialog: HTMLDialogElement;
  columnTitle: HTMLInputElement;
  columnSource: HTMLSelectElement;
  columnInstruction: HTMLTextAreaElement;
  columnSave: HTMLButtonElement;
  columnCancel: HTMLButtonElement;
  columnClose: HTMLButtonElement;
  commentsDialog: HTMLDialogElement;
  commentsClose: HTMLButtonElement;
  commentsTitle: HTMLElement;
  commentsMeta: HTMLElement;
  commentsBody: HTMLElement;
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
  backfilling: boolean;
  topRefreshing: boolean;
  topPull: number;
  topPullReset: number | null;
  autoReloadTimer: number | null;
  hasMore: boolean;
}

interface AppState {
  deck: Deck;
  columns: Map<string, ColumnRuntime>;
  columnItems: Map<string, ColumnItem[]>;
  storyById: Map<number, HNFeedItem>;
  sourceFilterDecisions: Map<string, boolean>;
  promptBus: PromptBus;
  routingInstructions: string;
  modelReady: boolean;
  setupDismissed: boolean;
  focusedColumnId: string | null;
  editingColumnId: string | null;
  draggingColumnId: string | null;
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
  filterCacheTimer: number | null;
  commentsAbort?: AbortController;
  composeAbort?: AbortController;
}

interface PersistedState {
  deck: Deck;
  routingInstructions: string;
  setupDismissed: boolean;
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

// ─── Map column source → HN feed ────────────────────────────────────

function columnFeed(column: Column): HNFeed {
  if (column.source === "custom") return "all";
  return column.source as HNFeed;
}

// ─── Boot ────────────────────────────────────────────────────────────

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
  const persistenceAvailable = await isPersistenceAvailable();
  const persisted = await loadPersistedState();
  const filterCache = await loadFilterCache();
  const state: AppState = {
    deck: persisted?.deck ?? defaultDeck(),
    columns: new Map(),
    columnItems: new Map(),
    storyById: new Map(),
    sourceFilterDecisions: filterCache,
    promptBus: createPromptBus(),
    routingInstructions: persisted?.routingInstructions ?? "",
    modelReady: false,
    setupDismissed: persisted?.setupDismissed ?? false,
    focusedColumnId: null,
    editingColumnId: null,
    draggingColumnId: null,
    mastheadTitle: persisted?.mastheadTitle ?? readMastheadTitle(),
    mastheadSubtitle: persisted?.mastheadSubtitle ?? readMastheadSubtitle(),
    mastheadTitleVisible: persisted?.mastheadTitleVisible ?? true,
    mastheadSubtitleVisible: persisted?.mastheadSubtitleVisible ?? true,
    customCSS: persisted?.customCSS ?? "",
    themeVars: persisted?.themeVars ?? {},
    persistTimer: null,
    domSnapshotTimer: null,
    domSnapshotRepairing: false,
    filterCacheTimer: null,
  };

  syncAppOwnedControls(state, dom);
  applyMasthead(state);
  observeMastheadEdits(state);
  applyThemeVars(state.themeVars);
  observeCSSVarEdits(state);
  applyCustomCSS(state.customCSS);
  renderDeck(state, dom);
  bindCoreControls(state, dom);
  markAppReady();
  if (!persistenceAvailable) {
    setStatus(dom, "This browser does not support OPFS persistence here. Layout/customization changes will reset on reload.", "warn");
  }
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

// ─── DOM baseline / snapshot ─────────────────────────────────────────

function createDOMBaseline(): DOMBaseline {
  const snapshot = readDOMSnapshot();
  const bodyTemplate = document.createElement("template");
  bodyTemplate.innerHTML = snapshot.bodyHTML;
  return { ...snapshot, bodyTemplate };
}

function readDOMSnapshot(): DOMSnapshot {
  return {
    documentAttributes: readAttributes(document.documentElement),
    headHTML: "", // never persist <head>; it has deploy-specific hashed assets
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
  if (new URLSearchParams(window.location.search).has("reset")) {
    await deletePersistedState();
    window.history.replaceState(null, "", window.location.pathname);
    window.location.reload();
    return;
  }
  const snapshot = await loadDOMSnapshot();
  if (!snapshot) return;
  // Never restore <head>. It contains build-specific hashed assets
  // that change on every deploy. Let the fresh HTML provide them.
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

// ─── Core DOM repair ─────────────────────────────────────────────────

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
  ensureChildElementWithChildren("setup-banner", main, ["setup-title", "setup-detail", "setup-begin", "setup-retry", "setup-dismiss"], baseline);
  ensureChildElement("deck", main, baseline);
  ensureDialogWithChildren("about-dialog", ["about-close"], baseline);
  ensureDialogWithChildren("editor-dialog", ["editor-close", "editor-done", "routing-instructions", "reset-state"], baseline);
  ensureDialogWithChildren("column-dialog", ["column-close", "column-title", "column-source", "column-instruction", "column-save", "column-cancel"], baseline);
  ensureDialogWithChildren("comments-dialog", ["comments-close", "comments-title", "comments-meta", "comments-body"], baseline);
  ensureDialogWithChildren("search-dialog", ["search-close", "search-form", "search-input", "search-meta"], baseline);
  ensureAppCSS(baseline);
}

function ensureTopbar(baseline: DOMBaseline): void {
  const required = ["search-btn", "add-column-btn", "editor-btn"];
  const current = document.querySelector<HTMLElement>(".topbar");
  const next = cloneBaselineElement<HTMLElement>(baseline, ".topbar");
  const currentVersion = current?.dataset.appVersion ?? "";
  const baselineVersion = next?.dataset.appVersion ?? "";
  if (current && required.every((id) => document.getElementById(id)) && currentVersion === baselineVersion) return;
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

function ensureChildElementWithChildren(id: string, parent: HTMLElement, childIds: string[], baseline: DOMBaseline): HTMLElement {
  const existing = document.getElementById(id) as HTMLElement | null;
  const next = cloneBaselineElement<HTMLElement>(baseline, `#${id}`) ?? document.createElement("div");
  const currentVersion = existing?.dataset.appVersion ?? "";
  const baselineVersion = next.dataset.appVersion ?? "";
  if (existing && childIds.every((childId) => document.getElementById(childId)) && currentVersion === baselineVersion) return existing;
  next.id = id;
  existing?.remove();
  parent.appendChild(next);
  return next;
}

function ensureDialogWithChildren(id: string, childIds: string[], baseline: DOMBaseline): void {
  const current = document.getElementById(id) as HTMLElement | null;
  const next = cloneBaselineElement<HTMLElement>(baseline, `#${id}`);
  const currentVersion = current?.dataset.appVersion ?? "";
  const baselineVersion = next?.dataset.appVersion ?? "";
  if (current && childIds.every((childId) => document.getElementById(childId)) && currentVersion === baselineVersion) return;
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

// ─── DOM getters ─────────────────────────────────────────────────────

function getDOM(): DOM {
  const get = <T extends HTMLElement>(id: string): T => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Missing #${id}`);
    return el as T;
  };
  return {
    status: get("status"),
    deck: get("deck"),
    instructionsBox: get<HTMLTextAreaElement>("routing-instructions"),
    searchBtn: get<HTMLButtonElement>("search-btn"),
    searchDialog: get<HTMLDialogElement>("search-dialog"),
    searchClose: get<HTMLButtonElement>("search-close"),
    searchForm: get<HTMLFormElement>("search-form"),
    searchInput: get<HTMLInputElement>("search-input"),
    searchMeta: get("search-meta"),
    addColumnBtn: get<HTMLButtonElement>("add-column-btn"),
    setupBanner: get("setup-banner"),
    setupTitle: get("setup-title"),
    setupDetail: get("setup-detail"),
    setupBar: get("setup-bar"),
    setupFill: get<HTMLDivElement>("setup-fill"),
    setupPct: get("setup-pct"),
    setupBegin: get<HTMLButtonElement>("setup-begin"),
    setupRetry: get<HTMLButtonElement>("setup-retry"),
    setupDismiss: get<HTMLButtonElement>("setup-dismiss"),
    setupSteps: get("setup-steps"),
    setupVerify: get<HTMLAnchorElement>("setup-verify"),
    columnDialog: get<HTMLDialogElement>("column-dialog"),
    columnTitle: get<HTMLInputElement>("column-title"),
    columnSource: get<HTMLSelectElement>("column-source"),
    columnInstruction: get<HTMLTextAreaElement>("column-instruction"),
    columnSave: get<HTMLButtonElement>("column-save"),
    columnCancel: get<HTMLButtonElement>("column-cancel"),
    columnClose: get<HTMLButtonElement>("column-close"),
    commentsDialog: get<HTMLDialogElement>("comments-dialog"),
    commentsClose: get<HTMLButtonElement>("comments-close"),
    commentsTitle: get("comments-title"),
    commentsMeta: get("comments-meta"),
    commentsBody: get("comments-body"),
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
  if (dom.instructionsBox.value !== state.routingInstructions) dom.instructionsBox.value = state.routingInstructions;
}

// ─── Control wiring ──────────────────────────────────────────────────

function bindCoreControls(state: AppState, dom: DOM): void {
  dom.instructionsBox.oninput = () => {
    state.routingInstructions = dom.instructionsBox.value;
    queuePersistState(state);
  };
  dom.setupBegin.onclick = () => void beginModelDownload(state, dom);
  dom.setupRetry.onclick = () => void bootstrap(state, dom);
  dom.setupDismiss.onclick = () => {
    state.setupDismissed = true;
    queuePersistState(state);
    setSetup(dom, { kind: "hidden" }, state);
  };
  dom.searchBtn.onclick = () => openSearchDialog(dom);
  dom.searchClose.onclick = () => closeDialog(dom.searchDialog);
  dom.searchDialog.onclick = (ev) => {
    if (ev.target === dom.searchDialog) closeDialog(dom.searchDialog);
  };
  dom.searchForm.onsubmit = (ev) => {
    ev.preventDefault();
    createSearchColumn(state, dom);
  };
  dom.addColumnBtn.onclick = () => openColumnDialog(state, dom, null);
  dom.columnSource.onchange = () => syncColumnSourceState(dom, true);
  dom.columnSave.onclick = () => saveColumnDialog(state, dom);
  dom.columnCancel.onclick = () => closeColumnDialog(state, dom);
  dom.columnClose.onclick = () => closeColumnDialog(state, dom);
  dom.resetState.onclick = () => void resetPersistedState();
  dom.columnDialog.onclick = (ev) => {
    if (ev.target === dom.columnDialog) closeColumnDialog(state, dom);
  };
  dom.commentsClose.onclick = () => closeDialog(dom.commentsDialog);
  dom.commentsDialog.onclick = (ev) => {
    if (ev.target === dom.commentsDialog) closeDialog(dom.commentsDialog);
  };
  wireDialogControls("about-dialog", "about-btn", "about-close");
  wireDialogControls("editor-dialog", "editor-btn", "editor-close", "editor-done");
  bindKeyboardShortcuts(state, dom);
}

function bindKeyboardShortcuts(state: AppState, dom: DOM): void {
  document.onkeydown = (ev) => {
    if (isTypingTarget(ev.target)) return;
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "k") {
      ev.preventDefault();
      openSearchDialog(dom);
      return;
    }
    if (ev.key === "Escape" && closeTopDialog()) {
      ev.preventDefault();
      return;
    }
    if (isAnyDialogOpen() && ev.key !== "?") return;
    if (ev.key === "n") {
      ev.preventDefault();
      openColumnDialog(state, dom, null);
    } else if (ev.key === "?") {
      ev.preventDefault();
      printDevToolsInstructions();
    } else if (ev.key === "Escape" && state.focusedColumnId !== null) {
      ev.preventDefault();
      state.focusedColumnId = null;
      applyFocusState(state, dom);
    }
  };
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return target.isContentEditable || tag === "input" || tag === "textarea" || tag === "select";
}

// ─── Dialog helpers ──────────────────────────────────────────────────

function wireDialogControls(dialogId: string, openBtnId: string, closeBtnId: string, doneBtnId?: string): void {
  const dlg = document.getElementById(dialogId) as HTMLDialogElement | null;
  const openBtn = document.getElementById(openBtnId) as HTMLElement | null;
  const closeBtn = document.getElementById(closeBtnId) as HTMLElement | null;
  const doneBtn = doneBtnId ? document.getElementById(doneBtnId) as HTMLElement | null : null;
  if (!dlg || !openBtn) return;
  openBtn.onclick = () => openDialog(dlg);
  closeBtn && (closeBtn.onclick = () => closeDialog(dlg));
  doneBtn && (doneBtn.onclick = () => closeDialog(dlg));
  dlg.onclick = (ev) => {
    if (ev.target === dlg) closeDialog(dlg);
  };
}

function openDialog(dlg: HTMLDialogElement): void {
  dlg.dataset.dialogOpen = "true";
  dlg.setAttribute("aria-modal", "true");
  window.setTimeout(() => dlg.querySelector<HTMLElement>("button, a, input, textarea, select")?.focus(), 0);
}

function closeDialog(dlg: HTMLDialogElement): void {
  if (!dlg.dataset.dialogOpen) return;
  delete dlg.dataset.dialogOpen;
  dlg.removeAttribute("aria-modal");
  dlg.dispatchEvent(new Event("close"));
}

function isAnyDialogOpen(): boolean {
  return document.querySelector('dialog[data-dialog-open="true"]') !== null;
}

function closeTopDialog(): boolean {
  const dialogs = Array.from(document.querySelectorAll<HTMLDialogElement>('dialog[data-dialog-open="true"]'));
  const dlg = dialogs.at(-1);
  if (!dlg) return false;
  closeDialog(dlg);
  return true;
}

// ─── Search ──────────────────────────────────────────────────────────

function openSearchDialog(dom: DOM): void {
  dom.searchMeta.textContent = "Create a search column";
  openDialog(dom.searchDialog);
  window.setTimeout(() => dom.searchInput.focus(), 0);
}

function createSearchColumn(state: AppState, dom: DOM): void {
  const query = dom.searchInput.value.trim();
  if (!query) {
    dom.searchMeta.textContent = "Enter a query first";
    return;
  }
  const id = newColumnId();
  state.deck = addColumn(state.deck, {
    id,
    title: query,
    source: "search",
    feedQuery: query,
  });
  state.focusedColumnId = id;
  dom.searchInput.value = "";
  queuePersistState(state);
  void persistStateNow(state);
  closeDialog(dom.searchDialog);
  renderDeck(state, dom);
}

// ─── Status / setup banner ───────────────────────────────────────────

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

function setSetup(dom: DOM, s: SetupState, state?: AppState): void {
  if (state?.setupDismissed && s.kind !== "hidden" && s.kind !== "downloading") {
    dom.setupBanner.hidden = true;
    return;
  }
  if (s.kind === "hidden") {
    dom.setupBanner.hidden = true;
    return;
  }
  dom.setupBanner.hidden = false;
  dom.setupBar.hidden = true;
  dom.setupPct.hidden = true;
  dom.setupBegin.hidden = true;
  dom.setupRetry.hidden = true;
  dom.setupDismiss.hidden = false;
  dom.setupSteps.hidden = true;
  dom.setupVerify.hidden = true;

  if (s.kind === "begin") {
    dom.setupTitle.textContent = "Gemini Nano isn't downloaded yet";
    dom.setupDetail.textContent = "Standard HN columns work now. Enable Nano to filter stories with custom instructions.";
    dom.setupBegin.hidden = false;
    return;
  }
  if (s.kind === "downloading") {
    dom.setupDismiss.hidden = true;
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

// ─── Bootstrap / Nano download ───────────────────────────────────────

async function bootstrap(state: AppState, dom: DOM): Promise<void> {
  setStatus(dom, "Loading Hacker News. Checking Nano in the background…");
  const status: ModelStatus = await checkAvailability();
  if (status.kind === "available") {
    state.modelReady = true;
    setSetup(dom, { kind: "hidden" }, state);
    dom.instructionsBox.disabled = false;
    setStatus(dom, "Nano is ready.");
    startNanoFilteredColumns(state);
    return;
  }
  if (status.kind === "unsupported") {
    const info = detectBrowser();
    setSetup(dom, { kind: "guide", content: guideContentFor(classifyFailure(info, false, status.reason)) }, state);
    setStatus(dom, "Standard columns are available. Nano setup required for custom instructions.");
    return;
  }
  setSetup(dom, { kind: "begin" }, state);
  setStatus(dom, "Standard columns are available. Nano needs one download for custom instructions.");
}

async function beginModelDownload(state: AppState, dom: DOM): Promise<void> {
  setSetup(dom, { kind: "downloading", progress: 0 }, state);
  try {
    const warmup = await createSession("Reply ok.", (p) => setSetup(dom, { kind: "downloading", progress: p }, state));
    warmup.destroy();
    state.modelReady = true;
    setSetup(dom, { kind: "hidden" }, state);
    dom.instructionsBox.disabled = false;
    setStatus(dom, "Nano is ready.");
    startNanoFilteredColumns(state);
  } catch (err) {
    const info = detectBrowser();
    setSetup(dom, { kind: "guide", content: guideContentFor(classifyFailure(info, true, err instanceof Error ? err.message : String(err))) }, state);
    setStatus(dom, "Nano download failed. Standard columns still work.", "error");
  }
}

/** Kick off loading for any column that has an instruction but is still empty. */
function startNanoFilteredColumns(state: AppState): void {
  for (const runtime of state.columns.values()) {
    if (columnNeedsNanoFilter(runtime.column) && getColumnItems(state, runtime.column.id).length === 0) {
      void loadBatch(state, runtime);
    }
  }
}

// ─── Render deck ─────────────────────────────────────────────────────

function renderDeck(state: AppState, dom: DOM): void {
  for (const rt of state.columns.values()) clearColumnAutoReloadTimer(rt);
  dom.deck.innerHTML = "";
  state.columns.clear();
  for (const column of state.deck.columns) {
    const el = document.createElement("section");
    el.className = "deck-column";
    el.dataset.columnId = column.id;
    el.innerHTML = `
      <header class="deck-column__header" draggable="true" title="Drag to reorder column">
        <h2 class="deck-column__title">${escapeHtml(column.title)}</h2>
        <div class="deck-column__actions">
          <div class="deck-column__actions-left">
            <button class="deck-column__btn" data-action="edit" title="Edit column" aria-label="Edit column">✎</button>
          </div>
          <div class="deck-column__actions-right">
            <button class="deck-column__btn deck-column__btn--focus-hidden" data-action="left" title="Move column left" aria-label="Move column left">←</button>
            <button class="deck-column__btn deck-column__btn--focus-hidden" data-action="right" title="Move column right" aria-label="Move column right">→</button>
            <button class="deck-column__btn deck-column__btn--wide deck-column__btn--focus-hidden" data-action="reload" title="Change column auto-refresh" aria-label="Change column auto-refresh">${escapeHtml(columnReloadLabel(column))}</button>
            <button class="deck-column__btn" data-action="focus" title="Focus column" aria-label="Focus column">⛶</button>
            <button class="deck-column__btn deck-column__btn--focus-hidden" data-action="remove" title="Remove column" aria-label="Remove column" ${columnActionBusy(state, column) ? "disabled" : ""}>×</button>
          </div>
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
      backfilling: false,
      topRefreshing: false,
      topPull: 0,
      topPullReset: null,
      autoReloadTimer: null,
      hasMore: true,
    };
    state.columns.set(column.id, runtime);
    dom.deck.appendChild(el);

    renderColumnCache(state, runtime);

    el.querySelector<HTMLElement>('[data-action="left"]')?.addEventListener("click", () => moveColumnInDeck(state, dom, column.id, -1));
    el.querySelector<HTMLElement>('[data-action="right"]')?.addEventListener("click", () => moveColumnInDeck(state, dom, column.id, 1));
    el.querySelector<HTMLElement>('[data-action="reload"]')?.addEventListener("click", () => toggleColumnAutoReload(state, dom, column.id));
    el.querySelector<HTMLElement>('[data-action="focus"]')?.addEventListener("click", () => toggleColumnFocus(state, dom, column.id));
    el.querySelector<HTMLElement>('[data-action="edit"]')?.addEventListener("click", () => editColumn(state, dom, column.id));
    el.querySelector<HTMLElement>('[data-action="remove"]')?.addEventListener("click", () => void removeColumnFromDeck(state, dom, column.id));

    body.addEventListener("scroll", () => {
      resetColumnAutoReloadTimer(state, dom, runtime);
      if (body.scrollTop + body.clientHeight >= body.scrollHeight - 240) {
        void loadBatch(state, runtime);
      }
    });
    body.addEventListener("wheel", (ev) => {
      resetColumnAutoReloadTimer(state, dom, runtime);
      if (body.scrollTop <= 0 && ev.deltaY < 0) {
        runtime.topPull += Math.abs(ev.deltaY);
        const readyToRefresh = runtime.topPull >= 80;
        runtime.topStatus.hidden = false;
        runtime.topStatus.classList.toggle("deck-column__top-status--ready", readyToRefresh);
        runtime.topStatus.classList.toggle("deck-column__top-status--loading", readyToRefresh);
        runtime.topStatus.innerHTML = `
          <span><span class="deck-spinner" aria-hidden="true"></span>${readyToRefresh ? "Refreshing…" : "Pull to refresh"}</span>
          <span class="deck-column__top-progress" style="width:${Math.min(100, Math.round((runtime.topPull / 80) * 100))}%"></span>
        `;
        if (runtime.topPullReset !== null) window.clearTimeout(runtime.topPullReset);
        runtime.topPullReset = window.setTimeout(() => {
          runtime.topPull = 0;
          if (!runtime.topRefreshing) hideTopStatus(runtime);
        }, 650);
        if (readyToRefresh) {
          runtime.topPull = 0;
          void refreshColumnFromTop(state, dom, runtime);
        }
      }
    }, { passive: true });

    if (getColumnItems(state, column.id).length === 0) {
      renderColumnWaitingMessage(state, runtime);
      void loadBatch(state, runtime);
    } else {
      runtime.sentinel.textContent = runtime.hasMore ? "Scroll for more" : endOfFeedLabel(column);
    }
    bindColumnDragEvents(state, runtime);
    scheduleColumnAutoReload(state, dom, runtime);
  }
  bindDeckDragPreview(state, dom);
  applyFocusState(state, dom);
  ensureFocusedColumnBacklog(state, dom);
  updateDeckOverflowState(dom);
}

function columnActionBusy(state: AppState, column: Column): boolean {
  const runtime = state.columns.get(column.id);
  return !!runtime?.loading || !!runtime?.backfilling || !!runtime?.topRefreshing;
}

function updateDeckOverflowState(dom: DOM): void {
  requestAnimationFrame(() => {
    const overflowing = dom.deck.scrollWidth > dom.deck.clientWidth + 1;
    dom.deck.classList.toggle("deck--overflowing", overflowing);
  });
}

// ─── Column messages ─────────────────────────────────────────────────

function renderColumnMessage(runtime: ColumnRuntime, text: string, kind: "empty" | "error" = "empty"): void {
  runtime.body.innerHTML = `<p class="deck-empty ${kind === "error" ? "deck-empty--error" : ""}">${escapeHtml(text)}</p>`;
}

function renderColumnWaitingMessage(state: AppState, runtime: ColumnRuntime): void {
  if (!runtime.column.instruction?.trim() || visibleCardCount(runtime) > 0) return;
  const message = state.modelReady
    ? "Waiting for Nano to filter this source…"
    : "Waiting for Nano. This column has a custom instruction, so stories will appear after Nano is ready.";
  renderColumnMessage(runtime, message);
}

function clearColumnMessage(runtime: ColumnRuntime): void {
  runtime.body.querySelector<HTMLElement>(".deck-empty")?.remove();
}

// ─── Load / filter ───────────────────────────────────────────────────

async function loadBatch(state: AppState, runtime: ColumnRuntime): Promise<void> {
  if (runtime.loading || !runtime.hasMore) return;
  runtime.loading = true;
  setColumnRemoveDisabled(runtime, true);
  runtime.sentinel.innerHTML = `<span class="deck-spinner" aria-hidden="true"></span> Loading more…`;
  renderColumnWaitingMessage(state, runtime);
  try {
    let added = 0;
    do {
      const batch = await fetchFeedStoryBatch(
        columnFeed(runtime.column),
        runtime.cursor,
        runtime.cursor + BATCH,
        undefined,
        { user: runtime.column.feedUser, month: runtime.column.feedMonth, query: runtime.column.feedQuery },
      );
      if (columnNeedsNanoFilter(runtime.column) && !state.modelReady) {
        runtime.sentinel.textContent = "Nano not ready";
        if (visibleCardCount(runtime) === 0) renderColumnMessage(runtime, "This column has a custom instruction. Enable Nano to apply it.");
        return;
      }
      const stories = await filterStories(state, runtime, batch.stories);
      for (const story of stories) {
        if (runtime.body.querySelector(`[data-story-id="${story.id}"]`)) continue;
        state.storyById.set(story.id, story);
        upsertColumnItem(state, runtime.column.id, { storyId: story.id, lastRenderedAt: Date.now() });
        if (added === 0) clearColumnMessage(runtime);
        runtime.body.appendChild(renderStoryCard(story));
        added++;
      }
      runtime.cursor += BATCH;
      runtime.hasMore = batch.hasMore;
      if (shouldScanMore(runtime, added)) {
        runtime.sentinel.textContent = `Scanning older ${runtime.column.source} stories…`;
      }
    } while (shouldScanMore(runtime, added));
    if (visibleCardCount(runtime) === 0 && !runtime.hasMore) renderColumnMessage(runtime, "No matching items found for this column.");
    runtime.sentinel.textContent = runtime.hasMore ? "Scroll for more" : endOfFeedLabel(runtime.column);
    if (added === 0 && runtime.hasMore) runtime.sentinel.textContent = "Scroll for more matches";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    runtime.sentinel.textContent = "Load failed";
    if (visibleCardCount(runtime) === 0) renderColumnMessage(runtime, `Could not load this column: ${message}`, "error");
  } finally {
    runtime.loading = false;
    setColumnRemoveDisabled(runtime, false);
  }
}

const MIN_ITEMS_PER_LOAD = 5;

function shouldScanMore(runtime: ColumnRuntime, added: number): boolean {
  if (!runtime.hasMore) return false;
  if (!runtime.column.instruction?.trim()) return false;
  if (added < MIN_ITEMS_PER_LOAD) return true;
  return !columnHasScrollableBacklog(runtime);
}

function columnHasScrollableBacklog(runtime: ColumnRuntime): boolean {
  const cards = visibleCardCount(runtime);
  if (cards === 0) return false;
  if (runtime.body.clientHeight <= 0) return cards >= 12;
  return runtime.body.scrollHeight > runtime.body.clientHeight + 80;
}

function endOfFeedLabel(column: Column): string {
  switch (column.source) {
    case "new": return "End of HN new stories";
    case "ask": return "End of Ask HN";
    case "show": return "End of Show HN";
    case "jobs": return "End of HN jobs";
    case "user": return "End of user activity";
    case "best-month": return "End of monthly best";
    case "search": return "End of search results";
    case "custom": return "End of HN stream";
    case "top":
    default: return "End of HN top stories";
  }
}

function columnNeedsNanoFilter(column: Column): boolean {
  return !!column.instruction?.trim();
}

async function filterStories(state: AppState, runtime: ColumnRuntime, stories: HNFeedItem[]): Promise<HNFeedItem[]> {
  const instruction = runtime.column.instruction?.trim();
  if (!instruction || stories.length === 0) return stories;

  for (const item of stories) {
    if (!state.sourceFilterDecisions.has(filterCacheKey(runtime.column, item.id))) {
      await filterSingleItem(state, runtime, item);
    }
  }

  return stories.filter((item) => state.sourceFilterDecisions.get(filterCacheKey(runtime.column, item.id)) === true);
}

async function filterSingleItem(state: AppState, runtime: ColumnRuntime, item: HNFeedItem): Promise<void> {
  const key = filterCacheKey(runtime.column, item.id);
  if (state.sourceFilterDecisions.has(key)) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    let output = "";
    await state.promptBus.run({
      systemPrompt: buildSourceFilterSystemPrompt({
        column: runtime.column,
        item,
        globalInstruction: state.routingInstructions,
      }),
      userPrompt: buildSourceFilterUserPrompt(attempt > 0),
      onChunk: (chunk) => { output += chunk; },
    });
    const decision = parseBooleanFilterOutput(output);
    if (decision !== null) {
      setFilterDecision(state, key, decision);
      return;
    }
  }
  setFilterDecision(state, key, false);
}

function setFilterDecision(state: AppState, key: string, value: boolean): void {
  state.sourceFilterDecisions.set(key, value);
  evictFilterCache(state);
  queuePersistFilterCache(state);
}

function evictFilterCache(state: AppState): void {
  if (state.sourceFilterDecisions.size <= FILTER_CACHE_MAX) return;
  const excess = state.sourceFilterDecisions.size - FILTER_CACHE_MAX;
  let i = 0;
  for (const key of state.sourceFilterDecisions.keys()) {
    if (i++ >= excess) break;
    state.sourceFilterDecisions.delete(key);
  }
}

function parseBooleanFilterOutput(output: string): boolean | null {
  const trimmed = output.trim().toUpperCase();
  if (trimmed === "YES" || trimmed === "Y" || trimmed === "T" || trimmed === "TRUE") return true;
  if (trimmed === "NO" || trimmed === "N" || trimmed === "F" || trimmed === "FALSE") return false;
  if (/^YES\b/.test(trimmed)) return true;
  if (/^NO\b/.test(trimmed)) return false;
  return null;
}

function filterCacheKey(column: Column, storyId: number): string {
  return `${SOURCE_FILTER_CACHE_VERSION}\n${column.instruction?.trim() ?? ""}\n${storyId}`;
}

// ─── Refresh from top ────────────────────────────────────────────────

async function refreshColumnFromTop(state: AppState, dom: DOM, runtime: ColumnRuntime): Promise<void> {
  if (runtime.topRefreshing) return;
  runtime.topRefreshing = true;
  setColumnRemoveDisabled(runtime, true);
  runtime.topStatus.hidden = false;
  runtime.topStatus.classList.remove("deck-column__top-status--ready");
  runtime.topStatus.classList.add("deck-column__top-status--loading");
  runtime.topStatus.innerHTML = `<span class="deck-spinner" aria-hidden="true"></span> Refreshing…`;
  try {
    clearHNCache();
    const batch = await fetchFeedStoryBatch(
      columnFeed(runtime.column),
      0,
      BATCH,
      undefined,
      { user: runtime.column.feedUser, month: runtime.column.feedMonth, query: runtime.column.feedQuery },
    );
    if (columnNeedsNanoFilter(runtime.column) && !state.modelReady) {
      runtime.sentinel.textContent = "Nano not ready";
      if (visibleCardCount(runtime) === 0) renderColumnMessage(runtime, "This column has a custom instruction. Enable Nano to apply it.");
      return;
    }
    const stories = await filterStories(state, runtime, batch.stories);
    const fragment = document.createDocumentFragment();
    let added = 0;
    for (const story of stories) {
      state.storyById.set(story.id, story);
      const item = { storyId: story.id, lastRenderedAt: Date.now() };
      const existing = runtime.body.querySelector<HTMLElement>(`[data-story-id="${story.id}"]`);
      if (existing) {
        if (!shouldReplaceColumnItem(state, runtime.column.id, story.id)) continue;
        upsertColumnItem(state, runtime.column.id, item);
        existing.replaceWith(renderStoryCard(story, true));
        added++;
        continue;
      }
      upsertColumnItem(state, runtime.column.id, item, "prepend");
      fragment.appendChild(renderStoryCard(story, true));
      added++;
    }
    if (added > 0) {
      clearColumnMessage(runtime);
      runtime.body.prepend(fragment);
    }
    runtime.sentinel.textContent = added > 0 ? `Added ${added} new` : "No new items";
    runtime.cursor = Math.max(runtime.cursor, BATCH);
    runtime.hasMore = batch.hasMore;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    runtime.sentinel.textContent = "Refresh failed";
    if (visibleCardCount(runtime) === 0) renderColumnMessage(runtime, `Could not refresh this column: ${message}`, "error");
  } finally {
    runtime.topRefreshing = false;
    setColumnRemoveDisabled(runtime, false);
    runtime.topStatus.classList.remove("deck-column__top-status--loading");
    runtime.topPull = 0;
    window.setTimeout(() => {
      if (!runtime.topRefreshing) hideTopStatus(runtime);
    }, 900);
    scheduleColumnAutoReload(state, dom, runtime);
  }
}

function hideTopStatus(runtime: ColumnRuntime): void {
  runtime.topStatus.hidden = true;
  runtime.topStatus.classList.remove("deck-column__top-status--ready", "deck-column__top-status--loading");
  runtime.topStatus.textContent = "Release to refresh";
}

// ─── Auto-reload ─────────────────────────────────────────────────────

function scheduleColumnAutoReload(state: AppState, dom: DOM, runtime: ColumnRuntime): void {
  clearColumnAutoReloadTimer(runtime);
  if (!columnAutoReloadEnabled(runtime.column)) return;
  runtime.autoReloadTimer = window.setTimeout(() => {
    runtime.autoReloadTimer = null;
    void refreshColumnFromTop(state, dom, runtime);
  }, columnAutoReloadMs(runtime.column));
}

function resetColumnAutoReloadTimer(state: AppState, dom: DOM, runtime: ColumnRuntime): void {
  if (!columnAutoReloadEnabled(runtime.column)) return;
  scheduleColumnAutoReload(state, dom, runtime);
}

function clearColumnAutoReloadTimer(runtime: ColumnRuntime): void {
  if (runtime.autoReloadTimer !== null) {
    clearTimeout(runtime.autoReloadTimer);
    runtime.autoReloadTimer = null;
  }
}

function toggleColumnAutoReload(state: AppState, dom: DOM, columnId: string): void {
  const column = state.deck.columns.find((c) => c.id === columnId);
  const runtime = state.columns.get(columnId);
  if (!column || !runtime) return;
  if (!columnAutoReloadEnabled(column)) {
    column.autoReloadEnabled = true;
    column.autoReloadMs = AUTO_RELOAD_OPTIONS[0];
  } else {
    const idx = AUTO_RELOAD_OPTIONS.findIndex((ms) => ms === columnAutoReloadMs(column));
    const next = idx + 1;
    if (next >= AUTO_RELOAD_OPTIONS.length) {
      column.autoReloadEnabled = false;
    } else {
      column.autoReloadEnabled = true;
      column.autoReloadMs = AUTO_RELOAD_OPTIONS[next];
    }
  }
  updateColumnReloadButton(runtime);
  scheduleColumnAutoReload(state, dom, runtime);
  queuePersistState(state);
}

function columnAutoReloadEnabled(column: Column): boolean {
  return column.autoReloadEnabled !== false;
}

function columnAutoReloadMs(column: Column): number {
  return column.autoReloadMs && AUTO_RELOAD_OPTIONS.includes(column.autoReloadMs as (typeof AUTO_RELOAD_OPTIONS)[number])
    ? column.autoReloadMs
    : DEFAULT_AUTO_RELOAD_MS;
}

function columnReloadLabel(column: Column): string {
  return columnAutoReloadEnabled(column) ? `↻ ${formatReloadInterval(columnAutoReloadMs(column))}` : "↻ off";
}

function updateColumnReloadButton(runtime: ColumnRuntime): void {
  const btn = runtime.el.querySelector<HTMLButtonElement>('[data-action="reload"]');
  if (btn) btn.textContent = columnReloadLabel(runtime.column);
}

function formatReloadInterval(ms: number): string {
  if (ms === 60_000) return "1m";
  if (ms === 5 * 60_000) return "5m";
  if (ms === 60 * 60_000) return "1h";
  return `${Math.round(ms / 1000)}s`;
}

// ─── Column remove helper ────────────────────────────────────────────

function setColumnRemoveDisabled(runtime: ColumnRuntime, disabled: boolean): void {
  const btn = runtime.el.querySelector<HTMLButtonElement>('[data-action="remove"]');
  if (btn) btn.disabled = disabled;
}

// ─── Column item bookkeeping ─────────────────────────────────────────

function renderColumnCache(state: AppState, runtime: ColumnRuntime): void {
  const items = getColumnItems(state, runtime.column.id);
  if (items.length === 0) return;
  runtime.body.innerHTML = "";
  for (const item of items) {
    const story = state.storyById.get(item.storyId);
    if (!story) continue;
    runtime.body.appendChild(renderStoryCard(story));
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
    return;
  }
  if (mode === "prepend") items.unshift(item);
  else items.push(item);
}

function shouldReplaceColumnItem(state: AppState, columnId: string, storyId: number): boolean {
  const existing = getColumnItems(state, columnId).find((x) => x.storyId === storyId);
  if (!existing) return true;
  return Date.now() - existing.lastRenderedAt > CARD_STALE_MS;
}

// ─── OPFS persistence ────────────────────────────────────────────────

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
      routingInstructions: typeof raw.routingInstructions === "string"
        ? raw.routingInstructions
        : typeof raw.readerContext === "string"
          ? raw.readerContext
          : "",
      setupDismissed: typeof raw.setupDismissed === "boolean" ? raw.setupDismissed : false,
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
    routingInstructions: state.routingInstructions,
    setupDismissed: state.setupDismissed,
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
  await writable.write(JSON.stringify(readPersistableDOMSnapshot()));
  await writable.close();
}

function readPersistableDOMSnapshot(): DOMSnapshot {
  const snapshot = readDOMSnapshot();
  const template = document.createElement("template");
  template.innerHTML = snapshot.bodyHTML;
  for (const dialog of template.content.querySelectorAll("dialog")) {
    dialog.removeAttribute("open");
    dialog.removeAttribute("data-dialog-open");
    dialog.removeAttribute("aria-modal");
  }
  template.content.getElementById(DROP_PLACEHOLDER_ID)?.remove();
  for (const el of template.content.querySelectorAll(".deck-column--dragging")) el.classList.remove("deck-column--dragging");
  return { ...snapshot, bodyHTML: template.innerHTML };
}

async function deletePersistedState(): Promise<void> {
  const root = await getOPFSRoot();
  if (!root) return;
  await Promise.all([
    removeOPFSEntryIfExists(root, OPFS_STATE_FILE),
    removeOPFSEntryIfExists(root, OPFS_DOM_SNAPSHOT_FILE),
    removeOPFSEntryIfExists(root, OPFS_FILTER_CACHE_FILE),
  ]);
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

async function isPersistenceAvailable(): Promise<boolean> {
  return (await getOPFSRoot()) !== null;
}

const FILTER_CACHE_MAX = 5000;

async function loadFilterCache(): Promise<Map<string, boolean>> {
  try {
    const root = await getOPFSRoot();
    if (!root) return new Map();
    const handle = await root.getFileHandle(OPFS_FILTER_CACHE_FILE);
    const raw = JSON.parse(await (await handle.getFile()).text()) as unknown;
    if (!raw || typeof raw !== "object") return new Map();
    const entries = Object.entries(raw as Record<string, boolean>)
      .filter(([k, v]) => typeof v === "boolean" && k.startsWith(SOURCE_FILTER_CACHE_VERSION))
      .slice(-FILTER_CACHE_MAX);
    return new Map(entries);
  } catch {
    return new Map();
  }
}

function queuePersistFilterCache(state: AppState): void {
  if (state.filterCacheTimer !== null) window.clearTimeout(state.filterCacheTimer);
  state.filterCacheTimer = window.setTimeout(() => {
    state.filterCacheTimer = null;
    void persistFilterCacheNow(state);
  }, 2000);
}

async function persistFilterCacheNow(state: AppState): Promise<void> {
  const root = await getOPFSRoot();
  if (!root) return;
  const obj: Record<string, boolean> = {};
  for (const [k, v] of state.sourceFilterDecisions) obj[k] = v;
  const handle = await root.getFileHandle(OPFS_FILTER_CACHE_FILE, { create: true });
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(obj));
  await writable.close();
}

// ─── Story cards ─────────────────────────────────────────────────────

function renderStoryCard(item: HNFeedItem, fresh = false): HTMLElement {
  const el = document.createElement("article");
  el.className = ["deck-card", `deck-card--${item.type}`, fresh ? "deck-card--fresh" : ""]
    .filter(Boolean)
    .join(" ");
  el.dataset.storyId = String(item.id);
  if (fresh) window.setTimeout(() => el.classList.remove("deck-card--fresh"), 45_000);
  const by = item.by ?? "unknown";
  const ts = item.time ? new Date(item.time * 1000) : null;
  const shortTime = ts ? relativeTime(ts) : "unknown time";
  const fullTime = ts ? formatFullTime(ts) : "unknown time";

  if (item.type === "comment") {
    el.innerHTML = renderCommentCard(item, by, shortTime, fullTime);
    bindCardTime(el);
    return el;
  }

  // story, job, poll all have title
  const title = item.title;
  const url = "url" in item ? item.url : undefined;
  const text = "text" in item ? item.text : undefined;
  const host = hostOf(url);
  const titleHref = url || hnPermalink(item.id);
  const hasScore = item.type === "story" || item.type === "poll";
  const score = hasScore ? (item as { score: number }).score : 0;
  const hasComments = item.type === "story" || item.type === "poll";
  const comments = hasComments ? ((item as { descendants?: number }).descendants ?? 0) : 0;
  const bodyPreview = !url && text ? escapeHtml(stripHtml(text).slice(0, 160)) : "";
  const bodyTooltip = !url && text ? escapeAttr(stripHtml(text).slice(0, 300)) : "";

  el.innerHTML = `
    <a class="deck-card__vote"
      href="${escapeAttr(hnPermalink(item.id))}"
      target="_blank" rel="noopener noreferrer"
      title="Open on HN to upvote">▲</a>
    ${hasScore ? `<a class="deck-card__score" href="${escapeAttr(hnPermalink(item.id))}" target="_blank" rel="noopener noreferrer" title="${score} points">${formatScore(score)}</a>` : ""}
    <div class="deck-card__title-row">
      <h3 class="deck-card__title">
        <a class="deck-card__title-link"
          href="${escapeAttr(titleHref)}"
          target="_blank" rel="noopener noreferrer"
          ${bodyTooltip ? `title="${bodyTooltip}"` : ""}>${escapeHtml(title)}</a>
      </h3>
      <img
        class="deck-card__favicon"
        src="${escapeAttr(faviconUrl(host))}"
        alt=""
        width="16"
        height="16"
        loading="lazy"
        referrerpolicy="no-referrer"
      />
    </div>
    <p class="deck-card__meta">
      ${hasComments ? `<a class="deck-card__comments" href="${escapeAttr(hnPermalink(item.id))}" target="_blank" rel="noopener noreferrer" data-comments-preview="${item.id}" title="${comments} ${comments === 1 ? "comment" : "comments"}" aria-label="${comments} ${comments === 1 ? "comment" : "comments"}">${comments} 💬</a><span class="deck-card__dot">·</span>` : ""}
      ${item.type === "job" ? `<span class="deck-card__badge">job</span><span class="deck-card__dot">·</span>` : ""}
      ${item.type === "poll" ? `<span class="deck-card__badge">poll</span><span class="deck-card__dot">·</span>` : ""}
      <span>by <a href="${escapeAttr(hnUserUrl(by))}" target="_blank" rel="noopener noreferrer">${escapeHtml(by)}</a></span>
      <span class="deck-card__dot">·</span>
      <button class="deck-card__time" type="button" data-short="${escapeAttr(shortTime)}" data-full="${escapeAttr(fullTime)}" title="${escapeAttr(fullTime)}">${escapeHtml(shortTime)}</button>
      <a class="deck-card__domain" href="${escapeAttr(hnFromSiteUrl(host))}" target="_blank" rel="noopener noreferrer">${escapeHtml(host)}</a>
    </p>
    ${bodyPreview ? `<p class="deck-card__body">${bodyPreview}</p>` : ""}
  `;
  bindCardTime(el);
  const commentsLink = el.querySelector<HTMLAnchorElement>("[data-comments-preview]");
  commentsLink?.addEventListener("click", (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || ev.button !== 0) return;
    ev.preventDefault();
    void openCommentsPreview(Number.parseInt(commentsLink.dataset.commentsPreview ?? "", 10));
  });
  return el;
}

function renderCommentCard(comment: Extract<HNFeedItem, { type: "comment" }>, by: string, shortTime: string, fullTime: string): string {
  return `
    <div class="deck-card__title-row">
      <h3 class="deck-card__title">
        <a class="deck-card__title-link" href="${escapeAttr(hnPermalink(comment.id))}" target="_blank" rel="noopener noreferrer">Comment by ${escapeHtml(by)}</a>
      </h3>
    </div>
    <p class="deck-card__meta">
      <a href="${escapeAttr(hnPermalink(comment.id))}" target="_blank" rel="noopener noreferrer">thread</a>
      ${comment.parent ? `<span>·</span><a href="${escapeAttr(hnPermalink(comment.parent))}" target="_blank" rel="noopener noreferrer">parent</a>` : ""}
      <span>·</span>
      <span>by <a href="${escapeAttr(hnUserUrl(by))}" target="_blank" rel="noopener noreferrer">${escapeHtml(by)}</a></span>
      <span>·</span>
      <button class="deck-card__time" type="button" data-short="${escapeAttr(shortTime)}" data-full="${escapeAttr(fullTime)}" title="${escapeAttr(fullTime)}">${escapeHtml(shortTime)}</button>
    </p>
    <p class="deck-card__body">${escapeHtml(stripHtml(comment.text))}</p>
  `;
}

function bindCardTime(el: HTMLElement): void {
  const timeBtn = el.querySelector<HTMLButtonElement>(".deck-card__time");
  timeBtn?.addEventListener("click", () => {
    if (!timeBtn.dataset.full || !timeBtn.dataset.short) return;
    timeBtn.textContent = timeBtn.textContent === timeBtn.dataset.full
      ? timeBtn.dataset.short
      : timeBtn.dataset.full;
  });
}

// ─── Comments preview ────────────────────────────────────────────────

async function openCommentsPreview(storyId: number): Promise<void> {
  if (!Number.isFinite(storyId)) return;
  const dom = tryGetDOM();
  if (!dom) return;
  statefulAbortComments(dom);
  const abort = new AbortController();
  (window as unknown as { __hnDeckCommentsAbort?: AbortController }).__hnDeckCommentsAbort = abort;
  dom.commentsTitle.textContent = "Loading comments…";
  dom.commentsMeta.textContent = "HN comments";
  dom.commentsBody.innerHTML = `
    <a class="comments-preview__open" href="${escapeAttr(hnPermalink(storyId))}" target="_blank" rel="noopener noreferrer">Open full thread on HN ↗</a>
    <p class="deck-empty"><span class="deck-spinner" aria-hidden="true"></span> Loading comments…</p>
  `;
  openDialog(dom.commentsDialog);
  try {
    const preview = await fetchCommentPreview(storyId, abort.signal);
    dom.commentsTitle.textContent = preview.story.title;
    dom.commentsMeta.textContent = `${preview.total} ${preview.total === 1 ? "comment" : "comments"}`;
    const storyBody = preview.story.text ? `<div class="comments-preview__body">${escapeHtml(stripHtml(preview.story.text))}</div>` : "";
    dom.commentsBody.innerHTML = `
      <a class="comments-preview__open" href="${escapeAttr(hnPermalink(preview.story.id))}" target="_blank" rel="noopener noreferrer">Open full thread on HN ↗</a>
      ${storyBody}
      ${preview.comments.length > 0 ? preview.comments.map((node) => renderCommentPreviewNode(node, 0)).join("") : `<p class="deck-empty">No comments yet.</p>`}
    `;
  } catch (err) {
    if (abort.signal.aborted) return;
    const message = err instanceof Error ? err.message : String(err);
    dom.commentsTitle.textContent = "Could not load comments";
    dom.commentsBody.innerHTML = `
      <a class="comments-preview__open" href="${escapeAttr(hnPermalink(storyId))}" target="_blank" rel="noopener noreferrer">Open full thread on HN ↗</a>
      <p class="deck-empty deck-empty--error">${escapeHtml(message)}</p>
    `;
  }
}

function statefulAbortComments(dom: DOM): void {
  const slot = window as unknown as { __hnDeckCommentsAbort?: AbortController };
  slot.__hnDeckCommentsAbort?.abort();
  dom.commentsDialog.addEventListener("close", () => slot.__hnDeckCommentsAbort?.abort(), { once: true });
}

function renderCommentPreviewNode(node: HNCommentNode, depth: number): string {
  const by = node.comment.by ?? "unknown";
  const date = node.comment.time ? new Date(node.comment.time * 1000) : null;
  const when = date ? relativeTime(date) : "unknown time";
  const fullTime = date ? formatFullTime(date) : "unknown time";
  return `
    <details class="comments-preview__comment" style="--depth:${Math.min(depth, 3)}" open>
      <summary class="comments-preview__byline"><a href="${escapeAttr(hnUserUrl(by))}" target="_blank" rel="noopener noreferrer">${escapeHtml(by)}</a> · <a href="${escapeAttr(hnPermalink(node.comment.id))}" target="_blank" rel="noopener noreferrer" title="${escapeAttr(fullTime)}">${escapeHtml(when)}</a></summary>
      <p class="comments-preview__text">${escapeHtml(stripHtml(node.comment.text))}</p>
      ${node.children.map((child) => renderCommentPreviewNode(child, depth + 1)).join("")}
    </details>
  `;
}

// ─── Column dialog ───────────────────────────────────────────────────

function editColumn(state: AppState, dom: DOM, id: string): void {
  openColumnDialog(state, dom, id);
}

function moveColumnInDeck(state: AppState, dom: DOM, id: string, direction: -1 | 1): void {
  state.deck = moveColumn(state.deck, id, direction);
  queuePersistState(state);
  renderDeck(state, dom);
}

async function removeColumnFromDeck(state: AppState, dom: DOM, id: string): Promise<void> {
  const runtime = state.columns.get(id);
  if (runtime && (runtime.loading || runtime.backfilling || runtime.topRefreshing)) return;
  if (state.persistTimer !== null) {
    window.clearTimeout(state.persistTimer);
    state.persistTimer = null;
  }
  state.columnItems.delete(id);
  clearFilterDecisions(state, id);
  state.deck = removeColumn(state.deck, id);
  if (state.focusedColumnId === id) state.focusedColumnId = null;
  await persistStateNow(state);
  renderDeck(state, dom);
  await persistDOMSnapshotNow();
}

function openColumnDialog(state: AppState, dom: DOM, id: string | null): void {
  state.editingColumnId = id;
  const col = id ? state.deck.columns.find((c) => c.id === id) : null;
  dom.columnTitle.value = columnDialogTitle(col);
  dom.columnSource.value = col?.source ?? "custom";
  dom.columnInstruction.value = col?.instruction ?? (col ? "" : defaultColumnInstruction("custom"));
  syncColumnSourceState(dom, false);
  openDialog(dom.columnDialog);
}

function columnDialogTitle(col: Column | null | undefined): string {
  if (!col) return "AI News";
  if (col.source === "user") return col.feedUser || col.title;
  if (col.source === "search") return col.feedQuery || col.title;
  return col.title;
}

function closeColumnDialog(state: AppState, dom: DOM): void {
  state.editingColumnId = null;
  closeDialog(dom.columnDialog);
}

function saveColumnDialog(state: AppState, dom: DOM): void {
  const title = dom.columnTitle.value.trim();
  if (!title) return;
  const source = dom.columnSource.value as ColumnSource;
  const editingId = state.editingColumnId;
  const instruction = dom.columnInstruction.value.trim() || undefined;
  const next: Omit<Column, "id"> =
    source === "top" || source === "new" || source === "ask" || source === "show" || source === "jobs"
      ? { source, title, instruction }
      : source === "user"
        ? { source, title, feedUser: title, instruction }
      : source === "best-month"
        ? { source, title, feedMonth: /^\d{4}-\d{2}$/.test(title) ? title : new Date().toISOString().slice(0, 7), instruction }
      : source === "search"
        ? { source, title, feedQuery: title, instruction }
      : {
          source: "custom",
          title,
          instruction: instruction || defaultColumnInstruction("custom"),
        };
  if (editingId) {
    state.deck = updateColumn(state.deck, editingId, next);
    state.columnItems.delete(editingId);
    clearFilterDecisions(state, editingId);
  } else {
    state.deck = addColumn(state.deck, { ...next, id: newColumnId() });
  }
  queuePersistState(state);
  closeColumnDialog(state, dom);
  renderDeck(state, dom);
}

function clearFilterDecisions(state: AppState, columnId: string): void {
  const col = state.deck.columns.find((c) => c.id === columnId);
  const instruction = col?.instruction?.trim();
  if (instruction) {
    const prefix = `${SOURCE_FILTER_CACHE_VERSION}\n${instruction}\n`;
    for (const key of state.sourceFilterDecisions.keys()) {
      if (key.startsWith(prefix)) state.sourceFilterDecisions.delete(key);
    }
  }
  queuePersistFilterCache(state);
}

function syncColumnSourceState(dom: DOM, updateTitle: boolean): void {
  if (updateTitle) dom.columnTitle.value = defaultColumnTitle(dom.columnSource.value);
  if (updateTitle) dom.columnInstruction.value = "";
}

function defaultColumnTitle(source: string): string {
  switch (source) {
    case "new": return "New";
    case "ask": return "Ask";
    case "show": return "Show";
    case "jobs": return "Jobs";
    case "user": return "hacker";
    case "best-month": return "Best this month";
    case "search": return "cloudflare";
    case "custom": return "AI News";
    case "top":
    default: return "Top";
  }
}

function defaultColumnInstruction(source: string): string {
  if (source !== "custom") return "";
  return "Artificial intelligence, machine learning, LLMs, GPT, Claude, Gemini, neural networks, AI research, AI products, AI startups.";
}

// ─── Drag / drop ─────────────────────────────────────────────────────

function bindColumnDragEvents(state: AppState, runtime: ColumnRuntime): void {
  runtime.el.addEventListener("dragstart", (ev) => {
    if (state.focusedColumnId !== null) {
      ev.preventDefault();
      return;
    }
    if (!isColumnDragHandle(ev.target, runtime.el)) {
      ev.preventDefault();
      return;
    }
    state.draggingColumnId = runtime.column.id;
    ev.dataTransfer?.setData("text/plain", runtime.column.id);
    ev.dataTransfer && (ev.dataTransfer.effectAllowed = "move");
    runtime.el.classList.add("deck-column--dragging");
  });
  runtime.el.addEventListener("dragend", () => {
    state.draggingColumnId = null;
    runtime.el.classList.remove("deck-column--dragging");
    clearColumnDropPlaceholder();
  });
}

function bindDeckDragPreview(state: AppState, dom: DOM): void {
  dom.deck.ondragover = (ev) => {
    const sourceId = state.draggingColumnId;
    if (!sourceId) return;
    ev.preventDefault();
    ev.dataTransfer && (ev.dataTransfer.dropEffect = "move");
    const target = findColumnDropTarget(dom, sourceId, ev.clientX);
    if (target) showColumnDropPlaceholder(dom, target.el, target.position);
  };
  dom.deck.ondrop = (ev) => {
    const sourceId = state.draggingColumnId;
    if (!sourceId) return;
    ev.preventDefault();
    const target = findColumnDropTarget(dom, sourceId, ev.clientX);
    state.draggingColumnId = null;
    clearColumnDropPlaceholder();
    if (!target || sourceId === target.el.dataset.columnId) return;
    state.deck = reorderColumn(state.deck, sourceId, target.el.dataset.columnId ?? "", target.position);
    queuePersistState(state);
    renderDeck(state, dom);
  };
  dom.deck.ondragleave = (ev) => {
    if (!state.draggingColumnId) return;
    if (ev.relatedTarget instanceof Node && dom.deck.contains(ev.relatedTarget)) return;
    clearColumnDropPlaceholder();
  };
}

function findColumnDropTarget(dom: DOM, sourceId: string, clientX: number): { el: HTMLElement; position: "before" | "after" } | null {
  const columns = Array.from(dom.deck.querySelectorAll<HTMLElement>(".deck-column"))
    .filter((el) => el.dataset.columnId !== sourceId);
  if (columns.length === 0) return null;
  for (const el of columns) {
    const rect = el.getBoundingClientRect();
    if (clientX < rect.left + rect.width / 2) return { el, position: "before" };
  }
  return { el: columns[columns.length - 1], position: "after" };
}

function isColumnDragHandle(target: EventTarget | null, columnEl: HTMLElement): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const header = target.closest<HTMLElement>(".deck-column__header");
  if (!header || !columnEl.contains(header)) return false;
  return !target.closest("button, a, input, textarea, select, [contenteditable]");
}

function showColumnDropPlaceholder(dom: DOM, target: HTMLElement, position: "before" | "after"): void {
  const existing = document.getElementById(DROP_PLACEHOLDER_ID);
  const placeholder = existing ?? document.createElement("section");
  placeholder.id = DROP_PLACEHOLDER_ID;
  placeholder.className = "deck-column-drop-placeholder";
  placeholder.setAttribute("aria-hidden", "true");
  placeholder.textContent = "Drop column here";
  if (position === "before") dom.deck.insertBefore(placeholder, target);
  else dom.deck.insertBefore(placeholder, target.nextSibling);
}

function clearColumnDropPlaceholder(): void {
  document.getElementById(DROP_PLACEHOLDER_ID)?.remove();
}

function reorderColumn(deck: Deck, sourceId: string, targetId: string, position: "before" | "after"): Deck {
  const columns = deck.columns.map((c) => ({ ...c }));
  const sourceIndex = columns.findIndex((c) => c.id === sourceId);
  const targetIndex = columns.findIndex((c) => c.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0) return deck;
  const [source] = columns.splice(sourceIndex, 1);
  let adjustedTarget = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
  if (position === "after") adjustedTarget += 1;
  columns.splice(adjustedTarget, 0, source);
  return { columns };
}

// ─── Focus mode ──────────────────────────────────────────────────────

function visibleCardCount(rt: ColumnRuntime): number {
  return rt.body.querySelectorAll(".deck-card").length;
}

function toggleColumnFocus(state: AppState, dom: DOM, id: string): void {
  state.focusedColumnId = state.focusedColumnId === id ? null : id;
  applyFocusState(state, dom);
  state.columns.get(id)?.el.scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" });
  ensureFocusedColumnBacklog(state, dom);
}

function ensureFocusedColumnBacklog(state: AppState, dom: DOM): void {
  const id = state.focusedColumnId;
  if (!id) return;
  const runtime = state.columns.get(id);
  if (!runtime || runtime.backfilling) return;
  window.requestAnimationFrame(() => void backfillFocusedColumn(state, dom, runtime));
}

async function backfillFocusedColumn(state: AppState, _dom: DOM, runtime: ColumnRuntime): Promise<void> {
  if (runtime.backfilling) return;
  runtime.backfilling = true;
  try {
    for (let i = 0; i < 4; i++) {
      if (state.focusedColumnId !== runtime.column.id || columnHasScrollableBacklog(runtime)) break;
      runtime.sentinel.innerHTML = `<span class="deck-spinner" aria-hidden="true"></span> Loading older…`;
      if (!runtime.hasMore || runtime.loading) break;
      await loadBatch(state, runtime);
      if (!runtime.hasMore) break;
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    }
  } finally {
    runtime.backfilling = false;
  }
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
      btn.textContent = focused ? "← Back" : "⛶";
      btn.classList.toggle("deck-column__btn--back", focused);
      btn.title = focused ? "Back to deck" : "Focus column";
      btn.setAttribute("aria-label", btn.title);
    }
  }
  updateDeckOverflowState(dom);
}

// ─── Custom CSS / theme ──────────────────────────────────────────────

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

// ─── Masthead ────────────────────────────────────────────────────────

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

// ─── Mutation observers ──────────────────────────────────────────────

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
  const allowed = children.every((el) =>
    el instanceof HTMLElement && (el.classList.contains("deck-column") || el.id === DROP_PLACEHOLDER_ID),
  );
  if (!allowed) return false;
  const columns = children.filter(
    (el): el is HTMLElement => el instanceof HTMLElement && el.classList.contains("deck-column"),
  );
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

// ─── Reset / console ─────────────────────────────────────────────────

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
      "  • deck columns, column order, titles, and instructions",
      "  • routing instructions",
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
      routingInstructions: state.routingInstructions,
      setupDismissed: state.setupDismissed,
      mastheadTitle: state.mastheadTitle,
      mastheadSubtitle: state.mastheadSubtitle,
      customCSSLength: state.customCSS.length,
      themeVars: { ...state.themeVars },
      columnsRendered: state.columns.size,
      cachedStories: state.storyById.size,
    }),
  };
}

// ─── Formatting helpers ──────────────────────────────────────────────

function formatScore(score: number): string {
  if (score >= 1000) return `${Math.round(score / 100) / 10}k`;
  return String(score);
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
