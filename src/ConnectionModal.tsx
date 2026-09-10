import { useState } from 'react';
import { App, Button, Form, Input, InputNumber, Modal, Select, Switch, Tabs, Alert } from 'antd';
import { FolderOpenOutlined, ThunderboltOutlined } from '@ant-design/icons';
import type { Bookmark } from './shared';
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
  const field = (name: string | string[], label: string, secret = false, placeholder?: string) => (
    <Form.Item name={name} label={label}>
      {secret ? <Input.Password placeholder={placeholder} /> : <Input placeholder={placeholder} />}
    </Form.Item>
  );
  async function test() {
    setTesting(true);
    try {
      await form.validateFields();
      const b = form.getFieldsValue(true) as Bookmark;
      const dbs = await window.dbDiff.test(b);
      message.success(`Connected · ${dbs.length} database${dbs.length === 1 ? '' : 's'} available`);
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Check the connection details.');
    } finally {
      setTesting(false);
    }
  }
  async function save() {
    try {
      await form.validateFields();
      const b = form.getFieldsValue(true) as Bookmark;
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
      title={value.id ? 'Edit connection' : 'New connection'}
      onCancel={onClose}
      width={620}
      footer={
        <div className="modal-footer">
          <Button icon={<ThunderboltOutlined />} loading={testing} disabled={busy} onClick={test}>
            Test connection
          </Button>
          <div>
            <Button onClick={onClose}>Cancel</Button>{' '}
            <Button type="primary" loading={busy} disabled={testing} onClick={save}>
              Save connection
            </Button>
          </div>
        </div>
      }
    >
      <Form form={form} layout="vertical" initialValues={value} requiredMark={false}>
        <Form.Item name="id" hidden>
          <Input />
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
              options={[
                { value: 'postgres', label: 'PostgreSQL' },
                { value: 'mysql', label: 'MySQL' },
                { value: 'sqlite', label: 'SQLite' },
              ]}
            />
          </Form.Item>
        </div>
        {engine === 'sqlite' ? (
          <Form.Item label="Database file" required>
            <div className="file-field">
              <Form.Item
                name="file"
                noStyle
                rules={[{ required: true, message: 'Choose a database file.' }]}
              >
                <Input placeholder="/path/to/database.sqlite" />
              </Form.Item>
              <Button
                aria-label="Choose database file"
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
        <div className="secure-note">
          Credentials are encrypted locally using macOS Keychain protection.
        </div>
      </Form>
    </Modal>
  );
}
