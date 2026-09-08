const { resolve } = require('node:path');
require('tsx/cjs');
const { app, BaseWindow, Menu, screen, Tray } = require('electron');
const { createLinuxTrayMenuPopup } = require('../src/linux-tray-menu.ts');

const deadline = setTimeout(() => {
  console.error('Electron menu popup probe timed out');
  app.exit(1);
}, 10_000);

app.whenReady().then(() => {
  let ownersCreated = 0;
  let ownersMapped = 0;
  let ownersDestroyed = 0;
  let activeOwner;
  const popup = createLinuxTrayMenuPopup({
    screen,
    environment: {},
    createHost: options => {
      const owner = new BaseWindow(options);
      ownersCreated += 1;
      activeOwner = owner;
      owner.once('show', () => { ownersMapped += 1; });
      owner.once('closed', () => { ownersDestroyed += 1; });
      return owner;
    },
  });

  let menuWillShow = 0;
  let menuWillClose = 0;
  const menu = Menu.buildFromTemplate([{ label: 'Open ProPR', enabled: true }]);
  const tray = new Tray(resolve(__dirname, '../assets/icons/propr-tray.png'));
  tray.setToolTip('ProPR native menu probe');
  tray.setContextMenu(menu);
  menu.on('menu-will-show', () => {
    menuWillShow += 1;
    const closingOwner = activeOwner;
    setTimeout(() => {
      if (menuWillShow === 1) menu.closePopup(closingOwner);
      else popup.close();
    }, 50);
  });
  menu.on('menu-will-close', () => {
    menuWillClose += 1;
    if (menuWillClose === 1) {
      setImmediate(() => popup.popup(menu, {
        bounds: { x: 0, y: 0, width: 0, height: 0 },
        position: screen.getCursorScreenPoint(),
      }));
      return;
    }
    setImmediate(() => {
      setImmediate(() => {
        clearTimeout(deadline);
        console.log(JSON.stringify({
          menuWillShow,
          menuWillClose,
          ownersCreated,
          ownersMapped,
          ownersDestroyed,
        }));
        tray.destroy();
        app.quit();
      });
    });
  });
  popup.popup(menu, {
    bounds: { x: 0, y: 0, width: 0, height: 0 },
    position: screen.getCursorScreenPoint(),
  });
}).catch(error => {
  clearTimeout(deadline);
  console.error(error);
  app.exit(1);
});
