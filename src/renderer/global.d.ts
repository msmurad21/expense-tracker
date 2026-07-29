import type { ExpenseTrackerApi } from '../preload/index.js';

declare global {
  interface Window {
    /**
     * The closed set of methods exposed by the preload bridge. The renderer has
     * no other route to the main process, no Node access, and no credentials.
     */
    api: ExpenseTrackerApi;
  }
}

export {};
