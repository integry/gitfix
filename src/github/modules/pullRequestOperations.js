import { getAuthenticatedOctokit } from '../../auth/githubAuth.js';
import logger from '../../utils/logger.js';
import { handleError } from '../../utils/errorHandler.js';
import { ensureBranchAndPush } from '../../git/repoManager.js';

// Configuration
const DEFAULT_BASE_BRANCH = process.env.GIT_DEFAULT_BRANCH || 'main';

/**
 * Creates a Pull Request with robust git operations ensuring proper branch history
 * @param {Object} params - PR creation parameters
 * @param {string} params.owner - Repository owner
 * @param {string} params.repoName - Repository name
 * @param {string} params.branchName - Feature branch name
 * @param {string} params.baseBranch - Base branch name
 * @param {number} params.issueNumber - Issue number
 * @param {string} params.prTitle - PR title
 * @param {string} params.prBody - PR body
 * @param {string} params.worktreePath - Path to the worktree
 * @param {string} params.repoUrl - Repository URL
 * @param {string} params.authToken - GitHub auth token
 * @returns {Promise<Object>} Created PR data
 */
export async function createPullRequestRobust(params) {
    const { 
        owner, 
        repoName, 
        branchName, 
        baseBranch, 
        issueNumber, 
        prTitle, 
        prBody,
        worktreePath,
        repoUrl,
        authToken
    } = params;
    
    const octokit = await getAuthenticatedOctokit();
    
    try {
        logger.info({
            owner,
            repoName,
            branchName,
            baseBranch,
            issueNumber,
            prTitle
        }, 'Creating pull request with robust git operations...');
        
        // Step 1: Ensure branch is properly pushed to remote
        await ensureBranchAndPush(worktreePath, branchName, baseBranch, {
            repoUrl,
            authToken,
            tokenRefreshFn: async () => {
                const newAuth = await octokit.auth();
                return newAuth.token;
            },
            correlationId: params.correlationId || 'unknown'
        });
        
        // Step 1.5: Wait for GitHub to propagate branch data (timing fix)
        logger.debug({ branchName }, 'Waiting for GitHub to propagate branch data...');
        await new Promise(resolve => setTimeout(resolve, 3000)); // 3 second delay
        
        // Step 2: Verify branch exists on remote with retry logic
        let branchExists = false;
        const maxRetries = 5;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                await octokit.request('GET /repos/{owner}/{repo}/branches/{branch}', {
                    owner,
                    repo: repoName,
                    branch: branchName
                });
                logger.debug({ branchName, attempt }, 'Confirmed branch exists on remote');
                branchExists = true;
                break;
            } catch (branchCheckError) {
                if (attempt === maxRetries) {
                    throw new Error(`Branch '${branchName}' does not exist on remote after ${maxRetries} attempts: ${branchCheckError.message}`);
                }
                
                const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000); // Exponential backoff, max 10s
                logger.debug({ 
                    branchName, 
                    attempt, 
                    delay,
                    error: branchCheckError.message 
                }, 'Branch not found, retrying...');
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
        
        // Step 2.5: Check if there are actual commits between base and head branches
        try {
            const compareResult = await octokit.request('GET /repos/{owner}/{repo}/compare/{base}...{head}', {
                owner,
                repo: repoName,
                base: baseBranch,
                head: branchName
            });
            
            logger.debug({
                branchName,
                baseBranch,
                aheadBy: compareResult.data.ahead_by,
                behindBy: compareResult.data.behind_by,
                totalCommits: compareResult.data.total_commits
            }, 'Branch comparison result');
            
            if (compareResult.data.ahead_by === 0) {
                logger.warn({
                    branchName,
                    baseBranch,
                    issueNumber
                }, 'Branch has no new commits compared to base branch');
                
                // Still create PR but with a note
                if (!prBody.includes('No code changes were made')) {
                    params.prBody = prBody + '\n\n---\n⚠️ Note: This branch contains no new commits compared to the base branch.';
                }
            }
        } catch (compareError) {
            logger.warn({
                error: compareError.message,
                branchName,
                baseBranch
            }, 'Failed to compare branches, continuing with PR creation');
        }
        
        // Step 3: Check if PR already exists
        try {
            const existingPRs = await octokit.request('GET /repos/{owner}/{repo}/pulls', {
                owner,
                repo: repoName,
                head: `${owner}:${branchName}`,
                state: 'open'
            });
            
            if (existingPRs.data.length > 0) {
                const existingPR = existingPRs.data[0];
                logger.warn({
                    prNumber: existingPR.number,
                    prUrl: existingPR.html_url,
                    branchName,
                    issueNumber
                }, 'Pull request already exists for this branch');
                
                return existingPR;
            }
        } catch (prCheckError) {
            logger.debug({
                error: prCheckError.message,
                branchName
            }, 'Error checking for existing PR, will attempt to create new one');
        }
        
        // Step 4: Create the pull request
        try {
            const prResponse = await octokit.request('POST /repos/{owner}/{repo}/pulls', {
                owner,
                repo: repoName,
                title: prTitle,
                body: prBody,
                head: branchName,
                base: baseBranch,
                draft: false
            });
            
            logger.info({
                prNumber: prResponse.data.number,
                prUrl: prResponse.data.html_url,
                issueNumber,
                branchName
            }, 'Successfully created pull request');
            
            return prResponse.data;
            
        } catch (prError) {
            // Handle specific error cases
            if (prError.status === 422) {
                // Validation failed - could be various reasons
                const errorMessage = prError.message || '';
                
                if (errorMessage.includes('pull request already exists')) {
                    // PR already exists but our check missed it
                    logger.warn({
                        branchName,
                        issueNumber,
                        error: errorMessage
                    }, 'PR already exists (caught during creation)');
                    
                    // Try to find the existing PR
                    const existingPRs = await octokit.request('GET /repos/{owner}/{repo}/pulls', {
                        owner,
                        repo: repoName,
                        head: `${owner}:${branchName}`,
                        state: 'all'
                    });
                    
                    if (existingPRs.data.length > 0) {
                        return existingPRs.data[0];
                    }
                } else if (errorMessage.includes('No commits between')) {
                    // No commits between branches
                    logger.error({
                        branchName,
                        baseBranch,
                        issueNumber,
                        error: errorMessage
                    }, 'No commits between base and head branches');
                    
                    throw new Error(`Cannot create PR: ${errorMessage}`);
                }
            }
            
            // Re-throw for other errors
            throw prError;
        }
        
    } catch (error) {
        handleError(error, 'Failed to create pull request with robust operations', {
            owner,
            repoName,
            branchName,
            baseBranch,
            issueNumber
        });
        throw error;
    }
}

/**
 * Creates a Pull Request using the GitHub API
 * @param {Object} options - PR creation options
 * @returns {Promise<Object>} Created PR data
 */
export async function createPullRequest(options) {
    const {
        owner,
        repo,
        title,
        body,
        head,
        base = DEFAULT_BASE_BRANCH,
        draft = false,
        issueNumber
    } = options;

    const octokit = await getAuthenticatedOctokit();

    try {
        logger.info({
            owner,
            repo,
            title,
            head,
            base,
            draft,
            issueNumber
        }, 'Creating pull request...');

        const response = await octokit.request('POST /repos/{owner}/{repo}/pulls', {
            owner,
            repo,
            title,
            body,
            head,
            base,
            draft
        });

        logger.info({
            prNumber: response.data.number,
            prUrl: response.data.html_url,
            issueNumber
        }, 'Pull request created successfully');

        return response.data;

    } catch (error) {
        handleError(error, 'Failed to create pull request', { owner, repo, issueNumber });
        
        // Check if PR already exists
        if (error.status === 422 && error.message?.includes('pull request already exists')) {
            logger.info({ owner, repo, head }, 'Pull request already exists, fetching existing PR...');
            
            try {
                const existingPRs = await octokit.request('GET /repos/{owner}/{repo}/pulls', {
                    owner,
                    repo,
                    head: `${owner}:${head}`,
                    state: 'open'
                });

                if (existingPRs.data.length > 0) {
                    const existingPR = existingPRs.data[0];
                    logger.info({
                        prNumber: existingPR.number,
                        prUrl: existingPR.html_url
                    }, 'Found existing pull request');
                    return existingPR;
                }
            } catch (fetchError) {
                logger.error({ error: fetchError.message }, 'Failed to fetch existing pull request');
            }
        }
        
        throw error;
    }
}

/**
 * Generates PR body content
 * @param {number} issueNumber - Issue number
 * @param {string} issueTitle - Issue title
 * @param {string} commitMessage - Commit message
 * @param {Object} claudeResult - Claude execution result
 * @returns {string} PR body content
 */
export function generatePRBody(issueNumber, issueTitle, commitMessage, claudeResult) {
    let body = `## AI Implementation Summary\n\n`;
    body += `Closes #${issueNumber}\n\n`;
    
    if (claudeResult?.summary) {
        body += `### What was done:\n${claudeResult.summary}\n\n`;
    } else {
        body += `### Issue:\n${issueTitle}\n\n`;
        
        if (commitMessage) {
            body += `### Changes:\n${commitMessage}\n\n`;
        }
    }
    
    if (claudeResult?.modifiedFiles && claudeResult.modifiedFiles.length > 0) {
        body += `### Files Modified:\n`;
        claudeResult.modifiedFiles.forEach(file => {
            body += `- \`${file}\`\n`;
        });
        body += `\n`;
    }
    
    // Add model information if available
    if (claudeResult?.model) {
        body += `### AI Model Used:\n- ${claudeResult.model}\n\n`;
    }
    
    body += `---\n`;
    body += `*This pull request was automatically generated by Claude Code AI.*\n`;
    
    return body;
}