/**
 * Git Repository Manager
 * 
 * This module provides a unified interface for git operations by re-exporting
 * functionality from specialized submodules.
 */

// Re-export repository cloning functions
export { 
    ensureRepoCloned, 
    getRepoPath, 
    getRepoUrl,
    setupAuthenticatedRemote 
} from './modules/repoCloning.js';

// Re-export branch operations
export { 
    detectDefaultBranch,
    listRepositoryBranchConfigurations,
    ensureBranchAndPush,
    pushBranch
} from './modules/branchOperations.js';

// Re-export worktree management
export { 
    createWorktreeForIssue,
    createWorktreeFromExistingBranch,
    cleanupWorktree,
    cleanupExpiredWorktrees
} from './modules/worktreeManagement.js';

// Re-export git operations
export { 
    commitChanges 
} from './modules/gitOperations.js';

// Keep backward compatibility by exporting a default object with all functions
import * as repoCloning from './modules/repoCloning.js';
import * as branchOps from './modules/branchOperations.js';
import * as worktreeOps from './modules/worktreeManagement.js';
import * as gitOps from './modules/gitOperations.js';

export default {
    ...repoCloning,
    ...branchOps,
    ...worktreeOps,
    ...gitOps
};