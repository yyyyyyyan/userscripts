// ==UserScript==
// @name          Reload Until
// @namespace     yyyyyyyan/reload-until
// @version       1.0.0
// @description   Reloads a page until something appears or disappears, then raises an alarm you can't miss.
// @author        yyyyyyyan
// @license       GPL-3.0-or-later
// @homepageURL   https://github.com/yyyyyyyan/userscripts/tree/main/scripts/reload-until
// @supportURL    https://github.com/yyyyyyyan/userscripts/issues
// @match         http://*/*
// @match         https://*/*
// @run-at        document-idle
// @noframes
// @grant         GM_getValue
// @grant         GM_setValue
// @grant         GM_deleteValue
// @grant         GM_listValues
// @grant         GM_addValueChangeListener
// @grant         GM_notification
// @grant         GM_registerMenuCommand
// @grant         window.focus
// @compatible    chrome Violentmonkey or Tampermonkey; enable "Allow User Scripts"
// @compatible    firefox Violentmonkey or Tampermonkey
// @incompatible  safari Userscripts lacks the menu commands this script needs
// ==/UserScript==

(() => {
  'use strict';

  /**
   * @typedef {object} PendingAlert
   * @property {'condition' | 'redirect' | 'not-ready'} kind
   * @property {number} at
   * @property {string} landedUrl
   * @property {string} watchOrigin
   * @property {string} watchHost The watched host name, the only part another site is shown.
   */

  /**
   * Why the script paused a watch on its own. A watch the user turned off has none.
   * @typedef {object} Pause
   * @property {'not-ready' | 'invalid' | 'error'} reason
   * @property {string} detail
   */

  /**
   * How an alarm reaches the user. Every style keeps the alarm on the page until Acknowledge.
   * @typedef {'page' | 'page-and-desktop' | 'insistent'} AlertStyle
   */

  /**
   * @typedef {object} Watch
   * @property {string} url
   * @property {boolean} enabled
   * @property {'appears' | 'disappears'} condition
   * @property {string} selector
   * @property {string} text
   * @property {boolean} matchCase
   * @property {string} readySelector
   * @property {number} intervalSeconds
   * @property {number} settleSeconds
   * @property {number} confirmSeconds
   * @property {AlertStyle} alertStyle
   * @property {PendingAlert | null} pendingAlert
   * @property {Pause | null} paused Set while the watch is on but the script paused it.
   */

  /**
   * Written just before the script reloads a watched page, and cleared by the page the reload
   * ends on.
   * @typedef {object} Handoff
   * @property {string} watchUrl
   * @property {string} watchOrigin
   * @property {string} watchHost
   * @property {string} fromUrl
   * @property {number} at
   * @property {string} nonce
   */

  /** @typedef {Window & { webkitAudioContext?: typeof AudioContext }} LegacyAudioWindow */

  /**
   * @typedef {object} Runner
   * @property {() => void} suspendRefresh
   * @property {() => void} destroy
   * @property {() => void} focus Moves keyboard focus to the widget.
   */

  const SHADOW_MODE = 'closed';
  const SCHEMA_VERSION = 1;
  const MIN_INTERVAL_SECONDS = 10;
  const WATCH_PREFIX = 'watch:';
  const HANDOFF_KEY = 'handoff';
  const SESSION_HANDOFF_KEY = 'reload-until:handoff';
  const SESSION_ALARM_KEY = 'reload-until:alarm';
  const SESSION_COLLAPSED_KEY = 'reload-until:collapsed';
  const HINT_KEY = 'hint-shown';
  const MENU_COMMAND = 'Reload Until settings';
  const HANDOFF_START_SLACK_MS = 500;
  const HANDOFF_CLAIM_DELAY_MS = 3000;
  const MAX_SECONDS = 86400;
  const REMINDER_INTERVAL_MS = 60_000;
  /** A reminder due sooner than this after a page loads waits for the next one instead. */
  const REMINDER_MIN_WAIT_MS = 10_000;
  const SOUND_VOLUME = 0.25;
  /** @type {readonly AlertStyle[]} */
  const ALERT_STYLES = ['page', 'page-and-desktop', 'insistent'];
  /** @type {Omit<Watch, 'url'>} */
  const DEFAULTS = {
    enabled: false,
    condition: 'appears',
    selector: '',
    text: '',
    matchCase: false,
    readySelector: '',
    intervalSeconds: 30,
    settleSeconds: 5,
    confirmSeconds: 3,
    alertStyle: 'page-and-desktop',
    pendingAlert: null,
    paused: null,
  };

  const PANEL_CSS = `
    *{box-sizing:border-box}
    [hidden]{display:none !important}
    .backdrop{width:100%;height:100%;display:grid;place-items:center;padding:12px;background:#0009}
    .panel:focus{outline:none}
    .panel{width:min(650px,94vw);max-height:90vh;overflow:auto;background:#17202a;color:#fff;border:1px solid #777;border-radius:12px;padding:20px;font:14px/1.5 system-ui,sans-serif;box-shadow:0 12px 50px #0009}
    h2{margin:0 0 8px;font-size:22px}
    h3{margin:0;font-size:16px}
    p{margin:6px 0 14px;color:#d1d5db}
    label{display:block}
    .group{margin:16px 0 0;padding:12px 14px 14px;border:1px solid #3d4b59;border-radius:8px}
    .field{margin:12px 0 0}
    .prompt{margin:8px 0 0;padding:8px 10px;border-left:4px solid #f5c542;background:#243140;color:#fff}
    .unsaved{margin-top:14px;padding:10px 12px;border:1px solid #f5c542;border-radius:8px}
    .unsaved p{margin:0 0 8px;color:#fff}
    .unsaved .actions{margin-top:0}
    .check{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
    .check small{flex-basis:100%}
    input:not([type=checkbox]),select,textarea{display:block;width:100%;margin-top:4px;padding:8px;color:#111;background:#fff;border:1px solid #aaa;border-radius:5px;font:inherit}
    input[type=checkbox]{margin:0}
    [aria-invalid=true]{border-color:#ff5252;outline:2px solid #ff5252}
    small{display:block;margin-top:2px;font-size:13px;color:#bfc8d2}
    .field-error{flex-basis:100%;margin:4px 0 0;color:#ffb4b4}
    button{font:inherit;padding:7px 12px;border:1px solid #aaa;border-radius:5px;background:#fff;color:#111;cursor:pointer}
    button:disabled{opacity:.55;cursor:default}
    .actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:18px}
    .error{color:#ffb4b4;white-space:pre-wrap;margin-top:12px}
  `;

  const WIDGET_CSS = `
    .box{background:#17202a;color:#fff;border:2px solid #7f8c8d;border-radius:10px;padding:14px;font:14px/1.4 system-ui,sans-serif;box-shadow:0 3px 18px #0006}
    .box.alarm{border-color:#ff5252}
    .box.collapsed{padding:6px 10px}
    .head{display:flex;align-items:center;justify-content:space-between;gap:12px}
    .name{font-weight:700}
    .head button{padding:2px 8px;font-size:12px}
    .body{margin-top:6px}
    p{margin:6px 0 0}
    .notice{margin-top:6px;white-space:pre-wrap}
    .detail{font-size:12px;color:#d1d5db;margin-top:6px}
    .notice:empty,.detail:empty{display:none}
    .actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
    button{font:inherit;color:#111;background:#fff;border:1px solid #aaa;border-radius:5px;padding:5px 9px;cursor:pointer}
    [hidden]{display:none}
  `;

  /** A validation failure that belongs to one settings field. */
  class FieldError extends Error {
    /**
     * @param {string} field
     * @param {string} message
     */
    constructor(field, message) {
      super(message);
      this.field = field;
    }
  }

  /**
   * @param {string} value
   * @returns {string | null} The URL without its fragment, or null when it can't be watched.
   */
  function normalizeUrl(value) {
    /** @type {URL} */
    let url;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    url.hash = '';
    return url.href;
  }
  const currentUrl = () => normalizeUrl(location.href);

  /**
   * @param {string} key
   * @returns {string | null | undefined} Undefined when the page blocks session storage.
   */
  function sessionGet(key) {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return undefined;
    }
  }

  /**
   * @param {string} key
   * @param {string | null} value Null removes the key.
   */
  function sessionSet(key, value) {
    try {
      if (value === null) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, value);
    } catch {
      /* Without session storage, only the shared handoff record is used. */
    }
  }

  function randomNonce() {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
  }

  /**
   * Records which watched page is about to reload, so the page the reload ends on can tell a
   * redirect from a successful reload. Session storage covers redirects within the watched site
   * in this tab; the shared record covers redirects to another site. Runs on the watched page,
   * so its origin and host come from `location`.
   * @param {string} watchUrl
   */
  function writeHandoff(watchUrl) {
    /** @type {Handoff} */
    const handoff = {
      watchUrl,
      watchOrigin: location.origin,
      watchHost: location.hostname,
      fromUrl: currentUrl() ?? watchUrl,
      at: Date.now(),
      nonce: randomNonce(),
    };
    sessionSet(SESSION_HANDOFF_KEY, JSON.stringify(handoff));
    GM_setValue(HANDOFF_KEY, handoff);
  }

  /**
   * Both Chromium and Firefox report a reload that a server redirected as a reload, so a page
   * the user opened any other way can't be where one of the script's reloads ended.
   */
  function loadedByReload() {
    const [entry] = /** @type {PerformanceNavigationTiming[]} */ (
      performance.getEntriesByType('navigation')
    );
    return !entry || entry.type === 'reload';
  }

  /**
   * Whether the previous document in this tab belonged to another site, which is what a reload
   * redirected here from another site looks like. A user's reload of this page has this page
   * as its previous document.
   * @returns {boolean | null} Null where the browser has no Navigation API.
   */
  function arrivedFromAnotherSite() {
    const { navigation } =
      /** @type {Window & { navigation?: { activation?: { from: unknown } | null } }} */ (window);
    if (!navigation?.activation) return null;
    return navigation.activation.from === null;
  }

  /**
   * A record is this page's only if this page's navigation started when the record was written:
   * the script reloads right after writing it. Navigation start is taken from the wall clock now,
   * because `performance.timeOrigin` can drift from `Date.now()` in a long-lived browser process.
   * How long the page then took to load doesn't matter.
   * @param {unknown} value
   * @returns {value is Handoff}
   */
  function isOwnHandoff(value) {
    if (typeof value !== 'object' || value === null) return false;
    const { watchUrl, watchOrigin, watchHost, at, nonce } = /** @type {Partial<Handoff>} */ (value);
    if (
      typeof watchUrl !== 'string' ||
      typeof watchOrigin !== 'string' ||
      typeof watchHost !== 'string' ||
      typeof nonce !== 'string' ||
      typeof at !== 'number'
    )
      return false;
    const navigationStart = Date.now() - performance.now();
    return Math.abs(navigationStart - at) <= HANDOFF_START_SLACK_MS;
  }

  /** @param {string | null | undefined} raw */
  function parseHandoff(raw) {
    try {
      return raw ? /** @type {unknown} */ (JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  }

  /** @type {string | null} The watch whose pending alarm this document shows away from its URL. */
  let awayAlarmUrl = null;

  /**
   * Runs once per document load: finds out whether this page is where one of the script's own
   * reloads ended, clears the handoff record if so, and raises the redirect alarm when the
   * reload ended somewhere other than the watched URL. The full watched URL is only compared as
   * a string here, never parsed, because another site's page can replace `URL`.
   *
   * The session record is written on the watched page, and session storage is kept per site, so
   * a real one always names this site. One that names another site was written by this page.
   * @param {string} url The current normalized URL.
   */
  function claimHandoff(url) {
    if (!loadedByReload()) return;
    const raw = sessionGet(SESSION_HANDOFF_KEY);
    if (raw) {
      sessionSet(SESSION_HANDOFF_KEY, null);
      const local = parseHandoff(raw);
      if (
        isOwnHandoff(local) &&
        local.watchOrigin === location.origin &&
        local.watchUrl.startsWith(location.origin + '/')
      ) {
        const shared = /** @type {Handoff | null} */ (GM_getValue(HANDOFF_KEY, null));
        if (shared?.nonce === local.nonce) GM_deleteValue(HANDOFF_KEY);
        if (local.watchUrl !== url) raiseRedirectAlarm(local, url);
        return;
      }
    }
    const shared = /** @type {unknown} */ (GM_getValue(HANDOFF_KEY, null));
    if (!isOwnHandoff(shared)) return;
    // The tab that reloaded has its own session record on the watched site, so a page of that
    // site without one belongs to another tab, even on the watched URL itself.
    if (raw !== undefined && shared.watchOrigin === location.origin) return;
    if (shared.watchUrl === url) {
      GM_deleteValue(HANDOFF_KEY);
      return;
    }
    const fromAnotherSite = arrivedFromAnotherSite();
    if (fromAnotherSite === false) return;
    if (fromAnotherSite) {
      GM_deleteValue(HANDOFF_KEY);
      raiseRedirectAlarm(shared, url);
      return;
    }
    // Without the Navigation API, a user's reload of this page can't be told apart, so wait for
    // the watched page to clear the record if its reload ended there after all.
    setTimeout(() => {
      const latest = /** @type {Handoff | null} */ (GM_getValue(HANDOFF_KEY, null));
      if (latest?.nonce !== shared.nonce) return;
      GM_deleteValue(HANDOFF_KEY);
      raiseRedirectAlarm(shared, url);
      boot();
    }, HANDOFF_CLAIM_DELAY_MS);
  }

  /**
   * @param {Handoff} handoff
   * @param {string} landedUrl
   */
  function raiseRedirectAlarm({ watchUrl, watchOrigin, watchHost }, landedUrl) {
    const watch = readWatch(watchUrl);
    if (!watch) return;
    if (!watch.pendingAlert) {
      const at = Date.now();
      updateWatch(watchUrl, {
        enabled: false,
        pendingAlert: { kind: 'redirect', at, landedUrl, watchOrigin, watchHost },
      });
    }
    awayAlarmUrl = watchUrl;
  }

  /**
   * Keeps a shown alarm with this tab when it moves to another page. Session storage is only
   * written on the watched site itself, so another site never receives the watched URL.
   * @param {string} watchUrl
   * @param {string | undefined} watchOrigin
   */
  function rememberAlarm(watchUrl, watchOrigin) {
    awayAlarmUrl = watchUrl;
    if (watchOrigin === location.origin && sessionGet(SESSION_ALARM_KEY) !== watchUrl)
      sessionSet(SESSION_ALARM_KEY, watchUrl);
  }

  /** @param {string} watchUrl */
  function forgetAlarm(watchUrl) {
    if (awayAlarmUrl === watchUrl) awayAlarmUrl = null;
    if (sessionGet(SESSION_ALARM_KEY) === watchUrl) sessionSet(SESSION_ALARM_KEY, null);
  }

  /** @returns {Watch | null} A watch with a pending alarm that this tab is showing. */
  function findAwayAlarm() {
    for (const candidate of [awayAlarmUrl, sessionGet(SESSION_ALARM_KEY)]) {
      if (!candidate) continue;
      const watch = readWatch(candidate);
      if (watch?.pendingAlert) return watch;
      forgetAlarm(candidate);
    }
    return null;
  }

  /**
   * Builds a watch from stored or edited fields. Fields a watch doesn't have, such as the
   * notification settings of earlier versions, are dropped.
   * @param {string} url
   * @param {object} fields
   * @returns {Watch}
   */
  function toWatch(url, fields) {
    /** @type {Record<string, unknown>} */
    const watch = { ...DEFAULTS, url };
    for (const [key, value] of Object.entries(fields)) {
      if (Object.hasOwn(watch, key)) watch[key] = value;
    }
    return /** @type {Watch} */ (watch);
  }

  /**
   * @param {string} url
   * @returns {Watch | null}
   */
  function readWatch(url) {
    const stored = /** @type {unknown} */ (GM_getValue(WATCH_PREFIX + url, null));
    return typeof stored === 'object' && stored !== null ? toWatch(url, stored) : null;
  }

  /** @param {Watch} watch */
  function writeWatch(watch) {
    if (/** @type {number} */ (GM_getValue('schema', 0)) !== SCHEMA_VERSION)
      GM_setValue('schema', SCHEMA_VERSION);
    GM_setValue(WATCH_PREFIX + watch.url, toWatch(watch.url, watch));
  }

  /**
   * Applies a change to one watch. It re-reads the watch just before writing, so only the
   * patched fields change and fields another tab changed earlier are kept.
   * @param {string} url
   * @param {Partial<Watch>} patch
   * @returns {boolean} Whether the watch still existed.
   */
  function updateWatch(url, patch) {
    const latest = readWatch(url);
    if (!latest) return false;
    writeWatch({ ...latest, ...patch });
    return true;
  }

  /** @param {string} url */
  function deleteWatch(url) {
    GM_deleteValue(WATCH_PREFIX + url);
  }

  /**
   * Lists one site's watches. Other sites' keys are only compared as strings, never read,
   * parsed or shown, because the page can replace `URL` and can read what the panel shows.
   * @param {string} origin
   * @returns {Watch[]}
   */
  function listWatches(origin) {
    const prefix = WATCH_PREFIX + origin + '/';
    return GM_listValues()
      .filter((key) => key.startsWith(prefix))
      .map((key) => readWatch(key.slice(WATCH_PREFIX.length)))
      .filter((watch) => watch !== null);
  }

  /**
   * @param {Watch} watch
   * @throws {FieldError}
   */
  function validateWatch(watch) {
    if (normalizeUrl(watch.url) !== watch.url)
      throw new FieldError(
        'url',
        'Enter a web address that starts with http:// or https:// and has no user name or password.',
      );
    if (!['appears', 'disappears'].includes(watch.condition))
      throw new FieldError('condition', 'Choose Appears or Disappears.');
    if (
      !Number.isFinite(watch.intervalSeconds) ||
      watch.intervalSeconds < MIN_INTERVAL_SECONDS ||
      watch.intervalSeconds > MAX_SECONDS
    )
      throw new FieldError(
        'intervalSeconds',
        'Use at least ' + MIN_INTERVAL_SECONDS + ' seconds and at most ' + MAX_SECONDS + '.',
      );
    for (const key of /** @type {const} */ (['settleSeconds', 'confirmSeconds'])) {
      if (!Number.isFinite(watch[key]) || watch[key] < 0 || watch[key] > MAX_SECONDS)
        throw new FieldError(key, 'Use a number from 0 to ' + MAX_SECONDS + '.');
    }
    if (!ALERT_STYLES.includes(watch.alertStyle))
      throw new FieldError('alertStyle', 'Choose an alert style.');
    if (typeof watch.text !== 'string') throw new FieldError('text', 'Enter text or leave blank.');
    if (typeof watch.selector !== 'string' || !watch.selector.trim())
      throw new FieldError('selector', 'Enter the element to look for, as a CSS selector.');
    for (const key of /** @type {const} */ (['selector', 'readySelector'])) {
      if (!watch[key]) continue;
      try {
        document.querySelector(watch[key]);
      } catch {
        throw new FieldError(key, 'This isn’t a valid CSS selector. Check it for typing mistakes.');
      }
    }
  }

  /**
   * @param {string} text
   * @param {boolean} matchCase
   */
  function normalizeText(text, matchCase) {
    const result = text.replace(/\s+/g, ' ').trim();
    return matchCase ? result : result.toLowerCase();
  }

  /**
   * @param {Element} element
   * @returns {boolean} Whether the page shows the element. Browsers without the check count it.
   */
  function isShown(element) {
    return (
      typeof element.checkVisibility !== 'function' ||
      element.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true })
    );
  }

  /**
   * @param {Element} element
   * @returns {string} The element's text as the page shows it, without hidden parts or scripts.
   */
  function shownText(element) {
    return (element instanceof HTMLElement ? element.innerText : element.textContent) ?? '';
  }

  /**
   * Looks for the watch's element among those the page shows. With text set, only text the page
   * shows counts, so hidden parts of the page and its scripts never match.
   * @param {Watch} watch
   * @returns {{ found: boolean, satisfied: boolean }}
   */
  function evaluateCondition(watch) {
    const needle = normalizeText(watch.text, watch.matchCase);
    const found = Array.from(document.querySelectorAll(watch.selector)).some(
      (element) =>
        isShown(element) &&
        (!needle || normalizeText(shownText(element), watch.matchCase).includes(needle)),
    );
    return { found, satisfied: watch.condition === 'appears' ? found : !found };
  }

  /**
   * Applies a change to a watch in memory and in storage.
   * @param {Watch} watch
   * @param {Partial<Watch>} patch
   * @returns {boolean} Whether the change reached storage.
   */
  function persistWatch(watch, patch) {
    Object.assign(watch, patch);
    try {
      return updateWatch(watch.url, patch);
    } catch {
      return false;
    }
  }

  /** @param {number} milliseconds */
  function toSeconds(milliseconds) {
    return Math.max(0, Math.ceil(milliseconds / 1000));
  }

  /**
   * @typedef {object} Progress
   * @property {'settling' | 'confirming' | 'waiting' | 'reloading'} phase
   * @property {number} secondsLeft
   * @property {boolean} found
   */

  /** @typedef {'user' | 'invalid' | 'error' | 'storage'} StopReason */

  /**
   * @typedef {object} WatcherReport
   * @property {() => void} onStarted
   * @property {(progress: Progress) => void} onProgress
   * @property {(reason: StopReason, detail?: string) => void} onStopped
   * @property {(persisted: boolean) => void} onTriggered The watch now carries its pending alarm.
   */

  /**
   * The timing loop for a watch on its own page: lets the page settle, checks the condition,
   * confirms it, and reloads. It reports what it does and never touches the widget.
   * @param {Watch} watch
   * @param {WatcherReport} report
   */
  function createWatcher(watch, report) {
    /** @type {ReturnType<typeof setInterval> | undefined} */
    let timer = undefined;
    let startedAt = 0;
    /** @type {number | null} */
    let candidateSince = null;
    /** @type {number | null} */
    let notReadySince = null;

    function stop() {
      clearInterval(timer);
      timer = undefined;
      candidateSince = null;
      notReadySince = null;
    }

    /**
     * @param {PendingAlert['kind']} kind
     * @returns {PendingAlert}
     */
    function alertHere(kind) {
      return {
        kind,
        at: Date.now(),
        landedUrl: watch.url,
        watchOrigin: location.origin,
        watchHost: location.hostname,
      };
    }

    /**
     * @param {StopReason} reason
     * @param {string} [detail]
     */
    function pause(reason, detail) {
      stop();
      persistWatch(
        watch,
        reason === 'user'
          ? { enabled: false, paused: null }
          : {
              paused: {
                reason: /** @type {Pause['reason']} */ (reason),
                detail: detail ?? '',
              },
            },
      );
      report.onStopped(reason, detail);
    }

    function tick() {
      if (timer === undefined) return;
      try {
        if (currentUrl() !== watch.url) {
          followNavigation();
          return;
        }
        const now = performance.now();
        const elapsed = now - startedAt;
        if (elapsed < watch.settleSeconds * 1000) {
          report.onProgress({
            phase: 'settling',
            secondsLeft: toSeconds(watch.settleSeconds * 1000 - elapsed),
            found: false,
          });
          return;
        }
        if (watch.readySelector && !document.querySelector(watch.readySelector)) {
          candidateSince = null;
          notReadySince ??= now;
          const remaining = watch.confirmSeconds * 1000 - (now - notReadySince);
          report.onProgress({
            phase: 'confirming',
            secondsLeft: toSeconds(remaining),
            found: false,
          });
          if (remaining > 0) return;
          stop();
          const persisted = persistWatch(watch, {
            paused: { reason: 'not-ready', detail: '' },
            pendingAlert: alertHere('not-ready'),
          });
          report.onTriggered(persisted);
          return;
        }
        notReadySince = null;
        const { found, satisfied } = evaluateCondition(watch);
        if (satisfied) {
          candidateSince ??= now;
          const remaining = watch.confirmSeconds * 1000 - (now - candidateSince);
          report.onProgress({ phase: 'confirming', secondsLeft: toSeconds(remaining), found });
          if (remaining > 0) return; // Never reload in the middle of confirming a possible match.
          stop();
          const persisted = persistWatch(watch, {
            enabled: false,
            pendingAlert: alertHere('condition'),
          });
          report.onTriggered(persisted);
          return;
        }
        candidateSince = null;
        const remaining = watch.intervalSeconds * 1000 - elapsed;
        report.onProgress({
          phase: remaining > 0 ? 'waiting' : 'reloading',
          secondsLeft: toSeconds(remaining),
          found,
        });
        if (remaining > 0) return;
        stop();
        writeHandoff(watch.url);
        location.reload();
      } catch (error) {
        pause('error', /** @type {Error} */ (error).message);
      }
    }

    return {
      get running() {
        return timer !== undefined;
      },
      /** @param {boolean} byUser Whether the user turned the watch on, as opposed to a page load. */
      start(byUser) {
        stop();
        try {
          validateWatch(watch);
        } catch (error) {
          pause('invalid', /** @type {Error} */ (error).message);
          return;
        }
        if (byUser && !persistWatch(watch, { enabled: true, paused: null })) {
          report.onStopped('storage');
          return;
        }
        startedAt = performance.now();
        timer = setInterval(tick, 250);
        report.onStarted();
        tick();
      },
      stop,
      pause: () => pause('user'),
    };
  }

  /** @type {AudioContext | null} */
  let audio = null;
  const SOUND_BLOCKED = 'Sound may be blocked: allow audio autoplay for this site.';
  const SOUND_RESUME_WAIT_MS = 1000;

  /** @param {AudioContext} context */
  function playAlarmSound(context) {
    for (let repeat = 0; repeat < 3; repeat++) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.connect(gain);
      gain.connect(context.destination);
      const start = context.currentTime + repeat * 0.6;
      oscillator.frequency.setValueAtTime(880, start);
      oscillator.frequency.setValueAtTime(660, start + 0.2);
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(SOUND_VOLUME, start + 0.02);
      gain.gain.setValueAtTime(SOUND_VOLUME, start + 0.4);
      gain.gain.linearRampToValueAtTime(0, start + 0.5);
      oscillator.addEventListener('ended', () => {
        oscillator.disconnect();
        gain.disconnect();
      });
      oscillator.start(start);
      oscillator.stop(start + 0.5);
    }
  }

  /**
   * Plays the alarm sound once. A new audio context can start out suspended even where sound is
   * allowed, so it is resumed first; the sound counts as blocked only if resuming fails or
   * doesn't finish promptly, and a late resume plays nothing, so the sound never comes at a
   * surprising moment.
   * @returns {Promise<string>} What the widget should say about the sound; empty when it played.
   */
  function beep() {
    return new Promise((resolve) => {
      try {
        const AudioContext = /** @type {typeof window.AudioContext} */ (
          window.AudioContext || /** @type {LegacyAudioWindow} */ (window).webkitAudioContext
        );
        const context = (audio ??= new AudioContext());
        if (context.state === 'running') {
          playAlarmSound(context);
          resolve('');
          return;
        }
        let settled = false;
        const timer = setTimeout(() => {
          settled = true;
          resolve(SOUND_BLOCKED);
        }, SOUND_RESUME_WAIT_MS);
        /** @param {boolean} resumed */
        const finish = (resumed) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (resumed && context.state === 'running') {
            playAlarmSound(context);
            resolve('');
          } else resolve(SOUND_BLOCKED);
        };
        context.resume().then(
          () => finish(true),
          () => finish(false),
        );
      } catch (error) {
        resolve('Sound unavailable: ' + /** @type {Error} */ (error).message);
      }
    });
  }

  /**
   * A desktop notification the script can close.
   * @typedef {object} DesktopNotice
   * @property {() => void} close
   */

  /**
   * @typedef {object} AlarmMessage
   * @property {string} title
   * @property {string} text
   * @property {string} tag Names the alarm without its URL, so a later page's notification
   *   replaces one that is still on screen.
   */

  /**
   * The browser's own notifications for this site. Uses the page's standard `Notification`, not
   * `unsafeWindow`, so Firefox can pass arguments across its userscript sandbox.
   * @returns {typeof Notification | null} Null where the page can't show them at all.
   */
  function notificationApi() {
    try {
      return window.isSecureContext && typeof window.Notification === 'function'
        ? window.Notification
        : null;
    } catch {
      return null;
    }
  }

  /** @returns {typeof Notification | null} This site's notifications, if the user allowed them. */
  function siteNotifications() {
    const Native = notificationApi();
    try {
      return Native?.permission === 'granted' ? Native : null;
    } catch {
      return null;
    }
  }

  function focusTab() {
    window.focus();
  }

  /**
   * @param {AlarmMessage} message
   * @param {(problem: string) => void} onProblem
   * @returns {DesktopNotice}
   */
  function notifyThroughManager({ title, text }, onProblem) {
    try {
      const handle = /** @type {VMScriptGMNotificationControl | undefined} */ (
        GM_notification({ title, text, onclick: focusTab })
      );
      return {
        close() {
          try {
            handle?.remove().catch(() => {});
          } catch {
            /* A notification the user already closed needs no cleanup. */
          }
        },
      };
    } catch (error) {
      onProblem(
        'The desktop notification failed: ' +
          /** @type {Error} */ (error).message +
          '. The alarm stays on this page.',
      );
      return { close() {} };
    }
  }

  /**
   * Shows a desktop notification. Where the user allowed this site's notifications, it uses
   * them and asks the browser to keep them on screen until clicked; otherwise, or if they fail,
   * it uses the userscript manager's. Clicking it closes it and asks to bring this tab to the
   * front.
   * @param {AlarmMessage} message
   * @param {{ renotify: boolean, onProblem: (problem: string) => void }} options
   * @returns {DesktopNotice}
   */
  function notifyDesktop(message, { renotify, onProblem }) {
    const Native = siteNotifications();
    if (!Native) return notifyThroughManager(message, onProblem);
    /** @type {NotificationOptions & { renotify?: boolean }} */
    const options = { body: message.text, tag: message.tag, requireInteraction: true };
    if (renotify) options.renotify = true;
    /** @type {Notification} */
    let notification;
    try {
      notification = new Native(message.title, options);
    } catch {
      return notifyThroughManager(message, onProblem);
    }
    /** @type {DesktopNotice | null} */
    let fallback = null;
    const useManager = () => {
      detach();
      fallback ??= notifyThroughManager(message, onProblem);
    };
    function select() {
      focusTab();
      notification.close();
    }
    // Removed explicitly rather than with an AbortSignal, which Firefox may not accept across
    // its userscript sandbox.
    function detach() {
      notification.removeEventListener('click', select);
      notification.removeEventListener('error', useManager);
    }
    notification.addEventListener('click', select);
    notification.addEventListener('error', useManager);
    return {
      close() {
        detach();
        try {
          notification.close();
        } catch {
          /* A notification the user already closed needs no cleanup. */
        }
        fallback?.close();
      },
    };
  }

  /**
   * The alarm this document is sounding. It lives outside the widget so that rebuilding the
   * widget, after Settings closes or the page changes route, neither repeats nor drops it.
   * @typedef {object} ActiveAlarm
   * @property {string} url
   * @property {number} at
   * @property {ReturnType<typeof setTimeout> | undefined} reminder
   * @property {DesktopNotice | undefined} notification
   * @property {string} deliveryProblem
   * @property {string} soundProblem
   * @property {(problem: string) => void} onProblem
   */

  /** @type {ActiveAlarm | null} */
  let activeAlarm = null;
  /** @type {Set<number>} The alarms, by `at`, that this document has already announced. */
  const announced = new Set();

  /**
   * Sounds a watch's pending alarm according to its alert style. Each document that shows the
   * alarm announces it once, because the userscript manager closes a tab's notifications when a
   * new page loads in it. Showing it again in the same document, after Settings closes or a
   * route change, stays quiet. Insistent reminders keep a one-minute schedule counted from when
   * the alarm was raised.
   * @param {Watch} watch
   * @param {Omit<AlarmMessage, 'tag'>} message
   * @param {(problem: string) => void} onProblem Receives what the widget should say about sound
   *   or desktop delivery.
   */
  function soundAlarm(watch, message, onProblem) {
    const alert = watch.pendingAlert;
    if (!alert) return;
    if (activeAlarm?.url === watch.url && activeAlarm.at === alert.at) {
      activeAlarm.onProblem = onProblem;
      reportAlarmProblems(activeAlarm);
      return;
    }
    silenceAlarm();
    /** @type {ActiveAlarm} */
    const alarm = {
      url: watch.url,
      at: alert.at,
      reminder: undefined,
      notification: undefined,
      deliveryProblem: '',
      soundProblem: '',
      onProblem,
    };
    activeAlarm = alarm;
    const insistent = watch.alertStyle === 'insistent';
    const tagged = { ...message, tag: 'reload-until-alarm-' + alert.at };
    function ring() {
      if (watch.alertStyle !== 'page') {
        alarm.notification?.close();
        alarm.deliveryProblem = '';
        alarm.notification = notifyDesktop(tagged, {
          renotify: insistent,
          onProblem(problem) {
            alarm.deliveryProblem = problem;
            reportAlarmProblems(alarm);
          },
        });
      }
      reportAlarmProblems(alarm);
      if (insistent)
        beep().then((problem) => {
          alarm.soundProblem = problem;
          reportAlarmProblems(alarm);
        });
    }
    if (!announced.has(alert.at)) {
      announced.add(alert.at);
      ring();
    }
    if (!insistent) return;
    const remindLater = () => {
      const sinceRaised = Math.max(0, Date.now() - alert.at);
      let wait = REMINDER_INTERVAL_MS - (sinceRaised % REMINDER_INTERVAL_MS);
      if (wait < REMINDER_MIN_WAIT_MS) wait += REMINDER_INTERVAL_MS;
      alarm.reminder = setTimeout(() => {
        if (activeAlarm !== alarm) return;
        ring();
        remindLater();
      }, wait);
    };
    remindLater();
  }

  /** @param {ActiveAlarm} alarm */
  function reportAlarmProblems(alarm) {
    if (activeAlarm !== alarm) return;
    alarm.onProblem([alarm.deliveryProblem, alarm.soundProblem].filter(Boolean).join(' '));
  }

  function silenceAlarm() {
    if (!activeAlarm) return;
    clearTimeout(activeAlarm.reminder);
    activeAlarm.notification?.close();
    activeAlarm = null;
  }

  /**
   * Stops the alarm this document sounds unless the watch shown now still has it pending.
   * @param {Watch | null} shown
   */
  function keepAlarmFor(shown) {
    if (!activeAlarm) return;
    if (shown?.url !== activeAlarm.url || shown.pendingAlert?.at !== activeAlarm.at) silenceAlarm();
  }

  /**
   * Listens only to events the user caused. A page that got hold of one of the script's shadow
   * roots could otherwise press its buttons from its own JavaScript.
   * @param {EventTarget} target
   * @param {string} type
   * @param {(event: Event) => void} handler
   */
  function onUserEvent(target, type, handler) {
    target.addEventListener(type, (event) => {
      if (event.isTrusted) handler(event);
    });
  }

  /**
   * Styles a shadow root with a constructed stylesheet, which a page's Content Security Policy
   * doesn't block the way it blocks `<style>` elements. Browsers without constructed
   * stylesheets get a `<style>` element instead.
   * @param {ShadowRoot} root
   * @param {string} css
   */
  function adoptStyles(root, css) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      root.adoptedStyleSheets = [sheet];
    } catch {
      const style = document.createElement('style');
      style.textContent = css;
      root.prepend(style);
    }
  }

  /** @type {Runner | null} */
  let runner = null;
  /** @type {HTMLElement | null} */
  let editor = null;
  /** @type {string | null} */
  let lastUrl = null;
  let followingNavigation = false;
  /** @type {Set<string>} */
  const listenedUrls = new Set();

  /** @type {string | null} The watch the widget shows, here or away from its URL. */
  let shownUrl = null;

  /**
   * Shows what this tab needs most: this page's own alarm, then an alarm the tab carries from
   * another page, then this page's running watch. A watch waits while another watch's alarm is
   * shown and starts once that alarm is acknowledged.
   */
  function boot() {
    if (runner) runner.destroy();
    runner = null;
    shownUrl = null;
    const url = currentUrl();
    lastUrl = url;
    const watch = url === null ? null : readWatch(url);
    const away = findAwayAlarm();
    if (url !== null && watch) {
      followWatchedPage(url);
      if (watch.pendingAlert || (watch.enabled && !away)) {
        shownUrl = url;
        keepAlarmFor(watch);
        if (!editor) runner = showWidget(watch);
        return;
      }
    }
    keepAlarmFor(away);
    if (!away) return;
    listenTo(away.url);
    shownUrl = away.url;
    if (!editor) runner = showWidget({ ...away, enabled: false });
  }

  /** @param {string} url */
  function listenTo(url) {
    if (listenedUrls.has(url)) return;
    listenedUrls.add(url);
    GM_addValueChangeListener(WATCH_PREFIX + url, (_name, _oldValue, _newValue, remote) => {
      if (remote && (currentUrl() === url || shownUrl === url)) applyRemoteChange(url);
    });
  }

  /**
   * Starts the listeners a watched page needs. Unwatched pages never get here.
   * @param {string} url
   */
  function followWatchedPage(url) {
    listenTo(url);
    if (followingNavigation) return;
    followingNavigation = true;
    window.addEventListener('popstate', followNavigation);
    setInterval(followNavigation, 500);
  }

  /** @param {string} url */
  function applyRemoteChange(url) {
    if (!editor) {
      boot();
      return;
    }
    if (runner) runner.destroy();
    runner = null;
    const watch = readWatch(url);
    keepAlarmFor(watch);
    if (watch?.pendingAlert) runner = showWidget({ ...watch, enabled: false });
  }

  function followNavigation() {
    const url = currentUrl();
    if (url === lastUrl) return;
    lastUrl = url;
    if (!editor) boot();
  }

  /**
   * The settings panel: lists this site's watches and edits one at a time. It reads and writes
   * watches through the storage functions and hands the page back to `boot()` when it closes.
   */
  function openManager() {
    if (editor) return;
    dismissTip();
    const returnFocus = document.activeElement;
    if (runner) runner.suspendRefresh(); // Keep pending alerts active while editing.
    const host = document.createElement('div');
    editor = host;
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;';
    const root = host.attachShadow({ mode: SHADOW_MODE });
    adoptStyles(root, PANEL_CSS);
    const backdrop = document.createElement('div');
    backdrop.className = 'backdrop';
    const panel = document.createElement('section');
    panel.className = 'panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'reload-until-title');
    panel.tabIndex = -1;
    backdrop.append(panel);
    /**
     * @template {keyof HTMLElementTagNameMap} K
     * @param {K} tag
     * @param {string} [text]
     * @param {HTMLElement} [parent]
     * @returns {HTMLElementTagNameMap[K]}
     */
    function add(tag, text, parent = panel) {
      const el = document.createElement(tag);
      if (text !== undefined) el.textContent = text;
      parent.append(el);
      return el;
    }
    add('h2', MENU_COMMAND).id = 'reload-until-title';
    add(
      'p',
      'Only this site’s watches are listed here. While this panel is open, this tab doesn’t reload.',
    );
    const pickWrapper = add('div');
    pickWrapper.className = 'field';
    const pickLabel = add('label', 'Saved watches', pickWrapper);
    pickLabel.htmlFor = 'reload-until-saved-watch';
    const picker = add('select', undefined, pickWrapper);
    picker.id = 'reload-until-saved-watch';
    picker.name = 'savedWatch';
    const fresh = add('option', 'New watch for this page', picker);
    fresh.value = '';
    for (const watch of listWatches(location.origin)) {
      const state = watch.paused ? 'Paused: ' : watch.enabled ? 'On: ' : 'Off: ';
      const option = add('option', state + watch.url, picker);
      option.value = watch.url;
    }
    const form = add('form');
    form.noValidate = true;
    form.addEventListener('submit', (event) => event.preventDefault());
    onUserEvent(form, 'keydown', (event) => {
      const { key, target } = /** @type {KeyboardEvent} */ (event);
      if (key !== 'Enter' || !(target instanceof HTMLInputElement) || target.type === 'checkbox')
        return;
      event.preventDefault();
      saveFromForm();
    });
    /** @type {Record<string, HTMLInputElement>} */
    const fields = {};
    /** @param {string} name */
    function group(name) {
      const section = add('div', undefined, form);
      section.className = 'group';
      section.setAttribute('role', 'group');
      const heading = add('h3', name, section);
      heading.id = 'reload-until-group-' + form.childElementCount;
      section.setAttribute('aria-labelledby', heading.id);
      return section;
    }
    /**
     * @param {string} name
     * @param {string} label
     * @param {string} type
     * @param {string} help
     * @param {HTMLElement} parent
     * @param {string[][] | null} [choices]
     */
    function field(name, label, type, help, parent, choices = null) {
      const wrapper = add('div', undefined, parent);
      wrapper.className = type === 'checkbox' ? 'field check' : 'field';
      const id = 'reload-until-' + name;
      const caption = document.createElement('label');
      caption.htmlFor = id;
      caption.textContent = label;
      const input = /** @type {HTMLInputElement} */ (
        document.createElement(choices ? 'select' : type === 'textarea' ? 'textarea' : 'input')
      );
      input.id = id;
      input.name = name;
      if (!choices && type !== 'textarea') input.type = type;
      if (type === 'checkbox') wrapper.append(input, caption);
      else wrapper.append(caption, input);
      if (choices)
        for (const [value, text] of choices) {
          const opt = add('option', text, input);
          opt.value = value;
        }
      if (type === 'number') {
        input.min = '0';
        input.max = String(MAX_SECONDS);
        input.step = 'any';
        input.required = true;
      }
      if (help) {
        const hint = add('small', help, wrapper);
        hint.id = id + '-help';
        input.setAttribute('aria-describedby', hint.id);
      }
      fields[name] = input;
      return input;
    }

    const what = group('What to watch');
    field(
      'url',
      'Page address',
      'url',
      'The exact address to reload, on this site. Anything after # is ignored.',
      what,
    ).required = true;
    field(
      'selector',
      'Element to look for',
      'text',
      'Enter a CSS selector, such as #price or .sold-out, or “body” for everything the page shows. To find one, right-click the element and select Inspect. In the developer tools, right-click the highlighted line, then select Copy > Copy selector in Chrome or Copy > CSS Selector in Firefox.',
      what,
    ).required = true;
    field(
      'text',
      'Containing text (optional)',
      'textarea',
      'Leave blank to match the element alone. Extra spaces and line breaks don’t matter.',
      what,
    );
    field(
      'matchCase',
      'Match case',
      'checkbox',
      'Treat capital and small letters in the text as different.',
      what,
    );
    field('condition', 'Raise the alarm when the element', 'text', '', what, [
      ['appears', 'Appears'],
      ['disappears', 'Disappears'],
    ]);
    const ready = field(
      'readySelector',
      'Only check when the page has this element (optional)',
      'text',
      'A CSS selector, like the one above. If the page doesn’t have this element, the alarm goes off and says the page may not be the real one, and the watch pauses until you select Resume.',
      what,
    );
    const readyHelp = /** @type {string} */ (ready.getAttribute('aria-describedby'));
    const readyPrompt = add(
      'p',
      'Error pages and sign-in pages also make things disappear, which would raise a false alarm. Enter something that’s always on the real page, such as its main heading.',
      /** @type {HTMLElement} */ (ready.parentElement),
    );
    readyPrompt.className = 'prompt';
    readyPrompt.id = 'reload-until-ready-prompt';
    function showReadyPrompt() {
      const needed = fields.condition.value === 'disappears' && !ready.value.trim();
      readyPrompt.hidden = !needed;
      ready.setAttribute('aria-describedby', needed ? readyHelp + ' ' + readyPrompt.id : readyHelp);
    }
    fields.condition.addEventListener('change', showReadyPrompt);
    ready.addEventListener('input', showReadyPrompt);

    const when = group('When');
    field(
      'enabled',
      'Watch this page',
      'checkbox',
      'While this is on, the page reloads whenever it’s open in a tab, until the alarm goes off.',
      when,
    );
    field(
      'intervalSeconds',
      'Seconds between reloads',
      'number',
      'At least ' + MIN_INTERVAL_SECONDS + '.',
      when,
    ).min = String(MIN_INTERVAL_SECONDS);
    field(
      'settleSeconds',
      'Seconds to wait after the page loads',
      'number',
      'Gives the page time to show its content before the first check.',
      when,
    );
    field(
      'confirmSeconds',
      'Seconds the change must last',
      'number',
      'The alarm goes off only if the change is still there after this long, so a brief flicker doesn’t set it off.',
      when,
    );

    const how = group('How to alert');
    field(
      'alertStyle',
      'Alert style',
      'text',
      'Every alarm stays on the page and in the tab title until you select Acknowledge. Whether desktop notifications stay on screen, how urgent they look, and whether Do Not Disturb hides them depend on your browser and desktop. Insistent reminders and the sound need this tab to stay open, and browsers may block the sound until you have interacted with the page.',
      how,
      [
        ['page', 'On this page only'],
        ['page-and-desktop', 'On this page, plus one desktop notification'],
        ['insistent', 'On this page, plus a desktop notification and a sound every minute'],
      ],
    );
    const permission = add('div', undefined, how);
    permission.className = 'field';
    const permissionStatus = add('small', '', permission);
    permissionStatus.id = 'reload-until-permission-status';
    permissionStatus.setAttribute('aria-live', 'polite');
    const permissionButton = add('button', 'Allow desktop notifications', permission);
    permissionButton.type = 'button';
    permissionButton.setAttribute('aria-describedby', permissionStatus.id);
    function showPermission() {
      const Native = notificationApi();
      const state = Native ? Native.permission : 'unavailable';
      permissionStatus.textContent =
        state === 'granted'
          ? 'Desktop notifications from this site: allowed. Alarms ask the browser to keep them on screen until you select or close them.'
          : state === 'denied'
            ? 'Desktop notifications from this site: blocked. To allow them, change this site’s notification setting in your browser. Until then, alarms use your userscript manager’s notifications, which some browsers hide after a few seconds.'
            : state === 'default'
              ? 'Desktop notifications from this site: not asked yet. Until you allow them, alarms use your userscript manager’s notifications, which some browsers hide after a few seconds.'
              : 'This site can’t show its own desktop notifications, so alarms use your userscript manager’s notifications.';
      permissionButton.disabled = state !== 'default';
    }
    onUserEvent(permissionButton, 'click', () => {
      const Native = notificationApi();
      if (Native?.permission !== 'default') {
        showPermission();
        return;
      }
      permissionButton.disabled = true;
      try {
        Promise.resolve(Native.requestPermission()).then(showPermission, showPermission);
      } catch {
        showPermission();
      }
    });
    showPermission();

    const error = add('div');
    error.className = 'error';
    error.setAttribute('role', 'alert');
    const unsaved = add('div');
    unsaved.className = 'unsaved';
    unsaved.setAttribute('role', 'alert');
    unsaved.hidden = true;
    add('p', 'You have unsaved changes to this watch.', unsaved).id = 'reload-until-unsaved';
    const unsavedActions = add('div', undefined, unsaved);
    unsavedActions.className = 'actions';
    const actions = add('div');
    actions.className = 'actions';
    /**
     * @param {string} label
     * @param {() => void} fn
     * @param {HTMLElement} [parent]
     */
    function action(label, fn, parent = actions) {
      const b = add('button', label, parent);
      b.type = 'button';
      onUserEvent(b, 'click', fn);
      return b;
    }
    const keepButton = action('Keep editing', keepEditing, unsavedActions);
    const discardButton = action('Discard changes', discardEdits, unsavedActions);
    for (const choice of [keepButton, discardButton])
      choice.setAttribute('aria-describedby', 'reload-until-unsaved');
    action('Save watch', saveFromForm);
    const remove = action('Delete watch', () => {
      if (!editingURL) return;
      try {
        if (readWatch(editingURL)?.pendingAlert)
          throw new Error(
            'An alarm for this watch is waiting. Close the settings and select Acknowledge before deleting it.',
          );
        deleteWatch(editingURL);
        close();
      } catch (e) {
        error.textContent = /** @type {Error} */ (e).message;
      }
    });
    action('Close', () => guardEdits(close));
    let editingURL = '';
    let savedForm = '';
    /** @type {(() => void) | null} */
    let afterDiscard = null;
    /** @type {Element | null} */
    let resumeFocus = null;

    function formState() {
      return JSON.stringify(
        Object.values(fields).map((input) =>
          input.type === 'checkbox' ? input.checked : input.value,
        ),
      );
    }
    /**
     * Runs `proceed` right away if the form has no unsaved edits; otherwise asks first.
     * @param {() => void} proceed
     */
    function guardEdits(proceed) {
      if (formState() === savedForm) {
        proceed();
        return;
      }
      afterDiscard = proceed;
      resumeFocus = root.activeElement;
      unsaved.hidden = false;
      keepButton.focus();
    }
    function keepEditing() {
      afterDiscard = null;
      unsaved.hidden = true;
      /** @type {HTMLElement | null} */ (resumeFocus)?.focus();
      resumeFocus = null;
    }
    function discardEdits() {
      const proceed = afterDiscard;
      afterDiscard = null;
      resumeFocus = null;
      unsaved.hidden = true;
      proceed?.();
    }

    /** The panel's controls that keyboard focus can reach, in order. */
    function focusStops() {
      const controls =
        /** @type {NodeListOf<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>} */ (
          panel.querySelectorAll('button, input, select, textarea')
        );
      return Array.from(controls).filter(
        (control) => !control.disabled && control.getClientRects().length > 0,
      );
    }
    onUserEvent(panel, 'keydown', (event) => {
      const { key, shiftKey } = /** @type {KeyboardEvent} */ (event);
      if (key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (unsaved.hidden) guardEdits(close);
        else keepEditing();
        return;
      }
      if (key !== 'Tab') return;
      const stops = focusStops();
      const first = stops[0];
      const last = stops[stops.length - 1];
      if (!first || !last) return;
      const active = root.activeElement;
      const inside = active !== null && active !== panel && panel.contains(active);
      if (shiftKey && (active === first || !inside)) {
        event.preventDefault();
        last.focus();
      } else if (!shiftKey && (active === last || !inside)) {
        event.preventDefault();
        first.focus();
      }
    });
    backdrop.addEventListener('mousedown', (event) => {
      if (event.target === backdrop) event.preventDefault();
    });
    /** @param {FocusEvent} event */
    function holdFocus(event) {
      if (event.target !== host) fields.url.focus();
    }

    function clearFieldErrors() {
      for (const input of Object.values(fields)) {
        input.removeAttribute('aria-invalid');
        input.removeAttribute('aria-errormessage');
      }
      for (const message of root.querySelectorAll('.field-error')) message.remove();
    }
    /** @param {FieldError} problem */
    function showFieldError(problem) {
      const input = fields[problem.field];
      const message = document.createElement('p');
      message.className = 'field-error';
      message.id = input.id + '-error';
      message.textContent = problem.message;
      /** @type {HTMLElement} */ (input.parentElement).append(message);
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-errormessage', message.id);
      input.focus();
    }

    /** @param {string} url */
    function fill(url) {
      editingURL = url;
      clearFieldErrors();
      const saved = url ? readWatch(url) : null;
      const watch = /** @type {Record<string, unknown>} */ ({
        ...DEFAULTS,
        url: currentUrl() ?? '',
        enabled: true,
        ...saved,
      });
      const defaults = /** @type {Record<string, unknown>} */ (DEFAULTS);
      for (const [name, input] of Object.entries(fields)) {
        if (input.type === 'checkbox') input.checked = Boolean(watch[name]);
        else input.value = String(watch[name] ?? defaults[name] ?? '');
      }
      remove.disabled = !url;
      error.textContent = '';
      showReadyPrompt();
      savedForm = formState();
    }
    function saveFromForm() {
      clearFieldErrors();
      error.textContent = '';
      try {
        if (editingURL && readWatch(editingURL)?.pendingAlert)
          throw new Error(
            'An alarm for this watch is waiting. Close the settings and select Acknowledge before editing it.',
          );
        const draft = /** @type {Record<string, unknown>} */ ({ ...DEFAULTS });
        for (const [name, input] of Object.entries(fields)) {
          draft[name] =
            input.type === 'checkbox'
              ? input.checked
              : input.type === 'number'
                ? input.value.trim() === ''
                  ? Number.NaN
                  : Number(input.value)
                : input.value;
        }
        const watch = /** @type {Watch} */ (draft);
        watch.url = normalizeUrl(watch.url.trim()) ?? watch.url;
        watch.selector = watch.selector.trim();
        watch.readySelector = watch.readySelector.trim();
        validateWatch(watch);
        if (!watch.url.startsWith(location.origin + '/'))
          throw new FieldError(
            'url',
            'Enter an address on this site. To watch a page on another site, open that page and add its watch there.',
          );
        if (watch.url !== editingURL && readWatch(watch.url))
          throw new FieldError(
            'url',
            'This address already has a watch. Select it from Saved watches to edit it.',
          );
        watch.pendingAlert = readWatch(watch.url)?.pendingAlert ?? null;
        writeWatch(watch);
        if (editingURL && editingURL !== watch.url) deleteWatch(editingURL);
        close();
      } catch (e) {
        if (e instanceof FieldError) showFieldError(e);
        else error.textContent = 'Couldn’t save: ' + /** @type {Error} */ (e).message;
      }
    }
    function close() {
      document.removeEventListener('focusin', holdFocus, true);
      host.remove();
      editor = null;
      boot();
      if (returnFocus?.isConnected) /** @type {HTMLElement} */ (returnFocus).focus();
      else if (returnFocus) runner?.focus();
    }
    picker.addEventListener('change', () => {
      const chosen = picker.value;
      picker.value = editingURL;
      guardEdits(() => {
        picker.value = chosen;
        fill(chosen);
      });
    });
    const here = currentUrl();
    const initial = here !== null && readWatch(here) ? here : '';
    picker.value = initial;
    fill(initial);
    root.append(backdrop);
    document.documentElement.append(host);
    fields.url.focus();
    document.addEventListener('focusin', holdFocus, true);
  }

  /** @type {HTMLElement | null} */
  let tipHost = null;

  function dismissTip() {
    tipHost?.remove();
    tipHost = null;
  }

  /** Tells someone who just installed the script where its settings are. */
  function showTip() {
    const host = document.createElement('div');
    tipHost = host;
    host.id = 'reload-until-tip';
    host.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483647;max-width:360px;';
    const root = host.attachShadow({ mode: SHADOW_MODE });
    adoptStyles(root, WIDGET_CSS);
    const box = document.createElement('section');
    box.className = 'box';
    box.setAttribute('aria-label', 'Reload Until tip');
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = 'Reload Until is installed';
    const how = document.createElement('p');
    const command = document.createElement('strong');
    command.textContent = MENU_COMMAND;
    how.append(
      'To watch a page, open it, then open your userscript manager’s menu and select ',
      command,
      '.',
    );
    const once = document.createElement('p');
    once.className = 'detail';
    once.textContent = 'This tip shows only once.';
    const actions = document.createElement('div');
    actions.className = 'actions';
    /**
     * @param {string} label
     * @param {() => void} fn
     */
    function button(label, fn) {
      const element = document.createElement('button');
      element.type = 'button';
      element.textContent = label;
      onUserEvent(element, 'click', fn);
      actions.append(element);
    }
    button('Open settings', openManager);
    button('Dismiss', dismissTip);
    box.append(name, how, once, actions);
    root.append(box);
    document.documentElement.append(host);
  }

  function initialize() {
    GM_registerMenuCommand(MENU_COMMAND, openManager);
    const url = currentUrl();
    if (url !== null) claimHandoff(url);
    boot();
    if (url !== null && !GM_getValue(HINT_KEY, false)) {
      GM_setValue(HINT_KEY, true);
      showTip();
    }
  }

  /**
   * The in-page widget for one watch: its status, countdown, controls and alarm. The timing
   * loop and the alarm's sound and notifications live outside it.
   * @param {Watch} watch
   * @returns {Runner}
   */
  function showWidget(watch) {
    const originalTitle = document.title;
    /** @type {string | null} */
    let ownTitle = null;
    const away = currentUrl() !== watch.url;
    const watchedSite = !away || watch.pendingAlert?.watchOrigin === location.origin;
    /** @type {'alarm' | 'test' | null} */
    let showing = null;
    /** @type {DesktopNotice | undefined} */
    let testNotification = undefined;

    // Shadow DOM keeps our notification text out of the watched page text.
    const host = document.createElement('div');
    host.id = 'reload-until';
    host.style.cssText =
      'position:fixed;right:12px;bottom:12px;z-index:2147483647;max-width:360px;';
    const root = host.attachShadow({ mode: SHADOW_MODE });
    adoptStyles(root, WIDGET_CSS);
    const box = document.createElement('section');
    box.className = 'box';
    box.setAttribute('aria-labelledby', 'reload-until-name');
    const head = document.createElement('div');
    head.className = 'head';
    const name = document.createElement('div');
    name.className = 'name';
    name.id = 'reload-until-name';
    name.textContent = 'Reload Until';
    const sizeButton = document.createElement('button');
    sizeButton.type = 'button';
    sizeButton.setAttribute('aria-controls', 'reload-until-body');
    head.append(name, sizeButton);
    const body = document.createElement('div');
    body.className = 'body';
    body.id = 'reload-until-body';
    let collapsed = sessionGet(SESSION_COLLAPSED_KEY) === '1';
    const status = document.createElement('div');
    status.setAttribute('role', 'status');
    const notice = document.createElement('div');
    notice.className = 'notice';
    notice.setAttribute('role', 'alert');
    const detail = document.createElement('div');
    detail.className = 'detail';
    detail.setAttribute('aria-live', 'polite');
    const actions = document.createElement('div');
    actions.className = 'actions';
    /**
     * @param {string} label
     * @param {() => void} action
     */
    function button(label, action) {
      const element = document.createElement('button');
      element.textContent = label;
      element.type = 'button';
      onUserEvent(element, 'click', action);
      actions.append(element);
      return element;
    }
    const toggle = button('Turn on', () => (watcher.running ? watcher.pause() : start(true)));
    /** @type {HTMLButtonElement | null} */
    let testButton = null;
    /** @type {HTMLButtonElement | null} */
    let settingsButton = null;
    if (away) {
      toggle.hidden = true;
      button('Open watched page', () => location.assign(watch.url));
    } else {
      settingsButton = button('Settings', openManager);
      testButton = button('Test alert', showTest);
    }
    const turnOffButton = button('Turn off', () => watcher.pause());
    turnOffButton.hidden = true;
    const acknowledgeButton = button('Acknowledge', acknowledge);
    acknowledgeButton.hidden = true;
    body.append(status, notice, detail, actions);
    box.append(head, body);
    root.append(box);
    document.documentElement.append(host);
    onUserEvent(sizeButton, 'click', () => {
      collapsed = !collapsed;
      sessionSet(SESSION_COLLAPSED_KEY, collapsed ? '1' : null);
      showSize();
    });
    showSize();

    const watcher = createWatcher(watch, {
      onStarted() {
        toggle.textContent = 'Turn off';
        turnOffButton.hidden = true;
        status.textContent = 'Starting watch…';
      },
      onProgress({ phase, secondsLeft, found }) {
        if (phase === 'settling') {
          status.textContent = 'Watching: giving the page time to load…';
          watchedTitle('wait ' + secondsLeft + 's');
        } else if (phase === 'confirming') {
          status.textContent = 'Checking that the change lasts: ' + secondsLeft + 's…';
          watchedTitle('confirm ' + secondsLeft + 's');
        } else {
          status.textContent =
            'Watching: the element is ' +
            (found ? 'on the page' : 'not on the page') +
            '. Next reload in ' +
            secondsLeft +
            's.';
          watchedTitle(phase === 'reloading' ? 'reloading' : secondsLeft + 's');
        }
      },
      onStopped(reason, problem) {
        if (!showing) restoreTitle();
        if (reason === 'user') {
          showOff();
          return;
        }
        if (reason === 'storage') {
          toggle.textContent = 'Turn on';
          turnOffButton.hidden = true;
          status.textContent =
            'Stopped: the script can’t save to its storage, so it can’t keep track of an alarm.';
          return;
        }
        showPaused({ reason, detail: problem ?? '' });
      },
      onTriggered(persisted) {
        if (watch.paused) {
          toggle.textContent = 'Resume';
          status.textContent = stoppedStatus();
        } else {
          toggle.textContent = 'Turn on';
          status.textContent = 'Stopped: the page changed. Select Turn on to watch again.';
        }
        showAlarm();
        if (!persisted)
          notice.textContent += '\nThe alarm couldn’t be saved, so avoid reloading this page.';
      },
    });

    /** @param {string} title */
    function setTitle(title) {
      document.title = title;
      ownTitle = document.title;
    }

    /** Puts the page's title back, unless the page has set its own title since. */
    function restoreTitle() {
      if (ownTitle !== null && document.title === ownTitle) document.title = originalTitle;
      ownTitle = null;
    }

    /** @param {string} countdown */
    function watchedTitle(countdown) {
      if (!showing) setTitle('👁 WATCHING [' + countdown + '] — ' + originalTitle);
    }

    /** What the alarm says. Another site only learns the watched host, never the full URL. */
    function alarmText() {
      const watchHost = watch.pendingAlert?.watchHost || 'another site';
      if (watch.pendingAlert?.kind === 'not-ready')
        return (
          (watchedSite ? 'The page at ' + watch.url : 'A page on ' + watchHost) +
          ' doesn’t have the element you said is always on it, so it may be an error or sign-in page. The watch is paused.'
        );
      if (watch.pendingAlert?.kind === 'redirect')
        return watchedSite
          ? 'Reloading ' + watch.url + ' ended on a different page. You may need to sign in again.'
          : 'Reloading a page on ' +
              watchHost +
              ' ended on this site instead. You may need to sign in again.';
      return (
        'What you’re watching for ' +
        (watch.condition === 'disappears' ? 'disappeared' : 'appeared') +
        ' on ' +
        (watchedSite ? watch.url : 'a page on ' + watchHost) +
        '.'
      );
    }

    /** @returns {Omit<AlarmMessage, 'tag'>} What a desktop notification for this alarm says. */
    function alarmMessage() {
      return {
        title: {
          condition: 'Reload Until: the page changed',
          redirect: 'Reload Until: a reload ended on another page',
          'not-ready': 'Reload Until: the watched page looks different',
        }[watch.pendingAlert?.kind ?? 'condition'],
        text:
          alarmText() +
          ' The alarm stays on the page until you select Acknowledge.' +
          (watch.alertStyle === 'insistent'
            ? ' While this tab stays open, a reminder follows every minute until then.'
            : ''),
      };
    }

    function stoppedStatus() {
      return {
        condition: 'Stopped: the page changed.',
        redirect: 'Stopped: a reload ended on a different page.',
        'not-ready': 'Paused: the page may be an error or sign-in page.',
      }[watch.pendingAlert?.kind ?? 'condition'];
    }

    /** @param {string} text */
    function showNotice(text) {
      notice.textContent = text;
      acknowledgeButton.hidden = false;
      if (testButton) testButton.hidden = true;
      box.classList.add('alarm');
      showSize();
    }

    /** Folds the widget down to its name, except while it shows an alarm. */
    function showSize() {
      const folded = collapsed && !showing;
      box.classList.toggle('collapsed', folded);
      body.hidden = folded;
      sizeButton.hidden = showing !== null;
      sizeButton.textContent = folded ? 'Show' : 'Hide';
      sizeButton.setAttribute('aria-expanded', String(!folded));
    }

    function clearNotice() {
      showing = null;
      notice.textContent = '';
      detail.textContent = '';
      acknowledgeButton.hidden = true;
      if (testButton) testButton.hidden = false;
      box.classList.remove('alarm');
      restoreTitle();
      showSize();
    }

    function showAlarm() {
      const alert = watch.pendingAlert;
      if (!alert) return;
      testNotification?.close();
      testNotification = undefined;
      showing = 'alarm';
      rememberAlarm(watch.url, alert.watchOrigin);
      showNotice('⚠ ' + alarmText() + '\nSelect Acknowledge to dismiss this alarm.');
      setTitle('⚠ ACKNOWLEDGE — ' + originalTitle);
      soundAlarm(watch, alarmMessage(), (problem) => {
        detail.textContent = problem;
      });
    }

    /** Shows what this watch's alarm looks like, without touching the watch. */
    function showTest() {
      if (showing) return;
      showing = 'test';
      showNotice(
        '⚠ Test alert: this is how an alarm shows on this page. Your watch is unchanged.\nSelect Acknowledge to dismiss it.',
      );
      setTitle('⚠ TEST — ' + originalTitle);
      detail.textContent = '';
      /** @param {string} problem */
      const report = (problem) => {
        if (showing === 'test' && problem)
          detail.textContent = [detail.textContent, problem].filter(Boolean).join(' ');
      };
      if (watch.alertStyle !== 'page')
        testNotification = notifyDesktop(
          {
            title: 'Reload Until: test alert',
            text: 'This is how an alarm for this watch reaches your desktop. Your watch is unchanged.',
            tag: 'reload-until-test',
          },
          { renotify: false, onProblem: report },
        );
      if (watch.alertStyle === 'insistent') beep().then(report);
    }

    function acknowledge() {
      if (showing === 'test') {
        testNotification?.close();
        testNotification = undefined;
        clearNotice();
        return;
      }
      if (watch.pendingAlert) {
        const stopped = stoppedStatus();
        try {
          updateWatch(watch.url, { pendingAlert: null });
          watch.pendingAlert = null;
        } catch (error) {
          notice.textContent +=
            '\nCouldn’t save the acknowledgement. Try again: ' +
            /** @type {Error} */ (error).message;
          return;
        }
        forgetAlarm(watch.url);
        if (watch.paused) showPaused(watch.paused);
        else status.textContent = stopped + ' Select Turn on to watch again.';
      }
      silenceAlarm();
      clearNotice();
      if (away) boot();
    }

    /** @param {boolean} byUser Whether the user turned the watch on, as opposed to a page load. */
    function start(byUser) {
      if (currentUrl() !== watch.url) {
        status.textContent = 'To turn this watch on, go back to the page it watches.';
        return;
      }
      if (watch.pendingAlert) {
        status.textContent = 'Select Acknowledge on the alarm before turning this watch on.';
        return;
      }
      watcher.start(byUser);
    }

    function showOff() {
      toggle.textContent = 'Turn on';
      turnOffButton.hidden = true;
      status.textContent =
        'Turned off. It stays off until you select Turn on here or turn it on in Settings.';
    }

    /** @param {Pause} pause */
    function showPaused({ reason, detail: problem }) {
      toggle.textContent = 'Resume';
      turnOffButton.hidden = away;
      status.textContent =
        reason === 'not-ready'
          ? 'Paused: the page doesn’t have the element that shows it loaded, so it may be an error or sign-in page. Check the page and sign in again if needed, then select Resume.'
          : [
              reason === 'invalid'
                ? 'Paused: this watch’s settings need fixing.'
                : 'Paused: something went wrong.',
              problem,
              reason === 'invalid' ? 'Fix them in Settings.' : 'Select Resume to try again.',
            ]
              .filter(Boolean)
              .join(' ');
    }

    if (watch.pendingAlert) {
      if (watch.paused) toggle.textContent = 'Resume';
      status.textContent = stoppedStatus() + ' An alarm is waiting for you to acknowledge it.';
      showAlarm();
    } else if (watch.paused) showPaused(watch.paused);
    else if (watch.enabled) start(false);
    else showOff();
    return {
      suspendRefresh() {
        if (!watcher.running) return;
        watcher.stop();
        toggle.textContent = 'Turn on';
        watchedTitle('settings open');
      },
      destroy() {
        watcher.stop();
        testNotification?.close();
        restoreTitle();
        host.remove();
      },
      focus() {
        (settingsButton && !body.hidden ? settingsButton : sizeButton).focus();
      },
    };
  }
  initialize();
})();
