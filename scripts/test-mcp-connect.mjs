import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

const commit = '0c8ca02044c88b181395ca8e15425c0821e588e4';
const repository = process.env.MCP_ROUTING_REPOSITORY;
if (!repository) throw new Error('Set MCP_ROUTING_REPOSITORY to a local integry/propr-routing Git checkout containing the pinned commit.');
const fixture = mkdtempSync(join(tmpdir(), 'propr-connect-integration-'));
const archive = execFileSync('git', ['-C', resolve(repository), 'archive', commit], { maxBuffer: 32 * 1024 * 1024 });
execFileSync('tar', ['-x', '-C', fixture], { input: archive });
execFileSync('npm', ['ci', '--ignore-scripts', '--workspaces=false', '--no-audit', '--no-fund'], { cwd: fixture, stdio: 'inherit' });
const bundle = join(fixture, 'worker.cjs');
await build({ entryPoints: [join(fixture, 'src/index.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs',
  alias: { 'cloudflare:workers': join(fixture, 'test/cloudflareWorkersStub.ts') } });
const coreHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const hash = createHash('sha256');
for (const dir of ['packages/api/mcp', 'packages/api/test/fixtures']) for (const file of readdirSync(dir).sort()) hash.update(file).update(readFileSync(join(dir, file)));
for (const file of ['packages/api/test/mcpConnectIntegration.test.ts', 'packages/api/server.ts', 'scripts/mcp-connect-register.ts', 'package.json', 'package-lock.json']) hash.update(file).update(readFileSync(file));
const sdkVersions = Object.fromEntries(['server', 'node', 'client', 'sdk'].map(name => [name, JSON.parse(readFileSync(`node_modules/@modelcontextprotocol/${name}/package.json`, 'utf8')).version]));
const report = { coreHead, sdkVersions, coreImplementationSha256: hash.digest('hex'), routingHead: commit, fixture,
  isolation: 'Actual bundled Worker with its DurableObject base stub (unused by MCP), actual SQL on SQLite via D1 API adapter; external GitHub and DNS isolated. Core HTTP/auth/tools execute without fixture replacements.' };
writeFileSync(join(fixture, 'commits.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', 'packages/api/test/mcpConnectIntegration.test.ts'], {
  stdio: 'inherit', env: { ...process.env, NODE_ENV: 'test', MCP_ROUTING_BUNDLE: bundle, MCP_ROUTING_FIXTURE: fixture, DATA_DIR: fixture, DB_FILENAME: join(fixture, 'core.sqlite'), LOG_LEVEL: 'error' }
});
process.exitCode = result.status ?? 1;
