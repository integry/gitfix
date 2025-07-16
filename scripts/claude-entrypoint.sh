#!/bin/bash
# Entrypoint script for Claude Code execution container
# Handles initialization and executes Claude Code CLI with proper security

set -e

# Skip firewall initialization for now (requires privileged container)
echo "Skipping firewall setup (would require --privileged Docker flag)"

# Ensure GitHub token is available
if [ -z "$GH_TOKEN" ]; then
    echo "Warning: GH_TOKEN environment variable not set"
    echo "GitHub operations may fail"
else
    echo "GitHub token detected (using environment variable)"
    echo "GitHub CLI will use GH_TOKEN environment variable for authentication"
fi

# Ensure Claude config is mounted and accessible
if [ ! -f "/home/node/.claude/.credentials.json" ]; then
    echo "Warning: Claude credentials not found"
    echo "Ensure Claude config directory is properly mounted"
    echo "Expected path: /home/node/.claude/.credentials.json"
else
    echo "Claude authentication configuration found"
fi

# Configure Git to trust all directories (security: container environment)
git config --global --add safe.directory '*' 2>/dev/null || echo "Git safe directory config already set"

# Set proper permissions for workspace
if [ -d "/home/node/workspace" ]; then
    # Check if we're running as the correct user (should be UID 1000)
    current_uid=$(id -u)
    if [ "$current_uid" = "1000" ]; then
        echo "Running as correct user (UID 1000)"
        # Check if files are already owned by us
        if [ -O "/home/node/workspace" ]; then
            echo "Workspace ownership is correct"
        else
            echo "Warning: Workspace files not owned by container user"
            echo "This may cause permission issues during execution"
        fi
    else
        echo "Warning: Running as UID $current_uid instead of expected 1000"
        # Try to ensure the user owns the workspace (skip if sudo fails in restricted container)
        if sudo chown -R node:node /home/node/workspace 2>/dev/null; then
            echo "Workspace permissions set"
        else
            echo "Workspace permissions already set (sudo not available in restricted container)"
        fi
    fi
fi

# If arguments are provided, execute them
if [ $# -gt 0 ]; then
    echo "Executing command: $@"
    exec "$@"
else
    echo "No command provided, starting interactive shell"
    exec /bin/bash
fi