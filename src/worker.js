import 'dotenv/config';
import { GITHUB_ISSUE_QUEUE_NAME, createWorker } from './queue/taskQueue.js';
import logger, { generateCorrelationId } from './utils/logger.js';
import { getAuthenticatedOctokit } from './auth/githubAuth.js';
import { withErrorHandling, handleError, ErrorCategories } from './utils/errorHandler.js';
import { withRetry, retryConfigs } from './utils/retryHandler.js';
import { getStateManager, TaskStates } from './utils/workerStateManager.js';
import { 
    ensureRepoCloned, 
    createWorktreeForIssue,
    createWorktreeFromExistingBranch,
    cleanupWorktree,
    getRepoUrl,
    commitChanges,
    pushBranch
} from './git/repoManager.js';
import { completePostProcessing } from './githubService.js';
import { executeClaudeCode, buildClaudeDockerImage } from './claude/claudeService.js';
import { 
    validatePRCreation, 
    generateEnhancedClaudePrompt, 
    validateRepositoryInfo 
} from './utils/prValidation.js';
import Redis from 'ioredis';
import { getDefaultModel } from './config/modelAliases.js';

// Configuration
const AI_PROCESSING_TAG = process.env.AI_PROCESSING_TAG || 'AI-processing';
const AI_PRIMARY_TAG = process.env.AI_PRIMARY_TAG || 'AI';
const AI_DONE_TAG = process.env.AI_DONE_TAG || 'AI-done';
const DEFAULT_MODEL_NAME = process.env.DEFAULT_CLAUDE_MODEL || getDefaultModel();

/**
 * Adds a small random delay to prevent concurrent execution conflicts
 * @param {string} modelName - Model name to create consistent but different delays
 * @returns {Promise<void>}
 */
function addModelSpecificDelay(modelName) {
    // Create a consistent but different delay for each model (500-2000ms)
    const baseDelay = 500;
    const modelHash = modelName.split('').reduce((hash, char) => {
        return ((hash << 5) - hash + char.charCodeAt(0)) & 0xffffffff;
    }, 0);
    const modelDelay = Math.abs(modelHash % 1500); // 0-1499ms additional delay
    const totalDelay = baseDelay + modelDelay;
    
    return new Promise(resolve => setTimeout(resolve, totalDelay));
}

/**
 * Safely removes a label from an issue, ignoring errors if label doesn't exist
 * @param {Object} octokit - GitHub API client
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {number} issueNumber - Issue number
 * @param {string} labelName - Label to remove
 * @param {Object} logger - Logger instance
 * @returns {Promise<boolean>} - True if removed or didn't exist, false if other error
 */
async function safeRemoveLabel(octokit, owner, repo, issueNumber, labelName, logger) {
    try {
        await octokit.request('DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', {
            owner,
            repo,
            issue_number: issueNumber,
            name: labelName
        });
        logger.debug(`Successfully removed label '${labelName}' from issue #${issueNumber}`);
        return true;
    } catch (error) {
        if (error.status === 404) {
            logger.debug(`Label '${labelName}' not found on issue #${issueNumber}, skipping removal`);
            return true; // Label doesn't exist, which is fine
        }
        logger.warn({ 
            error: error.message, 
            labelName, 
            issueNumber,
            status: error.status 
        }, `Failed to remove label '${labelName}' from issue #${issueNumber}`);
        return false;
    }
}

/**
 * Safely adds a label to an issue, ignoring errors if label already exists
 * @param {Object} octokit - GitHub API client
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {number} issueNumber - Issue number
 * @param {string} labelName - Label to add
 * @param {Object} logger - Logger instance
 * @returns {Promise<boolean>} - True if added or already exists, false if other error
 */
async function safeAddLabel(octokit, owner, repo, issueNumber, labelName, logger) {
    try {
        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
            owner,
            repo,
            issue_number: issueNumber,
            labels: [labelName]
        });
        logger.debug(`Successfully added label '${labelName}' to issue #${issueNumber}`);
        return true;
    } catch (error) {
        if (error.status === 422 && error.message?.includes('already exists')) {
            logger.debug(`Label '${labelName}' already exists on issue #${issueNumber}`);
            return true; // Label already exists, which is fine
        }
        logger.warn({ 
            error: error.message, 
            labelName, 
            issueNumber,
            status: error.status 
        }, `Failed to add label '${labelName}' to issue #${issueNumber}`);
        return false;
    }
}

/**
 * Safely updates issue labels with robust error handling
 * @param {Object} octokit - GitHub API client
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {number} issueNumber - Issue number
 * @param {Array<string>} labelsToRemove - Labels to remove
 * @param {Array<string>} labelsToAdd - Labels to add
 * @param {Object} logger - Logger instance
 * @returns {Promise<Object>} - Result with success status and any errors
 */
async function safeUpdateLabels(octokit, owner, repo, issueNumber, labelsToRemove = [], labelsToAdd = [], logger) {
    const results = {
        success: true,
        removed: [],
        added: [],
        errors: []
    };

    // Remove labels
    for (const labelName of labelsToRemove) {
        const removed = await safeRemoveLabel(octokit, owner, repo, issueNumber, labelName, logger);
        if (removed) {
            results.removed.push(labelName);
        } else {
            results.success = false;
            results.errors.push(`Failed to remove '${labelName}'`);
        }
    }

    // Add labels
    for (const labelName of labelsToAdd) {
        const added = await safeAddLabel(octokit, owner, repo, issueNumber, labelName, logger);
        if (added) {
            results.added.push(labelName);
        } else {
            results.success = false;
            results.errors.push(`Failed to add '${labelName}'`);
        }
    }

    logger.info({
        issueNumber,
        removed: results.removed,
        added: results.added,
        errors: results.errors.length > 0 ? results.errors : undefined
    }, 'Label update completed');

    return results;
}

/**
 * Processes a GitHub issue job from the queue
 * @param {import('bullmq').Job} job - The job to process
 * @returns {Promise<Object>} Processing result
 */
async function processPullRequestCommentJob(job) {
    const {
        pullRequestNumber,
        commentId,
        commentBody,
        commentAuthor,
        comments,  // New batch format
        branchName,
        repoOwner,
        repoName,
        llm,
        correlationId
    } = job.data;
    const correlatedLogger = logger.withCorrelation(correlationId);
    
    // Check if this is a batch job or single comment job
    const isBatchJob = !!comments && Array.isArray(comments);
    const commentsToProcess = isBatchJob ? comments : [{
        id: commentId,
        body: commentBody,
        author: commentAuthor
    }];
    
    correlatedLogger.info({ 
        pullRequestNumber, 
        branchName, 
        llm,
        isBatchJob,
        commentsCount: commentsToProcess.length
    }, `Processing PR comment${isBatchJob ? 's batch' : ''} job...`);

    let octokit;
    let localRepoPath;
    let worktreeInfo;

    try {
        // Get authenticated Octokit instance
        octokit = await withRetry(
            () => getAuthenticatedOctokit(),
            { ...retryConfigs.githubApi, correlationId },
            'get_authenticated_octokit'
        );

        // Check if comments have already been processed
        const botUsername = process.env.GITHUB_BOT_USERNAME || 'github-actions[bot]';
        const prComments = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner: repoOwner,
            repo: repoName,
            issue_number: pullRequestNumber,
            per_page: 100,
            page: 1
        });

        // Filter out already processed comments
        const unprocessedComments = commentsToProcess.filter(comment => {
            const alreadyProcessed = prComments.data.some(prComment => {
                const isBotComment = prComment.user.login === botUsername || 
                                    prComment.user.type === 'Bot' ||
                                    prComment.user.login.includes('[bot]');
                
                if (!isBotComment) return false;
                
                // Check if the bot comment references this specific comment ID
                const referencesThisComment = prComment.body.includes(`Comment ID: ${comment.id}`) ||
                                            prComment.body.includes(`comment #${comment.id}`) ||
                                            prComment.body.includes(`Processing comment ID: ${comment.id}`);
                
                return referencesThisComment;
            });
            
            if (alreadyProcessed) {
                correlatedLogger.debug({
                    pullRequestNumber,
                    commentId: comment.id,
                    commentAuthor: comment.author
                }, 'Comment already processed, filtering out');
            }
            
            return !alreadyProcessed;
        });

        if (unprocessedComments.length === 0) {
            correlatedLogger.info({
                pullRequestNumber,
                originalCount: commentsToProcess.length
            }, 'All PR comments have already been processed, skipping');
            
            return { 
                status: 'skipped', 
                reason: 'already_processed',
                pullRequestNumber 
            };
        }

        // Build combined comment body for prompt
        let combinedCommentBody;
        let commentAuthors = [];
        
        if (unprocessedComments.length === 1) {
            combinedCommentBody = unprocessedComments[0].body;
            commentAuthors = [unprocessedComments[0].author];
        } else {
            // Format multiple comments
            combinedCommentBody = unprocessedComments.map((comment, index) => {
                return `**Comment ${index + 1}** (by @${comment.author}):\n${comment.body}`;
            }).join('\n\n---\n\n');
            commentAuthors = [...new Set(unprocessedComments.map(c => c.author))];
        }

        // Post a "starting work" comment with reference to all comment IDs
        const commentIds = unprocessedComments.map(c => c.id).join(', ');
        const authorsText = commentAuthors.map(a => `@${a}`).join(', ');
        
        const startingWorkComment = await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner: repoOwner,
            repo: repoName,
            issue_number: pullRequestNumber,
            body: `🔄 **Starting work on follow-up changes** requested by ${authorsText}\n\nI'll analyze the ${unprocessedComments.length} request${unprocessedComments.length > 1 ? 's' : ''} and implement the necessary changes.\n\n---\n_Processing comment ID${unprocessedComments.length > 1 ? 's' : ''}: ${commentIds}_`,
        });

        const githubToken = await octokit.auth();
        const repoUrl = getRepoUrl({ repoOwner, repoName });

        // Step 1: Ensure repository is cloned
        localRepoPath = await ensureRepoCloned(repoUrl, repoOwner, repoName, githubToken.token);

        // Step 2: Create a worktree from the existing PR branch
        // Generate unique worktree name for this follow-up task
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
        const worktreeDirName = `pr-${pullRequestNumber}-followup-${timestamp}`;

        // Use the proper function to create worktree from existing branch
        worktreeInfo = await createWorktreeFromExistingBranch(
            localRepoPath,
            branchName,
            worktreeDirName,
            repoOwner,
            repoName
        );

        correlatedLogger.info({ 
            worktreePath: worktreeInfo.worktreePath, 
            branchName: worktreeInfo.branchName 
        }, 'Created worktree from existing PR branch');

        // Step 3: Generate prompt for follow-up changes
        const prompt = `You are working on an existing pull request branch. ${unprocessedComments.length > 1 ? `Users have requested the following ${unprocessedComments.length} follow-up changes` : 'A user has requested the following follow-up change'}:

${combinedCommentBody}

**CRITICAL INSTRUCTIONS:**
- You are in directory: ${worktreeInfo.worktreePath}
- The current branch already contains changes for pull request #${pullRequestNumber}
- Analyze the existing code on this branch
- Implement ONLY the changes requested in the comment above
- DO NOT commit your changes - the system will handle the commit for you
- DO NOT create a new pull request
- The repository is ${repoOwner}/${repoName}

**Context:**
- This is a follow-up to an existing PR
- Make sure your changes are compatible with the existing modifications on this branch
- Use appropriate commit messages that reference the follow-up nature of the changes`;

        // Step 4: Execute Claude Code with the follow-up prompt
        const claudeResult = await executeClaudeCode({
            worktreePath: worktreeInfo.worktreePath,
            issueRef: { 
                number: pullRequestNumber, 
                repoOwner, 
                repoName 
            },
            githubToken: githubToken.token,
            customPrompt: prompt,
            branchName: worktreeInfo.branchName,
            modelName: llm || DEFAULT_MODEL_NAME
        });

        if (!claudeResult.success) {
            throw new Error(`Claude execution failed: ${claudeResult.error || 'Unknown error'}`);
        }

        // Step 5: Commit and push changes
        // Extract a summary from Claude's result
        let changesSummary = '';
        if (claudeResult.summary) {
            changesSummary = claudeResult.summary;
        } else if (claudeResult.finalResult?.result) {
            changesSummary = claudeResult.finalResult.result;
        }

        // Parse the summary to extract key changes
        let commitDetails = '';
        if (changesSummary) {
            // Try to extract bullet points or key changes
            const lines = changesSummary.split('\n');
            const changeLines = lines.filter(line => 
                line.trim().startsWith('-') || 
                line.trim().startsWith('*') || 
                line.trim().startsWith('•') ||
                line.match(/^\d+\./)
            ).slice(0, 10); // Limit to 10 key points
            
            if (changeLines.length > 0) {
                commitDetails = '\n\nKey changes:\n' + changeLines.join('\n');
            }
        }

        // Build commit message with all comment references
        const commentReferences = unprocessedComments.map(c => 
            `Comment by: @${c.author} (ID: ${c.id})`
        ).join('\n');
        
        const commitMessage = `feat(ai): Apply follow-up changes from PR ${unprocessedComments.length > 1 ? 'comments' : 'comment'}

${changesSummary ? changesSummary.split('\n')[0] : `Implemented changes requested by ${authorsText}`}${commitDetails}

PR: #${pullRequestNumber}
${commentReferences}
Model: ${claudeResult.model || llm || DEFAULT_MODEL_NAME}`;

        const commitResult = await commitChanges(
            worktreeInfo.worktreePath,
            commitMessage,
            { name: 'Claude Code', email: 'claude-code@anthropic.com' },
            pullRequestNumber,
            'Follow-up changes'
        );

        if (commitResult) {
            await pushBranch(worktreeInfo.worktreePath, worktreeInfo.branchName, {
                repoUrl,
                authToken: githubToken.token
            });

            // Step 6: Add confirmation comment to the PR
            let prCommentBody = `✅ **Applied the requested follow-up changes** in commit ${commitResult.commitHash.substring(0, 7)}\n\n`;
            
            // Add reference to all processed comments
            if (unprocessedComments.length > 1) {
                prCommentBody += `Processed ${unprocessedComments.length} comments:\n`;
                unprocessedComments.forEach((comment, index) => {
                    prCommentBody += `- Comment ${index + 1} by @${comment.author} (ID: ${comment.id})\n`;
                });
                prCommentBody += '\n';
            }
            
            // Add the actual changes summary
            if (changesSummary) {
                prCommentBody += `## Summary of Changes\n\n`;
                
                // Extract the most relevant parts of the summary
                const summaryLines = changesSummary.split('\n');
                let includedSummary = false;
                
                // Look for sections that describe what was done
                for (let i = 0; i < summaryLines.length; i++) {
                    const line = summaryLines[i];
                    
                    // Include headers and bullet points
                    if (line.match(/^#+\s/) || line.trim().startsWith('-') || 
                        line.trim().startsWith('*') || line.trim().startsWith('•') ||
                        line.match(/^\d+\./)) {
                        prCommentBody += line + '\n';
                        includedSummary = true;
                    } else if (includedSummary && line.trim() === '') {
                        prCommentBody += '\n';
                    } else if (includedSummary && !line.match(/^#+\s/) && i < 50) {
                        // Include descriptive text after headers/bullets (limit lines)
                        prCommentBody += line + '\n';
                    }
                }
                
                prCommentBody += '\n';
            }
            
            prCommentBody += `---\n`;
            prCommentBody += `🤖 **Implemented by Claude Code**\n`;
            prCommentBody += `- Requested by: ${authorsText}\n`;
            prCommentBody += `- Model: ${claudeResult.model || llm || DEFAULT_MODEL_NAME}\n`;
            if (claudeResult.finalResult?.num_turns) {
                prCommentBody += `- Turns: ${claudeResult.finalResult.num_turns}\n`;
            }
            if (claudeResult.executionTime) {
                prCommentBody += `- Execution time: ${Math.round(claudeResult.executionTime / 1000)}s\n`;
            }
            const cost = claudeResult.finalResult?.total_cost_usd || claudeResult.finalResult?.cost_usd;
            if (cost) {
                prCommentBody += `- Cost: $${cost.toFixed(2)}\n`;
            }

            await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                owner: repoOwner,
                repo: repoName,
                issue_number: pullRequestNumber,
                body: prCommentBody,
            });

            // Delete the "starting work" comment
            if (startingWorkComment?.data?.id) {
                await octokit.request('DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}', {
                    owner: repoOwner,
                    repo: repoName,
                    comment_id: startingWorkComment.data.id,
                });
                correlatedLogger.info({
                    commentId: startingWorkComment.data.id
                }, 'Deleted starting work comment');
            }

            correlatedLogger.info({
                pullRequestNumber,
                commitHash: commitResult.commitHash
            }, 'Successfully applied follow-up changes');
        } else {
            // No changes were necessary
            let noChangesBody = `ℹ️ **Analyzed the follow-up request** by @${commentAuthor}\n\n`;
            
            if (changesSummary) {
                noChangesBody += `## Analysis Summary\n\n${changesSummary}\n\n`;
            }
            
            noChangesBody += `No code changes were necessary based on the current state of the branch.\n\n`;
            noChangesBody += `---\n`;
            noChangesBody += `🤖 **Analysis by Claude Code**\n`;
            noChangesBody += `- Model: ${claudeResult.model || llm || DEFAULT_MODEL_NAME}\n`;
            if (claudeResult.executionTime) {
                noChangesBody += `- Analysis time: ${Math.round(claudeResult.executionTime / 1000)}s\n`;
            }
            const analysisCost = claudeResult.finalResult?.total_cost_usd || claudeResult.finalResult?.cost_usd;
            if (analysisCost) {
                noChangesBody += `- Cost: $${analysisCost.toFixed(2)}\n`;
            }
            
            await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                owner: repoOwner,
                repo: repoName,
                issue_number: pullRequestNumber,
                body: noChangesBody,
            });

            // Delete the "starting work" comment
            if (startingWorkComment?.data?.id) {
                await octokit.request('DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}', {
                    owner: repoOwner,
                    repo: repoName,
                    comment_id: startingWorkComment.data.id,
                });
                correlatedLogger.info({
                    commentId: startingWorkComment.data.id
                }, 'Deleted starting work comment after no-changes analysis');
            }
        }

        return { 
            status: 'complete', 
            commit: commitResult?.commitHash,
            pullRequestNumber 
        };

    } catch (error) {
        handleError(error, 'Failed to process PR comment job', { correlationId });
        
        // Add error comment to the PR
        if (octokit) {
            try {
                await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                    owner: repoOwner,
                    repo: repoName,
                    issue_number: pullRequestNumber,
                    body: `❌ **Failed to apply follow-up changes** requested by ${authorsText}

An error occurred while processing your request:

\`\`\`
${error.message}
\`\`\`

---
Comment ID${unprocessedComments.length > 1 ? 's' : ''}: ${commentIds}
Please check the logs for more details.`,
                });

                // Delete the "starting work" comment even on error
                if (startingWorkComment?.data?.id) {
                    try {
                        await octokit.request('DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}', {
                            owner: repoOwner,
                            repo: repoName,
                            comment_id: startingWorkComment.data.id,
                        });
                        correlatedLogger.info({
                            commentId: startingWorkComment.data.id
                        }, 'Deleted starting work comment after error');
                    } catch (deleteError) {
                        correlatedLogger.error({ error: deleteError.message }, 'Failed to delete starting work comment');
                    }
                }
            } catch (commentError) {
                correlatedLogger.error({ error: commentError.message }, 'Failed to post error comment');
            }
        }
        
        throw error;
    } finally {
        // Cleanup worktree
        if (localRepoPath && worktreeInfo) {
            try {
                await cleanupWorktree(localRepoPath, worktreeInfo.worktreePath, worktreeInfo.branchName, {
                    deleteBranch: false, // Never delete the branch for PR follow-ups
                    success: true
                });
            } catch (cleanupError) {
                correlatedLogger.warn({ error: cleanupError.message }, 'Failed to cleanup worktree');
            }
        }
    }
}

async function processGitHubIssueJob(job) {
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
    
    // Create task state
    const taskId = `${issueRef.repoOwner}-${issueRef.repoName}-${issueRef.number}`;
    
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
                errorCategory: errorDetails.category 
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

        // Initial comment will be added after worktree creation to include branch info

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
                authToken: githubToken.token
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
            
            correlatedLogger.info({
                jobId,
                issueNumber: issueRef.number,
                worktreePath: worktreeInfo.worktreePath
            }, 'EXECUTION DEBUG: About to execute Claude Code');

            claudeResult = await executeClaudeCode({
                worktreePath: worktreeInfo.worktreePath,
                issueRef: issueRef,
                githubToken: githubToken.token,
                branchName: worktreeInfo.branchName,
                modelName: modelName
            });
            
            correlatedLogger.info({
                jobId,
                issueNumber: issueRef.number,
                claudeSuccess: claudeResult.success,
                claudeResultStructure: {
                    success: claudeResult.success,
                    executionTime: claudeResult.executionTime,
                    modifiedFilesCount: claudeResult.modifiedFiles?.length || 0,
                    hasOutput: !!claudeResult.output,
                    exitCode: claudeResult.exitCode,
                    hasLogs: !!claudeResult.logs
                }
            }, 'EXECUTION DEBUG: Claude Code execution completed');

            logger.info({ 
                jobId, 
                issueNumber: issueRef.number,
                claudeSuccess: claudeResult.success,
                executionTime: claudeResult.executionTime,
                modifiedFiles: claudeResult.modifiedFiles?.length || 0,
                claudeOutputSample: claudeResult.output?.rawOutput?.substring(0, 500),
                claudeFullOutput: claudeResult.output,
                claudeExitCode: claudeResult.exitCode,
                claudeLogs: claudeResult.logs
            }, 'Claude Code execution completed - detailed output');
            
            // Check what files exist in the worktree after Claude execution
            try {
                const fs = await import('fs');
                const path = await import('path');
                
                const listFiles = (dir) => {
                    const files = [];
                    const items = fs.readdirSync(dir);
                    for (const item of items) {
                        const fullPath = path.join(dir, item);
                        const stat = fs.statSync(fullPath);
                        if (stat.isDirectory() && !item.startsWith('.')) {
                            files.push(...listFiles(fullPath));
                        } else if (stat.isFile()) {
                            files.push(fullPath);
                        }
                    }
                    return files;
                };
                
                const filesInWorktree = listFiles(worktreeInfo.worktreePath);
                
                logger.info({
                    jobId,
                    issueNumber: issueRef.number,
                    worktreePath: worktreeInfo.worktreePath,
                    filesInWorktree,
                    fileCount: filesInWorktree.length
                }, 'Files in worktree after Claude execution');
                
            } catch (listError) {
                logger.warn({
                    jobId,
                    issueNumber: issueRef.number,
                    error: listError.message
                }, 'Failed to list files in worktree');
            }
            
            // Step 5: Post-processing (deterministic commit, push, and PR creation)
            logger.info({ 
                jobId, 
                issueNumber: issueRef.number,
                worktreePath: worktreeInfo.worktreePath,
                claudeSuccess: claudeResult?.success
            }, 'Starting deterministic post-processing...');

            try {
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
            
            await job.updateProgress(95);
            
        } finally {
            // CRITICAL: Always validate PR creation after Claude execution, regardless of post-processing results
            // This catches cases where Claude creates PR independently but our system doesn't detect it
            
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
                        postProcessingResult = { 
                            pr: finalPRValidation.pr, 
                            updatedLabels: postProcessingResult?.updatedLabels || [] 
                        };

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
                                    postProcessingResult = { 
                                        pr: emergencyValidation.pr, 
                                        updatedLabels: [] 
                                    };
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
                error: claudeResult?.error || null
            },
            postProcessing: {
                success: !!postProcessingResult,
                pr: postProcessingResult?.pr || null,
                updatedLabels: postProcessingResult?.updatedLabels || []
            }
        };

    } catch (error) {
        // Enhanced error metrics logging for QA framework
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
        
        // Update task state to failed for tracking
        try {
            await stateManager.markTaskFailed(taskId, error, { 
                errorCategory,
                processingStage: claudeResult ? 'post_processing' : 'pre_processing'
            });
        } catch (stateError) {
            correlatedLogger.warn({ error: stateError.message }, 'Failed to update task state to failed');
        }
        
        throw error;
    }
}

/**
 * Creates log files for detailed Claude execution data
 * @param {Object} claudeResult - Result from Claude Code execution
 * @param {Object} issueRef - Issue reference
 * @returns {Promise<Object>} File paths and metadata
 */
async function createLogFiles(claudeResult, issueRef) {
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    
    const logDir = path.join(os.tmpdir(), 'claude-logs');
    await fs.promises.mkdir(logDir, { recursive: true });
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePrefix = `issue-${issueRef.number}-${timestamp}`;
    
    const files = {};
    
    // Create conversation log file
    if (claudeResult?.conversationLog && claudeResult.conversationLog.length > 0) {
        const conversationPath = path.join(logDir, `${filePrefix}-conversation.json`);
        const conversationData = {
            sessionId: claudeResult.sessionId,
            conversationId: claudeResult.conversationId,
            model: claudeResult.model,
            timestamp: new Date().toISOString(),
            issueNumber: issueRef.number,
            repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
            messages: claudeResult.conversationLog
        };
        await fs.promises.writeFile(conversationPath, JSON.stringify(conversationData, null, 2));
        files.conversation = conversationPath;
        logger.info({ conversationPath, messageCount: claudeResult.conversationLog.length }, 'Created conversation log file');
    }
    
    // Create raw output file
    if (claudeResult?.rawOutput) {
        const outputPath = path.join(logDir, `${filePrefix}-output.txt`);
        await fs.promises.writeFile(outputPath, claudeResult.rawOutput);
        files.output = outputPath;
        logger.info({ outputPath, size: claudeResult.rawOutput.length }, 'Created raw output log file');
    }
    
    return files;
}


/**
 * Generates a detailed completion comment for GitHub issues
 * @param {Object} claudeResult - Result from Claude Code execution
 * @param {Object} issueRef - Issue reference
 * @returns {Promise<string>} Formatted completion comment
 */
async function generateCompletionComment(claudeResult, issueRef) {
    const timestamp = new Date().toISOString();
    const isSuccess = claudeResult?.success || false;
    const executionTime = Math.round((claudeResult?.executionTime || 0) / 1000);
    
    let comment = `🤖 **AI Processing ${isSuccess ? 'Completed' : 'Failed'}**\n\n`;
    comment += `**Execution Details:**\n`;
    comment += `- Issue: #${issueRef.number}\n`;
    comment += `- Repository: ${issueRef.repoOwner}/${issueRef.repoName}\n`;
    comment += `- Status: ${isSuccess ? '✅ Success' : '❌ Failed'}\n`;
    comment += `- Execution Time: ${executionTime}s\n`;
    comment += `- Timestamp: ${timestamp}\n`;
    
    // Add conversation ID if available
    if (claudeResult?.conversationId) {
        comment += `- Conversation ID: \`${claudeResult.conversationId}\`\n`;
    }
    
    // Add model information if available
    if (claudeResult?.model) {
        // Use the raw model ID directly
        comment += `- LLM Model: ${claudeResult.model}\n`;
    }
    
    comment += `\n`;
    
    if (claudeResult?.summary) {
        comment += `**Summary:**\n${claudeResult.summary}\n\n`;
    }
    
    if (claudeResult?.finalResult) {
        const result = claudeResult.finalResult;
        comment += `**Claude Code Results:**\n`;
        comment += `- Turns Used: ${result.num_turns || 'unknown'}\n`;
        comment += `- Cost: $${result.cost_usd || 'unknown'}\n`;
        comment += `- Session ID: \`${claudeResult.sessionId || 'unknown'}\`\n\n`;
        
        if (result.subtype === 'error_max_turns') {
            comment += `⚠️ **Max Turns Reached**: Claude reached the maximum number of conversation turns (${result.num_turns}) before completing all tasks. Consider increasing the turn limit or breaking down the task into smaller parts.\n\n`;
        }
    }
    
    // Create log files and include summaries in comment
    try {
        const logFiles = await createLogFiles(claudeResult, issueRef);
        
        if (Object.keys(logFiles).length > 0) {
            comment += `**📁 Detailed Logs:**\n`;
            comment += `Execution logs generated:\n`;
            
            // Add conversation summary
            if (logFiles.conversation && claudeResult.conversationLog?.length > 0) {
                comment += `- Conversation: ${claudeResult.conversationLog.length} messages\n`;
                comment += `- Session: \`${claudeResult.sessionId}\`\n`;
            }
            
            // Add output summary
            if (logFiles.output) {
                comment += `- Raw Output: ${(claudeResult.rawOutput?.length || 0).toLocaleString()} characters\n`;
            }
            
            // Add log file paths for debugging
            comment += `\nLog files stored at:\n`;
            Object.entries(logFiles).forEach(([type, path]) => {
                comment += `- ${type}: \`${path}\`\n`;
            });
            
            comment += `\n<details>\n<summary>💬 Latest Conversation Messages</summary>\n\n`;
            if (claudeResult.conversationLog && claudeResult.conversationLog.length > 0) {
                const lastMessages = claudeResult.conversationLog.slice(-3);
                comment += `\`\`\`\n`;
                lastMessages.forEach(msg => {
                    if (msg.type === 'assistant') {
                        const content = msg.message?.content?.[0]?.text || '[content unavailable]';
                        const preview = content.substring(0, 200);
                        comment += `ASSISTANT: ${preview}${content.length > 200 ? '...' : ''}\n\n`;
                    }
                });
                comment += `\`\`\`\n`;
            }
            comment += `</details>\n\n`;
        }
    } catch (logError) {
        logger.warn({
            issueNumber: issueRef.number,
            error: logError.message
        }, 'Failed to create log files');
    }
    
    comment += `---\n*Powered by Claude Code v${process.env.npm_package_version || 'unknown'}*`;
    
    return comment;
}

/**
 * Resets all worker-related queue data
 */
async function resetWorkerQueues() {
    logger.info('Resetting worker queue data...');
    
    try {
        const redis = new Redis({
            host: process.env.REDIS_HOST || '127.0.0.1',
            port: parseInt(process.env.REDIS_PORT || '6379', 10),
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
        });

        // Get all keys related to our queue
        const queueName = GITHUB_ISSUE_QUEUE_NAME;
        const keys = await redis.keys(`bull:${queueName}:*`);
        
        if (keys.length > 0) {
            logger.info({
                queueName,
                keysCount: keys.length
            }, 'Found worker queue keys to delete');
            
            // Delete all queue-related keys
            await redis.del(...keys);
            
            logger.info({
                queueName,
                deletedKeys: keys.length
            }, 'Successfully cleared all worker queue data');
        } else {
            logger.info({ queueName }, 'No worker queue data found to clear');
        }
        
        // Clean up Redis connection
        await redis.quit();
        
    } catch (error) {
        logger.error({ error: error.message }, 'Failed to reset worker queue data');
        throw error;
    }
}

/**
 * Parse command line arguments
 */
function parseArguments() {
    const args = process.argv.slice(2);
    const options = {
        reset: false,
        help: false
    };
    
    for (const arg of args) {
        switch (arg) {
            case '--reset':
                options.reset = true;
                break;
            case '--help':
            case '-h':
                options.help = true;
                break;
            default:
                if (arg.startsWith('--')) {
                    logger.warn({ argument: arg }, 'Unknown command line argument');
                }
        }
    }
    
    return options;
}

/**
 * Display help information
 */
function showHelp() {
    console.log(`
GitHub Issue Worker

Usage: node src/worker.js [options]

Options:
  --reset    Clear all queue data before starting worker
  --help     Show this help message

Examples:
  node src/worker.js                 # Start worker normally
  node src/worker.js --reset         # Reset queues and start worker
`);
}

/**
 * Starts the worker process
 */
async function startWorker(options = {}) {
    logger.info({
        queue: GITHUB_ISSUE_QUEUE_NAME,
        processingTag: AI_PROCESSING_TAG,
        primaryTag: AI_PRIMARY_TAG,
        doneTag: AI_DONE_TAG,
        resetPerformed: options.reset || false
    }, 'Starting GitHub Issue Worker...');
    
    // Initialize Redis connection for heartbeat
    const heartbeatRedis = new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT || 6379,
        retryStrategy: times => Math.min(times * 50, 2000)
    });
    
    // Function to send heartbeat
    const sendHeartbeat = async () => {
        try {
            await heartbeatRedis.set('system:status:worker', Date.now(), 'EX', 90);
            logger.debug('Worker heartbeat sent');
        } catch (error) {
            logger.error({ error: error.message }, 'Failed to send worker heartbeat');
        }
    };
    
    // Send initial heartbeat
    await sendHeartbeat();
    
    // Set up heartbeat interval (every 30 seconds)
    const heartbeatInterval = setInterval(sendHeartbeat, 30000);
    
    // Ensure Claude Docker image is built before starting worker
    logger.info('Checking Claude Code Docker image...');
    const imageReady = await buildClaudeDockerImage();
    
    if (!imageReady) {
        logger.error('Failed to build Claude Code Docker image. Worker may not function properly.');
        // Continue anyway - worker can still handle Git operations
    } else {
        logger.info('Claude Code Docker image is ready');
    }
    
    const worker = createWorker(GITHUB_ISSUE_QUEUE_NAME, async (job) => {
        if (job.name === 'processGitHubIssue') {
            return processGitHubIssueJob(job);
        } else if (job.name === 'processPullRequestComment') {
            return processPullRequestCommentJob(job);
        } else {
            throw new Error(`Unknown job type: ${job.name}`);
        }
    });

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
        logger.info('Worker received SIGINT, shutting down gracefully...');
        clearInterval(heartbeatInterval);
        await heartbeatRedis.quit();
        await worker.close();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        logger.info('Worker received SIGTERM, shutting down gracefully...');
        clearInterval(heartbeatInterval);
        await heartbeatRedis.quit();
        await worker.close();
        process.exit(0);
    });

    return worker;
}

// Export for testing
export { processGitHubIssueJob, processPullRequestCommentJob, startWorker };

// Start worker if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
    const options = parseArguments();
    
    if (options.help) {
        showHelp();
        process.exit(0);
    }
    
    async function main() {
        try {
            if (options.reset) {
                logger.info('Reset flag detected, clearing worker queue data...');
                await resetWorkerQueues();
                logger.info('Worker reset completed successfully');
            }
            
            await startWorker(options);
        } catch (error) {
            logger.error({ error: error.message }, 'Failed to start worker');
            process.exit(1);
        }
    }
    
    main();
}