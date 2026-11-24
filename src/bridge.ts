import { Electroview } from 'electrobun/view';
import type { DesktopRPC } from './rpc';
import type { API, Progress } from './shared';
import { backendVersionCheck, databaseList } from './backend';

const listeners = new Set<(progress: Progress) => void>();
const rpc = Electroview.defineRPC<DesktopRPC>({
  maxRequestTime: 660_000,
  handlers: {
    requests: {},
    messages: {
      progress: (value) => {
        for (const listener of listeners) listener(value);
      },
    },
  },
});
const checkBackend = backendVersionCheck(() =>
  rpc.request['app:version']([], { maxRequestTime: 10_000 }),
);
const ready = async <T>(request: () => Promise<T>): Promise<T> => {
  await checkBackend();
  return request();
};
const api: API = {
  bookmarks: {
    list: () => ready(() => rpc.request['bookmarks:list']([])),
    save: (value) => ready(() => rpc.request['bookmarks:save']([value])),
    remove: (id) => ready(() => rpc.request['bookmarks:remove']([id])),
  },
  chooseFile: () => ready(() => rpc.request['file:choose']([])),
  test: (bookmark) =>
    ready(async () => databaseList(await rpc.request['connection:test']([bookmark]))),
  databases: (id) => ready(async () => databaseList(await rpc.request['databases:list']([id]))),
  inspect: (endpoint) => ready(() => rpc.request['schema:inspect']([endpoint])),
  compare: (request) => ready(() => rpc.request['compare:start']([request])),
  cancel: () => ready(() => rpc.request['compare:cancel']([])),
  rows: (table, page, status) =>
    ready(() =>
      rpc.request['compare:rows'](status === undefined ? [table, page] : [table, page, status]),
    ),
  demo: () => ready(() => rpc.request['demo:create']([])),
  onProgress: (callback) => {
    listeners.add(callback);
    return () => {
      listeners.delete(callback);
    };
  },
};
if (window.__electrobun) {
  new Electroview({ rpc });
  window.dbDiff = api;
}
export const reportSmoke = (result: { ok: boolean; message: string }) =>
  rpc.request['smoke:report'](result);
export const smokeSQLFixture = () => rpc.request['smoke:sql-fixture']([]);
