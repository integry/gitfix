import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DesktopContext, type DesktopContextValue } from './DesktopContext';
import { DesktopInstanceSelector } from './DesktopInstanceSelector';

const profile = {
  id: 'preview', name: 'A very long shared development instance name',
  baseUrl: 'https://preview.example', kind: 'remote' as const,
  account: { id: '101', username: 'preview-engineering-account', avatarUrl: null },
};
const context = (overrides: Partial<DesktopContextValue> = {}): DesktopContextValue => ({
  isDesktop: true, platform: 'macos', profile, connection: { status: 'ready' },
  openProfileManager: vi.fn(), retry: vi.fn(), authenticate: vi.fn(), openConnectionHelp: vi.fn(),
  ...overrides,
});
const selector = (value: DesktopContextValue, transportReady = true) => (
  <DesktopContext.Provider value={value}><DesktopInstanceSelector transportReady={transportReady} /></DesktopContext.Provider>
);

describe('desktop selector identity and actions', () => {
  it('exposes the full instance and account, with a labeled dialog action', () => {
    const value = context();
    render(selector(value));
    const button = screen.getByRole('button', { name: `Connected: ${profile.name}` });
    expect(button).toHaveAttribute('aria-haspopup', 'dialog');
    expect(button).toHaveAccessibleDescription(/GitHub account: @preview-engineering-account\. Switch instance or GitHub account/);
    expect(screen.getByText(profile.name)).toHaveAttribute('title', profile.name);
    expect(screen.getByText(`@${profile.account.username}`).closest('[title]')).toHaveAttribute('title', `@${profile.account.username}`);
    fireEvent.click(button);
    expect(value.openProfileManager).toHaveBeenCalledOnce();
    expect(value.retry).not.toHaveBeenCalled();
  });

  it.each(['offline', 'incompatible'] as const)('distinguishes %s status from retry', status => {
    const value = context({ connection: { status, message: 'Preview status' } });
    render(selector(value));
    const button = screen.getByRole('button');
    expect(button).toHaveAccessibleDescription(/Retry connection/);
    expect(button).not.toHaveAttribute('aria-haspopup');
    fireEvent.click(button);
    expect(value.retry).toHaveBeenCalledOnce();
    expect(value.openProfileManager).not.toHaveBeenCalled();
  });

  it('replaces the displayed account with the active profile and clears absent identity', () => {
    const value = context();
    const view = render(selector(value));
    view.rerender(selector(context({ profile: { ...profile, id: 'second', account: { id: '202', username: 'preview-second', avatarUrl: null } } }), false));
    expect(screen.queryByText('@preview-engineering-account')).not.toBeInTheDocument();
    expect(screen.getByRole('button')).toHaveAccessibleDescription(/@preview-second\. Switch/);
    view.rerender(selector(context({ profile: { ...profile, account: undefined } })));
    expect(screen.queryByText('GitHub account')).not.toBeInTheDocument();
    expect(screen.queryByText('@preview-second')).not.toBeInTheDocument();
  });
});
