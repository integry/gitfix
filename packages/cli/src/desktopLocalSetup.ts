import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SetupActions } from '@propr/local-setup';
import { ConfigManager } from './config/index.js';
import { configureStackTemplatePath } from './commands/initStack.js';
import { createDefaultActions } from './commands/setup/hostActions.js';
import { configureOrchestratorAssetPath, getHostConfig } from './orchestrator/index.js';
import { localhostServiceUrl } from './utils/dockerPort.js';
import type { AuthenticationCommandHandoff, CapturedCommandRunner } from './auth/githubLogin.js';

export type { AuthenticationCommandHandoff } from './auth/githubLogin.js';

export interface DesktopSetupHost {
  actions: SetupActions;
  resolveApiBaseUrl(rootDir: string, signal?: AbortSignal): Promise<string>;
}

const verifiedResource = (path: string): string => {
  if (!existsSync(path)) throw new Error('Packaged local-setup resource is unavailable');
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Packaged local-setup resource is invalid');
  return realpathSync(path);
};

/** Build the real CLI setup host without exposing command execution to the renderer. */
export async function createDesktopSetupHost(options: {
  configDir: string;
  resourcesPath?: string;
  authenticationHandoff: AuthenticationCommandHandoff;
  capturedCommand?: CapturedCommandRunner;
}): Promise<DesktopSetupHost> {
  if (options.resourcesPath) {
    const root = realpathSync(options.resourcesPath);
    configureOrchestratorAssetPath(verifiedResource(join(root, 'orchestrator', 'orchestrator.mjs')));
    configureStackTemplatePath(verifiedResource(join(root, 'assets', 'env.example.txt')));
  }
  const config = new ConfigManager(resolve(options.configDir));
  await config.init();
  const actions = createDefaultActions(config, {
    authenticationHandoff: options.authenticationHandoff,
    capturedCommand: options.capturedCommand,
  });
  return {
    actions,
    async resolveApiBaseUrl(rootDir, signal) {
      signal?.throwIfAborted();
      const { cfg } = await getHostConfig({ configManager: config, root: rootDir });
      signal?.throwIfAborted();
      return localhostServiceUrl(cfg.apiPort);
    },
  };
}
