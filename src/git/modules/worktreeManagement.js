import simpleGit from 'simple-git';
import fs from 'fs-extra';
import path from 'path';
import logger from '../../utils/logger.js';
import { handleError } from '../../utils/errorHandler.js';
import { withRetry, retryConfigs } from '../../utils/retryHandler.js';
import { detectDefaultBranch, ensureBranchAndPush } from './branchOperations.js';

// Configuration from environment variables
const WORKTREES_BASE_PATH = process.env.GIT_WORKTREES_BASE_PATH || "/tmp/git-processor/worktrees";
const WORKTREE_RETENTION_HOURS = parseInt(process.env.WORKTREE_RETENTION_HOURS || '24', 10);

/**
 * Creates a worktree for a specific issue
 * @param {string} localRepoPath - Path to the local repository
 * @param {string|number} issueId - Issue ID/number
 * @param {string} issueTitle - Issue title for branch naming
 * @param {string} owner - Repository owner
 * @param {string} repoName - Repository name
 * @param {string|null} baseBranch - Base branch (null for auto-detection)
 * @param {Object|null} octokit - Octokit instance for API calls
 * @param {string|null} modelName - Model name for unique naming
 * @returns {Promise<Object>} Worktree information
 */
export async function createWorktreeForIssue(localRepoPath, issueId, issueTitle, owner, repoName, baseBranch = null, octokit = null, modelName = null) {
    try {
        // Initialize Git instance for the main repository
        const git = simpleGit(localRepoPath);
        
        // Detect default branch if not provided
        if (!baseBranch) {
            baseBranch = await detectDefaultBranch(git, owner, repoName, octokit);
            logger.info({
                repo: `${owner}/${repoName}`,
                detectedBranch: baseBranch
            }, 'Auto-detected base branch for worktree');
        }
        
        // Ensure we have the latest version of the base branch
        logger.info({
            repo: `${owner}/${repoName}`,
            baseBranch
        }, 'Fetching latest changes for base branch');
        
        await withRetry(
            async () => {
                await git.fetch(['origin', baseBranch, '--prune']);
            },
            retryConfigs.gitOperations,
            'fetch_base_branch'
        );
        
        // Generate branch name based on issue
        const sanitizedTitle = issueTitle
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .substring(0, 50); // Limit length
        
        const timestamp = new Date().toISOString().split('T')[0].replace(/-/g, '');
        
        let branchName;
        if (modelName && modelName !== 'default') {
            // Extract model identifier from full model name
            // e.g., "claude-3-5-sonnet-20241022" -> "sonnet"
            const modelParts = modelName.split('-');
            const modelIdentifier = modelParts.find(part => 
                ['opus', 'sonnet', 'haiku'].includes(part)
            ) || modelParts[modelParts.length - 1];
            
            branchName = `ai-fix/${issueId}-${sanitizedTitle}-${timestamp}-${modelIdentifier}`.substring(0, 100);
        } else {
            branchName = `ai-fix/${issueId}-${sanitizedTitle}-${timestamp}`.substring(0, 80);
        }
        
        // Generate worktree directory name (include model name for uniqueness)
        const worktreeDirName = modelName ? 
            `${owner}-${repoName}-issue-${issueId}-${modelName}` :
            `${owner}-${repoName}-issue-${issueId}`;
        const worktreePath = path.join(WORKTREES_BASE_PATH, worktreeDirName);
        
        // Clean up any existing worktree at this path
        if (await fs.pathExists(worktreePath)) {
            logger.warn({
                worktreePath,
                issueId
            }, 'Worktree already exists at path, cleaning up');
            
            // Try to remove via git first
            try {
                await git.raw(['worktree', 'remove', '--force', worktreePath]);
            } catch (removeError) {
                logger.warn({
                    worktreePath,
                    error: removeError.message
                }, 'Failed to remove worktree via git, removing directory');
            }
            
            // Ensure directory is removed
            await fs.remove(worktreePath);
        }
        
        // Create the worktree
        logger.info({
            localRepoPath,
            worktreePath,
            branchName,
            baseBranch
        }, 'Creating git worktree');
        
        await withRetry(
            async () => {
                // Create worktree with a new branch
                await git.raw(['worktree', 'add', '-b', branchName, worktreePath, `origin/${baseBranch}`]);
            },
            retryConfigs.gitOperations,
            'create_worktree'
        );
        
        logger.info({
            worktreePath,
            branchName,
            issueId
        }, 'Worktree created successfully');
        
        return {
            worktreePath,
            branchName,
            baseBranch
        };
        
    } catch (error) {
        handleError(error, 'Failed to create worktree for issue', {
            localRepoPath,
            issueId,
            owner,
            repoName
        });
        throw error;
    }
}

/**
 * Creates a worktree from an existing branch
 * @param {string} localRepoPath - Path to the local repository
 * @param {string} branchName - Existing branch name
 * @param {string} worktreeDirName - Directory name for the worktree
 * @param {string} owner - Repository owner
 * @param {string} repoName - Repository name
 * @returns {Promise<Object>} Worktree information
 */
export async function createWorktreeFromExistingBranch(localRepoPath, branchName, worktreeDirName, owner, repoName) {
    try {
        // Initialize Git instance for the main repository
        const git = simpleGit(localRepoPath);
        
        // Generate full worktree path
        const worktreePath = path.join(WORKTREES_BASE_PATH, worktreeDirName);
        
        // Clean up any existing worktree at this path
        if (await fs.pathExists(worktreePath)) {
            logger.warn({
                worktreePath,
                branchName
            }, 'Worktree already exists at path, cleaning up');
            
            // Try to remove via git first
            try {
                await git.raw(['worktree', 'remove', '--force', worktreePath]);
            } catch (removeError) {
                logger.warn({
                    worktreePath,
                    error: removeError.message
                }, 'Failed to remove worktree via git, removing directory');
            }
            
            // Ensure directory is removed
            await fs.remove(worktreePath);
        }
        
        // Fetch the latest state of the branch
        logger.info({
            repo: `${owner}/${repoName}`,
            branchName
        }, 'Fetching latest changes for existing branch');
        
        await withRetry(
            async () => {
                try {
                    // Try to fetch the specific branch
                    await git.fetch(['origin', `${branchName}:${branchName}`, '--force']);
                } catch (fetchError) {
                    // If specific branch fetch fails, do a general fetch
                    logger.warn({
                        branchName,
                        error: fetchError.message
                    }, 'Failed to fetch specific branch, trying general fetch');
                    await git.fetch(['origin', '--prune']);
                }
            },
            retryConfigs.gitOperations,
            'fetch_existing_branch'
        );
        
        // Create the worktree from the existing branch
        logger.info({
            localRepoPath,
            worktreePath,
            branchName
        }, 'Creating git worktree from existing branch');
        
        await withRetry(
            async () => {
                // First, ensure the branch exists locally
                const branches = await git.branchLocal();
                if (!branches.all.includes(branchName)) {
                    // Create local branch from remote
                    await git.branch([branchName, `origin/${branchName}`]);
                }
                
                // Create worktree using existing branch
                await git.raw(['worktree', 'add', worktreePath, branchName]);
            },
            retryConfigs.gitOperations,
            'create_worktree_from_branch'
        );
        
        // Verify the worktree is on the correct branch
        const worktreeGit = simpleGit(worktreePath);
        const currentBranch = await worktreeGit.revparse(['--abbrev-ref', 'HEAD']);
        
        if (currentBranch !== branchName) {
            logger.warn({
                expectedBranch: branchName,
                actualBranch: currentBranch
            }, 'Worktree is not on expected branch, checking out');
            await worktreeGit.checkout(branchName);
        }
        
        // Pull latest changes
        await withRetry(
            async () => {
                await worktreeGit.pull('origin', branchName);
            },
            retryConfigs.gitOperations,
            'pull_latest_changes'
        );
        
        logger.info({
            worktreePath,
            branchName
        }, 'Worktree created successfully from existing branch');
        
        return {
            worktreePath,
            branchName
        };
        
    } catch (error) {
        handleError(error, 'Failed to create worktree from existing branch', {
            localRepoPath,
            branchName,
            worktreeDirName,
            owner,
            repoName
        });
        throw error;
    }
}

/**
 * Cleans up a worktree after processing
 * @param {string} localRepoPath - Path to the main repository
 * @param {string} worktreePath - Path to the worktree
 * @param {string} branchName - Branch name
 * @param {Object} options - Cleanup options
 */
export async function cleanupWorktree(localRepoPath, worktreePath, branchName, options = {}) {
    const { 
        deleteBranch = true, 
        success = true,
        retentionStrategy = process.env.WORKTREE_RETENTION_STRATEGY || 'on_failure'
    } = options;
    
    try {
        // Determine if we should retain the worktree based on strategy
        let shouldRetain = false;
        
        switch (retentionStrategy) {
            case 'always':
                shouldRetain = true;
                break;
            case 'on_failure':
                shouldRetain = !success;
                break;
            case 'never':
            case 'always_delete':
                shouldRetain = false;
                break;
            default:
                shouldRetain = !success; // Default to keeping on failure
        }
        
        if (shouldRetain) {
            logger.info({
                worktreePath,
                branchName,
                success,
                retentionStrategy
            }, 'Retaining worktree based on retention strategy');
            
            // Still create a marker file to track retention time
            const markerPath = path.join(worktreePath, '.gitfix-retained');
            await fs.writeFile(markerPath, JSON.stringify({
                retainedAt: new Date().toISOString(),
                reason: success ? 'retained_by_strategy' : 'processing_failed',
                branchName
            }));
            
            return;
        }
        
        // Proceed with cleanup
        logger.info({
            worktreePath,
            branchName,
            deleteBranch
        }, 'Cleaning up worktree');
        
        const git = simpleGit(localRepoPath);
        
        // Remove the worktree
        try {
            await git.raw(['worktree', 'remove', '--force', worktreePath]);
            logger.info({ worktreePath }, 'Worktree removed via git');
        } catch (worktreeError) {
            logger.warn({
                worktreePath,
                error: worktreeError.message
            }, 'Failed to remove worktree via git, attempting directory removal');
            
            // Fallback: remove directory directly
            await fs.remove(worktreePath);
        }
        
        // Delete the local branch if requested
        if (deleteBranch && branchName) {
            try {
                await git.branch(['-D', branchName]);
                logger.info({ branchName }, 'Local branch deleted');
            } catch (branchError) {
                logger.warn({
                    branchName,
                    error: branchError.message
                }, 'Failed to delete local branch');
            }
        }
        
        logger.info({
            worktreePath,
            branchName
        }, 'Worktree cleanup completed');
        
    } catch (error) {
        handleError(error, 'Failed to cleanup worktree', {
            localRepoPath,
            worktreePath,
            branchName
        });
        // Don't throw - cleanup errors shouldn't fail the main process
    }
}

/**
 * Cleans up expired worktrees based on retention time
 * @param {string} worktreesBasePath - Base path for worktrees
 */
export async function cleanupExpiredWorktrees(worktreesBasePath = WORKTREES_BASE_PATH) {
    logger.info({
        worktreesBasePath,
        retentionHours: WORKTREE_RETENTION_HOURS
    }, 'Starting cleanup of expired worktrees');
    
    try {
        // Ensure the worktrees directory exists
        if (!await fs.pathExists(worktreesBasePath)) {
            logger.info({ worktreesBasePath }, 'Worktrees directory does not exist, nothing to clean');
            return;
        }
        
        const worktreeDirs = await fs.readdir(worktreesBasePath);
        const now = Date.now();
        const retentionMs = WORKTREE_RETENTION_HOURS * 60 * 60 * 1000;
        
        for (const dir of worktreeDirs) {
            const worktreePath = path.join(worktreesBasePath, dir);
            
            try {
                // Check if it's a directory
                const stat = await fs.stat(worktreePath);
                if (!stat.isDirectory()) {
                    continue;
                }
                
                // Check for retention marker
                const markerPath = path.join(worktreePath, '.gitfix-retained');
                let retainedInfo = null;
                
                if (await fs.pathExists(markerPath)) {
                    try {
                        retainedInfo = await fs.readJson(markerPath);
                    } catch (readError) {
                        logger.warn({
                            markerPath,
                            error: readError.message
                        }, 'Failed to read retention marker');
                    }
                }
                
                // Use retention time if available, otherwise use directory modification time
                const referenceTime = retainedInfo?.retainedAt ? 
                    new Date(retainedInfo.retainedAt).getTime() : 
                    stat.mtime.getTime();
                
                const age = now - referenceTime;
                
                if (age > retentionMs) {
                    logger.info({
                        worktreePath,
                        ageHours: Math.round(age / (60 * 60 * 1000)),
                        retainedInfo
                    }, 'Removing expired worktree');
                    
                    // Remove the directory
                    await fs.remove(worktreePath);
                    
                    logger.info({ worktreePath }, 'Expired worktree removed');
                }
                
            } catch (dirError) {
                logger.error({
                    worktreePath,
                    error: dirError.message
                }, 'Error processing worktree directory');
            }
        }
        
        logger.info('Expired worktree cleanup completed');
        
    } catch (error) {
        handleError(error, 'Failed to cleanup expired worktrees', {
            worktreesBasePath
        });
    }
}