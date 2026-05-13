/** TweetDeck-style HN deck app. */

import {
  fetchTopStoryBatch,
  fetchFeedStoryBatch,
  fetchSearchStoryBatch,
  clearHNCache,
  hnFromSiteUrl,
  hnPermalink,
  hnUserUrl,
  hostOf,
  stripHtml,
  type HNFeedItem,
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
import { buildDeckSystemPrompt, buildDeckUserPrompt, buildSourceFilterSystemPrompt, buildSourceFilterUserPrompt } from "./deck-prompt";
import { createPromptBus, type PromptBus } from "./prompt-bus";
import { checkAvailability, createSession, type ModelStatus } from "./prompt-api";
import { classifyFailure, detectBrowser, guideContentFor, type GuideContent } from "./setup-guide";

const BATCH = 30;
const AUTO_RELOAD_OPTIONS = [60_000, 5 * 60_000, 60 * 60_000] as const;
const DEFAULT_AUTO_RELOAD_MS = AUTO_RELOAD_OPTIONS[0];
const CARD_STALE_MS = 5 * 60_000;
const OPFS_STATE_FILE = "hn-deck-state-v1.json";
const OPFS_DOM_SNAPSHOT_FILE = "hn-deck-dom-v1.json";
const APP_CSS_ID = "hn-deck-app-css";
const CUSTOM_CSS_ID = "hn-deck-custom-css";
const THEME_VARS_CSS_ID = "hn-deck-theme-vars";
const DROP_PLACEHOLDER_ID = "deck-column-drop-placeholder";
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
const UI_SIZES = ["compact", "normal", "large"] as const;
type UISize = (typeof UI_SIZES)[number];

interface ColumnItem {
  storyId: number;
  lastRenderedAt: number;
}

interface DOM {
  status: HTMLElement;
  deck: HTMLElement;
  instructionsBox: HTMLTextAreaElement;
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
  columnSourceParam: HTMLInputElement;
  columnPredicate: HTMLTextAreaElement;
  columnSave: HTMLButtonElement;
  columnCancel: HTMLButtonElement;
  columnClose: HTMLButtonElement;
  uiSizeBtn: HTMLButtonElement;
  resetState: HTMLButtonElement;
}

interface ColumnRuntime {
  column: Column;
  el: HTMLElement;
  body: HTMLElement;
  topStatus: HTMLElement;
  sentinel: HTMLElement;
  cursor: number;
  searchCursor: number;
  searchFallback: boolean;
  loading: boolean;
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
  routingCursor: number;
  routing: boolean;
  /** True while rendering cards from a Nano routing/polling pass. */
  markingFresh: boolean;
  uiSize: UISize;
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
  composeAbort?: AbortController;
}

interface PersistedState {
  deck: Deck;
  routingInstructions: string;
  uiSize: UISize;
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
    sourceFilterDecisions: new Map(),
    promptBus: createPromptBus(),
    routingInstructions: persisted?.routingInstructions ?? "",
    modelReady: false,
    routingCursor: 0,
    routing: false,
    markingFresh: false,
    uiSize: persisted?.uiSize ?? "normal",
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
  };

  applyUISize(state);
  syncAppOwnedControls(state, dom);
  applyMasthead(state);
  observeMastheadEdits(state);
  applyThemeVars(state.themeVars);
  observeCSSVarEdits(state);
  applyCustomCSS(state.customCSS);
  observeCustomCSSEdits(state);
  renderDeck(state, dom);
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
  ensureDialogWithChildren("editor-dialog", ["editor-close", "editor-done", "routing-instructions", "ui-size-btn", "reset-state"], baseline);
  ensureDialogWithChildren("column-dialog", ["column-close", "column-title", "column-kind", "column-source-param", "column-predicate", "column-save", "column-cancel"], baseline);
  ensureAppCSS(baseline);
}

function ensureTopbar(baseline: DOMBaseline): void {
  const required = ["add-column-btn", "editor-btn", "about-btn", "github-link"];
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
    columnSourceParam: get<HTMLInputElement>("column-source-param"),
    columnPredicate: get<HTMLTextAreaElement>("column-predicate"),
    columnSave: get<HTMLButtonElement>("column-save"),
    columnCancel: get<HTMLButtonElement>("column-cancel"),
    columnClose: get<HTMLButtonElement>("column-close"),
    uiSizeBtn: get<HTMLButtonElement>("ui-size-btn"),
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
  updateUISizeButton(state, dom);
}

function bindCoreControls(state: AppState, dom: DOM): void {
  dom.instructionsBox.oninput = () => {
    state.routingInstructions = dom.instructionsBox.value;
    queuePersistState(state);
  };
  dom.setupBegin.onclick = () => void beginModelDownload(state, dom);
  dom.setupRetry.onclick = () => void bootstrap(state, dom);
  dom.uiSizeBtn.onclick = () => toggleUISize(state, dom);
  dom.addColumnBtn.onclick = () => openColumnDialog(state, dom, null);
  dom.columnKind.onchange = () => syncColumnKindState(dom, true);
  dom.columnSave.onclick = () => saveColumnDialog(state, dom);
  dom.columnCancel.onclick = () => closeColumnDialog(state, dom);
  dom.columnClose.onclick = () => closeColumnDialog(state, dom);
  dom.resetState.onclick = () => void resetPersistedState();
  dom.columnDialog.onclick = (ev) => {
    if (ev.target === dom.columnDialog) closeColumnDialog(state, dom);
  };
  wireDialogControls("about-dialog", "about-btn", "about-close");
  wireDialogControls("editor-dialog", "editor-btn", "editor-close", "editor-done");
  bindKeyboardShortcuts(state, dom);
}

function bindKeyboardShortcuts(state: AppState, dom: DOM): void {
  document.onkeydown = (ev) => {
    if (isTypingTarget(ev.target)) return;
    if (document.querySelector("dialog[open]") && ev.key !== "?") return;
    if (ev.key === "n") {
      ev.preventDefault();
      openColumnDialog(state, dom, null);
    } else if (ev.key === "c") {
      ev.preventDefault();
      document.getElementById("editor-btn")?.click();
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

function wireDialogControls(dialogId: string, openBtnId: string, closeBtnId: string, doneBtnId?: string): void {
  const dlg = document.getElementById(dialogId) as HTMLDialogElement | null;
  const openBtn = document.getElementById(openBtnId) as HTMLElement | null;
  const closeBtn = document.getElementById(closeBtnId) as HTMLElement | null;
  const doneBtn = doneBtnId ? document.getElementById(doneBtnId) as HTMLElement | null : null;
  if (!dlg || !openBtn) return;
  openBtn.onclick = () => {
    if (dlg.open) dlg.close();
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
    dom.instructionsBox.disabled = false;
    setStatus(dom, "Nano is ready. Filling curated columns…");
    loadNanoFilteredRawColumns(state);
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
    dom.instructionsBox.disabled = false;
    setStatus(dom, "Nano is ready. Filling curated columns…");
    loadNanoFilteredRawColumns(state);
    void routeUntilFilled(state, dom);
  } catch (err) {
    const info = detectBrowser();
    setSetup(dom, { kind: "guide", content: guideContentFor(classifyFailure(info, true, err instanceof Error ? err.message : String(err))) });
    setStatus(dom, "Nano download failed. Raw columns still work.", "error");
  }
}

function renderDeck(state: AppState, dom: DOM): void {
  for (const rt of state.columns.values()) clearColumnAutoReloadTimer(rt);
  dom.deck.innerHTML = "";
  state.columns.clear();
  for (const column of state.deck.columns) {
    const el = document.createElement("section");
    el.className = `deck-column deck-column--${column.kind}`;
    el.dataset.columnId = column.id;
    el.innerHTML = `
      <header class="deck-column__header" draggable="true" title="Drag to reorder column">
        <h2 class="deck-column__title">${escapeHtml(column.title)}</h2>
        <div class="deck-column__actions">
          <button class="deck-column__btn deck-column__btn--edit" data-action="left" title="Move column left" aria-label="Move column left">←</button>
          <button class="deck-column__btn deck-column__btn--edit" data-action="right" title="Move column right" aria-label="Move column right">→</button>
          <button class="deck-column__btn deck-column__btn--wide" data-action="reload" title="Change column auto-refresh" aria-label="Change column auto-refresh">${escapeHtml(columnReloadLabel(column))}</button>
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
      searchCursor: 0,
      searchFallback: false,
      loading: false,
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
    el.querySelector<HTMLElement>('[data-action="remove"]')?.addEventListener("click", () => {
      state.columnItems.delete(column.id);
      state.deck = removeColumn(state.deck, column.id);
      queuePersistState(state);
      renderDeck(state, dom);
    });

    body.addEventListener("scroll", () => {
      resetColumnAutoReloadTimer(state, dom, runtime);
      if (body.scrollTop + body.clientHeight >= body.scrollHeight - 240) {
        if (column.kind === "raw") void loadRawBatch(state, runtime);
        else void routeNextBatch(state, dom);
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

    if (column.kind === "raw") {
      if (getColumnItems(state, column.id).length === 0) {
        renderRawColumnWaitingMessage(state, runtime);
        void loadRawBatch(state, runtime);
      }
      else runtime.sentinel.textContent = runtime.hasMore ? "Scroll for more" : endOfFeedLabel(runtime.column);
    } else if (getColumnItems(state, column.id).length === 0) {
      renderCuratedEmpty(runtime);
    }
    bindColumnDragEvents(state, runtime);
    scheduleColumnAutoReload(state, dom, runtime);
  }
  bindDeckDragPreview(state, dom);
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
  renderColumnMessage(runtime, "Waiting for Nano routing. Once Nano is ready, stories matching this column's description will appear here automatically.");
  runtime.sentinel.textContent = "Not routed yet";
}

function loadNanoFilteredRawColumns(state: AppState): void {
  for (const runtime of state.columns.values()) {
    if (columnNeedsNanoFilter(runtime.column) && getColumnItems(state, runtime.column.id).length === 0) {
      void loadRawBatch(state, runtime);
    }
  }
}

function renderColumnMessage(runtime: ColumnRuntime, text: string, kind: "empty" | "error" = "empty"): void {
  runtime.body.innerHTML = `<p class="deck-empty ${kind === "error" ? "deck-empty--error" : ""}">${escapeHtml(text)}</p>`;
}

function renderRawColumnWaitingMessage(state: AppState, runtime: ColumnRuntime): void {
  if (runtime.column.kind !== "raw" || !runtime.column.description?.trim() || visibleCardCount(runtime) > 0) return;
  const message = parseLiteralSourcePredicate(runtime.column.description)
    ? "Filtering this source. Matching stories will appear here automatically."
    : state.modelReady
      ? "Waiting for Nano to filter this source. Matching stories will appear here automatically."
      : "Waiting for Nano. This source has a prompt filter, so matching stories will appear after Nano is ready.";
  renderColumnMessage(runtime, message);
}

function clearColumnMessage(runtime: ColumnRuntime): void {
  runtime.body.querySelector<HTMLElement>(".deck-empty")?.remove();
}

async function loadRawBatch(state: AppState, runtime: ColumnRuntime): Promise<void> {
  if (runtime.loading || !runtime.hasMore) return;
  runtime.loading = true;
  runtime.sentinel.innerHTML = `<span class="deck-spinner" aria-hidden="true"></span> Loading more…`;
  renderRawColumnWaitingMessage(state, runtime);
  try {
    let added = 0;
    do {
      const literal = literalSourcePredicate(runtime.column);
      const batch = runtime.searchFallback && literal
        ? await fetchSearchStoryBatch(literal.join(" "), runtime.searchCursor, runtime.searchCursor + BATCH)
        : await fetchFeedStoryBatch(
          runtime.column.feed ?? "top",
          runtime.cursor,
          runtime.cursor + BATCH,
          undefined,
          { user: runtime.column.feedUser, month: runtime.column.feedMonth },
        );
      if (columnNeedsNanoFilter(runtime.column) && !state.modelReady) {
        runtime.sentinel.textContent = "Nano filter not ready";
        if (visibleCardCount(runtime) === 0) renderColumnMessage(runtime, "This source has a prompt filter. Enable Nano to apply it.");
        return;
      }
      const stories = await filterSourceStories(state, runtime, batch.stories);
      for (const story of stories) {
        if (runtime.body.querySelector(`[data-story-id="${story.id}"]`)) continue;
        state.storyById.set(story.id, story);
        upsertColumnItem(state, runtime.column.id, { storyId: story.id, lastRenderedAt: Date.now() });
        if (added === 0) clearColumnMessage(runtime);
        runtime.body.appendChild(renderStoryCard(story));
        added++;
      }
      if (runtime.searchFallback) runtime.searchCursor += BATCH;
      else runtime.cursor += BATCH;
      runtime.hasMore = batch.hasMore;
      if (!runtime.hasMore && literal && !runtime.searchFallback && !columnHasScrollableBacklog(runtime)) {
        runtime.searchFallback = true;
        runtime.hasMore = true;
      }
      if (shouldScanMoreFilteredSource(runtime)) {
        runtime.sentinel.textContent = runtime.searchFallback
          ? `Searching older HN stories for ${literal?.join(" ") ?? "matches"}…`
          : `Scanning older ${runtime.column.feed ?? "top"} stories…`;
      }
    } while (shouldScanMoreFilteredSource(runtime));
    if (visibleCardCount(runtime) === 0 && !runtime.hasMore) renderColumnMessage(runtime, "No matching items found for this column.");
    runtime.sentinel.textContent = runtime.hasMore ? "Scroll for more" : endOfFeedLabel(runtime.column);
    if (added === 0 && runtime.hasMore) runtime.sentinel.textContent = "Scroll for more matches";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    runtime.sentinel.textContent = "Load failed";
    if (visibleCardCount(runtime) === 0) renderColumnMessage(runtime, `Could not load this column: ${message}`, "error");
  } finally {
    runtime.loading = false;
  }
}

function shouldScanMoreFilteredSource(runtime: ColumnRuntime): boolean {
  return runtime.column.kind === "raw" &&
    !!runtime.column.description?.trim() &&
    runtime.hasMore &&
    !columnHasScrollableBacklog(runtime);
}

function columnHasScrollableBacklog(runtime: ColumnRuntime): boolean {
  const cards = visibleCardCount(runtime);
  if (cards === 0) return false;
  if (runtime.body.clientHeight <= 0) return cards >= 12;
  return runtime.body.scrollHeight > runtime.body.clientHeight + 80;
}

function endOfFeedLabel(column: Column): string {
  switch (column.feed) {
    case "new": return "End of HN new stories";
    case "ask": return "End of Ask HN";
    case "show": return "End of Show HN";
    case "user": return "End of user activity";
    case "best-month": return "End of monthly best";
    case "top":
    default: return "End of HN top stories";
  }
}

function columnNeedsNanoFilter(column: Column): boolean {
  const predicate = column.description?.trim();
  return column.kind === "raw" && !!predicate && literalSourcePredicate(column) === null;
}

async function filterSourceStories(state: AppState, runtime: ColumnRuntime, stories: HNFeedItem[]): Promise<HNFeedItem[]> {
  const predicate = runtime.column.description?.trim();
  if (!predicate || runtime.column.kind !== "raw" || stories.length === 0) return stories;
  const literal = literalSourcePredicate(runtime.column);
  if (literal) return stories.filter((story) => literalSourceMatches(story, literal));

  const undecided: HNFeedItem[] = [];
  for (const story of stories) {
    if (!state.sourceFilterDecisions.has(sourceFilterCacheKey(runtime.column, story.id))) undecided.push(story);
  }

  if (undecided.length > 0) {
    let validDecisions = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      const filterColumn: Column = {
        ...runtime.column,
        kind: "curated",
        description: predicate,
      };
      const sink: DeckSink = {
        enqueue(action) {
          if (!undecided.some((story) => story.id === action.storyId)) return;
          state.sourceFilterDecisions.set(sourceFilterCacheKey(runtime.column, action.storyId), action.columnId === runtime.column.id);
          validDecisions++;
        },
        onSkip(reason) {
          console.warn("[deck filter] skipped", reason);
        },
      };
      const router = new DeckRouter([runtime.column.id], undecided.map((story) => story.id), sink);
      const executor = createDeckExecutor(router);
      await state.promptBus.run({
        systemPrompt: buildSourceFilterSystemPrompt({
          column: filterColumn,
          stories: undecided,
          batchStart: runtime.cursor,
        }),
        userPrompt: buildSourceFilterUserPrompt(attempt > 0),
        onChunk: (chunk) => executor.push(chunk),
      });
      executor.end();
      if (validDecisions > 0 || attempt > 0) break;
    }
    for (const story of undecided) {
      const key = sourceFilterCacheKey(runtime.column, story.id);
      if (!state.sourceFilterDecisions.has(key)) state.sourceFilterDecisions.set(key, false);
    }
  }

  return stories.filter((story) => state.sourceFilterDecisions.get(sourceFilterCacheKey(runtime.column, story.id)) === true);
}

function parseLiteralSourcePredicate(predicate: string): string[] | null {
  const p = predicate.trim();
  if (!p) return null;
  const quoted = p.match(/^['"]([^'"]{1,80})['"]$/);
  if (quoted) return [quoted[1]!.toLowerCase()];
  if (/^[a-z0-9][a-z0-9._-]{1,79}$/i.test(p)) return [p.toLowerCase()];
  if (/^[a-z0-9][a-z0-9._-]*(\s+[a-z0-9][a-z0-9._-]*){1,2}$/i.test(p)) {
    return p.toLowerCase().split(/\s+/);
  }
  return null;
}

function literalSourcePredicate(column: Column): string[] | null {
  const predicate = column.description?.trim();
  return predicate ? parseLiteralSourcePredicate(predicate) : null;
}

function literalSourceMatches(story: HNFeedItem, terms: readonly string[]): boolean {
  const haystack = [
    story.by,
    story.type === "comment" ? "news.ycombinator.com" : hostOf(story.url),
    story.type === "comment" ? stripHtml(story.text) : story.title,
    story.type === "story" ? stripHtml(story.text ?? "") : "",
    story.type === "story" ? story.url ?? "" : "",
  ].join("\n").toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

function sourceFilterCacheKey(column: Column, storyId: number): string {
  return `${column.id}\n${column.description?.trim() ?? ""}\n${storyId}`;
}

async function refreshColumnFromTop(state: AppState, dom: DOM, runtime: ColumnRuntime): Promise<void> {
  if (runtime.topRefreshing) return;
  runtime.topRefreshing = true;
  runtime.topStatus.hidden = false;
  runtime.topStatus.classList.remove("deck-column__top-status--ready");
  runtime.topStatus.classList.add("deck-column__top-status--loading");
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
      if (columnNeedsNanoFilter(runtime.column) && !state.modelReady) {
        runtime.sentinel.textContent = "Nano filter not ready";
        if (visibleCardCount(runtime) === 0) renderColumnMessage(runtime, "This source has a prompt filter. Enable Nano to apply it.");
        return;
      }
      const stories = await filterSourceStories(state, runtime, batch.stories);
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
    } else {
      await routeFreshTopBatch(state, dom);
      runtime.sentinel.textContent = "Refreshed";
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    runtime.sentinel.textContent = "Refresh failed";
    if (visibleCardCount(runtime) === 0) renderColumnMessage(runtime, `Could not refresh this column: ${message}`, "error");
  } finally {
    runtime.topRefreshing = false;
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
  }
}

async function routeOneBatch(
  state: AppState,
  dom: DOM,
  opts: { clearFirstBatch?: boolean; silent?: boolean; fresh?: boolean } = {},
): Promise<boolean> {
  const clearFirstBatch = opts.clearFirstBatch ?? true;
  const silent = opts.silent ?? false;
  const fresh = opts.fresh ?? false;
  const curated = state.deck.columns.filter((c) => c.kind === "curated");
  if (curated.length === 0) return false;
  setRoutingVisuals(state, true);
  state.markingFresh = fresh;
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

  const routingInstructions = dom.instructionsBox.value.trim();

  let decisions = 0;
  let placements = 0;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const sink: DeckSink = {
        enqueue(action) {
          if (action.columnId === "") {
            if (state.storyById.has(action.storyId)) decisions++;
            return;
          }
          if (renderDeckAction(state, action)) {
            decisions++;
            placements++;
          }
        },
        onSkip(reason) {
          console.warn("[deck] skipped", reason);
        },
      };
      const router = new DeckRouter(curated.map((c) => c.id), batch.stories.map((s) => s.id), sink);
      const executor = createDeckExecutor(router);
      await state.promptBus.run({
        systemPrompt: buildDeckSystemPrompt({ routingInstructions, columns: state.deck.columns, stories: batch.stories, batchStart: state.routingCursor }),
        userPrompt: buildDeckUserPrompt(attempt > 0),
        onChunk: (chunk) => executor.push(chunk),
      });
      executor.end();
      if (decisions > 0 || attempt > 0) break;
      if (!silent) setStatus(dom, "Nano returned no valid decisions. Retrying once…");
    }
    state.routingCursor += BATCH;
    if (placements === 0) {
      for (const rt of state.columns.values()) {
        if (rt.column.kind === "curated") rt.sentinel.textContent = batch.hasMore ? "No matches in latest batch; scroll for older" : "HN exhausted";
      }
    }
    return batch.hasMore;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setStatus(dom, `Routing failed: ${message}`, "error");
    for (const rt of state.columns.values()) {
      if (rt.column.kind !== "curated") continue;
      rt.sentinel.textContent = "Routing failed";
      if (visibleCardCount(rt) === 0) renderColumnMessage(rt, `Could not route this column: ${message}`, "error");
    }
    return false;
  } finally {
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
    await routeOneBatch(state, dom, { clearFirstBatch: false, silent: true, fresh: true });
  } finally {
    state.routingCursor = previousCursor;
    state.routing = false;
  }
}

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

function toggleUISize(state: AppState, dom: DOM): void {
  const current = UI_SIZES.indexOf(state.uiSize);
  state.uiSize = UI_SIZES[(current + 1) % UI_SIZES.length] ?? "normal";
  applyUISize(state);
  updateUISizeButton(state, dom);
  queuePersistState(state);
}

function applyUISize(state: AppState): void {
  document.documentElement.dataset.uiSize = state.uiSize;
}

function updateUISizeButton(state: AppState, dom: DOM): void {
  dom.uiSizeBtn.textContent = `UI size: ${labelUISize(state.uiSize)}`;
}

function labelUISize(size: UISize): string {
  switch (size) {
    case "compact": return "Compact";
    case "large": return "Large";
    case "normal":
    default: return "Normal";
  }
}

function coerceUISize(value: unknown): UISize {
  return typeof value === "string" && UI_SIZES.includes(value as UISize) ? value as UISize : "normal";
}

function underfilledCuratedColumns(state: AppState): ColumnRuntime[] {
  return Array.from(state.columns.values()).filter((rt) =>
    rt.column.kind === "curated" && !columnHasScrollableBacklog(rt),
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

function renderDeckAction(state: AppState, action: DeckAction): boolean {
  const rt = state.columns.get(action.columnId);
  if (!rt) return false;
  const story = state.storyById.get(action.storyId);
  if (!story) return false;
  if (!shouldReplaceColumnItem(state, rt.column.id, action.storyId)) return false;
  upsertColumnItem(state, rt.column.id, { storyId: story.id, lastRenderedAt: Date.now() }, state.markingFresh ? "prepend" : "append");
  const card = renderStoryCard(story, state.markingFresh);
  const existing = rt.body.querySelector<HTMLElement>(`[data-story-id="${story.id}"]`);
  if (existing) existing.replaceWith(card);
  else if (state.markingFresh) rt.body.prepend(card);
  else rt.body.appendChild(card);
  return true;
}

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
      uiSize: coerceUISize(raw.uiSize),
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
    uiSize: state.uiSize,
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
  for (const dialog of template.content.querySelectorAll("dialog[open]")) dialog.removeAttribute("open");
  template.content.getElementById(DROP_PLACEHOLDER_ID)?.remove();
  for (const el of template.content.querySelectorAll(".deck-column--dragging")) el.classList.remove("deck-column--dragging");
  return { ...snapshot, bodyHTML: template.innerHTML };
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

function renderStoryCard(story: HNFeedItem, fresh = false): HTMLElement {
  const el = document.createElement("article");
  el.className = ["deck-card", fresh ? "deck-card--fresh" : ""]
    .filter(Boolean)
    .join(" ");
  el.dataset.storyId = String(story.id);
  if (fresh) window.setTimeout(() => el.classList.remove("deck-card--fresh"), 45_000);
  const by = story.by ?? "unknown";
  const isComment = story.type === "comment";
  const host = isComment ? "news.ycombinator.com" : hostOf(story.url);
  const titleHref = isComment ? hnPermalink(story.id) : story.url || hnPermalink(story.id);
  const title = isComment ? `Comment by ${by}` : story.title;
  const bodyText = isComment ? stripHtml(story.text) : undefined;
  const ts = story.time ? new Date(story.time * 1000) : null;
  const shortTime = ts ? relativeTime(ts) : "unknown time";
  const fullTime = ts ? formatFullTime(ts) : "unknown time";
  const meta = isComment ? renderCommentMeta(story, by, shortTime, fullTime) : renderStoryMeta(story, host, by, shortTime, fullTime);
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
          target="_blank" rel="noopener noreferrer">${escapeHtml(title)}</a>
      </h3>
    </div>
    ${meta}
    ${bodyText ? `<p class="deck-card__body">${escapeHtml(bodyText)}</p>` : ""}
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

function renderStoryMeta(story: Extract<HNFeedItem, { type: "story" }>, host: string, by: string, shortTime: string, fullTime: string): string {
  const comments = story.descendants ?? 0;
  return `
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
  `;
}

function renderCommentMeta(comment: Extract<HNFeedItem, { type: "comment" }>, by: string, shortTime: string, fullTime: string): string {
  return `
    <p class="deck-card__meta">
      <a href="${escapeAttr(hnPermalink(comment.id))}" target="_blank" rel="noopener noreferrer">comment thread</a>
      ${comment.parent ? `<span>·</span><a href="${escapeAttr(hnPermalink(comment.parent))}" target="_blank" rel="noopener noreferrer">parent</a>` : ""}
      <span>·</span>
      <span>by <a href="${escapeAttr(hnUserUrl(by))}" target="_blank" rel="noopener noreferrer">${escapeHtml(by)}</a></span>
      <span>·</span>
      <button class="deck-card__time" type="button" data-short="${escapeAttr(shortTime)}" data-full="${escapeAttr(fullTime)}" title="${escapeAttr(fullTime)}">${escapeHtml(shortTime)}</button>
    </p>
  `;
}

function editColumn(state: AppState, dom: DOM, id: string): void {
  openColumnDialog(state, dom, id);
}

function moveColumnInDeck(state: AppState, dom: DOM, id: string, direction: -1 | 1): void {
  state.deck = moveColumn(state.deck, id, direction);
  queuePersistState(state);
  renderDeck(state, dom);
}

function bindColumnDragEvents(state: AppState, runtime: ColumnRuntime): void {
  runtime.el.addEventListener("dragstart", (ev) => {
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

function openColumnDialog(state: AppState, dom: DOM, id: string | null): void {
  state.editingColumnId = id;
  const col = id ? state.deck.columns.find((c) => c.id === id) : null;
  dom.columnTitle.value = col?.title ?? "Engineer bait";
  dom.columnKind.value = col?.kind === "raw" ? (col.feed ?? "top") : "custom";
  dom.columnSourceParam.value = col?.feed === "user"
    ? col.feedUser ?? ""
    : col?.feed === "best-month"
      ? col.feedMonth ?? new Date().toISOString().slice(0, 7)
      : "";
  dom.columnPredicate.value = col?.description ?? (col ? "" : defaultColumnPrompt("custom"));
  syncColumnKindState(dom, false);
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
  const editingId = state.editingColumnId;
  const previous = editingId ? state.deck.columns.find((c) => c.id === editingId) : null;
  const sourceParam = dom.columnSourceParam.value.trim();
  const description = dom.columnPredicate.value.trim() || undefined;
  const next: Omit<Column, "id"> =
    kind === "top" || kind === "new" || kind === "ask" || kind === "show"
      ? { kind: "raw", title, feed: kind, feedUser: undefined, feedMonth: undefined, description }
      : kind === "user"
        ? { kind: "raw", title, feed: "user", feedUser: sourceParam || "hacker", feedMonth: undefined, description }
      : kind === "best-month"
        ? { kind: "raw", title, feed: "best-month", feedMonth: sourceParam || new Date().toISOString().slice(0, 7), feedUser: undefined, description }
      : {
          kind: "curated",
          title,
          description: description || defaultColumnPrompt("custom"),
          feed: undefined,
          feedUser: undefined,
          feedMonth: undefined,
        };
  if (editingId) {
    state.deck = updateColumn(state.deck, editingId, next);
  } else {
    state.deck = addColumn(state.deck, { ...next, id: newColumnId() });
  }
  if (editingId) {
    state.columnItems.delete(editingId);
    clearSourceFilterDecisions(state, editingId);
  }
  if (previous?.kind === "curated" || next.kind === "curated") resetCuratedRoutingCache(state);
  queuePersistState(state);
  closeColumnDialog(state, dom);
  renderDeck(state, dom);
  if (next.kind === "curated" && state.modelReady) {
    void routeUntilFilled(state, dom);
  }
}

function resetCuratedRoutingCache(state: AppState): void {
  state.routingCursor = 0;
  for (const column of state.deck.columns) {
    if (column.kind === "curated") state.columnItems.delete(column.id);
  }
}

function clearSourceFilterDecisions(state: AppState, columnId: string): void {
  for (const key of state.sourceFilterDecisions.keys()) {
    if (key.startsWith(`${columnId}\n`)) state.sourceFilterDecisions.delete(key);
  }
}

function syncColumnKindState(dom: DOM, updateTitle: boolean): void {
  const needsParam = dom.columnKind.value === "user" || dom.columnKind.value === "best-month";
  dom.columnSourceParam.disabled = !needsParam;
  if (updateTitle) dom.columnTitle.value = defaultColumnTitle(dom.columnKind.value);
  if (updateTitle) dom.columnPredicate.value = "";
  if (dom.columnKind.value === "user" && (updateTitle || !dom.columnSourceParam.value.trim())) {
    dom.columnSourceParam.value = "hacker";
  }
  if (dom.columnKind.value === "best-month" && !dom.columnSourceParam.value.trim()) {
    dom.columnSourceParam.value = new Date().toISOString().slice(0, 7);
  }
}

function defaultColumnTitle(kind: string): string {
  switch (kind) {
    case "new": return "New";
    case "ask": return "Ask";
    case "show": return "Show";
    case "user": return "hacker";
    case "best-month": return "Best this month";
    case "custom": return "Engineer bait";
    case "top":
    default: return "Top";
  }
}

function defaultColumnPrompt(kind: string): string {
  if (kind !== "custom") return "";
  return "Deep technical posts a working software engineer would stop scrolling for: debugging stories, infrastructure details, databases, compilers, browsers, performance, reliability, and practical tools. Skip generic AI takes, funding, hiring, politics, and drama.";
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
      routingInstructions: state.routingInstructions,
      uiSize: state.uiSize,
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
