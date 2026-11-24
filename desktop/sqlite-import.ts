import { DatabaseSync, constants as c } from 'node:sqlite';
import { readFile } from 'node:fs/promises';

// Run in a worker: large or malformed scripts must not block the desktop service.
export async function importSqlite(source: string, destination: string) {
  const sql = await readFile(source, 'utf8');
  const db = new DatabaseSync(destination, { allowExtension: false });
  try {
    db.setAuthorizer((action, a, b) => {
      if ([c.SQLITE_ATTACH, c.SQLITE_DETACH, c.SQLITE_CREATE_VTABLE].includes(action))
        return c.SQLITE_DENY;
      if (
        action === c.SQLITE_PRAGMA &&
        !['foreign_keys', 'defer_foreign_keys', 'encoding'].includes(a || '')
      )
        return c.SQLITE_DENY;
      if (
        action === c.SQLITE_FUNCTION &&
        ['load_extension', 'readfile', 'writefile'].includes(b || '')
      )
        return c.SQLITE_DENY;
      return c.SQLITE_OK;
    });
    db.exec(sql);
    if (db.isTransaction) throw new Error('SQL file ends with an uncommitted transaction.');
    if (
      !db
        .prepare(
          "SELECT 1 FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1",
        )
        .get()
    )
      throw new Error('No tables were created. Supply a complete schema or schema-and-data dump.');
  } catch (error) {
    throw new Error(
      `SQLite SQL import failed: ${error instanceof Error ? error.message : String(error)} Use a standalone SQLite SQL dump; migration/data-only scripts needing a base schema and shell dot-commands are unsupported.`,
    );
  } finally {
    db.setAuthorizer(null);
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
  }
}
