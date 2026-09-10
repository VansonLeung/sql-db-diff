# SQL DB Diff

A read-only macOS database comparison app built with Vite, React, TypeScript, Ant Design, and Electron. Supports PostgreSQL, MySQL, and local SQLite databases. Both sides must use the same engine.

## Run

Requires Node.js 24 LTS and npm.

```sh
npm install
npm run dev
```

`npm run dev` starts Vite and Electron. React changes reload automatically; restart for Electron/backend changes. To run the production build:

```sh
npm run build
npm start
```

If your npm configuration disables dependency install scripts, run `node node_modules/electron/install.js` after installation to download Electron.

## Use

1. Add connection bookmarks, or click **Explore demo databases** to create two small local SQLite files.
2. Select source and target bookmarks and databases. A connection can be selected on both sides to compare two of its databases.
3. Click **Load tables**. Select tables and review their matching columns.
4. Primary keys, including composite keys, are selected automatically when compatible. Choose unique, non-null matching columns for tables without a shared primary key. Otherwise their schemas are compared and rows are marked skipped.
5. Click **Compare databases**. Review schema differences, indexes/constraints, and row differences. Expand a row to see source/target values and highlighted fields.

**Added** means target only; **removed** means source only. Duplicate or NULL matching keys produce a table error, never a misleading comparison. Tables are matched by schema/name in PostgreSQL and by name within the selected database in MySQL/SQLite. Table names remain case sensitive in the comparison.

## Connections

- PostgreSQL and MySQL: host, port, username/password, default database, or a connection URL. Selected databases override the URL's database.
- URLs: `postgresql://user:password@host:5432/database` or `mysql://user:password@host:3306/database`. Percent-encode reserved characters in credentials. Supported URL query option: `sslmode=verify-full` or `sslmode=disable`; other URL query parameters are rejected explicitly. Use the TLS tab for certificate configuration.
- TLS: certificate and hostname verification, custom CA certificate, and optional client certificate/private key. Paste PEM text in the TLS tab. MySQL verified TLS requires a DNS hostname, including through a tunnel.
- SSH: password or pasted OpenSSH/PEM private key, optional passphrase, and a trusted SHA256 host-key fingerprint from your administrator. The database host/port are reached from the SSH server. No SSH agent or `~/.ssh/config` integration in this version.
- SQLite: choose an existing local database file. Each bookmark represents one file; it opens read-only. Attached databases and encrypted SQLite extensions are not supported.

## Comparison behavior

- Column order, types, nullability, defaults, primary keys, indexes, and constraints are compared. Generated/identity column details and table definitions are included where exposed by the engine. PostgreSQL uses catalog definitions; MySQL uses `SHOW CREATE TABLE` with the changing auto-increment counter removed; SQLite includes its stored DDL.
- Comparison is exact: no whitespace, case, timezone, numeric, or DDL equivalence heuristics. Textually different definitions can be flagged despite equivalent behavior. PostgreSQL returns database text representations to preserve precision; PostgreSQL and MySQL sessions use UTC. SQLite preserves 64-bit integers and binary data. Missing fields and NULL values are distinct.
- Workers stream rows, stage one table pair at a time in temporary SQLite storage, and persist differences on disk. Only 100 differing rows are loaded into the renderer per page. All columns of a row are compared. Cancellation terminates the worker and removes that run's temporary results.
- PostgreSQL uses a read-only repeatable-read transaction; MySQL uses a read-only consistent snapshot (snapshot guarantees require InnoDB); SQLite uses a read-only transaction. Each side's snapshot starts independently. Stop concurrent schema changes while comparing. Large comparisons may keep snapshots open for several minutes.
- Views, triggers, routines, sequences, users/grants, exports, migrations, and applying changes are outside this version's scope. Tables and columns cannot currently be manually remapped or filtered with SQL predicates.

## Local storage and security

All bookmark data, including URLs, passwords, and SSH/TLS keys, is encrypted with Electron `safeStorage` (macOS Keychain backed) and saved atomically in `bookmarks.enc` under Electron's user-data directory. Saving fails if Keychain protection is unavailable; there is no plaintext fallback. Existing bookmarks can be edited, tested, and removed.

Temporary result files contain compared row values and use a private directory under `userData/comparisons`. They are not separately encrypted, and are deleted on cancellation, replacement, normal window close, or next startup after a crash. Results are session-only. Demo database files remain locally for reuse. Use FileVault if you need disk encryption for database and temporary files.

Database drivers run in worker threads. The renderer uses a sandboxed, isolated preload bridge with a restricted IPC API and validated payloads. The app issues no writes to selected databases. A read-only database account is still appropriate for this tool.

## Validation

```sh
npm run check
npm test
npm run test:smoke
npx tsx scripts/benchmark.ts
```

Unit/integration tests cover SQLite read-only access, schema/row/field differences, large integers, binary and NULL values, composite/duplicate keys, missing tables, and a 50,000-row comparison with pagination. The Electron smoke test uses an isolated user-data directory, verifies the demo workflow and encrypted bookmarks, and saves `test-results/comparison.png`. The benchmark generates 200 tables with 50,000 rows on each side, verifies every result, and cleans up its fixtures.

Measured on the development Mac: the synthetic SQLite benchmark read 20 million rows in 74.4 seconds with approximately 200 MiB peak process memory. Real performance depends on row size, difference volume, server load, and network latency. The packaged macOS app and Vite development workflow both passed the Electron smoke test.

Real PostgreSQL/MySQL and SSH integration tests are opt-in and require dedicated disposable servers; they recreate databases named `diff_source` and `diff_target`:

```sh
docker run --rm -d --name sql-db-diff-test-pg -e POSTGRES_PASSWORD=diff-test-only -p 127.0.0.1:55439:5432 postgres:17
docker run --rm -d --name sql-db-diff-test-mysql -e MYSQL_ROOT_PASSWORD=diff-test-only -p 127.0.0.1:53369:3306 mysql:8.4
# Once both servers are ready:
TEST_DATABASE_SERVERS=1 npm test
# Optional certificate tests reconfigure TLS on these disposable containers:
TEST_TLS_DATABASE_SERVERS=1 npx tsx --test tests/tls.test.ts
TEST_DATABASE_SERVERS=1 TEST_SSH_TLS=1 npx tsx --test tests/ssh.test.ts
docker stop sql-db-diff-test-pg sql-db-diff-test-mysql
```

## macOS distribution

```sh
npm run dist:mac
```

Produces DMG/ZIP artifacts in `release/` for the current Mac architecture. Public distribution requires your Apple Developer signing identity and notarization configuration. No signing credentials are included.

Packaging reuses the locally installed Electron runtime. Optional SSH native accelerators are excluded; SSH uses its JavaScript implementation and Node's built-in crypto. SQLite uses Electron's built-in Node SQLite module, so no native dependency rebuild is required.

Implementation references: [Electron security](https://www.electronjs.org/docs/latest/tutorial/security), [Node SQLite](https://nodejs.org/api/sqlite.html), [PostgreSQL TLS](https://node-postgres.com/features/ssl), [MySQL TLS](https://sidorares.github.io/node-mysql2/docs/documentation/ssl), [ssh2](https://github.com/mscdex/ssh2).
