import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopSetupSnapshot } from '../../../apps/desktop/src/shared/contract';
import { DesktopExperience } from './DesktopExperience';
import { adaptersFor, localProfile } from './DesktopExperience.testSupport';
import type { DesktopGuidedLocalSetupAdapter } from './types';

const apiMock = vi.hoisted(() => ({ setApiBaseUrl: vi.fn() }));
const runtimeMock = vi.hoisted(() => ({ setDesktopApiBaseUrl: vi.fn() }));
vi.mock('../api/apiClient', () => ({ setApiBaseUrl: apiMock.setApiBaseUrl }));
vi.mock('../config/runtimeConfig', () => ({ setDesktopApiBaseUrl: runtimeMock.setDesktopApiBaseUrl }));

const idle: DesktopSetupSnapshot = {
  phase: 'idle', capability: { supported: true, kind: 'local', platform: 'linux' },
  sessionId: '11111111-1111-4111-8111-111111111111', logs: [],
};
const completed: DesktopSetupSnapshot = { ...idle, phase: 'completed', profile: { ...localProfile, kind: 'local' } };
const defaultCancelled: DesktopSetupSnapshot = { ...idle, phase: 'cancelled', error: 'Setup was cancelled safely.' };

const guidedAdapter = (overrides: Partial<DesktopGuidedLocalSetupAdapter> = {}): DesktopGuidedLocalSetupAdapter => ({
  supported: true,
  status: vi.fn(async () => idle),
  start: vi.fn(async () => completed),
  retry: vi.fn(async () => completed),
  cancel: vi.fn(async () => defaultCancelled),
  selectPrivateKey: vi.fn(async () => null),
  acquireWebhookSecret: vi.fn(async () => null),
  onProgress: vi.fn(() => () => undefined),
  ...overrides,
});

const openAndSubmitWizard = async () => {
  fireEvent.click(await screen.findByRole('button', { name: /Set up this computer/i }));
  await screen.findByRole('heading', { name: 'Check the essentials' });
  for (const heading of ['Private local storage', 'Connect GitHub', 'Choose GitHub event intake', 'Select coding agents', 'Ready to install']) {
    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    await screen.findByRole('heading', { name: heading });
  }
  fireEvent.click(screen.getByRole('button', { name: /Install ProPR/i }));
};

describe('production local setup journey', () => {
  beforeEach(() => vi.clearAllMocks());

  it('opens the real wizard and settles cancellation before retrying', async () => {
    let progress: ((snapshot: DesktopSetupSnapshot) => void) | undefined;
    let settleStart: ((snapshot: DesktopSetupSnapshot) => void) | undefined;
    const start = vi.fn(async () => new Promise<DesktopSetupSnapshot>(resolve => {
      settleStart = resolve;
      progress?.({ ...idle, phase: 'running' });
    }));
    const cancelled = { ...idle, phase: 'cancelled' as const, error: 'Setup was cancelled safely.' };
    const cancel = vi.fn(async () => { settleStart?.(cancelled); return cancelled; });
    const retry = vi.fn(async () => completed);
    const adapter = guidedAdapter({
      start, cancel, retry,
      onProgress: vi.fn(listener => { progress = listener; return () => { progress = undefined; }; }),
    });
    const adapters = adaptersFor(); adapters.localSetup = adapter;
    render(<DesktopExperience adapters={adapters}><div>Dashboard</div></DesktopExperience>);

    await openAndSubmitWizard();
    expect(await screen.findByRole('heading', { name: 'Setting up ProPR' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Cancel safely/i }));
    expect(await screen.findByRole('heading', { name: 'Setup needs attention' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Retry setup/i }));
    expect(await screen.findByRole('heading', { name: 'ProPR is ready' })).toBeInTheDocument();
    expect(cancel).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledWith();
  });

  it('hands completion into pairing, authenticated reprobe, and the current dashboard flow', async () => {
    const adapters = adaptersFor();
    adapters.localSetup = guidedAdapter();
    vi.mocked(adapters.connection.probe)
      .mockResolvedValueOnce({ status: 'authentication-required', message: 'Pair this desktop.' })
      .mockResolvedValueOnce({ status: 'ready', version: '0.8.15' });
    render(<DesktopExperience adapters={adapters}><div>Authenticated dashboard</div></DesktopExperience>);

    await openAndSubmitWizard();
    fireEvent.click(await screen.findByRole('button', { name: /Connect securely/i }));
    expect(await screen.findByText('Sign in required')).toBeInTheDocument();
    expect(adapters.profiles.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Sign in in browser/i }));

    expect(await screen.findByText('Authenticated dashboard')).toBeInTheDocument();
    expect(adapters.authentication.authenticate).toHaveBeenCalledWith(localProfile);
    expect(adapters.connection.probe).toHaveBeenCalledTimes(2);
    expect(adapters.profiles.save).toHaveBeenCalledWith(expect.objectContaining({ id: localProfile.id }));
    expect(adapters.profiles.setActiveId).toHaveBeenCalledWith(localProfile.id);
    expect(runtimeMock.setDesktopApiBaseUrl).toHaveBeenCalledWith(localProfile.baseUrl);
  });
});
