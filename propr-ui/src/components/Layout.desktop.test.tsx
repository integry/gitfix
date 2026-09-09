import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopContext, type DesktopContextValue } from '../desktop/DesktopContext';
import Layout from './Layout';

const mocks = vi.hoisted(() => ({
  openProfileManager: vi.fn(),
  retry: vi.fn(),
  reportConnectedRendererReady: vi.fn(async () => undefined),
  socket: {
    isConnected: true,
    subscribeToQueueStats: vi.fn(),
    unsubscribeFromQueueStats: vi.fn(),
    subscribeToIndexingUpdates: vi.fn(),
    unsubscribeFromIndexingUpdates: vi.fn(),
    onQueueStatsUpdate: vi.fn(() => vi.fn()),
    onIndexingUpdate: vi.fn(() => vi.fn()),
    onDraftUpdate: vi.fn(() => vi.fn()),
  },
}));

vi.mock('../api/proprApi', () => ({ logout: vi.fn() }));
vi.mock('../hooks/useDynamicFavicon', () => ({ useDynamicFavicon: vi.fn() }));
vi.mock('../hooks/useSystemReadiness', () => ({
  useSystemReadiness: () => ({ hasAgents: true, hasRepos: true, hasTasks: true }),
}));
vi.mock('./ui/useToast', () => ({ useToast: () => ({ addToast: vi.fn() }) }));
vi.mock('./GlobalHeader', () => ({ default: () => <header data-testid="global-header">GitHub user</header> }));
vi.mock('./AgentTankSidebar', () => ({ default: () => null }));
vi.mock('../contexts/useSocket', () => ({ useSocket: () => mocks.socket }));
vi.mock('../contexts/DemoModeContext', () => ({ useDemoMode: () => ({ isDemoMode: false }) }));
vi.mock('../contexts/AuthContext', () => ({
  useCurrentUser: () => ({ id: 'user-1', username: 'octocat' }),
  userHasPermission: () => false,
}));
vi.mock('./ConnectPlusBanner', () => ({ ConnectCapacityBanner: () => null }));
vi.mock('../contexts/NotificationCenterContext', () => ({
  useNotificationCenter: () => ({ unreadCount: 0 }),
}));

const desktopValue = (overrides: Partial<DesktopContextValue> = {}): DesktopContextValue => ({
  isDesktop: true,
  platform: 'linux',
  profile: {
    id: 'local',
    name: 'This computer',
    baseUrl: 'http://127.0.0.1:3000',
    kind: 'local',
  },
  connection: { status: 'ready' },
  openProfileManager: mocks.openProfileManager,
  authenticate: vi.fn(async () => undefined),
  openConnectionHelp: vi.fn(async () => undefined),
  retry: mocks.retry,
  reportConnectedRendererReady: mocks.reportConnectedRendererReady,
  ...overrides,
});

const renderLayout = (desktop: DesktopContextValue | null) => render(
  <MemoryRouter>
    <DesktopContext.Provider value={desktop}>
      <Layout><div>Page content</div></Layout>
    </DesktopContext.Provider>
  </MemoryRouter>,
);

describe('Layout desktop instance selector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.socket.isConnected = true;
  });

  it('places the labelled selector in the sidebar without duplicate desktop chrome', async () => {
    renderLayout(desktopValue());

    const selector = screen.getByRole('button', { name: 'Connected: This computer' });
    expect(selector.closest('aside')).not.toBeNull();
    expect(screen.getByText('Instance')).toBeInTheDocument();
    expect(screen.getByText('Local instance')).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(document.querySelector('.desktop-titlebar')).not.toBeInTheDocument();
    expect(screen.getByTestId('global-header')).toHaveTextContent('GitHub user');

    fireEvent.click(selector);
    expect(mocks.openProfileManager).toHaveBeenCalledOnce();
    await waitFor(() => expect(mocks.reportConnectedRendererReady).toHaveBeenCalledOnce());
  });

  it('preserves retry and ProPR Connect identity while offline', () => {
    renderLayout(desktopValue({
      profile: {
        id: 'connect',
        name: 'Operations',
        baseUrl: 'https://t-operations.propr.dev',
        kind: 'remote',
      },
      connection: { status: 'offline', message: 'No route' },
    }));

    const selector = screen.getByRole('button', { name: 'Offline: Operations' });
    expect(screen.getByText('ProPR Connect')).toBeInTheDocument();
    expect(screen.getByText('Offline')).toBeInTheDocument();
    fireEvent.click(selector);
    expect(mocks.retry).toHaveBeenCalledOnce();
    expect(mocks.openProfileManager).not.toHaveBeenCalled();
  });

  it('uses the scoped transport for reconnecting and recovers without replacing the profile', async () => {
    mocks.socket.isConnected = false;
    const desktop = desktopValue();
    const view = renderLayout(desktop);

    const reconnecting = screen.getByRole('button', { name: 'Reconnecting: This computer' });
    expect(reconnecting).toHaveTextContent('Reconnecting');
    fireEvent.click(reconnecting);
    expect(mocks.openProfileManager).toHaveBeenCalledOnce();
    expect(mocks.retry).not.toHaveBeenCalled();

    mocks.socket.isConnected = true;
    view.rerender(
      <MemoryRouter>
        <DesktopContext.Provider value={desktop}>
          <Layout><div>Page content</div></Layout>
        </DesktopContext.Provider>
      </MemoryRouter>,
    );

    expect(screen.getByRole('button', { name: 'Connected: This computer' })).toBeInTheDocument();
    await waitFor(() => expect(mocks.reportConnectedRendererReady).toHaveBeenCalledOnce());
  });

  it('leaves the browser layout free of desktop-only instance controls', () => {
    renderLayout(null);

    expect(screen.queryByText('Instance')).not.toBeInTheDocument();
    expect(document.querySelector('.desktop-instance-selector')).not.toBeInTheDocument();
    expect(screen.getByText('Page content')).toBeInTheDocument();
  });
});
