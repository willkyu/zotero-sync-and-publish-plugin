/* GitHub API transport for the unified Local Workspace.
 *
 * This is deliberately a transport, not the old Zotero-only sync engine. It
 * scans every configured managed path, compares local files, the GitHub tree,
 * and a machine-local base, then transfers only unambiguous changes. The
 * branch ref is updated without force, so another computer can never be
 * overwritten by a stale run.
 */

ZoteroGitHubSync.WorkspaceAPITransport = class WorkspaceAPITransport {
	static VERSION = 1;
	static GIT_BLOB_LIMIT = 95 * 1024 * 1024;

	constructor(config, token) {
		this.config = config;
		this.token = token;
		this.client = new ZoteroGitHubSync.GitHub({
			token,
			apiURL: config.apiURL,
			owner: config.owner,
			repo: config.repo,
		});
		this.head = null;
		this.treeSha = null;
		this.remoteEntries = new Map();
		this.remote = new Map();
		this.base = null;
		this.sessionBase = null;
		this.conflicts = new Set();
	}

	static plan({ local, remote, base }) {
		let result = {
			upload: [],
			deleteRemote: [],
			download: [],
			deleteLocal: [],
			conflicts: [],
			unchanged: [],
		};
		let paths = new Set([...local.keys(), ...remote.keys(), ...(base ? base.keys() : [])]);
		for (let path of paths) {
			let l = local.get(path);
			let r = remote.get(path);
			let b = base ? base.get(path) : undefined;
			if (l === r) {
				result.unchanged.push(path);
			}
			else if (b === undefined) {
				if (l === undefined) result.download.push(path);
				else if (r === undefined) result.upload.push(path);
				else result.conflicts.push(path);
			}
			else if (l === b) {
				if (r === undefined) result.deleteLocal.push(path);
				else result.download.push(path);
			}
			else if (r === b) {
				if (l === undefined) result.deleteRemote.push(path);
				else result.upload.push(path);
			}
			else {
				result.conflicts.push(path);
			}
		}
		for (let list of Object.values(result)) list.sort();
		return result;
	}

	static nextBase({ local, remote, base, undecided = new Set() }) {
		let next = new Map();
		let paths = new Set([...local.keys(), ...remote.keys(), ...(base ? base.keys() : [])]);
		for (let path of paths) {
			if (undecided.has(path)) {
				if (base?.has(path)) next.set(path, base.get(path));
				continue;
			}
			let l = local.get(path);
			let r = remote.get(path);
			if (l !== undefined && l === r) next.set(path, l);
		}
		return next;
	}

	isManaged(path) {
		return this.config.managedPaths.some(root => path === root || path.startsWith(`${root}/`));
	}

	statePath() {
		let key = [
			this.config.workspacePath,
			this.config.apiURL,
			this.config.owner,
			this.config.repo,
			this.config.branch,
		].join('\n').toLowerCase();
		let hash = 0x811c9dc5;
		for (let i = 0; i < key.length; i++) {
			hash ^= key.charCodeAt(i);
			hash = Math.imul(hash, 0x01000193) >>> 0;
		}
		return PathUtils.join(
			Zotero.Profile.dir,
			'zotero-quartz-workspace',
			`api-${hash.toString(16).padStart(8, '0')}.json`
		);
	}

	async loadState() {
		try {
			let path = this.statePath();
			if (!await IOUtils.exists(path)) return null;
			let value = await IOUtils.readJSON(path);
			if (value?.version !== WorkspaceAPITransport.VERSION || !value.files) return null;
			return { commit: value.commit || null, files: new Map(Object.entries(value.files)) };
		}
		catch (e) {
			ZoteroGitHubSync.logError(e);
			return null;
		}
	}

	async saveState(files, commit) {
		let path = this.statePath();
		let ordered = {};
		for (let key of [...files.keys()].sort()) ordered[key] = files.get(key);
		await IOUtils.makeDirectory(PathUtils.parent(path), { ignoreExisting: true });
		await IOUtils.writeJSON(path, {
			version: WorkspaceAPITransport.VERSION,
			commit: commit || null,
			files: ordered,
		}, { tmpPath: `${path}.tmp` });
	}

	async connect() {
		let repo = await ZoteroGitHubSync.Sync._ensureRepo(this.client, this.config);
		if (repo?.permissions && repo.permissions.push === false) {
			throw new Error(`The token cannot write to ${this.config.owner}/${this.config.repo}. Grant Contents: Read and write.`);
		}
		this.head = await ZoteroGitHubSync.Sync._resolveHead(this.client, this.config);
		if (!this.head) return;
		let commit = await this.client.getCommit(this.head);
		this.treeSha = commit.tree.sha;
		let tree = await this.client.listTree(this.treeSha);
		this.remoteEntries = new Map([...tree].filter(([path]) => this.isManaged(path)));
		this.remote = new Map([...this.remoteEntries].map(([path, entry]) => [path, entry.sha]));
	}

	async prepare() {
		await this.connect();
		let state = await this.loadState();
		this.base = state?.files || null;
		this.sessionBase = new Map(this.base || []);
		let localScan = await ZoteroGitHubSync.Workspace.scanManaged(this.config);
		let plan = WorkspaceAPITransport.plan({ local: localScan.hashes, remote: this.remote, base: this.base });
		this.conflicts = new Set(plan.conflicts);

		let cancel = ZoteroGitHubSync.Sync._cancel;
		let done = 0;
		for (let path of plan.download) {
			cancel?.throwIfCancelled();
			let target = ZoteroGitHubSync.Workspace.resolve(this.config, path);
			let entry = this.remoteEntries.get(path);
			if (entry.size <= 512) {
				let bytes = await this.client.getBlobBytes(entry.sha);
				if (ZoteroGitHubSync.Utils.parseLFSPointer(ZoteroGitHubSync.Utils.textDecoder.decode(bytes))) {
					throw new Error(`GitHub API transport found a Git LFS pointer at ${path}. Use System Git transport for this repository.`);
				}
				await ZoteroGitHubSync.Workspace.writeBytesIfChanged(target, bytes);
			}
			else {
				await this.client.downloadBlob(entry.sha, target);
			}
			let { hash } = await ZoteroGitHubSync.Files.hashFile(target, 'git');
			if (hash !== this.remote.get(path)) {
				throw new Error(`Downloaded ${path} failed its Git blob verification.`);
			}
			this.sessionBase.set(path, hash);
			done++;
			ZoteroGitHubSync.Sync._updateProgress({
				phase: 'downloading', done, total: plan.download.length + plan.deleteLocal.length,
				message: `Downloading workspace files (${done}/${plan.download.length + plan.deleteLocal.length})…`,
			});
		}
		for (let path of plan.deleteLocal) {
			cancel?.throwIfCancelled();
			await IOUtils.remove(ZoteroGitHubSync.Workspace.resolve(this.config, path), { ignoreAbsent: true });
			this.sessionBase.delete(path);
			done++;
		}
		return {
			status: this.conflicts.size ? 'pending' : 'ready',
			downloaded: plan.download.length,
			deletedLocal: plan.deleteLocal.length,
			pending: this.conflicts.size,
			warnings: this.conflicts.size
				? [`Workspace conflicts preserved locally: ${[...this.conflicts].slice(0, 8).join(', ')}${this.conflicts.size > 8 ? '…' : ''}`]
				: [],
		};
	}

	async finish(trigger) {
		let scan = await ZoteroGitHubSync.Workspace.scanManaged(this.config);
		let plan = WorkspaceAPITransport.plan({ local: scan.hashes, remote: this.remote, base: this.sessionBase });
		for (let path of plan.conflicts) this.conflicts.add(path);
		for (let path of [...plan.download, ...plan.deleteLocal]) this.conflicts.add(path);
		let uploads = plan.upload.filter(path => !this.conflicts.has(path));
		let deletions = plan.deleteRemote.filter(path => !this.conflicts.has(path));
		let warnings = [];

		let oversized = uploads.filter(path => scan.files.get(path).size > WorkspaceAPITransport.GIT_BLOB_LIMIT);
		if (oversized.length) {
			for (let path of oversized) this.conflicts.add(path);
			uploads = uploads.filter(path => !this.conflicts.has(path));
			warnings.push(`GitHub API transport skipped files over 95 MB: ${oversized.slice(0, 8).join(', ')}`);
		}

		if (!this.config.autoCommit) {
			if (uploads.length || deletions.length) warnings.push('Workspace changes are ready but automatic API commits are disabled.');
			let base = WorkspaceAPITransport.nextBase({
				local: scan.hashes, remote: this.remote, base: this.sessionBase, undecided: this.conflicts,
			});
			await this.saveState(base, this.head);
			return {
				status: uploads.length || deletions.length ? 'local-complete' : 'up-to-date',
				commit: this.head,
				uploaded: 0,
				deletedRemote: 0,
				pending: this.conflicts.size,
				warnings,
			};
		}

		if (!uploads.length && !deletions.length) {
			let base = WorkspaceAPITransport.nextBase({
				local: scan.hashes, remote: this.remote, base: this.sessionBase, undecided: this.conflicts,
			});
			await this.saveState(base, this.head);
			return { status: 'up-to-date', commit: this.head, uploaded: 0, deletedRemote: 0, pending: this.conflicts.size, warnings };
		}

		let cancel = ZoteroGitHubSync.Sync._cancel;
		let entries = [];
		let done = 0;
		for (let path of uploads) {
			cancel?.throwIfCancelled();
			let file = scan.files.get(path);
			let bytes = await IOUtils.read(file.absolute);
			let sha = await this.client.createBlob(ZoteroGitHubSync.Utils.toBase64(bytes));
			if (sha !== scan.hashes.get(path)) throw new Error(`Upload of ${path} failed its Git blob verification.`);
			entries.push({ path, mode: this.remoteEntries.get(path)?.mode || '100644', type: 'blob', sha });
			done++;
			ZoteroGitHubSync.Sync._updateProgress({
				phase: 'uploading', done, total: uploads.length,
				message: `Uploading workspace files (${done}/${uploads.length})…`,
			});
		}
		for (let path of deletions) entries.push({ path, mode: '100644', type: 'blob', sha: null });

		let currentHead = await this.client.getBranchHead(this.config.branch);
		if (currentHead !== this.head) {
			warnings.push('The GitHub branch changed during sync; local files were preserved. Run sync again to reconcile it.');
			return { status: 'push-pending', commit: this.head, uploaded: 0, deletedRemote: 0, pending: this.conflicts.size + 1, warnings };
		}

		let tree = this.treeSha;
		for (let chunk of ZoteroGitHubSync.Sync._chunkEntries(entries)) {
			tree = await this.client.createTree(chunk, tree);
		}
		let message = (this.config.commitMessage || 'Research workspace sync: {changes} ({date})')
			.replace(/\{changes\}/g, `${uploads.length} uploaded, ${deletions.length} deleted`)
			.replace(/\{added\}/g, String(uploads.length))
			.replace(/\{updated\}/g, '0')
			.replace(/\{deleted\}/g, String(deletions.length))
			.replace(/\{trigger\}/g, trigger)
			.replace(/\{date\}/g, ZoteroGitHubSync.Utils.isoDate());
		let commit = await this.client.createCommit({
			message,
			tree,
			parents: this.head ? [this.head] : [],
			author: { name: this.config.authorName, email: this.config.authorEmail },
		});
		try {
			if (this.head) await this.client.updateRef(this.config.branch, commit, false);
			else await this.client.createRef(this.config.branch, commit);
		}
		catch (e) {
			if (e instanceof ZoteroGitHubSync.GitHubError && (e.status === 409 || e.status === 422)) {
				warnings.push('The GitHub branch changed before the commit could be published; local files were preserved. Run sync again.');
				return { status: 'push-pending', commit: this.head, uploaded: 0, deletedRemote: 0, pending: this.conflicts.size + 1, warnings };
			}
			throw e;
		}

		for (let path of uploads) this.remote.set(path, scan.hashes.get(path));
		for (let path of deletions) this.remote.delete(path);
		let base = WorkspaceAPITransport.nextBase({
			local: scan.hashes, remote: this.remote, base: this.sessionBase, undecided: this.conflicts,
		});
		await this.saveState(base, commit);
		this.head = commit;
		return {
			status: 'pushed', commit, uploaded: uploads.length, deletedRemote: deletions.length,
			pending: this.conflicts.size, warnings,
		};
	}
};
