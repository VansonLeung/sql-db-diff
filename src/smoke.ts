import { reportSmoke } from './bridge';

const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
async function until(check: () => boolean, message: string) {
  const deadline = Date.now() + 40_000;
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error(
        `${message}\n${document.body.innerText.slice(-6000)}\nButtons: ${[...document.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') || b.textContent).join(', ')}`,
      );
    await pause();
  }
}
function button(text: string) {
  return [...document.querySelectorAll('button')].find(
    (button) =>
      button.textContent?.replace(/\s+/g, '').includes(text.replace(/\s+/g, '')) &&
      !button.disabled,
  );
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

// This module is included only by Vite's smoke mode; it runs inside the actual
// native webview, exercising Electrobun's bridge and packaged Bun worker.
export async function runSmoke() {
  const errors: string[] = [];
  window.addEventListener('error', (event) => errors.push(event.message));
  window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)));
  try {
    await until(() => !!button('Explore demo databases'), 'Demo button did not render.');
    button('Explore demo databases')!.click();
    await until(() => !!button('Load tables'), 'Demo databases were not created.');
    button('Load tables')!.click();
    await until(() => !!button('Compare databases'), 'Tables were not inspected.');
    button('Compare databases')!.click();
    await until(
      () => document.body.textContent!.includes('Comparison complete · 4 tables'),
      'Comparison did not complete.',
    );
    await until(
      () => !!document.querySelector('button[aria-label="Expand row"]'),
      'Comparison rows did not render.',
    );
    (document.querySelector('button[aria-label="Expand row"]') as HTMLButtonElement).click();
    await until(
      () => document.body.textContent!.includes('enterprise'),
      'Changed field did not render.',
    );
    const bookmarks = await window.dbDiff.bookmarks.list();
    const source = bookmarks.find((b) => b.id === 'demo-source')!;
    const target = bookmarks.find((b) => b.id === 'demo-target')!;
    await window.dbDiff.bookmarks.save({ ...source, name: 'Edited demo source' });
    assert(
      (await window.dbDiff.bookmarks.list()).some((b) => b.name === 'Edited demo source'),
      'Bookmark edit failed.',
    );
    await window.dbDiff.bookmarks.save({
      id: 'settings-check',
      name: 'Settings check',
      engine: 'mysql',
      ssl: { enabled: true, ca: 'stored CA', key: 'line one\nline two' },
      ssh: { enabled: true, privateKey: 'stored SSH key', fingerprint: 'SHA256:test' },
    });
    const settings = (await window.dbDiff.bookmarks.list()).find((b) => b.id === 'settings-check')!;
    assert(
      settings.ssl?.key === 'line one\nline two' && settings.ssh?.privateKey === 'stored SSH key',
      'TLS/SSH settings were lost.',
    );
    await window.dbDiff.bookmarks.remove('settings-check');
    assert(
      !(await window.dbDiff.bookmarks.list()).some((b) => b.id === 'settings-check'),
      'Bookmark removal failed.',
    );
    const left = { bookmarkId: source.id, database: source.file! };
    const right = { bookmarkId: target.id, database: target.file! };
    const tables = await window.dbDiff.inspect(left);
    await window.dbDiff.compare({
      left,
      right,
      tables: tables.map((t) => t.id),
      keys: {},
      schemaOnly: false,
    });
    await window.dbDiff.cancel();
    let rejected = false;
    try {
      await window.dbDiff.rows(tables[0].id, 1);
    } catch {
      rejected = true;
    }
    assert(rejected, 'Cancelled comparison still exposes results.');
    assert(errors.length === 0, errors.join('\n'));
    await reportSmoke({
      ok: true,
      message:
        'Native webview: demo, table inspection, comparison, field expansion, encrypted bookmarks, TLS/SSH settings, cancellation and result invalidation passed.',
    });
  } catch (error) {
    await reportSmoke({
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
