import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const DESKTOP_ICON_FILE = 'propr-desktop.png';
export const MACOS_ICON_FILE = 'propr-desktop.icns';
export const DESKTOP_ICON_SIZE = 512;
export const CANONICAL_ICON_SHA256 = 'e66a28f489d5367e08b1b49b1b98b10dd0a29a4e424e38c0684be9513baa7726';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ICNS_SIZES = Object.freeze(new Map([
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
]));

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export const readPngSize = bytes => {
  if (!Buffer.isBuffer(bytes) || bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)
    || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('Desktop icon is not a valid PNG image');
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width <= 0 || height <= 0) throw new Error('Desktop icon PNG dimensions are invalid');
  return { width, height };
};

export const verifyDesktopPngBytes = (bytes, label = 'desktop icon') => {
  const dimensions = readPngSize(bytes);
  if (dimensions.width !== DESKTOP_ICON_SIZE || dimensions.height !== DESKTOP_ICON_SIZE) {
    throw new Error(`${label} must be exactly ${DESKTOP_ICON_SIZE}x${DESKTOP_ICON_SIZE}`);
  }
  if (sha256(bytes) !== CANONICAL_ICON_SHA256) {
    throw new Error(`${label} does not match the canonical ProPR artwork`);
  }
  return dimensions;
};

export const inspectIcnsBytes = bytes => {
  if (!Buffer.isBuffer(bytes) || bytes.length < 8 || bytes.toString('ascii', 0, 4) !== 'icns'
    || bytes.readUInt32BE(4) !== bytes.length) {
    throw new Error('macOS desktop icon is not a valid ICNS container');
  }
  const entries = new Map();
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 8 > bytes.length) throw new Error('macOS desktop icon has a truncated ICNS entry');
    const type = bytes.toString('ascii', offset, offset + 4);
    const length = bytes.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > bytes.length || entries.has(type)) {
      throw new Error('macOS desktop icon has an invalid or duplicate ICNS entry');
    }
    entries.set(type, bytes.subarray(offset + 8, offset + length));
    offset += length;
  }
  if (entries.size !== ICNS_SIZES.size) throw new Error('macOS desktop icon has an incomplete native size set');
  for (const [type, size] of ICNS_SIZES) {
    const payload = entries.get(type);
    if (!payload) throw new Error(`macOS desktop icon is missing ${type}`);
    const dimensions = readPngSize(payload);
    if (dimensions.width !== size || dimensions.height !== size) {
      throw new Error(`macOS desktop icon ${type} must be exactly ${size}x${size}`);
    }
  }
  return Object.freeze(Object.fromEntries(ICNS_SIZES));
};

export const verifyPackagedLinuxIcon = async applicationRoot => {
  const path = join(applicationRoot, 'resources', DESKTOP_ICON_FILE);
  verifyDesktopPngBytes(await readFile(path), 'packaged Linux runtime icon');
  return path;
};

export const verifyLinuxLauncherIcon = async ({ desktopFile, iconFile }) => {
  const desktop = await readFile(desktopFile, 'utf8');
  if (!/^Name=ProPR Desktop$/m.test(desktop)
    || !/^Exec=propr-desktop(?:\s+%U)?$/m.test(desktop)
    || !/^Icon=propr-desktop$/m.test(desktop)
    || !/^MimeType=.*x-scheme-handler\/propr;.*$/m.test(desktop)) {
    throw new Error('Linux package launcher branding or protocol declaration is invalid');
  }
  verifyDesktopPngBytes(await readFile(iconFile), 'Linux package launcher icon');
};

export const verifyMacApplicationIcon = async ({ applicationRoot, readPlist }) => {
  const iconFile = await readPlist('CFBundleIconFile');
  if (iconFile !== MACOS_ICON_FILE) throw new Error('macOS application icon metadata is not branded');
  const path = join(applicationRoot, 'Contents', 'Resources', iconFile);
  inspectIcnsBytes(await readFile(path));
  return path;
};
