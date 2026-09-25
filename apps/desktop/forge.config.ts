import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import type { ForgeConfig } from '@electron-forge/shared-types';

// FusesPlugin conflicts with VitePlugin on the `start` command, so it is only
// loaded for package/make. `ELECTRON_FORGE_START` is not a real env var — we key
// off the forge command via process.argv instead.
const isPackaging = process.argv.some((a) => a === 'package' || a === 'make');

const config: ForgeConfig = {
  packagerConfig: {
    name: 'AiOpt',
    executableName: 'AiOpt',
    appBundleId: 'dev.aiopt.app',
    // Extensionless: electron-packager appends `.icns` (macOS) / `.ico` (Windows).
    // Regenerate both from the master SVGs with `bash assets/generate-icons.sh`.
    icon: 'assets/icon',
    asar: true,
  },
  rebuildConfig: {},
  makers: [
    // NuGet refuses a package with no `<authors>` ("Authors is required."), and Squirrel only
    // falls back to package.json's `author`, which this private workspace package has none of.
    new MakerSquirrel({ authors: 'RushTeam' }),
    // macOS ships a disk image: open it, drag AiOpt.app onto the Applications link. Leaving
    // `name` unset keeps Forge's `AiOpt-<version>-<arch>.dmg`, which the Homebrew cask's url and
    // the release notes rely on. ULFO (lzfse) is smaller than the UDZO default; needs macOS 10.11+.
    new MakerDMG({ format: 'ULFO', icon: 'assets/icon.icns' }),
    new MakerZIP({}, ['linux']),
  ],
  plugins: [
    new VitePlugin({
      // The renderer entry name `main_window` produces the injected globals
      // MAIN_WINDOW_VITE_DEV_SERVER_URL (dev) and MAIN_WINDOW_VITE_NAME (prod).
      build: [
        {
          entry: 'src/main/index.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    // Hardening fuses for the packaged app — see
    // docs/dev-rules/electron-security-and-process-boundaries.md §7.
    ...(isPackaging
      ? [
          new FusesPlugin({
            version: FuseVersion.V1,
            [FuseV1Options.RunAsNode]: false,
            [FuseV1Options.EnableCookieEncryption]: true,
            [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
            [FuseV1Options.EnableNodeCliInspectArguments]: false,
            [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
            [FuseV1Options.OnlyLoadAppFromAsar]: true,
          }),
        ]
      : []),
  ],
};

export default config;
