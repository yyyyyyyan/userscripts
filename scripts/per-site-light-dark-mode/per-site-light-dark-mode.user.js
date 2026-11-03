// ==UserScript==
// @name         Per-Site Light/Dark Mode
// @namespace    yyyyyyyan/per-site-light-dark-mode
// @version      0.0.0
// @description  Makes each site use its own light or dark theme, remembered per site, without generating colors.
// @author       yyyyyyyan
// @license      GPL-3.0-or-later
// @homepageURL  https://github.com/yyyyyyyan/userscripts/tree/main/scripts/per-site-light-dark-mode
// @supportURL   https://github.com/yyyyyyyan/userscripts/issues
// @match        https://*/*
// @match        http://*/*
// @run-at       document-start
// @noframes
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @inject-into  auto
// @sandbox      JavaScript
// @compatible   chrome Violentmonkey or Tampermonkey; enable "Allow User Scripts"
// @compatible   firefox Violentmonkey or Tampermonkey
// ==/UserScript==

(() => {
  'use strict';

  const PREFIX = 'choice:';
  const LOG = '[Per-Site Light/Dark Mode]';
  const host = location.hostname.toLowerCase();
  const key = `${PREFIX}${host}`;

  /**
   * Finds the choice saved for `hostname` itself, else for the nearest parent host. A browser
   * default saved on a host ends the search, so a subdomain can opt out of its parent's choice.
   * @param {string} hostname
   * @param {(key: string) => string | undefined} getValue
   * @returns {{ host: string, mode: 'light' | 'dark' } | null}
   */
  function resolveChoice(hostname, getValue) {
    const labels = hostname.split('.');
    const isAddress = hostname.includes(':') || /^[\d.]+$/.test(hostname);
    const candidates = isAddress ? [hostname] : labels.map((_, i) => labels.slice(i).join('.'));
    for (const candidate of candidates) {
      const value = getValue(`${PREFIX}${candidate}`);
      if (value === 'light' || value === 'dark') return { host: candidate, mode: value };
      if (value === 'default') return null;
    }
    return null;
  }

  const choice = resolveChoice(host, GM_getValue);
  const mode = choice ? choice.mode : 'default';
  const page = /** @type {Window & typeof globalThis} */ (
    typeof unsafeWindow === 'undefined' ? window : unsafeWindow
  );
  const nativeMatchMedia = /** @type {(query?: string) => MediaQueryList} */ (page.matchMedia);
  const isolated = typeof GM_info === 'object' && GM_info.injectInto === 'content';

  /**
   * Counts page scripts that ran before this one could. Any of them may already have read
   * the real preference, and nothing afterwards can tell whether one did.
   */
  function scriptsAlreadyRun() {
    const parsed = document.readyState !== 'loading';
    return [...(document.scripts || [])].filter((element) => {
      const type = element.type.trim().toLowerCase();
      const classic =
        type === '' || /^(?:text|application)\/(?:x-)?(?:java|ecma)script$/.test(type);
      if (!classic && type !== 'module') return false;
      return parsed || (classic && !element.async && !element.defer);
    }).length;
  }

  const injectedAt = { readyState: document.readyState, scripts: scriptsAlreadyRun() };
  const blockedSheets = new Set();
  /** @type {CSSStyleSheet | null} */
  let pinSheet = null;
  let pinError = '';
  /** @type {'none' | 'pinned' | 'site' | 'failed'} */
  let pinDecision = 'none';
  let siteScheme = '';
  let everPinned = false;
  const status = {
    javascriptError: '',
    mediaConditions: 0,
    pageQueries: 0,
    hooks: /** @type {string[]} */ ([]),
  };

  /** @param {'light' | 'dark' | 'default'} next */
  function selectMode(next) {
    GM_deleteValue(key);
    if (next !== 'default') GM_setValue(key, next);
    else if (resolveChoice(host, (name) => (name === key ? undefined : GM_getValue(name))))
      GM_setValue(key, 'default');
    location.reload();
  }

  const labels = { light: 'Light', dark: 'Dark', default: 'Browser default' };
  for (const value of /** @type {const} */ (['light', 'dark', 'default'])) {
    const active = value === mode;
    const from = active && choice && choice.host !== host ? `from ${choice.host}, ` : '';
    GM_registerMenuCommand(
      `${active ? '✓ ' : ''}${labels[value]} for ${host} (${from}reloads the tab)`,
      () => selectMode(value),
    );
  }

  /** @returns {string[]} Two to four plain sentences. */
  function describeStatus() {
    const browser = nativeMatchMedia.call(page, '(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
    if (!choice) {
      const saved =
        GM_getValue(key) === 'default'
          ? `Browser default is saved for ${host}`
          : `No choice is saved for ${host}`;
      return [
        `${saved}, so this page follows your browser's setting, which is ${browser}.`,
        "To pick one, choose Light or Dark in your userscript manager's menu.",
      ];
    }

    const lines = [
      choice.host === host
        ? `${labels[mode]} is saved for ${host}.`
        : `${labels[mode]} is saved for ${choice.host}, which includes ${host}.`,
    ];
    if (isolated) {
      const reason =
        document.contentType === 'text/html'
          ? "most likely the page's Content Security Policy stopped it"
          : 'this is not an HTML page';
      lines.push(
        `The script could not run inside this page itself (${reason}), so the page's own scripts may still see your browser's setting.`,
      );
    } else if (status.javascriptError) {
      lines.push(
        `The script could not answer this page's theme checks: ${status.javascriptError.replace(/[.\s]+$/, '')}.`,
      );
    } else if (injectedAt.scripts > 0) {
      lines.push(
        status.mediaConditions > 0 || everPinned
          ? "Its style sheets follow your choice, but this page may have checked its theme before the script could run, so parts of it may still show your browser's setting."
          : "This page may have checked its theme before the script could run, so it may still show your browser's setting.",
        "Reload the page, or set the site's own theme to System or Automatic.",
      );
    } else if (status.mediaConditions > 0 || status.pageQueries > 0 || everPinned) {
      lines.push(`It applied: this page asked which theme you prefer and was told ${mode}.`);
    } else {
      lines.push(
        `This page has not asked which theme you prefer, so it may not have a ${mode} theme of its own.`,
      );
    }

    const pin = pinState();
    if (pin === 'site') {
      lines.push(
        `The site has set its own ${siteScheme} color scheme, for example from its own theme switch, and the script leaves that alone.`,
      );
    } else if (pin === 'dropped') {
      lines.push(
        'The page later removed the color scheme the script set, so form controls and scroll bars may not match until you reload the page.',
      );
    } else if (pin === 'failed') {
      lines.push(
        `The script could not set the page's color scheme: ${pinError.replace(/[.\s]+$/, '')}.`,
      );
    }
    if (blockedSheets.size > 0) {
      const count = blockedSheets.size;
      lines.push(
        `${count} style ${count === 1 ? 'sheet' : 'sheets'} from other sites could not be read, so parts of this page may not switch.`,
      );
    }
    return lines.slice(0, 4);
  }

  GM_registerMenuCommand('Status', () => {
    const text = describeStatus().join(' ');
    console.info(LOG, text, { injectedAt, isolated, status, pin: pinState(), blockedSheets });
    window.alert(text);
  });

  if (mode === 'default') return;

  // Rewrite only the feature, preserving viewport, print, negation and other conditions.
  /** @param {string} query */
  function rewrite(query) {
    return query
      .replace(
        /\(\s*prefers-color-scheme\s*:\s*(light|dark|no-preference)\s*\)/gi,
        (_match, value) => (value.toLowerCase() === mode ? '(width >= 0px)' : '(width < 0px)'),
      )
      .replace(/\(\s*prefers-color-scheme\s*\)/gi, '(width >= 0px)');
  }

  /**
   * @template {Function} T
   * @param {T} fn
   * @returns {T}
   */
  function share(fn) {
    return typeof exportFunction === 'function' ? exportFunction(fn, page) : fn;
  }

  try {
    page.matchMedia = share(function matchMedia(/** @type {unknown} */ query) {
      if (arguments.length === 0) return nativeMatchMedia.call(page);
      const original = String(query);
      const next = rewrite(original);
      if (next !== original) status.pageQueries++;
      return nativeMatchMedia.call(page, next);
    });
    const answered =
      page.matchMedia('(prefers-color-scheme: dark)').matches === (mode === 'dark') &&
      page.matchMedia('(prefers-color-scheme: light)').matches === (mode === 'light');
    status.pageQueries = 0;
    if (!answered) status.javascriptError = 'the replacement gave the wrong answer';
  } catch (error) {
    status.javascriptError = /** @type {Error} */ (error).message;
    console.warn(LOG, 'JavaScript override failed.', error);
  }

  /** @param {MediaList | null | undefined} media */
  function fixMedia(media) {
    if (!media) return;
    const original = media.mediaText;
    const next = rewrite(original);
    if (next !== original) {
      media.mediaText = next;
      status.mediaConditions++;
    }
  }

  /**
   * @typedef {CSSRule & { media?: MediaList, styleSheet?: CSSStyleSheet, cssRules?: CSSRuleList }} NestedRule
   */

  /**
   * @param {CSSRuleList | CSSRule[]} rules
   * @param {Set<CSSStyleSheet>} visited
   */
  function walkRules(rules, visited) {
    for (const rule of /** @type {Iterable<NestedRule>} */ (rules)) {
      try {
        fixMedia(rule.media);
        if (rule.styleSheet) processSheet(rule.styleSheet, visited);
        if (rule.cssRules) walkRules(rule.cssRules, visited);
      } catch (error) {
        console.debug(LOG, 'Could not adjust a CSS rule.', error);
      }
    }
  }

  /**
   * @param {CSSStyleSheet | null | undefined} sheet
   * @param {Set<CSSStyleSheet>} [visited]
   */
  function processSheet(sheet, visited = new Set()) {
    if (!sheet || visited.has(sheet)) return;
    visited.add(sheet);
    try {
      fixMedia(sheet.media);
      walkRules(sheet.cssRules, visited);
    } catch (error) {
      if (/** @type {Error} */ (error).name === 'SecurityError')
        blockedSheets.add(sheet.href || '(unreadable stylesheet)');
      else console.debug(LOG, 'Could not adjust a stylesheet.', error);
    }
  }

  function pinApplied() {
    return pinSheet !== null && document.adoptedStyleSheets.includes(pinSheet);
  }

  /** @returns {'none' | 'pinned' | 'dropped' | 'site' | 'failed'} */
  function pinState() {
    if (pinDecision === 'pinned') return pinApplied() ? 'pinned' : 'dropped';
    return pinDecision;
  }

  // Judges the page by the value it declares with the pin lifted, so a single value (the
  // site's own switch, whatever its selector) is left alone and only "light dark" is steered.
  function pinColorScheme() {
    const root = document.documentElement;
    if (!root || document.readyState === 'loading') return;
    try {
      if (pinSheet && pinApplied()) {
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
          (sheet) => sheet !== pinSheet,
        );
      }
      const meta = /** @type {HTMLMetaElement | null} */ (
        document.querySelector('meta[name="color-scheme" i]')
      );
      const computed = getComputedStyle(root).colorScheme;
      const declared = computed === 'normal' ? meta?.content || '' : computed;
      const light = /\blight\b/i.test(declared);
      const dark = /\bdark\b/i.test(declared);
      // Avoid imposing dark browser defaults on a page that only provides light colors.
      if (!light || !dark) {
        pinDecision = light || dark ? 'site' : 'none';
        siteScheme = dark ? 'dark' : 'light';
        return;
      }
      if (!pinSheet) {
        pinSheet = new page.CSSStyleSheet();
        pinSheet.replaceSync(`:root { color-scheme: ${mode} !important; }`);
      }
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, pinSheet];
      pinDecision = 'pinned';
      everPinned = true;
      pinError = '';
    } catch (error) {
      pinDecision = 'failed';
      pinError = /** @type {Error} */ (error).message;
    }
  }

  let pinQueued = false;

  // Rechecking forces a whole-document style recalculation, so bursts collapse into one per frame.
  function schedulePin() {
    if (pinQueued) return;
    pinQueued = true;
    const run = () => {
      pinQueued = false;
      pinColorScheme();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else queueMicrotask(run);
  }

  const selector = 'style, link[rel~="stylesheet"], link[media], source[media]';

  /** @param {Element & { sheet?: CSSStyleSheet | null }} element */
  function processElement(element) {
    if (element.nodeType !== Node.ELEMENT_NODE || !element.matches(selector)) return;
    const original = element.getAttribute('media');
    if (original) {
      const next = rewrite(original);
      if (next !== original) {
        element.setAttribute('media', next);
        status.mediaConditions++;
      }
    }
    if (element.sheet) processSheet(element.sheet);
  }

  /** @param {Node} node */
  function processSubtree(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    processElement(/** @type {Element} */ (node));
    for (const element of /** @type {Element} */ (node).querySelectorAll(selector))
      processElement(element);
  }

  function fullScan() {
    for (const element of document.querySelectorAll(selector)) processElement(element);
    for (const sheet of document.styleSheets) processSheet(sheet);
    for (const sheet of document.adoptedStyleSheets || []) processSheet(sheet);
    pinColorScheme();
  }

  // CSS-in-JS may update rules without any observable DOM mutation.
  for (const name of ['insertRule', 'replaceSync']) {
    try {
      const prototype = page.CSSStyleSheet.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      if (!descriptor || typeof descriptor.value !== 'function') continue;
      const original = descriptor.value;
      Object.defineProperty(prototype, name, {
        ...descriptor,
        value: share(
          /**
           * @this {CSSStyleSheet}
           * @param {any[]} args
           */
          function (...args) {
            const result = Reflect.apply(original, this, args);
            if (name === 'insertRule') walkRules([this.cssRules[result]], new Set());
            else processSheet(this);
            return result;
          },
        ),
      });
      status.hooks.push(name);
    } catch (error) {
      console.debug(LOG, `${name} hook unavailable.`, error);
    }
  }

  new MutationObserver((mutations) => {
    let stylesChanged = false;
    for (const mutation of mutations) {
      if (mutation.type === 'attributes') {
        processElement(/** @type {Element} */ (mutation.target));
        stylesChanged = true;
      } else if (
        mutation.target.nodeType === Node.ELEMENT_NODE &&
        /** @type {Element} */ (mutation.target).localName === 'style'
      ) {
        processElement(/** @type {Element} */ (mutation.target));
        stylesChanged = true;
      } else if (
        mutation.type === 'characterData' &&
        mutation.target.parentElement?.localName === 'style'
      ) {
        processElement(mutation.target.parentElement);
        stylesChanged = true;
      } else {
        for (const node of mutation.addedNodes) {
          processSubtree(node);
          if (
            node.nodeType === Node.ELEMENT_NODE &&
            (/** @type {Element} */ (node).matches(selector) ||
              /** @type {Element} */ (node).querySelector(selector))
          ) {
            stylesChanged = true;
          }
        }
      }
    }
    if (stylesChanged) schedulePin();
  }).observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['media', 'href', 'rel'],
  });

  document.addEventListener(
    'load',
    (event) => {
      const target = /** @type {Element} */ (event.target);
      if (target.nodeType === Node.ELEMENT_NODE && ['link', 'style'].includes(target.localName)) {
        processElement(target);
        schedulePin();
      }
    },
    true,
  );
  /** @param {Element} root */
  function watchRoot(root) {
    // The root of an XML document, such as a news feed, has no inline style.
    const style = /** @type {Partial<ElementCSSInlineStyle>} */ (root).style;
    const readInline = () => (style ? style.getPropertyValue('color-scheme') : '');
    let inlineScheme = readInline();
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.attributeName === 'style') {
          const current = readInline();
          if (current === inlineScheme) continue;
          inlineScheme = current;
        }
        schedulePin();
        return;
      }
    }).observe(root, { attributes: true });
  }

  if (document.documentElement) {
    watchRoot(document.documentElement);
  } else {
    const rootWaiter = new MutationObserver(() => {
      if (!document.documentElement) return;
      rootWaiter.disconnect();
      watchRoot(document.documentElement);
    });
    rootWaiter.observe(document, { childList: true });
  }

  document.addEventListener('DOMContentLoaded', fullScan, { once: true });
  window.addEventListener('load', fullScan, { once: true });
  fullScan();
})();
