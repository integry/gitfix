#!/usr/bin/env node

/**
 * Simple CLI utility to list repository-specific branch configurations
 */

import 'dotenv/config';
import { listRepositoryBranchConfigurations } from '../src/git/repoManager.js';

function main() {
    console.log('🔧 GitFix Repository Branch Configurations\n');
    
    const configs = listRepositoryBranchConfigurations();
    const configCount = Object.keys(configs).length;
    
    if (configCount === 0) {
        console.log('ℹ️  No repository-specific branch configurations found.');
        console.log('\n📖 To configure repository-specific branches, add environment variables like:');
        console.log('   GIT_DEFAULT_BRANCH_OWNER_REPO=branch_name');
        console.log('\n   Example:');
        console.log('   GIT_DEFAULT_BRANCH_INTEGRY_FOREX=dev');
        console.log('\n📚 See docs/REPOSITORY_BRANCH_CONFIG.md for detailed documentation.');
        return;
    }
    
    console.log(`✅ Found ${configCount} repository-specific branch configuration${configCount > 1 ? 's' : ''}:\n`);
    
    // Sort repositories for consistent output
    const sortedRepos = Object.keys(configs).sort();
    
    sortedRepos.forEach(repoKey => {
        const config = configs[repoKey];
        console.log(`📦 ${repoKey}`);
        console.log(`   Branch: ${config.branch}`);
        console.log(`   Environment Variable: ${config.envKey}`);
        console.log('');
    });
    
    console.log('🔍 Global Configuration:');
    console.log(`   Fallback Branch: ${process.env.GIT_FALLBACK_BRANCH || 'main (default)'}`);
    console.log(`   Default Branch: ${process.env.GIT_DEFAULT_BRANCH || 'main (default)'}`);
    
    console.log('\n📝 Notes:');
    console.log('   • Repository-specific configurations take highest priority');
    console.log('   • If a configured branch doesn\'t exist, automatic detection will be used');
    console.log('   • Changes to .env file require restart to take effect');
    console.log('\n📚 For more information, see docs/REPOSITORY_BRANCH_CONFIG.md');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}