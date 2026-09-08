const { resolve } = require('node:path');
require('tsx/cjs');
const { app, BrowserWindow, Menu, nativeImage, screen, Tray } = require('electron');
const { createLinuxTrayMenuPopup } = require('../src/linux-tray-menu.ts');
const { createDesktopTrayController } = require('../src/system-tray.ts');

const probeReadyMarker = 'PROPR_MENU_POPUP_PROBE_READY';
let deadline;

app.whenReady().then(() => {
  process.stdout.write(`${probeReadyMarker}\n`);
  deadline = setTimeout(() => {
    console.error('Electron menu popup probe timed out after readiness');
    app.exit(1);
  }, 10_000);
  let ownersCreated = 0;
  let ownersMapped = 0;
  let ownersDestroyed = 0;
  let browserWindowOwners = 0;
  let toolbarOwners = 0;
  let activeOwner;
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
      owner.once('closed', () => { ownersDestroyed += 1; });
      return owner;
    },
  });

  let menuWillShow = 0;
  let menuWillClose = 0;
  let trayActivations = 0;
  let opensAfterActivationDispatch = 0;
  let persistentDismissals = 0;
  let activationDispatchReturned = true;
  let dismissalRequested = false;
  let tray;
  let menu;
  let controller;
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
    activationDispatchReturned = false;
    tray.emit(
      'click',
      activationEvents[trayActivations - 1],
      { x: 0, y: 0, width: 0, height: 0 },
      screen.getCursorScreenPoint(),
    );
    activationDispatchReturned = true;
  };

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
        if (activationDispatchReturned) opensAfterActivationDispatch += 1;
        const closingOwner = activeOwner;
        setTimeout(() => {
          dismissalRequested = true;
          if (menuWillShow === 1) menu.closePopup(closingOwner);
          else controller.close();
        }, 100);
      });
      menu.on('menu-will-close', () => {
        menuWillClose += 1;
        if (dismissalRequested) persistentDismissals += 1;
        dismissalRequested = false;
        if (menuWillClose === 1) {
          setImmediate(activateTray);
          return;
        }
        setImmediate(() => {
          setImmediate(() => {
            clearTimeout(deadline);
            console.log(JSON.stringify({
              menuWillShow,
              menuWillClose,
              trayActivations,
              opensAfterActivationDispatch,
              persistentDismissals,
              ownersCreated,
              ownersMapped,
              ownersDestroyed,
              browserWindowOwners,
              toolbarOwners,
              trayDestroyed: tray.isDestroyed(),
            }));
            app.quit();
          });
        });
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
