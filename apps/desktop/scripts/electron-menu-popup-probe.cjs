const { resolve } = require('node:path');
require('tsx/cjs');
const { app, BrowserWindow, Menu, nativeImage, screen, Tray } = require('electron');
const { createLinuxTrayMenuPopup } = require('../src/linux-tray-menu.ts');
const { createDesktopTrayController } = require('../src/system-tray.ts');

const probeReadyMarker = 'PROPR_MENU_POPUP_PROBE_READY';
let deadline;
let persistentMainWindow;
let tray;
let controller;
let menu;
let activeOwner;
let menuWillShow = 0;
let menuWillClose = 0;
let trayActivations = 0;
let opensAfterActivationDispatch = 0;
let persistentDismissals = 0;
let ownersCreated = 0;
let ownersMapped = 0;
let ownersFocused = 0;
let ownersDestroyed = 0;
let browserWindowOwners = 0;
let toolbarOwners = 0;
let menusShownWithFocusedOwner = 0;
let menusShownWithPersistentMainWindow = 0;
let menuClosuresWithPersistentMainWindow = 0;
let persistentMainWindowsCreated = 0;
let persistentMainWindowsDestroyed = 0;
let windowAllClosed = 0;
let beforeQuit = 0;
let willQuit = 0;
let activationDispatchReturned = true;
let dismissalRequested = false;
const eventTrace = [];

const reportEvidence = () => {
  clearTimeout(deadline);
  console.log(JSON.stringify({
    menuWillShow,
    menuWillClose,
    trayActivations,
    opensAfterActivationDispatch,
    persistentDismissals,
    ownersCreated,
    ownersMapped,
    ownersFocused,
    ownersDestroyed,
    browserWindowOwners,
    toolbarOwners,
    menusShownWithFocusedOwner,
    menusShownWithPersistentMainWindow,
    menuClosuresWithPersistentMainWindow,
    persistentMainWindowsCreated,
    persistentMainWindowsDestroyed,
    trayDestroyed: tray?.isDestroyed() ?? false,
    windowAllClosed,
    beforeQuit,
    willQuit,
    eventTrace,
  }));
};

// Match the production Linux lifecycle: retaining any BrowserWindow prevents
// transient menu-owner teardown from quitting the application, while closing
// the final window deliberately quits it.
app.on('window-all-closed', () => {
  windowAllClosed += 1;
  eventTrace.push('window-all-closed');
  app.quit();
});
app.on('before-quit', () => {
  beforeQuit += 1;
  eventTrace.push('before-quit');
});
app.on('will-quit', () => {
  willQuit += 1;
  eventTrace.push('will-quit');
  reportEvidence();
});

app.whenReady().then(() => {
  // The desktop creates this regular hidden BrowserWindow before its tray and
  // retains it for the whole tray lifetime. It is intentionally never shown:
  // the menu helper must remain independent of main-window visibility.
  persistentMainWindow = new BrowserWindow({
    title: 'ProPR Desktop',
    width: 1280,
    height: 820,
    minWidth: 880,
    minHeight: 620,
    backgroundColor: '#f8fafc',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: false,
    },
  });
  persistentMainWindowsCreated += 1;
  persistentMainWindow.once('closed', () => {
    persistentMainWindowsDestroyed += 1;
    eventTrace.push('main-window-closed');
  });

  process.stdout.write(`${probeReadyMarker}\n`);
  deadline = setTimeout(() => {
    console.error('Electron menu popup probe timed out after readiness');
    app.exit(1);
  }, 10_000);

  const activationEvents = [
    {},
    {
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      triggeredByAccelerator: false,
    },
  ];

  const activateTray = () => {
    trayActivations += 1;
    eventTrace.push(`tray-activation-${trayActivations}`);
    activationDispatchReturned = false;
    tray.emit(
      'click',
      activationEvents[trayActivations - 1],
      { x: 0, y: 0, width: 0, height: 0 },
      screen.getCursorScreenPoint(),
    );
    activationDispatchReturned = true;
  };

  const popup = createLinuxTrayMenuPopup({
    screen,
    environment: {},
    createHost: options => {
      const owner = new BrowserWindow(options);
      ownersCreated += 1;
      if (owner instanceof BrowserWindow) browserWindowOwners += 1;
      if (options.type === 'toolbar' && options.focusable === true) toolbarOwners += 1;
      activeOwner = owner;
      owner.once('show', () => { ownersMapped += 1; });
      owner.once('focus', () => { ownersFocused += 1; });
      owner.once('closed', () => {
        ownersDestroyed += 1;
        eventTrace.push(`owner-closed-${ownersDestroyed}`);
        if (ownersDestroyed === 1) {
          setImmediate(activateTray);
          return;
        }
        persistentMainWindow?.destroy();
      });
      return owner;
    },
  });

  controller = createDesktopTrayController({
    platform: 'linux',
    icon: nativeImage.createFromPath(resolve(__dirname, '../assets/icons/propr-tray.png')),
    createTray: icon => {
      tray = new Tray(icon);
      return tray;
    },
    buildMenu: template => {
      menu = Menu.buildFromTemplate(template);
      menu.on('menu-will-show', () => {
        menuWillShow += 1;
        eventTrace.push(`menu-will-show-${menuWillShow}`);
        if (activeOwner?.isFocused()) menusShownWithFocusedOwner += 1;
        if (persistentMainWindow && !persistentMainWindow.isDestroyed()) {
          menusShownWithPersistentMainWindow += 1;
        }
        if (activationDispatchReturned) opensAfterActivationDispatch += 1;
        const menuIndex = menuWillShow;
        const closingOwner = activeOwner;
        setImmediate(() => {
          dismissalRequested = true;
          eventTrace.push(`dismissal-requested-${menuIndex}`);
          if (menuIndex === 1) menu.closePopup(closingOwner);
          else controller.close();
        });
      });
      menu.on('menu-will-close', () => {
        menuWillClose += 1;
        eventTrace.push(`menu-will-close-${menuWillClose}`);
        if (persistentMainWindow && !persistentMainWindow.isDestroyed()) {
          menuClosuresWithPersistentMainWindow += 1;
        }
        if (dismissalRequested) persistentDismissals += 1;
        dismissalRequested = false;
      });
      return menu;
    },
    popupMenu: (popupMenu, activation) => popup.popup(popupMenu, activation),
    closePopupMenu: () => popup.close(),
    setBadgeCount: () => false,
    fetchActiveWork: async () => ({ status: 'disconnected' }),
    commands: {
      dispatch: () => {},
      getState: () => ({
        authenticated: false,
        nativeNotificationsAvailable: false,
        nativeNotificationsEnabled: false,
      }),
      subscribe: () => () => {},
    },
    log: () => {},
  });
  controller.start();
  setImmediate(activateTray);
}).catch(error => {
  clearTimeout(deadline);
  console.error(error);
  app.exit(1);
});
