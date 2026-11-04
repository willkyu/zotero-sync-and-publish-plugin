// Real Git integration test with a bare remote and independent workspaces.
import assert from 'node:assert/strict';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const execFile = promisify(execFileCallback);
const run = (cwd, ...args) => execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' });
const exists = path => access(path).then(() => true, () => false);

// Firefox Subprocess-compatible shim, used only to execute the production
// LocalGit class rather than a duplicate test implementation.
const Subprocess = {
  pathSearch: async command => command,
  call({ command, arguments: args }) {
    const promise = new Promise(resolvePromise => {
      const child = spawn(command, args, { windowsHide: true });
      let stdout = '', stderr = '';
      child.stdout.on('data', b => { stdout += b.toString(); });
      child.stderr.on('data', b => { stderr += b.toString(); });
      child.on('close', exitCode => resolvePromise({ exitCode, stdout, stderr }));
    });
    const stream = key => {
      let read = false;
      return { async readString() { if (read) return ''; read = true; return (await promise)[key]; } };
    };
    return Promise.resolve({ stdout: stream('stdout'), stderr: stream('stderr'), wait: () => promise });
  },
};
globalThis.ChromeUtils = { importESModule: () => ({ Subprocess }) };
globalThis.PathUtils = { isAbsolute, join };
globalThis.IOUtils = { exists };
globalThis.ZoteroGitHubSync = { log(){} };
const source = fileURLToPath(new URL('../src/git.js', import.meta.url));
vm.runInThisContext(readFileSync(source, 'utf8'));

// Zotero launched from the Windows GUI may not inherit Git's PATH entry.
// Verify that the production resolver reaches the conventional installation.
const originalIOUtils = globalThis.IOUtils;
globalThis.Services = {
  appinfo: { OS: 'WINNT' },
  env: { get: name => name === 'ProgramFiles' ? 'C:\\Program Files' : '' },
};
globalThis.IOUtils = { exists: async path => path === 'C:\\Program Files\\Git\\cmd\\git.exe' };
const fallbackClient = new ZoteroGitHubSync.LocalGit({ workspacePath: 'unused', gitExecutable: 'git' });
assert.equal(
  await fallbackClient.resolveExecutable({ pathSearch: async () => { throw new Error('not found'); } }),
  'C:\\Program Files\\Git\\cmd\\git.exe',
);
globalThis.IOUtils = originalIOUtils;

const root = await mkdtemp(join(tmpdir(), 'zqws-git-'));
const remote = join(root, 'remote.git');
const a = join(root, '电脑 A');
const b = join(root, 'computer B');
const c = join(root, 'computer C');
try {
  await execFile('git', ['init', '--bare', '--initial-branch=main', remote]);
  await execFile('git', ['clone', remote, a]);
  await run(a, 'config', 'user.name', 'Test A'); await run(a, 'config', 'user.email', 'a@example.invalid');
  await mkdir(join(a, 'content'), { recursive: true }); await mkdir(join(a, 'zotero'), { recursive: true });
  await writeFile(join(a, 'content', '首页.md'), '# 初始\n');
  await writeFile(join(a, 'zotero', 'data.json'), '{"v":1}\n');
  await run(a, 'add', 'content', 'zotero'); await run(a, 'commit', '-m', 'initial'); await run(a, 'push', 'origin', 'main');
  await execFile('git', ['clone', remote, b]);
  await run(b, 'config', 'user.name', 'Test B'); await run(b, 'config', 'user.email', 'b@example.invalid');

  const config = { workspacePath: resolve(b), gitExecutable: 'git', gitRemote: 'origin', gitBranch: 'main' };
  const client = new ZoteroGitHubSync.LocalGit(config);
  await client.validate();

  await writeFile(join(a, 'content', '首页.md'), '# 来自 A\n');
  await run(a, 'add', 'content'); await run(a, 'commit', '-m', 'A update'); await run(a, 'push');
  const ff = await client.fetchAndFastForward();
  assert.equal(ff.status, 'fast-forwarded');
  assert.equal((await readFile(join(b, 'content', '首页.md'), 'utf8')).replace(/\r\n/g, '\n'), '# 来自 A\n');

  await writeFile(join(a, 'content', 'remote.md'), 'remote\n');
  await run(a, 'add', 'content'); await run(a, 'commit', '-m', 'remote moves'); await run(a, 'push');
  await writeFile(join(b, 'content', '本地.md'), 'must survive\n');
  const protectedResult = await client.fetchAndFastForward();
  assert.equal(protectedResult.status, 'remote-pending');
  assert.equal((await readFile(join(b, 'content', '本地.md'), 'utf8')).replace(/\r\n/g, '\n'), 'must survive\n');

  await writeFile(join(b, 'unrelated.txt'), 'user staged\n');
  await run(b, 'add', 'unrelated.txt');
  const refused = await client.commitAndPush(['content', 'zotero'], 'must not commit');
  assert.equal(refused.status, 'staged-pending');
  assert.deepEqual(await client.staged(), ['unrelated.txt']);

  // A clean third workspace can commit managed paths while leaving unrelated
  // untracked work untouched.
  await execFile('git', ['clone', remote, c]);
  await run(c, 'config', 'user.name', 'Test C'); await run(c, 'config', 'user.email', 'c@example.invalid');
  await writeFile(join(c, 'content', 'C.md'), 'C change\n');
  await writeFile(join(c, 'private.tmp'), 'do not commit\n');
  const cClient = new ZoteroGitHubSync.LocalGit({ ...config, workspacePath: resolve(c) });
  const pushed = await cClient.commitAndPush(['content', 'zotero'], 'managed only');
  assert.equal(pushed.status, 'pushed');
  const tree = (await run(c, 'ls-tree', '-r', '--name-only', 'HEAD')).stdout;
  assert.match(tree, /content\/C\.md/);
  assert.doesNotMatch(tree, /private\.tmp/);

  console.log('git integration tests passed');
}
finally {
  // Only the unique directory created by mkdtemp is removed.
  await rm(root, { recursive: true, force: true });
}
