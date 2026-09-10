import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createServer, createConnection, isIP, type Server } from 'node:net';
import { Client as SSH } from 'ssh2';
import pg from 'pg';
import Cursor from 'pg-cursor';
import mysql, { type Connection } from 'mysql2';
import type { Bookmark, TableMeta } from '../src/shared';

type Raw = Record<string, any>;
export interface Driver {
  query(sql: string): Promise<Raw[]>;
  rows(table: TableMeta): AsyncGenerator<Raw>;
  inspect(): Promise<TableMeta[]>;
  databases(): Promise<string[]>;
  close(): Promise<void>;
}
export const quote = (name: string, engine: string) =>
  engine === 'mysql'
    ? '`' + name.replaceAll('`', '``') + '`'
    : '"' + name.replaceAll('"', '""') + '"';
const literal = (s: string) => "'" + s.replaceAll("'", "''") + "'";
const qualified = (t: TableMeta, engine: string) =>
  `${quote(t.schema, engine)}.${quote(t.name, engine)}`;
export function connectionOptions(b: Bookmark, database?: string) {
  let host = b.host || 'localhost',
    port = b.port || (b.engine === 'postgres' ? 5432 : 3306),
    user = b.user || '',
    password = b.password || '',
    db = b.database;
  if (b.url) {
    const u = new URL(b.url);
    if (!(b.engine === 'postgres' ? ['postgres:', 'postgresql:'] : ['mysql:']).includes(u.protocol))
      throw new Error('Connection URL must match the selected engine.');
    if ([...u.searchParams.keys()].some((k) => k !== 'sslmode'))
      throw new Error('URL options other than sslmode are not supported. Use the TLS settings.');
    const mode = u.searchParams.get('sslmode');
    if (mode && !['disable', 'verify-full'].includes(mode))
      throw new Error('Use sslmode=verify-full or configure verified TLS in the TLS tab.');
    host = u.hostname;
    port = Number(u.port) || port;
    user = decodeURIComponent(u.username);
    password = decodeURIComponent(u.password);
    db = decodeURIComponent(u.pathname.slice(1));
  }
  return {
    host,
    port,
    user,
    password,
    database: database || db || (b.engine === 'postgres' ? 'postgres' : undefined),
  };
}

export async function connect(b: Bookmark, database?: string): Promise<Driver> {
  let sqlite: DatabaseSync | undefined,
    postgres: pg.Client | undefined,
    my: Connection | undefined,
    ssh: SSH | undefined,
    server: Server | undefined;
  const close = async () => {
    sqlite?.close();
    if (postgres) await postgres.end().catch(() => {});
    my?.destroy();
    server?.close();
    ssh?.end();
  };
  try {
    let query: Driver['query'];
    let rows: Driver['rows'];
    if (b.engine === 'sqlite') {
      if (!b.file) throw new Error('Choose a SQLite database file.');
      sqlite = new DatabaseSync(b.file, { readOnly: true });
      sqlite.exec('PRAGMA query_only=ON; BEGIN');
      query = async (sql) => sqlite!.prepare(sql).all();
      rows = async function* (table) {
        const statement = sqlite!.prepare(`SELECT * FROM ${qualified(table, b.engine)}`);
        statement.setReadBigInts(true);
        for (const row of statement.iterate()) yield row;
      };
    } else {
      const config = connectionOptions(b, database);
      const originalHost = config.host;
      let tunnelPort: number | undefined;
      if (b.ssh?.enabled) {
        const s = b.ssh;
        if (!s.host || !s.user || !s.fingerprint)
          throw new Error('SSH requires a host, user, and trusted SHA256 host fingerprint.');
        ssh = new SSH();
        await new Promise<void>((resolve, reject) => {
          ssh!.once('ready', resolve).on('error', reject);
          const fingerprint = s.fingerprint!.replace(/^SHA256:/, '').replace(/=+$/, '');
          ssh!.connect({
            host: s.host,
            port: s.port || 22,
            username: s.user,
            password: s.password,
            privateKey: s.privateKey,
            passphrase: s.passphrase,
            readyTimeout: 15000,
            hostVerifier: (key: Buffer) => {
              const hash = createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
              return hash === fingerprint;
            },
          });
        });
        const remotePort = config.port;
        server = createServer((socket) => {
          ssh!.forwardOut('127.0.0.1', 0, originalHost, remotePort, (error, stream) => {
            if (error) return socket.destroy();
            socket.on('error', () => stream.destroy());
            stream.on('error', () => socket.destroy());
            socket.pipe(stream).pipe(socket);
          });
        });
        await new Promise<void>((resolve, reject) => {
          server!.once('error', reject);
          server!.listen(0, '127.0.0.1', resolve);
        });
        tunnelPort = (server.address() as { port: number }).port;
      }
      const tlsEnabled =
        b.ssl?.enabled || (b.url && new URL(b.url).searchParams.get('sslmode') === 'verify-full');
      const ssl = tlsEnabled
        ? {
            rejectUnauthorized: true,
            verifyIdentity: true,
            servername: originalHost,
            ca: b.ssl?.ca || undefined,
            cert: b.ssl?.cert || undefined,
            key: b.ssl?.key || undefined,
          }
        : undefined;
      if (b.engine === 'postgres') {
        // Return database text representations to preserve numeric and timestamp precision.
        postgres = new pg.Client({
          ...config,
          ssl,
          ...(tunnelPort ? { host: '127.0.0.1', port: tunnelPort } : {}),
          connectionTimeoutMillis: 15000,
          statement_timeout: 120000,
          types: { getTypeParser: () => (value: string) => value },
        });
        await postgres.connect();
        await postgres.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await postgres.query("SET LOCAL TIME ZONE 'UTC'; SET LOCAL DateStyle = 'ISO, YMD'");
        query = async (sql) => (await postgres!.query(sql)).rows;
        rows = async function* (table) {
          const cursor = postgres!.query(new Cursor(`SELECT * FROM ${qualified(table, b.engine)}`));
          try {
            while (true) {
              const batch = await cursor.read(1000);
              if (!batch.length) break;
              for (const row of batch) yield row;
            }
          } finally {
            await cursor.close();
          }
        };
      } else {
        if (ssl && isIP(originalHost))
          throw new Error(
            'Verified MySQL TLS requires a DNS hostname matching the server certificate.',
          );
        my = mysql.createConnection({
          ...config,
          ssl,
          ...(tunnelPort
            ? { stream: () => createConnection({ host: '127.0.0.1', port: tunnelPort! }) }
            : {}),
          supportBigNumbers: true,
          bigNumberStrings: true,
          dateStrings: true,
          decimalNumbers: false,
          jsonStrings: true,
          connectTimeout: 15000,
        });
        my.on('error', () => {});
        const promise = my.promise();
        await promise.connect();
        await promise.query("SET time_zone = '+00:00'");
        await promise.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await promise.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
        query = async (sql) => (await promise.query({ sql, timeout: 120000 }))[0] as Raw[];
        rows = async function* (table) {
          const stream = my!
            .query({ sql: `SELECT * FROM ${qualified(table, b.engine)}`, timeout: 120000 })
            .stream({ highWaterMark: 1000 });
          for await (const row of stream) yield row as Raw;
        };
      }
    }
    const inspect = async (): Promise<TableMeta[]> => {
      if (b.engine === 'sqlite') {
        const tables = await query(
          "SELECT name, sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        );
        const result: TableMeta[] = [];
        for (const t of tables) {
          const columns = await query(`PRAGMA table_xinfo(${literal(t.name)})`);
          const indexes = await query(
            `SELECT sql FROM sqlite_schema WHERE type='index' AND tbl_name=${literal(t.name)} AND sql IS NOT NULL ORDER BY name`,
          );
          const fks = await query(`PRAGMA foreign_key_list(${literal(t.name)})`);
          result.push({
            id: JSON.stringify(['main', t.name]),
            schema: 'main',
            name: t.name,
            columns: columns
              .filter((c) => c.hidden !== 1)
              .map((c) => ({
                name: c.name,
                type: c.type,
                nullable: !c.notnull && !c.pk,
                default: c.dflt_value,
                pk: Number(c.pk),
                extra: String(c.hidden),
              })),
            indexes: indexes.map((i) => i.sql),
            constraints: fks.map((f) => JSON.stringify(f)),
            definition: t.sql,
          });
        }
        return result;
      }
      if (b.engine === 'postgres') {
        const tables = await query(
          "SELECT schemaname AS schema, tablename AS name FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') AND schemaname NOT LIKE 'pg_toast%' ORDER BY schemaname,tablename",
        );
        const columns = await query(
          `SELECT n.nspname AS schema, c.relname AS table, a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type, NOT a.attnotnull AS nullable, pg_get_expr(d.adbin,d.adrelid) AS "default", COALESCE(array_position(i.indkey::smallint[],a.attnum)+1,0) AS pk, a.attidentity::text || ':' || a.attgenerated::text || ':' || COALESCE(coll.collname,'') AS extra FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum LEFT JOIN pg_index i ON i.indrelid=c.oid AND i.indisprimary LEFT JOIN pg_collation coll ON coll.oid=a.attcollation WHERE a.attnum>0 AND NOT a.attisdropped AND c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema') ORDER BY a.attnum`,
        );
        const indexes = await query(
          "SELECT schemaname AS schema, tablename AS table, indexdef AS definition FROM pg_indexes WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY indexname",
        );
        const constraints = await query(
          "SELECT n.nspname AS schema,c.relname AS table,con.conname || ': ' || pg_get_constraintdef(con.oid) AS definition FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace ORDER BY con.conname",
        );
        return tables.map((t) => ({
          id: JSON.stringify([t.schema, t.name]),
          schema: t.schema,
          name: t.name,
          columns: columns
            .filter((c) => c.schema === t.schema && c.table === t.name)
            .map((c) => ({
              name: c.name,
              type: c.type,
              nullable: c.nullable === 't' || c.nullable === true,
              default: c.default,
              pk: Number(c.pk),
              extra: c.extra,
            })),
          indexes: indexes
            .filter((i) => i.schema === t.schema && i.table === t.name)
            .map((i) => i.definition),
          constraints: constraints
            .filter((i) => i.schema === t.schema && i.table === t.name)
            .map((i) => i.definition),
        }));
      }
      const tables = await query(
        "SELECT TABLE_SCHEMA AS db, TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME",
      );
      const columns = await query(
        'SELECT * FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() ORDER BY ORDINAL_POSITION',
      );
      const keys = await query(
        "SELECT * FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND CONSTRAINT_NAME='PRIMARY'",
      );
      const result: TableMeta[] = [];
      for (const t of tables) {
        const ddl = (await query(`SHOW CREATE TABLE ${quote(t.name, b.engine)}`))[0][
          'Create Table'
        ] as string;
        const lines = ddl.split('\n').map((l) => l.trim().replace(/,$/, ''));
        result.push({
          id: JSON.stringify(['database', t.name]),
          schema: t.db,
          name: t.name,
          columns: columns
            .filter((c) => c.TABLE_NAME === t.name)
            .map((c) => ({
              name: c.COLUMN_NAME,
              type: c.COLUMN_TYPE,
              nullable: c.IS_NULLABLE === 'YES',
              default: c.COLUMN_DEFAULT === null ? null : String(c.COLUMN_DEFAULT),
              pk: Number(
                keys.find((k) => k.TABLE_NAME === t.name && k.COLUMN_NAME === c.COLUMN_NAME)
                  ?.ORDINAL_POSITION || 0,
              ),
              extra: [c.EXTRA, c.COLLATION_NAME, c.GENERATION_EXPRESSION].join('|'),
            })),
          indexes: lines.filter((l) => /^(UNIQUE |FULLTEXT |SPATIAL )?KEY /.test(l)).sort(),
          constraints: lines.filter((l) => /^(CONSTRAINT |PRIMARY KEY |CHECK )/.test(l)).sort(),
          definition: ddl.replace(/ AUTO_INCREMENT=\d+\b/g, ''),
        });
      }
      return result;
    };
    return {
      query,
      rows,
      inspect,
      close,
      databases: async () =>
        b.engine === 'sqlite'
          ? [b.file!]
          : (
              await query(
                b.engine === 'postgres'
                  ? 'SELECT datname AS name FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname'
                  : 'SHOW DATABASES',
              )
            ).map((r) => String(r.name ?? r.Database)),
    };
  } catch (error) {
    await close();
    throw error;
  }
}
