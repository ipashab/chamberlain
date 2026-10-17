// Chamberlain packaging flavor: the same code under the fork's own name,
// appId and icon, so the app with our changes sits next to the official
// OpenChamber in /Applications and is obvious in the Dock.
//
// The Chamberlain icon — a brass seal with a key on teal wax — is drawn from
// scratch with Pillow, compiled into an .icns, and swapped into the fixed
// asset paths for the duration of the build. after-pack-beta.cjs then strips
// the CFBundleIconName pointer so macOS reads the swapped icon.icns instead
// of the official asset catalog.
//
// Usage: node ./scripts/package-beta.mjs [extra electron-builder args...]

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const iconsDir = path.join(packageRoot, 'resources', 'icons');
const flavorDir = path.join(iconsDir, 'chamberlain');

// The fork's app answers to its own name; the upstream stays untouched.
const FLAVOR_PRODUCT_NAME = 'Chamberlain';
const FLAVOR_APP_ID = 'dev.openchamber.chamberlain';

// The stock assets after-pack.cjs and electron-builder read by fixed path.
const SWAPPED_ASSETS = [
  ['icon.icns', 'chamberlain/icon-chamberlain.icns'],
  ['icon.png', 'chamberlain/icon-chamberlain.png'],
];

const run = (command, args, options = {}) =>
  execFileSync(command, args, { encoding: 'utf8', ...options }).trim();

const renderChamberlainPng = () => {
  fs.mkdirSync(flavorDir, { recursive: true });
  // A Pillow pass draws the seal; python3 with Pillow is available in
  // the QA environment, and the parameters stay here rather than in a
  // scratch file so the icon can always be regenerated.
  run('python3', [
    '-c',
    `
from PIL import Image, ImageDraw, ImageFilter

SIZE = 1024
C = SIZE // 2

wax_light = (21, 111, 112)
wax_dark = (12, 59, 61)
brass = (201, 165, 92)
brass_dim = (151, 120, 62)
gold = (232, 201, 135)

# Teal wax: a vertical gradient clipped to the squircle the OS expects.
img = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
grad = Image.new('RGBA', (SIZE, SIZE))
gd = ImageDraw.Draw(grad)
for y in range(SIZE):
    t = y / SIZE
    color = tuple(round(a + (b - a) * t) for a, b in zip(wax_light, wax_dark))
    gd.line([(0, y), (SIZE, y)], fill=color + (255,))

mask = Image.new('L', (SIZE, SIZE), 0)
md = ImageDraw.Draw(mask)
md.rounded_rectangle((28, 28, SIZE - 28, SIZE - 28), radius=232, fill=255)
img.paste(grad, (0, 0), mask)

# A soft sheen from the upper left, as if the wax was cast yesterday.
sheen = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
sd = ImageDraw.Draw(sheen)
sd.ellipse((90, -220, 720, 380), fill=(210, 255, 250, 46))
sheen = sheen.filter(ImageFilter.GaussianBlur(120))
img.paste(sheen, (0, 0), Image.composite(sheen, Image.new('RGBA', sheen.size), sheen.split()[3]))

draw = ImageDraw.Draw(img)

# The seal: a solid brass ring with light and dark edges, and a dotted
# tracking ring inside it, the way a wax stamp keeps its plating.
draw.ellipse((C - 404, C - 404, C + 404, C + 404), outline=brass_dim, width=6)
draw.ellipse((C - 400, C - 400, C + 400, C + 400), outline=brass, width=26)
draw.ellipse((C - 364, C - 364, C + 364, C + 364), outline=brass, width=10)

import math
for i in range(72):
    a = math.radians(i * 5)
    if i % 2 == 0:
        x1, y1 = C + 336 * math.cos(a - 0.035), C + 336 * math.sin(a - 0.035)
        x2, y2 = C + 336 * math.cos(a + 0.035), C + 336 * math.sin(a + 0.035)
        draw.line([(x1, y1), (x2, y2)], fill=brass, width=9)

# The key: a thick bow with a through hole, a shaft and teeth cut to one
# side at the lower end — the silhouette must read as a key at Dock size.
# Relief comes from a dark copy of each part set off by a few pixels.
dark = (120, 96, 47)
hx, hy = C, C - 168
bow_r, hole_r = 80, 38
draw.ellipse((hx - bow_r, hy - bow_r, hx + bow_r, hy + bow_r), fill=dark)
draw.ellipse((hx - bow_r + 2, hy - bow_r - 3, hx + bow_r - 2, hy + bow_r - 3), fill=gold)
draw.ellipse((hx - hole_r + 3, hy - hole_r + 3, hx + hole_r + 3, hy + hole_r + 3), fill=dark)
draw.ellipse((hx - hole_r, hy - hole_r, hx + hole_r, hy + hole_r), fill=(26, 92, 93))

shaft_w, shaft_top, shaft_bottom = 22, hy + bow_r - 12, C + 138
draw.rounded_rectangle((C - shaft_w + 4, shaft_top + 4, C + shaft_w + 4, shaft_bottom), radius=shaft_w, fill=dark)
draw.rounded_rectangle((C - shaft_w, shaft_top, C + shaft_w, shaft_bottom - 4), radius=shaft_w, fill=gold)

# Two teeth, long then short, on the right of the shaft's lower end.
for x_end, y_top, y_bottom in ((C + 92, shaft_bottom - 96, shaft_bottom - 48), (C + 62, shaft_bottom - 34, shaft_bottom + 4)):
    draw.rounded_rectangle((C, y_top + 4, x_end + 4, y_bottom + 4), radius=16, fill=dark)
    draw.rounded_rectangle((C - 4, y_top, x_end, y_bottom), radius=16, fill=gold)

img.save(${JSON.stringify(path.join(flavorDir, 'icon-chamberlain.png'))})
`,
  ]);
};

// iconutil wants the classic iconset layout at fixed names and sizes.
const ICONSET_FILES = [
  ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024],
];

const renderChamberlainIcns = () => {
  const iconset = path.join(flavorDir, 'icon-chamberlain.iconset');
  fs.rmSync(iconset, { recursive: true, force: true });
  fs.mkdirSync(iconset, { recursive: true });
  const source = path.join(flavorDir, 'icon-chamberlain.png');
  for (const [name, px] of ICONSET_FILES) {
    run('sips', ['-z', String(px), String(px), source, '--out', path.join(iconset, name)]);
  }
  run('iconutil', ['-c', 'icns', iconset, '-o', path.join(flavorDir, 'icon-chamberlain.icns')]);
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
  console.log('[package:beta] rendering Chamberlain icon assets');
  renderChamberlainPng();
  renderChamberlainIcns();

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
