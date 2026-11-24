# SQL DB Diff

A read-only desktop database comparison app built with Vite, React, TypeScript, Ant Design, and [Electrobun](https://github.com/blackboardsh/electrobun). The backend runs on Bun; the interface uses the native system webview (WKWebView on macOS, WebView2 on Windows, WebKitGTK on Linux). Chromium/CEF and WebGPU are not bundled. Supports PostgreSQL, MySQL, and local SQLite databases. Both sides must use the same engine. Either side can also use a plain `.sql` dump or pasted SQL text for that engine.

## Run

Requires Node.js 24 LTS and npm. `npm install` installs the pinned Bun 1.4.0 executable used for backend tests and worker bundling. Electrobun 2.0.1 packages the same Bun version. Its CLI downloads the matching Hutch/devkit on first use; subsequent builds reuse the cached toolchain.

```sh
npm install
npm run dev
```

`npm run dev` starts Vite and Electrobun. React changes reload automatically; quit and restart the native app for desktop/backend changes. The interface checks backend compatibility and reports a restart message when an older app is still running. To run locally with bundled frontend assets:

```sh
npm run build
npm start
```

If your npm configuration disables install scripts, run `node node_modules/bun/install.js` once after installation. `npm run build` produces a development app with bundled frontend assets; `npm start` launches that app. End users do not need Node.js, npm, or Bun installed.

## Use

1. Add database or SQL-file bookmarks, or click **Explore demo databases** to create two small local SQLite files.
2. Select **Database** or **SQL** independently for source and target, then choose bookmarks and databases. A connection can be selected on both sides to compare two of its databases.
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

## Comparing SQL files and pasted text

SQL files and pasted SQL text can be compared with each other or with a database for SQLite, MySQL, and PostgreSQL. Select the same engine on both sides. The file extension does not identify its dialect: select the engine explicitly in **New input**, along with **Schema only** or **Schema and data (including empty tables)**. A schema-only SQL input forces schema comparison on both sides; an empty full export still participates in row comparison.

Choose **SQL** on either side and click **Add SQL**, or create a SQL bookmark from **New connection**. Under **SQL source**, choose **SQL file** to select a dump or **Paste SQL text** to paste its contents into the editor. Select its engine and contents, and save it. Pasted SQL is saved encrypted with its bookmark and can be edited later. The editor accepts up to 5 million characters; use a file for larger dumps. **Test SQL import** validates the restore. Select **Load tables**, review matching keys, and compare as usual. Pasted text uses the same temporary import process, engine requirements, and schema-only behavior as files. For dumps that create their own database, refresh the database list and choose the restored database. Only databases containing tables are listed for SQL imports.

- SQLite imports run with the bundled SQLite engine in a private temporary file. SQL from `.dump` is supported, including transactions; SQLite shell dot-commands, attached databases, virtual-table dumps requiring `writable_schema`, and extension loading are unsupported.
- PostgreSQL and MySQL imports require Docker installed and running locally. The app uses the Docker CLI; remote Docker contexts are rejected. Choose PostgreSQL 15–18 (default 18) or MySQL 8.0/8.4 (default 8.4) to suit your dump. The corresponding official image (Alpine for PostgreSQL) is downloaded on first use and retained by Docker for reuse. Docker's disk usage and image downloads are additional to the desktop app.
- Each server import creates a disposable container on its own Docker bridge network, publishes only a random localhost port, and mounts no host directories. SQL is streamed to the client inside the container. PostgreSQL imports use `psql` with error stopping and support `COPY FROM stdin`; MySQL imports use the native client and support dump directives and `DELIMITER` blocks. Selected live databases are only opened by the existing read-only drivers.
- Use complete, standalone dumps. Migration scripts and data-only dumps needing an existing schema, PostgreSQL archive/custom formats, compressed files, and cross-engine comparisons are unsupported. Required external roles, extensions, collations, or plugins are not provisioned automatically; restore errors are shown instead of comparing a partially restored database. For portable PostgreSQL dumps, consider exporting with `pg_dump --no-owner --no-privileges`.
- Imports are repeated for testing, database listing, table inspection, and comparison, so edits to the source file are picked up. Stop editing files while an operation is running. Large dumps and first-time image downloads can take several minutes. Pasted text is written exactly as entered to a private temporary SQL file for each import and is removed with that import session. Source operations have a ten-minute deadline; SQLite import workers have a two-minute deadline. Comparison can be cancelled during import as well as row scanning.
- Temporary import files, containers, anonymous volumes, and networks are deleted after the operation, on cancellation, and on normal shutdown. Cleanup records allow retrying abandoned resources at the next launch after a crash. If Docker is unavailable during cleanup, its resources remain until the app can retry with Docker running. Docker images remain cached. Imported data and comparison results are not separately encrypted.

## Comparison behavior

- Column order, types, nullability, defaults, primary keys, indexes, and constraints are compared. Generated/identity column details and table definitions are included where exposed by the engine. PostgreSQL uses catalog definitions; MySQL uses `SHOW CREATE TABLE` with the changing auto-increment counter removed; SQLite includes its stored DDL.
- Comparison is exact: no whitespace, case, timezone, numeric, or DDL equivalence heuristics. Textually different definitions can be flagged despite equivalent behavior. PostgreSQL returns database text representations to preserve precision; PostgreSQL and MySQL sessions use UTC. SQLite preserves 64-bit integers and binary data. Missing fields and NULL values are distinct.
- Workers stream rows, stage one table pair at a time in temporary SQLite storage, and persist differences on disk. Only 100 differing rows are loaded into the renderer per page. All columns of a row are compared. Cancellation terminates the worker and removes that run's temporary results.
- PostgreSQL uses a read-only repeatable-read transaction; MySQL uses a read-only consistent snapshot (snapshot guarantees require InnoDB); SQLite uses a read-only transaction. Each side's snapshot starts independently. Stop concurrent schema changes while comparing. Large comparisons may keep snapshots open for several minutes.
- Views, triggers, routines, sequences, users/grants, exporting dumps, generating migrations, and applying changes are outside this version's scope. Tables and columns cannot currently be manually remapped or filtered with SQL predicates.

## Local storage and security

All bookmark data, including pasted SQL, URLs, passwords, and SSH/TLS keys, is encrypted with AES-256-GCM and saved atomically in `bookmarks.enc` under Electrobun's `Utils.paths.userData`. A separate random 256-bit key is stored with `Bun.secrets`: macOS Keychain, Windows Credential Manager, or the Linux Secret Service. Only the encryption key goes into the credential store, so large SSH keys and certificates do not hit credential-size limits. Missing keys or an unavailable credential store fail closed; there is no plaintext fallback. An instance lock prevents simultaneous processes from using the same vault and comparison directory.

**Migration from Electron:** the old application data is left untouched. The new app uses a different data directory and encrypted-file format; re-enter saved connections. Do not copy the old `bookmarks.enc` over the new one. Development and stable release channels also have separate data directories.

Temporary result files contain compared row values and use a private directory under `userData/comparisons`. They are not separately encrypted, and are deleted on cancellation, replacement, normal window close, or next startup after a crash. Results are session-only. Demo database files remain locally for reuse. Use operating-system disk encryption if you need encryption for database and temporary files.

Database comparisons and SQLite SQL imports run in worker threads. The desktop backend coordinates temporary Docker server imports and discovers their restored databases. The renderer uses Electrobun's typed RPC bridge with a fixed set of application methods and validated payloads. The privileged webview is restricted to the bundled app URL (or the exact local Vite URL in development); remote navigation is blocked. The renderer does not import database drivers or runtime secrets. The app issues no writes to selected databases. SQL-file imports write only to disposable local databases. A read-only database account is still appropriate for this tool.

## Validation

```sh
npm run check
npm test
TEST_SQL_IMPORT_DOCKER=1 npm exec -- bun test tests/sql-import.test.ts --timeout 360000
npm run test:smoke
npm run test:smoke -- --dev-server # same native checks through Vite
npm exec -- bun scripts/benchmark.ts
```

Tests cover SQL file/text validation, pasted text persistence, text/file/database comparisons, SQLite SQL imports, schema-only and empty exports, source preservation, import cleanup, SQLite read-only access, schema/row/field differences, large integers, binary and NULL values, composite/duplicate keys, missing tables, a 50,000-row comparison, encrypted-vault tampering/missing keys, instance locking, and real Bun worker lifecycle/cancellation. `npm run test:smoke` builds and launches an actual native-webview app, exercises the React demo workflow and typed RPC bridge, then checks encrypted persistence and temporary-file cleanup. It needs a graphical desktop session. Smoke builds use an isolated temporary data directory and an ephemeral encryption key; they do not alter real bookmarks or OS credentials. Smoke app bundles are isolated under `build/smoke/`, so the ordinary development app is unchanged.

The benchmark generates 200 tables with 50,000 rows on each side, verifies every result, and cleans up its fixtures. Performance depends on row size, difference volume, server load, and network latency; earlier Electron measurements do not describe the Bun build.

SQL-import Docker integration tests are opt-in (`TEST_SQL_IMPORT_DOCKER=1`), create only disposable resources, and cover native dump syntax, failed imports, named databases, cancellation, and crash cleanup. Set `TEST_SQL_IMPORT_PG_VERSION=15` (or another supported major) to test a specific PostgreSQL import version.

To include a real MySQL dump in the native smoke test, set `SQL_DB_DIFF_SMOKE_SQL_FILE=/path/to/dump.sql` when running `npm run test:smoke`. It restores the file into disposable MySQL 8.4 instances and checks table inspection through the renderer bridge; the dump is read without modification.

Real PostgreSQL/MySQL and SSH integration tests are opt-in and require dedicated disposable servers; they recreate databases named `diff_source` and `diff_target`:

```sh
docker run --rm -d --name sql-db-diff-test-pg -e POSTGRES_PASSWORD=diff-test-only -p 127.0.0.1:55439:5432 postgres:17
docker run --rm -d --name sql-db-diff-test-mysql -e MYSQL_ROOT_PASSWORD=diff-test-only -p 127.0.0.1:53369:3306 mysql:8.4
# Once both servers are ready:
TEST_DATABASE_SERVERS=1 npm test
# Optional certificate tests reconfigure TLS on these disposable containers:
TEST_TLS_DATABASE_SERVERS=1 npm exec -- bun test tests/tls.test.ts
TEST_DATABASE_SERVERS=1 TEST_SSH_TLS=1 npm exec -- bun test tests/ssh.test.ts
docker stop sql-db-diff-test-pg sql-db-diff-test-mysql
```

## Distribution

Build on the target operating system and architecture:

```sh
npm run dist:mac  # macOS: stable app, compressed archive, installer/DMG
npm run dist:win  # Windows x64: stable app and Windows installer
npm run dist      # current host
```

Electrobun writes development apps and release bundles to `build/` and distribution artifacts to `artifacts/`. Release bundles use a self-extracting launcher, so their compressed size is smaller than their installed footprint. `dist:win` intentionally fails on macOS instead of producing a misleading cross-platform result. The GitHub Actions workflow builds macOS ARM64 and Windows x64 separately. Windows users need WebView2 installed; this project does not bundle the browser runtime. Fully offline deployments must provision WebView2 separately.

Release builds always load bundled frontend assets and disable smoke mode. No Electron runtime, electron-builder, or production `node_modules` tree is shipped. Backend packages are bundled into the worker; optional SSH native accelerators are external and absent, so SSH uses its JavaScript implementation and Bun's crypto support. SQLite uses Bun's `node:sqlite` implementation. On macOS this uses system SQLite; a read-only WAL database whose sidecar files are absent may fail to open. Have its owner checkpoint it or provide a consistent SQLite backup; this application does not modify source databases to work around that restriction.

Public macOS distribution requires your signing identity and notarization configuration (`build.mac.codesign` / `notarize`). Configure signing in your release environment before publishing Windows installers as well. No signing credentials are included.

Implementation references: [Electrobun](https://framework.blackboard.sh/electrobun/), [Bun compatibility](https://bun.com/docs/runtime/nodejs-compat), [Bun secrets](https://bun.com/docs/runtime/secrets), [PostgreSQL TLS](https://node-postgres.com/features/ssl), [MySQL TLS](https://sidorares.github.io/node-mysql2/docs/documentation/ssl), [ssh2](https://github.com/mscdex/ssh2).
