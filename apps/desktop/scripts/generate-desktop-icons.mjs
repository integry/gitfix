import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  CANONICAL_ICON_SHA256,
  DESKTOP_ICON_FILE,
  inspectIcnsBytes,
  MACOS_ICON_FILE,
  sha256,
  verifyDesktopPngBytes,
} from './desktop-icon-assets.mjs';

const sourcePath = fileURLToPath(new URL('../../../propr-ui/public/icons/pwa-512x512.png', import.meta.url));
const outputDirectory = fileURLToPath(new URL('../assets/icons/', import.meta.url));
const pngOutputPath = resolve(outputDirectory, DESKTOP_ICON_FILE);
const icnsOutputPath = resolve(outputDirectory, MACOS_ICON_FILE);
const iconEntries = Object.freeze([
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
]);

const icnsEntry = (type, png) => {
  const header = Buffer.alloc(8);
  header.write(type, 0, 4, 'ascii');
  header.writeUInt32BE(header.length + png.length, 4);
  return Buffer.concat([header, png]);
};

export const buildDesktopIcons = async () => {
  const source = await readFile(sourcePath);
  verifyDesktopPngBytes(source, 'canonical ProPR PWA icon');
  if (sha256(source) !== CANONICAL_ICON_SHA256) throw new Error('Canonical ProPR icon checksum changed');

  const entries = await Promise.all(iconEntries.map(async ([type, size]) => {
    const png = size === 512
      ? source
      : await sharp(source)
        .resize(size, size, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
        .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
        .toBuffer();
    return icnsEntry(type, png);
  }));
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(header.length + entries.reduce((total, entry) => total + entry.length, 0), 4);
  const icns = Buffer.concat([header, ...entries]);
  inspectIcnsBytes(icns);
  return { png: source, icns };
};

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const generated = await buildDesktopIcons();
  if (process.argv[2] === '--check') {
    const [png, icns] = await Promise.all([readFile(pngOutputPath), readFile(icnsOutputPath)]);
    if (!png.equals(generated.png) || !icns.equals(generated.icns)) {
      throw new Error('Desktop native icons are stale; run npm run icons:generate -w @propr/desktop');
    }
    console.log('Desktop native icons match the canonical ProPR artwork.');
  } else if (process.argv.length === 2) {
    await mkdir(outputDirectory, { recursive: true });
    await Promise.all([
      writeFile(pngOutputPath, generated.png),
      writeFile(icnsOutputPath, generated.icns),
    ]);
    console.log(`Generated ${DESKTOP_ICON_FILE} and ${MACOS_ICON_FILE}.`);
  } else {
    throw new Error('Usage: generate-desktop-icons.mjs [--check]');
  }
}
