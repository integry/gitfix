import { withRetry, retryConfigs } from '../utils/retryHandler.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { getStateManager, TaskStates } from '../utils/workerStateManager.js';
import { 
    ensureRepoCloned, 
    createWorktreeForIssue,
    cleanupWorktree,
    getRepoUrl,
    commitChanges,
    pushBranch
} from '../git/repoManager.js';
import { completePostProcessing } from '../githubService.js';
import { executeClaudeCode, buildClaudeDockerImage, UsageLimitError } from '../claude/claudeService.js';
import { recordLLMMetrics } from '../utils/llmMetrics.js';
import { 
    validatePRCreation, 
    generateEnhancedClaudePrompt, 
    validateRepositoryInfo 
} from '../utils/prValidation.js';
import { generateCorrelationId } from '../utils/logger.js';
import { handleError } from '../utils/errorHandler.js';
import { 
    safeUpdateLabels, 
    formatResetTime, 
    addModelSpecificDelay,
    ensureGitRepository,
    generateCompletionComment
} from '../utils/workerHelpers.js';
import { GITHUB_ISSUE_QUEUE_NAME, issueQueue } from '../queue/taskQueue.js';
import logger from '../utils/logger.js';
import { getDefaultModel } from '../config/modelAliases.js';
import { loadSettings } from '../config/configRepoManager.js';

// Configuration
const AI_PROCESSING_TAG = process.env.AI_PROCESSING_TAG || 'AI-processing';
const AI_PRIMARY_TAG = process.env.AI_PRIMARY_TAG || 'AI';
const AI_DONE_TAG = process.env.AI_DONE_TAG || 'AI-done';
const DEFAULT_MODEL_NAME = process.env.DEFAULT_CLAUDE_MODEL || getDefaultModel();

// Buffer to add AFTER the reset timestamp to ensure limit is reset
const REQUEUE_BUFFER_MS = parseInt(process.env.REQUEUE_BUFFER_MS || (5 * 60 * 1000), 10); // 5 minutes buffer
// Jitter to prevent thundering herd if multiple jobs reset at the same time
const REQUEUE_JITTER_MS = parseInt(process.env.REQUEUE_JITTER_MS || (2 * 60 * 1000), 10); // 2 minutes jitter

/**
 * Processes a GitHub issue job from the queue
 * @param {import('bullmq').Job} job - The job to process
 * @returns {Promise<Object>} Processing result
 */
export async function processGitHubIssueJob(job) {
    const { id: jobId, name: jobName, data: issueRef } = job;
    const correlationId = issueRef.correlationId || generateCorrelationId();
    const correlatedLogger = logger.withCorrelation(correlationId);
    const stateManager = getStateManager();
    
    // Add delay to prevent concurrent worker conflicts
    const modelName = issueRef.modelName || 'default';
    await addModelSpecificDelay(modelName);
    
    correlatedLogger.debug({ 
        jobId, 
        modelName,
        delayApplied: true
    }, 'Applied model-specific delay to prevent conflicts');
    
    // Create task state - include model name to allow parallel processing with different models
    const taskId = `${issueRef.repoOwner}-${issueRef.repoName}-${issueRef.number}-${modelName}`;
    
    try {
        await stateManager.createTaskState(taskId, issueRef, correlationId);
    } catch (stateError) {
        correlatedLogger.warn({
            taskId,
            error: stateError.message
        }, 'Failed to create task state, continuing anyway');
    }
    
    correlatedLogger.info({ 
        jobId, 
        jobName, 
        taskId,
        issueNumber: issueRef.number, 
        repo: `${issueRef.repoOwner}/${issueRef.repoName}` 
    }, 'Processing job started');
    let octokit;
    try {
        octokit = await withRetry(
            () => getAuthenticatedOctokit(),
            { ...retryConfigs.githubApi, correlationId },
            'get_authenticated_octokit'
        );
    } catch (authError) {
        const errorDetails = handleError(authError, 'Worker: Failed to get authenticated Octokit instance', { 
            correlationId, 
            issueRef 
        });
        
        try {
            await stateManager.markTaskFailed(taskId, authError, {
                context: 'github_auth',
                category: errorDetails.category
            });
        } catch (stateError) {
            correlatedLogger.error({
                error: stateError.message,
                taskId
            }, 'Failed to update task state after auth error');
        }
        
        throw authError;
    }

    let localRepoPath;
    let worktreeInfo;
    let claudeResult = null;

    try {
        // Phase 1: Setup
        await stateManager.updateTaskState(taskId, TaskStates.SETUP, {
            reason: 'Starting issue processing'
        });

        const githubToken = await octokit.auth();

        // Build Claude Docker image if needed - should be cached after first build
        await buildClaudeDockerImage();
        
        // Validate the issue information
        const isValid = await validateRepositoryInfo(octokit, issueRef);
        if (!isValid) {
            throw new Error('Invalid issue or repository information');
        }

        // Update issue labels to indicate AI processing
        correlatedLogger.info({ issueNumber: issueRef.number }, 'Updating issue labels for AI processing');
        await safeUpdateLabels(
            octokit,
            issueRef.repoOwner,
            issueRef.repoName,
            issueRef.number,
            [AI_PRIMARY_TAG],  // Remove AI tag
            [AI_PROCESSING_TAG] // Add AI-processing tag
        );

        const repoUrl = getRepoUrl(issueRef);
        
        // Ensure we're in a valid git repository before proceeding
        await ensureGitRepository(correlatedLogger);

        // Step 1: Ensure repository is cloned
        correlatedLogger.info({ repoUrl }, 'Ensuring repository is cloned');
        localRepoPath = await ensureRepoCloned(repoUrl, issueRef.repoOwner, issueRef.repoName, githubToken.token);
        
        // Load per-repo settings after cloning
        const repoSettings = await loadSettings(issueRef.repoOwner, issueRef.repoName);
        correlatedLogger.debug({
            repoSettings,
            hasModels: !!repoSettings?.models,
            modelCount: repoSettings?.models ? Object.keys(repoSettings.models).length : 0
        }, 'Loaded repository-specific settings');
        
        // Determine model to use (prioritize per-repo settings)
        const modelToUse = (repoSettings?.models?.[issueRef.modelName] || issueRef.modelName || DEFAULT_MODEL_NAME);
        correlatedLogger.info({
            requestedModel: issueRef.modelName,
            resolvedModel: modelToUse,
            fromRepoSettings: !!repoSettings?.models?.[issueRef.modelName]
        }, 'Resolved model to use for issue');

        await stateManager.updateTaskState(taskId, TaskStates.SETUP, {
            reason: 'Repository cloned, creating worktree'
        });

        // Step 2: Create a worktree for the issue
        correlatedLogger.info({ issueNumber: issueRef.number }, 'Creating worktree for issue');
        worktreeInfo = await createWorktreeForIssue(
            localRepoPath, 
            issueRef.number, 
            issueRef.title, 
            issueRef.repoOwner, 
            issueRef.repoName,
            issueRef.baseBranch,
            octokit,
            modelToUse
        );
        correlatedLogger.info({ worktreePath: worktreeInfo.worktreePath, branchName: worktreeInfo.branchName }, 'Created worktree');

        // Phase 2: Claude Execution
        await stateManager.updateTaskState(taskId, TaskStates.CLAUDE_EXECUTION, {
            reason: 'Starting Claude execution'
        });

        // Step 3: Generate prompt and execute Claude Code
        const prompt = generateEnhancedClaudePrompt(issueRef, repoUrl, worktreeInfo.branchName, worktreeInfo.baseBranch, worktreeInfo.worktreePath);
        
        correlatedLogger.info({
            issueNumber: issueRef.number,
            worktreePath: worktreeInfo.worktreePath,
            model: modelToUse
        }, 'Executing Claude Code for issue');
        
        claudeResult = await executeClaudeCode({
            worktreePath: worktreeInfo.worktreePath,
            issueRef,
            githubToken: githubToken.token,
            customPrompt: prompt,
            branchName: worktreeInfo.branchName,
            modelName: modelToUse
        });
        correlatedLogger.info({ 
            issueNumber: issueRef.number, 
            success: claudeResult.success,
            model: claudeResult.model,
            executionTime: claudeResult.executionTime
        }, 'Claude Code execution completed');
        
        // Update task state with Claude execution result
        await stateManager.updateTaskState(taskId, TaskStates.CLAUDE_EXECUTION, {
            reason: 'Claude execution completed',
            claudeResult: {
                success: claudeResult.success,
                executionTime: claudeResult.executionTime
            }
        });
        
        // Record LLM metrics
        await recordLLMMetrics(claudeResult, issueRef, 'github_issue', correlationId);

        if (!claudeResult.success) {
            throw new Error(`Claude execution failed: ${claudeResult.error || 'Unknown error'}`);
        }

        // Phase 3: Git Operations
        await stateManager.updateTaskState(taskId, TaskStates.GIT_OPERATIONS, {
            reason: 'Committing and pushing changes'
        });

        // Step 4: Commit and push changes
        correlatedLogger.info({ issueNumber: issueRef.number }, 'Committing changes');
        const commitMessage = `fix: ${issueRef.title}\n\nImplemented solution for issue #${issueRef.number} using Claude Code.\nModel: ${modelToUse}`;
        const commitResult = await commitChanges(
            worktreeInfo.worktreePath,
            commitMessage,
            { name: 'Claude Code', email: 'claude-code@anthropic.com' },
            issueRef.number,
            issueRef.title
        );

        if (!commitResult) {
            correlatedLogger.info({ issueNumber: issueRef.number }, 'No changes to commit');
            
            // Update labels to indicate completion without changes
            await safeUpdateLabels(
                octokit,
                issueRef.repoOwner,
                issueRef.repoName,
                issueRef.number,
                [AI_PROCESSING_TAG],
                [AI_DONE_TAG]
            );

            // Add completion comment indicating no changes were necessary
            const noChangesComment = await generateCompletionComment(claudeResult, issueRef);
            await octokit.issues.createComment({
                owner: issueRef.repoOwner,
                repo: issueRef.repoName,
                issue_number: issueRef.number,
                body: noChangesComment
            });
            
            await stateManager.updateTaskState(taskId, TaskStates.COMPLETED, {
                reason: 'No changes necessary',
                historyMetadata: {
                    githubComment: noChangesComment
                }
            });
            
            return { 
                status: 'complete', 
                issueRef, 
                noChanges: true, 
                claudeResult 
            };
        }

        correlatedLogger.info({ 
            issueNumber: issueRef.number,
            commitHash: commitResult.commitHash
        }, 'Pushing changes');
        
        await pushBranch(worktreeInfo.worktreePath, worktreeInfo.branchName, {
            repoUrl,
            authToken: githubToken.token,
            tokenRefreshFn: async () => {
                const newToken = await octokit.auth();
                return newToken.token;
            },
            correlationId
        });

        // Phase 4: Post-processing
        await stateManager.updateTaskState(taskId, TaskStates.POST_PROCESSING, {
            reason: 'Creating pull request and updating GitHub'
        });

        // Step 5: Complete post-processing (creates PR, updates labels, comments, etc.)
        correlatedLogger.info({ issueNumber: issueRef.number }, 'Completing post-processing');
        const postProcessingResult = await completePostProcessing({
            issueRef,
            claudeResult,
            branchName: worktreeInfo.branchName,
            baseBranch: worktreeInfo.baseBranch,
            octokit,
            correlationId,
            stateManager,
            taskId,
            options: {
                successLabel: AI_DONE_TAG,
                processingLabel: AI_PROCESSING_TAG,
                modelUsed: modelToUse,
                commitHash: commitResult.commitHash
            }
        });

        await stateManager.updateTaskState(taskId, TaskStates.COMPLETED, {
            reason: 'Issue processing completed successfully',
            pullRequestUrl: postProcessingResult.pullRequestUrl
        });

        return { 
            status: 'complete', 
            ...postProcessingResult, 
            claudeResult 
        };

    } catch (error) {
        try {
            if (error instanceof UsageLimitError) {
                correlatedLogger.warn({
                    issueNumber: issueRef.number,
                    resetTimestamp: error.resetTimestamp
                }, 'Claude usage limit hit. Requeueing job.');

                const resetTimeUTC = error.resetTimestamp ? (error.resetTimestamp * 1000) : (Date.now() + 60 * 60 * 1000); // Default to 1 hour if timestamp parse failed
                const delay = (resetTimeUTC - Date.now()) + REQUEUE_BUFFER_MS + Math.floor(Math.random() * REQUEUE_JITTER_MS);
                
                const readableResetTime = formatResetTime(error.resetTimestamp);

                // Add comment to issue notifying user
                if (octokit) {
                    try {
                        await octokit.issues.createComment({
                            owner: issueRef.repoOwner,
                            repo: issueRef.repoName,
                            issue_number: issueRef.number,
                            body: `⌛ **Processing Delayed:** Claude's usage limit was reached.
                            
The job has been automatically rescheduled and will restart ${readableResetTime}.

---
*Job ID: ${job.id} will run again after delay.*`
                        });
                    } catch (commentError) {
                        correlatedLogger.error({ error: commentError.message }, 'Failed to post usage limit delay comment to issue.');
                    }
                }

                // Re-add the job to the queue with the calculated delay
                await issueQueue.add(job.name, job.data, { delay: Math.max(0, delay) });
                
                // Do NOT throw the error, as this job is technically "handled" by being requeued.
                // BullMQ would retry it immediately if we throw.

            } else {
                // Handle all other errors
                const errorDetails = handleError(error, 'Failed to process issue job', { 
                    correlationId, 
                    issueRef 
                });
                
                // Update task state to failed
                await stateManager.markTaskFailed(taskId, error, {
                    context: errorDetails.context,
                    category: errorDetails.category
                });
                
                // Record LLM metrics even if the job failed, as long as Claude was executed
                if (claudeResult) {
                    try {
                        await recordLLMMetrics(claudeResult, issueRef, 'github_issue', correlationId);
                        correlatedLogger.info({
                            correlationId,
                            issueNumber: issueRef.number
                        }, 'LLM metrics recorded for failed job');
                    } catch (metricsError) {
                        correlatedLogger.error({
                            error: metricsError.message,
                            correlationId
                        }, 'Failed to record LLM metrics for failed job');
                    }
                }
                
                throw error; // Re-throw general errors so BullMQ marks the job as failed
            }
        } catch (postProcessingError) {
            correlatedLogger.error({
                error: postProcessingError.message,
                phase: 'post_error_handling'
            }, 'Error during error handling phase');
            // Don't re-throw to avoid masking original error
        }
    } finally {
        // Cleanup worktree
        if (localRepoPath && worktreeInfo) {
            try {
                await cleanupWorktree(localRepoPath, worktreeInfo.worktreePath, worktreeInfo.branchName, {
                    deleteBranch: false, // Keep the branch since we may have pushed changes
                    success: true
                });
            } catch (cleanupError) {
                correlatedLogger.warn({ error: cleanupError.message }, 'Failed to cleanup worktree');
            }
        }
        
        // Update issue labels to remove processing tag even if there was an error
        if (octokit && issueRef) {
            try {
                await safeUpdateLabels(
                    octokit,
                    issueRef.repoOwner,
                    issueRef.repoName,
                    issueRef.number,
                    [AI_PROCESSING_TAG],  // Remove processing tag
                    [] // Don't add any new labels on error
                );
            } catch (labelError) {
                correlatedLogger.error({ error: labelError.message }, 'Failed to clean up labels after error');
            }
        }
    }
}