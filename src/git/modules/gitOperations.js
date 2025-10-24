import simpleGit from 'simple-git';
import fs from 'fs-extra';
import path from 'path';
import logger from '../../utils/logger.js';
import { handleError } from '../../utils/errorHandler.js';

/**
 * Commits changes in a worktree
 * @param {string} worktreePath - Path to the worktree
 * @param {string} commitMessage - Commit message
 * @param {Object} author - Author information
 * @param {number} issueNumber - Issue number
 * @param {string} issueTitle - Issue title
 * @returns {Promise<Object|null>} Commit information or null if no changes
 */
export async function commitChanges(worktreePath, commitMessage, author, issueNumber, issueTitle) {
    const git = simpleGit(worktreePath);
    
    try {
        // Check if there are any changes to commit
        const status = await git.status();
        
        logger.info({
            worktreePath,
            modifiedFiles: status.modified.length,
            createdFiles: status.created.length,
            deletedFiles: status.deleted.length,
            notAddedFiles: status.not_added.length
        }, 'Git status before commit');
        
        if (status.files.length === 0) {
            logger.info({
                worktreePath,
                issueNumber
            }, 'No changes to commit');
            return null;
        }
        
        // Stage all changes
        await git.add('.');
        
        // Configure git user for this commit
        if (author && author.name && author.email) {
            await git.addConfig('user.name', author.name);
            await git.addConfig('user.email', author.email);
        }
        
        // Commit the changes
        await git.commit(commitMessage);
        
        // Get commit info
        const commitInfo = await git.log(['-1']);
        const latestCommit = commitInfo.latest;
        
        logger.info({
            worktreePath,
            commitHash: latestCommit.hash,
            commitMessage: latestCommit.message,
            filesChanged: status.files.length
        }, 'Successfully created commit');
        
        return {
            commitHash: latestCommit.hash,
            commitMessage: latestCommit.message,
            author: latestCommit.author_name,
            email: latestCommit.author_email,
            date: latestCommit.date,
            filesChanged: status.files.length,
            files: {
                modified: status.modified,
                created: status.created,
                deleted: status.deleted
            }
        };
        
    } catch (error) {
        // Check if the error is due to no changes
        if (error.message && error.message.includes('nothing to commit')) {
            logger.info({
                worktreePath,
                issueNumber
            }, 'No changes to commit (caught from git error)');
            return null;
        }
        
        handleError(error, 'Failed to commit changes', {
            worktreePath,
            issueNumber,
            issueTitle
        });
        throw error;
    }
}