import { contextBridge, ipcRenderer } from 'electron';
import type { API } from '../src/shared';
const api: API = {
  bookmarks: {
    list: () => ipcRenderer.invoke('bookmarks:list'),
    save: (v) => ipcRenderer.invoke('bookmarks:save', v),
    remove: (id) => ipcRenderer.invoke('bookmarks:remove', id),
  },
  chooseFile: () => ipcRenderer.invoke('file:choose'),
  test: (b) => ipcRenderer.invoke('connection:test', b),
  databases: (id) => ipcRenderer.invoke('databases:list', id),
  inspect: (e) => ipcRenderer.invoke('schema:inspect', e),
  compare: (r) => ipcRenderer.invoke('compare:start', r),
  cancel: () => ipcRenderer.invoke('compare:cancel'),
  rows: (t, p, s) => ipcRenderer.invoke('compare:rows', t, p, s),
  demo: () => ipcRenderer.invoke('demo:create'),
  onProgress: (callback) => {
    const handler = (_event: unknown, p: Parameters<typeof callback>[0]) => callback(p);
    ipcRenderer.on('compare:progress', handler);
    return () => ipcRenderer.removeListener('compare:progress', handler);
  },
};
contextBridge.exposeInMainWorld('dbDiff', api);
