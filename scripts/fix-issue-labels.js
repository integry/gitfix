#!/usr/bin/env node

/**
 * Manual script to fix issue labels when post-processing fails
 * Usage: node scripts/fix-issue-labels.js <owner> <repo> <issueNumber>
 */

import { getAuthenticatedOctokit } from '../src/auth/githubAuth.js';
import logger from '../src/utils/logger.js';

const AI_PROCESSING_TAG = process.env.AI_PROCESSING_TAG || 'AI-processing';
const AI_DONE_TAG = process.env.AI_DONE_TAG || 'AI-done';

async function fixIssueLabels(owner, repo, issueNumber) {
    try {
        const octokit = await getAuthenticatedOctokit();
        
        logger.info({ owner, repo, issueNumber }, 'Fixing issue labels...');
        
        // Remove processing tag
        try {
            await octokit.request('DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', {
                owner,
                repo,
                issue_number: issueNumber,
                name: AI_PROCESSING_TAG,
            });
            logger.info({ issueNumber, tag: AI_PROCESSING_TAG }, 'Removed processing tag');
        } catch (removeError) {
            logger.warn({ error: removeError.message }, 'Failed to remove processing tag (might not exist)');
        }
        
        // Add done tag
        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
            owner,
            repo,
            issue_number: issueNumber,
            labels: [AI_DONE_TAG],
        });
        logger.info({ issueNumber, tag: AI_DONE_TAG }, 'Added done tag');
        
        // Check if there's a PR for this issue
        const prs = await octokit.request('GET /repos/{owner}/{repo}/pulls', {
            owner,
            repo,
            state: 'open',
            per_page: 20
        });
        
        const relatedPR = prs.data.find(pr => 
            pr.title.includes(`#${issueNumber}`) || 
            pr.body?.includes(`#${issueNumber}`) ||
            pr.head.ref.includes(issueNumber.toString())
        );
        
        if (relatedPR) {
            logger.info({
                issueNumber,
                prNumber: relatedPR.number,
                prUrl: relatedPR.html_url,
                prTitle: relatedPR.title
            }, 'Found related PR');
            
            // Add comment to issue linking to PR
            await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                owner,
                repo,
                issue_number: issueNumber,
                body: `🤖 **Issue Processing Completed**

A pull request has been created to address this issue: #${relatedPR.number}

**PR Details:**
- **Title**: ${relatedPR.title}
- **URL**: ${relatedPR.html_url}
- **Branch**: \`${relatedPR.head.ref}\`

Please review the changes and merge when ready.

---
*Labels updated manually after successful processing*`
            });
            
            logger.info({ issueNumber, prNumber: relatedPR.number }, 'Added comment linking to PR');
        } else {
            logger.warn({ issueNumber }, 'No related PR found');
        }
        
        logger.info({ owner, repo, issueNumber }, 'Issue labels fixed successfully');
        
    } catch (error) {
        logger.error({ 
            owner, 
            repo, 
            issueNumber, 
            error: error.message 
        }, 'Failed to fix issue labels');
        throw error;
    }
}

// Parse command line arguments
const [owner, repo, issueNumber] = process.argv.slice(2);

if (!owner || !repo || !issueNumber) {
    console.error('Usage: node scripts/fix-issue-labels.js <owner> <repo> <issueNumber>');
    console.error('Example: node scripts/fix-issue-labels.js integry forex 346');
    process.exit(1);
}

// Run the fix
fixIssueLabels(owner, repo, parseInt(issueNumber, 10))
    .then(() => {
        console.log('✅ Issue labels fixed successfully');
        process.exit(0);
    })
    .catch((error) => {
        console.error('❌ Failed to fix issue labels:', error.message);
        process.exit(1);
    });