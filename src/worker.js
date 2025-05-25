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

// Configuration
const AI_PROCESSING_TAG = process.env.AI_PROCESSING_TAG || 'AI-processing';
const AI_PRIMARY_TAG = process.env.AI_PRIMARY_TAG || 'AI';
const AI_EXCLUDE_TAGS_DONE = process.env.AI_EXCLUDE_TAGS_DONE || 'AI-done';

/**
 * Processes a GitHub issue job from the queue
 * @param {import('bullmq').Job} job - The job to process
 * @returns {Promise<Object>} Processing result
 */
async function processGitHubIssueJob(job) {
    const { id: jobId, name: jobName, data: issue } = job;
    
    logger.info({ 
        jobId, 
        jobName, 
        issueNumber: issue.number, 
        repo: `${issue.repoOwner}/${issue.repoName}` 
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
            owner: issue.repoOwner,
            repo: issue.repoName,
            issue_number: issue.number,
        });

        const currentLabels = currentIssueData.data.labels.map(label => label.name);
        const hasProcessingTag = currentLabels.includes(AI_PROCESSING_TAG);
        const hasPrimaryTag = currentLabels.includes(AI_PRIMARY_TAG);
        const hasDoneTag = currentLabels.includes(AI_EXCLUDE_TAGS_DONE);

        // Validate issue state
        if (!hasPrimaryTag) {
            logger.warn({ 
                jobId, 
                issueNumber: issue.number 
            }, `Issue no longer has primary tag '${AI_PRIMARY_TAG}'. Skipping.`);
            return { 
                status: 'skipped', 
                reason: 'Primary tag missing',
                issueNumber: issue.number 
            };
        }

        if (hasDoneTag) {
            logger.warn({ 
                jobId, 
                issueNumber: issue.number 
            }, `Issue already has '${AI_EXCLUDE_TAGS_DONE}' tag. Skipping.`);
            return { 
                status: 'skipped', 
                reason: 'Already done',
                issueNumber: issue.number 
            };
        }

        // Add processing tag if not already present
        if (!hasProcessingTag) {
            logger.info({ 
                jobId, 
                issueNumber: issue.number 
            }, `Adding '${AI_PROCESSING_TAG}' tag to issue`);
            
            await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
                owner: issue.repoOwner,
                repo: issue.repoName,
                issue_number: issue.number,
                labels: [AI_PROCESSING_TAG],
            });
            
            logger.info({ 
                jobId, 
                issueNumber: issue.number 
            }, `Successfully added '${AI_PROCESSING_TAG}' tag`);
        } else {
            logger.info({ 
                jobId, 
                issueNumber: issue.number 
            }, `Issue already has '${AI_PROCESSING_TAG}' tag, continuing with processing`);
        }

        // Add a comment to the issue indicating processing has started
        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner: issue.repoOwner,
            repo: issue.repoName,
            issue_number: issue.number,
            body: `🤖 AI processing has started for this issue.\n\nI'll analyze the problem and work on a solution. This may take a few minutes.`,
        });

        logger.info({ 
            jobId, 
            issueNumber: issue.number 
        }, 'Starting Git environment setup...');

        // Update progress: Git setup phase
        await job.updateProgress(25);
        
        // Get GitHub token for cloning
        const githubToken = await octokit.auth();
        const repoUrl = getRepoUrl(issue);
        
        let localRepoPath;
        let worktreeInfo;
        
        try {
            // Step 1: Ensure repository is cloned/updated
            logger.info({ 
                jobId, 
                repo: `${issue.repoOwner}/${issue.repoName}`,
                repoUrl 
            }, 'Cloning/updating repository...');
            
            localRepoPath = await ensureRepoCloned(
                repoUrl, 
                issue.repoOwner, 
                issue.repoName, 
                githubToken.token
            );
            
            await job.updateProgress(50);
            
            // Step 2: Create worktree for this issue
            logger.info({ 
                jobId, 
                issueNumber: issue.number,
                issueTitle: issue.title,
                localRepoPath
            }, 'Creating Git worktree for issue...');
            
            worktreeInfo = await createWorktreeForIssue(
                localRepoPath,
                issue.number,
                issue.title,
                issue.repoOwner,
                issue.repoName
            );
            
            await job.updateProgress(75);
            
            logger.info({ 
                jobId, 
                issueNumber: issue.number,
                worktreePath: worktreeInfo.worktreePath,
                branchName: worktreeInfo.branchName
            }, 'Git environment setup complete');
            
            // TODO: Future implementation will include:
            // 3. Execute Claude Code to analyze and fix the issue
            // 4. Commit changes
            // 5. Push branch and create PR
            // 6. Update issue with results
            
            // Simulate Claude processing work
            const simulatedWorkMs = parseInt(process.env.SIMULATED_WORK_MS || '3000', 10);
            logger.info({ 
                jobId, 
                issueNumber: issue.number,
                worktreePath: worktreeInfo.worktreePath
            }, 'Simulating Claude Code execution...');
            
            await new Promise(resolve => setTimeout(resolve, simulatedWorkMs));
            
            logger.info({ 
                jobId, 
                issueNumber: issue.number,
                simulatedWorkMs,
                worktreePath: worktreeInfo.worktreePath
            }, 'Processing simulation complete');
            
        } finally {
            // Cleanup: Remove worktree after processing
            if (worktreeInfo) {
                try {
                    logger.info({ 
                        jobId, 
                        issueNumber: issue.number,
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
                        issueNumber: issue.number,
                        error: cleanupError.message
                    }, 'Failed to cleanup worktree');
                }
            }
        }

        // Update progress tracking
        await job.updateProgress(100);

        return { 
            status: 'git_environment_ready', 
            issueNumber: issue.number,
            repository: `${issue.repoOwner}/${issue.repoName}`,
            gitSetup: {
                localRepoPath: localRepoPath,
                worktreeCreated: !!worktreeInfo,
                branchName: worktreeInfo?.branchName
            },
            processingTime: simulatedWorkMs
        };

    } catch (error) {
        logger.error({ 
            jobId, 
            issueNumber: issue.number, 
            errMessage: error.message, 
            stack: error.stack 
        }, 'Error processing GitHub issue job');
        
        // If we added the processing tag but failed, we might want to remove it
        // This could be done in a future enhancement with proper state management
        
        throw error;
    }
}

/**
 * Starts the worker process
 */
function startWorker() {
    logger.info({
        queue: GITHUB_ISSUE_QUEUE_NAME,
        processingTag: AI_PROCESSING_TAG,
        primaryTag: AI_PRIMARY_TAG,
        doneTag: AI_EXCLUDE_TAGS_DONE
    }, 'Starting GitHub Issue Worker...');
    
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
    startWorker();
}