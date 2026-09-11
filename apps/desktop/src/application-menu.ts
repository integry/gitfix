import type { Menu, MenuItemConstructorOptions } from 'electron';
import type { DesktopNativeCommandDispatcher } from './native-commands';

interface ApplicationMenuHost {
  buildFromTemplate(template: MenuItemConstructorOptions[]): Menu;
  setApplicationMenu(menu: Menu | null): void;
}

export interface ApplicationMenuController {
  close(): void;
}

const commandItem = (
  commands: DesktopNativeCommandDispatcher,
  command: Parameters<DesktopNativeCommandDispatcher['dispatch']>[0],
  label: string,
  accelerator: string | undefined,
  enabled = true,
): MenuItemConstructorOptions => ({
  label,
  ...(accelerator ? { accelerator } : {}),
  enabled,
  click: () => commands.dispatch(command),
});

export const createApplicationMenuTemplate = (
  platform: NodeJS.Platform,
  commands: DesktopNativeCommandDispatcher,
): MenuItemConstructorOptions[] => {
  const state = commands.getState();
  const authenticated = state.authenticated;
  const appActions: MenuItemConstructorOptions[] = [
    commandItem(commands, 'new-plan', 'New Plan', 'CmdOrCtrl+N', authenticated),
    { type: 'separator' },
    commandItem(commands, 'open', 'Open ProPR', 'CmdOrCtrl+O'),
    commandItem(commands, 'manage-instances', 'Switch / Manage Instances…', 'CmdOrCtrl+Shift+I', state.canManageInstances !== false),
    { type: 'separator' },
    commandItem(commands, 'notification-settings', 'Notification Settings…', 'CmdOrCtrl+,', authenticated),
    commandItem(
      commands,
      'toggle-native-notifications',
      state.nativeNotificationsEnabled ? 'Pause Native Notifications' : 'Resume Native Notifications',
      'CmdOrCtrl+Shift+N',
      state.nativeNotificationsAvailable,
    ),
  ];
  const notificationToggle = appActions.at(-1);
  if (notificationToggle) {
    notificationToggle.type = 'checkbox';
    notificationToggle.checked = state.nativeNotificationsEnabled;
  }

  const goMenu: MenuItemConstructorOptions = {
    label: 'Go',
    submenu: [
      commandItem(commands, 'tasks', 'Tasks', 'CmdOrCtrl+1', authenticated),
      commandItem(commands, 'plans', 'Plans', 'CmdOrCtrl+2', authenticated),
      commandItem(commands, 'inbox', 'Inbox', 'CmdOrCtrl+3', authenticated),
    ],
  };
  const editMenu: MenuItemConstructorOptions = {
    label: 'Edit',
    submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
      ...(platform === 'darwin' ? [{ role: 'pasteAndMatchStyle' as const }] : []),
      { role: 'selectAll' },
    ],
  };
  const viewMenu: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' }, { role: 'togglefullscreen' },
    ],
  };

  if (platform === 'darwin') {
    return [
      {
        label: 'ProPR',
        submenu: [
          { role: 'about' }, { type: 'separator' },
          commandItem(commands, 'settings', 'Settings…', 'CmdOrCtrl+,', authenticated),
          { type: 'separator' }, { role: 'services' },
          { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
          { type: 'separator' }, commandItem(commands, 'quit', 'Quit ProPR', 'CmdOrCtrl+Q'),
        ],
      },
      {
        label: 'File',
        submenu: [
          commandItem(commands, 'new-plan', 'New Plan', 'CmdOrCtrl+N', authenticated),
          { type: 'separator' },
          commandItem(commands, 'manage-instances', 'Switch / Manage Instances…', 'CmdOrCtrl+Shift+I', state.canManageInstances !== false),
          { type: 'separator' }, { role: 'close' },
        ],
      },
      editMenu,
      viewMenu,
      {
        label: 'Go',
        submenu: [
          commandItem(commands, 'back', 'Back', 'CmdOrCtrl+[', state.canGoBack === true),
          commandItem(commands, 'forward', 'Forward', 'CmdOrCtrl+]', state.canGoForward === true),
          { type: 'separator' },
          commandItem(commands, 'dashboard', 'Dashboard', 'CmdOrCtrl+1', authenticated),
          commandItem(commands, 'inbox', 'Inbox', 'CmdOrCtrl+2', authenticated),
          commandItem(commands, 'plans', 'Plans', 'CmdOrCtrl+3', authenticated),
          commandItem(commands, 'goals', 'Goals', 'CmdOrCtrl+4', authenticated),
          commandItem(commands, 'tasks', 'Tasks', 'CmdOrCtrl+5', authenticated),
          commandItem(commands, 'repositories', 'Repositories', 'CmdOrCtrl+6', authenticated),
          commandItem(commands, 'llm-logs', 'LLM Log', 'CmdOrCtrl+7', authenticated),
        ],
      },
      {
        label: 'Window',
        submenu: [
          { role: 'minimize' }, { role: 'zoom' },
          { type: 'separator' }, { role: 'front' },
        ],
      },
    ];
  }

  return [
    {
      label: 'ProPR',
      submenu: [...appActions, { type: 'separator' }, commandItem(commands, 'quit', 'Quit ProPR', 'CmdOrCtrl+Q')],
    },
    editMenu,
    goMenu,
    viewMenu,
    { label: 'Window', submenu: [{ role: 'minimize' }] },
  ];
};

export const configureApplicationMenu = (
  host: ApplicationMenuHost,
  commands: DesktopNativeCommandDispatcher,
  platform: NodeJS.Platform = process.platform,
): ApplicationMenuController => {
  if (platform !== 'darwin' && platform !== 'linux') {
    return { close: () => undefined };
  }
  let closed = false;
  const render = (): void => {
    if (!closed) host.setApplicationMenu(host.buildFromTemplate(createApplicationMenuTemplate(platform, commands)));
  };
  const unsubscribe = commands.subscribe(render);
  render();
  return {
    close() {
      if (closed) return;
      closed = true;
      unsubscribe();
    },
  };
};
