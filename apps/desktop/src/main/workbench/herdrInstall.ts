// Download herdr into the workbench data dir (managed plugin-style install).
//
// Uses the official GitHub release asset names from https://herdr.dev/docs/install/
// Only macOS and Linux direct binaries — Windows Workbench is unsupported today.

import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { writeFileAtomicSync } from '../storeFile';
import { managedHerdrBinary } from './herdrProbe';

const RELEASE_HOST = 'github.com';
const RELEASE_PATH = '/herdrdev/herdr/releases/latest/download/';

function assetName(platform: NodeJS.Platform, arch: string): string | null {
  if (platform === 'darwin') {
    return arch === 'arm64' ? 'herdr-macos-aarch64' : 'herdr-macos-x86_64';
  }
  if (platform === 'linux') {
    return arch === 'arm64' ? 'herdr-linux-aarch64' : 'herdr-linux-x86_64';
  }
  return null;
}

function download(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const follow = (href: string, redirects: number): void => {
      if (redirects > 5) {
        reject(new Error('too many redirects'));
        return;
      }
      https
        .get(href, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            follow(res.headers.location, redirects + 1);
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`download failed: ${res.statusCode ?? 'unknown'}`));
            return;
          }
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            try {
              writeFileAtomicSync(dest, Buffer.concat(chunks));
              fs.chmodSync(dest, 0o755);
              resolve();
            } catch (err) {
              reject(err);
            }
          });
          res.on('error', reject);
        })
        .on('error', reject);
    };
    follow(url, 0);
  });
}

export async function installManagedHerdr(workbenchDataDir: string, platform: NodeJS.Platform, arch: string): Promise<string> {
  const name = assetName(platform, arch);
  if (!name) throw new Error('unsupported_platform');
  const dir = path.join(workbenchDataDir, 'herdr-bin');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dest = managedHerdrBinary(workbenchDataDir);
  const url = `https://${RELEASE_HOST}${RELEASE_PATH}${name}`;
  await download(url, dest);
  if (!fs.statSync(dest).isFile()) throw new Error('install_incomplete');
  return dest;
}
