import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

/**
 * Packaging configuration.
 *
 * On distribution, read the "Why does my OS warn about this?" section of the
 * README before changing anything here. In short: builds are unsigned, so macOS
 * and Windows will both warn, and the documented primary route is building from
 * a clone — which is only viable because no dependency needs a C++ compiler.
 * That is the reason for choosing node:sqlite over better-sqlite3.
 */
const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: 'Expense Tracker',
    executableName: 'expense-tracker',
    appBundleId: 'com.msmurad21.expense-tracker',
    // Ad-hoc signing so Apple Silicon shows the honest "unidentified developer"
    // dialog rather than "is damaged and can't be opened", which reads as if the
    // download is corrupt and is the worst possible first impression.
    osxSign: process.platform === 'darwin' ? {} : undefined,
    ignore: [
      /^\/(tests|docs|scripts)($|\/)/,
      /^\/(demo|report)\.(db|html)$/,
      /^\/\.env/,
      /\.map$/,
    ],
  },

  makers: [new MakerZIP({}, ['darwin']), new MakerSquirrel({})],

  plugins: [
    new VitePlugin({
      build: [
        { entry: 'src/main/index.ts', config: 'vite.main.config.ts', target: 'main' },
        { entry: 'src/preload/index.ts', config: 'vite.preload.config.ts', target: 'preload' },
      ],
      renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }],
    }),

    // Close off the Node escape hatches inside the packaged app. Without these,
    // ELECTRON_RUN_AS_NODE or NODE_OPTIONS turns the shipped binary into a
    // general-purpose Node runtime with the app's own permissions.
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      // Meaningful only once builds are code-signed; harmless until then.
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
