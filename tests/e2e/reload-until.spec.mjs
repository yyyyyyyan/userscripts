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
 * @param {Locator} panel
 * @param {{ condition: 'Appears' | 'Disappears', selector: string, interval?: number }} watch
 */
async function fillWatch(panel, { condition, selector, interval = 10 }) {
  await panel.getByLabel('Enabled', { exact: false }).check();
  await panel.getByLabel('Refresh interval (seconds)').fill(String(interval));
  await panel.getByLabel('Stop and notify when the target').selectOption({ label: condition });
  await panel.getByLabel('CSS selector', { exact: true }).fill(selector);
  await panel.getByText('Timing, safeguards and notification settings').click();
  await panel.getByLabel('Initial rendering wait (seconds)').fill('1');
  await panel.getByLabel('Condition confirmation time (seconds)').fill('0');
}

/**
 * Creates a watch for the page through the settings panel.
 * @param {Vm} vm
 * @param {Page} page
 * @param {{ condition: 'Appears' | 'Disappears', selector: string }} watch
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
        values[name] = typeof raw === 'string' && raw[0] === 'o' ? JSON.parse(raw.slice(1)) : raw;
      }
    }
    return values;
  });
}

/**
 * Starts counting writes to the script's values in Violentmonkey's extension storage, which
 * keeps each script's values in one `val:<scriptId>` entry. Calling it again restarts the count.
 * @param {Vm} vm
 * @returns {Promise<() => Promise<number>>} Reads the number of writes since the call.
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
      if (area === 'local') {
        counter.count += Object.keys(changes).filter((key) => key.startsWith('val:')).length;
      }
    });
  });
  return () => worker.evaluate(() => globalThis.reloadUntilWrites.count);
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
 * @param {Page} page
 * @returns {Locator}
 */
function widget(page) {
  return page.locator('#reload-until');
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

    await page.reload();
    await expect(widget(page).getByRole('status')).toBeVisible();
    await expect(page).toHaveTitle('Appear');
    await expect(widget(page).getByRole('button', { name: 'Acknowledge' })).toBeHidden();
  });
});

test('interval below 10 seconds is refused', async () => {
  await withScript(async ({ vm, site }) => {
    const page = await vm.context.newPage();
    await page.goto(`${site.origin}/appear`);
    const panel = await openPanel(vm, page);
    await fillWatch(panel, { condition: 'Appears', selector: '#target', interval: 5 });
    await panel.getByRole('button', { name: 'Save watch' }).click();

    const interval = panel.getByLabel('Refresh interval (seconds)');
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

test('reloads in another tab change no stored value and keep an alarm acknowledged', async () => {
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
    const writes = await countValueWrites(vm);
    await widget(pageA).getByRole('button', { name: 'Acknowledge' }).click();
    await expect(pageA).toHaveTitle('Appear');
    await expect
      .poll(writes, { message: 'the acknowledgement reaches storage' })
      .toBeGreaterThan(0);

    await countValueWrites(vm);
    const reloadsB = site.count('/appear?b');
    await expect.poll(() => site.count('/appear?b'), { timeout: 20_000 }).toBeGreaterThan(reloadsB);
    await expect(pageB).toHaveTitle(WATCHING, { timeout: 10_000 });
    await pageB.waitForTimeout(3000);
    expect(await writes(), 'storage writes while tab B reloaded').toBe(0);
    expect(pendingAlertOf(await storedValues(vm), `watch:${site.origin}/appear?a`)).toBeNull();

    await pageA.reload();
    await expect(widget(pageA).getByRole('status')).toBeVisible();
    await expect(widget(pageA).getByRole('button', { name: 'Acknowledge' })).toBeHidden();
    await expect(pageA).toHaveTitle('Appear');
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
    const url = panel.getByLabel('Page URL');
    await url.fill(`http://u:p@127.0.0.1:${site.port}/plain`);
    await panel.getByLabel('CSS selector', { exact: true }).fill('#target');
    await panel.getByRole('button', { name: 'Save watch' }).click();
    await expect(url).toHaveAttribute('aria-invalid', 'true');
    expect(errors).toEqual([]);
  });
});
