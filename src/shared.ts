export type Engine = 'postgres' | 'mysql' | 'sqlite';
export const DESKTOP_PROTOCOL_VERSION = 1;
export const SQL_TEXT_LIMIT = 5_000_000;
export const PASTED_SQL_DATABASE = 'Pasted SQL';
export interface Bookmark {
  id: string;
  name: string;
  engine: Engine;
  input?: 'database' | 'sql';
  sqlSource?: 'file' | 'text';
  sqlText?: string;
  sqlContent?: 'schema' | 'data';
  sqlVersion?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  url?: string;
  file?: string;
  ssl?: { enabled: boolean; ca?: string; cert?: string; key?: string };
  ssh?: {
    enabled: boolean;
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    privateKey?: string;
    passphrase?: string;
    fingerprint?: string;
  };
}
export interface Column {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  pk: number;
  extra?: string;
}
export interface TableMeta {
  id: string;
  schema: string;
  name: string;
  columns: Column[];
  indexes: string[];
  constraints: string[];
  definition?: string;
}
export interface Endpoint {
  bookmarkId: string;
  database: string;
}
export interface ComparisonRequest {
  left: Endpoint;
  right: Endpoint;
  tables: string[];
  keys: Record<string, string[]>;
  schemaOnly: boolean;
}
export type RowStatus = 'added' | 'removed' | 'changed';
export type Value = { type: string; value: unknown };
export type DataRow = Record<string, Value>;
export interface RowDiff {
  id: number;
  status: RowStatus;
  key: string;
  left: DataRow | null;
  right: DataRow | null;
  fields: string[];
}
export interface TableResult {
  id: string;
  name: string;
  left?: TableMeta;
  right?: TableMeta;
  schemaChanged: boolean;
  added: number;
  removed: number;
  changed: number;
  equal: number;
  scanned: number;
  state: 'pending' | 'running' | 'done' | 'skipped' | 'error';
  message?: string;
}
export interface Progress {
  runId: string;
  state: 'running' | 'done' | 'error' | 'cancelled';
  completed: number;
  total: number;
  table?: string;
  scanned?: number;
  result?: TableResult;
  message?: string;
}
export interface API {
  bookmarks: {
    list(): Promise<Bookmark[]>;
    save(value: Bookmark): Promise<Bookmark>;
    remove(id: string): Promise<void>;
  };
  chooseFile(): Promise<string | undefined>;
  test(bookmark: Bookmark): Promise<string[]>;
  databases(id: string): Promise<string[]>;
  inspect(endpoint: Endpoint): Promise<TableMeta[]>;
  compare(request: ComparisonRequest): Promise<string>;
  cancel(): Promise<void>;
  rows(
    table: string,
    page: number,
    status?: RowStatus,
  ): Promise<{ rows: RowDiff[]; total: number }>;
  demo(): Promise<Bookmark[]>;
  onProgress(callback: (progress: Progress) => void): () => void;
}
declare global {
  interface Window {
    dbDiff: API;
  }
}
