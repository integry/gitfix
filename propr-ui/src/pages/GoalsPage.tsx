/* eslint-disable max-lines -- goal list and split-pane console intentionally share this route-level surface */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Activity, CheckCircle2, Circle, CircleDot, CirclePause, CirclePlay, CircleStop, Clock3,
  Coins, ExternalLink, FileText, GitPullRequest, Github, ListTodo, LoaderCircle, Plus, Send,
  MoreHorizontal, Terminal, Trash2,
} from 'lucide-react';
import { getInstanceCatalog } from '../api/proprApi';
import type { InstanceCatalogRepository } from '../api/proprTypes';
import {
  cancelGoal, createGoal, deleteGoal, getGoal, getGoalCapabilities, listGoals, pauseGoal,
  requestGoalModel, resumeGoal, sendGoalInput,
  getGoalAttachmentUrl,
  type Goal, type GoalCapability, type GoalLaunchStrategy,
} from '../api/goals';
import { useTaskLiveData } from '../components/TaskDetails/useTaskLiveData';
import TodoList from '../components/TaskDetails/TodoList';
import ExecutionEventLog from '../components/TaskDetails/ExecutionEventLog';
import ThinkingLog from '../components/TaskDetails/ThinkingLog';
import { useThinkingLog } from '../components/TaskDetails/useThinkingLog';
import { RepositorySelector, type RepoOption } from '../components/RepositorySelector';
import { ProviderLogo } from '../components/ui/ProviderLogo';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { formatAgentLabel } from '../utils/agentStatus';
import { getModelDisplayName } from '../utils/modelDisplay';
import { GoalAttachmentInput } from '../components/Goals/GoalAttachmentInput';
import { clipboardImageFiles } from '../components/Goals/goalAttachmentUtils';
import { resizeImage } from '../components/TaskPlanner/imageUtils';

const buttonClass = 'inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50';
const checkpointIntervalOptions = [5, 10, 15, 30, 60, 120];
const goalFormSettingsStorageKey = 'propr.goalFormSettings';
const maxGoalAttachmentsPerPrompt = 10;

async function addGoalFiles(
  current: File[],
  incoming: File[],
  setFiles: React.Dispatch<React.SetStateAction<File[]>>,
  setError: React.Dispatch<React.SetStateAction<string | null>>,
) {
  if (current.length + incoming.length > maxGoalAttachmentsPerPrompt) {
    setError(`Attach up to ${maxGoalAttachmentsPerPrompt} files to each prompt.`);
    return;
  }
  setFiles([...current, ...await Promise.all(incoming.map(resizeImage))]);
}

interface GoalFormSettings {
  repository: string;
  agentId: string;
  model: string;
  launchStrategy: GoalLaunchStrategy;
  maxParallelTasks: number | null;
  ultrafix: boolean;
  checkpointIntervalMinutes: number;
}

const defaultGoalFormSettings: GoalFormSettings = {
  repository: '',
  agentId: '',
  model: '',
  launchStrategy: 'direct',
  maxParallelTasks: null,
  ultrafix: false,
  checkpointIntervalMinutes: 15,
};

const readGoalFormSettings = (): GoalFormSettings => {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(goalFormSettingsStorageKey) || 'null');
    if (!parsed || typeof parsed !== 'object') return defaultGoalFormSettings;
    const stored = parsed as Record<string, unknown>;
    return {
      repository: typeof stored.repository === 'string' ? stored.repository : '',
      agentId: typeof stored.agentId === 'string' ? stored.agentId : '',
      model: typeof stored.model === 'string' ? stored.model : '',
      launchStrategy: stored.launchStrategy === 'orchestrate' ? 'orchestrate' : 'direct',
      maxParallelTasks: typeof stored.maxParallelTasks === 'number'
        && Number.isInteger(stored.maxParallelTasks)
        && stored.maxParallelTasks >= 1
        && stored.maxParallelTasks <= 32
        ? stored.maxParallelTasks
        : null,
      ultrafix: typeof stored.ultrafix === 'boolean' ? stored.ultrafix : false,
      checkpointIntervalMinutes: typeof stored.checkpointIntervalMinutes === 'number'
        && checkpointIntervalOptions.includes(stored.checkpointIntervalMinutes)
        ? stored.checkpointIntervalMinutes
        : 15,
    };
  } catch {
    return defaultGoalFormSettings;
  }
};

const saveGoalFormSettings = (settings: GoalFormSettings) => {
  try {
    window.localStorage.setItem(goalFormSettingsStorageKey, JSON.stringify(settings));
  } catch {
    // The form should remain usable when browser storage is unavailable.
  }
};

const duration = (milliseconds: number) => {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours ? `${hours}h ${minutes}m` : minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
};
const tokenTotal = (usage: { input_tokens?: number | null; output_tokens?: number | null; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null } | null) => usage
  ? (usage.input_tokens || 0) + (usage.output_tokens || 0)
    + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0)
  : 0;

const capabilityAgentLabel = (agent: GoalCapability, agents: GoalCapability[]) => formatAgentLabel(
  { type: agent.agentType, alias: agent.agentAlias },
  agents.map(candidate => ({ type: candidate.agentType, alias: candidate.agentAlias })),
);

function GoalState({ goal }: { goal: Goal }) {
  const state = goal.resultState || (goal.desiredState === 'cancelled' ? 'cancelling' : goal.desiredState);
  const color = state === 'completed' ? 'bg-green-100 text-green-800' : state === 'failed' || state === 'cancelled' ? 'bg-red-100 text-red-800' : state === 'paused' || state === 'cancelling' ? 'bg-amber-100 text-amber-800' : 'bg-blue-100 text-blue-800';
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold capitalize ${color}`}>
    {state === 'running' && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}
    {state}
  </span>;
}

function CheckpointDeclaration({ checkpoint }: { checkpoint: NonNullable<Goal['checkpoint']> }) {
  const latest = checkpoint.latest;
  if (!latest || latest.kind !== 'agent') return null;
  const badgeClass = latest.state === 'completed'
    ? 'bg-green-100 text-green-800'
    : latest.state === 'rejected' || latest.state === 'failed'
      ? 'bg-red-100 text-red-800'
      : 'bg-amber-100 text-amber-800';
  const paths = (label: string, values: string[] | null) => values && <div>
    <dt className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{label}</dt>
    <dd className="mt-1 flex flex-wrap gap-1.5">{values.map(value => <code key={value} className="rounded border border-slate-200 bg-white px-1.5 py-0.5 font-mono text-[12px] text-slate-700">{value}</code>)}</dd>
  </div>;
  return <section aria-label="Latest checkpoint declaration" className="mt-3 border-t border-blue-200 pt-3 text-slate-800">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="font-semibold">Latest checkpoint declaration</h2>
      <span className={`rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${badgeClass}`}>{latest.state}</span>
    </div>
    <dl className="mt-3 grid gap-3 sm:grid-cols-2">
      <div><dt className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Commit message</dt><dd className="mt-1 break-words font-medium">{latest.message || 'Not provided'}</dd></div>
      {latest.summary && <div><dt className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Summary</dt><dd className="mt-1 break-words">{latest.summary}</dd></div>}
      {paths('Included paths', latest.include)}
      {paths('Excluded paths', latest.exclude)}
    </dl>
    {latest.commitSha && <p className="mt-3 text-xs text-slate-500">Published commit <code className="font-mono text-slate-700">{latest.commitSha}</code></p>}
    {latest.error && <p className="mt-3 rounded bg-red-50 p-2 text-sm text-red-700">{latest.error}</p>}
  </section>;
}

function CreateGoalForm({ onCreated }: { onCreated: (goal: Goal) => void }) {
  const previousSettings = useMemo(readGoalFormSettings, []);
  const [repositories, setRepositories] = useState<InstanceCatalogRepository[]>([]);
  const [agents, setAgents] = useState<GoalCapability[]>([]);
  const [repository, setRepository] = useState(previousSettings.repository);
  const [agentId, setAgentId] = useState(previousSettings.agentId);
  const [model, setModel] = useState(previousSettings.model);
  const [objective, setObjective] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [launchStrategy, setLaunchStrategy] = useState<GoalLaunchStrategy>(previousSettings.launchStrategy);
  const [parallelism, setParallelism] = useState(previousSettings.maxParallelTasks?.toString() || '');
  const [ultrafix, setUltrafix] = useState(previousSettings.ultrafix);
  const [checkpointInterval, setCheckpointInterval] = useState(previousSettings.checkpointIntervalMinutes);
  const [submitting, setSubmitting] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedAgent = agents.find(agent => agent.agentId === agentId);
  const unsupportedAgents = agents.filter(agent => !agent.goalCapable);
  const showRuntimeDiagnostics = agents.length > 0 && unsupportedAgents.length === agents.length;
  const repositoryOptions = useMemo<RepoOption[]>(() => repositories.map(repo => ({
    name: repo.name,
    enabled: repo.enabled,
    ...(repo.alias ? { displayName: repo.alias } : {}),
    ...(repo.baseBranch ? { baseBranch: repo.baseBranch } : {}),
  })), [repositories]);

  const applyCapabilities = useCallback((capabilities: GoalCapability[]) => {
    setAgents(capabilities);
    setAgentId(current => capabilities.some(agent => agent.agentId === current && agent.goalCapable)
      ? current
      : capabilities.find(agent => agent.goalCapable)?.agentId || '');
  }, []);

  useEffect(() => {
    Promise.all([getInstanceCatalog(), getGoalCapabilities()]).then(([catalog, capabilityData]) => {
      setRepositories(catalog.repositories);
      applyCapabilities(capabilityData.agents);
      setRepository(current => catalog.repositories.some(repo => repo.name === current)
        ? current
        : catalog.repositories[0]?.name || '');
    }).catch(err => setError((err as Error).message));
  }, [applyCapabilities]);

  useEffect(() => {
    if (selectedAgent && !selectedAgent.models.includes(model)) setModel(selectedAgent.defaultModel || selectedAgent.models[0] || '');
  }, [model, selectedAgent]);

  const recheckCapabilities = async () => {
    setRechecking(true);
    setError(null);
    try {
      applyCapabilities((await getGoalCapabilities(true)).agents);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRechecking(false);
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const createBody = {
        repository, agentId, model, objective, launchStrategy,
        ...(parallelism ? { maxParallelTasks: Number(parallelism) } : {}),
        ...(launchStrategy === 'direct' ? { checkpointIntervalMinutes: checkpointInterval } : {}),
        ultrafix,
      };
      const result = files.length > 0 ? await createGoal(createBody, files) : await createGoal(createBody);
      saveGoalFormSettings({
        repository,
        agentId,
        model,
        launchStrategy,
        maxParallelTasks: parallelism ? Number(parallelism) : null,
        ultrafix,
        checkpointIntervalMinutes: checkpointInterval,
      });
      onCreated(result.goal);
    } catch (err) { setError((err as Error).message); }
    finally { setSubmitting(false); }
  };

  return (
    <form onSubmit={submit} className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold"><Plus className="h-5 w-5" /> Start a goal</h2>
      {error && <p role="alert" className="mb-3 text-sm text-red-600">{error}</p>}
      {showRuntimeDiagnostics && <div className="mb-3 rounded bg-amber-50 p-3 text-sm text-amber-800">
        <p>No configured coding-agent runtime currently supports goals.</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          {unsupportedAgents.map(agent => <li key={agent.agentId}><span className="font-medium">{agent.agentAlias}:</span> {agent.reason || 'Required goal/session transport is unavailable'}</li>)}
        </ul>
        <button type="button" disabled={rechecking} onClick={recheckCapabilities} className="mt-2 font-medium underline disabled:opacity-50">{rechecking ? 'Rechecking…' : 'Recheck runtimes'}</button>
      </div>}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="text-sm font-medium text-slate-700">Repository
          <RepositorySelector repos={repositoryOptions} selectedRepo={repository} onRepoChange={setRepository} className="mt-1" />
        </div>
        <label className="text-sm font-medium text-slate-700">Coding agent
          <select aria-label="Coding agent" value={agentId} onChange={event => setAgentId(event.target.value)} className="mt-1 w-full rounded-md border border-slate-300 p-2" required>
            {agents.map(agent => <option key={agent.agentId} value={agent.agentId} disabled={!agent.goalCapable}>{capabilityAgentLabel(agent, agents)}{agent.goalCapable ? '' : ' — unsupported'}</option>)}
          </select>
        </label>
        <label className="text-sm font-medium text-slate-700">Model
          <select aria-label="Model" value={model} onChange={event => setModel(event.target.value)} className="mt-1 w-full rounded-md border border-slate-300 p-2" required>
            {(selectedAgent?.models || []).map(item => <option key={item} value={item}>{getModelDisplayName(item)}</option>)}
          </select>
        </label>
        <label className="text-sm font-medium text-slate-700">Maximum parallel tasks (optional)
          <input aria-label="Maximum parallel tasks" type="number" min="1" max="32" value={parallelism} onChange={event => setParallelism(event.target.value)} className="mt-1 w-full rounded-md border border-slate-300 p-2" />
        </label>
      </div>
      <fieldset className="mt-4">
        <legend className="text-sm font-medium text-slate-700">Goal launch strategy</legend>
        <div className="mt-2 grid gap-3 md:grid-cols-2">
          <label className="flex cursor-pointer gap-3 rounded-md border border-slate-200 p-3 text-sm text-slate-700"><input aria-label="Agent implements directly" type="radio" name="launch-strategy" value="direct" checked={launchStrategy === 'direct'} onChange={() => setLaunchStrategy('direct')} /><span><strong className="block text-slate-900">Agent implements directly</strong>ProPR opens the draft PR before work begins and safely commits the agent's changes at checkpoints.</span></label>
          <label className="flex cursor-pointer gap-3 rounded-md border border-slate-200 p-3 text-sm text-slate-700"><input aria-label="Agent orchestrates through ProPR" type="radio" name="launch-strategy" value="orchestrate" checked={launchStrategy === 'orchestrate'} onChange={() => setLaunchStrategy('orchestrate')} /><span><strong className="block text-slate-900">Agent orchestrates through ProPR</strong>The agent owns decomposition, creates issues, and starts and monitors their implementation through ProPR.</span></label>
        </div>
      </fieldset>
      {launchStrategy === 'direct' && <div className="mt-4 max-w-xl">
        <div className="flex items-center justify-between gap-3">
          <label htmlFor="checkpoint-frequency" className="text-sm font-medium text-slate-700">Checkpoint target cadence</label>
          <output htmlFor="checkpoint-frequency" className="rounded-full bg-primary-500/10 px-2.5 py-1 text-xs font-semibold text-primary-700">{checkpointInterval} minutes</output>
        </div>
        <input
          id="checkpoint-frequency"
          aria-label="Checkpoint target cadence"
          aria-valuetext={`${checkpointInterval} minutes`}
          type="range"
          min="0"
          max={checkpointIntervalOptions.length - 1}
          step="1"
          value={checkpointIntervalOptions.indexOf(checkpointInterval)}
          onChange={event => setCheckpointInterval(checkpointIntervalOptions[Number(event.target.value)])}
          className="mt-3 h-2 w-full cursor-pointer accent-primary-600"
        />
        <div aria-label="Checkpoint target cadence options" className="mt-1 flex justify-between text-xs text-slate-500">
          {checkpointIntervalOptions.map(minutes => <span key={minutes}>{minutes}</span>)}
        </div>
        <p className="mt-2 text-xs text-slate-500">Guidance for the agent, not a timer. ProPR commits only when the agent declares a coherent checkpoint ready.</p>
      </div>}
      <div className="mt-4 text-sm font-medium text-slate-700">Objective
        <textarea aria-label="Objective" value={objective} onChange={event => setObjective(event.target.value)} onPaste={event => {
          const pasted = clipboardImageFiles(event);
          if (!pasted.length) return;
          event.preventDefault();
          void addGoalFiles(files, pasted, setFiles, setError);
        }} rows={5} className="mt-1 w-full rounded-md border border-slate-300 p-2" required />
        <GoalAttachmentInput files={files} onChange={setFiles} onError={setError} disabled={submitting} />
      </div>
      <label className="mt-3 flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={ultrafix} onChange={event => setUltrafix(event.target.checked)} /> Ask the coding agent to use Ultrafix</label>
      <button type="submit" disabled={submitting || !repository || !agentId || !model || !objective.trim() || !selectedAgent?.goalCapable} className={`${buttonClass} mt-4 bg-primary-600 text-white hover:bg-primary-700`}>{submitting ? 'Starting…' : 'Start goal'}</button>
    </form>
  );
}

function GoalList() {
  const navigate = useNavigate();
  const [goals, setGoals] = useState<Goal[]>([]);
  const [error, setError] = useState<string | null>(null);
  useDocumentTitle('Goals');
  const refresh = useCallback(() => listGoals().then(data => setGoals(data.goals)).catch(err => setError((err as Error).message)), []);
  useEffect(() => { refresh(); const timer = window.setInterval(refresh, 10_000); return () => window.clearInterval(timer); }, [refresh]);
  const goalAgents = goals.map(goal => ({ type: goal.agent.type, alias: goal.agent.alias }));
  return <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
    <div><h1 className="text-2xl font-bold text-slate-900">Goals</h1><p className="mt-1 text-sm text-slate-600">Long-running work kept in one exact coding-agent session.</p></div>
    <CreateGoalForm onCreated={goal => navigate(`/goals/${goal.id}`)} />
    {error && <p role="alert" className="text-red-600">{error}</p>}
    <section className="space-y-3"><h2 className="text-lg font-semibold">Your goals</h2>
      {goals.length === 0 ? <p className="rounded-lg border border-dashed p-8 text-center text-sm text-slate-500">No goals yet.</p> : goals.map(goal => <Link key={goal.id} to={`/goals/${goal.id}`} className="block rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition hover:border-primary-300 hover:shadow-md">
        <div className="flex items-start justify-between gap-4"><h3 className="line-clamp-2 min-w-0 font-semibold leading-5 text-slate-900" title={goal.title}>{goal.title}</h3><GoalState goal={goal} /></div>
        <p className="mt-1 line-clamp-2 text-sm leading-5 text-slate-500">{goal.objective}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-600">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1"><Github className="h-3.5 w-3.5 text-slate-500" />{goal.repository}</span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-violet-50 px-2.5 py-1 text-violet-700"><ProviderLogo provider={goal.agent.type} className="h-3.5 w-3.5" />{formatAgentLabel(goal.agent, goalAgents)}</span>
          <span className="inline-flex items-center rounded-full bg-cyan-50 px-2.5 py-1 text-cyan-700">{getModelDisplayName(goal.requestedModel)}</span>
        </div>
        <div className="mt-3 grid gap-2 text-xs text-slate-600 sm:grid-cols-3">
          <span className="flex items-center gap-1.5"><Activity className="h-3.5 w-3.5 flex-none text-blue-500" />Current: {goal.liveSummary.currentTask || goal.taskState}</span>
          <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1"><span className="inline-flex items-center gap-1.5"><Coins className="h-3.5 w-3.5 text-amber-500" />{(goal.liveSummary.nativeGoal?.tokensUsed ?? tokenTotal(goal.liveSummary.tokenUsage)).toLocaleString()} tokens</span><span aria-hidden="true">·</span><span className="inline-flex items-center gap-1.5"><Clock3 className="h-3.5 w-3.5 text-indigo-500" />{duration(goal.liveSummary.nativeGoal ? goal.liveSummary.nativeGoal.timeUsedSeconds * 1000 : goal.activeMs)} active</span></span>
          <span className="flex flex-wrap items-center gap-2"><span className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-2 py-1 text-blue-700"><CircleDot className="h-3.5 w-3.5" />{goal.artifactStats.openIssues}/{goal.artifactStats.issues} open issues</span><span className="inline-flex items-center gap-1.5 rounded-full bg-purple-50 px-2 py-1 text-purple-700"><GitPullRequest className="h-3.5 w-3.5" />{goal.artifactStats.openPullRequests}/{goal.artifactStats.pullRequests} open PRs</span></span>
        </div>
        {goal.liveSummary.todos.length > 0 && <div className="mt-3 flex gap-2 border-t border-slate-100 pt-3"><ListTodo className="mt-0.5 h-3.5 w-3.5 flex-none text-slate-400" /><ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">{goal.liveSummary.todos.map(todo => <li key={todo.id} className="inline-flex items-center gap-1.5">{todo.status === 'completed' ? <CheckCircle2 className="h-3.5 w-3.5 text-green-500" /> : todo.status === 'in_progress' ? <LoaderCircle className="h-3.5 w-3.5 text-blue-500" /> : <Circle className="h-3.5 w-3.5 text-slate-400" />}{todo.content}</li>)}</ul></div>}
      </Link>)}</section>
  </div>;
}

// The detail surface intentionally composes all goal controls and existing task projections.
// eslint-disable-next-line complexity
function GoalDetails({ goalId }: { goalId: string }) {
  const navigate = useNavigate();
  const [goal, setGoal] = useState<Goal | null>(null);
  const [message, setMessage] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outputMode, setOutputMode] = useState<'readable' | 'terminal'>('readable');
  const { liveDetails: live } = useTaskLiveData(goal?.taskId);
  const goalHistory = useMemo(() => goal?.startedAt
    ? [{ state: 'CLAUDE_EXECUTION', timestamp: goal.startedAt }]
    : [], [goal?.startedAt]);
  const thinkingLog = useThinkingLog(live, goalHistory);
  useDocumentTitle(goal?.title || 'Goal');

  const refresh = useCallback(async () => {
    try {
      const data = await getGoal(goalId); setGoal(data.goal);
      if (models.length === 0) {
        const capabilityData = await getGoalCapabilities();
        setModels(capabilityData.agents.find(agent => agent.agentId === data.goal.agent.id)?.models || [data.goal.requestedModel]);
      }
    } catch (err) { setError((err as Error).message); }
  }, [goalId, models.length]);
  useEffect(() => { refresh(); const timer = window.setInterval(refresh, 5_000); return () => window.clearInterval(timer); }, [refresh]);
  const act = async (operation: () => Promise<{ goal: Goal }>) => { setBusy(true); setError(null); try { setGoal((await operation()).goal); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } };
  const continueWith = async (body: { message?: string; canned?: 'done' | 'left' }, attachments: File[] = []) => {
    if (!goal) return;
    setBusy(true); setError(null);
    try {
      const result = attachments.length > 0 ? await sendGoalInput(goal.id, body, attachments) : await sendGoalInput(goal.id, body);
      setGoal(result.goal); setMessage(''); setFiles([]);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!goal || !window.confirm('Delete this goal? If it is running, it will be stopped first. This action cannot be undone.')) return;
    setBusy(true); setError(null);
    try {
      await deleteGoal(goal.id);
      navigate('/goals', { replace: true });
    } catch (err) { setError((err as Error).message); setBusy(false); }
  };
  const totalTokens = useMemo(
    () => tokenTotal(live.tokenUsage || null) || goal?.liveSummary.nativeGoal?.tokensUsed || 0,
    [goal?.liveSummary.nativeGoal?.tokensUsed, live.tokenUsage],
  );
  if (!goal) return <div className="p-6 text-slate-600">{error || 'Loading goal…'}</div>;
  const terminal = Boolean(goal.resultState);
  const cancelling = !terminal && goal.desiredState === 'cancelled';
  const mutable = !terminal && !cancelling;
  const strategyLabel = goal.launchStrategy === 'direct' ? 'Direct' : 'ProPR orchestrated';
  const currentModel = getModelDisplayName(goal.effectiveModel || goal.requestedModel);
  return <div className="min-h-full bg-white text-slate-900">
    <header className="w-full border-b border-slate-200 px-4 py-3 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <div className="flex items-center justify-between gap-4">
          <Link to="/goals" className="text-sm font-medium text-slate-600 transition hover:text-primary-700">← All goals</Link>
          <GoalState goal={goal} />
        </div>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">{goal.title}</h1>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-sm text-slate-700">
            <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Strategy</span>
            <span className="font-medium">{strategyLabel}</span>
            <span aria-hidden="true" className="text-slate-300">•</span>
            <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Model</span>
            <code className="rounded bg-slate-100 px-2 py-1 font-mono text-xs font-semibold text-slate-700">{currentModel}</code>
            <span aria-hidden="true" className="text-slate-300">•</span>
            <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Elapsed</span>
            <span className="font-mono text-xs font-semibold text-slate-700">{duration(goal.elapsedMs)}</span>
            <span aria-hidden="true" className="hidden text-slate-300 sm:inline">•</span>
            <span className="text-xs text-slate-500">{goal.repository} · {goal.agent.alias}</span>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {goal.desiredState === 'running' && mutable && <button disabled={busy} onClick={() => act(() => pauseGoal(goal.id))} className={`${buttonClass} border border-amber-300 text-amber-800 hover:bg-amber-50`}><CirclePause className="h-4 w-4" />Pause</button>}
            {goal.desiredState === 'paused' && mutable && <button disabled={busy} onClick={() => act(() => resumeGoal(goal.id))} className={`${buttonClass} border border-green-300 text-green-800 hover:bg-green-50`}><CirclePlay className="h-4 w-4" />{goal.pausePending ? 'Resume after safe boundary' : 'Resume'}</button>}
            {mutable && <button disabled={busy} onClick={() => act(() => cancelGoal(goal.id))} className={`${buttonClass} border border-red-300 text-red-700 hover:bg-red-50`}><CircleStop className="h-4 w-4" />Cancel</button>}
            {goal.finalPr && <a href={goal.finalPr.url} target="_blank" rel="noreferrer" className={`${buttonClass} bg-primary-600 text-white shadow-sm hover:bg-primary-700`}><GitPullRequest className="h-4 w-4" />{goal.launchStrategy === 'direct' ? 'Open draft PR' : 'Review final PR'} <ExternalLink className="h-3.5 w-3.5" /></a>}
            <details className="group relative">
              <summary aria-label="More goal actions" className="flex h-9 w-9 cursor-pointer list-none items-center justify-center rounded-md border border-slate-300 text-slate-600 transition hover:bg-slate-50 [&::-webkit-details-marker]:hidden"><MoreHorizontal className="h-4 w-4" /></summary>
              <div className="absolute right-0 z-20 mt-2 w-48 overflow-hidden rounded-md border border-slate-200 bg-white py-1 shadow-lg">
                <Link to={`/tasks/${goal.taskId}`} className="block px-3 py-2 text-sm text-slate-700 hover:bg-slate-50">Open task history</Link>
                <button disabled={busy} onClick={remove} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-700 hover:bg-red-50 disabled:opacity-50"><Trash2 className="h-4 w-4" />Delete goal</button>
              </div>
            </details>
          </div>
        </div>
      </div>
    </header>

    {(error || goal.failureReason || cancelling) && <div className="mx-auto max-w-7xl space-y-2 px-4 pt-4 sm:px-6 lg:px-8">
      {error && <p role="alert" className="bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {goal.failureReason && <p role="alert" className="bg-red-50 p-3 text-sm text-red-700">{goal.failureReason}</p>}
      {cancelling && <p className="bg-amber-50 p-3 text-sm text-amber-800">Cancelling at the provider boundary and cleaning up the active session…</p>}
    </div>}

    <div className="mx-auto grid min-h-[calc(100vh-17rem)] max-w-7xl lg:grid-cols-[minmax(0,3fr)_minmax(22rem,2fr)]">
      <main aria-label="Goal monitor" className="min-w-0 bg-white px-4 py-6 sm:px-6 lg:px-8">
        <section aria-labelledby="goal-context-heading">
          <h2 id="goal-context-heading" className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Context</h2>
          <details className="group border-b border-slate-200 py-4 text-sm" open>
            <summary className="cursor-pointer font-semibold text-slate-800">Goal description</summary>
            <p className="mt-3 whitespace-pre-wrap break-words leading-6 text-slate-600">{goal.objective}</p>
          </details>
          {(goal.attachments || []).length > 0 && <div className="border-b border-slate-200 py-4 text-sm">
            <h3 className="font-semibold text-slate-800">Files shared with this goal</h3>
            <div className="mt-3 flex flex-wrap gap-2">{(goal.attachments || []).map(attachment => <a key={attachment.id} href={getGoalAttachmentUrl(goal.id, attachment.id)} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-2 text-xs text-slate-700 hover:border-primary-300 hover:text-primary-700">
              {attachment.type === 'image'
                ? <img src={getGoalAttachmentUrl(goal.id, attachment.id)} alt="" className="h-9 w-9 rounded object-cover" />
                : <FileText className="h-4 w-4 text-slate-400" />}
              <span className="max-w-52 truncate" title={attachment.originalName}>{attachment.originalName}</span>
            </a>)}</div>
          </div>}
          <details className="group border-b border-slate-200 py-4 text-sm">
            <summary className="cursor-pointer font-semibold text-slate-800">Initial provider prompt</summary>
            <pre className="mt-3 whitespace-pre-wrap break-words font-mono text-xs leading-5 text-slate-600">{goal.initialPrompt}</pre>
          </details>
        </section>

        {goal.checkpoint && <section className="mb-6 mt-3 bg-blue-50 p-4 text-sm text-blue-950">
          <div className="flex items-start gap-3">
            <CircleDot className="mt-0.5 h-4 w-4 flex-none text-blue-600" />
            <div className="min-w-0">
              <p className="font-medium">{goal.checkpoint.count} checkpoint commit{goal.checkpoint.count === 1 ? '' : 's'}{goal.checkpoint.lastAt ? ` · last ${new Date(goal.checkpoint.lastAt).toLocaleString()}` : ''}</p>
              <p className="mt-1 text-blue-800">Target cadence: about every {goal.checkpoint.intervalMinutes || 15} minutes. <span className="text-xs">The agent declares when coherent work is ready.</span></p>
              {goal.checkpoint.error && !goal.checkpoint.latest?.error && <p className="mt-2 text-red-700">Checkpoint error: {goal.checkpoint.error}</p>}
              <CheckpointDeclaration checkpoint={goal.checkpoint} />
            </div>
          </div>
        </section>}

        {goal.artifacts.length > 0 && <div className="my-5 flex flex-wrap gap-2 text-xs text-slate-600">{goal.artifacts.map((artifact, index) => { const item = artifact as { type?: string; number?: number; url?: string }; return item.url ? <a key={item.url} href={item.url} target="_blank" rel="noreferrer" className="rounded bg-slate-100 px-2 py-1 hover:underline">{item.type === 'pull_request' ? 'PR' : 'Issue'} #{item.number}</a> : <span key={index} />; })}</div>}

        <section aria-labelledby="live-progress-heading" className="mt-6">
          <div className="flex items-center gap-2">
            <h2 id="live-progress-heading" className="text-[11px] font-bold uppercase tracking-widest text-slate-500">Execution queue</h2>
            {mutable && goal.desiredState === 'running' && <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" /><span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" /></span>}
          </div>
          {live.todos.length ? <div className="[&>div]:border-t-0 [&>div]:pt-3 [&>div>h4]:hidden"><TodoList liveDetails={live} history={[{ state: goal.taskState }]} /></div> : <p className="mt-3 text-sm text-slate-500">No provider todos yet.</p>}
        </section>

        <section className="mt-8 border-t border-slate-200 pt-5">
          <header className="flex flex-wrap items-center justify-between gap-3">
            <div><h2 className="font-semibold text-slate-900">Goal output</h2><p className="mt-0.5 text-xs text-slate-500">Follow the agent's progress or inspect the raw provider stream.</p></div>
            <div role="group" aria-label="Goal output view" className="inline-flex rounded-md border border-slate-200 bg-slate-50 p-1">
              <button type="button" aria-pressed={outputMode === 'readable'} onClick={() => setOutputMode('readable')} className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium transition ${outputMode === 'readable' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}><FileText className="h-3.5 w-3.5" />Human readable</button>
              <button type="button" aria-pressed={outputMode === 'terminal'} onClick={() => setOutputMode('terminal')} className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium transition ${outputMode === 'terminal' ? 'bg-slate-800 text-white shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}><Terminal className="h-3.5 w-3.5" />Raw terminal</button>
            </div>
          </header>
          {outputMode === 'readable'
            ? <div className="min-h-32 py-4">{thinkingLog.thinkingLogWithTimestamps.length > 0
              ? <ThinkingLog events={thinkingLog.thinkingLogWithTimestamps} todos={live.todos} />
              : <p className="text-sm text-slate-500">No human-readable output yet.</p>}</div>
            : <div className="mt-4 min-h-32 bg-slate-950 p-4 text-slate-100">{live.events.length > 0
              ? <ExecutionEventLog events={live.events} collapsed={false} onToggleCollapse={() => undefined} lastThought={thinkingLog.lastThought} isTaskActive={mutable && goal.desiredState === 'running'} taskInfo={null} />
              : <p className="text-sm text-slate-400">No terminal output yet.</p>}</div>}
        </section>
      </main>

      <aside aria-label="Steering console" className="flex min-w-0 flex-col border-t border-slate-200 bg-slate-50 px-4 py-6 sm:px-6 lg:border-l lg:border-t-0">
        <section aria-labelledby="goal-metrics-heading">
          <h2 id="goal-metrics-heading" className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Metrics</h2>
          <dl className="mt-3 grid grid-cols-2 border-y border-slate-200">
            <div className="border-b border-r border-slate-200 py-4 pr-4"><dt className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Usage</dt><dd className="mt-1 text-2xl font-bold tracking-tight text-slate-950">{totalTokens.toLocaleString()}</dd><dd className="text-xs text-slate-500">tokens</dd>{goal.liveSummary.nativeGoal && <dd className="mt-1 text-xs text-slate-500">{goal.liveSummary.nativeGoal.status} · {duration(goal.liveSummary.nativeGoal.timeUsedSeconds * 1000)}</dd>}</div>
            <div className="border-b border-slate-200 py-4 pl-4"><dt className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Session</dt><dd className="mt-2 break-all"><code className="rounded bg-white px-2 py-1 font-mono text-xs text-slate-700 shadow-sm">{goal.sessionId || 'Waiting for provider identity'}</code></dd></div>
            <div className="border-r border-slate-200 py-4 pr-4"><dt className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Active</dt><dd className="mt-1 font-mono text-sm font-semibold text-slate-800">{duration(goal.activeMs)}</dd><dd className="mt-1 text-xs text-slate-500">{duration(goal.pausedMs)} paused</dd></div>
            <div className="py-4 pl-4"><dt className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Artifacts</dt><dd className="mt-1 text-sm font-semibold text-slate-800">{goal.artifactStats.openPullRequests}/{goal.artifactStats.pullRequests} PRs</dd><dd className="mt-1 text-xs text-slate-500">{goal.artifactStats.openIssues}/{goal.artifactStats.issues} open issues</dd></div>
          </dl>
        </section>

        {mutable && <section aria-labelledby="quick-actions-heading" className="mt-7">
          <h2 id="quick-actions-heading" className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Quick actions</h2>
          <div className="mt-3 flex flex-wrap gap-2"><button disabled={busy} onClick={() => continueWith({ canned: 'done' })} className={`${buttonClass} border border-slate-200 bg-white text-slate-700 shadow-sm hover:border-slate-300 hover:bg-slate-50`}>What's done?</button><button disabled={busy} onClick={() => continueWith({ canned: 'left' })} className={`${buttonClass} border border-slate-200 bg-white text-slate-700 shadow-sm hover:border-slate-300 hover:bg-slate-50`}>What's left?</button></div>
        </section>}

        {mutable ? <section aria-labelledby="correction-heading" className="sticky bottom-0 mt-auto pt-10">
          <div className="mb-2 flex flex-col items-end gap-1">
            <label htmlFor="goal-continuation-model" className="text-xs text-slate-500">Model for next continuation</label>
            <select id="goal-continuation-model" value={goal.requestedModel} onChange={event => act(() => requestGoalModel(goal.id, event.target.value))} className="max-w-48 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs font-medium text-slate-700 shadow-sm">{models.map(item => <option key={item} value={item}>{getModelDisplayName(item)}</option>)}</select>
          </div>
          <div className="bg-white p-2 shadow-md ring-1 ring-slate-200/70">
            <h2 id="correction-heading" className="sr-only">Send a correction</h2>
            <textarea aria-label="Correction or follow-up" value={message} onChange={event => setMessage(event.target.value)} onPaste={event => {
              const pasted = clipboardImageFiles(event);
              if (!pasted.length) return;
              event.preventDefault();
              void addGoalFiles(files, pasted, setFiles, setError);
            }} rows={3} className="w-full resize-none border-0 p-2 text-sm text-slate-800 outline-none placeholder:text-slate-400 focus:ring-0" placeholder="Send a correction to the same coding-agent session…" />
            <GoalAttachmentInput files={files} onChange={setFiles} onError={setError} disabled={busy} compact />
            <div className="mt-2 flex justify-end"><button disabled={busy || !message.trim()} onClick={() => continueWith({ message }, files)} className={`${buttonClass} bg-primary-600 text-white hover:bg-primary-700`}><Send className="h-4 w-4" />Send</button></div>
          </div>
        </section> : <p className="mt-auto pt-10 text-sm text-slate-500">This goal no longer accepts corrections.</p>}
      </aside>
    </div>
  </div>;
}

export default function GoalsPage() { const { goalId } = useParams(); return goalId ? <GoalDetails goalId={goalId} /> : <GoalList />; }
