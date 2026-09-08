import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, resolve } from 'node:path';

const require = createRequire(import.meta.url);

const executableOnPath = (name, { environment, platform }) => (environment.PATH ?? '')
  .split(delimiter)
  .map(directory => resolve(directory, platform === 'win32' ? `${name}.exe` : name))
  .find(existsSync);

const resolveElectronExecutable = () => require('electron');

export const prepareNativeElectronTest = ({
  environment = process.env,
  findExecutable = executableOnPath,
  headlessReason = 'Electron needs DISPLAY or xvfb-run on Linux',
  linuxOnly = false,
  platform = process.platform,
  resolveElectron = resolveElectronExecutable,
  unsupportedPlatformReason = 'This native Electron probe is Linux-specific',
} = {}) => {
  if (linuxOnly && platform !== 'linux') {
    return { skipReason: unsupportedPlatformReason };
  }

  const xvfbRun = platform === 'linux' && !environment.DISPLAY
    ? findExecutable('xvfb-run', { environment, platform })
    : undefined;
  if (platform === 'linux' && !environment.DISPLAY && !xvfbRun) {
    return { skipReason: headlessReason };
  }

  return {
    electronExecutable: resolveElectron(),
    xvfbRun,
  };
};
