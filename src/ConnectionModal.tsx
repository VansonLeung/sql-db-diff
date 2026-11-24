import { useState } from 'react';
import {
  App,
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Segmented,
  Select,
  Switch,
  Tabs,
  Alert,
} from 'antd';
import { FolderOpenOutlined, ThunderboltOutlined } from '@ant-design/icons';
import type { Bookmark } from './shared';
import { SQL_TEXT_LIMIT } from './shared';
export default function ConnectionModal({
  value,
  onClose,
  onSaved,
}: {
  value: Bookmark;
  onClose: () => void;
  onSaved: (value: Bookmark) => void;
}) {
  const [form] = Form.useForm<Bookmark>();
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const { message } = App.useApp();
  const engine = Form.useWatch('engine', form) || value.engine;
  const input = Form.useWatch('input', form) || value.input || 'database';
  const sql = input === 'sql';
  const sqlSource = Form.useWatch('sqlSource', form) || value.sqlSource || 'file';
  const formValue = () => {
    const b = { ...form.getFieldsValue(true) } as Bookmark;
    if (b.input === 'sql') {
      if (b.sqlSource === 'text') b.file = undefined;
      else b.sqlText = undefined;
    } else {
      b.sqlSource = undefined;
      b.sqlText = undefined;
    }
    return b;
  };
  const field = (name: string | string[], label: string, secret = false, placeholder?: string) => (
    <Form.Item name={name} label={label}>
      {secret ? <Input.Password placeholder={placeholder} /> : <Input placeholder={placeholder} />}
    </Form.Item>
  );
  async function test() {
    setTesting(true);
    try {
      await form.validateFields();
      const b = formValue();
      const dbs = await window.dbDiff.test(b);
      message.success(
        `${sql ? 'Imported' : 'Connected'} · ${dbs.length} database${dbs.length === 1 ? '' : 's'} available`,
      );
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Check the connection details.');
    } finally {
      setTesting(false);
    }
  }
  async function save() {
    try {
      await form.validateFields();
      const b = formValue();
      setBusy(true);
      onSaved(await window.dbDiff.bookmarks.save(b));
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Check the connection details.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      title={value.id ? 'Edit input' : 'New input'}
      onCancel={onClose}
      width={620}
      footer={
        <div className="modal-footer">
          <Button icon={<ThunderboltOutlined />} loading={testing} disabled={busy} onClick={test}>
            {sql ? 'Test SQL import' : 'Test connection'}
          </Button>
          <div>
            <Button onClick={onClose}>Cancel</Button>{' '}
            <Button type="primary" loading={busy} disabled={testing} onClick={save}>
              Save input
            </Button>
          </div>
        </div>
      }
    >
      <Form form={form} layout="vertical" initialValues={value} requiredMark={false}>
        <Form.Item name="id" hidden>
          <Input />
        </Form.Item>
        <Form.Item name="input" label="Input type" initialValue="database">
          <Select
            options={[
              { value: 'database', label: 'Database' },
              { value: 'sql', label: 'SQL' },
            ]}
          />
        </Form.Item>
        <div className="form-grid">
          <Form.Item
            name="name"
            label="Bookmark name"
            rules={[{ required: true, whitespace: true }]}
          >
            <Input placeholder="Production · read replica" />
          </Form.Item>
          <Form.Item name="engine" label="Database engine">
            <Select
              onChange={() => form.setFieldValue('sqlVersion', undefined)}
              options={[
                { value: 'postgres', label: 'PostgreSQL' },
                { value: 'mysql', label: 'MySQL' },
                { value: 'sqlite', label: 'SQLite' },
              ]}
            />
          </Form.Item>
        </div>
        {sql && (
          <Form.Item name="sqlSource" label="SQL source" initialValue="file">
            <Segmented
              aria-label="SQL source"
              options={[
                { value: 'file', label: 'SQL file' },
                { value: 'text', label: 'Paste SQL text' },
              ]}
            />
          </Form.Item>
        )}
        {sql && sqlSource === 'text' ? (
          <Form.Item
            name="sqlText"
            label="SQL text"
            rules={[
              { required: true, whitespace: true, message: 'Paste SQL text.' },
              { max: SQL_TEXT_LIMIT, message: 'Choose a SQL file for larger dumps.' },
            ]}
            extra="Paste a complete schema or schema-and-data dump. For more than 5 million characters, choose a SQL file."
          >
            <Input.TextArea
              className="sql-textarea"
              autoSize={{ minRows: 10, maxRows: 18 }}
              spellCheck={false}
              placeholder={
                "CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT);\nINSERT INTO customers VALUES (1, 'Ada');"
              }
            />
          </Form.Item>
        ) : sql || engine === 'sqlite' ? (
          <Form.Item label={sql ? 'SQL file' : 'Database file'} required>
            <div className="file-field">
              <Form.Item
                name="file"
                noStyle
                rules={[
                  {
                    required: true,
                    message: sql ? 'Choose a SQL file.' : 'Choose a database file.',
                  },
                ]}
              >
                <Input placeholder={sql ? '/path/to/dump.sql' : '/path/to/database.sqlite'} />
              </Form.Item>
              <Button
                aria-label={sql ? 'Choose SQL file' : 'Choose database file'}
                icon={<FolderOpenOutlined />}
                onClick={async () => {
                  const file = await window.dbDiff.chooseFile();
                  if (file) form.setFieldValue('file', file);
                }}
              />
            </div>
          </Form.Item>
        ) : (
          <Tabs
            items={[
              {
                key: 'general',
                label: 'Connection',
                children: (
                  <>
                    <Alert
                      type="info"
                      showIcon
                      title="Use a connection URL or enter the host details below."
                      className="form-alert"
                    />
                    {field(
                      'url',
                      'Connection URL',
                      true,
                      engine === 'postgres'
                        ? 'postgresql://user:password@host:5432/database'
                        : 'mysql://user:password@host:3306/database',
                    )}
                    <div className="form-grid">
                      {field('host', 'Host', false, 'localhost')}
                      <Form.Item name="port" label="Port" normalize={(v) => v ?? undefined}>
                        <InputNumber
                          min={1}
                          max={65535}
                          placeholder={engine === 'postgres' ? '5432' : '3306'}
                          style={{ width: '100%' }}
                        />
                      </Form.Item>
                      {field('user', 'Username')}
                      {field('password', 'Password', true)}
                    </div>
                    {field(
                      'database',
                      'Default database',
                      false,
                      engine === 'postgres' ? 'postgres' : 'Optional',
                    )}
                  </>
                ),
              },
              {
                key: 'tls',
                label: 'TLS / SSL',
                children: (
                  <>
                    <Form.Item
                      name={['ssl', 'enabled']}
                      label="Enable verified TLS"
                      valuePropName="checked"
                    >
                      <Switch />
                    </Form.Item>
                    <p className="muted">
                      Server certificates are verified. Paste PEM certificates for a private CA or
                      mutual TLS.
                    </p>
                    <Form.Item name={['ssl', 'ca']} label="CA certificate (PEM)">
                      <Input.TextArea rows={3} />
                    </Form.Item>
                    <Form.Item name={['ssl', 'cert']} label="Client certificate (PEM)">
                      <Input.TextArea rows={3} />
                    </Form.Item>
                    <Form.Item name={['ssl', 'key']} label="Client private key (PEM)">
                      <Input.TextArea rows={3} />
                    </Form.Item>
                  </>
                ),
              },
              {
                key: 'ssh',
                label: 'SSH tunnel',
                children: (
                  <>
                    <Form.Item
                      name={['ssh', 'enabled']}
                      label="Connect through SSH"
                      valuePropName="checked"
                    >
                      <Switch />
                    </Form.Item>
                    <div className="form-grid">
                      {field(['ssh', 'host'], 'SSH host')}
                      <Form.Item
                        name={['ssh', 'port']}
                        label="SSH port"
                        normalize={(v) => v ?? undefined}
                      >
                        <InputNumber placeholder="22" min={1} max={65535} />
                      </Form.Item>
                      {field(['ssh', 'user'], 'SSH username')}
                      {field(['ssh', 'password'], 'SSH password', true)}
                    </div>
                    {field(['ssh', 'fingerprint'], 'Trusted host fingerprint', false, 'SHA256:…')}
                    <p className="muted">
                      Obtain this fingerprint from your server administrator. The database host is
                      resolved from the SSH server.
                    </p>
                    <Form.Item name={['ssh', 'privateKey']} label="Private key (PEM or OpenSSH)">
                      <Input.TextArea rows={3} />
                    </Form.Item>
                    {field(['ssh', 'passphrase'], 'Key passphrase', true)}
                  </>
                ),
              },
            ]}
          />
        )}
        {sql && (
          <>
            <Form.Item
              name="sqlContent"
              label="SQL contents"
              rules={[{ required: true, message: 'Select the SQL contents.' }]}
            >
              <Select
                placeholder="Select what this SQL contains"
                options={[
                  { value: 'schema', label: 'Schema only' },
                  { value: 'data', label: 'Schema and data (including empty tables)' },
                ]}
              />
            </Form.Item>
            {engine !== 'sqlite' && (
              <Form.Item name="sqlVersion" label="Temporary server version">
                <Select
                  placeholder={
                    engine === 'postgres' ? 'PostgreSQL 18 (default)' : 'MySQL 8.4 (default)'
                  }
                  options={(engine === 'postgres' ? ['15', '16', '17', '18'] : ['8.0', '8.4']).map(
                    (version) => ({ value: version, label: version }),
                  )}
                />
              </Form.Item>
            )}
            <Alert
              type="info"
              showIcon
              title={
                engine === 'sqlite'
                  ? 'Imported into a temporary SQLite database. Select the dialect that matches your SQL.'
                  : 'Requires Docker running locally. A disposable database is created for each import; its image is downloaded on first use.'
              }
              description="Use a standalone plain SQL dump. Migration and data-only scripts requiring a base schema are unsupported. Original files and selected databases stay read-only."
            />
          </>
        )}
        <div className="secure-note">
          Saved inputs, pasted SQL, and credentials are encrypted locally using your operating
          system’s credential store.
        </div>
      </Form>
    </Modal>
  );
}
