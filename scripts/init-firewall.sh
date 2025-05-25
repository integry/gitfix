#!/bin/bash
# Firewall initialization script for Claude Code execution environment
# Implements network restrictions for secure AI code execution

set -e

# Only allow outbound connections to essential services
# This script should be run with sudo privileges during container startup

echo "Initializing firewall rules for Claude Code execution..."

# Clear existing rules
iptables -F
iptables -X

# Set default policies
iptables -P INPUT DROP
iptables -P FORWARD DROP
iptables -P OUTPUT DROP

# Allow loopback traffic
iptables -A INPUT -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT

# Allow established and related connections
iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# Allow outbound HTTPS to Anthropic API
iptables -A OUTPUT -p tcp --dport 443 -d api.anthropic.com -j ACCEPT

# Allow outbound HTTPS to GitHub API and services
iptables -A OUTPUT -p tcp --dport 443 -d api.github.com -j ACCEPT
iptables -A OUTPUT -p tcp --dport 443 -d github.com -j ACCEPT
iptables -A OUTPUT -p tcp --dport 443 -d objects.githubusercontent.com -j ACCEPT

# Allow DNS queries
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT

# Allow outbound SSH for Git operations (if needed)
iptables -A OUTPUT -p tcp --dport 22 -j ACCEPT

# Log dropped packets for debugging (optional)
iptables -A INPUT -j LOG --log-prefix "FIREWALL-INPUT-DROP: "
iptables -A OUTPUT -j LOG --log-prefix "FIREWALL-OUTPUT-DROP: "

echo "Firewall rules initialized successfully"
echo "Allowed outbound connections:"
echo "  - HTTPS to api.anthropic.com (Claude API)"
echo "  - HTTPS to GitHub services"
echo "  - DNS queries"
echo "  - SSH for Git operations"
echo "All other traffic is blocked for security"