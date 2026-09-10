import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { Server as SocketIOServer } from 'socket.io';
import * as shared from '@propr/shared';
import { DesktopCredentialService } from '../src/credential-service.ts';
import { ProfileStore } from '../src/profile-store.ts';
import {
  authorizePackagedAcceptanceTest,
  packagedAcceptanceAccountConfirmation,
  packagedAcceptancePairingTiming,
  PACKAGED_ACCEPTANCE_LOOPBACK_ORIGINS,
} from '../src/acceptance-test-authorization.ts';
import { classifyCurrentUserRequestShape } from './packaged-acceptance-current-user.mjs';
import { PACKAGED_ACCEPTANCE_EPOCH_MILLISECONDS } from './packaged-acceptance-clock.mjs';
import { FIXED_TIME } from './acceptance-artifacts.mjs';

// Exercise the runner's actual HTTP fixture without launching its top-level Electron journeys.
// Keep this extraction bounded to fixture construction, as in the stats fixture tests.
const runner = readFileSync(new URL('./run-packaged-acceptance.mjs', import.meta.url), 'utf8');
const between = (start, end) => {
  const from = runner.indexOf(start);
  const to = runner.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return runner.slice(from, to);
};
const createFixture = async mode => {
  const fixture = runInNewContext(`
    ${between('const DEVICE_SECRET =', 'const consoleRecords =')}
    const requestRecords = [], fixtureCurrentUserRecords = [], fixtureHandshakeRecords = [], socketRecords = [];
    let activeJourney = 'account-regression', currentUserEvidenceInvalid = false;
    const QUEUE_STATS_SUBSCRIBE_EVENT = 'subscribe:queue:stats';
    ${between('const json =', 'let readyOrigin;')}
    ({ createFixture, fixtures, requestRecords, fixtureCurrentUserRecords, INSTANCE_TOKEN });
  `, {
    ...shared, URL, Buffer, createServer, SocketIOServer, once, FIXED_TIME,
    PACKAGED_ACCEPTANCE_EPOCH_MILLISECONDS, classifyCurrentUserRequestShape,
  });
  const origin = PACKAGED_ACCEPTANCE_LOOPBACK_ORIGINS[mode === 'revoked' ? 1 : 0];
  await fixture.createFixture(mode, origin);
  return {
    ...fixture, origin,
    close: async () => {
      for (const { io } of fixture.fixtures) await new Promise(resolve => io.close(resolve));
    },
  };
};

// Unit/integration storage only; packaged acceptance still uses the real OS credential backend.
const encryption = {
  isEncryptionAvailable: () => true, backend: () => 'keychain',
  encrypt: value => Buffer.from(value), decrypt: value => value.toString(),
};
const account = { id: '2296', username: 'acceptance-admin', avatarUrl: null };
const confirmationPath = '/api/auth/user?desktop_account_confirmation=1';

const setup = async (mode, overrides = {}) => {
  const fixture = await createFixture(mode);
  const directory = await mkdtemp(join(tmpdir(), 'propr-desktop-acceptance-'));
  const authorized = authorizePackagedAcceptanceTest({
    argv: ['app', '--propr-acceptance-test', `--user-data-dir=${directory}`],
    defaultUserDataDirectory: join(tmpdir(), 'default-desktop-profile'),
    environmentTriggered: true, isPackaged: true, platform: 'linux',
  });
  const profiles = new ProfileStore(directory, encryption);
  const confirm = packagedAcceptanceAccountConfirmation(authorized);
  let confirmations = 0;
  const service = new DesktopCredentialService({
    profiles, fetch, clientName: 'Acceptance account regression',
    pairingTiming: packagedAcceptancePairingTiming(authorized),
    openPairingBrowser: async () => {},
    confirmAccount: async (observed, origin, signal) => {
      confirmations++;
      assert.deepEqual(observed, account);
      assert.equal(origin, fixture.origin);
      assert.equal(await profiles.readCredential('operations'), null);
      assert.equal((await profiles.list()).profiles.length, 0);
      return confirm(observed, origin, signal);
    },
    ...overrides,
  });
  return {
    fixture, profiles, service,
    profile: { id: 'operations', label: 'Operations', apiBaseUrl: fixture.origin },
    confirmations: () => confirmations,
    close: async () => {
      await service.dispose(); await profiles.close(); await fixture.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
};

for (const mode of ['ready', 'revoked']) {
  test(`acceptance ${mode} fixture pairs, confirms, reprobes and activates through the real credential service`, async () => {
    const f = await setup(mode);
    try {
      assert.equal((await f.service.probe(f.profile)).status, 'authentication-required');
      await f.service.pair(f.profile);
      assert.equal(f.confirmations(), 1);
      assert.deepEqual((await f.profiles.list()).profiles[0].account, account);
      const probe = await f.service.probe(f.profile);
      assert.equal(probe.status, 'ready');
      const activated = await f.service.activate(probe.activationTicket);
      assert.equal(activated.status, 'ready');
      assert.equal(activated.profileId, f.profile.id);
      assert.match(activated.transportScope, /^[A-Za-z0-9_-]{22}$/);
      const url = `${f.fixture.origin}/api/auth/user?proprDesktopScopeGeneration=1`;
      const prepared = f.service.prepareRequest(url, {
        Origin: shared.DESKTOP_RENDERER_ORIGIN,
        'X-ProPR-Desktop-Transport-Scope': activated.transportScope,
      });
      assert.notEqual(prepared.cancel, true);
      const response = await fetch(url, { headers: prepared.requestHeaders });
      assert.equal(response.status, mode === 'ready' ? 200 : 401);
      const user = await response.json();
      if (mode === 'ready') {
        assert.equal(user.id, account.id);
        assert.equal(user.username, account.username);
      } else assert.equal(user.code, 'INSTANCE_TOKEN_REVOKED');
      assert.deepEqual(Array.from(f.fixture.fixtureCurrentUserRecords, record => record.source), [
        'account-confirmation', 'main', 'renderer',
      ]);
      assert.ok(f.fixture.fixtureCurrentUserRecords.every(record =>
        record.authorizationMatchesActivatedBearer && !record.cookiePresent));
      const requests = Array.from(f.fixture.requestRecords);
      const activation = requests.findIndex(record => record.url.endsWith('/activate'));
      const confirmation = requests.findIndex(record => record.url === confirmationPath);
      const reprobe = requests.findIndex(record => record.url === '/api/auth/user');
      assert.ok(activation >= 0 && confirmation > activation && reprobe > confirmation);
    } finally { await f.close(); }
  });
}

for (const failure of ['malformed-account', 'denied-admission', 'cancelled-confirmation', 'missing-confirmation']) {
  test(`acceptance pairing never commits or activates after ${failure}`, async () => {
    const f = await setup('ready', failure === 'missing-confirmation'
      ? { confirmAccount: undefined }
      : failure === 'cancelled-confirmation'
      ? { confirmAccount: async () => false }
      : { fetch: async (input, init) => input.toString().endsWith(confirmationPath)
        ? new Response(JSON.stringify(failure === 'malformed-account'
          ? { ...account, id: 'acceptance-user' } : { code: 'INSUFFICIENT_INSTANCE_PERMISSION' }),
        { status: failure === 'malformed-account' ? 200 : 403 })
        : fetch(input, init) });
    try {
      await assert.rejects(f.service.pair(f.profile), {
        code: failure.endsWith('confirmation') ? 'PAIRING_CANCELLED' : 'PAIRING_REJECTED',
      });
      assert.equal(f.confirmations(), 0);
      assert.equal(await f.profiles.readCredential(f.profile.id), null);
      assert.equal((await f.profiles.list()).profiles.length, 0);
      assert.equal((await f.service.probe(f.profile)).status, 'authentication-required');
    } finally { await f.close(); }
  });
}

test('acceptance identity routes reject inactive tokens, wrong custody and malformed confirmation requests', async () => {
  const f = await setup('ready');
  const bearer = { Authorization: `Bearer ${f.fixture.INSTANCE_TOKEN}` };
  try {
    assert.equal((await fetch(`${f.fixture.origin}${confirmationPath}`, { headers: bearer })).status, 401);
    await f.service.pair(f.profile);
    for (const headers of [{}, { Authorization: 'Bearer wrong' }, { ...bearer, Cookie: 'session=wrong' },
      { ...bearer, 'X-ProPR-Desktop-Transport-Scope': 'renderer-scope' },
      { ...bearer, Origin: shared.DESKTOP_RENDERER_ORIGIN }]) {
      assert.equal((await fetch(`${f.fixture.origin}${confirmationPath}`, { headers })).status, 401);
    }
    for (const path of [`${confirmationPath}&extra=1`, '/api/auth/user?desktop_account_confirmation=0']) {
      assert.equal((await fetch(`${f.fixture.origin}${path}`, { headers: bearer })).status, 401);
    }
  } finally { await f.close(); }
});
