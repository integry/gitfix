import simpleGit from 'simple-git';
import path from 'path';
import fs from 'fs-extra';
import logger from '../../utils/logger.js';
import { withRetry, retryConfigs } from '../../utils/retryHandler.js';
import Redis from 'ioredis';
import { detectDefaultBranch, ensureBranchAndPush } from './branchOperations.js';
import { getRepoConfigKey } from './gitAuthSetup.js';

// Configuration
const WORKTREE_BASE_DIR = process.env.WORKTREE_BASE_DIR || '/tmp/worktrees';
const WORKTREE_CLEANUP_DAYS = parseInt(process.env.WORKTREE_CLEANUP_DAYS || '7', 10);
const WORKTREE_CLEANUP_AFTER_SUCCESS = process.env.WORKTREE_CLEANUP_AFTER_SUCCESS !== 'false';

/**
 * Generates a branch name for an issue
 * @param {number} issueNumber - Issue number
 * @param {string} title - Issue title
 * @param {string} modelName - Model name
 * @returns {string} Branch name
 */
export function generateBranchName(issueNumber, title, modelName = '') {
    // Sanitize the title to create a valid branch name
    let sanitizedTitle = title
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '') // Remove special characters
        .trim()
        .replace(/\s+/g, '-') // Replace spaces with hyphens
        .substring(0, 30); // Limit length

    // Remove trailing hyphens
    sanitizedTitle = sanitizedTitle.replace(/-+$/, '');
    
    const timestamp = new Date().toISOString().split('T')[0].replace(/-/g, '');
    
    // Generate a short random suffix for uniqueness
    const randomSuffix = Math.random().toString(36).substring(2, 5);
    
    if (modelName && modelName !== 'default' && !modelName.includes('claude')) {
        // Include model name for non-default models
        const sanitizedModel = modelName
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, '')
            .substring(0, 10);
        return `ai-fix/${issueNumber}-${sanitizedTitle}-${timestamp}-${sanitizedModel}-${randomSuffix}`;
    }
    
    return `ai-fix/${issueNumber}-${sanitizedTitle}-${timestamp}-${randomSuffix}`;
}

/**
 * Creates a worktree directory name
 * @param {number} issueNumber - Issue number
 * @param {string} branchName - Branch name
 * @returns {string} Worktree directory name
 */
export function getWorktreeDirName(issueNumber, branchName) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    return `issue-${issueNumber}-${timestamp}`;
}

/**
 * Gets the worktree path
 * @param {string} dirName - Directory name
 * @param {string} repoOwner - Repository owner
 * @param {string} repoName - Repository name
 * @returns {string} Full worktree path
 */
export function getWorktreePath(dirName, repoOwner, repoName) {
    return path.join(WORKTREE_BASE_DIR, repoOwner, repoName, dirName);
}

/**
 * Creates a worktree for an issue
 * @param {string} localRepoPath - Local repository path
 * @param {number} issueNumber - Issue number
 * @param {string} title - Issue title
 * @param {string} repoOwner - Repository owner
 * @param {string} repoName - Repository name
 * @param {string} baseBranch - Base branch (optional)
 * @param {Object} octokit - GitHub API client
 * @param {string} modelName - Model name
 * @returns {Promise<Object>} Worktree information
 */
export async function createWorktreeForIssue(localRepoPath, issueNumber, title, repoOwner, repoName, baseBranch, octokit, modelName = '') {
    const git = simpleGit(localRepoPath);
    
    // Generate branch name
    const branchName = generateBranchName(issueNumber, title, modelName);
    
    // If no base branch specified, detect the default branch
    if (!baseBranch) {
        baseBranch = await detectDefaultBranch(localRepoPath, octokit, repoOwner, repoName);
    }
    
    logger.info({ 
        issueNumber, 
        branchName, 
        baseBranch, 
        modelName 
    }, 'Creating worktree for issue');
    
    // Get the latest commit on base branch
    await withRetry(
        async () => {
            await git.fetch(['origin', baseBranch]);
        },
        retryConfigs.gitOperations,
        'fetch_base_branch'
    );
    
    // Create and setup worktree
    const worktreeDirName = getWorktreeDirName(issueNumber, branchName);
    const worktreePath = getWorktreePath(worktreeDirName, repoOwner, repoName);
    
    await fs.ensureDir(path.dirname(worktreePath));
    
    await withRetry(
        async () => {
            await git.raw(['worktree', 'add', '-b', branchName, worktreePath, `origin/${baseBranch}`]);
        },
        retryConfigs.gitOperations,
        'create_worktree'
    );
    
    // Store branch configuration in Redis
    const redis = new Redis({
        host: process.env.REDIS_HOST || 'redis',
        port: process.env.REDIS_PORT || 6379
    });
    
    try {
        const configKey = getRepoConfigKey(repoOwner, repoName);
        await redis.hset(configKey, branchName, JSON.stringify({
            issueNumber,
            baseBranch,
            createdAt: new Date().toISOString(),
            modelName
        }));
        await redis.expire(configKey, 86400 * 30); // 30 days expiry
    } finally {
        await redis.quit();
    }
    
    logger.info({ worktreePath, branchName }, 'Worktree created successfully');
    
    return {
        worktreePath,
        branchName,
        baseBranch
    };
}

/**
 * Creates a worktree from an existing branch (for PR follow-ups)
 * @param {string} localRepoPath - Local repository path
 * @param {string} branchName - Existing branch name
 * @param {string} worktreeDirName - Worktree directory name
 * @param {string} repoOwner - Repository owner
 * @param {string} repoName - Repository name
 * @returns {Promise<Object>} Worktree information
 */
export async function createWorktreeFromExistingBranch(localRepoPath, branchName, worktreeDirName, repoOwner, repoName) {
    const git = simpleGit(localRepoPath);
    const worktreePath = getWorktreePath(worktreeDirName, repoOwner, repoName);
    
    logger.info({ 
        branchName, 
        worktreePath 
    }, 'Creating worktree from existing branch');
    
    await fs.ensureDir(path.dirname(worktreePath));
    
    // Fetch latest changes
    await withRetry(
        async () => {
            await git.fetch(['origin', branchName]);
        },
        retryConfigs.gitOperations,
        'fetch_existing_branch'
    );
    
    // Create worktree from existing branch
    await withRetry(
        async () => {
            await git.raw(['worktree', 'add', worktreePath, `origin/${branchName}`]);
        },
        retryConfigs.gitOperations,
        'create_worktree_from_existing'
    );
    
    // Set up local tracking
    const worktreeGit = simpleGit(worktreePath);
    await worktreeGit.branch(['--set-upstream-to', `origin/${branchName}`]);
    
    logger.info({ worktreePath, branchName }, 'Worktree created from existing branch');
    
    return {
        worktreePath,
        branchName
    };
}

/**
 * Cleans up a worktree
 * @param {string} localRepoPath - Local repository path
 * @param {string} worktreePath - Worktree path
 * @param {string} branchName - Branch name
 * @param {Object} options - Cleanup options
 * @returns {Promise<void>}
 */
export async function cleanupWorktree(localRepoPath, worktreePath, branchName, options = {}) {
    const { deleteBranch = false, success = true } = options;
    
    if (!WORKTREE_CLEANUP_AFTER_SUCCESS && success) {
        logger.info({ 
            worktreePath, 
            branchName 
        }, 'Skipping worktree cleanup (WORKTREE_CLEANUP_AFTER_SUCCESS=false)');
        return;
    }
    
    const git = simpleGit(localRepoPath);
    
    try {
        // Remove worktree
        await git.raw(['worktree', 'remove', worktreePath, '--force']);
        logger.info({ worktreePath }, 'Removed worktree');
        
        // Delete local branch if requested
        if (deleteBranch) {
            await git.branch(['-D', branchName]);
            logger.info({ branchName }, 'Deleted local branch');
        }
    } catch (error) {
        logger.warn({ 
            error: error.message, 
            worktreePath, 
            branchName 
        }, 'Failed to cleanup worktree');
    }
}

/**
 * Lists all worktrees for a repository
 * @param {string} localRepoPath - Local repository path
 * @returns {Promise<Array>} List of worktrees
 */
export async function listWorktrees(localRepoPath) {
    const git = simpleGit(localRepoPath);
    
    try {
        const output = await git.raw(['worktree', 'list', '--porcelain']);
        const worktrees = [];
        const lines = output.split('\n');
        
        let currentWorktree = {};
        for (const line of lines) {
            if (line.startsWith('worktree ')) {
                if (currentWorktree.path) {
                    worktrees.push(currentWorktree);
                }
                currentWorktree = { path: line.substring(9) };
            } else if (line.startsWith('HEAD ')) {
                currentWorktree.head = line.substring(5);
            } else if (line.startsWith('branch ')) {
                currentWorktree.branch = line.substring(7);
            }
        }
        
        if (currentWorktree.path) {
            worktrees.push(currentWorktree);
        }
        
        return worktrees;
    } catch (error) {
        logger.error({ 
            error: error.message, 
            localRepoPath 
        }, 'Failed to list worktrees');
        return [];
    }
}

/**
 * Cleans up expired worktrees
 * @param {string} localRepoPath - Local repository path
 * @param {number} maxAgeDays - Maximum age in days
 * @returns {Promise<number>} Number of cleaned up worktrees
 */
export async function cleanupExpiredWorktrees(localRepoPath, maxAgeDays = WORKTREE_CLEANUP_DAYS) {
    const worktrees = await listWorktrees(localRepoPath);
    const now = Date.now();
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    let cleanedUp = 0;
    
    for (const worktree of worktrees) {
        if (worktree.path === localRepoPath) {
            continue; // Skip main worktree
        }
        
        try {
            const stats = await fs.stat(worktree.path);
            const age = now - stats.mtime.getTime();
            
            if (age > maxAgeMs) {
                logger.info({ 
                    worktreePath: worktree.path, 
                    ageInDays: Math.floor(age / (24 * 60 * 60 * 1000)) 
                }, 'Cleaning up expired worktree');
                
                await cleanupWorktree(localRepoPath, worktree.path, worktree.branch, {
                    deleteBranch: true
                });
                cleanedUp++;
            }
        } catch (error) {
            logger.warn({ 
                error: error.message, 
                worktreePath: worktree.path 
            }, 'Failed to check worktree age');
        }
    }
    
    logger.info({ cleanedUp, total: worktrees.length }, 'Completed worktree cleanup');
    return cleanedUp;
}