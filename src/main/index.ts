import { app, BrowserWindow, protocol, net, session } from 'electron';
import { fileURLToPath } from 'node:url';
import { join, dirname, normalize } from 'node:path';
import { initDatabase } from './db/index.js';
import { registerIpcHandlers } from './ipc/handlers.js';
import type { Db } from './db/Db.js';

/**
 * Electron main process.
 *
 * Everything privileged lives here: the database, IMAP, OAuth, credential
 * storage. The renderer is React and nothing else — it holds no Node access, no
 * credentials, and no database handle, and reaches this side only through the
 * enumerated methods in ../preload.
 */

const isDev = !app.isPackaged;
const rendererDir = join(dirname(fileURLToPath(import.meta.url)), '../renderer');

let db: Db | null = null;
let mainWindow: BrowserWindow | null = null;

/**
 * The renderer is served from a custom scheme rather than file://.
 *
 * file:// has an opaque origin, which makes Content-Security-Policy and
 * connect-src semantics mushy and disables ordinary origin isolation. A
 * registered scheme behaves like a normal secure origin.
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
  },
]);

function registerAppProtocol(): void {
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    const requested = url.pathname === '/' ? '/index.html' : url.pathname;

    // Contain every request to the renderer directory. Without normalising and
    // re-checking, "../../" in a path would walk out and serve arbitrary files.
    const resolved = normalize(join(rendererDir, requested));
    if (!resolved.startsWith(rendererDir)) {
      return new Response('Not found', { status: 404 });
    }

    return net.fetch(`file://${resolved}`);
  });
}

function applySecurityPolicy(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          [
            "default-src 'none'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data:",
            "font-src 'self'",
            // The load-bearing line. The renderer has no legitimate reason to
            // open a socket — all mail, OAuth and LLM traffic starts in main.
            // With this, a renderer-side XSS cannot exfiltrate a transaction
            // history; it can only call the enumerated IPC methods.
            "connect-src 'none'",
            "frame-src 'none'",
            "object-src 'none'",
            "base-uri 'none'",
            "form-action 'none'",
          ].join('; '),
        ],
      },
    });
  });

  // Nothing in this app should ever open a second window or navigate away.
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));

    contents.on('will-navigate', (event, url) => {
      if (!url.startsWith('app://') && !(isDev && url.startsWith('http://localhost'))) {
        event.preventDefault();
      }
    });

    // Permissions are all irrelevant here; refusing them wholesale means a
    // future dependency cannot quietly ask for the microphone.
    contents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#f9f9f7',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(dirname(fileURLToPath(import.meta.url)), '../preload/index.cjs'),
      // These are current Electron defaults. Set explicitly so that a later
      // refactor cannot silently regress them without the diff being obvious.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  if (isDev && process.env['VITE_DEV_SERVER_URL']) {
    void mainWindow.loadURL(process.env['VITE_DEV_SERVER_URL']);
  } else {
    void mainWindow.loadURL('app://local/index.html');
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

void app.whenReady().then(() => {
  registerAppProtocol();
  applySecurityPolicy();

  // Opened after ready because credential storage depends on it: on Linux
  // safeStorage reports unavailable before the app is ready, and on macOS it
  // may bind to the wrong keychain item if app.name is not settled yet.
  db = initDatabase();
  registerIpcHandlers(db);

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  db?.close();
  db = null;
});
