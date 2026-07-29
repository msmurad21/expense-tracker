import { contextBridge, ipcRenderer } from 'electron';

/**
 * The only bridge between the main process and the UI.
 *
 * Deliberately a CLOSED set of named methods rather than a generic
 * `invoke(channel, args)` passthrough. The passthrough version is the common
 * shortcut and it is a mistake: it hands an attacker the entire IPC surface the
 * moment anything in the renderer is compromised, because every channel becomes
 * reachable by name.
 *
 * Note what is absent. There is a `setImapCredentials`, and no getter for one.
 * No method here returns a password, an app password or a token — the UI can
 * only learn whether a credential exists and see a masked hint.
 */

const api = {
  analytics: {
    report: () => ipcRenderer.invoke('analytics:report'),
  },

  templates: {
    list: () => ipcRenderer.invoke('templates:list'),
    seedBuiltins: () => ipcRenderer.invoke('templates:seedBuiltins'),
    preview: (id: number) => ipcRenderer.invoke('templates:preview', { id }),
    approve: (id: number) => ipcRenderer.invoke('templates:setStatus', { id, status: 'approved' }),
    reject: (id: number) => ipcRenderer.invoke('templates:setStatus', { id, status: 'rejected' }),
  },

  parse: {
    run: () => ipcRenderer.invoke('parse:run', {}),
    reprocessAll: () => ipcRenderer.invoke('parse:run', { all: true }),
    unmatchedSenders: () => ipcRenderer.invoke('parse:unmatchedSenders'),
  },

  status: {
    overview: () => ipcRenderer.invoke('status:overview'),
  },

  credentials: {
    /** Write-only by design. There is no corresponding read. */
    setImap: (user: string, appPassword: string) =>
      ipcRenderer.invoke('credentials:setImap', { user, appPassword }),
    clear: () => ipcRenderer.invoke('credentials:clear'),
  },
} as const;

contextBridge.exposeInMainWorld('api', api);

export type ExpenseTrackerApi = typeof api;
