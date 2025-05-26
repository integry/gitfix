import { getAuthenticatedOctokit } from './auth/githubAuth.js';
import logger from './utils/logger.js';
import { handleError } from './utils/errorHandler.js';

// Configuration
const DEFAULT_BASE_BRANCH = process.env.GIT_DEFAULT_BRANCH || 'main';
const MAX_COMMENT_LENGTH = 65000; // GitHub's comment length limit

/**
 * Creates a Pull Request for the given branch and issue
 * @param {Object} options - PR creation options
 * @returns {Promise<{number: number, url: string, title: string}>} PR details
 */
export async function createPullRequest(options) {
    const {
        owner,
        repoName,
        branchName,
        baseBranch = DEFAULT_BASE_BRANCH,
        issueNumber,
        issueTitle,
        commitMessage,
        claudeResult
    } = options;

    try {
        const octokit = await getAuthenticatedOctokit();

        // Generate PR title and body
        const prTitle = `AI Fix for Issue #${issueNumber}: ${issueTitle}`;
        const prBody = generatePRBody(issueNumber, issueTitle, commitMessage, claudeResult);

        logger.info({
            owner,
            repoName,
            branchName,
            baseBranch,
            issueNumber,
            prTitle
        }, 'Creating pull request...');

        // Create the pull request
        const response = await octokit.request('POST /repos/{owner}/{repo}/pulls', {
            owner,
            repo: repoName,
            title: prTitle,
            head: branchName,
            base: baseBranch,
            body: prBody,
            draft: false
        });

        const prData = response.data;

        logger.info({
            owner,
            repoName,
            issueNumber,
            prNumber: prData.number,
            prUrl: prData.html_url,
            branchName
        }, 'Pull request created successfully');

        return {
            number: prData.number,
            url: prData.html_url,
            title: prData.title
        };

    } catch (error) {
        handleError(error, `Failed to create pull request for issue #${issueNumber}`);
        throw error;
    }
}

/**
 * Adds Claude execution logs as a comment to the Pull Request
 */
export async function addClaudeLogsComment(options) {
    const {
        owner,
        repoName,
        prNumber,
        claudeResult,
        issueNumber
    } = options;

    try {
        const octokit = await getAuthenticatedOctokit();
        const commentBody = generateClaudeLogsComment(claudeResult, issueNumber);

        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner,
            repo: repoName,
            issue_number: prNumber,
            body: commentBody
        });

        logger.info({
            owner,
            repoName,
            prNumber,
            issueNumber
        }, 'Claude logs comment added successfully');

    } catch (error) {
        handleError(error, `Failed to add Claude logs comment to PR #${prNumber}`);
        throw error;
    }
}

/**
 * Updates GitHub issue labels atomically
 */
export async function updateIssueLabels(options) {
    const {
        owner,
        repoName,
        issueNumber,
        labelsToRemove = [],
        labelsToAdd = []
    } = options;

    try {
        const octokit = await getAuthenticatedOctokit();

        // Get current issue labels
        const issueResponse = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
            owner,
            repo: repoName,
            issue_number: issueNumber
        });

        const currentLabels = issueResponse.data.labels.map(label => label.name);

        // Calculate new labels set
        const updatedLabels = [
            ...currentLabels.filter(label => !labelsToRemove.includes(label)),
            ...labelsToAdd.filter(label => !currentLabels.includes(label))
        ];

        // Update labels atomically
        await octokit.request('PUT /repos/{owner}/{repo}/issues/{issue_number}/labels', {
            owner,
            repo: repoName,
            issue_number: issueNumber,
            labels: updatedLabels
        });

        logger.info({
            owner,
            repoName,
            issueNumber,
            updatedLabels
        }, 'Issue labels updated successfully');

        return updatedLabels;

    } catch (error) {
        handleError(error, `Failed to update labels for issue #${issueNumber}`);
        throw error;
    }
}

/**
 * Complete post-processing workflow for successful Claude execution
 */
export async function completePostProcessing(options) {
    const {
        owner,
        repoName,
        branchName,
        issueNumber,
        issueTitle,
        commitMessage,
        claudeResult,
        processingTags = ['AI-processing'],
        completionTags = ['AI-done']
    } = options;

    let prInfo = null;
    let updatedLabels = [];

    try {
        logger.info({
            owner,
            repoName,
            issueNumber,
            branchName
        }, 'Starting post-processing workflow...');

        // Step 1: Create Pull Request
        prInfo = await createPullRequest({
            owner,
            repoName,
            branchName,
            issueNumber,
            issueTitle,
            commitMessage,
            claudeResult
        });

        // Step 2: Add Claude logs as PR comment
        await addClaudeLogsComment({
            owner,
            repoName,
            prNumber: prInfo.number,
            claudeResult,
            issueNumber
        });

        // Step 3: Update issue labels
        updatedLabels = await updateIssueLabels({
            owner,
            repoName,
            issueNumber,
            labelsToRemove: processingTags,
            labelsToAdd: completionTags
        });

        logger.info({
            owner,
            repoName,
            issueNumber,
            prNumber: prInfo.number,
            prUrl: prInfo.url
        }, 'Post-processing workflow completed successfully');

        return {
            pr: prInfo,
            updatedLabels
        };

    } catch (error) {
        // If post-processing fails, try to update labels to indicate failure
        try {
            await updateIssueLabels({
                owner,
                repoName,
                issueNumber,
                labelsToRemove: processingTags,
                labelsToAdd: ['AI-failed-post-processing']
            });
        } catch (labelError) {
            logger.warn({
                issueNumber,
                error: labelError.message
            }, 'Failed to update labels after post-processing failure');
        }

        handleError(error, `Post-processing failed for issue #${issueNumber}`);
        throw error;
    }
}

/**
 * Generates Pull Request body content
 */
function generatePRBody(issueNumber, issueTitle, commitMessage, claudeResult) {
    const timestamp = new Date().toISOString();
    const isSuccess = claudeResult?.success || false;
    const executionTime = Math.round((claudeResult?.executionTime || 0) / 1000);

    let body = `## 🤖 AI-Generated Solution\n\n`;
    body += `Resolves #${issueNumber}.\n\n`;
    body += `This Pull Request was automatically generated by Claude Code to address the issue: **${issueTitle}**\n\n`;
    
    body += `### 📋 Execution Summary\n\n`;
    body += `- **Status**: ${isSuccess ? '✅ Success' : '❌ Failed'}\n`;
    body += `- **Execution Time**: ${executionTime}s\n`;
    body += `- **Generated**: ${timestamp}\n`;
    
    if (claudeResult?.finalResult) {
        const result = claudeResult.finalResult;
        body += `- **Claude Turns**: ${result.num_turns || 'unknown'}\n`;
        body += `- **Cost**: $${result.cost_usd || 'unknown'}\n`;
        body += `- **Session ID**: \`${claudeResult.sessionId || 'unknown'}\`\n`;
    }
    
    body += `\n### 💬 Implementation Details\n\n`;
    if (commitMessage) {
        body += `**Commit Message:**\n\`\`\`\n${commitMessage}\n\`\`\`\n\n`;
    }
    
    if (claudeResult?.summary) {
        body += `**Summary:**\n${claudeResult.summary}\n\n`;
    }
    
    body += `**Note:** Detailed conversation logs and execution details will be added as a comment below.\n\n`;
    body += `---\n*This PR was generated automatically by Claude Code. Full execution logs are available in the comments.*`;

    return body;
}

/**
 * Generates Claude logs comment content
 */
function generateClaudeLogsComment(claudeResult, issueNumber) {
    let comment = `## 🔍 Claude Code Execution Logs\n\n`;
    comment += `**Issue**: #${issueNumber}\n`;
    comment += `**Session ID**: \`${claudeResult?.sessionId || 'unknown'}\`\n`;
    comment += `**Timestamp**: ${new Date().toISOString()}\n\n`;

    // Add execution details
    if (claudeResult?.finalResult) {
        const result = claudeResult.finalResult;
        comment += `### 📊 Execution Statistics\n\n`;
        comment += `- **Success**: ${claudeResult.success ? 'Yes' : 'No'}\n`;
        comment += `- **Total Turns**: ${result.num_turns || 'unknown'}\n`;
        comment += `- **Execution Time**: ${Math.round((claudeResult.executionTime || 0) / 1000)}s\n`;
        comment += `- **Cost**: $${result.cost_usd || 'unknown'}\n\n`;
    }

    // Add conversation log summary
    if (claudeResult?.conversationLog && claudeResult.conversationLog.length > 0) {
        comment += `### 💬 Conversation Summary\n\n`;
        comment += `Total messages exchanged: ${claudeResult.conversationLog.length}\n\n`;
    }

    // Ensure comment doesn't exceed GitHub's limit
    if (comment.length > MAX_COMMENT_LENGTH) {
        const truncatePoint = MAX_COMMENT_LENGTH - 200;
        comment = comment.substring(0, truncatePoint);
        comment += '\n\n[Comment truncated due to GitHub length limits]\n';
        comment += `\nFull logs are available in the system logs.`;
    }

    comment += `---\n*Generated by Claude Code*`;

    return comment;
}