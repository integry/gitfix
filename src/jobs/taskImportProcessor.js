import logger from '../utils/logger.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { withRetry, retryConfigs } from '../utils/retryHandler.js';
import { getStateManager, TaskStates } from '../utils/workerStateManager.js';
import { 
    ensureRepoCloned, 
    createWorktreeForIssue,
    cleanupWorktree,
    getRepoUrl
} from '../git/repoManager.js';
import { executeClaudeCode, generateTaskImportPrompt, UsageLimitError } from '../claude/claudeService.js';
import { handleError } from '../utils/errorHandler.js';
import { ensureGitRepository } from '../utils/workerUtils.js';

const REQUEUE_BUFFER_MS = parseInt(process.env.REQUEUE_BUFFER_MS || (5 * 60 * 1000), 10);
const REQUEUE_JITTER_MS = parseInt(process.env.REQUEUE_JITTER_MS || (2 * 60 * 1000), 10);

/**
 * Processes a task import job from the queue
 * @param {import('bullmq').Job} job - The job to process
 * @returns {Promise<Object>} Processing result
 */
export async function processTaskImportJob(job) {
    const { id: jobId, name: jobName, data } = job;
    const {
        taskDescription,
        repository,
        correlationId,
        user
    } = data;
    const correlatedLogger = logger.withCorrelation(correlationId);
    const stateManager = getStateManager(jobId);
    
    correlatedLogger.info({ 
        jobId,
        jobName,
        repository, 
        user,
        taskDescriptionLength: taskDescription?.length || 0,
        taskDescriptionPreview: taskDescription?.substring(0, 100) + '...'
    }, 'Processing task import job...');

    let octokit;
    let localRepoPath;
    let worktreeInfo;

    try {
        // Phase 1: Setup
        await stateManager.updateState(TaskStates.SETUP, 'Initializing task import process');
        
        // Get authenticated Octokit instance
        octokit = await withRetry(
            () => getAuthenticatedOctokit(),
            { ...retryConfigs.githubApi, correlationId },
            'get_authenticated_octokit'
        );

        // Parse repository into owner and name
        const [repoOwner, repoName] = repository.split('/');
        
        if (!repoOwner || !repoName) {
            throw new Error(`Invalid repository format: ${repository}. Expected format: owner/name`);
        }

        const githubToken = await octokit.auth();
        const repoUrl = getRepoUrl({ repoOwner, repoName });

        // Ensure we're in a valid git repository before proceeding
        await ensureGitRepository(correlatedLogger);

        // Step 1: Ensure repository is cloned
        await stateManager.updateState(TaskStates.SETUP, 'Cloning repository if needed');
        localRepoPath = await ensureRepoCloned(repoUrl, repoOwner, repoName, githubToken.token);

        // Step 2: Create a worktree for the task import analysis
        await stateManager.updateState(TaskStates.SETUP, 'Creating worktree for analysis');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
        const worktreeDirName = `task-import-${timestamp}`;

        // Use placeholder values for issue-specific parameters
        worktreeInfo = await createWorktreeForIssue(
            localRepoPath,
            'import', // issueNumber placeholder
            'Task Import Analysis', // title
            repoOwner,
            repoName,
            null, // Use auto-detected default branch
            octokit,
            'planner' // modelName placeholder
        );

        correlatedLogger.info({ 
            worktreePath: worktreeInfo.worktreePath, 
            branchName: worktreeInfo.branchName 
        }, 'Created worktree for task import analysis');

        // Phase 2: AI Processing
        await stateManager.updateState(TaskStates.AI_PROCESSING, 'Generating task import prompt');
        
        // Step 3: Generate the task import prompt
        const prompt = generateTaskImportPrompt(taskDescription, repoOwner, repoName, worktreeInfo.worktreePath);

        await stateManager.updateState(TaskStates.AI_PROCESSING, 'Executing Claude analysis');
        
        // Step 4: Execute Claude Code with the task import prompt
        const claudeResult = await executeClaudeCode({
            worktreePath: worktreeInfo.worktreePath,
            issueRef: { 
                number: 'import', // placeholder
                repoOwner, 
                repoName 
            },
            githubToken: githubToken.token,
            customPrompt: prompt,
            branchName: worktreeInfo.branchName,
            modelName: 'claude-3-5-sonnet-20241022' // Use a specific model for planning
        });

        correlatedLogger.info({
            success: claudeResult.success,
            executionTime: claudeResult.executionTime,
            conversationTurns: claudeResult.conversationLog?.length || 0
        }, 'Claude task import analysis completed');

        // Log the result (this is a fire-and-forget job)
        if (claudeResult.success) {
            correlatedLogger.info({
                repository,
                user,
                stdout: claudeResult.output?.rawOutput || claudeResult.output
            }, 'Task import job completed successfully - Claude executed gh commands');
        } else {
            correlatedLogger.error({
                repository,
                user,
                error: claudeResult.error
            }, 'Task import job failed');
        }
        
        // Phase 3: Cleanup
        await stateManager.updateState(TaskStates.CLEANUP, 'Cleaning up worktree');
        await stateManager.updateState(TaskStates.COMPLETED, 'Task import completed successfully');

        return { 
            status: 'complete', 
            repository,
            success: claudeResult.success,
            jobId,
            claudeResult: {
                success: claudeResult.success,
                executionTime: claudeResult.executionTime,
                conversationTurns: claudeResult.conversationLog?.length || 0,
                stdout: claudeResult.output?.rawOutput || claudeResult.output
            }
        };

    } catch (error) {
        if (error instanceof UsageLimitError) {
            correlatedLogger.warn({
                repository,
                resetTimestamp: error.resetTimestamp
            }, 'Claude usage limit hit during task import processing. Requeueing job.');

            const resetTimeUTC = error.resetTimestamp ? (error.resetTimestamp * 1000) : (Date.now() + 60 * 60 * 1000);
            const delay = (resetTimeUTC - Date.now()) + REQUEUE_BUFFER_MS + Math.floor(Math.random() * REQUEUE_JITTER_MS);

            // Re-add the job to the queue with delay
            const { issueQueue } = await import('../queue/taskQueue.js');
            await issueQueue.add(job.name, job.data, { delay: Math.max(0, delay) });
            
            // Don't throw - job is handled by requeueing
            return { 
                status: 'requeued', 
                repository,
                delay
            };
        } else {
            // Handle all other errors
            correlatedLogger.error({
                error: error.message,
                stack: error.stack
            }, 'Task import job failed');
            
            await stateManager.updateState(TaskStates.FAILED, `Task import failed: ${error.message}`);
            
            handleError(error, 'Failed to process task import job', { correlationId });
            throw error;
        }
    } finally {
        // Cleanup worktree
        if (localRepoPath && worktreeInfo) {
            try {
                await cleanupWorktree(localRepoPath, worktreeInfo.worktreePath, worktreeInfo.branchName, {
                    deleteBranch: true, // Always delete branch for task imports
                    success: true
                });
            } catch (cleanupError) {
                correlatedLogger.warn({ error: cleanupError.message }, 'Failed to cleanup worktree');
            }
        }
    }
}