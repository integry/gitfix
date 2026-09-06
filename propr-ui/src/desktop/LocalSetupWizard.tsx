import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Check, ChevronRight, CircleAlert, KeyRound, LoaderCircle, RotateCcw, X } from 'lucide-react';
import type {
  DesktopFilesystemSelection, DesktopSecretSelection, DesktopSetupRequest, DesktopSetupSnapshot,
} from '../../../apps/desktop/src/shared/contract';
import type { DesktopGuidedLocalSetupAdapter, DesktopProfile } from './types';

type Stage = 'prerequisites' | 'directory' | 'github' | 'intake' | 'agents' | 'summary';
type GithubMode = DesktopSetupRequest['github']['mode'];
type IntakeMode = DesktopSetupRequest['intake']['mode'];
const stages: Stage[] = ['prerequisites', 'directory', 'github', 'intake', 'agents', 'summary'];
const agents = ['codex', 'claude', 'antigravity', 'opencode', 'vibe'];

interface Draft {
  githubMode: GithubMode; appId: string; installationId: string; privateKey: DesktopFilesystemSelection | null;
  intakeMode: IntakeMode; webhookSecret: DesktopSecretSelection | null; selectedAgents: string[];
  whitelist: string; reinitialize: boolean;
}

const requestFrom = (sessionId: string, draft: Draft): DesktopSetupRequest => ({
  sessionId, root: { mode: 'default' }, reinitialize: draft.reinitialize, agents: draft.selectedAgents,
  github: draft.githubMode === 'app' ? { mode: 'app', appId: draft.appId, installationId: draft.installationId,
    privateKeyCapability: draft.privateKey?.capability ?? '' } : { mode: draft.githubMode },
  intake: draft.intakeMode === 'direct_webhook' ? { mode: 'direct_webhook', secretCapability: draft.webhookSecret?.capability ?? '' }
    : { mode: draft.intakeMode },
  whitelist: draft.whitelist.trim()
    ? draft.whitelist.split(',').map(value => value.trim()).filter(Boolean)
    : null,
  repository: null,
});

const InlineError: React.FC<{ message: string | null }> = ({ message }) => message
  ? <div className="desktop-inline-error" role="alert">{message}</div>
  : null;

const Running: React.FC<{ snapshot: DesktopSetupSnapshot; busy: boolean; error: string | null; back(): void; cancel(): void }> = ({ snapshot, busy, error, back, cancel }) => {
  const complete = snapshot.state?.steps.filter(step => ['done', 'skipped', 'warning'].includes(step.status)).length ?? 0;
  const total = snapshot.state?.steps.length ?? 1;
  return <main className="desktop-setup-wizard" aria-live="polite">
    <span className="desktop-eyebrow">Installing locally</span><h1>Setting up ProPR</h1>
    <div className="desktop-setup-progress"><span style={{ width: `${Math.round(complete / total * 100)}%` }} /></div>
    <div className="desktop-setup-step-list">{snapshot.state?.steps.map(step => <div key={step.id} data-status={step.status}>
      <span>{step.status === 'active' ? <LoaderCircle className="desktop-spin" /> : step.status === 'done' ? <Check /> : step.status === 'failed' ? <X /> : null}</span>
      <div><strong>{step.title}</strong><small>{step.detail || step.description}</small></div>
    </div>)}</div>
    {snapshot.logs.length > 0 && <pre className="desktop-setup-log">{snapshot.logs.slice(-8).join('\n')}</pre>}
    <InlineError message={error} />
    <div className="desktop-setup-footer">{error && <button type="button" className="desktop-secondary-button" onClick={back}>Back</button>}
      <button type="button" className="desktop-secondary-button" disabled={busy} onClick={cancel}>{busy ? 'Cancelling…' : error ? 'Try cancellation again' : 'Cancel safely'}</button></div>
  </main>;
};

const Recovery: React.FC<{ snapshot: DesktopSetupSnapshot; busy: boolean; error: string | null; back(): void; retry(): void; review(): void }> = ({ snapshot, busy, error, back, retry, review }) => {
  const failed = snapshot.state?.steps.find(step => step.status === 'failed');
  return <main className="desktop-setup-wizard"><CircleAlert className="desktop-setup-hero-icon desktop-setup-error-icon" />
    <span className="desktop-eyebrow">Recovery</span><h1>{snapshot.phase === 'interrupted' ? 'Continue your setup' : 'Setup needs attention'}</h1>
    <p>{failed?.detail || snapshot.error || snapshot.errors?.[0]?.message || 'Setup stopped safely.'}</p>
    {(failed?.nextAction || snapshot.errors?.[0]?.nextAction) && <div className="desktop-setup-recovery">{failed?.nextAction || snapshot.errors?.[0]?.nextAction}</div>}
    <InlineError message={error} />
    <div className="desktop-setup-footer"><button className="desktop-secondary-button" type="button" onClick={back}>Back</button>
      {snapshot.reconfigurationRequired && <button className="desktop-secondary-button" type="button" disabled={busy} onClick={review}>Review saved choices</button>}
      <button className="desktop-primary-button" type="button" disabled={busy} onClick={retry}><RotateCcw /> {busy ? 'Waiting…' : 'Retry setup'}</button></div>
  </main>;
};

const Form: React.FC<{ stage: Stage; draft: Draft; busy: boolean; error: string | null; back(): void; next(): void;
  setDraft: React.Dispatch<React.SetStateAction<Draft>>; chooseKey(): void; acquireSecret(): void }> = props => {
  const { stage, draft, setDraft } = props;
  const index = stages.indexOf(stage);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(current => ({ ...current, [key]: value }));
  return <main className="desktop-setup-wizard"><button type="button" className="desktop-back-button" onClick={props.back}><ArrowLeft /> Back</button>
    <span className="desktop-eyebrow">Local setup · {index + 1} of {stages.length}</span>
    {stage === 'prerequisites' && <><h1>Check the essentials</h1><p>ProPR needs Linux and a running Docker Engine. Setup checks Docker before changing the local stack and reports anything you need to fix.</p></>}
    {stage === 'directory' && <><h1>Private local storage</h1><p>Environment, data, logs, and repositories stay in a fixed owner-only directory managed by ProPR Desktop.</p><div className="desktop-setup-note">Desktop-managed local runtime</div></>}
    {stage === 'github' && <><h1>Connect GitHub</h1><p>Secrets stay in the trusted desktop process and are never returned to this page.</p>
      <div className="desktop-setup-options">{(['relay', 'app', 'demo', 'keep'] as GithubMode[]).map(mode => <label key={mode}><input type="radio" checked={draft.githubMode === mode} onChange={() => {
        set('githubMode', mode); if (mode === 'relay' && draft.intakeMode === 'direct_webhook') set('intakeMode', 'routing_websocket');
        if (mode === 'app' && draft.intakeMode === 'routing_websocket') set('intakeMode', 'polling'); if (mode === 'demo') set('intakeMode', 'keep');
      }} /><span><strong>{mode === 'relay' ? 'ProPR Connect' : mode === 'app' ? 'Custom GitHub App' : mode === 'demo' ? 'Demo mode' : 'Keep existing configuration'}</strong></span></label>)}</div>
      {draft.githubMode === 'app' && <div className="desktop-setup-grid"><label>App ID<input value={draft.appId} onChange={event => set('appId', event.target.value)} /></label>
        <label>Installation ID<input value={draft.installationId} onChange={event => set('installationId', event.target.value)} /></label>
        <div className="desktop-setup-wide"><button type="button" className="desktop-secondary-button" onClick={props.chooseKey}><KeyRound /> Choose private key</button><small>{draft.privateKey?.label ?? ' No key selected'}</small></div></div>}</>}
    {stage === 'intake' && <><h1>Choose GitHub event intake</h1><div className="desktop-setup-options">
      {(draft.githubMode === 'relay' ? ['keep', 'routing_websocket', 'polling'] : draft.githubMode === 'app' ? ['keep', 'polling', 'direct_webhook'] : draft.githubMode === 'demo' ? ['keep'] : ['keep', 'routing_websocket', 'polling', 'direct_webhook']).map(mode =>
        <label key={mode}><input type="radio" checked={draft.intakeMode === mode} onChange={() => set('intakeMode', mode as IntakeMode)} /><span><strong>{mode.replace(/_/g, ' ')}</strong></span></label>)}</div>
      {draft.intakeMode === 'direct_webhook' && <div className="desktop-setup-wide"><button type="button" className="desktop-secondary-button" onClick={props.acquireSecret}><KeyRound /> Enter webhook secret securely</button><small>{draft.webhookSecret?.label ?? ' No secret entered'}</small></div>}</>}
    {stage === 'agents' && <><h1>Select coding agents</h1><div className="desktop-agent-options">{agents.map(agent => <label key={agent}><input type="checkbox" checked={draft.selectedAgents.includes(agent)} onChange={() => set('selectedAgents', draft.selectedAgents.includes(agent) ? draft.selectedAgents.filter(value => value !== agent) : [...draft.selectedAgents, agent])} /><span>{agent}</span></label>)}</div>
      {draft.githubMode !== 'demo' && <label className="desktop-setup-field"><span>Allowed GitHub users (comma-separated, optional)</span><div><input value={draft.whitelist} onChange={event => set('whitelist', event.target.value)} /></div></label>}</>}
    {stage === 'summary' && <><h1>Ready to install</h1><dl className="desktop-setup-summary"><div><dt>Directory</dt><dd>Desktop-managed local runtime</dd></div><div><dt>GitHub</dt><dd>{draft.githubMode}</dd></div><div><dt>Intake</dt><dd>{draft.intakeMode}</dd></div><div><dt>Agents</dt><dd>{draft.selectedAgents.join(', ') || 'None'}</dd></div></dl></>}
    {props.error && <div className="desktop-inline-error" role="alert">{props.error}</div>}
    <div className="desktop-setup-footer"><button type="button" className="desktop-primary-button" disabled={props.busy} onClick={props.next}>{stage === 'summary' ? 'Install ProPR' : 'Continue'} <ChevronRight /></button></div>
  </main>;
};

export const LocalSetupWizard: React.FC<{ adapter: DesktopGuidedLocalSetupAdapter; onBack(): void; onComplete(profile: DesktopProfile): void }> = ({ adapter, onBack, onComplete }) => {
  const [stage, setStage] = useState<Stage>('prerequisites');
  const [snapshot, setSnapshot] = useState<DesktopSetupSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusAttempt, setStatusAttempt] = useState(0);
  const [reconfiguring, setReconfiguring] = useState(false);
  const [draft, setDraft] = useState<Draft>({ githubMode: 'relay', appId: '', installationId: '', privateKey: null,
    intakeMode: 'routing_websocket', webhookSecret: null, selectedAgents: ['codex'], whitelist: '', reinitialize: false });

  useEffect(() => {
    let mounted = true; const unsubscribe = adapter.onProgress(value => { if (mounted) setSnapshot(value); });
    void adapter.status().then(value => { if (!mounted) return; setSnapshot(value); if (value.resume) setDraft(current => ({ ...current,
      githubMode: value.resume!.github.mode, appId: value.resume!.github.mode === 'app' ? value.resume!.github.appId : '',
      installationId: value.resume!.github.mode === 'app' ? value.resume!.github.installationId : '', intakeMode: value.resume!.intake.mode,
      selectedAgents: value.resume!.agents, whitelist: value.resume!.whitelist?.join(', ') ?? '', reinitialize: value.resume!.reinitialize })); })
      .catch(() => { if (mounted) setError('Setup status is unavailable.'); });
    return () => { mounted = false; unsubscribe(); };
  }, [adapter, statusAttempt]);
  const request = useMemo(() => snapshot ? requestFrom(snapshot.sessionId, draft) : null, [draft, snapshot]);
  const run = async (retry: boolean, review = false) => {
    if (!request) return;
    if (review && snapshot?.reconfigurationRequired && !reconfiguring) {
      setStage(snapshot.resume?.reconfigurationStage ?? 'github'); setReconfiguring(true); return;
    }
    setBusy(true); setError(null);
    try {
      const nextSnapshot = retry ? reconfiguring ? await adapter.retry(request) : await adapter.retry() : await adapter.start(request);
      setSnapshot(nextSnapshot);
      if (retry && reconfiguring && ['failed', 'cancelled'].includes(nextSnapshot.phase)) setReconfiguring(false);
    }
    catch { setError('Local setup could not be started. Check the selected values and try again.'); }
    finally { setBusy(false); }
  };
  const chooseKey = async () => { setBusy(true); try { const value = await adapter.selectPrivateKey(); if (value) setDraft(current => ({ ...current, privateKey: value })); } catch { setError('Choose a regular owner-only private-key file.'); } finally { setBusy(false); } };
  const acquireSecret = async () => { setBusy(true); try { const value = await adapter.acquireWebhookSecret(); if (value) setDraft(current => ({ ...current, webhookSecret: value })); } catch { setError('Install zenity or kdialog to enter the secret securely.'); } finally { setBusy(false); } };
  const cancel = async () => {
    setCancelling(true); setError(null);
    try { setSnapshot(await adapter.cancel()); }
    catch { setError('Setup cancellation could not be confirmed. Try again or go back and reopen setup.'); }
    finally { setCancelling(false); }
  };
  if (!snapshot && error) return <main className="desktop-setup-wizard"><CircleAlert className="desktop-setup-hero-icon desktop-setup-error-icon" />
    <span className="desktop-eyebrow">Setup unavailable</span><h1>Could not load setup</h1><div className="desktop-inline-error" role="alert">{error}</div>
    <div className="desktop-setup-footer"><button type="button" className="desktop-secondary-button" onClick={onBack}>Back</button>
      <button type="button" className="desktop-primary-button" onClick={() => { setError(null); setStatusAttempt(value => value + 1); }}><RotateCcw /> Retry</button></div></main>;
  if (!snapshot) return <div className="desktop-loading"><LoaderCircle className="desktop-spin" /> Loading setup…</div>;
  if (snapshot.phase === 'unsupported') return <main className="desktop-setup-wizard"><CircleAlert className="desktop-setup-hero-icon" /><h1>Local setup is unavailable</h1><p>{snapshot.error}</p><button className="desktop-primary-button" onClick={onBack}>Back to instances</button></main>;
  if (snapshot.phase === 'running') return <Running snapshot={snapshot} busy={cancelling} error={error} back={onBack} cancel={() => void cancel()} />;
  if (['failed', 'cancelled', 'interrupted'].includes(snapshot.phase) && !reconfiguring) return <Recovery snapshot={snapshot} busy={busy} error={error} back={onBack} retry={() => void run(true)} review={() => void run(true, true)} />;
  if (snapshot.phase === 'completed' && snapshot.profile) return <main className="desktop-setup-wizard"><div className="desktop-setup-success"><Check /></div><span className="desktop-eyebrow">Setup complete</span><h1>ProPR is ready</h1><p>The local stack is healthy. Continue through the normal identity and pairing checks to open it.</p><div className="desktop-setup-footer"><button className="desktop-primary-button" onClick={() => onComplete(snapshot.profile!)}>Connect securely</button></div></main>;
  const index = stages.indexOf(stage);
  const next = () => { setError(null); if (stage === 'github' && draft.githubMode === 'app' && (!/^\d{1,20}$/.test(draft.appId) || !/^\d{1,20}$/.test(draft.installationId) || !draft.privateKey)) return setError('Enter numeric App and installation IDs, then choose the private key.');
    if (stage === 'intake' && draft.intakeMode === 'direct_webhook' && !draft.webhookSecret) return setError('Enter the webhook secret securely.');
    if (index === stages.length - 1) void run(reconfiguring); else setStage(stages[index + 1]); };
  return <Form stage={stage} draft={draft} setDraft={setDraft} busy={busy} error={error} chooseKey={() => void chooseKey()} acquireSecret={() => void acquireSecret()} next={next} back={index ? () => setStage(stages[index - 1]) : onBack} />;
};
