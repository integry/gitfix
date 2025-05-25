import simpleGit from 'simple-git';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';
import { handleError } from '../utils/errorHandler.js';

// Configuration from environment variables
const CLONES_BASE_PATH = process.env.GIT_CLONES_BASE_PATH || "/tmp/git-processor/clones";
const WORKTREES_BASE_PATH = process.env.GIT_WORKTREES_BASE_PATH || "/tmp/git-processor/worktrees";
const GIT_DEFAULT_BRANCH = process.env.GIT_DEFAULT_BRANCH || 'main';
const GIT_SHALLOW_CLONE_DEPTH = process.env.GIT_SHALLOW_CLONE_DEPTH ? parseInt(process.env.GIT_SHALLOW_CLONE_DEPTH) : undefined;

/**
 * Gets the local path for a repository clone
 * @param {string} owner - Repository owner
 * @param {string} repoName - Repository name
 * @returns {Promise<string>} Local repository path
 */
async function getRepoPath(owner, repoName) {
    return path.join(CLONES_BASE_PATH, owner, repoName);
}

/**
 * Ensures a repository is cloned locally and up to date
 * @param {string} repoUrl - Repository URL (e.g., https://github.com/owner/repo.git)
 * @param {string} owner - Repository owner
 * @param {string} repoName - Repository name
 * @param {string} authToken - GitHub authentication token
 * @returns {Promise<string>} Local repository path
 */
export async function ensureRepoCloned(repoUrl, owner, repoName, authToken) {
    const localRepoPath = await getRepoPath(owner, repoName);
    
    try {
        // Check if repository already exists
        if (await fs.pathExists(path.join(localRepoPath, ".git"))) {
            logger.info({ 
                repo: `${owner}/${repoName}`, 
                path: localRepoPath 
            }, 'Repository exists locally. Fetching updates...');
            
            const git = simpleGit(localRepoPath);
            await git.fetch(['origin', '--prune']);
            
            logger.info({ 
                repo: `${owner}/${repoName}`, 
                path: localRepoPath 
            }, 'Repository updated successfully');
            
        } else {
            logger.info({ 
                repo: `${owner}/${repoName}`, 
                path: localRepoPath 
            }, 'Cloning repository...');
            
            // Ensure parent directory exists
            await fs.ensureDir(localRepoPath);
            
            // Prepare clone options
            const cloneOptions = [];
            if (GIT_SHALLOW_CLONE_DEPTH) {
                cloneOptions.push(`--depth=${GIT_SHALLOW_CLONE_DEPTH}`);
            }
            
            // Construct authenticated URL
            const authenticatedUrl = repoUrl.replace('https://', `https://x-access-token:${authToken}@`);
            
            // Clone the repository
            const git = simpleGit();
            await git.clone(authenticatedUrl, localRepoPath, cloneOptions);
            
            logger.info({ 
                repo: `${owner}/${repoName}`, 
                path: localRepoPath,
                shallow: !!GIT_SHALLOW_CLONE_DEPTH
            }, 'Repository cloned successfully');
        }
        
        return localRepoPath;
        
    } catch (error) {
        handleError(error, `Failed to clone/fetch repository ${owner}/${repoName}`);
        throw error;
    }
}

/**
 * Creates a Git worktree for a specific issue
 * @param {string} localRepoPath - Path to the main repository clone
 * @param {number} issueId - GitHub issue ID
 * @param {string} issueTitle - GitHub issue title
 * @param {string} owner - Repository owner
 * @param {string} repoName - Repository name
 * @param {string} baseBranch - Base branch to create worktree from
 * @returns {Promise<{worktreePath: string, branchName: string}>} Worktree details
 */
export async function createWorktreeForIssue(localRepoPath, issueId, issueTitle, owner, repoName, baseBranch = GIT_DEFAULT_BRANCH) {
    // Sanitize issue title for branch name
    const sanitizedTitle = issueTitle
        .toLowerCase()
        .replace(/[^a-z0-9_\-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 50);
    
    const branchName = `ai-fix/${issueId}-${sanitizedTitle}`;
    const worktreeDirName = `issue-${issueId}`;
    const worktreePath = path.join(WORKTREES_BASE_PATH, owner, repoName, worktreeDirName);
    
    try {
        const git = simpleGit(localRepoPath);
        
        // Check if worktree path already exists
        if (await fs.pathExists(worktreePath)) {
            logger.warn({ 
                worktreePath, 
                issueId 
            }, 'Worktree path already exists. Removing existing worktree...');
            
            await cleanupWorktree(localRepoPath, worktreePath, branchName);
        }
        
        // Ensure parent directory exists
        await fs.ensureDir(path.dirname(worktreePath));
        
        // Check if base branch exists remotely
        try {
            await git.revparse([`origin/${baseBranch}`]);
        } catch (branchError) {
            // Try 'master' if 'main' doesn't exist
            if (baseBranch === 'main') {
                logger.warn({ 
                    repo: `${owner}/${repoName}`, 
                    baseBranch 
                }, 'Main branch not found, trying master branch');
                baseBranch = 'master';
                await git.revparse([`origin/${baseBranch}`]);
            } else {
                throw branchError;
            }
        }
        
        logger.info({ 
            localRepoPath, 
            worktreePath, 
            branchName, 
            baseBranch,
            issueId
        }, 'Creating Git worktree...');
        
        // Create the worktree with new branch
        await git.raw([
            'worktree', 'add', 
            worktreePath, 
            '-b', branchName, 
            `origin/${baseBranch}`
        ]);
        
        logger.info({ 
            worktreePath, 
            branchName, 
            issueId 
        }, 'Git worktree created successfully');
        
        return {
            worktreePath,
            branchName
        };
        
    } catch (error) {
        handleError(error, `Failed to create worktree for issue ${issueId}`);
        throw error;
    }
}

/**
 * Cleans up a Git worktree and optionally its branch
 * @param {string} localRepoPath - Path to the main repository clone
 * @param {string} worktreePath - Path to the worktree to remove
 * @param {string} branchName - Branch name to optionally delete
 * @param {boolean} deleteBranch - Whether to delete the local branch
 */
export async function cleanupWorktree(localRepoPath, worktreePath, branchName, deleteBranch = false) {
    logger.info({ 
        worktreePath, 
        branchName, 
        deleteBranch 
    }, 'Cleaning up Git worktree...');
    
    const git = simpleGit(localRepoPath);
    
    try {
        // Remove the worktree
        await git.raw(['worktree', 'remove', worktreePath, '--force']);
        logger.info({ worktreePath }, 'Worktree removed successfully');
    } catch (error) {
        logger.warn({ 
            worktreePath, 
            error: error.message 
        }, 'Failed to remove worktree with git command, attempting directory removal');
        
        // Try to remove directory directly if git command fails
        try {
            await fs.remove(worktreePath);
            logger.info({ worktreePath }, 'Worktree directory removed directly');
        } catch (fsError) {
            logger.error({ 
                worktreePath, 
                error: fsError.message 
            }, 'Failed to remove worktree directory');
        }
    }
    
    // Optionally delete the local branch
    if (deleteBranch && branchName) {
        try {
            await git.deleteLocalBranch(branchName, true); // Force delete
            logger.info({ branchName }, 'Local branch deleted');
        } catch (branchError) {
            logger.warn({ 
                branchName, 
                error: branchError.message 
            }, 'Failed to delete local branch');
        }
    }
    
    // Prune worktrees to clean up references
    try {
        await git.raw(['worktree', 'prune']);
        logger.debug('Git worktree references pruned');
    } catch (pruneError) {
        logger.warn({ 
            error: pruneError.message 
        }, 'Failed to prune worktree references');
    }
}

/**
 * Gets the repository URL from issue data
 * @param {Object} issue - Issue object containing repository information
 * @returns {string} Repository URL
 */
export function getRepoUrl(issue) {
    return `https://github.com/${issue.repoOwner}/${issue.repoName}.git`;
}

/**
 * Commits changes in a worktree
 * @param {string} worktreePath - Path to the worktree
 * @param {string} commitMessage - Commit message
 * @param {Object} author - Author information {name, email}
 * @returns {Promise<string>} Commit hash
 */
export async function commitChanges(worktreePath, commitMessage, author) {
    const git = simpleGit(worktreePath);
    
    try {
        // Configure author if provided
        if (author) {
            await git.addConfig('user.name', author.name, false, 'local');
            await git.addConfig('user.email', author.email, false, 'local');
        }
        
        // Add all changes
        await git.add('.');
        
        // Check if there are any changes to commit
        const status = await git.status();
        if (status.files.length === 0) {
            logger.info({ worktreePath }, 'No changes to commit');
            return null;
        }
        
        // Commit changes
        const result = await git.commit(commitMessage);
        
        logger.info({ 
            worktreePath, 
            commitHash: result.commit,
            filesChanged: status.files.length
        }, 'Changes committed successfully');
        
        return result.commit;
        
    } catch (error) {
        handleError(error, `Failed to commit changes in worktree ${worktreePath}`);
        throw error;
    }
}

/**
 * Pushes branch from worktree to remote
 * @param {string} worktreePath - Path to the worktree
 * @param {string} branchName - Branch name to push
 * @param {string} remote - Remote name (default: 'origin')
 * @returns {Promise<void>}
 */
export async function pushBranch(worktreePath, branchName, remote = 'origin') {
    const git = simpleGit(worktreePath);
    
    try {
        await git.push([remote, branchName, '--set-upstream']);
        
        logger.info({ 
            worktreePath, 
            branchName, 
            remote 
        }, 'Branch pushed to remote successfully');
        
    } catch (error) {
        handleError(error, `Failed to push branch ${branchName} from worktree ${worktreePath}`);
        throw error;
    }
}