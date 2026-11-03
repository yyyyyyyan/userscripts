import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';

import { launchWithViolentmonkey, openMenu, openShadow } from './harness.mjs';
import { startFixtures } from './fixtures/reload-until/server.mjs';

/**
 * @typedef {import('@playwright/test').Page} Page
 * @typedef {import('@playwright/test').Locator} Locator
 * @typedef {Awaited<ReturnType<typeof launchWithViolentmonkey>>} Vm
 * @typedef {Awaited<ReturnType<typeof startFixtures>>} Site
 */

const source = await readFile(
  new URL('../../scripts/reload-until/reload-until.user.js', import.meta.url),
  'utf8',
);

test.use({ actionTimeout: 15_000 });

const WATCHING = /^\u{1F441}/u;
const ALARM = /^\u{26A0}/u;
const MENU_COMMAND = 'Reload Until: Manage watches';

/** The settings panel's field labels, exactly as shown. */
const LABELS = {
  url: 'Page address',
  condition: 'Raise the alarm when the element',
  selector: 'Element to look for',
  ready: 'Only check when the page has this element (optional)',
  enabled: 'Watch this page',
  interval: 'Seconds between reloads',
  settle: 'Seconds to wait after the page loads',
  confirm: 'Seconds the change must last',
  newWatch: 'New watch for this page',
};

/**
 * @param {(env: { vm: Vm, site: Site }) => Promise<void>} body
 */
async function withScript(body) {
  const site = await startFixtures();
  const vm = await launchWithViolentmonkey({ hostMap: { 'other.test': site.port } });
  try {
    await vm.install(openShadow(source));
    await body({ vm, site });
  } finally {
    await vm.close();
    await site.close();
  }
}

/**
 * Runs the script's menu command for the page and returns the settings panel.
 * @param {Vm} vm
 * @param {Page} page
 * @returns {Promise<Locator>}
 */
async function openPanel(vm, page) {
  // The popup sometimes opens without listing the page's commands, so it is retried.
  await expect(async () => {
    const popup = await openMenu(vm.context, vm.extensionId, page);
    try {
      await popup.getByText(MENU_COMMAND).click({ timeout: 5000 });
    } finally {
      await popup.close().catch(() => {});
    }
  }).toPass({ timeout: 45_000 });
  const panel = page.getByRole('dialog');
  await expect(panel).toBeVisible();
  return panel;
}

/**
 * @typedef {object} WatchFields
 * @property {'Appears' | 'Disappears'} condition
 * @property {string} selector
 * @property {number} [interval]
 * @property {'page' | 'page-and-desktop' | 'insistent'} [alertStyle]
 * @property {boolean} [enabled]
 */

/**
 * @param {Locator} panel
 * @param {string} label
 * @returns {Locator}
 */
function field(panel, label) {
  return panel.getByLabel(label, { exact: true });
}

/**
 * @param {Locator} panel
 * @param {WatchFields} watch
 */
async function fillWatch(
  panel,
  { condition, selector, interval = 10, alertStyle, enabled = true },
) {
  await field(panel, LABELS.enabled).setChecked(enabled);
  await field(panel, LABELS.interval).fill(String(interval));
  await field(panel, LABELS.condition).selectOption({ label: condition });
  await field(panel, LABELS.selector).fill(selector);
  if (alertStyle) {
    await panel.getByLabel('Alert style').selectOption(alertStyle);
  }
  await field(panel, LABELS.settle).fill('1');
  await field(panel, LABELS.confirm).fill('0');
}

/**
 * Creates a watch for the page through the settings panel.
 * @param {Vm} vm
 * @param {Page} page
 * @param {WatchFields} watch
 */
async function createWatch(vm, page, watch) {
  const panel = await openPanel(vm, page);
  await fillWatch(panel, watch);
  await panel.getByRole('button', { name: 'Save watch' }).click();
  await expect(panel).toBeHidden();
}

/**
 * Reads the script's stored values out of Violentmonkey's extension storage.
 * @param {Vm} vm
 * @returns {Promise<Record<string, unknown>>}
 */
async function storedValues(vm) {
  const [worker] = vm.context.serviceWorkers();
  return worker.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    /** @type {Record<string, unknown>} */
    const values = {};
    for (const [key, stored] of Object.entries(all)) {
      if (!key.startsWith('val:') || typeof stored !== 'object' || stored === null) {
        continue;
      }
      for (const [name, raw] of Object.entries(stored)) {
        if (typeof raw !== 'string') {
          values[name] = raw;
          continue;
        }
        // Violentmonkey prefixes each value with its type: object, boolean, number or string.
        const body = raw.slice(1);
        values[name] =
          raw[0] === 'o'
            ? JSON.parse(body)
            : raw[0] === 'b'
              ? body === 'true'
              : raw[0] === 'n'
                ? Number(body)
                : raw[0] === 's'
                  ? body
                  : raw;
      }
    }
    return values;
  });
}

/**
 * Starts counting changed values in Violentmonkey's extension storage, which keeps each
 * script's values in one `val:<scriptId>` entry. The reload `handoff` is left out: every
 * script-initiated reload writes it and the reloaded page clears it. Calling it again restarts
 * the count.
 * @param {Vm} vm
 * @returns {Promise<() => Promise<number>>} Reads the number of changed values since the call.
 */
async function countValueWrites(vm) {
  const [worker] = vm.context.serviceWorkers();
  await worker.evaluate(() => {
    if (globalThis.reloadUntilWrites) {
      globalThis.reloadUntilWrites.count = 0;
      return;
    }
    const counter = { count: 0 };
    globalThis.reloadUntilWrites = counter;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') {
        return;
      }
      for (const [key, change] of Object.entries(changes)) {
        if (!key.startsWith('val:')) {
          continue;
        }
        const before = change.oldValue ?? {};
        const after = change.newValue ?? {};
        for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
          if (name !== 'handoff' && before[name] !== after[name]) {
            counter.count += 1;
          }
        }
      }
    });
  });
  return () => worker.evaluate(() => globalThis.reloadUntilWrites.count);
}

/**
 * Lists the desktop notifications Violentmonkey is showing. Its `GM_notification` is built on
 * `chrome.notifications`, so the extension's own list is what the desktop was given.
 * @param {Vm} vm
 * @returns {Promise<string[]>} Notification ids.
 */
async function desktopNotifications(vm) {
  const [worker] = vm.context.serviceWorkers();
  return Object.keys(await worker.evaluate(() => chrome.notifications.getAll()));
}

/**
 * Starts counting the desktop notifications Violentmonkey creates. Calling it again restarts
 * the count.
 * @param {Vm} vm
 * @returns {Promise<() => Promise<number>>} Reads the number created since the call.
 */
async function countNotificationsSent(vm) {
  const [worker] = vm.context.serviceWorkers();
  await worker.evaluate(() => {
    if (globalThis.reloadUntilNotifications) {
      globalThis.reloadUntilNotifications.count = 0;
      return;
    }
    const counter = { count: 0 };
    globalThis.reloadUntilNotifications = counter;
    const create = chrome.notifications.create.bind(chrome.notifications);
    chrome.notifications.create = (...args) => {
      counter.count += 1;
      return create(...args);
    };
  });
  return () => worker.evaluate(() => globalThis.reloadUntilNotifications.count);
}

/**
 * @param {Record<string, unknown>} stored
 * @param {string} key
 * @returns {unknown} The watch's `pendingAlert`, or undefined when the watch isn't stored.
 */
function pendingAlertOf(stored, key) {
  const watch = stored[key];
  return typeof watch === 'object' && watch !== null && 'pendingAlert' in watch
    ? watch.pendingAlert
    : undefined;
}

/**
 * Waits until storage holds a redirect alarm on the watch and no leftover reload handoff.
 * Violentmonkey writes values to extension storage shortly after the page does.
 * @param {Vm} vm
 * @param {string} watched
 * @param {string} landedUrl
 */
async function expectRedirectStored(vm, watched, landedUrl) {
  await expect
    .poll(async () => {
      const stored = await storedValues(vm);
      return { pendingAlert: pendingAlertOf(stored, `watch:${watched}`), handoff: stored.handoff };
    })
    .toMatchObject({ pendingAlert: { kind: 'redirect', landedUrl }, handoff: undefined });
}

/**
 * @param {Page} page
 * @returns {Locator}
 */
function widget(page) {
  return page.locator('#reload-until');
}

/**
 * @param {Page} page
 * @returns {Promise<string>} The markup inside the widget's shadow root, opened by `openShadow`.
 */
function widgetShadowHtml(page) {
  return page.evaluate(() => document.getElementById('reload-until')?.shadowRoot?.innerHTML ?? '');
}

/**
 * @param {Page} page
 * @returns {Promise<number | null>} Seconds left before the next reload, from the tab title.
 */
async function countdown(page) {
  const match = /\[(\d+)s\]/.exec(await page.title());
  return match ? Number(match[1]) : null;
}

test('appears: alarm after the element shows up', async () => {
  await withScript(async ({ vm, site }) => {
    const page = await vm.context.newPage();
    await page.goto(`${site.origin}/appear`);
    await createWatch(vm, page, { condition: 'Appears', selector: '#target' });
    await expect(page).toHaveTitle(WATCHING);

    await expect(page).toHaveTitle(ALARM, { timeout: 30_000 });
    await expect(widget(page).getByRole('alert')).toBeVisible();
    await expect(widget(page).getByRole('button', { name: 'Acknowledge' })).toBeVisible();

    const requests = site.count('/appear');
    await page.waitForTimeout(15_000);
    expect(site.count('/appear')).toBe(requests);
    await expect(page).toHaveTitle(ALARM);
  });
});

test('disappears: alarm after the element goes away', async () => {
  await withScript(async ({ vm, site }) => {
    const page = await vm.context.newPage();
    await page.goto(`${site.origin}/disappear`);
    await expect(page.locator('#target')).toBeVisible();
    await createWatch(vm, page, { condition: 'Disappears', selector: '#target' });
    await expect(page).toHaveTitle(WATCHING);

    await expect(page).toHaveTitle(ALARM, { timeout: 30_000 });
    await expect(page.locator('#target')).toHaveCount(0);
    await expect(widget(page).getByRole('alert')).toBeVisible();
    expect(site.count('/disappear')).toBe(2);
  });
});

test('alarm survives reload and clears only on Acknowledge', async () => {
  await withScript(async ({ vm, site }) => {
    const page = await vm.context.newPage();
    await page.goto(`${site.origin}/appear`);
    await createWatch(vm, page, { condition: 'Appears', selector: '#target' });
    await expect(page).toHaveTitle(ALARM, { timeout: 30_000 });

    await page.reload();
    await expect(page).toHaveTitle(ALARM);
    await expect(widget(page).getByRole('alert')).toBeVisible();

    await widget(page).getByRole('button', { name: 'Acknowledge' }).click();
    await expect(page).toHaveTitle('Appear');
    await expect(widget(page).getByRole('alert')).toBeHidden();
    await expect(widget(page).getByRole('status')).not.toHaveText(/alert/i);

    // Acknowledging leaves the watch off, and a watch that is off shows nothing.
    await page.reload();
    await expect(page).toHaveTitle('Appear');
    await page.waitForTimeout(2000);
    await expect(widget(page)).toHaveCount(0);
  });
});

test('interval below 10 seconds is refused', async () => {
  await withScript(async ({ vm, site }) => {
    const page = await vm.context.newPage();
    await page.goto(`${site.origin}/appear`);
    const panel = await openPanel(vm, page);
    await fillWatch(panel, { condition: 'Appears', selector: '#target', interval: 5 });
    await panel.getByRole('button', { name: 'Save watch' }).click();

    const interval = field(panel, LABELS.interval);
    await expect(interval).toHaveAttribute('aria-invalid', 'true');
    await expect(interval).toHaveAccessibleErrorMessage(/at least 10 seconds/);
    await expect(panel).toBeVisible();
    const stored = Object.keys(await storedValues(vm));
    expect(stored.filter((key) => key.startsWith('watch:'))).toEqual([]);

    await page.reload();
    await expect(page).toHaveTitle('Appear');
    await page.waitForTimeout(3000);
    await expect(widget(page)).toHaveCount(0);
  });
});

test('fragment change keeps the watch', async () => {
  await withScript(async ({ vm, site }) => {
    const page = await vm.context.newPage();
    await page.goto(`${site.origin}/appear?fragment`);
    await createWatch(vm, page, { condition: 'Appears', selector: '#never-there' });
    await expect.poll(() => countdown(page), { timeout: 15_000 }).toBeLessThanOrEqual(5);
    const requests = site.count('/appear?fragment');

    await page.evaluate(() => {
      location.hash = 'x';
    });
    await expect(page).toHaveTitle(WATCHING);
    expect(await countdown(page)).toBeLessThanOrEqual(5);
    await expect(widget(page)).toHaveCount(1);

    // A restarted watch would wait the full 1 s settle plus 10 s interval again.
    await expect.poll(() => site.count('/appear?fragment'), { timeout: 8000 }).toBe(requests + 1);
  });
});

test('reloads in another tab change no watch and keep an alarm acknowledged', async () => {
  await withScript(async ({ vm, site }) => {
    const pageA = await vm.context.newPage();
    await pageA.goto(`${site.origin}/appear?a`);
    await createWatch(vm, pageA, { condition: 'Appears', selector: '#target' });

    const pageB = await vm.context.newPage();
    await pageB.goto(`${site.origin}/appear?b`);
    await createWatch(vm, pageB, { condition: 'Appears', selector: '#never-there' });
    await expect(pageB).toHaveTitle(WATCHING);

    await expect(pageA).toHaveTitle(ALARM, { timeout: 30_000 });
    await pageA.bringToFront();
    await widget(pageA).getByRole('button', { name: 'Acknowledge' }).click();
    await expect(pageA).toHaveTitle('Appear');
    // Violentmonkey writes values to extension storage some time after the page does, so the
    // count starts only once the acknowledgement, and every write before it, has landed.
    await expect
      .poll(async () => pendingAlertOf(await storedValues(vm), `watch:${site.origin}/appear?a`), {
        message: 'the acknowledgement reaches storage',
      })
      .toBeNull();

    const writes = await countValueWrites(vm);
    const reloadsB = site.count('/appear?b');
    await expect.poll(() => site.count('/appear?b'), { timeout: 20_000 }).toBeGreaterThan(reloadsB);
    await expect(pageB).toHaveTitle(WATCHING, { timeout: 10_000 });
    await pageB.waitForTimeout(3000);
    expect(await writes(), 'storage writes while tab B reloaded').toBe(0);
    expect(pendingAlertOf(await storedValues(vm), `watch:${site.origin}/appear?a`)).toBeNull();

    await pageA.reload();
    await expect(pageA).toHaveTitle('Appear');
    await pageA.waitForTimeout(2000);
    await expect(widget(pageA)).toHaveCount(0);
  });
});

test('unwatched pages are left alone', async () => {
  await withScript(async ({ vm, site }) => {
    const page = await vm.context.newPage();
    await page.goto(`${site.origin}/plain`);
    await page.waitForTimeout(12_000);

    await expect(widget(page)).toHaveCount(0);
    await expect(page).toHaveTitle('Plain');
    expect(site.count('/plain')).toBe(1);
    await openPanel(vm, page);
  });
});

test("a URL with credentials doesn't break the script", async () => {
  await withScript(async ({ vm, site }) => {
    const page = await vm.context.newPage();
    /** @type {string[]} */
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`http://u:p@127.0.0.1:${site.port}/plain`);
    await expect(page).toHaveTitle('Plain');

    const panel = await openPanel(vm, page);
    const url = field(panel, LABELS.url);
    await url.fill(`http://u:p@127.0.0.1:${site.port}/plain`);
    await field(panel, LABELS.selector).fill('#target');
    await panel.getByRole('button', { name: 'Save watch' }).click();
    await expect(url).toHaveAttribute('aria-invalid', 'true');
    expect(errors).toEqual([]);
  });
});

test('same-origin redirect raises the alarm with the full watched URL', async () => {
  await withScript(async ({ vm, site }) => {
    const page = await vm.context.newPage();
    const watched = `${site.origin}/redirect`;
    await page.goto(watched);
    await createWatch(vm, page, { condition: 'Appears', selector: '#never-there' });
    await expect(page).toHaveTitle(WATCHING);

    await page.waitForURL(`${site.origin}/login`, { timeout: 30_000 });
    await expect(page).toHaveTitle(ALARM);
    await expect(widget(page).getByRole('alert')).toContainText(watched);
    await expectRedirectStored(vm, watched, `${site.origin}/login`);
    await expect
      .poll(() => desktopNotifications(vm), { message: 'the alarm reaches the desktop' })
      .toHaveLength(1);

    const sent = await countNotificationsSent(vm);
    const reopened = page.waitForRequest(watched);
    await widget(page).getByRole('button', { name: 'Open watched page' }).click();
    await reopened;
    await page.waitForURL(`${site.origin}/login`);
    await expect(page).toHaveTitle(ALARM);
    await expect.poll(sent, { message: 'the new landing page sends it once' }).toBe(1);
    await expect.poll(() => desktopNotifications(vm)).toHaveLength(1);
  });
});

test('cross-origin redirect shows only the watched host', async () => {
  await withScript(async ({ vm, site }) => {
    const page = await vm.context.newPage();
    const watched = `${site.origin}/xredirect`;
    await page.goto(watched);
    await createWatch(vm, page, { condition: 'Appears', selector: '#never-there' });
    await expect(page).toHaveTitle(WATCHING);

    await page.waitForURL(`http://other.test:${site.port}/login`, { timeout: 30_000 });
    await expect(page).toHaveTitle(ALARM);
    await expect(widget(page).getByRole('alert')).toContainText('127.0.0.1');
    await expect(widget(page).getByRole('button', { name: 'Open watched page' })).toBeVisible();
    expect(await widgetShadowHtml(page)).not.toContain('/xredirect');
    expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toContain(
      '/xredirect',
    );
    expect(await page.evaluate(() => JSON.stringify({ ...sessionStorage }))).not.toContain(
      '/xredirect',
    );
    await expectRedirectStored(vm, watched, `http://other.test:${site.port}/login`);

    const reopened = page.waitForRequest(watched);
    await widget(page).getByRole('button', { name: 'Open watched page' }).click();
    await reopened;
  });
});

test("reloading another site's page while the watched page reloads raises no alarm", async () => {
  await withScript(async ({ vm, site }) => {
    const page = await vm.context.newPage();
    const watched = `${site.origin}/slow`;
    await page.goto(watched);
    await createWatch(vm, page, { condition: 'Appears', selector: '#never-there' });
    await expect(page).toHaveTitle(WATCHING);
    const other = await vm.context.newPage();
    await other.goto(`http://other.test:${site.port}/plain`);

    // The watched page answers slowly, so this reload ends while the handoff is still stored.
    await page.waitForRequest(watched, { timeout: 30_000 });
    await other.reload();
    await expect(other).toHaveTitle('Plain');
    await other.waitForTimeout(5000);

    await expect(other).toHaveTitle('Plain');
    await expect(widget(other)).toHaveCount(0);
    await expect(page).toHaveTitle(WATCHING);
    await expect
      .poll(async () => {
        const stored = await storedValues(vm);
        const watch = /** @type {{ enabled?: boolean } | undefined} */ (stored[`watch:${watched}`]);
        return {
          pendingAlert: pendingAlertOf(stored, `watch:${watched}`),
          enabled: watch?.enabled,
          handoff: stored.handoff,
        };
      })
      .toEqual({ pendingAlert: null, enabled: true, handoff: undefined });
  });
});

test('leaving on purpose pauses instead of alarming', async () => {
  await withScript(async ({ vm, site }) => {
    const page = await vm.context.newPage();
    const watched = `${site.origin}/appear?leave`;
    await page.goto(watched);
    await createWatch(vm, page, { condition: 'Appears', selector: '#never-there' });
    await expect(page).toHaveTitle(WATCHING);

    await page.goto(`${site.origin}/plain`);
    await page.waitForTimeout(3000);
    await expect(page).toHaveTitle('Plain');
    await expect(widget(page)).toHaveCount(0);
    expect(pendingAlertOf(await storedValues(vm), `watch:${watched}`)).toBeNull();

    const requests = site.count('/appear?leave');
    await page.goBack();
    await expect(page).toHaveTitle(WATCHING);
    await expect
      .poll(() => site.count('/appear?leave'), { timeout: 20_000 })
      .toBeGreaterThan(requests);
    await expect(page).toHaveTitle(WATCHING);
  });
});

test("in-page navigation away keeps the page's own title", async () => {
  await withScript(async ({ vm, site }) => {
    const page = await vm.context.newPage();
    await page.goto(`${site.origin}/appear?spa`);
    await createWatch(vm, page, { condition: 'Appears', selector: '#never-there' });
    await expect(page).toHaveTitle(WATCHING);

    await page.evaluate(() => {
      history.pushState(null, '', '/plain?spa');
      document.title = 'Another view';
    });
    await page.waitForTimeout(2000);
    await expect(page).toHaveTitle('Another view');
    await expect(widget(page)).toHaveCount(0);
  });
});

test('a pending alarm stays with the tab when it moves to another page of the site', async () => {
  await withScript(async ({ vm, site }) => {
    const page = await vm.context.newPage();
    await page.goto(`${site.origin}/appear?moves`);
    await createWatch(vm, page, { condition: 'Appears', selector: '#target' });
    await expect(page).toHaveTitle(ALARM, { timeout: 30_000 });

    await page.evaluate(() => {
      location.href = '/plain';
    });
    await page.waitForURL(`${site.origin}/plain`);
    await expect(page).toHaveTitle(ALARM);
    await expect(widget(page).getByRole('alert')).toBeVisible();

    await widget(page).getByRole('button', { name: 'Acknowledge' }).click();
    await expect(widget(page)).toHaveCount(0);
    await expect(page).toHaveTitle('Plain');
    await page.reload();
    await page.waitForTimeout(2000);
    await expect(widget(page)).toHaveCount(0);
  });
});

test('page JavaScript cannot read watches', async () => {
  await withScript(async ({ vm, site }) => {
    const page = await vm.context.newPage();
    const watched = `${site.origin}/appear?private`;
    await page.goto(watched);
    await createWatch(vm, page, { condition: 'Appears', selector: '#never-there' });
    await expect(page).toHaveTitle(WATCHING);

    await vm.install(source);
    // The script runs in the page's own JavaScript world, so a page that wraps attachShadow
    // before the script runs receives even a closed shadow root.
    await page.addInitScript(() => {
      /** @type {ShadowRoot[]} */
      const roots = [];
      Object.assign(window, { capturedRoots: roots });
      const attach = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function (init) {
        const root = attach.call(this, init);
        roots.push(root);
        return root;
      };
    });
    await page.reload();
    await expect.poll(() => countdown(page), { timeout: 15_000 }).not.toBeNull();
    expect(
      await page.evaluate(() => document.querySelector('#reload-until')?.shadowRoot === null),
    ).toBe(true);
    const capturedRoots = () => page.evaluate(() => window.capturedRoots.length);
    expect(await capturedRoots()).toBe(1);

    /** @param {string} label */
    const clickFromPage = (label) =>
      page.evaluate((text) => {
        for (const button of window.capturedRoots[0].querySelectorAll('button')) {
          if (button.textContent === text) {
            button.click();
          }
        }
      }, label);

    await page.evaluate(() =>
      document
        .querySelector('#reload-until')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true })),
    );
    await clickFromPage('Settings');
    await page.waitForTimeout(1000);
    expect(await capturedRoots(), 'a settings panel was opened').toBe(1);
    expect(await countdown(page), 'refreshing was suspended').not.toBeNull();

    await clickFromPage('Disable');
    await page.waitForTimeout(1000);
    await expect(page).toHaveTitle(WATCHING);
    const watch = /** @type {{ enabled?: boolean }} */ (
      (await storedValues(vm))[`watch:${watched}`]
    );
    expect(watch.enabled).toBe(true);
  });
});

test("panel lists only this site's watches", async () => {
  await withScript(async ({ vm, site }) => {
    const other = await vm.context.newPage();
    const otherWatched = `http://other.test:${site.port}/appear?other`;
    await other.goto(otherWatched);
    await createWatch(vm, other, { condition: 'Appears', selector: '#never-there' });
    await expect(other).toHaveTitle(WATCHING);

    const page = await vm.context.newPage();
    const mine = `${site.origin}/appear?mine`;
    await page.goto(mine);
    await createWatch(vm, page, { condition: 'Appears', selector: '#never-there' });
    await expect
      .poll(async () => Object.keys(await storedValues(vm)))
      .toEqual(expect.arrayContaining([`watch:${mine}`, `watch:${otherWatched}`]));

    const panel = await openPanel(vm, page);
    const options = await panel.getByLabel('Saved watches').locator('option').allTextContents();
    expect(options.some((text) => text.includes(mine))).toBe(true);
    expect(options.filter((text) => text.includes('other.test'))).toEqual([]);
    const everything = await page.evaluate(() =>
      [
        document.documentElement.outerHTML,
        ...Array.from(document.querySelectorAll('*'), (element) => element.shadowRoot?.innerHTML),
      ].join('\n'),
    );
    expect(everything).toContain('/appear?mine');
    expect(everything).not.toContain('other.test');

    await panel.getByLabel('Saved watches').selectOption({ label: LABELS.newWatch });
    const url = field(panel, LABELS.url);
    await url.fill(`http://other.test:${site.port}/plain`);
    await field(panel, LABELS.selector).fill('#target');
    await panel.getByRole('button', { name: 'Save watch' }).click();
    await expect(url).toHaveAttribute('aria-invalid', 'true');
    await expect(url).toHaveAccessibleErrorMessage(/this site/);
  });
});

test('panel is styled on a strict-CSP page', async () => {
  await withScript(async ({ vm, site }) => {
    const page = await vm.context.newPage();
    await page.goto(`${site.origin}/csp`);
    const panel = await openPanel(vm, page);
    expect(await panel.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(
      'rgba(0, 0, 0, 0)',
    );
    await fillWatch(panel, { condition: 'Appears', selector: '#never-there' });
    await panel.getByRole('button', { name: 'Save watch' }).click();
    await expect(panel).toBeHidden();
    const box = widget(page).locator('section');
    await expect(box).toBeVisible();
    expect(await box.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(
      'rgba(0, 0, 0, 0)',
    );
  });
});

test('Test alert does not re-fire a pending alarm', async () => {
  await withScript(async ({ vm, site }) => {
    const page = await vm.context.newPage();
    await page.goto(`${site.origin}/appear`);
    await createWatch(vm, page, { condition: 'Appears', selector: '#target' });
    await expect(page).toHaveTitle(ALARM, { timeout: 30_000 });
    await expect.poll(() => desktopNotifications(vm)).toHaveLength(1);
    const before = await desktopNotifications(vm);
    const sent = await countNotificationsSent(vm);

    await expect(widget(page).getByRole('button', { name: 'Test alert' })).toBeHidden();
    await page.waitForTimeout(2000);
    expect(await sent()).toBe(0);
    expect(await desktopNotifications(vm)).toEqual(before);
    await expect(page).toHaveTitle(ALARM);
  });
});

test('Acknowledge closes the desktop notification', async () => {
  await withScript(async ({ vm, site }) => {
    const page = await vm.context.newPage();
    await page.goto(`${site.origin}/appear`);
    await createWatch(vm, page, { condition: 'Appears', selector: '#target' });
    await expect(page).toHaveTitle(ALARM, { timeout: 30_000 });
    await expect.poll(() => desktopNotifications(vm)).toHaveLength(1);

    await widget(page).getByRole('button', { name: 'Acknowledge' }).click();
    await expect.poll(() => desktopNotifications(vm)).toEqual([]);
  });
});

test('closing Settings keeps the alarm quiet, and a reload sends it to the desktop once', async () => {
  await withScript(async ({ vm, site }) => {
    const page = await vm.context.newPage();
    await page.goto(`${site.origin}/appear`);
    await createWatch(vm, page, { condition: 'Appears', selector: '#target' });
    await expect(page).toHaveTitle(ALARM, { timeout: 30_000 });
    await expect.poll(() => desktopNotifications(vm)).toHaveLength(1);
    const sent = await countNotificationsSent(vm);

    const panel = await openPanel(vm, page);
    await panel.getByRole('button', { name: 'Close' }).click();
    await expect(panel).toBeHidden();
    await expect(widget(page).getByRole('alert')).toBeVisible();
    await page.waitForTimeout(2000);
    expect(await sent(), 'notifications sent after closing Settings').toBe(0);

    await page.reload();
    await expect(page).toHaveTitle(ALARM);
    await expect(widget(page).getByRole('alert')).toBeVisible();
    await expect.poll(sent).toBe(1);
    await page.waitForTimeout(2000);
    expect(await sent(), 'notifications sent by the reloaded page').toBe(1);
    expect(await desktopNotifications(vm)).toHaveLength(1);
  });
});

test('page alert style sends no desktop notification', async () => {
  await withScript(async ({ vm, site }) => {
    const page = await vm.context.newPage();
    await page.goto(`${site.origin}/appear`);
    const sent = await countNotificationsSent(vm);
    await createWatch(vm, page, { condition: 'Appears', selector: '#target', alertStyle: 'page' });
    await expect(page).toHaveTitle(ALARM, { timeout: 30_000 });
    await expect(widget(page).getByRole('alert')).toBeVisible();
    await page.waitForTimeout(2000);
    expect(await sent()).toBe(0);
  });
});

test('insistent alert style repeats the desktop notification until Acknowledge', async () => {
  test.setTimeout(240_000);
  await withScript(async ({ vm, site }) => {
    const page = await vm.context.newPage();
    await page.goto(`${site.origin}/appear`);
    const sent = await countNotificationsSent(vm);
    await createWatch(vm, page, {
      condition: 'Appears',
      selector: '#target',
      alertStyle: 'insistent',
    });
    await expect(page).toHaveTitle(ALARM, { timeout: 30_000 });
    await expect.poll(sent).toBe(1);

    await expect.poll(sent, { timeout: 70_000, intervals: [1000] }).toBe(2);
    expect(await desktopNotifications(vm)).toHaveLength(1);
    await widget(page).getByRole('button', { name: 'Acknowledge' }).click();
    await expect.poll(() => desktopNotifications(vm)).toEqual([]);

    // Reminders are due every 60 s from the alarm, so this wait passes the next one.
    await page.waitForTimeout(62_000);
    expect(await sent(), 'notifications sent after Acknowledge').toBe(2);
    expect(await desktopNotifications(vm)).toEqual([]);
  });
});

test('with permission, the alarm uses a site notification that asks to stay until clicked', async () => {
  await withScript(async ({ vm, site }) => {
    const page = await vm.context.newPage();
    // Stands in for the browser's notifications, which the script uses from the page's world.
    await page.addInitScript(() => {
      /** @type {{ created: { title: string, options: NotificationOptions }[], closed: number }} */
      const record = { created: [], closed: 0 };
      class FakeNotification extends EventTarget {
        static get permission() {
          return sessionStorage.getItem('test-notification-permission') ?? 'default';
        }
        static requestPermission() {
          sessionStorage.setItem('test-notification-permission', 'granted');
          return Promise.resolve(FakeNotification.permission);
        }
        /**
         * @param {string} title
         * @param {NotificationOptions} options
         */
        constructor(title, options) {
          super();
          record.created.push({ title, options });
        }
        close() {
          record.closed += 1;
        }
      }
      Object.assign(window, { Notification: FakeNotification, notificationRecord: record });
    });
    await page.goto(`${site.origin}/appear`);
    const sent = await countNotificationsSent(vm);

    const panel = await openPanel(vm, page);
    const allow = panel.getByRole('button', { name: 'Allow desktop notifications' });
    await expect(allow).toHaveAccessibleDescription(/not asked yet/);
    await allow.click();
    await expect(allow).toHaveAccessibleDescription(/allowed/);
    await expect(allow).toBeDisabled();
    await fillWatch(panel, { condition: 'Appears', selector: '#target' });
    await panel.getByRole('button', { name: 'Save watch' }).click();
    await expect(panel).toBeHidden();

    await expect(page).toHaveTitle(ALARM, { timeout: 30_000 });
    const record = () => page.evaluate(() => window.notificationRecord);
    await expect.poll(async () => (await record()).created.length).toBe(1);
    const [notification] = (await record()).created;
    expect(notification.title).toBe('Reload Until: the page changed');
    expect(notification.options).toMatchObject({ requireInteraction: true });
    expect(notification.options.tag).toMatch(/^reload-until-alarm-\d+$/);
    expect(notification.options.body).not.toMatch(/critical/i);
    expect(await sent(), 'manager notifications').toBe(0);

    await widget(page).getByRole('button', { name: 'Acknowledge' }).click();
    await expect.poll(async () => (await record()).closed).toBe(1);
  });
});

/**
 * @param {Page} page
 * @returns {Promise<boolean>} Whether keyboard focus is inside the settings panel.
 */
function focusInPanel(page) {
  return page.evaluate(
    () => document.activeElement?.shadowRoot?.querySelector('[role="dialog"]') != null,
  );
}

test('panel has three groups', async () => {
  await withScript(async ({ vm, site }) => {
    const page = await vm.context.newPage();
    await page.goto(`${site.origin}/plain`);
    const panel = await openPanel(vm, page);

    await expect(panel).toHaveAttribute('aria-modal', 'true');
    await expect(panel.getByRole('heading', { level: 3 })).toHaveText([
      'What to watch',
      'When',
      'How to alert',
    ]);
    /** @type {Record<string, string[]>} */
    const groups = {
      'What to watch': [LABELS.url, LABELS.condition, LABELS.selector, LABELS.ready],
      When: [LABELS.enabled, LABELS.interval, LABELS.settle, LABELS.confirm],
      'How to alert': ['Alert style'],
    };
    for (const [name, labels] of Object.entries(groups)) {
      const group = panel.getByRole('group', { name, exact: true });
      for (const label of labels) {
        await expect(field(group, label), `${label} is under ${name}`).toBeVisible();
      }
    }
    const labels = await panel.locator('label').allTextContents();
    expect(
      labels.filter((text) => /\b(URL|CSS|selector|rendering|condition)\b/i.test(text)),
    ).toEqual([]);
  });
});

test('disappears asks for a page-ready guard', async () => {
  await withScript(async ({ vm, site }) => {
    const page = await vm.context.newPage();
    await page.goto(`${site.origin}/disappear`);
    const panel = await openPanel(vm, page);
    const prompt = panel.getByText(/sign-in page/);
    await expect(prompt).toBeHidden();

    await field(panel, LABELS.condition).selectOption({ label: 'Disappears' });
    await expect(prompt).toBeVisible();
    const ready = field(panel, LABELS.ready);
    await expect(ready).toHaveAccessibleDescription(/sign-in page/);

    await ready.fill('h1');
    await expect(prompt).toBeHidden();
    await ready.fill('');
    await expect(prompt).toBeVisible();
    await field(panel, LABELS.condition).selectOption({ label: 'Appears' });
    await expect(prompt).toBeHidden();
  });
});

test('unsaved edits warn before switching or closing', async () => {
  await withScript(async ({ vm, site }) => {
    const page = await vm.context.newPage();
    const watched = `${site.origin}/appear?edits`;
    await page.goto(watched);
    await createWatch(vm, page, { condition: 'Appears', selector: '#never-there' });

    const panel = await openPanel(vm, page);
    const picker = panel.getByLabel('Saved watches');
    await expect(picker).toHaveValue(watched);
    const selector = field(panel, LABELS.selector);
    await selector.fill('#edited');
    const warning = panel.getByRole('alert').filter({ hasText: /unsaved/i });

    await picker.selectOption({ label: LABELS.newWatch });
    await expect(warning).toBeVisible();
    await expect(picker).toHaveValue(watched);
    await expect(selector).toHaveValue('#edited');
    await panel.getByRole('button', { name: 'Keep editing' }).click();
    await expect(warning).toBeHidden();
    await expect(selector).toHaveValue('#edited');

    await panel.getByRole('button', { name: 'Close' }).click();
    await expect(warning).toBeVisible();
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: 'Discard changes' }).click();
    await expect(panel).toBeHidden();
    const watch = /** @type {{ selector?: string }} */ (
      (await storedValues(vm))[`watch:${watched}`]
    );
    expect(watch.selector).toBe('#never-there');
  });
});

test('Escape closes the panel and focus returns to the page', async () => {
  await withScript(async ({ vm, site }) => {
    const page = await vm.context.newPage();
    await page.goto(`${site.origin}/login`);
    await page.locator('input[name="user"]').focus();
    const panel = await openPanel(vm, page);
    await expect(panel).toHaveAttribute('aria-modal', 'true');
    expect(await focusInPanel(page), 'the panel takes focus').toBe(true);

    for (let step = 0; step < 25; step++) {
      await page.keyboard.press('Tab');
    }
    expect(await focusInPanel(page), 'Tab stays in the panel').toBe(true);
    for (let step = 0; step < 25; step++) {
      await page.keyboard.press('Shift+Tab');
    }
    expect(await focusInPanel(page), 'Shift+Tab stays in the panel').toBe(true);

    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(page.locator('input[name="user"]')).toBeFocused();
  });
});

test('first-run hint shows once', async () => {
  await withScript(async ({ vm, site }) => {
    const page = await vm.context.newPage();
    await page.goto(`${site.origin}/plain`);
    const tip = page.getByRole('region', { name: 'Reload Until tip', exact: true });
    await expect(tip).toContainText(MENU_COMMAND);
    await expect(tip).toContainText(/your userscript manager.s menu/);
    await expect.poll(async () => (await storedValues(vm))['hint-shown']).toBe(true);

    await tip.getByRole('button', { name: 'Dismiss' }).click();
    await expect(tip).toHaveCount(0);
    await page.reload();
    await expect(page).toHaveTitle('Plain');
    await page.waitForTimeout(2000);
    await expect(tip).toHaveCount(0);

    const another = await vm.context.newPage();
    await another.goto(`${site.origin}/appear`);
    await another.waitForTimeout(2000);
    await expect(another.getByRole('region', { name: 'Reload Until tip' })).toHaveCount(0);
  });
});

test('disabled watch shows nothing', async () => {
  await withScript(async ({ vm, site }) => {
    const page = await vm.context.newPage();
    const watched = `${site.origin}/appear?off`;
    await page.goto(watched);
    await createWatch(vm, page, {
      condition: 'Appears',
      selector: '#never-there',
      enabled: false,
    });
    await page.waitForTimeout(2000);
    await expect(widget(page)).toHaveCount(0);
    await expect(page).toHaveTitle('Appear');
    await page.reload();
    await page.waitForTimeout(2000);
    await expect(widget(page)).toHaveCount(0);
    await expect(page).toHaveTitle('Appear');

    const panel = await openPanel(vm, page);
    await field(panel, LABELS.enabled).check();
    await panel.getByRole('button', { name: 'Save watch' }).click();
    await expect(page).toHaveTitle(WATCHING);
    await widget(page).getByRole('button', { name: 'Disable' }).click();
    await expect(widget(page).getByRole('status')).toHaveText(/Paused/);
    await page.reload();
    await expect(page).toHaveTitle('Appear');
    await page.waitForTimeout(2000);
    await expect(widget(page)).toHaveCount(0);
  });
});

test('widget is labeled and collapsible', async () => {
  await withScript(async ({ vm, site }) => {
    const page = await vm.context.newPage();
    await page.goto(`${site.origin}/appear?collapse`);
    await createWatch(vm, page, { condition: 'Appears', selector: '#never-there' });
    const box = widget(page).getByRole('region', { name: 'Reload Until', exact: true });
    await expect(box).toBeVisible();

    const hide = box.getByRole('button', { name: 'Hide' });
    await expect(hide).toHaveAttribute('aria-expanded', 'true');
    await hide.click();
    await expect(box.getByRole('status')).toBeHidden();
    await expect(box).toBeVisible();
    await expect(page).toHaveTitle(WATCHING);

    await page.reload();
    await expect(page).toHaveTitle(WATCHING);
    const show = widget(page).getByRole('button', { name: 'Show' });
    await expect(show).toHaveAttribute('aria-expanded', 'false');
    await expect(widget(page).getByRole('status')).toBeHidden();
    await show.click();
    await expect(widget(page).getByRole('status')).toBeVisible();
  });
});
