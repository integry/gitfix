import { useLayoutEffect } from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopExperience } from './DesktopExperience';
import { DesktopInstanceSelector } from './DesktopInstanceSelector';
import { adaptersFor, deferred, localProfile } from './DesktopExperience.testSupport';
import type { DesktopConnectionResult } from './types';

const apiMock = vi.hoisted(() => ({ setApiBaseUrl: vi.fn() }));
const runtimeMock = vi.hoisted(() => ({ setDesktopApiBaseUrl: vi.fn() }));

vi.mock('../api/apiClient', () => ({ setApiBaseUrl: apiMock.setApiBaseUrl }));
vi.mock('../config/runtimeConfig', () => ({ setDesktopApiBaseUrl: runtimeMock.setDesktopApiBaseUrl }));

const OpenManagerAtConnectedCommit = () => {
  useLayoutEffect(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'I', ctrlKey: true, shiftKey: true, bubbles: true,
    }));
  }, []);
  return <><DesktopInstanceSelector /><div>Connected app</div></>;
};

describe('DesktopExperience shortcut readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('handles the management shortcut in the commit that makes a delayed connection ready', async () => {
    const pendingProbe = deferred<DesktopConnectionResult>();
    const adapters = adaptersFor([localProfile], localProfile.id, () => pendingProbe.promise);
    render(
      <DesktopExperience adapters={adapters}>
        <OpenManagerAtConnectedCommit />
      </DesktopExperience>,
    );

    expect(await screen.findByRole('heading', { name: 'Connecting to This computer' })).toBeInTheDocument();
    await act(async () => { pendingProbe.resolve({ status: 'ready', version: '0.8.15' }); });

    expect(await screen.findByRole('dialog', { name: 'Manage instances' })).toBeInTheDocument();
  });
});
