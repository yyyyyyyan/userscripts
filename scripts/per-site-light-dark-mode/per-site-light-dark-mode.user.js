// ==UserScript==
// @name         Site Color Preference
// @namespace    yyyyyyyan/site-color-preference
// @version      0.1.0
// @description  Remember a native light/dark preference per hostname. Configure from Tampermonkey's menu.
// @match        https://*/*
// @match        http://*/*
// @run-at       document-start
// @sandbox      JavaScript
// @noframes
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @license      GPL-3.0-or-later
// ==/UserScript==

/*
 * USE: Visit a site, then select Prefer light / Prefer dark in its Tampermonkey menu.
 *      The current tab reloads. Use browser default removes that hostname's rule.
 *      Set the website's own theme to System/Automatic when it offers that option.
 *
 * Preferences are stored by Tampermonkey, independently of website cookies.
 * Hostnames are exact: example.com, www.example.com and app.example.com are separate.
 *
 * This requests existing themes; it does not generate or invert colors. It rewrites
 * JavaScript matchMedia queries, accessible CSS media rules and HTML media attributes.
 * Browser controls/light-dark() are adjusted when the root declares both schemes.
 *
 * Limits: cross-origin stylesheets that deny CSSOM access are skipped; closed/shadow
 * trees, embedded frames and some dynamically adopted styles may be unaffected.
 * A site's explicit saved theme can take precedence. A brief initial flash is possible.
 * The status command reports inaccessible sheets and whether JS overriding succeeded.
 * There are no dependencies, telemetry, network calls of its own or periodic polling.
 */

(() => {
  'use strict';

  const host = location.hostname.toLowerCase();
  const key = `site-color-preference:${host}`;
  const saved = GM_getValue(key, 'default');
  const mode = saved === 'light' || saved === 'dark' ? saved : 'default';
  const page = typeof unsafeWindow === 'undefined' ? window : unsafeWindow;
  const nativeMatchMedia = page.matchMedia;
  const blockedSheets = new Set();
  const status = {
    javascript: 'inactive',
    mediaConditions: 0,
    colorScheme: 'unchanged',
    hooks: [],
  };

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
      rootColorScheme: status.colorScheme,
      dynamicCssHooks: status.hooks,
      inaccessibleStylesheets: [...blockedSheets],
      note: 'A saved site/account theme can override this preference. Choose System/Automatic on the site.',
    };
    console.info('[Site Color Preference]', report);
    window.alert(JSON.stringify(report, null, 2));
  });

  if (mode === 'default') return;

  // Rewrite only the feature, preserving viewport, print, negation and other conditions.
  function rewrite(query) {
    return query
      .replace(
        /\(\s*prefers-color-scheme\s*:\s*(light|dark|no-preference)\s*\)/gi,
        (_match, value) => (value.toLowerCase() === mode ? '(width >= 0px)' : '(width < 0px)'),
      )
      .replace(/\(\s*prefers-color-scheme\s*\)/gi, '(width >= 0px)');
  }

  function share(fn) {
    return typeof exportFunction === 'function' ? exportFunction(fn, page) : fn;
  }

  try {
    page.matchMedia = share(function matchMedia(query) {
      if (arguments.length === 0) return nativeMatchMedia.call(page);
      return nativeMatchMedia.call(page, rewrite(String(query)));
    });
    status.javascript =
      page.matchMedia('(prefers-color-scheme: dark)').matches === (mode === 'dark') &&
      page.matchMedia('(prefers-color-scheme: light)').matches === (mode === 'light')
        ? 'installed'
        : 'failed';
  } catch (error) {
    status.javascript = `failed: ${error.message}`;
    console.warn('[Site Color Preference] JavaScript override failed.', error);
  }

  function fixMedia(media) {
    if (!media) return;
    const original = media.mediaText;
    const next = rewrite(original);
    if (next !== original) {
      media.mediaText = next;
      status.mediaConditions++;
    }
  }

  function walkRules(rules, visited) {
    for (const rule of rules) {
      try {
        fixMedia(rule.media);
        if (rule.styleSheet) processSheet(rule.styleSheet, visited);
        if (rule.cssRules) walkRules(rule.cssRules, visited);
      } catch (error) {
        console.debug('[Site Color Preference] Could not adjust a CSS rule.', error);
      }
    }
  }

  function processSheet(sheet, visited = new Set()) {
    if (!sheet || visited.has(sheet)) return;
    visited.add(sheet);
    try {
      fixMedia(sheet.media);
      walkRules(sheet.cssRules, visited);
    } catch (error) {
      if (error.name === 'SecurityError')
        blockedSheets.add(sheet.href || '(unreadable stylesheet)');
      else console.debug('[Site Color Preference] Could not adjust a stylesheet.', error);
    }
  }

  function pinColorScheme() {
    const root = document.documentElement;
    if (!root || document.readyState === 'loading' || status.colorScheme !== 'unchanged') return;
    const meta = document.querySelector('meta[name="color-scheme" i]');
    const computed = getComputedStyle(root).colorScheme;
    const declared = computed === 'normal' ? meta?.content || '' : computed;
    // Avoid imposing dark browser defaults on a page that only provides light colors.
    if (/\blight\b/i.test(declared) && /\bdark\b/i.test(declared)) {
      root.style.setProperty('color-scheme', mode, 'important');
      status.colorScheme = mode;
    }
  }

  const selector = 'style, link[rel~="stylesheet"], link[media], source[media]';

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

  function processSubtree(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    processElement(node);
    for (const element of node.querySelectorAll(selector)) processElement(element);
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
        value: share(function (...args) {
          const result = Reflect.apply(original, this, args);
          if (name === 'insertRule') walkRules([this.cssRules[result]], new Set());
          else processSheet(this);
          return result;
        }),
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
        processElement(mutation.target);
        stylesChanged = true;
      } else if (
        mutation.target.nodeType === Node.ELEMENT_NODE &&
        mutation.target.localName === 'style'
      ) {
        processElement(mutation.target);
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
            (node.matches(selector) || node.querySelector(selector))
          ) {
            stylesChanged = true;
          }
        }
      }
    }
    if (stylesChanged) pinColorScheme();
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
      if (
        event.target.nodeType === Node.ELEMENT_NODE &&
        ['link', 'style'].includes(event.target.localName)
      ) {
        processElement(event.target);
        pinColorScheme();
      }
    },
    true,
  );
  document.addEventListener('DOMContentLoaded', fullScan, { once: true });
  window.addEventListener('load', fullScan, { once: true });
  fullScan();
})();
