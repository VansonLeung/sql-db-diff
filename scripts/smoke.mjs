import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, rm, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const userData = await mkdtemp(join(tmpdir(), 'sql-diff-ui-'));
const env = { ...process.env, SQL_DB_DIFF_TEST_USER_DATA: userData };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch(
  process.env.SQL_DB_DIFF_PACKAGED_APP
    ? {
        executablePath: process.env.SQL_DB_DIFF_PACKAGED_APP,
        args: [`--user-data-dir=${userData}`],
        env,
      }
    : { args: ['.'], env },
);
try {
  expect(await realpath(await app.evaluate(({ app }) => app.getPath('userData')))).toBe(
    await realpath(userData),
  );
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addStyleTag({
    content: '*, *::before, *::after { transition: none !important; animation: none !important; }',
  });
  await expect(page.getByRole('heading', { name: 'Compare databases' })).toBeVisible();
  await page.getByRole('button', { name: 'Explore demo databases' }).click();
  await expect(page.getByRole('button', { name: /Load tables/ })).toBeEnabled();
  await page.getByRole('button', { name: /Load tables/ }).click();
  await expect(page.getByRole('heading', { name: 'customers', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Compare databases/ }).click();
  await expect(page.getByText('Comparison complete · 4 tables')).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole('tab', { name: /Row differences/ })).toBeVisible();
  await expect(page.getByText('Changed 1', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Expand row' }).first().click();
  await expect(page.getByText('enterprise', { exact: true })).toBeVisible();
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/comparison.png', fullPage: true });
  await page.locator('.bookmark').filter({ hasText: 'Demo · Source' }).hover();
  await page.getByRole('button', { name: 'Edit Demo · Source' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByLabel('Bookmark name').fill('Edited demo source');
  await page.getByRole('button', { name: 'Save connection' }).click();
  await expect(page.getByText('Edited demo source', { exact: true }).first()).toBeVisible();
  const bytes = await readFile(join(userData, 'bookmarks.enc'));
  const decrypts = await app.evaluate(
    ({ safeStorage }, encoded) =>
      safeStorage.decryptString(Buffer.from(encoded, 'base64')).includes('Edited demo source'),
    bytes.toString('base64'),
  );
  const encrypted = { encrypted: !bytes.toString().includes('Edited demo source'), decrypts };
  expect(encrypted).toEqual({ encrypted: true, decrypts: true });
  const cancelResult = await page.evaluate(async () => {
    const bookmarks = await window.dbDiff.bookmarks.list();
    const l = bookmarks.find((b) => b.id === 'demo-source'),
      r = bookmarks.find((b) => b.id === 'demo-target');
    const left = { bookmarkId: l.id, database: l.file },
      right = { bookmarkId: r.id, database: r.file };
    const tables = await window.dbDiff.inspect(left);
    const id = await window.dbDiff.compare({
      left,
      right,
      tables: tables.map((t) => t.id),
      keys: {},
      schemaOnly: false,
    });
    await window.dbDiff.cancel();
    return !!id;
  });
  expect(cancelResult).toBe(true);
  const temporaryFiles = await readdir(join(userData, 'comparisons'));
  expect(temporaryFiles).toEqual([]);
  await page.evaluate(() =>
    window.dbDiff.bookmarks.save({
      id: 'settings-check',
      name: 'Settings check',
      engine: 'mysql',
      ssl: { enabled: true, ca: 'stored CA', key: 'line one\nline two' },
      ssh: { enabled: true, privateKey: 'stored SSH key', fingerprint: 'SHA256:test' },
    }),
  );
  await page.reload();
  await page.locator('.bookmark').filter({ hasText: 'Settings check' }).hover();
  await page.getByRole('button', { name: 'Edit Settings check' }).click();
  await page.getByLabel('Bookmark name').fill('Settings preserved');
  await page.getByRole('button', { name: 'Save connection' }).click();
  await expect(page.getByText('Settings preserved', { exact: true })).toBeVisible();
  const settings = await page.evaluate(async () =>
    (await window.dbDiff.bookmarks.list()).find((b) => b.id === 'settings-check'),
  );
  expect(settings.ssl.key).toBe('line one\nline two');
  expect(settings.ssh.privateKey).toBe('stored SSH key');
  await page.locator('.bookmark').filter({ hasText: 'Settings preserved' }).hover();
  await page.getByRole('button', { name: 'Remove Settings preserved' }).click();
  await page.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(page.getByText('Settings preserved', { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
  console.log(
    'Electron smoke passed: demo, inspection, comparison, field expansion, bookmark edit, encrypted storage, cancellation and cleanup, no renderer errors.',
  );
} finally {
  await app.close();
  await rm(userData, { recursive: true, force: true });
}
