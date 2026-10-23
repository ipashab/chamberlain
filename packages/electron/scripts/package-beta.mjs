// Chamberlain packaging flavor: the same code under the fork's own name,
// appId and icon, so the app with our changes sits next to the official
// OpenChamber in /Applications and is obvious in the Dock.
//
// The flavor icons come from the fork's own stock assets
// (resources/icons/icon.icns, icon.png) — whatever design they carry —
// copied into the chamberlain asset paths and swapped into the fixed paths
// electron-builder reads for the duration of the build.
// after-pack-beta.cjs then strips the CFBundleIconName pointer so macOS
// reads the swapped icon.icns instead of the official asset catalog.
//
// Usage: node ./scripts/package-beta.mjs [extra electron-builder args...]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const iconsDir = path.join(packageRoot, 'resources', 'icons');
const flavorDir = path.join(iconsDir, 'chamberlain');

// The fork's app answers to its own name; the upstream stays untouched.
const FLAVOR_PRODUCT_NAME = 'Chamberlain';
const FLAVOR_APP_ID = 'dev.openchamber.chamberlain';

// The stock assets after-pack.cjs and electron-builder read by fixed path;
// the flavor copies of the same files, kept under the chamberlain directory.
const SWAPPED_ASSETS = [
  ['icon.icns', 'chamberlain/icon-chamberlain.icns'],
  ['icon.png', 'chamberlain/icon-chamberlain.png'],
];

const copyFlavorAssets = () => {
  fs.mkdirSync(flavorDir, { recursive: true });
  for (const [stock, flavorRelative] of SWAPPED_ASSETS) {
    fs.copyFileSync(path.join(iconsDir, stock), path.join(iconsDir, flavorRelative));
  }
};

const swapInFlavorAssets = () => {
  const backups = [];
  for (const [stock, flavorRelative] of SWAPPED_ASSETS) {
    const stockPath = path.join(iconsDir, stock);
    const backupPath = `${stockPath}.official-backup`;
    fs.copyFileSync(stockPath, backupPath);
    backups.push({ stockPath, backupPath });
    fs.copyFileSync(path.join(iconsDir, flavorRelative), stockPath);
  }
  return () => {
    for (const { stockPath, backupPath } of backups) {
      fs.copyFileSync(backupPath, stockPath);
      fs.rmSync(backupPath, { force: true });
    }
  };
};

const main = async () => {
  if (process.platform !== 'darwin') {
    console.error('[package:beta] the Chamberlain flavor only makes sense on macOS');
    process.exit(1);
  }
  console.log('[package:beta] copying the fork icon assets into the Chamberlain flavor');
  copyFlavorAssets();

  const restore = swapInFlavorAssets();
  const builderArgs = [
    `--config.appId=${FLAVOR_APP_ID}`,
    `--config.productName=${FLAVOR_PRODUCT_NAME}`,
    '--config.artifactName=Chamberlain-${version}-${arch}.${ext}',
    '--config.mac.artifactName=Chamberlain-${version}-mac-${arch}.${ext}',
    '--config.afterPack=scripts/after-pack-beta.cjs',
    ...process.argv.slice(2),
  ];
  try {
    console.log(`[package:beta] packaging as "${FLAVOR_PRODUCT_NAME}" (appId ${FLAVOR_APP_ID})`);
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(packageRoot, 'scripts', 'package.mjs'), ...builderArgs], {
        stdio: 'inherit',
        cwd: packageRoot,
      });
      child.on('exit', (code, signal) => {
        if (signal) process.kill(process.pid, signal);
        else if (code === 0) resolve();
        else reject(new Error(`electron-builder exited with ${code}`));
      });
      child.on('error', reject);
    });
  } finally {
    restore();
    console.log('[package:beta] stock icon assets restored');
  }
};

await main();
