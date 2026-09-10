import type { Args, McpTool } from './tools.js';

/** Small spoken summaries; the structured result remains authoritative. */
export function presentResult(tool: McpTool, args: Args, data: Args, instanceId: string, origin: string): { summary: string; links: Record<string, string> } {
  const result = tool.readOnly ? data : data.result || {};
  const continuation = result.continuation || result;
  const planId = args.planId || continuation.planId;
  const goalId = args.goalId || continuation.goalId;
  const taskId = args.taskId || continuation.taskId;
  let resource = 'connection', ui = origin;
  const frontend = (process.env.FRONTEND_URL || origin).replace(/\/$/, '');
  if (planId) { resource = `plans/${encodeURIComponent(planId)}`; ui = `${frontend}/studio/${encodeURIComponent(planId)}`; }
  else if (goalId) { resource = `goals/${encodeURIComponent(goalId)}`; ui = `${frontend}/goals/${encodeURIComponent(goalId)}`; }
  else if (taskId) { resource = `tasks/${encodeURIComponent(taskId)}`; ui = `${frontend}/tasks/${encodeURIComponent(taskId)}`; }
  else if (args.pullRequest) { resource = `repositories/${args.repository}/pulls/${args.pullRequest}`; ui = `https://github.com/${args.repository}/pull/${args.pullRequest}`; }
  else if (args.artifactId || result.artifactId) { const id = args.artifactId || result.artifactId; resource = `artifacts/${id}`; ui = `${origin}/mcp/artifacts/${id}`; }
  else if (tool.name === 'list_repositories') resource = 'repositories';
  else if (tool.name === 'list_models') resource = 'models';
  let summary = `${tool.name.replaceAll('_', ' ')}: ${tool.readOnly ? 'retrieved' : data.state}.`;
  if (!tool.readOnly) {
    if (data.state === 'accepted') summary += ' Work was accepted; completion is still pending.';
    if (data.state === 'unknown') summary += ' The outcome needs inspection before another action.';
    if (result.error) summary += ` ${result.error.code}: ${result.error.message}`;
    if (planId) summary += ` Plan ${planId}.`;
    if (goalId) summary += ` Goal ${goalId}.`;
    if (taskId) summary += ` Task ${taskId}.`;
    summary += ` Operation ${data.operationId}.`;
  } else if (tool.name === 'get_task') summary = `Task ${args.taskId}: ${result.latestEvent?.state || 'no execution state yet'}.`;
  else if (tool.name === 'get_plan') summary = `${result.name || 'Plan'}: ${result.status}, revision ${result.mcp_revision}.`;
  else if (tool.name === 'get_goal') summary = `${result.goal?.title || 'Goal'}: ${result.goal?.resultState || result.goal?.desiredState || 'state unavailable'}.`;
  else if (tool.name === 'get_connection') summary = `Connected as ${result.identity.username} to ${result.instanceId}. ${result.scopes.join(', ')} permissions.`;
  else if (tool.name === 'resolve_reference') summary = result.match === 'ambiguous' || result.match === 'candidates' ? `${result.candidates.length} candidates. Choose an exact handle before acting.` : `${result.match.replaceAll('_', ' ')}: ${result.candidates.length} candidates.`;
  else {
    const list = Object.values(result).find(Array.isArray);
    if (list) summary = `${tool.name.replaceAll('_', ' ')}: ${list.length} items in this page.`;
  }
  return { summary, links: { instance: origin, ui, resource: `propr://instances/${instanceId}/${resource}` } };
}
