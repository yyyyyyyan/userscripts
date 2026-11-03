// ==UserScript==
// @name          Per-Site Light/Dark Mode
// @namespace     yyyyyyyan/per-site-light-dark-mode
// @version       0.0.0
// @description   Makes each site use its own light or dark theme, remembered per site, without generating colors.
// @author        yyyyyyyan
// @license       GPL-3.0-or-later
// @homepageURL   https://github.com/yyyyyyyan/userscripts/tree/main/scripts/per-site-light-dark-mode
// @supportURL    https://github.com/yyyyyyyan/userscripts/issues
// @match         https://*/*
// @match         http://*/*
// @run-at        document-start
// @noframes
// @grant         unsafeWindow
// @grant         GM_getValue
// @grant         GM_setValue
// @grant         GM_deleteValue
// @grant         GM_registerMenuCommand
// @inject-into   auto
// @sandbox       JavaScript
// @compatible    chrome Violentmonkey or Tampermonkey; enable "Allow User Scripts"
// @compatible    firefox Violentmonkey or Tampermonkey
// @incompatible  safari Userscripts lacks the menu commands this script needs
// ==/UserScript==

(() => {
  'use strict';

  const PREFIX = 'choice:';
  const LOG = '[Per-Site Light/Dark Mode]';
  const host = location.hostname.toLowerCase().replace(/\.$/, '');
  const key = `${PREFIX}${host}`;

  /**
   * Finds the choice saved for `hostname` itself, else for the nearest parent host. A browser
   * default saved on a host ends the search, so a subdomain can opt out of its parent's choice.
   * @param {string} hostname
   * @param {(key: string) => string | undefined} getValue
   * @returns {{ host: string, mode: 'light' | 'dark' } | null}
   */
  function resolveChoice(hostname, getValue) {
    const name = hostname.replace(/\.$/, '');
    const labels = name.split('.');
    const isAddress = name.includes(':') || /^[\d.]+$/.test(name);
    const candidates = isAddress ? [name] : labels.map((_, i) => labels.slice(i).join('.'));
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

  /** @param {Node} node */
  function hasFollowingNode(node) {
    const root = document.documentElement;
    for (
      let current = /** @type {Node | null} */ (node);
      current && current !== root;
      current = current.parentNode
    ) {
      let next = current.nextSibling;
      // Userscript managers attach their own elements to <html>, where the parser only ever
      // puts <head>, <body> or <frameset>.
      if (current.parentNode === root) {
        while (
          next?.nodeType === Node.ELEMENT_NODE &&
          !['head', 'body', 'frameset'].includes(/** @type {Element} */ (next).localName)
        )
          next = next.nextSibling;
      }
      if (next) return true;
    }
    return false;
  }

  /**
   * Counts the page's scripts that have certainly run already. Any of them may have read the
   * real preference, and nothing afterwards can tell whether one did.
   * - Data blocks such as JSON are never counted.
   * - Once the page has loaded, every script counts.
   * - Before that, external `async`, `defer` and module scripts don't count, because they
   *   may not have run yet.
   * - While the page is still loading, an ordinary script counts only when something follows
   *   it in the document. The parser moves past a script only after running it, so the last
   *   one may still be waiting to download or for a style sheet.
   */
  function scriptsAlreadyRun() {
    const state = document.readyState;
    return [...(document.scripts || [])].filter((element) => {
      const type = element.type.trim().toLowerCase();
      const classic =
        type === '' || /^(?:text|application)\/(?:x-)?(?:java|ecma)script$/.test(type);
      if (!classic && type !== 'module') return false;
      if (state === 'complete') return true;
      if (!classic || (element.src && (element.async || element.defer))) return false;
      return state === 'interactive' || hasFollowingNode(element);
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
        "To pick one, select Light or Dark in your userscript manager's menu.",
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
    } else if (status.mediaConditions > 0 || status.pageQueries > 0 || everPinned) {
      lines.push(`It applied: this page asked which theme you prefer and was told ${mode}.`);
      if (injectedAt.scripts > 0) {
        lines.push(
          "If parts of this page still show your browser's setting, the page probably checked its theme before the script loaded; reload the page, or set the site's own theme to System or Automatic.",
        );
      }
    } else if (injectedAt.scripts > 0) {
      lines.push(
        "This page may have checked its theme before the script could run, so it may still show your browser's setting.",
        "Reload the page, or set the site's own theme to System or Automatic.",
      );
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
        "The page later removed the color scheme the script set, so this page may show your browser's setting until you reload it.",
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

  const nativeReplaceSync = page.CSSStyleSheet?.prototype.replaceSync;

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
   * @typedef {CSSRule & { media?: MediaList, styleSheet?: CSSStyleSheet | null, cssRules?: CSSRuleList }} NestedRule
   */

  /**
   * Rule count of each sheet when it was last walked. Rules added later through the hooked
   * `insertRule` are walked one by one, so a sheet is walked again only when its count changed
   * some other way.
   * @type {WeakMap<CSSStyleSheet, number>}
   */
  const processed = new WeakMap();

  const IMPORT_RULE = 3;
  const MEDIA_RULE = 4;
  const KEYFRAMES_RULE = 7;

  /**
   * Reads as few properties as it can per rule, because each read can make the browser create
   * an object, and large sites have tens of thousands of rules.
   * @param {CSSRuleList | CSSRule[]} rules
   */
  function walkRules(rules) {
    for (let i = 0, count = rules.length; i < count; i++) {
      const rule = /** @type {NestedRule} */ (rules[i]);
      try {
        const type = rule.type;
        if (type === MEDIA_RULE || type === IMPORT_RULE) fixMedia(rule.media);
        if (type === IMPORT_RULE) processSheet(rule.styleSheet);
        else if (type !== KEYFRAMES_RULE) {
          const nested = rule.cssRules;
          if (nested && nested.length > 0) walkRules(nested);
        }
      } catch (error) {
        console.debug(LOG, 'Could not adjust a CSS rule.', error);
      }
    }
  }

  /** @param {CSSStyleSheet | null | undefined} sheet */
  function processSheet(sheet) {
    if (!sheet) return;
    try {
      const rules = sheet.cssRules;
      if (processed.get(sheet) === rules.length) {
        // An imported sheet can finish loading after the sheet that imports it. Imports come
        // before every other rule except `@layer` statements, so the loop stops early.
        for (const rule of /** @type {Iterable<NestedRule>} */ (rules)) {
          if ('styleSheet' in rule) processSheet(rule.styleSheet);
          else if (!('nameList' in rule)) break;
        }
        return;
      }
      fixMedia(sheet.media);
      walkRules(rules);
      processed.set(sheet, rules.length);
    } catch (error) {
      if (/** @type {Error} */ (error).name === 'SecurityError')
        blockedSheets.add(sheet.href || '(unreadable stylesheet)');
      else console.debug(LOG, 'Could not adjust a stylesheet.', error);
    }
  }

  /** @param {CSSStyleSheet} sheet */
  function reprocessSheet(sheet) {
    processed.delete(sheet);
    processSheet(sheet);
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
      const meta = /** @type {HTMLMetaElement | null} */ (document.querySelector(schemeMeta));
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
        Reflect.apply(nativeReplaceSync, pinSheet, [`:root { color-scheme: ${mode} !important; }`]);
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

  /** @param {unknown} text */
  function schedulePinFor(text) {
    if (/color-scheme/i.test(String(text))) schedulePin();
  }

  const selector = 'style, link[rel~="stylesheet"], link[media], source[media]';
  const schemeMeta = 'meta[name="color-scheme" i]';
  const schemeSelector = `${selector}, ${schemeMeta}`;
  const schemeTags = ['style', 'link', 'source', 'meta'];
  const observed = {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['media', 'href', 'rel', 'disabled', 'content'],
  };

  /**
   * Rewrites the element's `media` attribute and, for `<style>`, starts watching its text.
   * @param {Element} element
   */
  function processElement(element) {
    if (!element.matches(selector)) return;
    const original = element.getAttribute('media');
    if (original) {
      const next = rewrite(original);
      if (next !== original) {
        element.setAttribute('media', next);
        status.mediaConditions++;
      }
    }
    if (element.localName === 'style')
      observer.observe(element, { subtree: true, characterData: true });
  }

  /** @param {Element & { sheet?: CSSStyleSheet | null }} element */
  function processStyleElement(element) {
    processElement(element);
    processSheet(element.sheet);
  }

  /**
   * @param {Node} node
   * @returns {boolean} Whether the subtree holds anything that can change the page's styles.
   */
  function processSubtree(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    const element = /** @type {Element} */ (node);
    if (!element.firstElementChild && !schemeTags.includes(element.localName)) return false;
    const matches = element.matches(schemeSelector);
    if (!matches && !element.querySelector(schemeSelector)) return false;
    if (matches) processStyleElement(element);
    for (const each of element.querySelectorAll(schemeSelector)) processStyleElement(each);
    return true;
  }

  /** @param {Element} element */
  function isSchemeMeta(element) {
    return element.localName === 'meta' && element.matches(schemeMeta);
  }

  /** @param {Node} node */
  function holdsStyles(node) {
    return (
      node.nodeType === Node.ELEMENT_NODE &&
      (/** @type {Element} */ (node).matches(schemeSelector) ||
        /** @type {Element} */ (node).querySelector(schemeSelector) !== null)
    );
  }

  // The parser adds every element as its own record, so a large page delivers tens of thousands
  // of them and each property read counts.
  const observer = new MutationObserver((mutations) => {
    let stylesChanged = false;
    const parsing = document.readyState === 'loading';
    for (let i = 0, count = mutations.length; i < count; i++) {
      const mutation = mutations[i];
      const type = mutation.type;
      const target = /** @type {Element} */ (mutation.target);
      if (type === 'childList') {
        if (target.localName === 'style') {
          processStyleElement(target);
          stylesChanged = true;
          continue;
        }
        const added = mutation.addedNodes;
        for (let j = 0; j < added.length; j++) if (processSubtree(added[j])) stylesChanged = true;
        // Removals only call for a re-check, which the scan at DOMContentLoaded schedules anyway.
        if (parsing) continue;
        const removed = mutation.removedNodes;
        for (let j = 0; j < removed.length; j++) if (holdsStyles(removed[j])) stylesChanged = true;
      } else if (type === 'attributes') {
        if (mutation.attributeName === 'content') {
          if (isSchemeMeta(target)) stylesChanged = true;
        } else if (['link', 'style', 'source'].includes(target.localName)) {
          processStyleElement(target);
          stylesChanged = true;
        }
      } else {
        const style = target.parentElement;
        if (style?.localName === 'style') {
          processStyleElement(style);
          stylesChanged = true;
        }
      }
    }
    if (stylesChanged) schedulePin();
  });

  /** @param {Event} event */
  function onLoad(event) {
    const target = /** @type {Element} */ (event.target);
    if (target.nodeType === Node.ELEMENT_NODE && ['link', 'style'].includes(target.localName)) {
      processStyleElement(target);
      schedulePin();
    }
  }

  /** @param {Document | ShadowRoot} root */
  function scanRoot(root) {
    for (const element of root.querySelectorAll(selector)) processElement(element);
    for (const sheet of root.styleSheets) processSheet(sheet);
    for (const sheet of root.adoptedStyleSheets || []) processSheet(sheet);
  }

  /**
   * Watches a shadow root the way the document is watched. It needs its own `load` listener,
   * because a `load` event inside a shadow tree does not reach the document.
   * @param {ShadowRoot} root
   */
  function watchShadowRoot(root) {
    observer.observe(root, observed);
    root.addEventListener('load', onLoad, true);
    scanRoot(root);
  }

  /** @param {Document | ShadowRoot} root */
  function scanShadowRoots(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const shadow = /** @type {Element} */ (node).shadowRoot;
      if (!shadow) continue;
      watchShadowRoot(shadow);
      scanShadowRoots(shadow);
    }
  }

  let shadowRootsFound = false;

  // Visiting every element is slow on large pages, so existing roots are searched for once, after
  // parsing has created every declarative one. Later roots arrive through the attachShadow hook.
  function fullScan() {
    scanRoot(document);
    if (!shadowRootsFound && document.readyState !== 'loading') {
      shadowRootsFound = true;
      scanShadowRoots(document);
    }
    schedulePin();
  }

  let hooking = false;

  /**
   * Replaces `owner[name]` so `after` runs once the page's own call has returned. A call made
   * while `after` is running, such as from another of these hooks, is passed straight through.
   * @param {object | undefined} owner A prototype, missing in browsers without the interface.
   * @param {string} name
   * @param {(self: any, result: any, args: any[]) => void} after
   * @param {'value' | 'set'} [slot]
   */
  function hook(owner, name, after, slot = 'value') {
    if (!owner) return;
    const label = `${/** @type {Function} */ (owner.constructor).name}.${name}`;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(owner, name);
      const original = descriptor?.[slot];
      if (!descriptor || typeof original !== 'function') return;
      Object.defineProperty(owner, name, {
        ...descriptor,
        [slot]: share(
          /**
           * @this {unknown}
           * @param {any[]} args
           */
          function (...args) {
            const result = Reflect.apply(original, this, args);
            if (hooking) return result;
            hooking = true;
            try {
              after(this, result, args);
            } catch (error) {
              console.debug(LOG, `Could not follow ${label}.`, error);
            } finally {
              hooking = false;
            }
            return result;
          },
        ),
      });
      status.hooks.push(label);
    } catch (error) {
      console.debug(LOG, `${label} hook unavailable.`, error);
    }
  }

  // CSS-in-JS may update rules without any observable DOM mutation.
  hook(page.CSSStyleSheet?.prototype, 'insertRule', (sheet, index, [text]) => {
    const rules = /** @type {CSSStyleSheet} */ (sheet).cssRules;
    walkRules([rules[index]]);
    if (processed.get(sheet) === rules.length - 1) processed.set(sheet, rules.length);
    schedulePinFor(text);
  });
  hook(page.CSSGroupingRule?.prototype, 'insertRule', (rule, index, [text]) => {
    walkRules([/** @type {CSSGroupingRule} */ (rule).cssRules[index]]);
    schedulePinFor(text);
  });
  hook(page.CSSStyleSheet?.prototype, 'replaceSync', (sheet) => {
    reprocessSheet(sheet);
    schedulePin();
  });
  hook(page.CSSStyleSheet?.prototype, 'replace', (sheet, promise) => {
    /** @type {Promise<unknown>} */ (promise).then(
      () => {
        reprocessSheet(sheet);
        schedulePin();
      },
      () => {},
    );
  });
  hook(page.Element?.prototype, 'attachShadow', (_host, root) => watchShadowRoot(root));
  hook(
    page.ShadowRoot?.prototype,
    'adoptedStyleSheets',
    (root) => {
      for (const sheet of /** @type {ShadowRoot} */ (root).adoptedStyleSheets) processSheet(sheet);
    },
    'set',
  );

  observer.observe(document, observed);
  document.addEventListener('load', onLoad, true);

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
