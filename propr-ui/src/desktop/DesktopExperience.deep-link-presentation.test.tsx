import { act, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { createDesktopBridge, type PreloadIpc } from '../../../apps/desktop/src/preload-bridge';
import { IPC_CHANNELS } from '../../../apps/desktop/src/shared/contract';
import { DesktopDeepLinkInbox } from '../desktop-deep-link';
import { DesktopExperience } from './DesktopExperience';
import { adaptersFor, deferred } from './DesktopExperience.testSupport';
import type { DesktopProfile } from './types';

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
