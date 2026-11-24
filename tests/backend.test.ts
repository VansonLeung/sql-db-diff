import test from 'node:test';
import assert from 'node:assert/strict';
import { backendVersionCheck, databaseList } from '../src/backend';
import { DESKTOP_PROTOCOL_VERSION } from '../src/shared';

test('backend version is checked once, including concurrent requests', async () => {
  let checks = 0;
  const ready = backendVersionCheck(async () => {
    checks++;
    return DESKTOP_PROTOCOL_VERSION;
  });
  await Promise.all([ready(), ready()]);
  await ready();
  assert.equal(checks, 1);
});

test('old, unavailable and mismatched desktop backends produce a restart message', async () => {
  for (const version of [undefined, null, DESKTOP_PROTOCOL_VERSION + 1, '1'])
    await assert.rejects(
      backendVersionCheck(async () => version)(),
      /versions do not match.*Quit SQL DB Diff/,
    );
  await assert.rejects(
    backendVersionCheck(async () => {
      throw new Error('Unknown desktop request.');
    })(),
    /older or unavailable.*Quit SQL DB Diff/,
  );
});

test('missing or malformed database lists are errors rather than undefined length failures', () => {
  for (const result of [undefined, null, {}, 'sqldiff', [undefined], [1]])
    assert.throws(() => databaseList(result), /invalid database list.*Quit SQL DB Diff/);
  assert.deepEqual(databaseList([]), []);
  assert.deepEqual(databaseList(['sqldiff']), ['sqldiff']);
});
