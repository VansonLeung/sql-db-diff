import type { API, Progress } from './shared';

type Request<F extends (...args: any[]) => any> = {
  params: Parameters<F>;
  response: Awaited<ReturnType<F>>;
};
export type DesktopRPC = {
  bun: {
    requests: {
      'app:version': { params: []; response: number };
      'bookmarks:list': Request<API['bookmarks']['list']>;
      'bookmarks:save': Request<API['bookmarks']['save']>;
      'bookmarks:remove': Request<API['bookmarks']['remove']>;
      'file:choose': Request<API['chooseFile']>;
      'connection:test': Request<API['test']>;
      'databases:list': Request<API['databases']>;
      'schema:inspect': Request<API['inspect']>;
      'compare:start': Request<API['compare']>;
      'compare:cancel': Request<API['cancel']>;
      'compare:rows': Request<API['rows']>;
      'demo:create': Request<API['demo']>;
      'smoke:report': { params: { ok: boolean; message: string }; response: void };
      'smoke:sql-fixture': { params: []; response: string | undefined };
    };
    messages: {};
  };
  webview: { requests: {}; messages: { progress: Progress } };
};
