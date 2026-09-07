import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { voiceBriefingResponseSchema, type VoiceBriefingResponse } from '@propr/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useVoiceBriefing,
  type PendingVoiceBriefingAction,
  type VoiceBriefingController,
} from '../hooks/useVoiceBriefing';
import VoiceBriefingControl, {
  VOICE_RECOGNITION_DISCLOSURE_STORAGE_KEY,
} from './VoiceBriefingControl';

vi.mock('../hooks/useVoiceBriefing', () => ({
  useVoiceBriefing: vi.fn(),
}));

const briefing: VoiceBriefingResponse = voiceBriefingResponseSchema.parse({
  generatedAt: '2026-09-07T09:35:00.000Z',
  scope: 'all',
  headline: 'One task needs attention',
  speechText: 'One task needs attention. Task 1: Review the failed checks.',
  counts: { running: 1, queued: 0, attention: 1, plans: 0, total: 1 },
  items: [{
    reference: 'task 1',
    position: 1,
    kind: 'task',
    id: 'task-1',
    title: 'Fix voice briefing accessibility',
    repository: 'integry/propr',
    status: 'attention',
    summary: 'Review the failed checks.',
    href: '/tasks/task-1',
    requiresAttention: true,
    actions: ['open', 'stop', 'follow_up'],
    updatedAt: '2026-09-07T09:30:00.000Z',
  }],
});

function controller(
  overrides: Partial<VoiceBriefingController> = {},
): VoiceBriefingController {
  return {
    phase: 'idle',
    briefing: null,
    pendingAction: null,
    transcript: null,
    error: null,
    capabilities: { speechSynthesis: true, speechRecognition: true },
    requestBriefing: vi.fn().mockResolvedValue(undefined),
    repeatBriefing: vi.fn().mockResolvedValue(undefined),
    startListening: vi.fn().mockResolvedValue(undefined),
    handleTranscript: vi.fn().mockResolvedValue(undefined),
    confirmPendingAction: vi.fn().mockResolvedValue(undefined),
    cancelPendingAction: vi.fn(),
    stopAudio: vi.fn(),
    clearError: vi.fn(),
    ...overrides,
  };
}

function renderControl(value: VoiceBriefingController) {
  vi.mocked(useVoiceBriefing).mockReturnValue(value);
  return render(
    <MemoryRouter>
      <VoiceBriefingControl />
    </MemoryRouter>,
  );
}

describe('VoiceBriefingControl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it('shows disclosure on first open without starting recognition', () => {
    const value = controller();
    renderControl(value);

    fireEvent.click(screen.getByRole('button', { name: 'Voice briefing' }));

    expect(screen.getByRole('dialog', { name: 'Voice briefing' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Before you use voice recognition' })).toBeInTheDocument();
    expect(value.startListening).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'I understand' }));
    expect(window.localStorage.getItem(VOICE_RECOGNITION_DISCLOSURE_STORAGE_KEY))
      .toBe('acknowledged');
    expect(value.startListening).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Listen' }));
    expect(value.startListening).toHaveBeenCalledOnce();
  });

  it('keeps a structured briefing usable when browser speech is unavailable', () => {
    renderControl(controller({
      briefing,
      capabilities: { speechSynthesis: false, speechRecognition: false },
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Voice briefing' }));

    expect(screen.getByRole('button', { name: 'Listen' })).toBeDisabled();
    expect(screen.getByText(/Voice commands aren’t supported/)).toBeInTheDocument();
    expect(screen.getByText(/Spoken playback isn’t supported/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: briefing.headline })).toBeInTheDocument();
    const items = screen.getByRole('list', { name: 'Briefing items' });
    expect(within(items).getByRole('link', { name: briefing.items[0].title })).toBeInTheDocument();
  });

  it('shows exact mutation details with visible confirmation controls', () => {
    const pendingAction: PendingVoiceBriefingAction = {
      type: 'pending_action',
      action: 'follow_up',
      item: briefing.items[0],
      instruction: 'Rerun the keyboard accessibility checks exactly once.',
      requiresConfirmation: true,
    };
    const value = controller({ briefing, pendingAction, phase: 'confirming' });
    renderControl(value);
    fireEvent.click(screen.getByRole('button', { name: 'Voice briefing' }));

    const confirmation = screen.getByRole('region', { name: 'Confirm follow-up' });
    expect(confirmation).toHaveTextContent('Fix voice briefing accessibility');
    expect(confirmation).toHaveTextContent('Rerun the keyboard accessibility checks exactly once.');
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Confirm' }));
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Cancel' }));
    expect(value.confirmPendingAction).toHaveBeenCalledOnce();
    expect(value.cancelPendingAction).toHaveBeenCalledOnce();
  });

  it('stops audio and restores launcher focus when Escape closes the panel', () => {
    const value = controller({ phase: 'speaking', briefing });
    renderControl(value);
    const launcher = screen.getByRole('button', { name: 'Voice briefing' });
    fireEvent.click(launcher);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(value.stopAudio).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog', { name: 'Voice briefing' })).not.toBeInTheDocument();
    expect(launcher).toHaveFocus();
  });
});
