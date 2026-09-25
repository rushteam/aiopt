import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import type { ForgeConfig } from '@electron-forge/shared-types';

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
  hooks: {
    // Unsigned macOS builds: FusesPlugin re-signs only the Electron binary, ad hoc, before
    // packager rewrites Info.plist and renames the bundle, so the finished app's seal no longer
    // matches and `codesign --verify` rejects it. Re-seal the whole bundle ad hoc once it is
    // final. A configured `osxSign` signs properly after this point, so leave it alone then.
    postPackage: async (forgeConfig, { platform, outputPaths }) => {
      if (platform !== 'darwin' || forgeConfig.packagerConfig.osxSign) return;
      for (const outputPath of outputPaths) {
        const appPath = path.join(outputPath, `${forgeConfig.packagerConfig.name}.app`);
        execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath]);
        execFileSync('codesign', ['--verify', '--deep', '--strict', appPath]);
      }
    },
  },
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
    // docs/dev-rules/electron-security-and-process-boundaries.md §7. Always loaded: the plugin
    // only hooks `packageAfterCopy`, so `start` never reaches it, and a command-line test for
    // package/make does not work (Forge runs each command as its own electron-forge-<cmd>.js).
    // `pnpm --filter desktop run check:fuses` reads the result back from the packaged binary.
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
