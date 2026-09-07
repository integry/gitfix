const { app, BrowserWindow, ipcMain, protocol } = require('electron');
const { join } = require('node:path');

app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged([{
  scheme: 'propr-readiness-fixture',
  privileges: { standard: true, secure: true },
}]);

app.whenReady().then(async () => {
  protocol.handle('propr-readiness-fixture', () => new Response(
    '<main>renderer readiness fixture</main>',
    { headers: { 'content-type': 'text/html; charset=UTF-8' } },
  ));
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, 'electron-frame-semantics-preload.cjs'),
      sandbox: true,
    },
  });
  const initialFrame = window.webContents.mainFrame;
  const initialDocumentId = `${initialFrame.processId}:${initialFrame.frameToken}`;
  let navigationStarted;
  let navigationCommitted;
  window.webContents.on('did-start-navigation', (details, deprecatedUrl) => {
    const frame = window.webContents.mainFrame;
    navigationStarted = {
      detailsIsFirst: typeof details === 'object' && details !== null,
      deprecatedUrlIsSecond: typeof deprecatedUrl === 'string',
      isMainFrame: details.isMainFrame,
      isSameDocument: details.isSameDocument,
      detailsFrameMatchesGetter: details.frame === frame,
      initialFrameMatchesGetter: initialFrame === frame,
      initialDocumentIdMatches: initialDocumentId === `${frame.processId}:${frame.frameToken}`,
    };
  });
  window.webContents.on('did-navigate', () => {
    const firstGetter = window.webContents.mainFrame;
    const secondGetter = window.webContents.mainFrame;
    navigationCommitted = {
      firstGetterMatchesSecondGetter: firstGetter === secondGetter,
      initialFrameMatchesGetter: initialFrame === firstGetter,
      initialDocumentIdMatches: initialDocumentId === `${firstGetter.processId}:${firstGetter.frameToken}`,
    };
  });
  ipcMain.handle('ready', event => {
    const firstGetter = event.sender.mainFrame;
    const secondGetter = event.sender.mainFrame;
    process.stdout.write(`${JSON.stringify({
      navigationStarted,
      navigationCommitted,
      readiness: {
        senderFrameMatchesFirstGetter: event.senderFrame === firstGetter,
        firstGetterMatchesSecondGetter: firstGetter === secondGetter,
        initialFrameMatchesGetter: initialFrame === firstGetter,
        initialDocumentIdMatches: initialDocumentId === `${firstGetter.processId}:${firstGetter.frameToken}`,
      },
    })}\n`);
    setTimeout(() => app.quit(), 50);
  });
  await window.loadURL('propr-readiness-fixture://app/renderer.html');
}).catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  app.exit(1);
});
