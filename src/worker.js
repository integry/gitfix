import 'dotenv/config';
import { GITHUB_ISSUE_QUEUE_NAME, createWorker } from './queue/taskQueue.js';
import logger from './utils/logger.js';
import { getAuthenticatedOctokit } from './auth/githubAuth.js';
import { withErrorHandling } from './utils/errorHandler.js';
import { 
    ensureRepoCloned, 
    createWorktreeForIssue, 
    cleanupWorktree,
    getRepoUrl 
} from './git/repoManager.js';
import { executeClaudeCode, buildClaudeDockerImage } from './claude/claudeService.js';
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
    
    logger.info({ 
        jobId, 
        jobName, 
        issueNumber: issueRef.number, 
        repo: `${issueRef.repoOwner}/${issueRef.repoName}` 
    }, 'Processing job started');

    let octokit;
    try {
        octokit = await getAuthenticatedOctokit();
    } catch (authError) {
        logger.error({ 
            jobId, 
            errMessage: authError.message 
        }, 'Worker: Failed to get authenticated Octokit instance');
        throw authError;
    }

    try {
        // Get current issue state
        const currentIssueData = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
            owner: issueRef.repoOwner,
            repo: issueRef.repoName,
            issue_number: issueRef.number,
        });

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
        let claudeResult;
        
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
                issueRef.repoName
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
            
            // Post completion comment with detailed logs
            const completionComment = await generateCompletionComment(claudeResult, issueRef);
            await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                owner: issueRef.repoOwner,
                repo: issueRef.repoName,
                issue_number: issueRef.number,
                body: completionComment,
            });
            
            logger.info({ 
                jobId, 
                issueNumber: issueRef.number 
            }, 'Posted completion comment to issue');
            
            // Check if a PR was created by looking for recent PRs
            let prInfo = null;
            try {
                logger.info({ 
                    jobId, 
                    issueNumber: issueRef.number 
                }, 'Checking for created pull requests...');
                
                const prsResponse = await octokit.request('GET /repos/{owner}/{repo}/pulls', {
                    owner: issueRef.repoOwner,
                    repo: issueRef.repoName,
                    state: 'open',
                    sort: 'created',
                    direction: 'desc',
                    per_page: 10
                });
                
                // Look for PRs created in the last 30 minutes that might be from this run
                const recentTime = new Date(Date.now() - 30 * 60 * 1000);
                const recentPR = prsResponse.data.find(pr => {
                    const createdAt = new Date(pr.created_at);
                    return createdAt > recentTime && 
                           (pr.title.includes(`#${issueRef.number}`) || 
                            pr.head.ref.includes(`${issueRef.number}`) ||
                            pr.body?.includes(`#${issueRef.number}`));
                });
                
                if (recentPR) {
                    prInfo = {
                        number: recentPR.number,
                        url: recentPR.html_url,
                        title: recentPR.title,
                        branch: recentPR.head.ref
                    };
                    logger.info({ 
                        jobId, 
                        issueNumber: issueRef.number,
                        prNumber: recentPR.number,
                        prUrl: recentPR.html_url
                    }, 'Found created pull request');
                }
            } catch (prCheckError) {
                logger.warn({ 
                    jobId, 
                    issueNumber: issueRef.number,
                    error: prCheckError.message
                }, 'Failed to check for created pull requests');
            }
            
            // Update issue labels: remove AI-processing, add AI-done
            try {
                logger.info({ 
                    jobId, 
                    issueNumber: issueRef.number 
                }, 'Updating issue labels...');
                
                // Remove AI-processing label
                try {
                    await octokit.request('DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', {
                        owner: issueRef.repoOwner,
                        repo: issueRef.repoName,
                        issue_number: issueRef.number,
                        name: AI_PROCESSING_TAG,
                    });
                    logger.info({ 
                        jobId, 
                        issueNumber: issueRef.number 
                    }, `Removed '${AI_PROCESSING_TAG}' label`);
                } catch (removeError) {
                    logger.warn({ 
                        jobId, 
                        issueNumber: issueRef.number,
                        error: removeError.message
                    }, `Failed to remove '${AI_PROCESSING_TAG}' label`);
                }
                
                // Add AI-done label
                await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
                    owner: issueRef.repoOwner,
                    repo: issueRef.repoName,
                    issue_number: issueRef.number,
                    labels: [AI_DONE_TAG],
                });
                logger.info({ 
                    jobId, 
                    issueNumber: issueRef.number 
                }, `Added '${AI_DONE_TAG}' label`);
                
            } catch (labelError) {
                logger.warn({ 
                    jobId, 
                    issueNumber: issueRef.number,
                    error: labelError.message
                }, 'Failed to update issue labels');
            }
            
            // Update the completion comment if we found a PR
            if (prInfo) {
                try {
                    const prUpdateComment = `\n\n**🎉 Pull Request Created Successfully!**\n\n` +
                                          `- **PR #${prInfo.number}**: [${prInfo.title}](${prInfo.url})\n` +
                                          `- **Branch**: \`${prInfo.branch}\`\n` +
                                          `- **Status**: Ready for review\n\n` +
                                          `The implementation is now available for review and can be merged when approved.`;
                    
                    await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                        owner: issueRef.repoOwner,
                        repo: issueRef.repoName,
                        issue_number: issueRef.number,
                        body: prUpdateComment,
                    });
                    
                    logger.info({ 
                        jobId, 
                        issueNumber: issueRef.number,
                        prNumber: prInfo.number
                    }, 'Posted PR update comment');
                } catch (updateError) {
                    logger.warn({ 
                        jobId, 
                        issueNumber: issueRef.number,
                        error: updateError.message
                    }, 'Failed to post PR update comment');
                }
            }
            
            await job.updateProgress(95);
            
        } finally {
            // Cleanup: Remove worktree after processing
            if (worktreeInfo) {
                try {
                    logger.info({ 
                        jobId, 
                        issueNumber: issueRef.number,
                        worktreePath: worktreeInfo.worktreePath
                    }, 'Cleaning up Git worktree...');
                    
                    await cleanupWorktree(
                        localRepoPath, 
                        worktreeInfo.worktreePath, 
                        worktreeInfo.branchName,
                        true // Delete the branch since we're just simulating
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

        return { 
            status: claudeResult?.success ? 'claude_processing_complete' : 'claude_processing_failed', 
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
            }
        };

    } catch (error) {
        logger.error({ 
            jobId, 
            issueNumber: issueRef.number, 
            errMessage: error.message, 
            stack: error.stack 
        }, 'Error processing GitHub issue job');
        
        // If we added the processing tag but failed, we might want to remove it
        // This could be done in a future enhancement with proper state management
        
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
    comment += `- Timestamp: ${timestamp}\n\n`;
    
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