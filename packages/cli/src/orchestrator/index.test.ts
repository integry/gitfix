import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigManager } from "../config/ConfigManager.js";
import { connectExecutionEnvironment, getHostConfig, loadOrchestrator } from "./index.js";

function createStackRoot(parent: string, name: string): string {
  const root = join(parent, name);
  mkdirSync(root);
  for (const dir of ["data", "logs", "repos"]) mkdirSync(join(root, dir));
  writeFileSync(join(root, ".env"), "");
  return root;
}

test("explicit new root does not inherit legacy tunnel intent during start preflight", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "propr-root-isolation-test-"));
  try {
    const rootA = createStackRoot(tempDir, "root-a");
    const rootB = createStackRoot(tempDir, "root-b");
    const configDir = join(tempDir, "config");
    mkdirSync(configDir);
    writeFileSync(join(configDir, "config.json"), JSON.stringify({
      stackRoot: rootA,
      tunnelEnabled: true,
    }));

    const configManager = new ConfigManager(configDir);
    await configManager.init();

    const rootAHost = await getHostConfig({ configManager, root: rootA });
    assert.equal(rootAHost.cfg.uiTunnelEnabled, true);

    // This is the same resolution and validation path used by setup's
    // startStack action after the user accepts "Start the stack now?".
    const rootBHost = await getHostConfig({ configManager, root: rootB });
    assert.equal(rootBHost.cfg.uiTunnelEnabled, false);
    const preflight = rootBHost.orch.validateEnv(rootBHost.cfg);
    assert.equal(preflight.ok, true, preflight.errors.join("\n"));

    // Persisting setup's newly selected default root must not move A's intent.
    await configManager.setStackRoot(rootB);
    assert.equal(configManager.getTunnelEnabled(rootA), true);
    assert.equal(configManager.getTunnelEnabled(rootB), undefined);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("owned-stack replacement validates mounts first and mutates immutable container IDs", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "propr-owned-replacement-test-"));
  const rootDir = createStackRoot(tempDir, "managed-root");
  const docker = join(tempDir, "docker");
  const log = join(tempDir, "docker.jsonl");
  const originalPath = process.env.PATH;
  process.env.PROPR_TEST_DOCKER_LOG = log;
  process.env.PROPR_TEST_MANAGED_ROOT = rootDir;
  writeFileSync(docker, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const apiId = 'a'.repeat(64);
const uiId = 'b'.repeat(64);
fs.appendFileSync(process.env.PROPR_TEST_DOCKER_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'ps') process.stdout.write(apiId + '\\n' + uiId + '\\n');
if (args[0] === 'inspect') {
  const id = args.at(-1);
  const service = id === apiId ? 'api' : 'ui';
  const root = process.env.PROPR_TEST_MANAGED_ROOT;
  const mounts = service === 'api' ? [
    { Type: 'bind', Source: path.join(root, 'data'), Destination: '/usr/src/app/data' },
    { Type: 'bind', Source: path.join(root, 'logs'), Destination: '/usr/src/app/logs' },
    { Type: 'bind', Source: path.join(root, '.env'), Destination: '/usr/src/app/.env' },
  ] : [];
  process.stdout.write([id, '/desktop-owned-' + service, {
    'propr.stack': 'desktop-owned', 'propr.service': service,
  }, mounts].map(JSON.stringify).join('\\t') + '\\n');
}
`, { mode: 0o700 });
  chmodSync(docker, 0o700);
  process.env.PATH = `${tempDir}:${originalPath ?? ""}`;
  try {
    const orch = await loadOrchestrator();
    await orch.replaceStackContainersAsync({
      stack: "desktop-owned", validateHostPaths: true,
      hostData: join(rootDir, "data"), hostLogs: join(rootDir, "logs"),
      hostRepos: join(rootDir, "repos"), envFileHost: join(rootDir, ".env"),
    } as never);
    const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(calls.map((call: string[]) => [call[0], call.at(-1)]), [
      ["ps", "{{.ID}}"],
      ["inspect", "a".repeat(64)], ["inspect", "b".repeat(64)],
      ["stop", "a".repeat(64)], ["rm", "a".repeat(64)],
      ["stop", "b".repeat(64)], ["rm", "b".repeat(64)],
    ]);
    const mutations = calls.filter((call: string[]) => call[0] === "stop" || call[0] === "rm");
    assert.equal(mutations.flat().some((argument: string) => /volume|network|data|credential/i.test(argument)), false);
  } finally {
    process.env.PATH = originalPath;
    delete process.env.PROPR_TEST_DOCKER_LOG;
    delete process.env.PROPR_TEST_MANAGED_ROOT;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("owned-stack replacement refuses a same-label container mounted from another root without mutation", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "propr-foreign-replacement-test-"));
  const rootDir = createStackRoot(tempDir, "managed-root");
  const foreignRoot = createStackRoot(tempDir, "foreign-root");
  const docker = join(tempDir, "docker");
  const log = join(tempDir, "docker.jsonl");
  const originalPath = process.env.PATH;
  process.env.PROPR_TEST_DOCKER_LOG = log;
  process.env.PROPR_TEST_FOREIGN_ROOT = foreignRoot;
  writeFileSync(docker, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const id = 'c'.repeat(64);
fs.appendFileSync(process.env.PROPR_TEST_DOCKER_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'ps') process.stdout.write(id + '\\n');
if (args[0] === 'inspect') {
  const root = process.env.PROPR_TEST_FOREIGN_ROOT;
  const mounts = [
    { Type: 'bind', Source: path.join(root, 'data'), Destination: '/usr/src/app/data' },
    { Type: 'bind', Source: path.join(root, 'logs'), Destination: '/usr/src/app/logs' },
    { Type: 'bind', Source: path.join(root, '.env'), Destination: '/usr/src/app/.env' },
  ];
  process.stdout.write([id, '/desktop-owned-api', {
    'propr.stack': 'desktop-owned', 'propr.service': 'api',
  }, mounts].map(JSON.stringify).join('\\t') + '\\n');
}
`, { mode: 0o700 });
  chmodSync(docker, 0o700);
  process.env.PATH = `${tempDir}:${originalPath ?? ""}`;
  try {
    const orch = await loadOrchestrator();
    await assert.rejects(orch.replaceStackContainersAsync({
      stack: "desktop-owned", validateHostPaths: true,
      hostData: join(rootDir, "data"), hostLogs: join(rootDir, "logs"),
      hostRepos: join(rootDir, "repos"), envFileHost: join(rootDir, ".env"),
    } as never), /ownership metadata does not match/);
    const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(calls.map((call: string[]) => call[0]), ["ps", "inspect"]);
  } finally {
    process.env.PATH = originalPath;
    delete process.env.PROPR_TEST_DOCKER_LOG;
    delete process.env.PROPR_TEST_FOREIGN_ROOT;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Connect forwards only validated Docker transport and process bootstrap variables", () => {
  const windows = process.platform === "win32";
  const platform = windows ? "win32" : process.platform;
  const path = windows ? "C:\\trusted\\bin" : "/trusted/bin";
  const certPath = windows ? "C:\\private\\certs" : "/private/certs";
  const configPath = windows ? "C:\\private\\docker-config" : "/private/docker-config";
  const sshSocket = windows ? "\\\\.\\pipe\\trusted-ssh-agent" : "/trusted/ssh-agent";
  const platformHome = windows ? { USERPROFILE: "C:\\Users\\trusted" } : { HOME: "/trusted/home" };
  const environment = connectExecutionEnvironment({
    PATH: path,
    DOCKER_HOST: "ssh://docker.example.test",
    DOCKER_CONTEXT: "remote-context",
    DOCKER_TLS: "1",
    DOCKER_TLS_VERIFY: "1",
    DOCKER_CERT_PATH: certPath,
    DOCKER_CONFIG: configPath,
    PROPR_UI_TUNNEL_TOKEN: "must-not-cross",
    ...platformHome,
    HOME: windows ? "/must/not/cross" : platformHome.HOME,
    SSH_AUTH_SOCK: sshSocket,
    DOCKER_AUTH_CONFIG: "must-not-cross",
    NODE_OPTIONS: "must-not-cross",
    HTTPS_PROXY: "must-not-cross",
  }, platform);
  assert.deepEqual(environment, {
    PATH: path,
    DOCKER_HOST: "ssh://docker.example.test",
    DOCKER_CONTEXT: "remote-context",
    DOCKER_TLS: "1",
    DOCKER_TLS_VERIFY: "1",
    DOCKER_CERT_PATH: certPath,
    DOCKER_CONFIG: configPath,
    ...platformHome,
    SSH_AUTH_SOCK: sshSocket,
  });
  for (const invalid of [
    { DOCKER_HOST: "x".repeat(4097) },
    { DOCKER_CONTEXT: "x".repeat(256) },
    { DOCKER_CONTEXT: "é".repeat(128) },
    { DOCKER_TLS: "" },
    { DOCKER_TLS: "x".repeat(17) },
    { DOCKER_CERT_PATH: "private\0path" },
    { DOCKER_CONFIG: 42 },
    { DOCKER_TLS_VERIFY: "" },
  ]) assert.throws(() => connectExecutionEnvironment(invalid, platform), /environment/);

  assert.deepEqual(connectExecutionEnvironment({
    PATH: "C:\\trusted\\bin",
    HOMEDRIVE: "C:",
    HOMEPATH: "\\Users\\trusted",
    HOME: "/must/not/cross",
  }, "win32"), {
    PATH: "C:\\trusted\\bin",
    HOMEDRIVE: "C:",
    HOMEPATH: "\\Users\\trusted",
  });
  for (const invalidHome of [
    { USERPROFILE: "relative" },
    { HOMEDRIVE: "C:" },
    { HOMEPATH: "\\Users\\trusted" },
    { HOMEDRIVE: "relative", HOMEPATH: "\\Users\\trusted" },
    { HOMEDRIVE: "C:", HOMEPATH: "relative" },
  ]) assert.throws(() => connectExecutionEnvironment(invalidHome, "win32"), /platform environment/);
});
