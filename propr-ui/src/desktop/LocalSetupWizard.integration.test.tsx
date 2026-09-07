import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopSetupSnapshot } from '../../../apps/desktop/src/shared/contract';
import { DesktopExperience } from './DesktopExperience';
import { adaptersFor, localProfile } from './DesktopExperience.testSupport';
import { LocalSetupWizard } from './LocalSetupWizard';
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
  for (const heading of ['Private local storage', 'Connect GitHub', 'GitHub event intake', 'Select coding agents', 'Ready to install']) {
    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    await screen.findByRole('heading', { name: heading });
  }
  fireEvent.click(screen.getByRole('button', { name: /Install ProPR/i }));
};

describe('production local setup journey', () => {
  beforeEach(() => vi.clearAllMocks());

  it('removes Demo and fixes ProPR Connect to readable WebSocket intake', async () => {
    render(<LocalSetupWizard adapter={guidedAdapter()} onBack={vi.fn()} onComplete={vi.fn()} />);

    await screen.findByRole('heading', { name: 'Check the essentials' });
    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    expect(await screen.findByRole('heading', { name: 'Connect GitHub' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /Demo/i })).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'ProPR Connect' })).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    expect(await screen.findByRole('heading', { name: 'GitHub event intake' })).toBeInTheDocument();
    expect(screen.getByText('ProPR Connect uses a persistent WebSocket connection for GitHub events.')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });

  it('keeps Custom GitHub App polling and direct webhook choices readable', async () => {
    const adapter = guidedAdapter({
      selectPrivateKey: vi.fn(async () => ({ capability: 'private-key-capability-123456789012', label: 'github-app.pem' })),
    });
    render(<LocalSetupWizard adapter={adapter} onBack={vi.fn()} onComplete={vi.fn()} />);

    await screen.findByRole('heading', { name: 'Check the essentials' });
    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    fireEvent.click(await screen.findByRole('radio', { name: 'Custom GitHub App' }));
    fireEvent.change(screen.getByLabelText('App ID'), { target: { value: '123' } });
    fireEvent.change(screen.getByLabelText('Installation ID'), { target: { value: '456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Choose private key' }));
    await screen.findByText('github-app.pem');
    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));

    expect(await screen.findByRole('heading', { name: 'GitHub event intake' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Polling' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Direct webhook' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'WebSocket' })).not.toBeInTheDocument();
  });

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

  it('shows status failures with working back and retry actions', async () => {
    const adapter = guidedAdapter();
    vi.mocked(adapter.status).mockRejectedValueOnce(new Error('private status failure'));
    const onBack = vi.fn();
    render(<LocalSetupWizard adapter={adapter} onBack={onBack} onComplete={vi.fn()} />);

    expect(await screen.findByRole('heading', { name: 'Could not load setup' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Setup status is unavailable.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Check the essentials' })).toBeInTheDocument();
    expect(adapter.status).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('keeps cancellation failures visible with retry and back available', async () => {
    const adapter = guidedAdapter({
      status: vi.fn(async () => ({ ...idle, phase: 'running' as const })),
      cancel: vi.fn(async () => { throw new Error('private cancellation failure'); }),
    });
    const onBack = vi.fn();
    render(<LocalSetupWizard adapter={adapter} onBack={onBack} onComplete={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel safely' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Setup cancellation could not be confirmed.');
    expect(screen.getByRole('button', { name: 'Try cancellation again' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('renders a failed recovery retry without hiding recovery controls', async () => {
    const failed = { ...idle, phase: 'failed' as const, error: 'Docker is unavailable.' };
    const adapter = guidedAdapter({
      status: vi.fn(async () => failed),
      retry: vi.fn(async () => { throw new Error('private retry failure'); }),
    });
    render(<LocalSetupWizard adapter={adapter} onBack={vi.fn()} onComplete={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Retry setup' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Local setup could not be started.');
    expect(screen.getByRole('button', { name: 'Retry setup' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
  });

  it('requires the dedicated recovery control before replacing an incompatible running stack', async () => {
    const incompatible: DesktopSetupSnapshot = {
      ...idle,
      phase: 'failed',
      state: {
        rootDir: '/redacted',
        steps: [{
          id: 'start-stack', title: 'Start stack', description: 'Launch services.', optional: false,
          status: 'failed', detail: 'The retained runtime is incompatible.',
          nextAction: 'Only this Desktop-managed stack is replaced; data and credentials are retained.',
          recoveryAction: 'replace-running-stack',
        }],
      },
      resumeAvailable: true,
      resume: {
        agents: [], reinitialize: false, github: { mode: 'relay' }, intake: { mode: 'routing_websocket' },
        whitelist: null, repository: null,
      },
    };
    const retry = vi.fn(async () => completed);
    render(<LocalSetupWizard adapter={guidedAdapter({ status: vi.fn(async () => incompatible), retry })} onBack={vi.fn()} onComplete={vi.fn()} />);

    const replace = await screen.findByRole('button', { name: 'Restart with aligned runtime' });
    expect(screen.getByText(/data and credentials are retained/i)).toBeInTheDocument();
    expect(retry).not.toHaveBeenCalled();
    fireEvent.click(replace);
    expect(await screen.findByRole('heading', { name: 'ProPR is ready' })).toBeInTheDocument();
    expect(retry).toHaveBeenCalledWith({
      sessionId: idle.sessionId,
      recoveryAction: 'replace-running-stack',
    });
  });

  it('offers credential review without replacing ordinary retry for a transient failure', async () => {
    const requiresReview: DesktopSetupSnapshot = {
      ...idle, phase: 'failed', error: 'The backend was temporarily unavailable.',
      resumeAvailable: true, reconfigurationRequired: true,
      resume: {
        agents: [], reinitialize: false,
        github: { mode: 'app', appId: '123', installationId: '456', reconfigurationRequired: true },
        intake: { mode: 'polling' }, whitelist: null, repository: null, reconfigurationStage: 'github',
      },
    };
    const retry = vi.fn(async () => completed);
    const adapter = guidedAdapter({ status: vi.fn(async () => requiresReview), retry });
    render(<LocalSetupWizard adapter={adapter} onBack={vi.fn()} onComplete={vi.fn()} />);

    expect(await screen.findByRole('button', { name: 'Review saved choices' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry setup' }));
    expect(await screen.findByRole('heading', { name: 'ProPR is ready' })).toBeInTheDocument();
    expect(retry).toHaveBeenCalledWith();
  });

  it('requires a supported choice when a legacy saved setup used Demo mode', async () => {
    const legacy: DesktopSetupSnapshot = {
      ...idle, phase: 'failed', error: 'Demo mode is no longer available in desktop setup.',
      resumeAvailable: true, reconfigurationRequired: true,
      resume: {
        agents: ['codex'], reinitialize: false, github: { mode: 'demo' }, intake: { mode: 'keep' },
        whitelist: null, repository: null, reconfigurationStage: 'github',
      },
    };
    const retry = vi.fn(async () => completed);
    render(<LocalSetupWizard adapter={guidedAdapter({ status: vi.fn(async () => legacy), retry })} onBack={vi.fn()} onComplete={vi.fn()} />);

    expect(await screen.findByLabelText('Selected configuration')).toHaveTextContent('Demo mode (unsupported)');
    fireEvent.click(screen.getByRole('button', { name: 'Review saved choices' }));
    expect(await screen.findByRole('heading', { name: 'Connect GitHub' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /Demo/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Keep existing configuration' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    expect(screen.getByRole('alert')).toHaveTextContent('Select ProPR Connect');

    fireEvent.click(screen.getByRole('radio', { name: 'ProPR Connect' }));
    for (const heading of ['GitHub event intake', 'Select coding agents', 'Ready to install']) {
      fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
      await screen.findByRole('heading', { name: heading });
    }
    expect(screen.getByLabelText('Selected configuration')).toHaveTextContent('ProPR Connect');
    expect(screen.getByLabelText('Selected configuration')).toHaveTextContent('WebSocket');
    fireEvent.click(screen.getByRole('button', { name: /Install ProPR/i }));
    expect(retry).toHaveBeenCalledWith(expect.objectContaining({
      github: { mode: 'relay' }, intake: { mode: 'routing_websocket' },
    }));
  });

  it('shows and confirms corrected WebSocket intake for stale ProPR Connect recovery', async () => {
    const corrected: DesktopSetupSnapshot = {
      ...idle, phase: 'failed', error: 'ProPR Connect now requires WebSocket intake.',
      resumeAvailable: true, reconfigurationRequired: true,
      resume: {
        agents: ['codex'], reinitialize: false, github: { mode: 'relay' }, intake: { mode: 'routing_websocket' },
        whitelist: null, repository: null, reconfigurationStage: 'intake',
      },
    };
    const retry = vi.fn(async () => completed);
    render(<LocalSetupWizard adapter={guidedAdapter({ status: vi.fn(async () => corrected), retry })} onBack={vi.fn()} onComplete={vi.fn()} />);

    const saved = await screen.findByLabelText('Selected configuration');
    expect(saved).toHaveTextContent('ProPR Connect');
    expect(saved).toHaveTextContent('WebSocket');
    fireEvent.click(screen.getByRole('button', { name: 'Review saved choices' }));
    expect(await screen.findByText('ProPR Connect uses a persistent WebSocket connection for GitHub events.')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    for (const heading of ['Select coding agents', 'Ready to install']) {
      fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
      await screen.findByRole('heading', { name: heading });
    }
    fireEvent.click(screen.getByRole('button', { name: /Install ProPR/i }));
    expect(retry).toHaveBeenCalledWith(expect.objectContaining({ intake: { mode: 'routing_websocket' } }));
  });

  it.each(['failed', 'cancelled', 'interrupted'] as const)('lets a resumable %s setup revise ordinary saved choices', async phase => {
    const recoverable: DesktopSetupSnapshot = {
      ...idle, phase, error: 'ProPR Connect could not be configured.',
      resumeAvailable: true, reconfigurationRequired: false,
      resume: {
        agents: ['codex'], reinitialize: false, github: { mode: 'relay' },
        intake: { mode: 'routing_websocket' }, whitelist: ['octocat'], repository: null,
      },
    };
    const retry = vi.fn(async () => completed);
    const adapter = guidedAdapter({ status: vi.fn(async () => recoverable), retry });
    render(<LocalSetupWizard adapter={adapter} onBack={vi.fn()} onComplete={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Review saved choices' }));
    expect(await screen.findByRole('heading', { name: 'Connect GitHub' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Keep existing configuration' }));
    for (const heading of ['GitHub event intake', 'Select coding agents', 'Ready to install']) {
      fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
      await screen.findByRole('heading', { name: heading });
    }
    fireEvent.click(screen.getByRole('button', { name: /Install ProPR/i }));

    expect(await screen.findByRole('heading', { name: 'ProPR is ready' })).toBeInTheDocument();
    expect(retry).toHaveBeenCalledWith(expect.objectContaining({
      github: { mode: 'keep' }, intake: { mode: 'routing_websocket' },
    }));
  });

  it.each(['failed', 'cancelled'] as const)('returns a %s reconfigured retry to credential-free recovery', async phase => {
    const resume = {
      agents: ['codex'], reinitialize: false, github: { mode: 'keep' as const },
      intake: { mode: 'direct_webhook' as const, reconfigurationRequired: true as const },
      whitelist: null, repository: null, reconfigurationStage: 'intake' as const,
    };
    const requiresSecret: DesktopSetupSnapshot = {
      ...idle, phase: 'failed', error: 'Enter the webhook secret again.', resume,
      resumeAvailable: true, reconfigurationRequired: true,
    };
    const terminal: DesktopSetupSnapshot = {
      ...requiresSecret, phase, error: phase === 'cancelled' ? 'Setup was cancelled safely.' : 'Webhook setup failed.',
      reconfigurationRequired: false,
    };
    const retry = vi.fn()
      .mockResolvedValueOnce(terminal)
      .mockResolvedValueOnce(completed);
    const adapter = guidedAdapter({
      status: vi.fn(async () => requiresSecret), retry,
      acquireWebhookSecret: vi.fn(async () => ({ capability: 'webhook-secret-capability', label: 'Secret entered' as const })),
    });
    render(<LocalSetupWizard adapter={adapter} onBack={vi.fn()} onComplete={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Review saved choices' }));
    expect(await screen.findByRole('heading', { name: 'GitHub event intake' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Enter webhook secret securely' }));
    await screen.findByText('Secret entered');
    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    await screen.findByRole('heading', { name: 'Select coding agents' });
    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    await screen.findByRole('heading', { name: 'Ready to install' });
    fireEvent.click(screen.getByRole('button', { name: /Install ProPR/i }));

    expect(await screen.findByRole('heading', { name: 'Setup needs attention' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry setup' }));
    expect(await screen.findByRole('heading', { name: 'ProPR is ready' })).toBeInTheDocument();
    expect(retry).toHaveBeenNthCalledWith(1, expect.objectContaining({
      intake: { mode: 'direct_webhook', secretCapability: 'webhook-secret-capability' },
    }));
    expect(retry).toHaveBeenNthCalledWith(2);
  });
});
