import path from 'path';
import fs from 'fs-extra';
import Redis from 'ioredis';
import logger, { generateCorrelationId } from '../utils/logger.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { withRetry, retryConfigs } from '../utils/retryHandler.js';
import { getStateManager, TaskStates } from '../utils/workerStateManager.js';
import { 
    ensureRepoCloned, 
    createWorktreeForIssue,
    cleanupWorktree,
    getRepoUrl,
    pushBranch
} from '../git/repoManager.js';
import { executeClaudeCode, UsageLimitError } from '../claude/claudeService.js';
import { recordLLMMetrics } from '../utils/llmMetrics.js';
import { validatePRCreation, validateRepositoryInfo } from '../utils/prValidation.js';
import { getDefaultModel } from '../config/modelAliases.js';
import { ErrorCategories } from '../utils/errorHandler.js';
import { 
    formatResetTime, 
    addModelSpecificDelay, 
    safeRemoveLabel, 
    safeAddLabel, 
    safeUpdateLabels, 
    ensureGitRepository, 
    createLogFiles, 
    generateCompletionComment 
} from '../utils/workerUtils.js';
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
        correlatedLogger.error({
            error: authError.message,
            correlationId,
            issueRef
        }, 'Worker: Failed to get authenticated Octokit instance');
        
        try {
            await stateManager.markTaskFailed(taskId, authError, { 
                errorCategory: ErrorCategories.AUTH 
            });
        } catch (stateError) {
            correlatedLogger.warn({ error: stateError.message }, 'Failed to update task state to failed');
        }
        
        throw authError;
    }

    // Initialize variables that need to be accessible in catch block
    let localRepoPath;
    let worktreeInfo;
    let claudeResult = null;
    let postProcessingResult = null;
    let commitResult = null;

    try {
        // Update state to processing
        await stateManager.updateTaskState(taskId, TaskStates.PROCESSING, {
            reason: 'Starting issue processing'
        });
        
        // Get current issue state with retry
        const currentIssueData = await withRetry(
            () => octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
                owner: issueRef.repoOwner,
                repo: issueRef.repoName,
                issue_number: issueRef.number,
            }),
            { ...retryConfigs.githubApi, correlationId },
            `get_issue_${issueRef.number}`
        );

        const currentLabels = currentIssueData.data.labels.map(label => label.name);
        const hasProcessingTag = currentLabels.includes(AI_PROCESSING_TAG);
        const hasPrimaryTag = currentLabels.includes(AI_PRIMARY_TAG);
        const hasDoneTag = currentLabels.includes(AI_DONE_TAG);

        // Validate issue state
        if (!hasPrimaryTag) {
            logger.warn({ 
                jobId, 
                issueNumber: issueRef.number 
            }, `Issue no longer has primary tag '${AI_PRIMARY_TAG}'. Skipping.`);
            return { 
                status: 'skipped', 
                reason: 'Primary tag missing',
                issueNumber: issueRef.number 
            };
        }

        if (hasDoneTag) {
            logger.warn({ 
                jobId, 
                issueNumber: issueRef.number 
            }, `Issue already has '${AI_DONE_TAG}' tag. Skipping.`);
            return { 
                status: 'skipped', 
                reason: 'Already done',
                issueNumber: issueRef.number 
            };
        }

        // Add processing tag if not already present
        if (!hasProcessingTag) {
            logger.info({ 
                jobId, 
                issueNumber: issueRef.number 
            }, `Adding '${AI_PROCESSING_TAG}' tag to issue`);
            
            await safeAddLabel(octokit, issueRef.repoOwner, issueRef.repoName, issueRef.number, AI_PROCESSING_TAG, correlatedLogger);
            
            logger.info({ 
                jobId, 
                issueNumber: issueRef.number 
            }, `Successfully added '${AI_PROCESSING_TAG}' tag`);
        } else {
            logger.info({ 
                jobId, 
                issueNumber: issueRef.number 
            }, `Issue already has '${AI_PROCESSING_TAG}' tag, continuing with processing`);
        }

        logger.info({ 
            jobId, 
            issueNumber: issueRef.number 
        }, 'Starting Git environment setup...');

        // Update progress: Git setup phase
        await job.updateProgress(25);
        
        // Validate repository and get configuration early for use in comments
        logger.info({ 
            jobId, 
            owner: issueRef.repoOwner, 
            repo: issueRef.repoName 
        }, 'Validating repository access...');
        
        const repoValidation = await validateRepositoryInfo(issueRef, octokit, correlationId);
        
        // Get GitHub token for cloning
        const githubToken = await octokit.auth();
        const repoUrl = getRepoUrl(issueRef);
        
        try {
            // Ensure we're in a valid git repository before proceeding
            await ensureGitRepository(correlatedLogger);
            
            // Step 1: Ensure repository is cloned/updated
            logger.info({ 
                jobId, 
                repo: `${issueRef.repoOwner}/${issueRef.repoName}`,
                repoUrl 
            }, 'Cloning/updating repository...');
            
            localRepoPath = await ensureRepoCloned(
                repoUrl, 
                issueRef.repoOwner, 
                issueRef.repoName, 
                githubToken.token
            );
            
            await job.updateProgress(50);
            
            // Step 2: Create worktree for this issue
            logger.info({ 
                jobId, 
                issueNumber: issueRef.number,
                issueTitle: currentIssueData.data.title,
                localRepoPath,
                modelName
            }, 'Creating Git worktree for issue...');
            
            worktreeInfo = await createWorktreeForIssue(
                localRepoPath,
                issueRef.number,
                currentIssueData.data.title,
                issueRef.repoOwner,
                issueRef.repoName,
                null, // Use auto-detected default branch
                octokit, // Pass GitHub API client for better branch detection
                modelName // Pass model name for unique branch/worktree naming
            );
            
            await job.updateProgress(75);
            
            logger.info({ 
                jobId, 
                issueNumber: issueRef.number,
                worktreePath: worktreeInfo.worktreePath,
                branchName: worktreeInfo.branchName
            }, 'Git environment setup complete');
            
            // Add a comment to the issue indicating processing has started with model and branch info
            await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                owner: issueRef.repoOwner,
                repo: issueRef.repoName,
                issue_number: issueRef.number,
                body: `🤖 AI processing has started for this issue using **${modelName}** model.\n\nI'll analyze the problem and work on a solution. This may take a few minutes.\n\n**Processing Details:**\n- Model: \`${modelName}\`\n- Branch: \`${worktreeInfo.branchName}\`\n- Base Branch: \`${repoValidation.repoData.defaultBranch}\`\n- Worktree: \`${worktreeInfo.worktreePath.split('/').pop()}\``,
            });
            
            // Step 3: Push empty branch to GitHub (deterministic setup)
            logger.info({ 
                jobId, 
                issueNumber: issueRef.number,
                branchName: worktreeInfo.branchName
            }, 'Pushing initial branch to GitHub...');
            
            await pushBranch(worktreeInfo.worktreePath, worktreeInfo.branchName, {
                repoUrl,
                authToken: githubToken.token,
                tokenRefreshFn: async () => {
                    const newToken = await octokit.auth();
                    return newToken.token;
                },
                correlationId
            });
            
            logger.info({ 
                jobId, 
                issueNumber: issueRef.number,
                branchName: worktreeInfo.branchName
            }, 'Initial branch pushed successfully');
            
            // Step 4: Execute Claude Code to analyze and fix the issue (AI phase)
            logger.info({ 
                jobId, 
                issueNumber: issueRef.number,
                worktreePath: worktreeInfo.worktreePath
            }, 'Starting Claude Code execution...');
            
            await job.updateProgress(80);
            
            // Fetch issue comments before executing Claude
            let issueComments = [];
            try {
                const allComments = await octokit.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                    owner: issueRef.repoOwner,
                    repo: issueRef.repoName,
                    issue_number: issueRef.number,
                    per_page: 100
                });
                
                // Filter out bot comments (especially gitfixio bot)
                const botUsername = process.env.GITHUB_BOT_USERNAME || 'github-actions[bot]';
                issueComments = allComments.filter(comment => {
                    const isBot = comment.user.login === botUsername || 
                                  comment.user.type === 'Bot' ||
                                  comment.user.login.includes('[bot]') ||
                                  comment.user.login.toLowerCase().includes('gitfixio');
                    return !isBot;
                });
                
                correlatedLogger.info({
                    issueNumber: issueRef.number,
                    totalComments: allComments.length,
                    filteredComments: issueComments.length,
                    botCommentsRemoved: allComments.length - issueComments.length
                }, 'Fetched and filtered issue comments for Claude');
            } catch (commentError) {
                correlatedLogger.warn({
                    issueNumber: issueRef.number,
                    error: commentError.message
                }, 'Failed to fetch issue comments, continuing without them');
            }

            claudeResult = await executeClaudeCode({
                worktreePath: worktreeInfo.worktreePath,
                issueRef: issueRef,
                githubToken: githubToken.token,
                branchName: worktreeInfo.branchName,
                modelName: modelName,
                issueDetails: {
                    title: currentIssueData.data.title,
                    body: currentIssueData.data.body,
                    comments: issueComments,
                    labels: currentIssueData.data.labels,
                    created_at: currentIssueData.data.created_at,
                    updated_at: currentIssueData.data.updated_at,
                    user: currentIssueData.data.user
                },
                onSessionId: async (sessionId, conversationId) => {
                    try {
                        // Update state immediately when sessionId is detected
                        await stateManager.updateTaskState(taskId, TaskStates.CLAUDE_EXECUTION, {
                            reason: 'Claude execution started',
                            claudeResult: {
                                sessionId,
                                conversationId
                            },
                            historyMetadata: {
                                sessionId,
                                conversationId
                            }
                        });
                        
                        // Store placeholder log file path in Redis for live-details API
                        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                        const logDir = '/tmp/claude-logs';
                        
                        // Ensure log directory exists
                        await fs.ensureDir(logDir);
                        
                        const filePrefix = `issue-${issueRef.number}-${timestamp}`;
                        const conversationPath = `${logDir}/${filePrefix}-conversation.json`;
                        
                        // Create placeholder conversation file with initial structure
                        const placeholderConversation = {
                            sessionId: sessionId,
                            conversationId: conversationId,
                            timestamp: new Date().toISOString(),
                            issueNumber: issueRef.number,
                            repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
                            messages: [],
                            _streaming: true
                        };
                        await fs.writeFile(conversationPath, JSON.stringify(placeholderConversation, null, 2));
                        
                        const redis = new Redis({
                            host: process.env.REDIS_HOST || 'redis',
                            port: process.env.REDIS_PORT || 6379
                        });
                        
                        const logData = {
                            files: {
                                conversation: conversationPath
                            },
                            issueNumber: issueRef.number,
                            repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
                            timestamp: timestamp,
                            sessionId: sessionId,
                            conversationId: conversationId
                        };
                        
                        if (sessionId) {
                            const sessionKey = `execution:logs:session:${sessionId}`;
                            await redis.set(sessionKey, JSON.stringify(logData), 'EX', 86400 * 30);
                        }
                        
                        if (conversationId) {
                            const conversationKey = `execution:logs:conversation:${conversationId}`;
                            await redis.set(conversationKey, JSON.stringify(logData), 'EX', 86400 * 30);
                        }
                        
                        await redis.quit();
                        
                        correlatedLogger.info({
                            taskId,
                            sessionId,
                            conversationId,
                            conversationPath
                        }, 'Updated task state with sessionId for live tracking');
                    } catch (error) {
                        correlatedLogger.warn({
                            error: error.message,
                            taskId,
                            sessionId
                        }, 'Failed to update task state with early sessionId');
                    }
                },
                onContainerId: async (containerId, containerName) => {
                    try {
                        // Update state with container info for Docker log access
                        await stateManager.updateHistoryMetadata(taskId, 'claude_execution', {
                            containerId,
                            containerName
                        });
                        correlatedLogger.info({ 
                            taskId, 
                            containerId, 
                            containerName 
                        }, 'Docker container info added to task state');
                    } catch (err) {
                        correlatedLogger.warn({ 
                            taskId, 
                            error: err.message 
                        }, 'Failed to update state with container info');
                    }
                }
            });
            
            // Update task state with Claude execution result (including sessionId for live tracking)
            await stateManager.updateTaskState(taskId, TaskStates.CLAUDE_EXECUTION, {
                reason: 'Claude execution completed',
                claudeResult: {
                    success: claudeResult.success,
                    sessionId: claudeResult.sessionId,
                    conversationId: claudeResult.conversationId,
                    executionTime: claudeResult.executionTime
                },
                historyMetadata: {
                    sessionId: claudeResult.sessionId,
                    conversationId: claudeResult.conversationId,
                    model: claudeResult.model
                }
            });
            
            // Record LLM metrics for issue processing
            await recordLLMMetrics(claudeResult, issueRef, 'issue', correlationId);
            
            logger.info({ 
                jobId, 
                issueNumber: issueRef.number,
                claudeSuccess: claudeResult.success,
                executionTime: claudeResult.executionTime,
                modifiedFiles: claudeResult.modifiedFiles?.length || 0
            }, 'Claude Code execution completed');
            
            // Step 5: Post-processing
            const postProcessResult = await handlePostProcessing({
                jobId,
                issueRef,
                currentIssueData,
                worktreeInfo,
                claudeResult,
                repoValidation,
                repoUrl,
                githubToken,
                octokit,
                correlatedLogger,
                modelName
            });
            
            postProcessingResult = postProcessResult.postProcessingResult;
            commitResult = postProcessResult.commitResult;
            
            await job.updateProgress(95);
            
        } finally {
            // CRITICAL: Always validate PR creation after Claude execution
            await performFinalValidation({
                jobId,
                issueRef,
                claudeResult,
                worktreeInfo,
                postProcessingResult,
                octokit,
                correlatedLogger,
                correlationId,
                githubToken,
                modelName
            });
            
            // Cleanup: Remove worktree after processing with retention strategy
            if (worktreeInfo) {
                try {
                    logger.info({ 
                        jobId, 
                        issueNumber: issueRef.number,
                        worktreePath: worktreeInfo.worktreePath
                    }, 'Cleaning up Git worktree...');
                    
                    const wasSuccessful = claudeResult?.success && postProcessingResult?.pr;
                    
                    await cleanupWorktree(
                        localRepoPath, 
                        worktreeInfo.worktreePath, 
                        worktreeInfo.branchName,
                        {
                            deleteBranch: !wasSuccessful, // Keep branch if successful (it's in the PR)
                            success: wasSuccessful,
                            retentionStrategy: process.env.WORKTREE_RETENTION_STRATEGY || 'always_delete'
                        }
                    );
                } catch (cleanupError) {
                    logger.warn({ 
                        jobId, 
                        issueNumber: issueRef.number,
                        error: cleanupError.message
                    }, 'Failed to cleanup worktree');
                }
            }
        }

        // Update progress tracking
        await job.updateProgress(100);

        const finalStatus = claudeResult?.success ? 
            (postProcessingResult?.pr ? 'complete_with_pr' : 'claude_success_no_changes') : 
            'claude_processing_failed';

        // Enhanced metrics logging for QA framework
        const jobStartTime = Date.now(); // TODO: Extract actual start time from job metadata
        const timeToPR = postProcessingResult?.pr ? (Date.now() - jobStartTime) : null;
        
        // Log comprehensive metrics for system improvement tracking
        correlatedLogger.info({
            // Core identification
            issueNumber: issueRef.number,
            repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
            correlationId,
            taskId,
            
            // Success metrics
            status: finalStatus,
            resolution: claudeResult?.success ? 
                (postProcessingResult?.pr ? 'resolved' : 'no_changes_needed') : 'failed',
            
            // Time-to-PR metrics
            timeToPRMs: timeToPR,
            timeToPRMinutes: timeToPR ? Math.round(timeToPR / 60000) : null,
            
            // Claude performance metrics
            claudeSuccess: claudeResult?.success || false,
            claudeExecutionTimeMs: claudeResult?.executionTime || 0,
            claudeExecutionTimeMinutes: claudeResult?.executionTime ? 
                Math.round(claudeResult.executionTime / 60000) : 0,
            claudeNumTurns: claudeResult?.finalResult?.num_turns || null,
            claudeCostUsd: claudeResult?.finalResult?.cost_usd || null,
            claudeModel: claudeResult?.model || null,
            
            // Processing results
            prCreated: !!postProcessingResult?.pr,
            prNumber: postProcessingResult?.pr?.number || null,
            prUrl: postProcessingResult?.pr?.url || null,
            modifiedFilesCount: claudeResult?.modifiedFiles?.length || 0,
            
            // Failure categorization (if failed)
            failureCategory: !claudeResult?.success ? 
                (claudeResult?.error?.includes('timeout') ? 'timeout' :
                 claudeResult?.error?.includes('API') ? 'api_error' :
                 claudeResult?.error?.includes('git') ? 'git_error' : 'claude_error') : null,
                 
            // System health indicators
            worktreeCreated: !!worktreeInfo,
            branchName: worktreeInfo?.branchName,
            
            // Metadata for analysis
            timestamp: new Date().toISOString(),
            systemVersion: process.env.npm_package_version || 'unknown'
        }, 'Issue processing completed - comprehensive metrics logged');
        
        return { 
            status: finalStatus,
            issueNumber: issueRef.number,
            repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
            gitSetup: {
                localRepoPath: localRepoPath,
                worktreeCreated: !!worktreeInfo,
                branchName: worktreeInfo?.branchName
            },
            claudeResult: {
                success: claudeResult?.success || false,
                executionTime: claudeResult?.executionTime || 0,
                modifiedFiles: claudeResult?.modifiedFiles || [],
                conversationLog: claudeResult?.conversationLog || [],
                error: claudeResult?.error || null,
                sessionId: claudeResult?.sessionId || null,
                conversationId: claudeResult?.conversationId || null,
                model: claudeResult?.model || null
            },
            postProcessing: {
                success: !!postProcessingResult,
                pr: postProcessingResult?.pr || null,
                updatedLabels: postProcessingResult?.updatedLabels || []
            }
        };

    } catch (error) {
        return await handleJobError({
            error,
            jobId,
            issueRef,
            taskId,
            octokit,
            claudeResult,
            worktreeInfo,
            correlatedLogger,
            correlationId,
            stateManager,
            job
        });
    }
}

async function handlePostProcessing(params) {
    const {
        jobId,
        issueRef,
        currentIssueData,
        worktreeInfo,
        claudeResult,
        repoValidation,
        repoUrl,
        githubToken,
        octokit,
        correlatedLogger,
        modelName
    } = params;
    
    let postProcessingResult = null;
    let commitResult = null;
    
    logger.info({ 
        jobId, 
        issueNumber: issueRef.number,
        worktreePath: worktreeInfo.worktreePath,
        claudeSuccess: claudeResult?.success
    }, 'Starting deterministic post-processing...');

    try {
        // Import required modules
        const { commitChanges } = await import('../git/repoManager.js');
        
        // Always attempt to commit any changes Claude may have made
        let commitMessage = `fix(ai): Resolve issue #${issueRef.number} - ${currentIssueData.data.title.substring(0, 50)}

Implemented by Claude Code using ${modelName} model.

${claudeResult?.success ? 'Implementation completed successfully.' : 'Implementation attempted - see PR comments for details.'}`;
        
        if (claudeResult?.suggestedCommitMessage) {
            commitMessage = claudeResult.suggestedCommitMessage;
        }

        // Deterministic commit - always attempt regardless of Claude success
        commitResult = await commitChanges(
            worktreeInfo.worktreePath,
            commitMessage,
            {
                name: 'Claude Code',
                email: 'claude-code@anthropic.com'
            },
            issueRef.number,
            currentIssueData.data.title
        );

        // Deterministic push and PR creation regardless of commit result
        logger.info({
            jobId,
            issueNumber: issueRef.number,
            branchName: worktreeInfo.branchName,
            hasCommits: !!commitResult
        }, 'Pushing changes and creating PR...');

        // Push any changes to remote
        await pushBranch(worktreeInfo.worktreePath, worktreeInfo.branchName, {
            repoUrl,
            authToken: githubToken.token
        });
        
        logger.info({
            jobId,
            issueNumber: issueRef.number,
            branchName: worktreeInfo.branchName
        }, 'Branch pushed to remote successfully');

        // Create PR with completion comment (deterministic)
        let prTitle = `AI Analysis for Issue #${issueRef.number}: ${currentIssueData.data.title}`;
        if (commitResult) {
            prTitle = `AI Fix for Issue #${issueRef.number}: ${currentIssueData.data.title}`;
        }

        // Generate PR body using the completion comment as content
        const completionComment = await generateCompletionComment(claudeResult, issueRef);
        const prBody = `## AI Implementation Summary

${commitResult ? `Closes #${issueRef.number}` : `Addresses #${issueRef.number}`}

**Model Used:** ${modelName}
**Status:** ${claudeResult?.success ? '✅ Implementation Completed' : '⚠️ Analysis Completed'}
**Branch:** \`${worktreeInfo.branchName}\`
**Commits:** ${commitResult ? `✅ Changes committed (${commitResult.commitHash.substring(0, 7)})` : '❌ No changes made'}

---

${completionComment}

---

*This PR was created automatically by Claude Code after processing issue #${issueRef.number}.*`;

        // Create PR using GitHub API directly (more reliable than completePostProcessing)
        try {
            const prResponse = await octokit.request('POST /repos/{owner}/{repo}/pulls', {
                owner: issueRef.repoOwner,
                repo: issueRef.repoName,
                title: prTitle,
                head: worktreeInfo.branchName,
                base: repoValidation.repoData.defaultBranch,
                body: prBody,
                draft: false
            });

            logger.info({
                jobId,
                issueNumber: issueRef.number,
                prNumber: prResponse.data.number,
                prUrl: prResponse.data.html_url
            }, 'PR created successfully');

            // Add the PR label
            try {
                const settings = await loadSettings();
                const prLabel = settings.pr_label || process.env.PR_LABEL || 'gitfix';
                
                await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
                    owner: issueRef.repoOwner,
                    repo: issueRef.repoName,
                    issue_number: prResponse.data.number,
                    labels: [prLabel]
                });
                
                logger.info({
                    jobId,
                    prNumber: prResponse.data.number,
                    label: prLabel
                }, 'Added PR label successfully');
            } catch (labelError) {
                logger.warn({
                    jobId,
                    prNumber: prResponse.data.number,
                    error: labelError.message
                }, 'Failed to add PR label, continuing anyway');
            }

            postProcessingResult = {
                success: true,
                pr: {
                    number: prResponse.data.number,
                    url: prResponse.data.html_url,
                    title: prResponse.data.title
                },
                updatedLabels: []
            };

            logger.info({
                jobId,
                issueNumber: issueRef.number,
                prNumber: prResponse.data.number,
                linkedViaKeyword: commitResult ? 'Closes' : 'Addresses'
            }, 'PR linked to issue via GitHub keyword in description');

        } catch (prError) {
            logger.warn({
                jobId,
                issueNumber: issueRef.number,
                branchName: worktreeInfo.branchName,
                error: prError.message
            }, 'Direct PR creation failed, checking if PR already exists...');

            // Check if PR already exists
            try {
                const existingPRs = await octokit.request('GET /repos/{owner}/{repo}/pulls', {
                    owner: issueRef.repoOwner,
                    repo: issueRef.repoName,
                    head: `${issueRef.repoOwner}:${worktreeInfo.branchName}`,
                    state: 'open'
                });

                if (existingPRs.data.length > 0) {
                    const existingPR = existingPRs.data[0];
                    logger.info({
                        jobId,
                        issueNumber: issueRef.number,
                        prNumber: existingPR.number,
                        prUrl: existingPR.html_url
                    }, 'Found existing PR for branch');

                    postProcessingResult = {
                        success: true,
                        pr: {
                            number: existingPR.number,
                            url: existingPR.html_url,
                            title: existingPR.title
                        },
                        updatedLabels: []
                    };

                    logger.info({
                        jobId,
                        issueNumber: issueRef.number,
                        prNumber: existingPR.number
                    }, 'Found existing PR (linking depends on PR description keywords)');
                } else {
                    throw prError; // Re-throw if no existing PR found
                }
            } catch (checkError) {
                throw prError; // Re-throw original error
            }
        }

        // Update labels after successful processing
        await safeUpdateLabels(
            octokit, 
            issueRef.repoOwner, 
            issueRef.repoName, 
            issueRef.number,
            [AI_PROCESSING_TAG], // Remove processing tag
            [AI_DONE_TAG], // Add done tag
            correlatedLogger
        );

        logger.info({
            jobId,
            issueNumber: issueRef.number,
            prNumber: postProcessingResult.pr?.number,
            prUrl: postProcessingResult.pr?.url
        }, 'Deterministic post-processing completed successfully');

    } catch (postProcessingError) {
        logger.error({
            jobId,
            issueNumber: issueRef.number,
            error: postProcessingError.message,
            stack: postProcessingError.stack
        }, 'Deterministic post-processing failed');

        // Fallback: at least update labels and add completion comment
        try {
            await safeUpdateLabels(
                octokit, 
                issueRef.repoOwner, 
                issueRef.repoName, 
                issueRef.number,
                [AI_PROCESSING_TAG], // Remove processing tag
                [AI_DONE_TAG], // Add done tag
                correlatedLogger
            );

            const completionComment = await generateCompletionComment(claudeResult, issueRef);
            await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                owner: issueRef.repoOwner,
                repo: issueRef.repoName,
                issue_number: issueRef.number,
                body: `⚠️ **Post-processing encountered an error, but Claude analysis was completed.**\n\n${completionComment}`,
            });

            postProcessingResult = {
                success: false,
                pr: null,
                updatedLabels: [AI_DONE_TAG],
                error: postProcessingError.message
            };
        } catch (fallbackError) {
            logger.error({
                jobId,
                issueNumber: issueRef.number,
                error: fallbackError.message
            }, 'Fallback post-processing also failed');
            
            postProcessingResult = {
                success: false,
                pr: null,
                updatedLabels: [],
                error: postProcessingError.message
            };
        }
    }
    
    return { postProcessingResult, commitResult };
}

async function performFinalValidation(params) {
    const {
        jobId,
        issueRef,
        claudeResult,
        worktreeInfo,
        postProcessingResult,
        octokit,
        correlatedLogger,
        correlationId,
        githubToken,
        modelName
    } = params;
    
    correlatedLogger.info({
        jobId,
        issueNumber: issueRef.number,
        workerFinally: 'ENTERED_FINALLY_BLOCK'
    }, 'WORKER DEBUG: Entered finally block - this should ALWAYS appear');

    // Log all variables for debugging with complete details
    correlatedLogger.info({
        jobId,
        issueNumber: issueRef.number,
        claudeResultExists: !!claudeResult,
        claudeSuccess: claudeResult?.success,
        claudeResultType: typeof claudeResult,
        claudeResultKeys: claudeResult ? Object.keys(claudeResult) : null,
        worktreeInfoExists: !!worktreeInfo,
        worktreeInfoType: typeof worktreeInfo,
        branchName: worktreeInfo?.branchName,
        worktreePath: worktreeInfo?.worktreePath,
        worktreeInfoKeys: worktreeInfo ? Object.keys(worktreeInfo) : null,
        postProcessingSuccess: !!postProcessingResult?.pr,
        postProcessingResultExists: !!postProcessingResult,
        postProcessingResultType: typeof postProcessingResult,
        postProcessingResultKeys: postProcessingResult ? Object.keys(postProcessingResult) : null
    }, 'VALIDATION DEBUG: Complete variable state check for final PR validation');

    if (claudeResult?.success && worktreeInfo?.branchName) {
        correlatedLogger.info({
            jobId,
            issueNumber: issueRef.number,
            branchName: worktreeInfo.branchName,
            postProcessingSuccess: !!postProcessingResult?.pr
        }, 'CRITICAL: Performing final PR validation after Claude execution');

        try {
            const finalPRValidation = await validatePRCreation({
                owner: issueRef.repoOwner,
                repoName: issueRef.repoName,
                branchName: worktreeInfo.branchName,
                expectedPrNumber: postProcessingResult?.pr?.number,
                correlationId
            });

            correlatedLogger.info({
                jobId,
                issueNumber: issueRef.number,
                validationResult: finalPRValidation
            }, 'VALIDATION COMPLETED: Final PR validation result');

            if (finalPRValidation.isValid && !postProcessingResult?.pr) {
                // PR exists but post-processing didn't detect it - update our results
                correlatedLogger.info({
                    jobId,
                    issueNumber: issueRef.number,
                    prNumber: finalPRValidation.pr.number,
                    prUrl: finalPRValidation.pr.url
                }, 'Found PR that post-processing missed - updating results and labels');

                // Update post-processing result
                postProcessingResult.pr = finalPRValidation.pr;

                // Update issue labels since post-processing missed the PR
                await safeUpdateLabels(
                    octokit, 
                    issueRef.repoOwner, 
                    issueRef.repoName, 
                    issueRef.number,
                    [AI_PROCESSING_TAG], 
                    [AI_DONE_TAG], 
                    correlatedLogger
                );

            } else if (!finalPRValidation.isValid && claudeResult?.success) {
                // Claude succeeded but no PR exists - trigger retry
                correlatedLogger.warn({
                    jobId,
                    issueNumber: issueRef.number,
                    branchName: worktreeInfo.branchName,
                    validationError: finalPRValidation.error
                }, 'Claude succeeded but no PR found - triggering emergency retry');

                // Validate repository information
                const repoValidation = await validateRepositoryInfo(issueRef, octokit, correlationId);
            
                if (repoValidation.isValid) {
                    // Generate enhanced prompt focused purely on PR creation
                    const emergencyPrompt = `The code changes for GitHub issue #${issueRef.number} have already been implemented and committed to branch ${worktreeInfo.branchName}.

**URGENT TASK: CREATE PULL REQUEST**

**REPOSITORY INFORMATION (USE EXACTLY):**
- Repository: ${issueRef.repoOwner}/${issueRef.repoName}
- Branch: ${worktreeInfo.branchName}
- Base Branch: ${repoValidation.repoData.defaultBranch}
- Issue: #${issueRef.number}

**CRITICAL INSTRUCTIONS:**
1. You are in directory: ${worktreeInfo.worktreePath}
2. The code changes are already committed
3. Your ONLY task is to create a pull request
4. Use: \`gh pr create --title "Fix issue #${issueRef.number}" --body "Resolves #${issueRef.number}"\`
5. DO NOT make any code changes
6. DO NOT commit anything
7. ONLY create the pull request

**VERIFICATION:**
After creating the PR, verify it exists with: \`gh pr list\`

This is an emergency retry - the main implementation is complete, you just need to create the PR.`;

                    // Emergency retry focused only on PR creation
                    const emergencyRetry = await executeClaudeCode({
                        worktreePath: worktreeInfo.worktreePath,
                        issueRef: issueRef,
                        githubToken: githubToken.token,
                        customPrompt: emergencyPrompt,
                        isRetry: true,
                        retryReason: 'Emergency PR creation - main implementation complete',
                        branchName: worktreeInfo.branchName,
                        modelName: modelName
                    });

                    correlatedLogger.info({
                        jobId,
                        issueNumber: issueRef.number,
                        emergencyRetrySuccess: emergencyRetry.success
                    }, 'Emergency PR creation retry completed');

                    // Final validation after emergency retry
                    if (emergencyRetry.success) {
                        const emergencyValidation = await validatePRCreation({
                            owner: issueRef.repoOwner,
                            repoName: issueRef.repoName,
                            branchName: worktreeInfo.branchName,
                            expectedPrNumber: null,
                            correlationId
                        });

                        if (emergencyValidation.isValid) {
                            correlatedLogger.info({
                                jobId,
                                issueNumber: issueRef.number,
                                prNumber: emergencyValidation.pr.number,
                                prUrl: emergencyValidation.pr.url
                            }, 'Emergency PR creation successful');

                            // Update final results
                            postProcessingResult.pr = emergencyValidation.pr;
                        }
                    }
                }
            }
        } catch (validationError) {
            correlatedLogger.error({
                jobId,
                issueNumber: issueRef.number,
                error: validationError.message,
                stack: validationError.stack
            }, 'CRITICAL ERROR: Final PR validation failed with exception');
        }
    } else {
        correlatedLogger.warn({
            jobId,
            issueNumber: issueRef.number,
            claudeResultExists: !!claudeResult,
            claudeSuccess: claudeResult?.success,
            worktreeInfoExists: !!worktreeInfo,
            branchName: worktreeInfo?.branchName
        }, 'VALIDATION SKIPPED: Conditions not met for final PR validation');
    }
}

async function handleJobError(params) {
    const {
        error,
        jobId,
        issueRef,
        taskId,
        octokit,
        claudeResult,
        worktreeInfo,
        correlatedLogger,
        correlationId,
        stateManager,
        job
    } = params;
    
    if (error instanceof UsageLimitError) {
        correlatedLogger.warn({
            jobId,
            issueNumber: issueRef.number,
            resetTimestamp: error.resetTimestamp
        }, 'Claude usage limit hit during issue processing. Requeueing job.');

        const resetTimeUTC = error.resetTimestamp ? (error.resetTimestamp * 1000) : (Date.now() + 60 * 60 * 1000); // Default to 1 hour
        const delay = (resetTimeUTC - Date.now()) + REQUEUE_BUFFER_MS + Math.floor(Math.random() * REQUEUE_JITTER_MS);
        const readableResetTime = formatResetTime(error.resetTimestamp);

        // Add comment to issue notifying user
        if (octokit) {
            try {
                await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                    owner: issueRef.repoOwner,
                    repo: issueRef.repoName,
                    issue_number: issueRef.number,
                    body: `⌛ **Processing Delayed:** Claude's usage limit was reached while processing this issue.
                    
The job has been automatically rescheduled and will restart ${readableResetTime}.
        
---
*Job ID: ${jobId} will run again after delay.*`
                });
            } catch (commentError) {
                correlatedLogger.error({ error: commentError.message }, 'Failed to post usage limit delay comment to issue.');
            }
        }

        // Re-add the job to the queue with the calculated delay
        const { issueQueue } = await import('../queue/taskQueue.js');
        await issueQueue.add(job.name, job.data, { delay: Math.max(0, delay) });

        // Do NOT throw, as this job is handled.
        // We only need to update the state manager to reflect failure (for now) but the job shouldn't fully "fail" in BullMQ
        try {
            await stateManager.markTaskFailed(taskId, error, { 
                errorCategory: ErrorCategories.CLAUDE_EXECUTION,
                processingStage: 'claude_execution',
                requeued: true,
                delay: delay
            });
        } catch (stateError) {
            correlatedLogger.warn({ error: stateError.message }, 'Failed to update task state to failed (requeued)');
        }

    } else {
        // Standard Error Handling for non-usage-limit errors
        const errorCategory = error.message?.includes('authentication') ? 'auth_error' :
                             error.message?.includes('network') ? 'network_error' :
                             error.message?.includes('git') ? 'git_error' :
                             error.message?.includes('GitHub') ? 'github_api_error' :
                             error.message?.includes('timeout') ? 'timeout_error' :
                             'unknown_error';
        
        correlatedLogger.error({ 
            // Core identification
            jobId, 
            issueNumber: issueRef.number,
            repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
            correlationId,
            taskId,
            
            // Error details
            errMessage: error.message, 
            stack: error.stack,
            
            // Failure metrics
            status: 'system_error',
            resolution: 'failed',
            failureCategory: errorCategory,
            
            // Processing state when error occurred
            claudeAttempted: !!claudeResult,
            claudeSuccess: claudeResult?.success || false,
            worktreeCreated: !!worktreeInfo,
            
            // Metadata for analysis
            timestamp: new Date().toISOString(),
            systemVersion: process.env.npm_package_version || 'unknown'
        }, 'Error processing GitHub issue job - enhanced error metrics logged');
        
        // Record LLM metrics even if the job failed, as long as Claude was executed
        if (claudeResult) {
            try {
                await recordLLMMetrics(claudeResult, issueRef, 'issue', correlationId);
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
        
        // Post error to GitHub issue
        if (octokit) {
            try {
                let errorMessage = `❌ **Failed to process this issue**\n\n`;
                errorMessage += `**Error Category:** ${errorCategory.replace('_', ' ')}\n`;
                errorMessage += `**Error Message:** ${error.message}\n\n`;
                
                // Add user-friendly explanations based on error category
                if (errorCategory === 'git_error') {
                    errorMessage += `This appears to be a Git-related issue. The system may have encountered a corrupted repository or git operation failure. `;
                    errorMessage += `The issue will be automatically retried, and any corrupted repositories will be cleaned up.\n\n`;
                } else if (errorCategory === 'auth_error') {
                    errorMessage += `This is an authentication issue. Please ensure the GitHub token has proper permissions.\n\n`;
                } else if (errorCategory === 'network_error') {
                    errorMessage += `This is a network connectivity issue. The system will automatically retry.\n\n`;
                }
                
                errorMessage += `**Processing Stage:** ${claudeResult ? 'Post-processing (after AI analysis)' : 'Pre-processing (before AI analysis)'}\n`;
                
                if (worktreeInfo) {
                    errorMessage += `**Branch:** ${worktreeInfo.branchName}\n`;
                }
                
                errorMessage += `\n<details><summary>Technical Details</summary>\n\n`;
                errorMessage += `\`\`\`\n${error.stack || error.message}\n\`\`\`\n`;
                errorMessage += `</details>\n\n`;
                errorMessage += `---\n*The system will automatically retry this task. If the issue persists, please contact support.*`;
                
                await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                    owner: issueRef.repoOwner,
                    repo: issueRef.repoName,
                    issue_number: issueRef.number,
                    body: errorMessage
                });
                
                // Remove processing label if it exists
                await safeRemoveLabel(
                    octokit,
                    issueRef.repoOwner,
                    issueRef.repoName,
                    issueRef.number,
                    AI_PROCESSING_TAG,
                    correlatedLogger
                );
                
            } catch (commentError) {
                correlatedLogger.error({ 
                    error: commentError.message,
                    issueNumber: issueRef.number
                }, 'Failed to post error comment to GitHub issue');
            }
        }
        
        // Update task state to failed for tracking
        try {
            await stateManager.markTaskFailed(taskId, error, { 
                errorCategory,
                processingStage: claudeResult ? 'post_processing' : 'pre_processing'
            });
        } catch (stateError) {
            correlatedLogger.warn({ error: stateError.message }, 'Failed to update task state to failed');
        }
        
        throw error; // Throw general errors so BullMQ marks the job as failed
    }
}