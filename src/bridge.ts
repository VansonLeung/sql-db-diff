import { Electroview } from 'electrobun/view';
import type { DesktopRPC } from './rpc';
import type { API, Progress } from './shared';

const listeners = new Set<(progress: Progress) => void>();
const rpc = Electroview.defineRPC<DesktopRPC>({
  maxRequestTime: 130_000,
  handlers: {
    requests: {},
    messages: {
      progress: (value) => {
        for (const listener of listeners) listener(value);
      },
    },
  },
});
const api: API = {
  bookmarks: {
    list: () => rpc.request['bookmarks:list']([]),
    save: (value) => rpc.request['bookmarks:save']([value]),
    remove: (id) => rpc.request['bookmarks:remove']([id]),
  },
  chooseFile: () => rpc.request['file:choose']([]),
  test: (bookmark) => rpc.request['connection:test']([bookmark]),
  databases: (id) => rpc.request['databases:list']([id]),
  inspect: (endpoint) => rpc.request['schema:inspect']([endpoint]),
  compare: (request) => rpc.request['compare:start']([request]),
  cancel: () => rpc.request['compare:cancel']([]),
  rows: (table, page, status) =>
    rpc.request['compare:rows'](status === undefined ? [table, page] : [table, page, status]),
  demo: () => rpc.request['demo:create']([]),
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
