/**
 * Prompt Generation Module for Claude Code
 * 
 * This module handles the generation of prompts for various Claude Code operations.
 */

/**
 * Generates a context-aware prompt for Claude Code to analyze and fix GitHub issues
 * @param {Object} issueRef - GitHub issue reference
 * @param {string} issueRef.number - Issue number
 * @param {string} issueRef.repoOwner - Repository owner
 * @param {string} issueRef.repoName - Repository name
 * @param {string} branchName - The specific branch name to use (optional)
 * @param {string} modelName - The AI model being used (optional)
 * @param {Object} issueDetails - Pre-fetched issue details (optional)
 * @returns {string} Formatted prompt for Claude
 */
export function generateClaudePrompt(issueRef, branchName = null, modelName = null, issueDetails = null) {
    const branchInfo = branchName ? `\n- **BRANCH**: You are working on branch \`${branchName}\`.` : '';
    const modelInfo = modelName ? `\n- **MODEL**: This task is being processed by the \`${modelName}\` model.` : '';

    // Build issue details section if provided
    let issueDetailsSection = '';
    if (issueDetails) {
        issueDetailsSection = `

**ISSUE DETAILS (Pre-fetched for reliability):**

**Title:** ${issueDetails.title || 'N/A'}

**Description:**
${issueDetails.body || 'No description provided'}

**Labels:** ${issueDetails.labels?.map(l => l.name).join(', ') || 'None'}

**Created by:** @${issueDetails.user?.login || 'unknown'}
**Created at:** ${issueDetails.created_at || 'unknown'}`;

        // Add comments if available
        if (issueDetails.comments && issueDetails.comments.length > 0) {
            issueDetailsSection += `\n\n**Comments (${issueDetails.comments.length} total):**\n`;
            issueDetails.comments.forEach((comment, index) => {
                issueDetailsSection += `\n---\n**Comment ${index + 1}** by @${comment.user?.login || 'unknown'} (${comment.created_at || 'unknown'}):\n${comment.body || 'Empty comment'}\n`;
            });
        } else {
            issueDetailsSection += `\n\n**Comments:** No comments on this issue yet.`;
        }

        issueDetailsSection += `\n\n**Note:** The above issue details have been automatically injected. You can still use \`gh issue view ${issueRef.number}\` if you need to fetch any additional information or verify the details.`;
    }

    return `Please analyze and implement a solution for GitHub issue #${issueRef.number}.

**REPOSITORY INFORMATION:**
- Repository Owner: ${issueRef.repoOwner}
- Repository Name: ${issueRef.repoName}
- Full Repository: ${issueRef.repoOwner}/${issueRef.repoName}${branchInfo}${modelInfo}${issueDetailsSection}

**YOUR FOCUS: IMPLEMENTATION ONLY**

The git workflow (branching, committing, pushing, PR creation) is handled automatically by the system. Your job is to focus solely on implementing the solution.

Follow these steps systematically:
1. ${issueDetails ? 'Review the pre-fetched issue details above' : `Use \`gh issue view ${issueRef.number}\` to get the issue details`}
2. ${issueDetails ? '(Optional)' : ''} Use \`gh issue view ${issueRef.number} --comments\` to ${issueDetails ? 'fetch any additional comments or verify the information' : 'read all issue comments for additional context'}
3. **Pay attention to any images, screenshots, or attachments** in the issue description and comments - these often contain crucial visual information like UI mockups, error screenshots, or design specifications
4. Understand the complete problem described in the issue, comments, and any visual materials
5. Search the codebase to understand the current implementation
6. Implement the necessary changes to solve the issue
7. Test your implementation (if applicable and possible)
8. Ensure code follows existing patterns and conventions

**IMPORTANT NOTES:**
- **DO NOT** worry about git operations (add, commit, push, PR creation)
- **DO NOT** use git commands or GitHub CLI for workflow operations
- **FOCUS ONLY** on implementing the solution to the problem
- You are working in a git worktree environment with the codebase ready
- Make your changes directly to the files that need modification
- The system will automatically handle committing, pushing, and creating a PR
- Include a brief summary of what you implemented when you're done

**SUCCESS CRITERIA:**
Your task is complete when you have implemented a working solution to the issue. The git workflow and PR creation will be handled automatically by the system after your implementation.

**CRITICAL GIT SAFETY RULES:**
- NEVER run 'rm .git' or delete the .git file/directory
- NEVER run 'git init' in the workspace - this is already a git repository
- If you encounter git errors, report them but DO NOT attempt to reinitialize the repository
- The workspace is a git worktree linked to the main repository
- Only make changes to the specific files mentioned in the issue/request
- If git commands fail, describe the error but do not try destructive recovery methods
- NOTE: You may encounter permission errors when trying to commit - this is expected
- The system will automatically commit your changes after you complete the modifications`;
}

/**
 * Generates a prompt for task import operations
 * @param {string} taskDescription - The task description provided by the user
 * @param {string} repoOwner - Repository owner
 * @param {string} repoName - Repository name
 * @param {string} worktreePath - Path to the worktree
 * @returns {string} Formatted prompt for task import
 */
export function generateTaskImportPrompt(taskDescription, repoOwner, repoName, worktreePath) {
    return `You are a task planning assistant. Your job is to analyze the user's request and create appropriate GitHub issues.

**USER'S REQUEST:**
${taskDescription}

**REPOSITORY INFORMATION:**
- Repository: ${repoOwner}/${repoName}
- Working Directory: ${worktreePath}

**YOUR TASKS:**
1. Analyze the user's request to understand what they want to build or accomplish
2. Explore the repository structure to understand the codebase
3. Break down the request into logical, implementable tasks
4. Create GitHub issues for each task using the \`gh issue create\` command

**GUIDELINES FOR CREATING ISSUES:**
- Each issue should be focused on a single, well-defined task
- Include clear acceptance criteria
- Add relevant labels (always include the "AI" label so the system can process it)
- Use descriptive titles that clearly state what needs to be done
- In the issue body, provide:
  - Context and background
  - Specific requirements
  - Technical details if applicable
  - Any dependencies on other tasks

**EXAMPLE ISSUE CREATION:**
\`\`\`bash
gh issue create \\
  --title "Add user authentication system" \\
  --body "## Description
Implement a complete user authentication system...

## Requirements
- User registration with email
- Login/logout functionality
- Password reset capability

## Technical Details
- Use JWT tokens
- Implement refresh token mechanism" \\
  --label "AI" \\
  --label "enhancement" \\
  --label "backend"
\`\`\`

**IMPORTANT:**
- Always add the "AI" label to issues you create
- Create issues that are specific enough to be implemented independently
- If the request is complex, break it into multiple smaller issues
- Use appropriate additional labels (bug, enhancement, feature, etc.)

Please analyze the request and create the appropriate GitHub issues.`;
}

/**
 * Generates an enhanced prompt for retry operations
 * @param {Object} params - Parameters for generating the retry prompt
 * @param {Object} params.issueRef - Issue reference
 * @param {string} params.retryReason - Reason for retry
 * @param {string} params.branchName - Branch name
 * @param {string} params.modelName - Model name
 * @param {Object} params.issueDetails - Issue details
 * @returns {string} Enhanced prompt for retry
 */
export function generateRetryPrompt(params) {
    const { issueRef, retryReason, branchName, modelName, issueDetails } = params;
    
    const basePrompt = generateClaudePrompt(issueRef, branchName, modelName, issueDetails);
    
    return `**RETRY ATTEMPT - ${retryReason}**

This is a retry attempt. The previous execution may have failed or been interrupted.

${basePrompt}

**ADDITIONAL RETRY INSTRUCTIONS:**
- Check if any work was already partially completed
- Review any existing changes in the worktree
- Continue from where the previous attempt left off if applicable
- Ensure all required changes are implemented`;
}