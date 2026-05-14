/**
 * Detection + targeted setup guide for users whose browser doesn't
 * have the Prompt API ready.
 *
 * The check ladder:
 *   1. Is this Chrome (or a Chromium-based browser that ships the API)?
 *   2. Is it a desktop OS? (No iOS / Android support yet.)
 *   3. Is the Chrome version 138+? (Stable shipped here.)
 *   4. Does `LanguageModel` exist on the global scope?
 *   5. Does `availability()` return "available" / "downloadable"?
 *
 * Each rung that fails maps to a specific problem and a specific fix.
 * We surface the most relevant one first so users don't wade through
 * irrelevant troubleshooting.
 */

export type GuideReason =
  | { kind: "wrong-browser"; browser: string }
  | { kind: "mobile" }
  | { kind: "old-chrome"; version: number }
  | { kind: "api-missing" }                // Chrome OK but `LanguageModel` undefined
  | { kind: "model-unavailable"; reason: string }; // availability returned "unavailable"

export interface BrowserInfo {
  isChrome: boolean;
  isEdge: boolean;
  isOtherChromium: boolean;
  isFirefox: boolean;
  isSafari: boolean;
  chromeVersion: number | null;
  isMobile: boolean;
  os: "mac" | "windows" | "linux" | "ios" | "android" | "chromeos" | "unknown";
}

export function detectBrowser(): BrowserInfo {
  const ua = navigator.userAgent;
  const ualc = ua.toLowerCase();

  const isMobile = /android|iphone|ipad|ipod|mobile/i.test(ua);
  const isEdge = /edg\//i.test(ua);
  const isFirefox = /firefox/i.test(ua);
  const isSafari = /safari/i.test(ua) && !/chrome|chromium|crios|edg\//i.test(ua);
  // Chrome must NOT match Edge/Opera/etc. The order matters.
  const isChrome = /chrome/i.test(ua) && !isEdge && !/opr\//i.test(ua) && !/yabrowser/i.test(ua);
  const isOtherChromium = !isChrome && !isEdge && /chromium|chrome/i.test(ualc) && !isFirefox && !isSafari;

  let chromeVersion: number | null = null;
  if (isChrome || isEdge) {
    const m = ua.match(/Chrome\/(\d+)/);
    if (m) chromeVersion = Number.parseInt(m[1], 10);
  }

  let os: BrowserInfo["os"] = "unknown";
  if (/iphone|ipad|ipod/i.test(ua)) os = "ios";
  else if (/android/i.test(ua)) os = "android";
  else if (/cros/i.test(ua)) os = "chromeos";
  else if (/mac os x/i.test(ua)) os = "mac";
  else if (/windows/i.test(ua)) os = "windows";
  else if (/linux/i.test(ua)) os = "linux";

  return {
    isChrome,
    isEdge,
    isOtherChromium,
    isFirefox,
    isSafari,
    chromeVersion,
    isMobile,
    os,
  };
}

/**
 * Classify why the API is unavailable so the UI can show targeted
 * instructions. `availabilityReason` is whatever `availability()` told
 * us, used as the model-unavailable fallback.
 */
export function classifyFailure(
  info: BrowserInfo,
  apiPresent: boolean,
  availabilityReason: string,
): GuideReason {
  // Mobile is a hard no for now.
  if (info.isMobile || info.os === "ios" || info.os === "android") {
    return { kind: "mobile" };
  }

  // Wrong browser entirely.
  if (info.isFirefox) return { kind: "wrong-browser", browser: "Firefox" };
  if (info.isSafari) return { kind: "wrong-browser", browser: "Safari" };

  // Chrome-family but probably not real Chrome (Brave/Opera with custom builds, etc.)
  // For now we treat Edge as Chrome. It ships the same API on the same schedule.
  if (!info.isChrome && !info.isEdge && !info.isOtherChromium) {
    return { kind: "wrong-browser", browser: "this browser" };
  }

  // Old Chrome.
  if (info.chromeVersion !== null && info.chromeVersion < 138) {
    return { kind: "old-chrome", version: info.chromeVersion };
  }

  // Chrome 138+ but the API isn't on the global scope.
  // Could be: ChromeOS on a non-Plus device, missing flag, an enterprise lockdown.
  if (!apiPresent) return { kind: "api-missing" };

  // API exists but availability returned "unavailable". Likely a
  // hardware / storage / metered-network gate.
  return { kind: "model-unavailable", reason: availabilityReason };
}

export interface GuideContent {
  title: string;
  intro: string;
  /**
   * Each step is a piece of HTML. The renderer numbers them and
   * displays them as a list. The HTML is trusted; we author it here,
   * not from user/model input.
   */
  steps: string[];
  /** Optional verification link. */
  verifyLink?: { label: string; href: string };
}

export function guideContentFor(reason: GuideReason): GuideContent {
  switch (reason.kind) {
    case "mobile":
      return {
        title: "Open this on a desktop",
        intro:
          "On-device AI in Chrome doesn't yet run on phones or tablets. The model is too large for mobile devices.",
        steps: [
          "Open this page on macOS, Windows, Linux, or a Chromebook Plus.",
          "Use Chrome 138 or newer.",
          "Make sure you have at least 22 GB free disk space.",
        ],
      };

    case "wrong-browser":
      return {
        title: `${reason.browser} doesn't have built-in AI yet`,
        intro:
          "This demo uses Chrome's built-in Prompt API (Gemini Nano). It's currently a Chromium-only feature.",
        steps: [
          "Install Google Chrome 138 or newer: <a href=\"https://www.google.com/chrome/\" target=\"_blank\" rel=\"noopener\">google.com/chrome</a>.",
          "Reopen this page in Chrome.",
          "Click the <b>Begin</b> button to download the on-device model (~few GB, one-time).",
        ],
      };

    case "old-chrome":
      return {
        title: `Chrome ${reason.version} is too old`,
        intro:
          "The Prompt API shipped to stable in Chrome 138 (mid-2025). Earlier versions don't have it.",
        steps: [
          "Update Chrome: open <code>chrome://settings/help</code> in a new tab.",
          "Wait for Chrome to download the latest version, then click <b>Relaunch</b>.",
          "Come back to this page and refresh.",
        ],
        verifyLink: { label: "Open chrome://settings/help", href: "chrome://settings/help" },
      };

    case "api-missing":
      return {
        title: "Built-in AI isn't enabled in this Chrome",
        intro:
          "Chrome 138+ ships the Prompt API by default, but in some builds (older ChromeOS, enterprise-managed, or development) it's off. Enable two flags and restart Chrome.",
        steps: [
          "Open <code>chrome://flags/#optimization-guide-on-device-model</code> in a new tab.",
          "Set the flag to <b>Enabled BypassPerfRequirement</b>.",
          "Open <code>chrome://flags/#prompt-api-for-gemini-nano</code> and set it to <b>Enabled</b>.",
          "Click <b>Relaunch</b> at the bottom.",
          "Come back here, refresh the page, and click the <b>Begin</b> button.",
          "If <code>chrome://on-device-internals</code> is missing, enable <code>chrome://flags/#internal-debugging-page-urls</code>, relaunch Chrome, then check <code>chrome://chrome-urls</code>.",
        ],
        verifyLink: {
          label: "Open chrome://on-device-internals",
          href: "chrome://on-device-internals",
        },
      };

    case "model-unavailable":
      return {
        title: "On-device model can't run on this device",
        intro:
          "Chrome's check returned <code>unavailable</code>. Usually this means the hardware or storage requirements aren't met.",
        steps: [
          "<b>Storage:</b> the volume containing your Chrome profile needs at least <b>22 GB free</b>.",
          "<b>GPU:</b> a discrete or integrated GPU with more than <b>4 GB VRAM</b>, OR a CPU with <b>16 GB RAM and 4+ cores</b>.",
          "<b>Network:</b> not on a metered/cellular connection (the one-time download is several GB).",
          "Open <code>chrome://on-device-internals</code> to see exactly which check failed.",
          "If that page is hidden, enable <code>chrome://flags/#internal-debugging-page-urls</code>, relaunch Chrome, then open it from <code>chrome://chrome-urls</code>.",
          `<details><summary>Original error</summary><pre style="white-space:pre-wrap;font-size:11px;color:#9aa0a6;margin-top:6px;">${escapeHtml(reason.reason)}</pre></details>`,
        ],
        verifyLink: {
          label: "Open chrome://on-device-internals",
          href: "chrome://on-device-internals",
        },
      };
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
