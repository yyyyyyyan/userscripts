// ==UserScript==
// @name          Reload Until
// @namespace     yyyyyyyan/reload-until
// @version       0.0.0
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
   * @property {'condition' | 'redirect'} kind
   * @property {number} at
   * @property {string} landedUrl
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
   * @property {string} notificationTitle
   * @property {string} notificationText
   * @property {boolean} desktopNotification
   * @property {boolean} sound
   * @property {number} soundRepeatSeconds
   * @property {number} volume
   * @property {boolean} requireExplicitDismissal
   * @property {number} notificationRepeatSeconds
   * @property {string} notificationBackend
   * @property {PendingAlert | null} pendingAlert
   */

  /**
   * Written just before the script reloads a watched page, and cleared by the page the reload
   * ends on.
   * @typedef {object} Handoff
   * @property {string} watchUrl
   * @property {string} fromUrl
   * @property {number} at
   * @property {string} nonce
   */

  /** @typedef {Window & { webkitAudioContext?: typeof AudioContext }} LegacyAudioWindow */

  /**
   * @typedef {object} Runner
   * @property {() => void} suspendRefresh
   * @property {() => void} destroy
   */

  const SHADOW_MODE = 'closed';
  const SCHEMA_VERSION = 1;
  const MIN_INTERVAL_SECONDS = 10;
  const WATCH_PREFIX = 'watch:';
  const HANDOFF_KEY = 'handoff';
  const SESSION_HANDOFF_KEY = 'reload-until:handoff';
  const SESSION_ALARM_KEY = 'reload-until:alarm';
  const HANDOFF_LIFETIME_MS = 20_000;
  const HANDOFF_START_SLACK_MS = 2000;
  const MAX_SECONDS = 86400;
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
    notificationTitle: 'Reload Until — condition met!',
    notificationText: 'The watched condition is met. Check the page now.',
    desktopNotification: true,
    sound: true,
    soundRepeatSeconds: 4,
    volume: 0.25,
    requireExplicitDismissal: true,
    notificationRepeatSeconds: 30,
    notificationBackend: 'auto',
    pendingAlert: null,
  };

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
   * @param {string} a
   * @param {string} b
   */
  function sameOrigin(a, b) {
    return new URL(a).origin === new URL(b).origin;
  }

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
   * in this tab; the shared record covers redirects to another site.
   * @param {string} watchUrl
   */
  function writeHandoff(watchUrl) {
    /** @type {Handoff} */
    const handoff = {
      watchUrl,
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
   * A record is this page's only if it is recent and this page's navigation started when the
   * record was written. Navigation start is taken from the wall clock now, because
   * `performance.timeOrigin` can drift from `Date.now()` in a long-lived browser process.
   * @param {unknown} value
   * @returns {value is Handoff}
   */
  function isOwnHandoff(value) {
    if (typeof value !== 'object' || value === null) return false;
    const { watchUrl, at, nonce } = /** @type {Partial<Handoff>} */ (value);
    if (typeof watchUrl !== 'string' || typeof nonce !== 'string' || typeof at !== 'number')
      return false;
    const now = Date.now();
    const navigationStart = now - performance.now();
    return (
      now - at < HANDOFF_LIFETIME_MS && Math.abs(navigationStart - at) <= HANDOFF_START_SLACK_MS
    );
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
   * reload ended somewhere other than the watched URL.
   * @param {string} url The current normalized URL.
   */
  function claimHandoff(url) {
    if (!loadedByReload()) return;
    const raw = sessionGet(SESSION_HANDOFF_KEY);
    if (raw) {
      sessionSet(SESSION_HANDOFF_KEY, null);
      const local = parseHandoff(raw);
      if (isOwnHandoff(local)) {
        const shared = /** @type {Handoff | null} */ (GM_getValue(HANDOFF_KEY, null));
        if (shared?.nonce === local.nonce) GM_deleteValue(HANDOFF_KEY);
        if (local.watchUrl !== url) raiseRedirectAlarm(local.watchUrl, url);
        return;
      }
    }
    const shared = /** @type {unknown} */ (GM_getValue(HANDOFF_KEY, null));
    if (!isOwnHandoff(shared)) return;
    if (shared.watchUrl === url) {
      GM_deleteValue(HANDOFF_KEY);
      return;
    }
    // A redirect within the watched site would have left this tab's own session record, so a
    // same-site page without one belongs to another tab.
    if (raw !== undefined && sameOrigin(shared.watchUrl, url)) return;
    GM_deleteValue(HANDOFF_KEY);
    raiseRedirectAlarm(shared.watchUrl, url);
  }

  /**
   * @param {string} watchUrl
   * @param {string} landedUrl
   */
  function raiseRedirectAlarm(watchUrl, landedUrl) {
    const watch = readWatch(watchUrl);
    if (!watch) return;
    if (!watch.pendingAlert)
      updateWatch(watchUrl, {
        enabled: false,
        pendingAlert: { kind: 'redirect', at: Date.now(), landedUrl },
      });
    awayAlarmUrl = watchUrl;
  }

  /**
   * Keeps a shown alarm with this tab when it moves to another page. Session storage is only
   * written on the watched site itself, so another site never receives the watched URL.
   * @param {string} watchUrl
   */
  function rememberAlarm(watchUrl) {
    awayAlarmUrl = watchUrl;
    if (sameOrigin(watchUrl, location.href) && sessionGet(SESSION_ALARM_KEY) !== watchUrl)
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
   * @param {string} url
   * @returns {Watch | null}
   */
  function readWatch(url) {
    const stored = /** @type {Watch | null} */ (GM_getValue(WATCH_PREFIX + url, null));
    return stored && { ...DEFAULTS, ...stored };
  }

  /** @param {Watch} watch */
  function writeWatch(watch) {
    if (/** @type {number} */ (GM_getValue('schema', 0)) !== SCHEMA_VERSION)
      GM_setValue('schema', SCHEMA_VERSION);
    GM_setValue(WATCH_PREFIX + watch.url, watch);
  }

  /**
   * Applies a change to the freshest stored copy of one watch, so a tab never writes back
   * fields it read before another tab changed them.
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

  /** @returns {Watch[]} */
  function listWatches() {
    return GM_listValues()
      .filter((key) => key.startsWith(WATCH_PREFIX))
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
    for (const key of /** @type {const} */ (['soundRepeatSeconds', 'notificationRepeatSeconds'])) {
      if (!Number.isFinite(watch[key]) || watch[key] < 1 || watch[key] > MAX_SECONDS)
        throw new FieldError(key, 'Use a number from 1 to ' + MAX_SECONDS + '.');
    }
    for (const key of /** @type {const} */ (['settleSeconds', 'confirmSeconds'])) {
      if (!Number.isFinite(watch[key]) || watch[key] < 0 || watch[key] > MAX_SECONDS)
        throw new FieldError(key, 'Use a number from 0 to ' + MAX_SECONDS + '.');
    }
    if (!['auto', 'manager'].includes(watch.notificationBackend))
      throw new FieldError('notificationBackend', 'Choose a notification method.');
    if (!Number.isFinite(watch.volume) || watch.volume < 0 || watch.volume > 1)
      throw new FieldError('volume', 'Use a volume from 0 to 1.');
    if (typeof watch.text !== 'string') throw new FieldError('text', 'Enter text or leave blank.');
    if (typeof watch.selector !== 'string' || !watch.selector.trim())
      throw new FieldError('selector', 'Enter a CSS selector.');
    for (const key of /** @type {const} */ (['selector', 'readySelector'])) {
      if (!watch[key]) continue;
      try {
        document.querySelector(watch[key]);
      } catch {
        throw new FieldError(key, 'This CSS selector is not valid.');
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
   * @param {Watch} watch
   * @returns {{ found: boolean, satisfied: boolean }}
   */
  function evaluateCondition(watch) {
    const needle = normalizeText(watch.text, watch.matchCase);
    const found = Array.from(document.querySelectorAll(watch.selector)).some(
      (element) =>
        !needle || normalizeText(element.textContent || '', watch.matchCase).includes(needle),
    );
    return { found, satisfied: watch.condition === 'appears' ? found : !found };
  }

  // Use the standard DOM API, not unsafeWindow, so Firefox can wrap arguments
  // normally across its userscript sandbox.
  function nativeAPI() {
    try {
      return window.isSecureContext !== false && typeof window.Notification === 'function'
        ? window.Notification
        : null;
    } catch {
      return null;
    }
  }
  function nativePermission() {
    try {
      return nativeAPI()?.permission || 'unavailable';
    } catch {
      return 'unavailable';
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

  function boot() {
    if (runner) runner.destroy();
    runner = null;
    shownUrl = null;
    const url = currentUrl();
    lastUrl = url;
    const watch = url === null ? null : readWatch(url);
    if (url !== null && watch) {
      followWatchedPage(url);
      shownUrl = url;
      if (!editor) runner = runWatch(watch);
      return;
    }
    const away = findAwayAlarm();
    if (!away) return;
    listenTo(away.url);
    shownUrl = away.url;
    if (!editor) runner = runWatch({ ...away, enabled: false });
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
    if (watch?.pendingAlert) runner = runWatch({ ...watch, enabled: false });
  }

  function followNavigation() {
    const url = currentUrl();
    if (url === lastUrl) return;
    lastUrl = url;
    if (!editor) boot();
  }

  function openManager() {
    if (editor) return;
    if (runner) runner.suspendRefresh(); // Keep pending alerts active while editing.
    const host = document.createElement('div');
    editor = host;
    host.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;background:#0009;display:grid;place-items:center;padding:12px;';
    const root = host.attachShadow({ mode: SHADOW_MODE });
    const style = document.createElement('style');
    style.textContent = `
      *{box-sizing:border-box} .panel{width:min(650px,94vw);max-height:90vh;overflow:auto;background:#17202a;color:#fff;border:1px solid #777;border-radius:12px;padding:20px;font:14px/1.5 system-ui,sans-serif;box-shadow:0 12px 50px #0009}
      h2{margin:0 0 8px;font-size:22px}p{margin:6px 0 14px;color:#d1d5db}label{display:block}.field{margin:12px 0 0}.check{display:flex;flex-wrap:wrap;align-items:center;gap:8px}.check small{flex-basis:100%}input:not([type=checkbox]),select,textarea{display:block;width:100%;margin-top:4px;padding:8px;color:#111;background:#fff;border:1px solid #aaa;border-radius:5px;font:inherit}input[type=checkbox]{margin:0}[aria-invalid=true]{border-color:#ff5252;outline:2px solid #ff5252}small{display:block;color:#bfc8d2}.field-error{flex-basis:100%;margin:4px 0 0;color:#ffb4b4}button{font:inherit;padding:7px 12px;border:1px solid #aaa;border-radius:5px;background:#fff;color:#111;cursor:pointer}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:18px}.error{color:#ffb4b4;white-space:pre-wrap;margin-top:12px}details{margin-top:16px}summary{cursor:pointer;font-weight:600}
    `;
    const panel = document.createElement('section');
    panel.className = 'panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Manage Reload Until settings');
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
    add('h2', 'Reload Until settings');
    add(
      'p',
      'Save one watch per URL. Refreshing is suspended in this tab while this panel is open.',
    );
    const pickWrapper = add('div');
    pickWrapper.className = 'field';
    const pickLabel = add('label', 'Saved watches', pickWrapper);
    pickLabel.htmlFor = 'reload-until-saved-watch';
    const picker = add('select', undefined, pickWrapper);
    picker.id = 'reload-until-saved-watch';
    picker.name = 'savedWatch';
    const fresh = add('option', '＋ New watch for this page', picker);
    fresh.value = '';
    for (const watch of listWatches()) {
      const option = add('option', (watch.enabled ? 'ON — ' : 'OFF — ') + watch.url, picker);
      option.value = watch.url;
    }
    const form = add('form');
    form.noValidate = true;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      saveFromForm();
    });
    /** @type {Record<string, HTMLInputElement>} */
    const fields = {};
    /**
     * @param {string} name
     * @param {string} label
     * @param {string} [type]
     * @param {string} [help]
     * @param {HTMLElement} [parent]
     * @param {string[][] | null} [choices]
     */
    function field(name, label, type = 'text', help = '', parent = form, choices = null) {
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
    field(
      'url',
      'Page URL',
      'url',
      'Exact URL, including query parameters. The #fragment is ignored.',
    ).required = true;
    field('enabled', 'Enabled — refresh this URL when it is open', 'checkbox');
    field('intervalSeconds', 'Refresh interval (seconds)', 'number').min =
      String(MIN_INTERVAL_SECONDS);
    field('condition', 'Stop and notify when the target is…', 'text', '', form, [
      ['appears', 'Appears'],
      ['disappears', 'Disappears'],
    ]);
    field(
      'selector',
      'CSS selector',
      'text',
      'Example: .alert.alert-error. Use body to search the whole page.',
    ).required = true;
    field(
      'text',
      'Containing text (optional)',
      'textarea',
      'Leave blank to match the selector alone. Extra whitespace is ignored.',
    );
    const advanced = add('details', undefined, form);
    add('summary', 'Timing, safeguards and notification settings', advanced);
    field('matchCase', 'Match case', 'checkbox', '', advanced);
    field('settleSeconds', 'Initial rendering wait (seconds)', 'number', '', advanced);
    field('confirmSeconds', 'Condition confirmation time (seconds)', 'number', '', advanced);
    field(
      'readySelector',
      'Page-ready CSS selector (optional)',
      'text',
      'If missing, the watch pauses. Without this guard, an error or login page can make the target disappear.',
      advanced,
    );
    field('notificationTitle', 'Notification title', 'text', '', advanced);
    field('notificationText', 'Notification message', 'textarea', '', advanced);
    field(
      'requireExplicitDismissal',
      'Require explicit dismissal (persistent alert)',
      'checkbox',
      'Repeat desktop notifications until you click Acknowledge. A pending alert returns after reload. Requests native persistence; OS urgency depends on the browser and desktop.',
      advanced,
    );
    field(
      'notificationRepeatSeconds',
      'Repeat desktop notification every (seconds)',
      'number',
      'Used only for persistent alerts while this page is open. The OS may group or suppress repeated notifications.',
      advanced,
    ).min = '1';
    field('desktopNotification', 'Desktop notification', 'checkbox', '', advanced);
    field('notificationBackend', 'Notification method', 'text', '', advanced, [
      ['auto', 'Native browser notification + automatic fallback'],
      ['manager', 'Userscript manager only'],
    ]);
    const permissionStatus = add('small', '', advanced);
    const permissionButton = add('button', 'Allow native notifications', advanced);
    permissionButton.type = 'button';
    function editingThisSite() {
      try {
        return new URL(fields.url.value).origin === new URL(location.href).origin;
      } catch {
        return false;
      }
    }
    function showPermission() {
      const permission = nativePermission();
      permissionStatus.textContent = !editingThisSite()
        ? 'Open the watch’s site to grant native notification permission there.'
        : permission === 'granted'
          ? 'Native notification permission granted for this site. Use Test alert after saving.'
          : permission === 'denied'
            ? 'Native notifications are blocked. Change this site’s browser permissions, then reopen Settings. Your userscript manager’s notification remains available.'
            : permission === 'unavailable'
              ? 'Native notifications are unavailable here. Your userscript manager’s notification will be used.'
              : 'Click Allow native notifications for this site. Until allowed, your userscript manager’s notification will be used.';
      permissionButton.disabled = !editingThisSite() || permission !== 'default';
    }
    permissionButton.addEventListener('click', () => {
      if (!editingThisSite() || nativePermission() !== 'default') {
        showPermission();
        return;
      }
      // Call immediately inside the real click handler (required by Firefox).
      try {
        permissionButton.disabled = true;
        /** @type {typeof Notification} */ (nativeAPI())
          .requestPermission()
          .then(showPermission, () => {
            showPermission();
            permissionStatus.textContent +=
              ' Permission request failed; use browser site permissions.';
          });
      } catch {
        showPermission();
        permissionStatus.textContent += ' Permission request failed; use browser site permissions.';
      }
    });
    fields.url.addEventListener('input', showPermission);
    field('sound', 'Repeat an audible alarm until acknowledged', 'checkbox', '', advanced);
    field('soundRepeatSeconds', 'Alarm repeat interval (seconds)', 'number', '', advanced).min =
      '1';
    const volume = field('volume', 'Volume (0–1)', 'number', '', advanced);
    volume.max = '1';
    volume.step = '0.05';
    add(
      'p',
      'Allow audio autoplay for the site. Chromium/Linux may display persistent native notifications as critical; Firefox can keep normal urgency. Reminders and the page alert continue until Acknowledge; Do Not Disturb remains desktop-controlled.',
      advanced,
    );
    const error = add('div');
    error.className = 'error';
    error.setAttribute('role', 'alert');
    const actions = add('div');
    actions.className = 'actions';
    /**
     * @param {string} label
     * @param {() => void} fn
     */
    function action(label, fn) {
      const b = add('button', label, actions);
      b.type = 'button';
      b.addEventListener('click', fn);
      return b;
    }
    action('Save watch', saveFromForm);
    const remove = action('Delete watch', () => {
      if (!editingURL) return;
      try {
        if (readWatch(editingURL)?.pendingAlert)
          throw new Error(
            'Close settings and Acknowledge the active alert before deleting this watch.',
          );
        deleteWatch(editingURL);
        close();
      } catch (e) {
        error.textContent = /** @type {Error} */ (e).message;
      }
    });
    action('Close', close);
    let editingURL = '';

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
      const section = input.closest('details');
      if (section) section.open = true;
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
        ...saved,
      });
      const defaults = /** @type {Record<string, unknown>} */ (DEFAULTS);
      for (const [name, input] of Object.entries(fields)) {
        if (input.type === 'checkbox') input.checked = Boolean(watch[name]);
        else input.value = String(watch[name] ?? defaults[name] ?? '');
      }
      showPermission();
      remove.disabled = !url;
      error.textContent = '';
    }
    function saveFromForm() {
      clearFieldErrors();
      error.textContent = '';
      try {
        if (editingURL && readWatch(editingURL)?.pendingAlert)
          throw new Error(
            'Close settings and Acknowledge the active alert before editing this watch.',
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
        if (watch.url !== editingURL && readWatch(watch.url))
          throw new FieldError(
            'url',
            'A watch already exists for this URL. Select it from Saved watches to edit it.',
          );
        watch.pendingAlert = readWatch(watch.url)?.pendingAlert ?? null;
        writeWatch(watch);
        if (editingURL && editingURL !== watch.url) deleteWatch(editingURL);
        close();
      } catch (e) {
        if (e instanceof FieldError) showFieldError(e);
        else error.textContent = 'Could not save: ' + /** @type {Error} */ (e).message;
      }
    }
    function close() {
      host.remove();
      editor = null;
      boot();
    }
    picker.addEventListener('change', () => fill(picker.value));
    const here = currentUrl();
    const initial = here !== null && readWatch(here) ? here : '';
    picker.value = initial;
    fill(initial);
    root.append(style, panel);
    document.documentElement.append(host);
    fields.url.focus();
  }

  function initialize() {
    GM_registerMenuCommand('Reload Until: Manage watches', openManager);
    const url = currentUrl();
    if (url !== null) claimHandoff(url);
    boot();
  }

  /**
   * @param {Watch} CONFIG
   * @returns {Runner}
   */
  function runWatch(CONFIG) {
    const originalTitle = document.title;
    /** @type {string | null} */
    let ownTitle = null;
    const away = currentUrl() !== CONFIG.url;
    const watchedSite = sameOrigin(CONFIG.url, location.href);
    let running = false;
    /** @type {ReturnType<typeof setInterval> | undefined} */
    let timer = undefined;
    let startedAt = 0;
    /** @type {number | null} */
    let candidateSince = null;
    /** @type {ReturnType<typeof setInterval> | undefined} */
    let alarmTimer = undefined;
    /** @type {ReturnType<typeof setInterval> | undefined} */
    let notificationTimer = undefined;
    /** @type {{ notification: Notification; listeners: AbortController } | null} */
    let nativeNotification = null;
    let notificationGeneration = 0;
    let nativeFailed = false;
    let alarmActive = false;
    /** @type {AudioContext | null} */
    let audio = null;

    // Shadow DOM keeps our notification text out of the watched page text.
    const host = document.createElement('div');
    host.id = 'reload-until';
    host.style.cssText =
      'position:fixed;right:12px;bottom:12px;z-index:2147483647;max-width:360px;';
    const root = host.attachShadow({ mode: SHADOW_MODE });
    const box = document.createElement('section');
    box.style.cssText =
      'background:#17202a;color:#fff;border:2px solid #7f8c8d;border-radius:10px;padding:14px;font:14px/1.4 system-ui,sans-serif;box-shadow:0 3px 18px #0006;';
    const status = document.createElement('div');
    status.setAttribute('role', 'status');
    const notice = document.createElement('div');
    notice.setAttribute('role', 'alert');
    notice.style.cssText = 'margin-top:6px;white-space:pre-wrap;';
    const detailStyle = 'font-size:12px;color:#d1d5db;margin-top:6px;';
    const soundStatus = document.createElement('div');
    soundStatus.style.cssText = detailStyle;
    soundStatus.setAttribute('aria-live', 'polite');
    const deliveryStatus = document.createElement('div');
    deliveryStatus.style.cssText = detailStyle;
    deliveryStatus.setAttribute('aria-live', 'polite');
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;';
    /**
     * @param {string} label
     * @param {() => void} action
     */
    function button(label, action) {
      const element = document.createElement('button');
      element.textContent = label;
      element.type = 'button';
      element.style.cssText =
        'font:inherit;color:#111;background:#fff;border:1px solid #aaa;border-radius:5px;padding:5px 9px;cursor:pointer;';
      element.addEventListener('click', action);
      actions.append(element);
      return element;
    }
    const toggle = button('Enable', () => (running ? pause('Paused') : start(true)));
    if (away) {
      toggle.hidden = true;
      button('Open watched page', () => location.assign(CONFIG.url));
    } else {
      button('Settings', openManager);
      button('Test alert', () => alertUser(!CONFIG.pendingAlert));
    }
    const acknowledgeButton = button('Acknowledge', acknowledgeAlert);
    acknowledgeButton.hidden = true;
    box.append(status, notice, soundStatus, deliveryStatus, actions);
    root.append(box);
    document.documentElement.append(host);

    /**
     * @param {Partial<Watch>} patch
     * @returns {boolean} Whether the change reached storage.
     */
    function persist(patch) {
      Object.assign(CONFIG, patch);
      try {
        return updateWatch(CONFIG.url, patch);
      } catch {
        status.textContent =
          'Paused: browser storage is unavailable; cannot safely retain stop state.';
        return false;
      }
    }

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

    function stopTimers() {
      running = false;
      clearInterval(timer);
      timer = undefined;
      candidateSince = null;
      toggle.textContent = 'Enable';
      if (!alarmActive) restoreTitle();
    }

    /** @param {string} countdown */
    function watchedTitle(countdown) {
      if (!alarmActive) setTitle('👁 WATCHING [' + countdown + '] — ' + originalTitle);
    }

    /** What the alarm says. Another site only learns the watched host, never the full URL. */
    function alarmText() {
      if (CONFIG.pendingAlert?.kind !== 'redirect') return CONFIG.notificationText;
      return watchedSite
        ? 'Reloading ' + CONFIG.url + ' ended on a different page. You may need to sign in again.'
        : 'Reloading a page on ' +
            new URL(CONFIG.url).hostname +
            ' ended on this site instead. You may need to sign in again.';
    }

    function stoppedStatus() {
      return CONFIG.pendingAlert?.kind === 'redirect'
        ? 'Stopped: a reload ended on a different page.'
        : 'Stopped: condition met.';
    }

    /** @param {string} message */
    function pause(message) {
      stopTimers();
      silence();
      status.textContent = message;
      persist({ enabled: false });
    }

    function tick() {
      if (!running) return;
      try {
        if (currentUrl() !== CONFIG.url) {
          followNavigation();
          return;
        }
        const now = performance.now();
        const elapsed = now - startedAt;
        if (elapsed < CONFIG.settleSeconds * 1000) {
          status.textContent = 'Watching: waiting for the page to settle…';
          watchedTitle('wait ' + Math.ceil((CONFIG.settleSeconds * 1000 - elapsed) / 1000) + 's');
          return;
        }
        if (CONFIG.readySelector && !document.querySelector(CONFIG.readySelector)) {
          pause('Paused: page is not ready. Check login/loading, then Enable.');
          return;
        }
        const { found, satisfied } = evaluateCondition(CONFIG);
        if (satisfied) {
          candidateSince ??= now;
          const remaining = CONFIG.confirmSeconds * 1000 - (now - candidateSince);
          status.textContent =
            'Confirming condition: ' + Math.max(0, Math.ceil(remaining / 1000)) + 's…';
          watchedTitle('confirm ' + Math.max(0, Math.ceil(remaining / 1000)) + 's');
          if (remaining <= 0) {
            stopTimers(); // Stop first, even if notifications fail.
            status.textContent = 'Stopped: condition met. Enable to watch again.';
            const persisted = persist({
              enabled: false,
              pendingAlert: CONFIG.requireExplicitDismissal
                ? { kind: 'condition', at: Date.now(), landedUrl: CONFIG.url }
                : null,
            });
            alertUser(false);
            if (!persisted)
              notice.textContent += '\nStop state could not be saved; avoid manually reloading.';
          }
          return; // Never reload in the middle of confirming a possible match.
        }
        candidateSince = null;
        const remaining = CONFIG.intervalSeconds * 1000 - elapsed;
        status.textContent =
          'Watching: target ' +
          (found ? 'found' : 'not found') +
          '. Reload in ' +
          Math.max(0, Math.ceil(remaining / 1000)) +
          's.';
        watchedTitle(Math.max(0, Math.ceil(remaining / 1000)) + 's');
        if (remaining <= 0) {
          stopTimers();
          watchedTitle('reloading');
          writeHandoff(CONFIG.url);
          location.reload();
        }
      } catch (error) {
        pause('Paused: configuration/page error — ' + /** @type {Error} */ (error).message);
      }
    }

    /** @param {boolean} byUser Whether the user turned the watch on, as opposed to a page load. */
    function start(byUser) {
      if (currentUrl() !== CONFIG.url) {
        status.textContent = 'Stopped: return to the watched URL before enabling this watch.';
        return;
      }
      if (CONFIG.pendingAlert) {
        status.textContent = 'Stopped: Acknowledge the pending alert before enabling this watch.';
        return;
      }
      stopTimers();
      silence();
      try {
        validateWatch(CONFIG);
      } catch (error) {
        pause('Paused: invalid configuration — ' + /** @type {Error} */ (error).message);
        return;
      }
      if (byUser && !persist({ enabled: true })) return;
      running = true;
      toggle.textContent = 'Disable';
      startedAt = performance.now();
      candidateSince = null;
      status.textContent = 'Starting watch…';
      timer = setInterval(tick, 250);
      tick();
    }

    function beep() {
      if (!CONFIG.sound || !alarmActive) return;
      try {
        const AudioContext = /** @type {typeof window.AudioContext} */ (
          window.AudioContext || /** @type {LegacyAudioWindow} */ (window).webkitAudioContext
        );
        audio ??= new AudioContext();
        if (audio.state !== 'running') {
          audio.resume().catch(() => {});
          soundStatus.textContent = 'Sound may be blocked: allow audio autoplay for this site.';
          return;
        }
        soundStatus.textContent = '';
        const oscillator = audio.createOscillator();
        const gain = audio.createGain();
        oscillator.connect(gain);
        gain.connect(audio.destination);
        const now = audio.currentTime;
        oscillator.frequency.setValueAtTime(880, now);
        oscillator.frequency.setValueAtTime(660, now + 0.2);
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(CONFIG.volume, now + 0.02);
        gain.gain.setValueAtTime(CONFIG.volume, now + 0.4);
        gain.gain.linearRampToValueAtTime(0, now + 0.5);
        oscillator.addEventListener('ended', () => {
          oscillator.disconnect();
          gain.disconnect();
        });
        oscillator.start(now);
        oscillator.stop(now + 0.5);
      } catch (error) {
        soundStatus.textContent = 'Sound unavailable: ' + /** @type {Error} */ (error).message;
      }
    }

    let alarmMessage = '';
    /** @param {boolean} test */
    function alertUser(test) {
      silence();
      alarmActive = true;
      const persistent = Boolean(CONFIG.pendingAlert) || CONFIG.requireExplicitDismissal;
      if (!test && CONFIG.pendingAlert) rememberAlarm(CONFIG.url);
      const title = test
        ? 'Reload Until — TEST'
        : CONFIG.pendingAlert?.kind === 'redirect'
          ? 'Reload Until — reload ended on another page'
          : CONFIG.notificationTitle;
      alarmMessage = test ? 'Test alert — monitoring state is unchanged.' : alarmText();
      notice.textContent =
        '⚠ ' + alarmMessage + (persistent ? '\nClick Acknowledge to dismiss this alert.' : '');
      acknowledgeButton.hidden = false;
      box.style.borderColor = '#ff5252';
      setTitle(
        '⚠ ' + (persistent ? 'ACKNOWLEDGE' : test ? 'TEST' : 'CHECK PAGE') + ' — ' + originalTitle,
      );
      nativeFailed = false;
      function notifyDesktop() {
        if (!alarmActive || !CONFIG.desktopNotification) return;
        const generation = ++notificationGeneration;
        const text = alarmMessage + (persistent ? ' — Open the page and click Acknowledge.' : '');
        const tag = 'reload-until-' + (watchedSite ? CONFIG.url : new URL(CONFIG.url).hostname);
        const click = () => {
          if (!alarmActive || generation !== notificationGeneration) return;
          window.focus();
          // Native close events may be timeouts or replacements: never acknowledge them.
          if (!persistent) acknowledgeAlert();
        };
        /** @param {string} reason */
        function fallback(reason) {
          if (!alarmActive || generation !== notificationGeneration) return;
          deliveryStatus.textContent = reason + ' Using your userscript manager’s notification.';
          try {
            /** @type {VMScriptGMNotificationOptions & { highlight: boolean; timeout: number }} */
            const options = {
              title,
              text,
              tag,
              highlight: true,
              silent: false,
              timeout: persistent ? 0 : 10000,
              onclick: click,
            };
            GM_notification(options);
          } catch (error) {
            deliveryStatus.textContent =
              'Desktop delivery failed: ' +
              /** @type {Error} */ (error).message +
              '. The page alert remains active.';
          }
        }
        if (CONFIG.notificationBackend === 'manager') {
          fallback('');
          return;
        }
        const Native = nativeAPI();
        if (!Native || nativePermission() !== 'granted' || nativeFailed) {
          fallback(
            nativeFailed
              ? 'Native delivery failed.'
              : 'Native notifications are not available or allowed.',
          );
          return;
        }
        try {
          closeNativeNotification();
          /** @type {NotificationOptions & { renotify: boolean }} */
          const options = {
            body: text,
            tag,
            requireInteraction: persistent,
            renotify: persistent,
            silent: false,
          };
          const notification = new Native(title, options);
          const listeners = new AbortController();
          nativeNotification = { notification, listeners };
          notification.addEventListener('click', click, { signal: listeners.signal });
          notification.addEventListener(
            'error',
            () => {
              if (!alarmActive || generation !== notificationGeneration || nativeFailed) return;
              nativeFailed = true;
              closeNativeNotification();
              fallback('Native delivery failed.');
            },
            { signal: listeners.signal },
          );
          deliveryStatus.textContent =
            persistent && notification.requireInteraction !== true
              ? 'Native notification sent; browser did not confirm persistence. Repeating reminders remain active.'
              : 'Native notification sent' +
                (persistent
                  ? ' with persistence requested. Repeating reminders remain active.'
                  : '.');
        } catch {
          nativeFailed = true;
          closeNativeNotification();
          fallback('Native delivery failed.');
        }
      }

      notifyDesktop();
      if (persistent && CONFIG.desktopNotification) {
        notificationTimer = setInterval(notifyDesktop, CONFIG.notificationRepeatSeconds * 1000);
      }
      beep();
      if (CONFIG.sound) alarmTimer = setInterval(beep, CONFIG.soundRepeatSeconds * 1000);
    }

    function acknowledgeAlert() {
      if (CONFIG.pendingAlert) {
        const stopped = stoppedStatus();
        try {
          updateWatch(CONFIG.url, { pendingAlert: null });
          CONFIG.pendingAlert = null;
        } catch (error) {
          notice.textContent +=
            '\nCould not save acknowledgement; try again: ' + /** @type {Error} */ (error).message;
          return;
        }
        forgetAlarm(CONFIG.url);
        status.textContent = stopped + ' Enable to watch again.';
      }
      silence();
      if (away) boot();
    }

    function closeNativeNotification() {
      if (!nativeNotification) return;
      const { notification, listeners } = nativeNotification;
      nativeNotification = null;
      try {
        listeners.abort();
        notification.close();
      } catch {
        /* A closed or unavailable native notification needs no cleanup. */
      }
    }

    function silence() {
      alarmActive = false;
      notificationGeneration++;
      closeNativeNotification();
      deliveryStatus.textContent = '';
      soundStatus.textContent = '';
      clearInterval(alarmTimer);
      alarmTimer = undefined;
      clearInterval(notificationTimer);
      notificationTimer = undefined;
      if (audio && audio.state === 'running') audio.suspend().catch(() => {});
      notice.textContent = '';
      acknowledgeButton.hidden = true;
      box.style.borderColor = '#7f8c8d';
      restoreTitle();
    }

    if (CONFIG.pendingAlert) {
      status.textContent = stoppedStatus() + ' An alert is waiting for you to acknowledge it.';
      alertUser(false);
    } else if (CONFIG.enabled) start(false);
    else status.textContent = 'Disabled. Enable to start watching.';
    return {
      suspendRefresh() {
        stopTimers();
        watchedTitle('settings open');
      },
      destroy() {
        stopTimers();
        silence();
        if (audio) audio.close().catch(() => {});
        host.remove();
      },
    };
  }
  initialize();
})();
