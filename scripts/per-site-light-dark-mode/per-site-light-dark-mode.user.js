// ==UserScript==
// @name         Per-Site Light/Dark Mode
// @namespace    yyyyyyyan/per-site-light-dark-mode
// @version      0.0.0
// @description  Asks each site for its own light or dark theme, remembered per site. It never generates colors.
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
// @inject-into  page
// @sandbox      JavaScript
// @compatible   chrome Violentmonkey or Tampermonkey; enable "Allow User Scripts"
// @compatible   firefox Violentmonkey or Tampermonkey
// ==/UserScript==

(() => {
  'use strict';

  const host = location.hostname.toLowerCase();
  const key = `site-color-preference:${host}`;
  const saved = GM_getValue(key, /** @type {string} */ ('default'));
  const mode = saved === 'light' || saved === 'dark' ? saved : 'default';
  const page = /** @type {Window & typeof globalThis} */ (
    typeof unsafeWindow === 'undefined' ? window : unsafeWindow
  );
  const nativeMatchMedia = /** @type {(query?: string) => MediaQueryList} */ (page.matchMedia);
  const blockedSheets = new Set();
  /** @type {CSSStyleSheet | null} */
  let pinSheet = null;
  let pinError = '';
  const status = {
    javascript: 'inactive',
    mediaConditions: 0,
    hooks: /** @type {string[]} */ ([]),
  };

  /** @param {string} next */
  function selectMode(next) {
    if (next === 'default') GM_deleteValue(key);
    else GM_setValue(key, next);
    location.reload();
  }

  for (const [value, label] of [
    ['light', 'Prefer light'],
    ['dark', 'Prefer dark'],
    ['default', 'Use browser default'],
  ]) {
    GM_registerMenuCommand(`${value === mode ? '\u2713 ' : ''}${label} for ${host} (reload)`, () =>
      selectMode(value),
    );
  }

  GM_registerMenuCommand('Show color preference status', () => {
    const report = {
      host,
      preference: mode,
      browserPreference: nativeMatchMedia.call(page, '(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light',
      javascriptOverride: status.javascript,
      mediaConditionsChanged: status.mediaConditions,
      rootColorScheme: pinState(),
      dynamicCssHooks: status.hooks,
      inaccessibleStylesheets: [...blockedSheets],
      note: 'A saved site/account theme can override this preference. Choose System/Automatic on the site.',
    };
    console.info('[Site Color Preference]', report);
    window.alert(JSON.stringify(report, null, 2));
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
      return nativeMatchMedia.call(page, rewrite(String(query)));
    });
    status.javascript =
      page.matchMedia('(prefers-color-scheme: dark)').matches === (mode === 'dark') &&
      page.matchMedia('(prefers-color-scheme: light)').matches === (mode === 'light')
        ? 'installed'
        : 'failed';
  } catch (error) {
    status.javascript = `failed: ${/** @type {Error} */ (error).message}`;
    console.warn('[Site Color Preference] JavaScript override failed.', error);
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
        console.debug('[Site Color Preference] Could not adjust a CSS rule.', error);
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
      else console.debug('[Site Color Preference] Could not adjust a stylesheet.', error);
    }
  }

  function pinApplied() {
    return pinSheet !== null && document.adoptedStyleSheets.includes(pinSheet);
  }

  function pinState() {
    if (pinApplied()) return mode;
    return pinError ? `failed: ${pinError}` : 'unchanged';
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
      // Avoid imposing dark browser defaults on a page that only provides light colors.
      if (!/\blight\b/i.test(declared) || !/\bdark\b/i.test(declared)) return;
      if (!pinSheet) {
        pinSheet = new page.CSSStyleSheet();
        pinSheet.replaceSync(`:root { color-scheme: ${mode} !important; }`);
      }
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, pinSheet];
      pinError = '';
    } catch (error) {
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
      console.debug(`[Site Color Preference] ${name} hook unavailable.`, error);
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
  /** @param {HTMLElement} root */
  function watchRoot(root) {
    let inlineScheme = root.style.getPropertyValue('color-scheme');
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.attributeName === 'style') {
          const current = root.style.getPropertyValue('color-scheme');
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
