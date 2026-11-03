// ==UserScript==
// @name         Page Watch — refresh until found / missing
// @namespace    yan-orestes/page-watch
// @version      2.3.0
// @description  Manage per-URL refresh watches through a settings panel. No code editing needed.
// @match        http://*/*
// @match        https://*/*
// @run-at       document-idle
// @noframes
// @grant        GM_getTab
// @grant        GM_saveTab
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_notification
// @grant        GM_registerMenuCommand
// ==/UserScript==

(() => {
  'use strict';
  // INSTALL ONCE: replace the old script with this entire file and save.
  // CONFIGURE: Tampermonkey menu > Page Watch: Manage watches.
  // One watch per exact URL (including query parameters, ignoring #fragment).
  // Settings and enabled/disabled state persist across tabs and browser restarts.
  // Watches run only while their page is open. No background fetching or purchases.
  // Native notifications request persistence. Chromium/Linux may promote these to critical;
  // Firefox and desktop notification services can handle urgency differently.
  // Monitoring and tab-title countdowns do not depend on focus or visibility.
  // Browser background throttling may delay ticks; suspended/discarded tabs cannot run.

  const STORAGE = 'page-watch:v2:watches';
  const DEFAULTS = {
    enabled: false,
    lastStatus: 'paused',
    intervalSeconds: 30,
    stopWhen: 'not-found',
    selector: '',
    text: '',
    caseSensitive: false,
    settleSeconds: 5,
    confirmSeconds: 3,
    readySelector: '',
    notificationTitle: 'Page Watch — condition met!',
    notificationText: 'The watched condition is met. Check the page now.',
    desktopNotification: true,
    sound: true,
    soundRepeatSeconds: 4,
    volume: 0.25,
    requireExplicitDismissal: true,
    notificationRepeatSeconds: 30,
    pendingAlert: null,
    notificationBackend: 'auto',
    alertOnRedirect: true,
  };
  const PRESET = {
    ...DEFAULTS,
    url: 'https://tickets.example.com/events/match-123/',
    selector: 'div.alert.alert-error[role="alert"]',
    text: 'No momento, todos os ingressos estão reservados.',
    notificationTitle: 'Tickets — page changed!',
    notificationText:
      'The all-tickets-reserved warning is gone. Check the page now; availability is not guaranteed.',
  };
  function normalizeURL(value) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use an HTTP or HTTPS URL.');
    if (url.username || url.password)
      throw new Error('URLs with embedded credentials are not supported.');
    url.hash = '';
    return url.href;
  }
  // Use the standard DOM API, not unsafeWindow, so Firefox can wrap arguments
  // normally across its userscript sandbox. Never change browser preferences.
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
  const currentURL = () => normalizeURL(location.href);
  const readRules = () => GM_getValue(STORAGE, {});
  let runner = null;
  let editor = null;
  let currentSignature = '';
  let tabState = {};
  let lastURL = currentURL();
  function displayedRuleURL(rules) {
    const tracked = tabState.pageWatch?.url;
    return tracked && rules[tracked]?.pendingAlert ? tracked : currentURL();
  }
  function signature(rules) {
    return JSON.stringify(rules[displayedRuleURL(rules)] || null);
  }
  function forgetWatch(url) {
    if (tabState.pageWatch?.url !== url) return;
    delete tabState.pageWatch;
    try {
      GM_saveTab(tabState);
    } catch (error) {
      console.warn('Page Watch: tab tracking cleanup failed', error);
    }
  }
  function trackWatch(url, ready, failed) {
    tabState.pageWatch = { url };
    try {
      GM_saveTab(tabState, ready);
    } catch (error) {
      failed(error);
    }
  }
  function checkDestination() {
    const source = tabState.pageWatch?.url;
    if (!source || source === currentURL()) return;
    const rule = readRules()[source];
    if (rule?.pendingAlert) return; // Preserve an already pending alert across navigation.
    if (!rule?.enabled || rule.alertOnRedirect === false) {
      forgetWatch(source);
      return;
    }
    const destination = currentURL();
    const displayURL = (value) => {
      const url = new URL(value);
      return url.origin + url.pathname;
    };
    saveRule({
      ...DEFAULTS,
      ...rule,
      enabled: false,
      lastStatus: 'stopped',
      pendingAlert: {
        kind: 'redirect',
        title: 'Page Watch — unexpected URL change',
        createdAt: Date.now(),
        destinationURL: destination,
        text:
          'Monitoring stopped because this tab left its watched URL.\nExpected: ' +
          displayURL(source) +
          '\nOpened: ' +
          displayURL(destination) +
          '\nYour login may have expired. Check the page, then return to the watched URL to enable monitoring again.',
      },
    });
    // Make the alert visible even if a single-page navigation happened during editing.
    if (editor) {
      editor.remove();
      editor = null;
    }
  }
  function writeRules(rules) {
    // Record our own write before listeners run; don't tear down a fresh alarm.
    const previous = currentSignature;
    currentSignature = signature(rules);
    try {
      GM_setValue(STORAGE, rules);
    } catch (error) {
      currentSignature = previous;
      throw error;
    }
  }
  function saveRule(rule) {
    const rules = readRules();
    rules[rule.url] = { ...rule };
    writeRules(rules);
  }
  function validateRule(rule) {
    normalizeURL(rule.url);
    if (!['auto', 'tampermonkey'].includes(rule.notificationBackend))
      throw new Error('Choose a valid notification method.');
    for (const key of ['intervalSeconds', 'soundRepeatSeconds', 'notificationRepeatSeconds']) {
      if (!Number.isFinite(rule[key]) || rule[key] < 1 || rule[key] > 86400)
        throw new Error(key + ' must be between 1 and 86400 seconds.');
    }
    for (const key of ['settleSeconds', 'confirmSeconds']) {
      if (!Number.isFinite(rule[key]) || rule[key] < 0 || rule[key] > 86400)
        throw new Error(key + ' must be between 0 and 86400 seconds.');
    }
    if (!['found', 'not-found'].includes(rule.stopWhen))
      throw new Error('Choose found or not found.');
    if (typeof rule.selector !== 'string' || !rule.selector.trim())
      throw new Error('Enter a CSS selector.');
    if (typeof rule.text !== 'string') throw new Error('Text must be a string.');
    if (!Number.isFinite(rule.volume) || rule.volume < 0 || rule.volume > 1)
      throw new Error('Volume must be between 0 and 1.');
    document.querySelector(rule.selector);
    if (rule.readySelector) document.querySelector(rule.readySelector);
  }
  function boot() {
    if (runner) runner.destroy();
    runner = null;
    const rules = readRules();
    currentSignature = signature(rules);
    const rule = rules[displayedRuleURL(rules)];
    if (!editor && rule) runner = runWatch({ ...DEFAULTS, ...rule });
  }

  function openManager() {
    if (editor) return;
    if (runner) runner.suspendRefresh(); // Keep pending alerts active while editing.
    const host = document.createElement('div');
    editor = host;
    host.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;background:#0009;display:grid;place-items:center;padding:12px;';
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      *{box-sizing:border-box} .panel{width:min(650px,94vw);max-height:90vh;overflow:auto;background:#17202a;color:#fff;border:1px solid #777;border-radius:12px;padding:20px;font:14px/1.5 system-ui,sans-serif;box-shadow:0 12px 50px #0009}
      h2{margin:0 0 8px;font-size:22px}p{margin:6px 0 14px;color:#d1d5db}label{display:block;margin:12px 0 0}input:not([type=checkbox]),select,textarea{display:block;width:100%;margin-top:4px;padding:8px;color:#111;background:#fff;border:1px solid #aaa;border-radius:5px;font:inherit}input[type=checkbox]{margin-right:8px}small{display:block;color:#bfc8d2}button{font:inherit;padding:7px 12px;border:1px solid #aaa;border-radius:5px;background:#fff;color:#111;cursor:pointer}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:18px}.error{color:#ffb4b4;white-space:pre-wrap;margin-top:12px}details{margin-top:16px}summary{cursor:pointer;font-weight:600}
    `;
    const panel = document.createElement('section');
    panel.className = 'panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Manage Page Watch settings');
    function add(tag, text, parent = panel) {
      const el = document.createElement(tag);
      if (text !== undefined) el.textContent = text;
      parent.append(el);
      return el;
    }
    add('h2', 'Page Watch settings');
    add(
      'p',
      'Save one watch per URL. Refreshing is suspended in this tab while this panel is open.',
    );
    const pickLabel = add('label', 'Saved watches');
    const picker = add('select', undefined, pickLabel);
    picker.name = 'savedWatch';
    const fresh = add('option', '＋ New watch for this page', picker);
    fresh.value = '';
    for (const rule of Object.values(readRules())) {
      const option = add('option', (rule.enabled ? 'ON — ' : 'OFF — ') + rule.url, picker);
      option.value = rule.url;
    }
    const form = add('form');
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      saveFromForm();
    });
    const fields = {};
    function field(name, label, type = 'text', help = '', parent = form, choices = null) {
      const wrapper = add('label', type === 'checkbox' ? undefined : label, parent);
      const input = add(
        choices ? 'select' : type === 'textarea' ? 'textarea' : 'input',
        undefined,
        wrapper,
      );
      input.name = name;
      if (!choices && type !== 'textarea') input.type = type;
      if (type === 'checkbox') add('span', label, wrapper);
      if (choices)
        for (const [value, text] of choices) {
          const opt = add('option', text, input);
          opt.value = value;
        }
      if (type === 'number') {
        input.min = '0';
        input.max = '86400';
        input.step = 'any';
        input.required = true;
      }
      if (help) add('small', help, wrapper);
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
    field('intervalSeconds', 'Refresh interval (seconds)', 'number').min = '1';
    field('stopWhen', 'Stop and notify when the target is…', 'text', '', form, [
      ['not-found', 'Not found — disappears'],
      ['found', 'Found — appears'],
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
    field('caseSensitive', 'Case-sensitive text matching', 'checkbox', '', advanced);
    field('settleSeconds', 'Initial rendering wait (seconds)', 'number', '', advanced);
    field('confirmSeconds', 'Condition confirmation time (seconds)', 'number', '', advanced);
    field(
      'alertOnRedirect',
      'Alert when this tab leaves the watched URL',
      'checkbox',
      'Stops monitoring and requires acknowledgement on another URL, including login redirects or manual navigation. Disable the watch before intentionally leaving. Works across HTTP/HTTPS pages where this script is allowed to run.',
      advanced,
    );
    field(
      'readySelector',
      'Page-ready CSS selector (optional)',
      'text',
      'If missing, the watch pauses. Without this guard, an error/login page can trigger a “not found” condition.',
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
      ['tampermonkey', 'Tampermonkey only'],
    ]);
    const permissionStatus = add('small', '', advanced);
    const permissionButton = add('button', 'Allow native notifications', advanced);
    permissionButton.type = 'button';
    function sameOrigin() {
      try {
        return new URL(fields.url.value).origin === new URL(location.href).origin;
      } catch {
        return false;
      }
    }
    function showPermission() {
      const permission = nativePermission();
      permissionStatus.textContent = !sameOrigin()
        ? 'Open the watch’s site to grant native notification permission there.'
        : permission === 'granted'
          ? 'Native notification permission granted for this site. Use Test alert after saving.'
          : permission === 'denied'
            ? 'Native notifications are blocked. Change this site’s browser permissions, then reopen Settings. Tampermonkey fallback remains available.'
            : permission === 'unavailable'
              ? 'Native notifications are unavailable here. Tampermonkey fallback will be used.'
              : 'Click Allow native notifications for this site. Until allowed, Tampermonkey fallback will be used.';
      permissionButton.disabled = !sameOrigin() || permission !== 'default';
    }
    permissionButton.addEventListener('click', () => {
      if (!sameOrigin() || nativePermission() !== 'default') {
        showPermission();
        return;
      }
      // Call immediately inside the real click handler (required by Firefox).
      try {
        permissionButton.disabled = true;
        nativeAPI()
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
      'Allow audio autoplay for the site. Chromium/Linux may display persistent native notifications as critical; Firefox can keep normal urgency. If Firefox reports persistence unsupported, check dom.webnotifications.requireinteraction.enabled in about:config. Reminders and the page alert continue until Acknowledge; Do Not Disturb remains desktop-controlled.',
      advanced,
    );
    const error = add('div');
    error.className = 'error';
    error.setAttribute('role', 'alert');
    const actions = add('div');
    actions.className = 'actions';
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
        const rules = readRules();
        if (rules[editingURL]?.pendingAlert)
          throw new Error(
            'Close settings and Acknowledge the active alert before deleting this watch.',
          );
        delete rules[editingURL];
        writeRules(rules);
        close();
      } catch (e) {
        error.textContent = e.message;
      }
    });
    action('Close', close);
    let editingURL = '';
    function fill(url) {
      editingURL = url;
      const rule = { ...DEFAULTS, url: currentURL(), ...(readRules()[url] || {}) };
      for (const [name, input] of Object.entries(fields)) {
        if (input.type === 'checkbox') input.checked = Boolean(rule[name]);
        else input.value = String(rule[name] ?? DEFAULTS[name] ?? '');
      }
      showPermission();
      remove.disabled = !url;
      error.textContent = '';
    }
    function saveFromForm() {
      if (!form.reportValidity()) return;
      try {
        if (readRules()[editingURL]?.pendingAlert)
          throw new Error(
            'Close settings and Acknowledge the active alert before editing this watch.',
          );
        const rule = { ...DEFAULTS };
        for (const [name, input] of Object.entries(fields)) {
          rule[name] =
            input.type === 'checkbox'
              ? input.checked
              : input.type === 'number'
                ? Number(input.value)
                : input.value;
        }
        rule.url = normalizeURL(rule.url.trim());
        rule.selector = rule.selector.trim();
        rule.readySelector = rule.readySelector.trim();
        rule.lastStatus = rule.enabled ? 'running' : 'paused';
        validateRule(rule);
        const rules = readRules();
        if (rule.url !== editingURL && rules[rule.url])
          throw new Error(
            'A watch already exists for this URL. Select it from Saved watches to edit it.',
          );
        if (editingURL && editingURL !== rule.url) delete rules[editingURL];
        rules[rule.url] = rule;
        writeRules(rules);
        close();
      } catch (e) {
        error.textContent = 'Could not save: ' + e.message;
      }
    }
    function close() {
      host.remove();
      editor = null;
      boot();
    }
    picker.addEventListener('change', () => fill(picker.value));
    const initial = readRules()[currentURL()] ? currentURL() : '';
    picker.value = initial;
    fill(initial);
    root.append(style, panel);
    document.documentElement.append(host);
    fields.url.focus();
  }

  function followNavigation() {
    if (currentURL() === lastURL) return;
    lastURL = currentURL();
    checkDestination();
    if (!editor) boot();
  }
  function initialize(tab) {
    tabState = tab || {};
    // GM tab state survives document reloads and cross-origin redirects, but is
    // isolated from independent browser tabs (unlike global saved watch settings).
    if (GM_getValue(STORAGE, null) === null) writeRules({ [PRESET.url]: PRESET });
    checkDestination();
    GM_registerMenuCommand('Page Watch: Manage watches', openManager);
    GM_addValueChangeListener(STORAGE, () => {
      const next = signature(readRules());
      if (next !== currentSignature) {
        currentSignature = next;
        if (!editor) boot();
        else {
          if (runner) runner.destroy();
          runner = null;
          const rules = readRules();
          const rule = rules[displayedRuleURL(rules)];
          if (rule?.pendingAlert) runner = runWatch({ ...DEFAULTS, ...rule, enabled: false });
        }
      }
    });
    lastURL = currentURL();
    window.addEventListener('popstate', followNavigation);
    setInterval(followNavigation, 500);
    boot();
  }

  function runWatch(CONFIG) {
    const originalTitle = document.title;
    let running = false;
    let lifecycle = 0;
    let timer = null;
    let startedAt = 0;
    let candidateSince = null;
    let alarmTimer = null;
    let notificationTimer = null;
    let nativeNotification = null;
    let notificationGeneration = 0;
    let nativeFailed = false;
    let alarmActive = false;
    let audio = null;

    // Shadow DOM keeps our notification text out of the watched page text.
    const host = document.createElement('div');
    host.id = 'page-watch';
    host.style.cssText =
      'position:fixed;right:12px;bottom:12px;z-index:2147483647;max-width:360px;';
    const root = host.attachShadow({ mode: 'open' });
    const box = document.createElement('section');
    box.style.cssText =
      'background:#17202a;color:#fff;border:2px solid #7f8c8d;border-radius:10px;padding:14px;font:14px/1.4 system-ui,sans-serif;box-shadow:0 3px 18px #0006;';
    const status = document.createElement('div');
    status.setAttribute('role', 'status');
    const deliveryStatus = document.createElement('div');
    deliveryStatus.style.cssText = 'font-size:12px;color:#d1d5db;margin-top:6px;';
    deliveryStatus.setAttribute('role', 'status');
    const notice = document.createElement('div');
    notice.setAttribute('role', 'alert');
    notice.style.cssText = 'margin-top:6px;white-space:pre-wrap;';
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;';
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
    const toggle = button('Enable', () => (running ? pause('Paused') : start()));
    if (currentURL() !== CONFIG.url) button('Open watched page', () => location.assign(CONFIG.url));
    button('Settings', openManager);
    button('Test alert', () => alertUser(!CONFIG.pendingAlert));
    const acknowledgeButton = button('Acknowledge', acknowledgeAlert);
    acknowledgeButton.hidden = true;
    box.append(status, notice, deliveryStatus, actions);
    root.append(box);
    document.documentElement.append(host);

    function save(state) {
      try {
        CONFIG.enabled = state === 'running';
        CONFIG.lastStatus = state;
        saveRule(CONFIG);
        return true;
      } catch {
        status.textContent =
          'Paused: browser storage is unavailable; cannot safely retain stop state.';
        return false;
      }
    }

    function stopTimers() {
      lifecycle++;
      running = false;
      clearInterval(timer);
      timer = null;
      candidateSince = null;
      toggle.textContent = 'Enable';
      if (!alarmActive) document.title = originalTitle;
    }

    function watchedTitle(countdown) {
      if (!alarmActive) document.title = '👁 WATCHING [' + countdown + '] — ' + originalTitle;
    }

    function pause(message) {
      stopTimers();
      silence();
      status.textContent = message;
      save('paused');
      forgetWatch(CONFIG.url);
    }

    function validate() {
      validateRule(CONFIG);
    }

    function normalizeText(text) {
      const result = text.replace(/\s+/g, ' ').trim();
      return CONFIG.caseSensitive ? result : result.toLowerCase();
    }

    function tick() {
      if (!running) return;
      try {
        if (normalizeURL(location.href) !== normalizeURL(CONFIG.url)) {
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
        const needle = normalizeText(CONFIG.text);
        const found = Array.from(document.querySelectorAll(CONFIG.selector)).some(
          (element) => !needle || normalizeText(element.textContent || '').includes(needle),
        );
        const satisfied = CONFIG.stopWhen === 'found' ? found : !found;
        if (satisfied) {
          candidateSince ??= now;
          const remaining = CONFIG.confirmSeconds * 1000 - (now - candidateSince);
          status.textContent =
            'Confirming condition: ' + Math.max(0, Math.ceil(remaining / 1000)) + 's…';
          watchedTitle('confirm ' + Math.max(0, Math.ceil(remaining / 1000)) + 's');
          if (remaining <= 0) {
            stopTimers(); // Stop first, even if notifications fail.
            status.textContent = 'Stopped: condition met. Enable to watch again.';
            if (CONFIG.requireExplicitDismissal)
              CONFIG.pendingAlert = {
                title: CONFIG.notificationTitle,
                text: CONFIG.notificationText,
                createdAt: Date.now(),
              };
            const persisted = save('stopped');
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
          // State remains running so monitoring continues on the next page load.
          location.reload();
        }
      } catch (error) {
        pause('Paused: configuration/page error — ' + error.message);
      }
    }

    function start() {
      if (currentURL() !== CONFIG.url) {
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
        validate();
      } catch (error) {
        pause('Paused: invalid configuration — ' + error.message);
        return;
      }
      if (!save('running')) return;
      running = true;
      toggle.textContent = 'Disable';
      startedAt = performance.now();
      candidateSince = null;
      const generation = lifecycle;
      status.textContent = 'Starting watch…';
      trackWatch(
        CONFIG.url,
        () => {
          if (!running || generation !== lifecycle) return;
          timer = setInterval(tick, 250);
          tick();
        },
        (error) => pause('Paused: could not save tab tracking — ' + error.message),
      );
    }

    function beep() {
      if (!CONFIG.sound || !alarmActive) return;
      try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        audio ??= new AudioContext();
        if (audio.state !== 'running') {
          audio.resume().catch(() => {});
          notice.textContent =
            '⚠ ' +
            (alarmMessage || '') +
            '\nSound may be blocked: allow audio autoplay for this site.';
          return;
        }
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
        oscillator.onended = () => {
          oscillator.disconnect();
          gain.disconnect();
        };
        oscillator.start(now);
        oscillator.stop(now + 0.5);
      } catch (error) {
        notice.textContent = '⚠ ' + alarmMessage + '\nSound unavailable: ' + error.message;
      }
    }

    let alarmMessage = '';
    function alertUser(test) {
      silence();
      alarmActive = true;
      const persistent = Boolean(CONFIG.pendingAlert) || CONFIG.requireExplicitDismissal;
      const title = test
        ? 'Page Watch — TEST'
        : CONFIG.pendingAlert?.title || CONFIG.notificationTitle;
      alarmMessage = test
        ? 'Test alert — monitoring state is unchanged.'
        : CONFIG.pendingAlert?.text || CONFIG.notificationText;
      notice.textContent =
        '⚠ ' + alarmMessage + (persistent ? '\nClick Acknowledge to dismiss this alert.' : '');
      acknowledgeButton.hidden = false;
      box.style.borderColor = '#ff5252';
      document.title =
        '⚠ ' + (persistent ? 'ACKNOWLEDGE' : test ? 'TEST' : 'CHECK PAGE') + ' — ' + originalTitle;
      nativeFailed = false;
      function notifyDesktop() {
        if (!alarmActive || !CONFIG.desktopNotification) return;
        const generation = ++notificationGeneration;
        const text = alarmMessage + (persistent ? ' — Open the page and click Acknowledge.' : '');
        const tag = 'page-watch-' + normalizeURL(CONFIG.url);
        const click = () => {
          if (!alarmActive || generation !== notificationGeneration) return;
          window.focus();
          // Native close events may be timeouts or replacements: never acknowledge them.
          if (!persistent) acknowledgeAlert();
        };
        function fallback(reason) {
          if (!alarmActive || generation !== notificationGeneration) return;
          deliveryStatus.textContent = reason + ' Using Tampermonkey notification.';
          try {
            GM_notification({
              title,
              text,
              tag,
              highlight: true,
              silent: false,
              timeout: persistent ? 0 : 10000,
              onclick: click,
            });
          } catch (error) {
            deliveryStatus.textContent =
              'Desktop delivery failed: ' + error.message + '. The page alert remains active.';
          }
        }
        if (CONFIG.notificationBackend === 'tampermonkey') {
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
          const notification = new Native(title, {
            body: text,
            tag,
            requireInteraction: persistent,
            renotify: persistent,
            silent: false,
          });
          nativeNotification = notification;
          notification.onclick = click;
          notification.onerror = () => {
            if (!alarmActive || generation !== notificationGeneration || nativeFailed) return;
            nativeFailed = true;
            closeNativeNotification();
            fallback('Native delivery failed.');
          };
          deliveryStatus.textContent =
            persistent && notification.requireInteraction !== true
              ? 'Native notification sent; browser did not confirm persistence. Repeating reminders remain active. In Firefox, check dom.webnotifications.requireinteraction.enabled.'
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
        try {
          const latest = readRules()[CONFIG.url];
          if (latest) saveRule({ ...latest, pendingAlert: null });
          CONFIG.pendingAlert = null;
          forgetWatch(CONFIG.url);
        } catch (error) {
          notice.textContent += '\nCould not save acknowledgement; try again: ' + error.message;
          return;
        }
      }
      silence();
    }

    function closeNativeNotification() {
      if (!nativeNotification) return;
      const notification = nativeNotification;
      nativeNotification = null;
      try {
        notification.onclick = null;
        notification.onerror = null;
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
      clearInterval(alarmTimer);
      alarmTimer = null;
      clearInterval(notificationTimer);
      notificationTimer = null;
      if (audio && audio.state === 'running') audio.suspend().catch(() => {});
      notice.textContent = '';
      acknowledgeButton.hidden = true;
      box.style.borderColor = '#7f8c8d';
      document.title = originalTitle;
    }

    if (CONFIG.pendingAlert) {
      status.textContent = 'Stopped: an alert is waiting for explicit acknowledgement.';
      alertUser(false);
    } else if (CONFIG.enabled) start();
    else
      status.textContent =
        CONFIG.lastStatus === 'stopped'
          ? 'Stopped: condition previously met. Enable to watch again.'
          : 'Disabled. Enable to start watching.';
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
  GM_getTab(initialize);
})();
