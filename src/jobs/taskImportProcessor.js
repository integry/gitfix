import { withRetry, retryConfigs } from '../utils/retryHandler.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { getStateManager, TaskStates } from '../utils/workerStateManager.js';
import { 
    ensureRepoCloned, 
    createWorktreeForIssue,
    cleanupWorktree,
    getRepoUrl
} from '../git/repoManager.js';
import { executeClaudeCode, generateTaskImportPrompt } from '../claude/claudeService.js';
import { ensureGitRepository } from '../utils/workerHelpers.js';
import logger from '../utils/logger.js';

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
            }, 'Task import job failed - Claude execution error');
        }

        // Phase 3: Completion
        await stateManager.updateState(TaskStates.COMPLETED, 'Task import job completed');

        return {
            status: 'complete',
            repository,
            user,
            success: claudeResult.success,
            executionTime: claudeResult.executionTime
        };

    } catch (error) {
        correlatedLogger.error({
            error: error.message,
            stack: error.stack,
            repository,
            user
        }, 'Task import job failed');

        // Update state to failed
        await stateManager.updateState(TaskStates.FAILED, `Task import failed: ${error.message}`);

        // This is a fire-and-forget job, so we don't re-throw the error
        return {
            status: 'failed',
            repository,
            user,
            error: error.message
        };
    } finally {
        // Cleanup worktree
        if (localRepoPath && worktreeInfo) {
            try {
                await cleanupWorktree(localRepoPath, worktreeInfo.worktreePath, worktreeInfo.branchName, {
                    deleteBranch: true, // Clean up the temporary branch
                    success: true
                });
            } catch (cleanupError) {
                correlatedLogger.warn({ error: cleanupError.message }, 'Failed to cleanup worktree');
            }
        }
    }
}