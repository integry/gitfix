import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron';

/** Public build diagnostics only. Never include profile paths or credentials. */
export const applicationAboutDetails = (version: string, platform: string, arch: string, versions: NodeJS.ProcessVersions): string => [
  `ProPR ${version}`,
  `Platform: ${platform} (${arch})`,
  `Electron: ${versions.electron ?? 'unknown'}`,
  `Chromium: ${versions.chrome ?? 'unknown'}`,
  `Node.js: ${versions.node}`,
  `© ${new Date().getFullYear()} Rinalds Uzkalns`,
  'https://propr.dev',
].join('\n');

export const showApplicationAbout = async (host: {
  showMessageBox(options: MessageBoxOptions): Promise<MessageBoxReturnValue>;
  copy(text: string): void;
}, details: string): Promise<void> => {
  const { response } = await host.showMessageBox({
    type: 'info', title: 'About ProPR', message: 'ProPR', detail: details,
    buttons: ['Close', 'Copy Version Details'], defaultId: 0, cancelId: 0,
  });
  if (response === 1) host.copy(details);
};
