const { app, session } = require('electron');
const { pathToFileURL } = require('node:url');
const { resolve } = require('node:path');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  let endpoint;
  try {
    endpoint = new URL(process.argv.at(-1));
  } catch {
    throw new Error('Native zstd pairing endpoint is missing');
  }
  if (endpoint.protocol !== 'http:'
    || endpoint.hostname !== '127.0.0.1'
    || !endpoint.port
    || endpoint.username
    || endpoint.password
    || endpoint.pathname !== '/valid'
    || endpoint.search
    || endpoint.hash) throw new Error('Native zstd pairing endpoint is invalid');

  const clientModuleUrl = pathToFileURL(resolve(
    __dirname,
    '../../../packages/client/dist/pairingProtocol.js',
  )).href;
  const { requestPairingProtocol } = await import(clientModuleUrl);
  const electronFetch = session.defaultSession.fetch.bind(session.defaultSession);
  const request = async path => {
    let responseEncoding;
    let responseLength;
    try {
      const value = await requestPairingProtocol(async (...args) => {
        const response = await electronFetch(...args);
        responseEncoding = response.headers.get('content-encoding');
        responseLength = response.headers.get('content-length');
        return response;
      }, new URL(path, endpoint), { method: 'POST' });
      return { kind: 'success', responseEncoding, responseLength, value };
    } catch (error) {
      return {
        kind: error && typeof error.kind === 'string' ? error.kind : 'unexpected',
        message: error instanceof Error ? error.message : '',
        responseEncoding,
        responseLength,
      };
    }
  };

  process.stdout.write(`${JSON.stringify({
    valid: await request('/valid'),
    decodedOverLimit: await request('/decoded-over-limit'),
    truncated: await request('/truncated'),
    stacked: await request('/stacked'),
  })}\n`);
  app.quit();
}).catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  app.exit(1);
});
