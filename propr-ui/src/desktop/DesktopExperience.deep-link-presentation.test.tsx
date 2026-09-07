import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { createDesktopBridge, type PreloadIpc } from '../../../apps/desktop/src/preload-bridge';
import { IPC_CHANNELS, type DesktopSetupSnapshot } from '../../../apps/desktop/src/shared/contract';
import { DesktopDeepLinkInbox } from '../desktop-deep-link';
import { DesktopExperience } from './DesktopExperience';
import { adaptersFor, deferred, localProfile } from './DesktopExperience.testSupport';
import type { DesktopGuidedLocalSetupAdapter, DesktopProfile } from './types';

it('does not acknowledge a cold Connect link until its confirmation editor is presented', async () => {
  const invocations: Array<{ channel: string; args: unknown[]; visibleEndpoint: string | null }> = [];
  let receiveFromMain: ((event: unknown, value: unknown) => void) | undefined;
  const ipc: PreloadIpc = {
    invoke: async (channel, ...args) => {
      const endpoint = screen.queryByLabelText('Instance URL');
      invocations.push({
        channel,
        args,
        visibleEndpoint: endpoint instanceof HTMLInputElement ? endpoint.value : null,
      });
    },
    on: (channel, listener) => {
      if (channel === IPC_CHANNELS.deepLink) receiveFromMain = listener;
    },
    removeListener: () => undefined,
  };
  const bridge = createDesktopBridge(ipc);
  const delivery = {
    deliveryId: 42,
    url: 'propr://connect?api=http%3A%2F%2Flocalhost%3A44111',
  };
  receiveFromMain?.({}, delivery);

  const inbox = new DesktopDeepLinkInbox();
  const unsubscribe = bridge.app.onDeepLink(value => inbox.receive(value));
  const profiles = deferred<DesktopProfile[]>();
  const activeProfile = deferred<string | null>();
  const adapters = adaptersFor();
  adapters.profiles.list = vi.fn(() => profiles.promise);
  adapters.profiles.getActiveId = vi.fn(() => activeProfile.promise);
  const rendered = render(
    <DesktopExperience adapters={adapters} deepLinks={inbox}><div>Shared route tree</div></DesktopExperience>
  );
  try {
    expect(await screen.findByText('Opening ProPR…')).toBeInTheDocument();
    expect(screen.queryByLabelText('Instance URL')).not.toBeInTheDocument();
    expect(invocations).toEqual([]);

    await act(async () => {
      profiles.resolve([]);
      activeProfile.resolve(null);
      await Promise.all([profiles.promise, activeProfile.promise]);
    });

    expect(await screen.findByLabelText('Instance URL')).toHaveValue('http://localhost:44111');
    await waitFor(() => expect(invocations).toEqual([{
      channel: IPC_CHANNELS.deepLinkAcknowledgement,
      args: [{
        ...delivery,
        consumption: { kind: 'connect-confirmation', target: 'http://localhost:44111' },
      }],
      visibleEndpoint: 'http://localhost:44111',
    }]));
  } finally {
    unsubscribe();
    rendered.unmount();
  }
});

it('presents Connect during guided setup and settles setup cancellation before connecting', async () => {
  const idle: DesktopSetupSnapshot = {
    phase: 'idle', capability: { supported: true, kind: 'local', platform: 'linux' },
    sessionId: '11111111-1111-4111-8111-111111111111', logs: [],
  };
  const running: DesktopSetupSnapshot = { ...idle, phase: 'running' };
  const cancelled: DesktopSetupSnapshot = { ...idle, phase: 'cancelled', error: 'Setup was cancelled safely.' };
  const startResult = deferred<DesktopSetupSnapshot>();
  const cancellation = deferred<DesktopSetupSnapshot>();
  let progress: ((snapshot: DesktopSetupSnapshot) => void) | undefined;
  const releaseProgressOwner = vi.fn();
  const adapter: DesktopGuidedLocalSetupAdapter = {
    supported: true,
    status: vi.fn(async () => idle),
    start: vi.fn(() => {
      progress?.(running);
      return startResult.promise;
    }),
    retry: vi.fn(async () => cancelled),
    cancel: vi.fn(async () => {
      const result = await cancellation.promise;
      startResult.resolve(result);
      return result;
    }),
    selectPrivateKey: vi.fn(async () => null),
    acquireWebhookSecret: vi.fn(async () => null),
    resolveGithubInstallation: vi.fn(async () => idle),
    onProgress: vi.fn(listener => {
      progress = listener;
      return () => {
        progress = undefined;
        releaseProgressOwner();
      };
    }),
  };
  const adapters = adaptersFor();
  adapters.localSetup = adapter;
  const deepLinks = new DesktopDeepLinkInbox();
  render(<DesktopExperience adapters={adapters} deepLinks={deepLinks}><div>Shared route tree</div></DesktopExperience>);

  fireEvent.click(await screen.findByRole('button', { name: /Set up this computer/i }));
  await screen.findByRole('heading', { name: 'Check the essentials' });
  for (const heading of ['Private local storage', 'Connect GitHub', 'GitHub event intake', 'Select coding agents', 'Ready to install']) {
    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    await screen.findByRole('heading', { name: heading });
  }
  fireEvent.click(screen.getByRole('button', { name: /Install ProPR/i }));
  expect(await screen.findByRole('heading', { name: 'Setting up ProPR' })).toBeInTheDocument();

  let consumption: ReturnType<DesktopDeepLinkInbox['receive']> = null;
  act(() => {
    consumption = deepLinks.receive('propr://connect?api=https%3A%2F%2Fconnect.propr.dev');
  });

  expect(await screen.findByLabelText('Instance URL')).toHaveValue('https://connect.propr.dev');
  await expect(consumption).resolves.toEqual({
    kind: 'connect-confirmation',
    target: 'https://connect.propr.dev',
  });
  expect(adapter.cancel).not.toHaveBeenCalled();
  expect(adapters.connection.probe).not.toHaveBeenCalled();
  expect(releaseProgressOwner).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  await waitFor(() => expect(adapter.cancel).toHaveBeenCalledOnce());
  expect(adapters.connection.probe).not.toHaveBeenCalled();
  expect(releaseProgressOwner).not.toHaveBeenCalled();

  await act(async () => {
    cancellation.resolve(cancelled);
    await cancellation.promise;
  });

  await waitFor(() => expect(adapters.connection.probe).toHaveBeenCalledOnce());
  expect(adapters.connection.probe).toHaveBeenCalledWith(expect.objectContaining({
    baseUrl: 'https://connect.propr.dev',
  }));
  expect(releaseProgressOwner).toHaveBeenCalledOnce();
  expect(adapters.connection.probe).not.toHaveBeenCalledWith(localProfile);
});
