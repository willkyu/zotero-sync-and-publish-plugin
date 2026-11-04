// Workspace GitHub API transport integration test with an in-memory remote.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, basename } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const gitHash = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const root = await mkdtemp(join(tmpdir(), 'zqws-api-'));
const workspace = join(root, 'workspace');
const profile = join(root, 'profile');
await mkdir(join(workspace, 'content'), { recursive: true });
await mkdir(profile, { recursive: true });

globalThis.PathUtils = { join, parent: dirname, filename: basename, isAbsolute: path => /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/') };
globalThis.IOUtils = {
  exists: path => stat(path).then(() => true, () => false),
  read: path => readFile(path),
  write: async (path, bytes) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes); },
  readJSON: async path => JSON.parse(await readFile(path, 'utf8')),
  writeJSON: async (path, value) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value)); },
  makeDirectory: path => mkdir(path, { recursive: true }),
  remove: path => rm(path, { force: true }),
};
globalThis.Zotero = { Profile: { dir: profile } };

const repo = {
  head: 'commit-1',
  remote: new Map([
    ['README.md', Buffer.from('outside managed paths\n')],
    ['content/remote.md', Buffer.from('remote one\n')],
  ]),
  blobs: new Map(),
  pending: null,
  commits: 1,
};
const indexBlobs = () => {
  repo.blobs.clear();
  for (const bytes of repo.remote.values()) repo.blobs.set(gitHash(bytes), bytes);
};
indexBlobs();

class FakeGitHub {
  async getBranchHead() { return repo.head; }
  async getCommit() { return { tree: { sha: 'tree' } }; }
  async listTree() {
    indexBlobs();
    return new Map([...repo.remote].map(([path, bytes]) => [path, { sha: gitHash(bytes), mode: '100644', size: bytes.length }]));
  }
  async downloadBlob(sha, target) {
    const bytes = repo.blobs.get(sha);
    assert.ok(bytes, `remote blob ${sha} exists`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  async getBlobBytes(sha) { return repo.blobs.get(sha); }
  async createBlob(base64) {
    const bytes = Buffer.from(base64, 'base64');
    const sha = gitHash(bytes);
    repo.blobs.set(sha, bytes);
    return sha;
  }
  async createTree(entries) {
    if (!repo.pending) repo.pending = new Map(repo.remote);
    for (const entry of entries) {
      if (entry.sha === null) repo.pending.delete(entry.path);
      else repo.pending.set(entry.path, repo.blobs.get(entry.sha));
    }
    return 'pending-tree';
  }
  async createCommit() { return `commit-${++repo.commits}`; }
  async updateRef(_branch, commit) {
    repo.remote = repo.pending;
    repo.pending = null;
    repo.head = commit;
    indexBlobs();
  }
  async createRef(branch, commit) { return this.updateRef(branch, commit); }
}

globalThis.ZoteroGitHubSync = {
  GitHub: FakeGitHub,
  Utils: {
    toBase64: bytes => Buffer.from(bytes).toString('base64'),
    isoDate: () => '2026-11-04',
    parseLFSPointer: () => null,
    textDecoder: new TextDecoder(),
  },
  Files: {
    async cachedHash(source) { return gitHash(await readFile(source.path)); },
    async hashFile(path) { const bytes = await readFile(path); return { hash: gitHash(bytes), size: bytes.length }; },
  },
  Workspace: {
    resolve(config, relative) { return join(config.workspacePath, ...relative.split('/')); },
    async writeBytesIfChanged(path, bytes) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes); },
    async scanManaged(config) {
      const files = new Map(), hashes = new Map();
      const walk = async (absolute, relative) => {
        let children;
        try { children = await readdir(absolute, { withFileTypes: true }); }
        catch { return; }
        for (const child of children) {
          const childAbsolute = join(absolute, child.name);
          const childRelative = `${relative}/${child.name}`.replace(/\\/g, '/');
          if (child.isDirectory()) await walk(childAbsolute, childRelative);
          else {
            const info = await stat(childAbsolute);
            files.set(childRelative, { absolute: childAbsolute, size: info.size, mtime: info.mtimeMs });
            hashes.set(childRelative, gitHash(await readFile(childAbsolute)));
          }
        }
      };
      for (const managed of config.managedPaths) await walk(join(config.workspacePath, managed), managed);
      return { files, hashes };
    },
  },
  Sync: {
    _cancel: null,
    _updateProgress() {},
    async _ensureRepo() { return { permissions: { push: true } }; },
    async _resolveHead(client, config) { return client.getBranchHead(config.branch); },
    _chunkEntries(entries) { return [entries]; },
  },
  logError: console.error,
};

const source = fileURLToPath(new URL('../src/workspace-api.js', import.meta.url));
vm.runInThisContext(readFileSync(source, 'utf8'));
const config = {
  workspacePath: workspace,
  managedPaths: ['content'],
  apiURL: 'https://api.github.test', owner: 'owner', repo: 'repo', branch: 'main',
  autoCommit: true,
  commitMessage: 'Workspace: {changes}', authorName: '', authorEmail: '',
};

try {
  await writeFile(join(workspace, 'content', 'local.md'), 'local one\n');
  let transport = new ZoteroGitHubSync.WorkspaceAPITransport(config, 'token');
  let prepared = await transport.prepare();
  assert.equal(prepared.downloaded, 1);
  assert.equal(await readFile(join(workspace, 'content', 'remote.md'), 'utf8'), 'remote one\n');
  let result = await transport.finish('test');
  assert.equal(result.status, 'pushed');
  assert.equal(repo.remote.get('content/local.md').toString(), 'local one\n');
  assert.equal(repo.remote.get('README.md').toString(), 'outside managed paths\n');

  await writeFile(join(workspace, 'content', 'local.md'), 'local two\n');
  repo.remote.set('content/remote.md', Buffer.from('remote two\n'));
  repo.head = 'external-2';
  indexBlobs();
  transport = new ZoteroGitHubSync.WorkspaceAPITransport(config, 'token');
  prepared = await transport.prepare();
  assert.equal(prepared.downloaded, 1);
  assert.equal(await readFile(join(workspace, 'content', 'remote.md'), 'utf8'), 'remote two\n');
  result = await transport.finish('test');
  assert.equal(result.status, 'pushed');
  assert.equal(repo.remote.get('content/local.md').toString(), 'local two\n');

  await writeFile(join(workspace, 'content', 'delete-local.md'), 'delete me locally\n');
  transport = new ZoteroGitHubSync.WorkspaceAPITransport(config, 'token');
  await transport.prepare();
  await transport.finish('test');
  await rm(join(workspace, 'content', 'delete-local.md'));
  transport = new ZoteroGitHubSync.WorkspaceAPITransport(config, 'token');
  await transport.prepare();
  result = await transport.finish('test');
  assert.equal(result.deletedRemote, 1);
  assert.equal(repo.remote.has('content/delete-local.md'), false);

  repo.remote.delete('content/local.md');
  repo.head = 'external-delete';
  indexBlobs();
  transport = new ZoteroGitHubSync.WorkspaceAPITransport(config, 'token');
  prepared = await transport.prepare();
  assert.equal(prepared.deletedLocal, 1);
  assert.equal(await IOUtils.exists(join(workspace, 'content', 'local.md')), false);
  await transport.finish('test');

  await writeFile(join(workspace, 'content', 'remote.md'), 'local conflict\n');
  repo.remote.set('content/remote.md', Buffer.from('remote conflict\n'));
  repo.head = 'external-3';
  indexBlobs();
  transport = new ZoteroGitHubSync.WorkspaceAPITransport(config, 'token');
  prepared = await transport.prepare();
  assert.equal(prepared.pending, 1);
  assert.equal(await readFile(join(workspace, 'content', 'remote.md'), 'utf8'), 'local conflict\n');
  result = await transport.finish('test');
  assert.equal(result.pending, 1);
  assert.equal(repo.remote.get('content/remote.md').toString(), 'remote conflict\n');
  console.log('workspace API integration tests passed');
}
finally {
  await rm(root, { recursive: true, force: true });
}
