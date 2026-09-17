# SQL DB Diff

A read-only desktop database comparison app built with Vite, React, TypeScript, Ant Design, and [Electrobun](https://github.com/blackboardsh/electrobun). The backend runs on Bun; the interface uses the native system webview (WKWebView on macOS, WebView2 on Windows, WebKitGTK on Linux). Chromium/CEF and WebGPU are not bundled. Supports PostgreSQL, MySQL, and local SQLite databases. Both sides must use the same engine.

## Run

Requires Node.js 24 LTS and npm. `npm install` installs the pinned Bun 1.4.0 executable used for backend tests and worker bundling. Electrobun 2.0.1 packages the same Bun version. Its CLI downloads the matching Hutch/devkit on first use; subsequent builds reuse the cached toolchain.

```sh
npm install
npm run dev
```

`npm run dev` starts Vite and Electrobun. React changes reload automatically; restart for desktop/backend changes. To run locally with bundled frontend assets:

```sh
npm run build
npm start
```

If your npm configuration disables install scripts, run `node node_modules/bun/install.js` once after installation. `npm run build` produces a development app with bundled frontend assets; `npm start` launches that app. End users do not need Node.js, npm, or Bun installed.

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

All bookmark data, including URLs, passwords, and SSH/TLS keys, is encrypted with AES-256-GCM and saved atomically in `bookmarks.enc` under Electrobun's `Utils.paths.userData`. A separate random 256-bit key is stored with `Bun.secrets`: macOS Keychain, Windows Credential Manager, or the Linux Secret Service. Only the encryption key goes into the credential store, so large SSH keys and certificates do not hit credential-size limits. Missing keys or an unavailable credential store fail closed; there is no plaintext fallback. An instance lock prevents simultaneous processes from using the same vault and comparison directory.

**Migration from Electron:** the old application data is left untouched. The new app uses a different data directory and encrypted-file format; re-enter saved connections. Do not copy the old `bookmarks.enc` over the new one. Development and stable release channels also have separate data directories.

Temporary result files contain compared row values and use a private directory under `userData/comparisons`. They are not separately encrypted, and are deleted on cancellation, replacement, normal window close, or next startup after a crash. Results are session-only. Demo database files remain locally for reuse. Use operating-system disk encryption if you need encryption for database and temporary files.

Database drivers run in worker threads. The renderer uses Electrobun's typed RPC bridge with a fixed set of application methods and validated payloads. The privileged webview is restricted to the bundled app URL (or the exact local Vite URL in development); remote navigation is blocked. The renderer does not import database drivers or runtime secrets. The app issues no writes to selected databases. A read-only database account is still appropriate for this tool.

## Validation

```sh
npm run check
npm test
npm run test:smoke
npm run test:smoke -- --dev-server # same native checks through Vite
npm exec -- bun scripts/benchmark.ts
```

Tests cover SQLite read-only access, schema/row/field differences, large integers, binary and NULL values, composite/duplicate keys, missing tables, a 50,000-row comparison, encrypted-vault tampering/missing keys, instance locking, and real Bun worker lifecycle/cancellation. `npm run test:smoke` builds and launches an actual native-webview app, exercises the React demo workflow and typed RPC bridge, then checks encrypted persistence and temporary-file cleanup. It needs a graphical desktop session. Smoke builds use an isolated temporary data directory and an ephemeral encryption key; they do not alter real bookmarks or OS credentials. Smoke app bundles are isolated under `build/smoke/`, so the ordinary development app is unchanged.

The benchmark generates 200 tables with 50,000 rows on each side, verifies every result, and cleans up its fixtures. Performance depends on row size, difference volume, server load, and network latency; earlier Electron measurements do not describe the Bun build.

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
