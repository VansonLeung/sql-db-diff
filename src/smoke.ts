import { reportSmoke, smokeSQLFixture } from './bridge';

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
    const leftInput = document.querySelector('[aria-label="left input type"]')!;
    const sqlChoice = [...leftInput.querySelectorAll('label')].find(
      (el) => el.textContent === 'SQL',
    );
    assert(sqlChoice, 'SQL input selector did not render.');
    sqlChoice.click();
    await until(() => !!button('Add SQL'), 'Add SQL did not render.');
    button('Add SQL')!.click();
    await until(() => !!document.querySelector('input#name'), 'SQL input form did not render.');
    const nameInput = document.querySelector('input#name') as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      nameInput,
      'Smoke SQL input',
    );
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    (document.querySelector('[aria-label="Choose SQL file"]') as HTMLButtonElement).click();
    const content = document.querySelector('#sqlContent')!;
    content.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await until(
      () =>
        [...document.querySelectorAll('.ant-select-item-option-content')].some(
          (el) => el.textContent === 'Schema and data (including empty tables)',
        ),
      'SQL contents options did not open.',
    );
    (
      [...document.querySelectorAll('.ant-select-item-option-content')].find(
        (el) => el.textContent === 'Schema and data (including empty tables)',
      ) as HTMLElement
    ).click();
    await until(
      () => !!(document.querySelector('input#file') as HTMLInputElement)?.value,
      'SQL file chooser did not return a path.',
    );
    button('Save input')!.click();
    await until(
      () => !document.querySelector('.ant-modal-content') && !!button('Load tables'),
      'SQL input was not saved.',
    );
    button('Load tables')!.click();
    await until(() => !!button('Compare databases'), 'SQL tables were not inspected.');
    button('Compare databases')!.click();
    await until(
      () => document.body.textContent!.includes('Comparison complete · 4 tables'),
      'SQL/database comparison did not complete.',
    );
    assert(
      (await window.dbDiff.bookmarks.list()).some(
        (b) => b.input === 'sql' && b.sqlContent === 'data',
      ),
      'SQL settings did not persist.',
    );
    (document.querySelector('[aria-label="Edit Smoke SQL input"]') as HTMLButtonElement).click();
    await until(
      () => !!document.querySelector('[aria-label="SQL source"]'),
      'SQL source options did not render.',
    );
    const pasteChoice = [...document.querySelectorAll('[aria-label="SQL source"] label')].find(
      (el) => el.textContent === 'Paste SQL text',
    );
    assert(pasteChoice, 'Paste SQL option did not render.');
    (pasteChoice as HTMLElement).click();
    await until(
      () => !!document.querySelector('textarea#sqlText'),
      'SQL text editor did not render.',
    );
    const pastedSQL =
      "CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT, plan TEXT DEFAULT 'starter');\nINSERT INTO customers VALUES(1,'Pasted 客戶','ada@example.test','pro');";
    const sqlEditor = document.querySelector('textarea#sqlText') as HTMLTextAreaElement;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      sqlEditor,
      pastedSQL,
    );
    sqlEditor.dispatchEvent(new Event('input', { bubbles: true }));
    button('Test SQL import')!.click();
    await until(
      () =>
        document.body.textContent!.includes('Imported · 1 database available') &&
        !!button('Save input'),
      'Pasted SQL test did not complete.',
    );
    button('Save input')!.click();
    await until(
      () => !document.querySelector('.ant-modal-content') && !!button('Load tables'),
      'Pasted SQL was not saved.',
    );
    const pastedBookmark = (await window.dbDiff.bookmarks.list()).find(
      (b) => b.name === 'Smoke SQL input',
    );
    assert(
      pastedBookmark?.sqlSource === 'text' &&
        pastedBookmark.sqlText === pastedSQL &&
        !pastedBookmark.file,
      'Pasted SQL or source settings were lost.',
    );
    button('Load tables')!.click();
    await until(() => !!button('Compare databases'), 'Pasted SQL tables were not inspected.');
    button('Compare databases')!.click();
    await until(
      () => document.body.textContent!.includes('Comparison complete · 4 tables'),
      'Pasted SQL/database comparison did not complete.',
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
    let importFailure = '';
    try {
      await window.dbDiff.test({
        id: 'bad-sql',
        name: 'Bad SQL',
        input: 'sql',
        engine: 'sqlite',
        sqlSource: 'text',
        sqlContent: 'schema',
        sqlText: 'CREATE TABLE broken (',
      });
    } catch (error) {
      importFailure = error instanceof Error ? error.message : String(error);
    }
    assert(
      importFailure.includes('SQLite SQL import failed'),
      `Import errors were not preserved across the bridge: ${importFailure}`,
    );
    const sqlFixture = await smokeSQLFixture();
    let fixtureTables = 0;
    if (sqlFixture) {
      const fixture = {
        id: 'mysql-sql-fixture',
        name: 'MySQL SQL fixture',
        input: 'sql' as const,
        engine: 'mysql' as const,
        sqlContent: 'data' as const,
        sqlVersion: '8.4',
        file: sqlFixture,
      };
      const databases = await window.dbDiff.test(fixture);
      assert(databases.includes('sqldiff'), 'MySQL fixture did not return the restored database.');
      await window.dbDiff.bookmarks.save(fixture);
      fixtureTables = (await window.dbDiff.inspect({ bookmarkId: fixture.id, database: 'sqldiff' }))
        .length;
      assert(fixtureTables > 0, 'MySQL fixture did not expose its restored tables.');
      await window.dbDiff.bookmarks.remove(fixture.id);
    }
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
      message: `Native webview: SQL imports and failure reporting, pasted SQL editor, SQL/database comparisons, encrypted bookmarks, cancellation and cleanup passed.${sqlFixture ? ` MySQL fixture restored and inspected ${fixtureTables} tables.` : ''}`,
    });
  } catch (error) {
    await reportSmoke({
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
