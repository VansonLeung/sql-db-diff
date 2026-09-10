import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Checkbox,
  Empty,
  Input,
  Popconfirm,
  Progress as ProgressBar,
  Segmented,
  Select,
  Spin,
  Table,
  Tabs,
  Tag,
  Tooltip,
} from 'antd';
import {
  ApartmentOutlined,
  ArrowRightOutlined,
  CheckCircleOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  EditOutlined,
  ExperimentOutlined,
  KeyOutlined,
  LockOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  SwapOutlined,
  TableOutlined,
} from '@ant-design/icons';
import ConnectionModal from './ConnectionModal';
import type {
  Bookmark,
  DataRow,
  Endpoint,
  Progress,
  RowDiff,
  RowStatus,
  TableMeta,
  TableResult,
  Value,
} from './shared';

const engineNames = { postgres: 'PostgreSQL', mysql: 'MySQL', sqlite: 'SQLite' };
const emptyBookmark: Bookmark = {
  id: '',
  name: '',
  engine: 'postgres',
  host: 'localhost',
  ssl: { enabled: false },
  ssh: { enabled: false },
};
const initialEndpoint = { bookmarkId: '', database: '' };
const primaryKeys = (t?: TableMeta) =>
  t?.columns
    .filter((c) => c.pk)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name) || [];
const keyDefaults = (a?: TableMeta, b?: TableMeta) =>
  !a || !b
    ? primaryKeys(a || b)
    : JSON.stringify(primaryKeys(a)) === JSON.stringify(primaryKeys(b))
      ? primaryKeys(a)
      : [];
const valueText = (v?: Value) =>
  !v
    ? '— missing —'
    : v.type === 'null'
      ? 'NULL'
      : v.type === 'binary'
        ? `0x${v.value}`
        : typeof v.value === 'object'
          ? JSON.stringify(v.value)
          : String(v.value);
const rowKeyText = (key: string) => (JSON.parse(key) as Value[]).map(valueText).join(' · ');
function CellValue({ value }: { value?: Value }) {
  return (
    <span
      className={value?.type === 'null' || !value ? 'null-value' : 'cell-value'}
      title={value ? `${value.type}: ${valueText(value)}` : 'Missing column'}
    >
      {valueText(value)}
    </span>
  );
}

export default function App() {
  const { message } = AntApp.useApp();
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]),
    [editing, setEditing] = useState<Bookmark>();
  const [left, setLeft] = useState<Endpoint>(initialEndpoint),
    [right, setRight] = useState<Endpoint>(initialEndpoint);
  const [databases, setDatabases] = useState<Record<string, string[]>>({}),
    [dbLoading, setDbLoading] = useState<Record<string, boolean>>({});
  const [meta, setMeta] = useState<{ left: TableMeta[]; right: TableMeta[] }>(),
    [selected, setSelected] = useState<string[]>([]),
    [keys, setKeys] = useState<Record<string, string[]>>({});
  const [focused, setFocused] = useState<string>(),
    [search, setSearch] = useState(''),
    [onlyDiff, setOnlyDiff] = useState(false),
    [schemaOnly, setSchemaOnly] = useState(false);
  const [loading, setLoading] = useState(false),
    [running, setRunning] = useState(false),
    [progress, setProgress] = useState<Progress>(),
    [results, setResults] = useState<Record<string, TableResult>>({});
  const [rows, setRows] = useState<RowDiff[]>([]),
    [rowTotal, setRowTotal] = useState(0),
    [page, setPage] = useState(1),
    [rowFilter, setRowFilter] = useState<'all' | RowStatus>('all'),
    [rowsLoading, setRowsLoading] = useState(false),
    [tab, setTab] = useState('schema');
  const [error, setError] = useState('');
  const runId = useRef<string | undefined>(undefined),
    loadVersion = useRef(0);
  const api = window.dbDiff;
  const report = (e: unknown) => {
    const text = e instanceof Error ? e.message : String(e);
    setError(text);
  };
  useEffect(() => {
    if (!api) return;
    api.bookmarks.list().then(setBookmarks).catch(report);
    return api.onProgress((p) => {
      if (runId.current && p.runId !== runId.current) return;
      setProgress(p);
      if (p.result) setResults((r) => ({ ...r, [p.result!.id]: p.result! }));
      if (p.state !== 'running') {
        setRunning(false);
        if (p.state === 'error') setError(p.message || 'Comparison failed.');
        if (p.state === 'done') setTab('rows');
      }
    });
  }, []);
  useEffect(() => {
    let live = true;
    setRows([]);
    setRowTotal(0);
    if (!api || !focused || running || progress?.state !== 'done') return;
    setRowsLoading(true);
    api
      .rows(focused, page, rowFilter === 'all' ? undefined : rowFilter)
      .then((data) => {
        if (live) {
          setRows(data.rows);
          setRowTotal(data.total);
        }
      })
      .catch((e) => {
        if (live) report(e);
      })
      .finally(() => {
        if (live) setRowsLoading(false);
      });
    return () => {
      live = false;
    };
  }, [focused, page, rowFilter, running, progress?.state]);
  function reset() {
    loadVersion.current++;
    setMeta(undefined);
    setResults({});
    setProgress(undefined);
    setFocused(undefined);
    setSelected([]);
    setRows([]);
    setError('');
    runId.current = undefined;
  }
  async function loadDatabases(id: string) {
    if (!id) return;
    setDbLoading((s) => ({ ...s, [id]: true }));
    try {
      const dbs = await api.databases(id);
      setDatabases((d) => ({ ...d, [id]: dbs }));
      return dbs;
    } catch (e) {
      report(e);
    } finally {
      setDbLoading((s) => ({ ...s, [id]: false }));
    }
  }
  function chooseConnection(side: 'left' | 'right', id: string) {
    reset();
    const b = bookmarks.find((b) => b.id === id)!;
    const next = {
      bookmarkId: id,
      database: b.engine === 'sqlite' ? b.file || '' : b.database || '',
    };
    if (side === 'left') setLeft(next);
    else setRight(next);
    void loadDatabases(id);
  }
  const lb = bookmarks.find((b) => b.id === left.bookmarkId),
    rb = bookmarks.find((b) => b.id === right.bookmarkId);
  const compatible = !!lb && !!rb && lb.engine === rb.engine;
  async function inspect() {
    setLoading(true);
    setError('');
    const version = ++loadVersion.current;
    try {
      const [a, b] = await Promise.all([api.inspect(left), api.inspect(right)]);
      if (version !== loadVersion.current) return;
      setMeta({ left: a, right: b });
      const ids = [...new Set([...a, ...b].map((t) => t.id))];
      setSelected(ids);
      setFocused(ids[0]);
      setKeys(
        Object.fromEntries(
          ids.map((id) => [
            id,
            keyDefaults(
              a.find((t) => t.id === id),
              b.find((t) => t.id === id),
            ),
          ]),
        ),
      );
      setResults({});
      setProgress(undefined);
      setTab('schema');
    } catch (e) {
      report(e);
    } finally {
      setLoading(false);
    }
  }
  async function compare() {
    setError('');
    setResults({});
    setRows([]);
    setRowTotal(0);
    setRunning(true);
    runId.current = undefined;
    setProgress({ runId: '', state: 'running', completed: 0, total: selected.length });
    try {
      runId.current = await api.compare({ left, right, tables: selected, keys, schemaOnly });
    } catch (e) {
      setRunning(false);
      setProgress(undefined);
      report(e);
    }
  }
  async function demo() {
    setLoading(true);
    try {
      const list = await api.demo();
      setBookmarks(list);
      reset();
      const a = list.find((b) => b.id === 'demo-source')!,
        b = list.find((b) => b.id === 'demo-target')!;
      setLeft({ bookmarkId: a.id, database: a.file! });
      setRight({ bookmarkId: b.id, database: b.file! });
      setDatabases((d) => ({ ...d, [a.id]: [a.file!], [b.id]: [b.file!] }));
      message.success('Demo databases are ready. Load tables to explore.');
    } catch (e) {
      report(e);
    } finally {
      setLoading(false);
    }
  }
  async function remove(id: string) {
    try {
      await api.bookmarks.remove(id);
      setBookmarks((b) => b.filter((x) => x.id !== id));
      if (left.bookmarkId === id) {
        setLeft(initialEndpoint);
        reset();
      }
      if (right.bookmarkId === id) {
        setRight(initialEndpoint);
        reset();
      }
    } catch (e) {
      report(e);
    }
  }
  const tables = meta
    ? [...new Map([...meta.left, ...meta.right].map((t) => [t.id, t])).values()].sort((a, b) =>
        a.name.localeCompare(b.name),
      )
    : [];
  const visible = tables.filter(
    (t) =>
      `${t.schema}.${t.name}`.toLowerCase().includes(search.toLowerCase()) &&
      (!onlyDiff ||
        (results[t.id] &&
          (results[t.id].schemaChanged ||
            results[t.id].added + results[t.id].removed + results[t.id].changed > 0 ||
            results[t.id].state === 'error'))),
  );
  const a = meta?.left.find((t) => t.id === focused),
    b = meta?.right.find((t) => t.id === focused),
    current = focused ? results[focused] : undefined;
  const totals = Object.values(results).reduce(
    (s, r) => ({
      added: s.added + r.added,
      removed: s.removed + r.removed,
      changed: s.changed + r.changed,
      schemas: s.schemas + Number(r.schemaChanged),
    }),
    { added: 0, removed: 0, changed: 0, schemas: 0 },
  );
  const busy = loading || running;
  const pick = (id: string) => {
    setFocused(id);
    setPage(1);
    setRowFilter('all');
  };
  const endpointCard = (side: 'left' | 'right', endpoint: Endpoint, bookmark?: Bookmark) => (
    <div className="endpoint-card">
      <div className="eyebrow">
        <span className={`side-marker ${side}`}>{side === 'left' ? 'A' : 'B'}</span>
        {side === 'left' ? 'SOURCE DATABASE' : 'TARGET DATABASE'}
      </div>
      <Select
        aria-label={`${side} connection`}
        className="connection-select"
        variant="borderless"
        placeholder="Choose a connection"
        value={endpoint.bookmarkId || undefined}
        disabled={busy}
        onChange={(id) => chooseConnection(side, id)}
        options={bookmarks.map((x) => ({
          value: x.id,
          label: (
            <span>
              <DatabaseOutlined /> &nbsp;{x.name}{' '}
              <span className="option-engine">{engineNames[x.engine]}</span>
            </span>
          ),
        }))}
      />
      <div className="database-select">
        <DatabaseOutlined />
        <Select
          aria-label={`${side} database`}
          showSearch
          optionFilterProp="label"
          placeholder="Select database"
          value={endpoint.database || undefined}
          disabled={!bookmark || busy}
          loading={dbLoading[endpoint.bookmarkId]}
          onChange={(database) => {
            reset();
            (side === 'left' ? setLeft : setRight)({ ...endpoint, database });
          }}
          options={[
            ...new Set([
              ...(databases[endpoint.bookmarkId] || []),
              ...(endpoint.database ? [endpoint.database] : []),
            ]),
          ].map((db) => ({
            value: db,
            label: bookmark?.engine === 'sqlite' ? db.split('/').pop()! : db,
          }))}
        />
        <Tooltip title="Refresh databases">
          <Button
            aria-label={`Refresh ${side} databases`}
            type="text"
            icon={<ReloadOutlined />}
            disabled={!bookmark || busy}
            onClick={() => loadDatabases(endpoint.bookmarkId)}
          />
        </Tooltip>
      </div>
    </div>
  );
  if (!api)
    return (
      <div className="browser-notice">
        <DatabaseOutlined />
        <h1>SQL DB Diff</h1>
        <p>Open the Electron desktop app to connect to your databases.</p>
        <code>npm run dev</code>
      </div>
    );
  return (
    <div className="app-shell">
      <header className="titlebar">
        <span>SQL DB Diff</span>
        <span className="titlebar-tag">
          <LockOutlined /> Read-only workspace
        </span>
      </header>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <SwapOutlined />
          </div>
          <div>
            SQL DB Diff<small>DATABASE WORKSPACE</small>
          </div>
        </div>
        <div className="nav-active">
          <ApartmentOutlined /> Database comparison
        </div>
        <div className="sidebar-heading">
          CONNECTIONS
          <Button
            size="small"
            type="text"
            aria-label="Add connection"
            icon={<PlusOutlined />}
            disabled={busy}
            onClick={() => setEditing({ ...emptyBookmark })}
          />
        </div>
        <div className="bookmark-list">
          {bookmarks.map((item) => (
            <div
              className={`bookmark ${[left.bookmarkId, right.bookmarkId].includes(item.id) ? 'selected' : ''}`}
              key={item.id}
            >
              <div className={`engine-icon ${item.engine}`}>
                <DatabaseOutlined />
              </div>
              <div className="bookmark-label">
                <strong>{item.name}</strong>
                <small>
                  {engineNames[item.engine]} ·{' '}
                  {item.engine === 'sqlite'
                    ? 'Local file'
                    : item.ssh?.enabled
                      ? 'SSH tunnel'
                      : item.host || 'URL connection'}
                </small>
              </div>
              <div className="bookmark-actions">
                <Button
                  type="text"
                  size="small"
                  aria-label={`Edit ${item.name}`}
                  disabled={busy}
                  icon={<EditOutlined />}
                  onClick={() => setEditing(item)}
                />
                <Popconfirm
                  title="Remove this connection bookmark?"
                  description="The database itself will not be changed."
                  onConfirm={() => remove(item.id)}
                >
                  <Button
                    type="text"
                    size="small"
                    danger
                    aria-label={`Remove ${item.name}`}
                    disabled={busy}
                    icon={<DeleteOutlined />}
                  />
                </Popconfirm>
              </div>
            </div>
          ))}
          {!bookmarks.length && (
            <p className="sidebar-empty">Your saved connections will appear here.</p>
          )}
        </div>
        <Button
          className="add-connection"
          icon={<PlusOutlined />}
          disabled={busy}
          onClick={() => setEditing({ ...emptyBookmark })}
        >
          New connection
        </Button>
        <div className="sidebar-bottom">
          <div className="local-label">
            <span /> Local & private
          </div>
          <p>Your connections stay on this Mac.</p>
          <Button type="text" icon={<ExperimentOutlined />} disabled={busy} onClick={demo}>
            Try demo databases
          </Button>
          <small>v0.1.0 · macOS</small>
        </div>
      </aside>
      <main>
        <div className="page-heading">
          <div>
            <div className="eyebrow">DATABASE TOOLS</div>
            <h1>Compare databases</h1>
            <p>See what changed. Down to the last field.</p>
          </div>
          <Tag icon={<LockOutlined />} bordered={false}>
            Read-only
          </Tag>
        </div>
        {error && (
          <Alert
            className="error-banner"
            type="error"
            showIcon
            closable
            title={error}
            onClose={() => setError('')}
          />
        )}
        <section className="connection-panel">
          {endpointCard('left', left, lb)}
          <Button
            className="swap-button"
            shape="circle"
            aria-label="Swap source and target"
            icon={<SwapOutlined />}
            disabled={busy}
            onClick={() => {
              reset();
              setLeft(right);
              setRight(left);
            }}
          />
          {endpointCard('right', right, rb)}
          <div className="connection-action">
            <Button
              icon={<ReloadOutlined />}
              loading={loading}
              disabled={!compatible || !left.database || !right.database || running}
              onClick={inspect}
            >
              {meta ? 'Reload tables' : 'Load tables'}
            </Button>
            <span>
              {compatible
                ? engineNames[lb!.engine]
                : lb && rb
                  ? 'Select the same engine'
                  : 'Select two databases'}
            </span>
          </div>
        </section>
        <div className="compare-toolbar">
          <div>
            <span className="step-dot">1</span>
            <strong>
              {meta ? `${selected.length} tables selected` : 'Connect your databases'}
            </strong>
            <span className="muted">
              {meta
                ? 'Review matching keys, then compare.'
                : 'Choose a source and target to get started.'}
            </span>
          </div>
          <div>
            <Checkbox
              checked={schemaOnly}
              disabled={busy}
              onChange={(e) => setSchemaOnly(e.target.checked)}
            >
              Schema only
            </Checkbox>
            {running ? (
              <Button
                danger
                onClick={async () => {
                  try {
                    await api.cancel();
                    setRunning(false);
                    setResults({});
                  } catch (e) {
                    report(e);
                  }
                }}
              >
                Cancel comparison
              </Button>
            ) : (
              <Button
                type="primary"
                icon={<SwapOutlined />}
                disabled={!meta || !selected.length || loading}
                onClick={compare}
              >
                Compare databases
              </Button>
            )}
          </div>
        </div>
        {progress && (
          <div className="progress-strip">
            <ProgressBar
              percent={progress.total ? Math.round((progress.completed / progress.total) * 100) : 0}
              status={
                progress.state === 'error'
                  ? 'exception'
                  : progress.state === 'running'
                    ? 'active'
                    : 'normal'
              }
              showInfo={false}
            />
            <span>
              {progress.state === 'running'
                ? `Comparing ${progress.table || 'schemas'} · ${(progress.scanned || 0).toLocaleString()} rows read`
                : progress.state === 'done'
                  ? `Comparison complete · ${progress.completed} tables`
                  : progress.state === 'cancelled'
                    ? 'Comparison cancelled'
                    : 'Comparison stopped'}
            </span>
          </div>
        )}
        <div className="stats">
          <div>
            <span className="stat-icon violet">
              <TableOutlined />
            </span>
            <div>
              <strong>{meta ? tables.length : '—'}</strong>
              <span>Tables discovered</span>
            </div>
          </div>
          <div>
            <span className="stat-icon blue">
              <ApartmentOutlined />
            </span>
            <div>
              <strong>{progress ? totals.schemas : '—'}</strong>
              <span>Schema differences</span>
            </div>
          </div>
          <div>
            <span className="stat-icon amber">~</span>
            <div>
              <strong>{progress ? totals.changed.toLocaleString() : '—'}</strong>
              <span>Changed rows</span>
            </div>
          </div>
          <div>
            <span className="stat-icon green">±</span>
            <div>
              <strong>{progress ? (totals.added + totals.removed).toLocaleString() : '—'}</strong>
              <span>Added / removed rows</span>
            </div>
          </div>
        </div>
        <section className="results-workspace">
          <div className="tables-pane">
            <div className="pane-heading">
              <strong>Tables</strong>
              <span className="count-pill">{tables.length}</span>
            </div>
            <Input
              aria-label="Search tables"
              prefix={<SearchOutlined />}
              placeholder="Find a table…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="table-filter">
              <Checkbox
                disabled={!meta || busy}
                checked={!!tables.length && selected.length === tables.length}
                indeterminate={!!selected.length && selected.length < tables.length}
                onChange={(e) => setSelected(e.target.checked ? tables.map((t) => t.id) : [])}
              >
                Select all
              </Checkbox>
              <Tooltip title="Show only completed tables with differences">
                <Button
                  type={onlyDiff ? 'primary' : 'text'}
                  size="small"
                  onClick={() => setOnlyDiff(!onlyDiff)}
                >
                  Differences
                </Button>
              </Tooltip>
            </div>
            <div className="table-list">
              {visible.map((t) => {
                const r = results[t.id];
                return (
                  <div key={t.id} className={`table-item ${focused === t.id ? 'active' : ''}`}>
                    <Checkbox
                      aria-label={`Select ${t.name}`}
                      disabled={busy}
                      checked={selected.includes(t.id)}
                      onChange={(e) =>
                        setSelected((s) =>
                          e.target.checked ? [...s, t.id] : s.filter((id) => id !== t.id),
                        )
                      }
                    />
                    <button onClick={() => pick(t.id)}>
                      <TableOutlined />
                      <span>
                        <strong>{t.name}</strong>
                        <small>{lb?.engine === 'mysql' ? 'database' : t.schema}</small>
                      </span>
                      {r ? (
                        <span
                          className={`table-status ${r.state === 'error' ? 'error' : r.state === 'skipped' ? 'skipped' : r.schemaChanged || r.added + r.removed + r.changed ? 'different' : 'equal'}`}
                        >
                          {r.state === 'error'
                            ? '!'
                            : r.state === 'skipped'
                              ? '—'
                              : r.schemaChanged || r.added + r.removed + r.changed
                                ? '●'
                                : '✓'}
                        </span>
                      ) : (
                        <span className="table-status pending">·</span>
                      )}
                    </button>
                  </div>
                );
              })}
              {!visible.length && (
                <div className="list-empty">
                  {meta ? 'No matching tables' : 'Load databases to see tables'}
                </div>
              )}
            </div>
            <div className="table-legend">
              <span className="green-text">●</span> Equal <span className="amber-text">●</span>{' '}
              Different <span>—</span> Skipped
            </div>
          </div>
          <div className="detail-pane">
            {!focused ? (
              <div className="welcome">
                <div className="welcome-graphic">
                  <DatabaseOutlined />
                  <span>
                    <SwapOutlined />
                  </span>
                  <DatabaseOutlined />
                </div>
                <h2>A clear view of every difference</h2>
                <p>
                  Compare table structures and records side by side.
                  <br />
                  Start with two connections, or explore with sample data.
                </p>
                <Button icon={<ExperimentOutlined />} onClick={demo} disabled={busy}>
                  Explore demo databases <ArrowRightOutlined />
                </Button>
                <div className="welcome-features">
                  <span>
                    <CheckCircleOutlined /> Three SQL engines
                  </span>
                  <span>
                    <LockOutlined /> Read-only access
                  </span>
                  <span>
                    <KeyOutlined /> Field-level detail
                  </span>
                </div>
              </div>
            ) : (
              <>
                <div className="detail-heading">
                  <div>
                    <TableOutlined />
                    <h2>{(a || b)?.name}</h2>
                    {!a ? (
                      <Tag color="green">Target only</Tag>
                    ) : !b ? (
                      <Tag color="red">Source only</Tag>
                    ) : current ? (
                      <Tag color={current.schemaChanged ? 'gold' : 'green'}>
                        {current.schemaChanged ? 'Schema changed' : 'Schema equal'}
                      </Tag>
                    ) : null}
                  </div>
                  <span className="muted">{(a || b)?.columns.length} columns</span>
                </div>
                <div className="key-picker">
                  <KeyOutlined />
                  <span>Match rows by</span>
                  <Select
                    aria-label="Row matching columns"
                    mode="multiple"
                    placeholder="Choose unique, non-null columns"
                    value={keys[focused] || []}
                    disabled={busy}
                    onChange={(v) => setKeys((k) => ({ ...k, [focused]: v }))}
                    options={(a || b)!.columns
                      .filter((c) => !a || !b || b.columns.some((x) => x.name === c.name))
                      .map((c) => ({ value: c.name, label: c.name + (c.pk ? ' · PK' : '') }))}
                  />
                </div>
                {!(keys[focused] || []).length && !schemaOnly && (
                  <Alert
                    type="warning"
                    showIcon
                    title="No shared primary key. Select matching columns above to include row comparison."
                  />
                )}
                {current?.message && (
                  <Alert
                    showIcon
                    type={current.state === 'error' ? 'error' : 'info'}
                    title={current.message}
                  />
                )}
                <Tabs
                  activeKey={tab}
                  onChange={setTab}
                  items={[
                    {
                      key: 'schema',
                      label: 'Table schema',
                      children: <SchemaView left={a} right={b} />,
                    },
                    {
                      key: 'rows',
                      label: (
                        <>
                          Row differences{' '}
                          {current && (
                            <span className="tab-count">
                              {current.added + current.removed + current.changed}
                            </span>
                          )}
                        </>
                      ),
                      children: (
                        <>
                          <div className="row-toolbar">
                            <Segmented
                              value={rowFilter}
                              onChange={(v) => {
                                setRowFilter(v as typeof rowFilter);
                                setPage(1);
                              }}
                              options={[
                                { label: 'All differences', value: 'all' },
                                { label: `Changed ${current?.changed || 0}`, value: 'changed' },
                                { label: `Added ${current?.added || 0}`, value: 'added' },
                                { label: `Removed ${current?.removed || 0}`, value: 'removed' },
                              ]}
                            />
                          </div>
                          {progress?.state !== 'done' ? (
                            <Empty
                              image={Empty.PRESENTED_IMAGE_SIMPLE}
                              description={
                                running
                                  ? 'Reading databases. Results will appear when the comparison completes.'
                                  : 'Run a comparison to view row and field differences.'
                              }
                            />
                          ) : (
                            <Table<RowDiff>
                              size="small"
                              loading={rowsLoading}
                              rowKey="id"
                              dataSource={rows}
                              pagination={{
                                current: page,
                                pageSize: 100,
                                total: rowTotal,
                                showSizeChanger: false,
                                onChange: setPage,
                                showTotal: (n) => `${n.toLocaleString()} differences`,
                              }}
                              locale={{
                                emptyText:
                                  current?.state === 'error' || current?.state === 'skipped'
                                    ? current.message
                                    : 'No row differences',
                              }}
                              columns={[
                                {
                                  title: 'Matching key',
                                  dataIndex: 'key',
                                  render: (k) => <code>{rowKeyText(k)}</code>,
                                },
                                {
                                  title: 'Status',
                                  dataIndex: 'status',
                                  width: 100,
                                  render: (s) => (
                                    <Tag
                                      color={
                                        s === 'added' ? 'green' : s === 'removed' ? 'red' : 'gold'
                                      }
                                    >
                                      {s}
                                    </Tag>
                                  ),
                                },
                                {
                                  title: 'Different fields',
                                  dataIndex: 'fields',
                                  render: (f: string[]) => f.join(', '),
                                },
                              ]}
                              expandable={{
                                expandedRowRender: (row) => <FieldDiff row={row} />,
                                rowExpandable: () => true,
                              }}
                            />
                          )}
                        </>
                      ),
                    },
                    {
                      key: 'definitions',
                      label: 'Indexes & constraints',
                      children: (
                        <div className="definitions-grid">
                          {[a, b].map((t, i) => (
                            <div key={i}>
                              <div className="eyebrow">{i === 0 ? 'SOURCE' : 'TARGET'}</div>
                              <h3>Indexes</h3>
                              <pre>{t?.indexes.join('\n\n') || 'None'}</pre>
                              <h3>Constraints</h3>
                              <pre>{t?.constraints.join('\n\n') || 'None'}</pre>
                              {t?.definition && (
                                <>
                                  <h3>Table definition</h3>
                                  <pre>{t.definition}</pre>
                                </>
                              )}
                            </div>
                          ))}
                        </div>
                      ),
                    },
                  ]}
                />
              </>
            )}
          </div>
        </section>
        <footer className="workspace-footer">
          <span>
            <LockOutlined /> Source and target databases are never modified.
          </span>
          <span>
            Source → Target <span className="footer-dot">·</span> Added = target only
          </span>
        </footer>
      </main>
      {editing && (
        <ConnectionModal
          value={editing}
          onClose={() => setEditing(undefined)}
          onSaved={(b) => {
            setBookmarks((s) => [...s.filter((x) => x.id !== b.id), b]);
            setEditing(undefined);
            setDatabases((d) => ({ ...d, [b.id]: [] }));
            if (left.bookmarkId === b.id) {
              setLeft({
                bookmarkId: b.id,
                database: b.engine === 'sqlite' ? b.file || '' : b.database || '',
              });
              reset();
            }
            if (right.bookmarkId === b.id) {
              setRight({
                bookmarkId: b.id,
                database: b.engine === 'sqlite' ? b.file || '' : b.database || '',
              });
              reset();
            }
            message.success('Connection saved');
          }}
        />
      )}
    </div>
  );
}
function SchemaView({ left, right }: { left?: TableMeta; right?: TableMeta }) {
  const names = [
    ...new Set([...(left?.columns || []), ...(right?.columns || [])].map((c) => c.name)),
  ];
  const data = names.map((name) => ({
    name,
    left: left?.columns.find((c) => c.name === name),
    right: right?.columns.find((c) => c.name === name),
  }));
  const render = (c: TableMeta['columns'][0] | undefined) => (
    <div className="schema-cell">
      {c ? (
        <>
          <code>{c.type || '(untyped)'}</code>
          <div>
            {c.pk > 0 && <Tag icon={<KeyOutlined />}>PK {c.pk}</Tag>}
            <span className="muted">
              {c.nullable ? 'nullable' : 'not null'}
              {c.default !== null && ` · default ${c.default}`}
              {c.extra && c.extra !== '0' && ` · ${c.extra}`}
            </span>
          </div>
        </>
      ) : (
        <span className="null-value">— missing —</span>
      )}
    </div>
  );
  return (
    <Table
      size="small"
      rowKey="name"
      pagination={false}
      dataSource={data}
      rowClassName={(r) =>
        JSON.stringify(r.left) === JSON.stringify(r.right) ? '' : 'schema-different'
      }
      columns={[
        {
          title: 'Column',
          dataIndex: 'name',
          width: '26%',
          render: (name: string, r) => (
            <span>
              <strong>{name}</strong>
              {JSON.stringify(r.left) !== JSON.stringify(r.right) && (
                <span className="change-dot" />
              )}
            </span>
          ),
        },
        { title: 'A · Source', dataIndex: 'left', width: '37%', render },
        { title: 'B · Target', dataIndex: 'right', width: '37%', render },
      ]}
    />
  );
}
function FieldDiff({ row }: { row: RowDiff }) {
  const fields = [...new Set([...Object.keys(row.left || {}), ...Object.keys(row.right || {})])];
  return (
    <Table
      size="small"
      pagination={false}
      rowKey="field"
      dataSource={fields.map((field) => ({
        field,
        left: row.left?.[field],
        right: row.right?.[field],
      }))}
      rowClassName={(r) => (row.fields.includes(r.field) ? 'field-changed' : '')}
      columns={[
        { title: 'Field', dataIndex: 'field', width: '24%' },
        {
          title: 'A · Source value',
          dataIndex: 'left',
          width: '38%',
          render: (value) => <CellValue value={value} />,
        },
        {
          title: 'B · Target value',
          dataIndex: 'right',
          width: '38%',
          render: (value) => <CellValue value={value} />,
        },
      ]}
    />
  );
}
