// Pure-logic tests: no Zotero, no network. Run with `npm test`.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHash, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const SRC = fileURLToPath(new URL('../src', import.meta.url));
globalThis.ZoteroGitHubSync = { log(){}, warn(){}, logError: console.error, version: '0.2.0', getString: k => k };
for (const f of ['utils.js', 'exporter.js', 'importer.js', 'planner.js', 'git.js', 'workspace-api.js', 'better-notes.js', 'workspace.js', 'sync.js']) vm.runInThisContext(readFileSync(`${SRC}/${f}`, 'utf8'));
const U = ZoteroGitHubSync.Utils, E = ZoteroGitHubSync.Exporter, I = ZoteroGitHubSync.Importer;
const G = ZoteroGitHubSync.LocalGit, API = ZoteroGitHubSync.WorkspaceAPITransport, BN = ZoteroGitHubSync.BetterNotes, W = ZoteroGitHubSync.Workspace;

// base64 across block boundaries
for (const n of [0, 1, 2, 3, 3*1024*1024 - 1, 3*1024*1024, 3*1024*1024 + 1, 7*1024*1024 + 2]) {
  const b = new Uint8Array(randomBytes(n));
  assert.equal(U.toBase64(b), Buffer.from(b).toString('base64'), `b64 ${n}`);
}
// git blob sha for text
const txt = U.encode('hello zotero\n');
assert.equal(await U.gitBlobSha(txt), createHash('sha1').update('blob 13\0hello zotero\n').digest('hex'));
// LFS pointer
const oid = 'a'.repeat(64);
const ptr = U.lfsPointer(oid, 123456789);
assert.deepEqual(U.parseLFSPointer(ptr), { oid, size: 123456789 });
assert.equal(U.parseLFSPointer('%PDF-1.7 ...'), null);
assert.equal(ptr, `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 123456789\n`);
// shards
assert.equal(U.shard('ABCD1234'), 'AB');
assert.equal(U.letterShard('attention (X).md'), 'A');
assert.equal(U.letterShard('Élan (X).md'), 'E');
assert.equal(U.letterShard('2024 report'), '0-9');
assert.equal(U.letterShard('深度学习'), 'other');
// stableStringify with cross-realm objects
const foreign = vm.runInNewContext('({ b: 1, a: { d: [ { z: 1, y: 2 } ], c: 3 } })');
assert.equal(E.stableStringify(foreign), JSON.stringify({ a: { c: 3, d: [ { y: 2, z: 1 } ] }, b: 1 }, null, '\t'));
// groupByLibrary
const tree = new Map([
  ['zotero/my-library/items/AB/ABCD1234.json', { sha: 's1' }],
  ['zotero/my-library/items/ZZZZ9999.json', { sha: 's2' }],
  ['zotero/my-library/collections.json', { sha: 'c' }],
  ['zotero/my-library/searches.json', { sha: 'q' }],
  ['zotero/my-library/settings.json', { sha: 'st' }],
  ['zotero/my-library/attachments/PD/PDFK0001/paper name.pdf', { sha: 'f1', size: 10 }],
  ['zotero/my-library/attachments/SN/SNAP0001/sub/dir/img.png', { sha: 'f2', size: 5 }],
  ['zotero/my-library/attachments-lfs/BI/BIGF0001/book.pdf', { sha: 'p1', size: 130 }],
  ['zotero/my-library/attachments-lfs/.gitattributes', { sha: 'ga', size: 50 }],
  ['zotero/my-library/notes/A/Attention (ABCD1234).md', { sha: 'n' }],
  ['other/file.txt', { sha: 'x' }],
]);
const libs = I.groupByLibrary(tree, { basePath: 'zotero' });
const g = libs.get('my-library');
assert.deepEqual(g.items.map(i => i.key).sort(), ['ABCD1234', 'ZZZZ9999']);
assert.equal(g.searches.sha, 'q'); assert.equal(g.settings.sha, 's' + 't');
assert.deepEqual(g.files.get('SNAP0001'), [{ path: 'my-library/attachments/SN/SNAP0001/sub/dir/img.png', name: 'sub/dir/img.png', sha: 'f2', size: 5, lfs: false }]);
assert.equal(g.files.get('BIGF0001')[0].lfs, true);
assert.equal(g.files.size, 3);
// flattenRecords ordering
const flat = I.flattenRecords([
  { key: 'TOP00001', data: { zotero: { key: 'TOP00001', itemType: 'book' }, children: [
    { key: 'ANN00001', itemType: 'annotation', parentItem: 'ATT00001' },
    { key: 'IMG00001', itemType: 'attachment', parentItem: 'NOTE0001' },
    { key: 'ATT00001', itemType: 'attachment', parentItem: 'TOP00001' },
    { key: 'NOTE0001', itemType: 'note', parentItem: 'TOP00001' },
  ] } },
  { key: 'OLD00001', data: { zotero: { key: 'OLD00001', itemType: 'note', parentItem: 'TOP00001' } } },
]);
const pos = k => flat.findIndex(j => j.key === k);
assert.ok(pos('TOP00001') < pos('ATT00001') && pos('ATT00001') < pos('ANN00001'));
assert.ok(pos('NOTE0001') < pos('IMG00001') && pos('TOP00001') < pos('OLD00001'));
assert.equal(flat.length, 6);
// tree batching: count and byte limits, size stripped from entries
const S = ZoteroGitHubSync.Sync;
const entries = Array.from({ length: 650 }, (_, i) => ({ path: `f${i}`, mode: '100644', type: 'blob', content: 'x', size: 1 }));
entries.splice(10, 0, { path: 'big', mode: '100644', type: 'blob', content: 'y', size: S.TREE_MAX_BYTES });
const chunks = S._chunkEntries(entries);
assert.equal(chunks.flat().length, 651);
assert.ok(chunks.every(c => c.length <= S.TREE_MAX_ENTRIES));
assert.ok(chunks.flat().every(e => !('size' in e)));
assert.ok(chunks.some(c => c.length === 1 && c[0].path === 'big') || chunks[0].length === 10);
// progress formatting
assert.equal(S.percent({ bytesDone: 50, bytesTotal: 200, done: 1, total: 2 }), 25);
assert.equal(S.percent({ done: 1, total: 4 }), 25);
assert.equal(S.percent(null), null);
// cancel token interrupts a sleep
const token = new ZoteroGitHubSync.CancelToken();
const t0 = Date.now();
const sleeping = token.sleep(5000);
setTimeout(() => token.cancel(), 20);
await assert.rejects(sleeping, e => e.name === 'CancelledError');
assert.ok(Date.now() - t0 < 1000);
// rate limiter waits once the window is full
const limiter = new ZoteroGitHubSync.RateLimiter([{ ms: 200, max: 3 }]);
let waited = null;
const t1 = Date.now();
for (let i = 0; i < 4; i++) await limiter.acquire({ onWait: until => { waited = until; } });
assert.ok(waited && Date.now() - t1 >= 150, 'fourth request waited for the window');
// fromJSON() ordering: link mode and annotation type before dependent fields
const orderedAttachment = Object.keys(I.orderForFromJSON({ contentType: 'application/pdf', filename: 'a.pdf', itemType: 'attachment', linkMode: 'imported_file', parentItem: 'ABCD1234', title: 'PDF' }));
assert.ok(orderedAttachment.indexOf('linkMode') < orderedAttachment.indexOf('filename'));
assert.equal(orderedAttachment[0], 'itemType');
const orderedAnnotation = Object.keys(I.orderForFromJSON({ annotationColor: '#ffd400', annotationComment: 'x', annotationType: 'highlight', itemType: 'annotation', parentItem: 'WXYZ5678' }));
assert.ok(orderedAnnotation.indexOf('annotationType') < orderedAnnotation.indexOf('annotationColor'));
assert.equal(orderedAnnotation.length, 5);
// -- Planner: three-way classification --------------------------------------
const P = ZoteroGitHubSync.Planner;
const M = obj => new Map(Object.entries(obj));
const ITEM = k => `my-library/items/${k.slice(0, 2)}/${k}.json`;
const FILE = (k, n) => `my-library/attachments/${k.slice(0, 2)}/${k}/${n}`;
const MD = t => `my-library/notes/${t[0]}/${t}.md`;
assert.equal(P.importable(ITEM('ABCD1234')).kind, 'item');
assert.equal(P.importable(FILE('WXYZ5678', 'a.pdf')).kind, 'file');
assert.equal(P.importable('my-library/attachments-lfs/.gitattributes'), null);
assert.equal(P.importable('my-library/collections.json').kind, 'library');
assert.equal(P.importable(MD('Title (ABCD1234)')), null);

{
	// With a base: every case
	const base = M({
		[ITEM('AAAAAAAA')]: 'a1', // unchanged
		[ITEM('BBBBBBBB')]: 'b1', // changed locally
		[ITEM('CCCCCCCC')]: 'c1', // changed on server
		[ITEM('DDDDDDDD')]: 'd1', // changed on both
		[ITEM('EEEEEEEE')]: 'e1', // deleted locally
		[ITEM('FFFFFFFF')]: 'f1', // deleted on server
		[MD('Edited (GGGGGGGG)')]: 'g1', // derived, edited on server
		[FILE('KKKKKKKK', 'x.pdf')]: 'k1', // kept: file not on this computer
	});
	const local = M({
		[ITEM('AAAAAAAA')]: 'a1', [ITEM('BBBBBBBB')]: 'b2', [ITEM('CCCCCCCC')]: 'c1',
		[ITEM('DDDDDDDD')]: 'd2', [ITEM('FFFFFFFF')]: 'f1', [MD('Edited (GGGGGGGG)')]: 'g1',
		[ITEM('NNNNNNNN')]: 'n1', // new locally
	});
	const remote = M({
		[ITEM('AAAAAAAA')]: 'a1', [ITEM('BBBBBBBB')]: 'b1', [ITEM('CCCCCCCC')]: 'c2',
		[ITEM('DDDDDDDD')]: 'd3', [ITEM('EEEEEEEE')]: 'e1', [MD('Edited (GGGGGGGG)')]: 'g2',
		[ITEM('RRRRRRRR')]: 'r1', // added on the server by another computer
		[FILE('KKKKKKKK', 'x.pdf')]: 'k1',
	});
	const plan = P.plan({ local, remote, base, kept: new Set([FILE('KKKKKKKK', 'x.pdf')]) });
	assert.deepEqual(plan.push, [ITEM('BBBBBBBB'), ITEM('NNNNNNNN')]);
	assert.deepEqual(plan.delete, [ITEM('EEEEEEEE')]);
	assert.deepEqual(plan.incoming, [ITEM('CCCCCCCC'), ITEM('RRRRRRRR')]);
	assert.deepEqual(plan.conflicts, [ITEM('DDDDDDDD')]);
	assert.deepEqual(plan.overwrite, [MD('Edited (GGGGGGGG)')]);
	assert.deepEqual(plan.restore, [ITEM('FFFFFFFF')]);
	assert.ok(plan.unchanged.includes(FILE('KKKKKKKK', 'x.pdf')));
	assert.ok(P.needsReview(plan));
	// prune off: a file whose item is gone here stays on the server
	const noPrune = P.plan({ local, remote, base, kept: new Set([FILE('KKKKKKKK', 'x.pdf')]), prune: false });
	assert.deepEqual(noPrune.delete, []);
	assert.ok(noPrune.unchanged.includes(ITEM('EEEEEEEE')));
	assert.deepEqual(noPrune.push, [ITEM('BBBBBBBB'), ITEM('NNNNNNNN')]);
	assert.deepEqual(noPrune.retained, [ITEM('EEEEEEEE')]);
	// ... and it is remembered, so the next sync neither re-imports it nor forgets it
	const kept1 = new Set([FILE('KKKKKKKK', 'x.pdf')]);
	const afterSync = new Map(remote);
	const base2 = P.nextBase({ local, remote: afterSync, base, undecided: new Set(), kept: kept1, retained: new Set(noPrune.retained) });
	assert.equal(base2.get(ITEM('EEEEEEEE')), 'e1');
	const later = P.plan({ local, remote, base: base2, kept: kept1, prune: true });
	assert.deepEqual(later.delete, [ITEM('EEEEEEEE')]);
	// without it the deleted item would come back as an import
	const forgotten = P.nextBase({ local, remote: afterSync, base, undecided: new Set(), kept: kept1 });
	assert.equal(forgotten.has(ITEM('EEEEEEEE')), false);

	// After a sync that skipped the undecided paths, they keep their old base
	const undecided = new Set([...plan.incoming, ...plan.conflicts, ...plan.overwrite, ...plan.restore]);
	const after = new Map(remote);
	after.set(ITEM('BBBBBBBB'), 'b2'); after.set(ITEM('NNNNNNNN'), 'n1'); after.delete(ITEM('EEEEEEEE'));
	const next = P.nextBase({ local, remote: after, base, undecided, kept: new Set([FILE('KKKKKKKK', 'x.pdf')]) });
	assert.equal(next.get(ITEM('BBBBBBBB')), 'b2');
	assert.equal(next.get(ITEM('CCCCCCCC')), 'c1', 'incoming stays pending');
	assert.equal(next.get(ITEM('DDDDDDDD')), 'd1', 'conflict stays pending');
	assert.equal(next.has(ITEM('EEEEEEEE')), false, 'deleted path leaves the base');
	assert.equal(next.has(ITEM('RRRRRRRR')), false, 'remote-only item is not recorded as synced');
	assert.equal(next.get(FILE('KKKKKKKK', 'x.pdf')), 'k1');
	// ...so a second sync asks the same questions and still deletes nothing new
	const again = P.plan({ local, remote: after, base: next, kept: new Set([FILE('KKKKKKKK', 'x.pdf')]) });
	assert.deepEqual(again.delete, []);
	assert.deepEqual(again.incoming, [ITEM('CCCCCCCC'), ITEM('RRRRRRRR')]);
	assert.deepEqual(again.conflicts, [ITEM('DDDDDDDD')]);
}

{
	// The multi-computer hazard: computer B is behind and has never synced.
	// It must not delete A's item, and must not silently overwrite what differs.
	const remote = M({ [ITEM('AAAAAAAA')]: 'a2', [ITEM('XXXXXXXX')]: 'x1', [MD('A (AAAAAAAA)')]: 'm1', [FILE('PPPPPPPP', 'p.pdf')]: 'p1' });
	const local = M({ [ITEM('AAAAAAAA')]: 'a1', [MD('A (AAAAAAAA)')]: 'm0', [FILE('PPPPPPPP', 'p.pdf')]: 'p0' });
	const plan = P.plan({ local, remote, base: null });
	assert.deepEqual(plan.delete, []);
	assert.deepEqual(plan.incoming, [ITEM('XXXXXXXX')]);
	assert.deepEqual(plan.diverged, [FILE('PPPPPPPP', 'p.pdf'), ITEM('AAAAAAAA')].sort());
	assert.deepEqual(plan.push, [MD('A (AAAAAAAA)')]);
}

{
	// Partial sync: only exported paths, never deletions
	const plan = P.plan({
		local: M({ [ITEM('AAAAAAAA')]: 'a2' }),
		remote: M({ [ITEM('AAAAAAAA')]: 'a1', [ITEM('BBBBBBBB')]: 'b1' }),
		base: M({ [ITEM('AAAAAAAA')]: 'a1', [ITEM('BBBBBBBB')]: 'b1' }),
		fullSync: false,
	});
	assert.deepEqual(plan.push, [ITEM('AAAAAAAA')]);
	assert.deepEqual(plan.delete, []);
	assert.ok(!P.needsReview(plan));
}

{
	// Deletions are limited to paths the plugin manages
	const plan = P.plan({
		local: M({}),
		remote: M({ [ITEM('AAAAAAAA')]: 'a1', 'my-library/notes/other.md': 'o1' }),
		base: M({ [ITEM('AAAAAAAA')]: 'a1', 'my-library/notes/other.md': 'o1' }),
		managed: new Set([ITEM('AAAAAAAA')]),
	});
	assert.deepEqual(plan.delete, [ITEM('AAAAAAAA')]);
}
// -- Importer: repository paths may not leave the attachment folder ----------
assert.deepEqual(I.safeSegments('paper.pdf'), ['paper.pdf']);
assert.deepEqual(I.safeSegments('snapshot/index.html'), ['snapshot', 'index.html']);
for (const bad of ['../evil.txt', 'a/../../evil.txt', './x', 'a//b', '', 'a/', 'a\\..\\b']) {
  assert.equal(I.safeSegments(bad), null, `escapes: ${bad}`);
}

// -- Local Workspace safety and compatibility rules ------------------------
assert.deepEqual(G.parsePorcelainZ(' M content/a.md\0R  zotero/old.json\0zotero/new.json\0'), [
  { status: ' M', path: 'content/a.md', original: null },
  { status: 'R ', path: 'zotero/old.json', original: 'zotero/new.json' },
]);
assert.ok(G.executableCandidates('WINNT', { ProgramFiles: 'D:\\Apps' }).includes('D:\\Apps\\Git\\cmd\\git.exe'));
assert.ok(G.executableCandidates('WINNT', { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' }).includes('C:\\Users\\test\\AppData\\Local\\Programs\\Git\\cmd\\git.exe'));
assert.ok(G.executableCandidates('Darwin').includes('/opt/homebrew/bin/git'));
{
  const base = M({
    'content/local.md': 'a', 'content/remote.md': 'b', 'content/both.md': 'c',
    'content/local-delete.md': 'd', 'content/remote-delete.md': 'e',
  });
  const local = M({
    'content/local.md': 'a2', 'content/remote.md': 'b', 'content/both.md': 'c2',
    'content/remote-delete.md': 'e', 'content/new-local.md': 'n',
  });
  const remote = M({
    'content/local.md': 'a', 'content/remote.md': 'b2', 'content/both.md': 'c3',
    'content/local-delete.md': 'd', 'content/new-remote.md': 'r',
  });
  const plan = API.plan({ local, remote, base });
  assert.deepEqual(plan.upload, ['content/local.md', 'content/new-local.md']);
  assert.deepEqual(plan.download, ['content/new-remote.md', 'content/remote.md']);
  assert.deepEqual(plan.deleteRemote, ['content/local-delete.md']);
  assert.deepEqual(plan.deleteLocal, ['content/remote-delete.md']);
  assert.deepEqual(plan.conflicts, ['content/both.md']);
  const next = API.nextBase({ local, remote, base, undecided: new Set(plan.conflicts) });
  assert.equal(next.get('content/both.md'), 'c', 'a workspace conflict keeps its old machine-local base');
  assert.equal(next.has('content/local.md'), false, 'one-sided changes are not recorded until transferred');
}
{
  const plan = API.plan({
    local: M({ 'content/same.md': 's', 'content/different.md': 'l', 'content/local.md': 'x' }),
    remote: M({ 'content/same.md': 's', 'content/different.md': 'r', 'content/remote.md': 'y' }),
    base: null,
  });
  assert.deepEqual(plan.upload, ['content/local.md']);
  assert.deepEqual(plan.download, ['content/remote.md']);
  assert.deepEqual(plan.conflicts, ['content/different.md']);
}
assert.deepEqual(BN.unsafeMarkdown('# Fine\n\n- [ ] lossy\n\n![[embed.png]]\n'), ['task lists', 'Obsidian embeds']);
assert.deepEqual(BN.unsafeMarkdown('```md\n- [ ] code\n![[x]]\n```\n> [!note]\n[[Page]]'), []);
assert.equal(BN.relativePosix('content/papers', 'content/assets/图 1.png'), '../assets/图 1.png');
{
  const events = [];
  let markdownMode = true;
  const editor = {
    _item: { id: 42 },
    _iframeWindow: { wrappedJSObject: { getDataSync: () => ({ html: '<p>saved</p>' }) } },
    _save: async data => events.push(['save', data.html]),
  };
  globalThis.Components = { utils: { isDeadWrapper: () => false } };
  globalThis.Zotero = {
    Notes: { _editorInstances: [editor] },
    BetterNotes: { api: { editor: {
      isMarkdownMode: () => markdownMode,
      toggleMarkdownMode: async () => { events.push(['toggle']); markdownMode = false; },
    } } },
  };
  assert.equal(await BN.flushNoteEditors(42), 1);
  assert.deepEqual(events, [['toggle'], ['save', '<p>saved</p>']]);
  assert.equal((await BN.flushNoteEditors(99)), 0, 'only the requested note editor is flushed');
}
{
  globalThis.Zotero = {
    CreatorTypes: { getName: () => 'author' },
    ItemFields: { getID: name => name === 'DOI' ? 1 : 0 },
    Collections: { get: id => ({ name: `Collection ${id}` }) },
    URI: { getItemURI: item => `zotero://item/${item.key}` },
  };
  const parent = {
    key: 'PARENT01', itemType: 'journalArticle',
    getDisplayTitle: () => 'A Paper',
    getCreators: () => [{ firstName: 'Ada', lastName: 'Lovelace', creatorTypeID: 1 }],
    getTags: () => [{ tag: 'methods' }], getCollections: () => [7],
    getField: name => ({ date: '2025-06', DOI: '10.1/example', extra: 'Citation Key: lovelace2025' })[name] || '',
  };
  const rendered = BN.renderTemplate('# {{title}}\n{{authors}} | {{year}} | {{DOI}} | {{citationKey}} | {{noteKey}}', parent, { key: 'NOTE0001' });
  assert.equal(rendered, '# A Paper\nAda Lovelace | 2025 | 10.1/example | lovelace2025 | NOTE0001');
  assert.equal(BN.formatTemplateDate('YYYY-MM-DD', new Date(2026, 10, 4, 15, 7, 9)), '2026-11-04');
  assert.equal(BN.renderTemplate('{{date:YYYY-MM-DD}}', parent, { key: 'NOTE0001' }).length, 10);
  assert.throws(() => BN.renderTemplate('{{missing}}', parent, { key: 'NOTE0001' }), /Unknown reading-note template variable/);
  assert.throws(() => BN.renderTemplate('{{date:MMMM D}}', parent, { key: 'NOTE0001' }), /Unsupported reading-note date format/);
  assert.equal(BN.noteIsEmpty({ getNote: () => '<div data-schema-version="9"><p><br></p></div>' }), true);
  assert.equal(BN.noteIsEmpty({ getNote: () => '<div><p>Text</p></div>' }), false);
  const combined = BN.withMarkdownBody('---\ntags: []\n$itemKey: NOTE0001\n---\nold body\n', '\n\n# Template\n\n- [ ] task\n');
  assert.equal(combined, '---\ntags: []\n$itemKey: NOTE0001\n---\n\n# Template\n\n- [ ] task\n');
}
const bindings = W.validateBindings({ bindings: [
  { library: { type: 'user' }, parentKey: 'PARENT01', noteKey: 'NOTE0001', path: 'content/papers/a.md' },
  { library: { type: 'user' }, parentKey: 'PARENT02', noteKey: 'NOTE0001', path: 'content/papers/duplicate.md' },
  { library: { type: 'user' }, parentKey: 'PARENT03', noteKey: 'NOTE0003', path: '../outside.md' },
] });
assert.equal(bindings.length, 1, 'duplicate note identities and escaping paths are rejected');
assert.equal(W.isMirrorPath('my-library/items/AB/ABCD1234.json'), true);
assert.equal(W.isMirrorPath('my-library/notes/A/user.md'), false, 'generated Markdown is not a local mirror input');
assert.equal(W.isMirrorPath('my-library/attachments/AB/ABCDEFGH/image.png'), true);
{
  const local = new Map([['my-library/items/AB/ABCD1234.json', 'item']]);
  const remote = new Map([
    ['my-library/items/AB/ABCD1234.json', 'item'],
    ['my-library/attachments/PD/PDF00001/paper.pdf', 'pdf'],
  ]);
  const kept = W.applyKeepPrefixes(local, remote, ['my-library/attachments/PD/PDF00001/']);
  assert.deepEqual(kept, ['my-library/attachments/PD/PDF00001/paper.pdf']);
  assert.equal(local.get(kept[0]), 'pdf', 'disabled/missing attachments retain their repository baseline');
}

console.log('all pure-logic tests passed');
