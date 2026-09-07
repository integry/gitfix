import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { DesktopNotificationSettings } from '../../../../apps/desktop/src/shared/contract';
import DesktopNotificationSettingsSection from './DesktopNotificationSettingsSection';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
  test: vi.fn(),
  publish: vi.fn(),
  clear: vi.fn(),
  onNavigate: vi.fn(() => () => undefined),
  supported: true,
  desktop: null as unknown as Record<string, unknown>,
}));

const settings = (): DesktopNotificationSettings => ({
  preferences: {
    enabled: false,
    taskStarted: false,
    taskCompleted: false,
    taskFailed: true,
    taskNeedsAttention: true,
  },
  capability: mocks.supported
    ? { supported: true, platform: 'linux', permission: 'unknown' }
    : { supported: false, platform: 'win32', permission: 'unsupported', reason: 'platform-deferred' },
  scope: 'account-instance-device',
});

vi.mock('../../contexts/AuthContext', () => ({
  useCurrentUser: () => ({ id: 'user-1' }),
}));
vi.mock('../../desktop/DesktopContext', () => ({
  useDesktop: () => mocks.desktop,
}));

describe('Desktop notification settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.supported = true;
    mocks.desktop = {
      profile: { id: 'profile-1', name: 'Engineering' },
      connection: { status: 'ready', transportScope: 'abcdefghijklmnopqrstuv' },
      notifications: {
        bridge: mocks,
        scopeFor: (userId: string) => ({
          profileId: 'profile-1', transportScope: 'abcdefghijklmnopqrstuv', userId,
        }),
      },
    };
    mocks.get.mockResolvedValue(settings());
    mocks.update.mockImplementation(async (_scope, update) => ({
      ...settings(), preferences: { ...settings().preferences, ...update },
    }));
    mocks.test.mockResolvedValue({ invoked: true });
  });

  test('shows an independent section with quiet defaults and explicit enrollment', async () => {
    render(<DesktopNotificationSettingsSection />);

    expect(await screen.findByRole('heading', { name: 'Desktop notifications' })).toBeInTheDocument();
    expect(screen.getByText(/separate from Browser push/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Desktop notification for Task started' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Desktop notification for Task completed' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Desktop notification for Task failed' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Desktop notification for Needs attention' })).toBeChecked();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.test).not.toHaveBeenCalled();
  });

  test('enables and tests only after direct user actions', async () => {
    render(<DesktopNotificationSettingsSection />);
    const enabled = await screen.findByRole('checkbox', { name: 'Enable desktop notifications on this device' });
    fireEvent.click(enabled);
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith(
      { profileId: 'profile-1', transportScope: 'abcdefghijklmnopqrstuv', userId: 'user-1' },
      { enabled: true },
    ));
    const testButton = screen.getByRole('button', { name: 'Send test notification' });
    await waitFor(() => expect(testButton).toBeEnabled());
    fireEvent.click(testButton);
    expect(await screen.findByText(/operating system decides whether a banner/)).toBeInTheDocument();
  });

  test('explains the deferred Windows capability without enrollment controls', async () => {
    mocks.supported = false;
    mocks.get.mockResolvedValue(settings());
    render(<DesktopNotificationSettingsSection />);

    expect(await screen.findByText(/currently available on Linux and macOS/)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /Enable desktop notifications/ })).not.toBeInTheDocument();
  });
});
