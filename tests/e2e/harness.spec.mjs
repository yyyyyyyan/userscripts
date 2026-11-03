import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';

import { launchWithViolentmonkey, openMenu, openShadow, serve } from './harness.mjs';

const probe = await readFile(new URL('./fixtures/probe.user.js', import.meta.url), 'utf8');
const menuProbe = await readFile(new URL('./fixtures/menu-probe.user.js', import.meta.url), 'utf8');

test('installs a script and persists GM storage across a reload', async () => {
  const site = await serve({
    '/': '<!doctype html><title>fixture</title><p>hello</p>',
  });
  const vm = await launchWithViolentmonkey();
  try {
    await vm.install(probe);
    const page = await vm.context.newPage();
    await page.goto(`${site.origin}/`);
    await expect(page.locator('html')).toHaveAttribute('data-probe', '1');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-probe', '2');
  } finally {
    await vm.close();
    await site.close();
  }
});

test('maps a host name to a local server', async () => {
  const site = await serve({ '/': '<!doctype html><title>mapped</title>' });
  const vm = await launchWithViolentmonkey({ hostMap: { 'example.test': site.port } });
  try {
    const page = await vm.context.newPage();
    await page.goto('http://example.test/');
    await expect(page).toHaveTitle('mapped');
  } finally {
    await vm.close();
    await site.close();
  }
});

test('openMenu opens the popup for the page and runs a menu command', async () => {
  const site = await serve({ '/': '<!doctype html><title>menu</title><p>hello</p>' });
  const vm = await launchWithViolentmonkey();
  try {
    await vm.install(menuProbe);
    const page = await vm.context.newPage();
    await page.goto(`${site.origin}/`);
    const popup = await openMenu(vm.context, vm.extensionId, page);
    await popup.getByText('Mark the page').click();
    await expect(page.locator('html')).toHaveAttribute('data-menu-clicked', 'yes');
  } finally {
    await vm.close();
    await site.close();
  }
});

test('serve answers function routes and 404s unknown paths', async () => {
  const site = await serve({
    '/fn': (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('from function');
    },
  });
  try {
    expect(await (await fetch(`${site.origin}/fn`)).text()).toBe('from function');
    expect((await fetch(`${site.origin}/missing`)).status).toBe(404);
  } finally {
    await site.close();
  }
});

test('openShadow switches exactly one closed shadow declaration', () => {
  const closed = "const SHADOW_MODE = 'closed';\nattach({ mode: SHADOW_MODE });\n";
  expect(openShadow(closed)).toBe("const SHADOW_MODE = 'open';\nattach({ mode: SHADOW_MODE });\n");
  expect(() => openShadow('no declaration')).toThrow(/found 0/);
  expect(() => openShadow(`${closed}${closed}`)).toThrow(/found 2/);
});
