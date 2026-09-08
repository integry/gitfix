const { resolve } = require('node:path');
const { app, BrowserWindow, Menu, Tray } = require('electron');

const deadline = setTimeout(() => {
  console.error('Electron menu popup probe timed out');
  app.exit(1);
}, 10_000);

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 320,
    height: 240,
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await window.loadURL('data:text/html,<title>ProPR native menu probe</title>');

  let menuWillShow = 0;
  let menuWillClose = 0;
  let popupCallback = 0;
  const menu = Menu.buildFromTemplate([{ label: 'Open ProPR', enabled: true }]);
  const tray = new Tray(resolve(__dirname, '../assets/icons/propr-tray.png'));
  tray.setToolTip('ProPR native menu probe');
  tray.setContextMenu(menu);
  menu.once('menu-will-show', () => {
    menuWillShow += 1;
    setTimeout(() => menu.closePopup(window), 50);
  });
  menu.once('menu-will-close', () => { menuWillClose += 1; });
  menu.popup({
    window,
    x: 16,
    y: 16,
    callback: () => {
      popupCallback += 1;
      setImmediate(() => {
        clearTimeout(deadline);
        console.log(JSON.stringify({ menuWillShow, menuWillClose, popupCallback }));
        tray.destroy();
        window.destroy();
        app.quit();
      });
    },
  });
}).catch(error => {
  clearTimeout(deadline);
  console.error(error);
  app.exit(1);
});
