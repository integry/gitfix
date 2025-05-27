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

// Configuration
const AI_PROCESSING_TAG = process.env.AI_PROCESSING_TAG || 'AI-processing';
const AI_PRIMARY_TAG = process.env.AI_PRIMARY_TAG || 'AI';
const AI_DONE_TAG = process.env.AI_DONE_TAG || 'AI-done';

/**
 * Processes a GitHub issue job from the queue
 * @param {import('bullmq').Job} job - The job to process
 * @returns {Promise<Object>} Processing result
 */
async function processGitHubIssueJob(job) {
    const { id: jobId, name: jobName, data: issueRef } = job;
    const correlationId = issueRef.correlationId || generateCorrelationId();
    const correlatedLogger = logger.withCorrelation(correlationId);
    const stateManager = getStateManager();
    
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
            
            await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
                owner: issueRef.repoOwner,
                repo: issueRef.repoName,
                issue_number: issueRef.number,
                labels: [AI_PROCESSING_TAG],
            });
            
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

        // Add a comment to the issue indicating processing has started
        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner: issueRef.repoOwner,
            repo: issueRef.repoName,
            issue_number: issueRef.number,
            body: `🤖 AI processing has started for this issue.\n\nI'll analyze the problem and work on a solution. This may take a few minutes.`,
        });

        logger.info({ 
            jobId, 
            issueNumber: issueRef.number 
        }, 'Starting Git environment setup...');

        // Update progress: Git setup phase
        await job.updateProgress(25);
        
        // Get GitHub token for cloning
        const githubToken = await octokit.auth();
        const repoUrl = getRepoUrl(issueRef);
        
        let localRepoPath;
        let worktreeInfo;
        let claudeResult = null;
        let postProcessingResult = null;
        
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
                localRepoPath
            }, 'Creating Git worktree for issue...');
            
            worktreeInfo = await createWorktreeForIssue(
                localRepoPath,
                issueRef.number,
                currentIssueData.data.title,
                issueRef.repoOwner,
                issueRef.repoName,
                null, // Use auto-detected default branch
                octokit // Pass GitHub API client for better branch detection
            );
            
            await job.updateProgress(75);
            
            logger.info({ 
                jobId, 
                issueNumber: issueRef.number,
                worktreePath: worktreeInfo.worktreePath,
                branchName: worktreeInfo.branchName
            }, 'Git environment setup complete');
            
            // Step 3: Execute Claude Code to analyze and fix the issue
            logger.info({ 
                jobId, 
                issueNumber: issueRef.number,
                worktreePath: worktreeInfo.worktreePath
            }, 'Starting Claude Code execution...');
            
            await job.updateProgress(80);
            
            claudeResult = await executeClaudeCode({
                worktreePath: worktreeInfo.worktreePath,
                issueRef: issueRef,
                githubToken: githubToken.token
            });
            
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
            
            // Step 4: Post-processing (commit, push, create PR, update labels)
            if (claudeResult?.success) {
                try {
                    logger.info({ 
                        jobId, 
                        issueNumber: issueRef.number,
                        worktreePath: worktreeInfo.worktreePath
                    }, 'Starting post-processing: commit, push, and PR creation...');

                    // Extract commit message from Claude result if available
                    let commitMessage = `fix(ai): Resolve issue #${issueRef.number} - ${currentIssueData.data.title.substring(0, 50)}

Implemented by Claude Code. Full conversation log in PR comment.`;
                    
                    if (claudeResult.suggestedCommitMessage) {
                        commitMessage = claudeResult.suggestedCommitMessage;
                    }

                    // Commit changes
                    const commitResult = await commitChanges(
                        worktreeInfo.worktreePath,
                        commitMessage,
                        {
                            name: 'Claude Code',
                            email: 'claude-code@anthropic.com'
                        },
                        issueRef.number,
                        currentIssueData.data.title
                    );

                    if (commitResult) {
                        logger.info({
                            jobId,
                            issueNumber: issueRef.number,
                            commitHash: commitResult.commitHash
                        }, 'Changes committed successfully');

                        // Push branch to remote
                        await pushBranch(worktreeInfo.worktreePath, worktreeInfo.branchName, {
                            repoUrl,
                            authToken: githubToken.token
                        });
                        
                        logger.info({
                            jobId,
                            issueNumber: issueRef.number,
                            branchName: worktreeInfo.branchName
                        }, 'Branch pushed to remote successfully');

                        // Complete post-processing (PR creation, comments, labels)
                        postProcessingResult = await completePostProcessing({
                            owner: issueRef.repoOwner,
                            repoName: issueRef.repoName,
                            branchName: worktreeInfo.branchName,
                            issueNumber: issueRef.number,
                            issueTitle: currentIssueData.data.title,
                            commitMessage: commitResult.commitMessage,
                            claudeResult,
                            processingTags: [AI_PROCESSING_TAG],
                            completionTags: [AI_DONE_TAG]
                        });

                        logger.info({
                            jobId,
                            issueNumber: issueRef.number,
                            prNumber: postProcessingResult.pr?.number,
                            prUrl: postProcessingResult.pr?.url
                        }, 'Post-processing completed successfully');

                        // Step 5: Validate PR creation and retry if needed
                        // Only validate if we expected a PR to be created (i.e., there were commits)
                        const shouldValidatePR = !!commitResult;
                        let prValidationResult = null;
                        
                        if (shouldValidatePR) {
                            prValidationResult = await validatePRCreation({
                                owner: issueRef.repoOwner,
                                repoName: issueRef.repoName,
                                branchName: worktreeInfo.branchName,
                                expectedPrNumber: postProcessingResult.pr?.number,
                                correlationId
                            });
                        }

                        if (shouldValidatePR && (!prValidationResult || !prValidationResult.isValid)) {
                            correlatedLogger.warn({
                                jobId,
                                issueNumber: issueRef.number,
                                branchName: worktreeInfo.branchName,
                                validationError: prValidationResult.error
                            }, 'PR validation failed - attempting Claude retry with enhanced prompt');

                            // Validate repository information first
                            const repoValidation = await validateRepositoryInfo(issueRef, octokit, correlationId);
                            
                            if (repoValidation.isValid) {
                                // Generate enhanced prompt with explicit repository metadata
                                const enhancedPrompt = generateEnhancedClaudePrompt({
                                    issueRef,
                                    currentIssueData: currentIssueData.data,
                                    worktreePath: worktreeInfo.worktreePath,
                                    branchName: worktreeInfo.branchName,
                                    baseBranch: repoValidation.repoData.defaultBranch
                                });

                                // Retry Claude execution with enhanced prompt
                                const retryResult = await executeClaudeCode({
                                    worktreePath: worktreeInfo.worktreePath,
                                    issueRef: issueRef,
                                    githubToken: githubToken.token,
                                    customPrompt: enhancedPrompt,
                                    isRetry: true,
                                    retryReason: `PR validation failed: ${prValidationResult.error}`
                                });

                                correlatedLogger.info({
                                    jobId,
                                    issueNumber: issueRef.number,
                                    retrySuccess: retryResult.success,
                                    originalClaudeSuccess: claudeResult.success
                                }, 'Claude retry execution completed');

                                // Validate PR creation again after retry
                                const retryValidationResult = await validatePRCreation({
                                    owner: issueRef.repoOwner,
                                    repoName: issueRef.repoName,
                                    branchName: worktreeInfo.branchName,
                                    expectedPrNumber: postProcessingResult.pr?.number,
                                    correlationId
                                });

                                if (retryValidationResult.isValid) {
                                    correlatedLogger.info({
                                        jobId,
                                        issueNumber: issueRef.number,
                                        prNumber: retryValidationResult.pr.number,
                                        prUrl: retryValidationResult.pr.url
                                    }, 'PR validation successful after retry');
                                    
                                    // Update post-processing result with validated PR info
                                    postProcessingResult.pr = retryValidationResult.pr;
                                } else {
                                    correlatedLogger.error({
                                        jobId,
                                        issueNumber: issueRef.number,
                                        retryValidationError: retryValidationResult.error
                                    }, 'PR validation still failed after retry');
                                }
                            } else {
                                correlatedLogger.error({
                                    jobId,
                                    issueNumber: issueRef.number,
                                    repoValidationError: repoValidation.error
                                }, 'Repository validation failed - cannot retry Claude execution');
                            }
                        } else {
                            correlatedLogger.info({
                                jobId,
                                issueNumber: issueRef.number,
                                prNumber: prValidationResult.pr.number,
                                prUrl: prValidationResult.pr.url
                            }, 'PR validation successful on first attempt');
                        }

                    } else {
                        logger.info({
                            jobId,
                            issueNumber: issueRef.number
                        }, 'No changes to commit, posting completion comment only');

                        // Just update labels if no changes were made
                        await octokit.request('DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', {
                            owner: issueRef.repoOwner,
                            repo: issueRef.repoName,
                            issue_number: issueRef.number,
                            name: AI_PROCESSING_TAG,
                        });

                        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
                            owner: issueRef.repoOwner,
                            repo: issueRef.repoName,
                            issue_number: issueRef.number,
                            labels: [AI_DONE_TAG],
                        });

                        const completionComment = await generateCompletionComment(claudeResult, issueRef);
                        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                            owner: issueRef.repoOwner,
                            repo: issueRef.repoName,
                            issue_number: issueRef.number,
                            body: completionComment,
                        });
                    }

                } catch (postProcessingError) {
                    logger.error({
                        jobId,
                        issueNumber: issueRef.number,
                        error: postProcessingError.message
                    }, 'Post-processing failed');

                    // If post-processing failed but there were commits, try PR validation and retry
                    if (commitResult) {
                        correlatedLogger.warn({
                            jobId,
                            issueNumber: issueRef.number,
                            postProcessingError: postProcessingError.message
                        }, 'Post-processing failed - attempting Claude retry for PR creation');

                        // Validate repository information first
                        const repoValidation = await validateRepositoryInfo(issueRef, octokit, correlationId);
                        
                        if (repoValidation.isValid) {
                            // Generate enhanced prompt with explicit repository metadata
                            const enhancedPrompt = generateEnhancedClaudePrompt({
                                issueRef,
                                currentIssueData: currentIssueData.data,
                                worktreePath: worktreeInfo.worktreePath,
                                branchName: worktreeInfo.branchName,
                                baseBranch: repoValidation.repoData.defaultBranch
                            });

                            // Retry Claude execution with enhanced prompt focused on PR creation
                            const retryResult = await executeClaudeCode({
                                worktreePath: worktreeInfo.worktreePath,
                                issueRef: issueRef,
                                githubToken: githubToken.token,
                                customPrompt: enhancedPrompt + '\n\n**CRITICAL: Focus on creating the pull request. The code changes are already committed. Your primary task is to create a working pull request.**',
                                isRetry: true,
                                retryReason: `Post-processing failed: ${postProcessingError.message}`
                            });

                            correlatedLogger.info({
                                jobId,
                                issueNumber: issueRef.number,
                                retrySuccess: retryResult.success
                            }, 'Claude PR creation retry completed');

                            // Try to validate PR creation after retry
                            if (retryResult.success) {
                                const retryValidationResult = await validatePRCreation({
                                    owner: issueRef.repoOwner,
                                    repoName: issueRef.repoName,
                                    branchName: worktreeInfo.branchName,
                                    expectedPrNumber: null, // Don't expect a specific number
                                    correlationId
                                });

                                if (retryValidationResult.isValid) {
                                    correlatedLogger.info({
                                        jobId,
                                        issueNumber: issueRef.number,
                                        prNumber: retryValidationResult.pr.number,
                                        prUrl: retryValidationResult.pr.url
                                    }, 'PR creation successful after retry');
                                    
                                    // Update post-processing result
                                    postProcessingResult = { pr: retryValidationResult.pr, updatedLabels: [] };
                                    
                                    // Skip the error handling below since we recovered
                                    return;
                                }
                            }
                        }
                    }

                    // Try to update labels to indicate post-processing failure
                    try {
                        await octokit.request('DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', {
                            owner: issueRef.repoOwner,
                            repo: issueRef.repoName,
                            issue_number: issueRef.number,
                            name: AI_PROCESSING_TAG,
                        });

                        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
                            owner: issueRef.repoOwner,
                            repo: issueRef.repoName,
                            issue_number: issueRef.number,
                            labels: ['AI-failed-post-processing'],
                        });
                    } catch (labelError) {
                        logger.warn({
                            jobId,
                            issueNumber: issueRef.number,
                            error: labelError.message
                        }, 'Failed to update labels after post-processing failure');
                    }

                    // Still post a completion comment with error details
                    const errorComment = `🤖 **AI Processing Completed with Post-Processing Errors**

Claude Code successfully analyzed and potentially fixed the issue, but encountered errors during post-processing (commit/PR creation).

**Error Details:**
- Post-processing Error: ${postProcessingError.message}

Please check the logs and manually review any changes made to the codebase.

---
*Powered by Claude Code*`;
                    
                    await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                        owner: issueRef.repoOwner,
                        repo: issueRef.repoName,
                        issue_number: issueRef.number,
                        body: errorComment,
                    });
                }
            } else {
                // Claude failed, just update labels
                logger.warn({
                    jobId,
                    issueNumber: issueRef.number
                }, 'Claude processing failed, updating labels only');

                try {
                    await octokit.request('DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', {
                        owner: issueRef.repoOwner,
                        repo: issueRef.repoName,
                        issue_number: issueRef.number,
                        name: AI_PROCESSING_TAG,
                    });

                    await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
                        owner: issueRef.repoOwner,
                        repo: issueRef.repoName,
                        issue_number: issueRef.number,
                        labels: ['AI-failed-claude'],
                    });
                } catch (labelError) {
                    logger.warn({
                        jobId,
                        issueNumber: issueRef.number,
                        error: labelError.message
                    }, 'Failed to update labels after Claude failure');
                }

                const failureComment = await generateCompletionComment(claudeResult, issueRef);
                await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                    owner: issueRef.repoOwner,
                    repo: issueRef.repoName,
                    issue_number: issueRef.number,
                    body: failureComment,
                });
            }
            
            await job.updateProgress(95);
            
        } finally {
            // CRITICAL: Always validate PR creation after Claude execution, regardless of post-processing results
            // This catches cases where Claude creates PR independently but our system doesn't detect it
            if (claudeResult?.success && worktreeInfo?.branchName) {
                correlatedLogger.info({
                    jobId,
                    issueNumber: issueRef.number,
                    branchName: worktreeInfo.branchName,
                    postProcessingSuccess: !!postProcessingResult?.pr
                }, 'Performing final PR validation after Claude execution');

                const finalPRValidation = await validatePRCreation({
                    owner: issueRef.repoOwner,
                    repoName: issueRef.repoName,
                    branchName: worktreeInfo.branchName,
                    expectedPrNumber: postProcessingResult?.pr?.number,
                    correlationId
                });

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
                    try {
                        await octokit.request('DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', {
                            owner: issueRef.repoOwner,
                            repo: issueRef.repoName,
                            issue_number: issueRef.number,
                            name: AI_PROCESSING_TAG,
                        });

                        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
                            owner: issueRef.repoOwner,
                            repo: issueRef.repoName,
                            issue_number: issueRef.number,
                            labels: [AI_DONE_TAG],
                        });

                        correlatedLogger.info({
                            jobId,
                            issueNumber: issueRef.number
                        }, 'Updated issue labels after finding missed PR');

                    } catch (labelUpdateError) {
                        correlatedLogger.warn({
                            error: labelUpdateError.message
                        }, 'Failed to update labels after finding missed PR');
                    }

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
                            retryReason: 'Emergency PR creation - main implementation complete'
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
    
    // Ensure Claude Docker image is built before starting worker
    logger.info('Checking Claude Code Docker image...');
    const imageReady = await buildClaudeDockerImage();
    
    if (!imageReady) {
        logger.error('Failed to build Claude Code Docker image. Worker may not function properly.');
        // Continue anyway - worker can still handle Git operations
    } else {
        logger.info('Claude Code Docker image is ready');
    }
    
    const worker = createWorker(GITHUB_ISSUE_QUEUE_NAME, processGitHubIssueJob);

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
        logger.info('Worker received SIGINT, shutting down gracefully...');
        await worker.close();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        logger.info('Worker received SIGTERM, shutting down gracefully...');
        await worker.close();
        process.exit(0);
    });

    return worker;
}

// Export for testing
export { processGitHubIssueJob, startWorker };

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