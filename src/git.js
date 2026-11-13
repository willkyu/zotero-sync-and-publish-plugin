/* Local Workspace -- safe system Git integration.
 *
 * Commands are passed as argument arrays.  No shell is involved, so paths with
 * spaces/CJK characters and user-controlled commit messages are not evaluated.
 * The real index is only touched after we have proved that it has no staged
 * entries; this prevents a plugin commit from accidentally including the
 * user's pre-existing staging area.
 */

ZoteroGitHubSync.LocalGit = class LocalGit {
	constructor(config) {
		this.root = config.workspacePath;
		this.executable = config.gitExecutable || 'git';
		this.remote = config.gitRemote || 'origin';
		this.branch = config.gitBranch || 'main';
		this._resolvedExecutable = '';
	}

	/**
	 * GUI applications do not always inherit the same PATH as a terminal. In
	 * particular, Zotero may have been started before Git was installed, and
	 * macOS applications launched from Finder do not read shell startup files.
	 */
	static executableCandidates(os, env = {}) {
		let candidates = [];
		let add = value => {
			value = String(value || '').trim().replace(/[\\/]+$/, '');
			if (value && !candidates.includes(value)) candidates.push(value);
		};
		let under = (base, suffix) => {
			base = String(base || '').trim().replace(/[\\/]+$/, '');
			if (base) add(`${base}${os === 'WINNT' ? '\\' : '/'}${suffix}`);
		};

		if (os === 'WINNT') {
			for (let base of [env.ProgramFiles, env['ProgramFiles(x86)'], 'C:\\Program Files', 'C:\\Program Files (x86)']) {
				under(base, 'Git\\cmd\\git.exe');
				under(base, 'Git\\bin\\git.exe');
			}
			under(env.LOCALAPPDATA, 'Programs\\Git\\cmd\\git.exe');
			under(env.USERPROFILE, 'scoop\\apps\\git\\current\\cmd\\git.exe');
			under(env.ProgramData, 'chocolatey\\bin\\git.exe');
		}
		else {
			// Apple Silicon Homebrew, Intel Homebrew/MacPorts, then system paths.
			for (let path of ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/opt/local/bin/git', '/usr/bin/git']) add(path);
		}
		return candidates;
	}

	async resolveExecutable(Subprocess) {
		if (this._resolvedExecutable) return this._resolvedExecutable;
		let configured = String(this.executable || 'git').trim() || 'git';
		if (PathUtils.isAbsolute(configured)) {
			if (!await IOUtils.exists(configured)) {
				throw new Error(`Configured Git executable does not exist: ${configured}`);
			}
			return (this._resolvedExecutable = configured);
		}

		try {
			let found = await Subprocess.pathSearch(configured);
			if (found) return (this._resolvedExecutable = found);
		}
		catch (_) {}

		// A non-default command is an explicit override, so do not silently run a
		// different program when it cannot be found.
		if (!/^git(?:\.exe)?$/i.test(configured)) {
			throw new Error(`Git executable not found: ${configured}. Enter its absolute path in the plugin settings.`);
		}
		let env = {};
		for (let name of ['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA', 'USERPROFILE', 'ProgramData']) {
			try { env[name] = Services.env.get(name); }
			catch (_) { env[name] = ''; }
		}
		let os = '';
		try { os = Services.appinfo.OS; }
		catch (_) {}
		for (let candidate of LocalGit.executableCandidates(os, env)) {
			if (await IOUtils.exists(candidate)) {
				ZoteroGitHubSync.log(`Using Git executable ${candidate}`);
				return (this._resolvedExecutable = candidate);
			}
		}
		throw new Error('Git executable not found. Install Git, restart Zotero, or enter the absolute git.exe path in the plugin settings.');
	}

	static parsePorcelainZ(text) {
		let records = [];
		let fields = String(text || '').split('\0');
		for (let i = 0; i < fields.length; i++) {
			let field = fields[i];
			if (!field) continue;
			let status = field.slice(0, 2);
			let path = field.slice(3);
			let original = null;
			if ((status.includes('R') || status.includes('C')) && fields[i + 1]) {
				original = fields[++i];
			}
			records.push({ status, path: path.replace(/\\/g, '/'), original });
		}
		return records;
	}

	async run(args, { allowFailure = false } = {}) {
		let { Subprocess } = ChromeUtils.importESModule('resource://gre/modules/Subprocess.sys.mjs');
		let command = await this.resolveExecutable(Subprocess);
		let printable = args.map(a => JSON.stringify(String(a))).join(' ');
		ZoteroGitHubSync.log(`git ${printable}`);
		let proc = await Subprocess.call({
			command,
			arguments: ['-C', this.root, ...args.map(String)],
			stdout: 'pipe',
			stderr: 'pipe',
		});
		let read = async stream => {
			let output = '';
			let part;
			while ((part = await stream.readString())) output += part;
			return output;
		};
		let [stdout, stderr, result] = await Promise.all([
			read(proc.stdout),
			read(proc.stderr),
			proc.wait(),
		]);
		let code = result.exitCode;
		if (code && !allowFailure) {
			let detail = (stderr || stdout).trim();
			throw new Error(`git ${args[0]} failed (${code})${detail ? `: ${detail}` : ''}`);
		}
		return { code, stdout, stderr };
	}

	async validate() {
		if (!this.root || !PathUtils.isAbsolute(this.root) || !await IOUtils.exists(this.root)) {
			throw new Error('Local Workspace path must be an existing absolute directory.');
		}
		let top = (await this.run(['rev-parse', '--show-toplevel'])).stdout.trim();
		let normalize = p => String(p).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
		if (normalize(top) !== normalize(this.root)) {
			throw new Error(`Configured workspace is not the Git root (${top}).`);
		}
		let current = (await this.run(['branch', '--show-current'])).stdout.trim();
		if (current !== this.branch) {
			throw new Error(current
				? `Workspace is on branch ${current}; configured branch is ${this.branch}.`
				: `Workspace has a detached HEAD; check out ${this.branch} before syncing.`);
		}
		return true;
	}

	async status(paths = []) {
		let result = await this.run([
			'status', '--porcelain=v1', '-z', '--untracked-files=all',
			...(paths.length ? ['--', ...paths] : []),
		]);
		return LocalGit.parsePorcelainZ(result.stdout);
	}

	async hasOperationInProgress() {
		for (let name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
			let result = await this.run(['rev-parse', '--git-path', name]);
			let path = result.stdout.trim();
			if (path && !PathUtils.isAbsolute(path)) path = PathUtils.join(this.root, path);
			if (path && await IOUtils.exists(path)) return name;
		}
		let unmerged = await this.run(['diff', '--name-only', '--diff-filter=U']);
		return unmerged.stdout.trim() ? 'unmerged files' : '';
	}

	async staged() {
		let result = await this.run(['diff', '--cached', '--name-only', '-z']);
		return result.stdout.split('\0').filter(Boolean).map(p => p.replace(/\\/g, '/'));
	}

	async fetchAndFastForward() {
		let operation = await this.hasOperationInProgress();
		if (operation) return { status: 'blocked', reason: `Git operation in progress: ${operation}` };

		let fetch = await this.run(['fetch', '--prune', this.remote, this.branch], { allowFailure: true });
		if (fetch.code) return { status: 'offline', reason: (fetch.stderr || fetch.stdout).trim() };

		let remoteRef = `${this.remote}/${this.branch}`;
		let exists = await this.run(['rev-parse', '--verify', '--quiet', remoteRef], { allowFailure: true });
		if (exists.code) return { status: 'no-remote-branch' };
		let counts = (await this.run(['rev-list', '--left-right', '--count', `HEAD...${remoteRef}`]))
			.stdout.trim().split(/\s+/).map(Number);
		let [ahead, behind] = counts;
		if (ahead && behind) return { status: 'diverged', ahead, behind };
		if (!behind) return { status: ahead ? 'ahead' : 'up-to-date', ahead, behind: 0 };

		let dirty = await this.status();
		if (dirty.length) {
			return { status: 'remote-pending', behind, reason: 'Working tree has local changes' };
		}
		let merge = await this.run(['merge', '--ff-only', remoteRef], { allowFailure: true });
		if (merge.code) return { status: 'remote-pending', behind, reason: (merge.stderr || merge.stdout).trim() };
		return { status: 'fast-forwarded', behind };
	}

	async commitAndPush(paths, message, { push = true, ignoredPathspecs = [] } = {}) {
		if (!paths?.length) return { status: 'blocked', reason: 'No managed Git paths are configured.' };
		let operation = await this.hasOperationInProgress();
		if (operation) return { status: 'blocked', reason: `Git operation in progress: ${operation}` };
		let staged = await this.staged();
		if (staged.length) {
			return { status: 'staged-pending', reason: `Existing staged files: ${staged.join(', ')}` };
		}
		await this.run(['add', '-A', '--', ...paths, ...ignoredPathspecs]);
		let changed = await this.staged();
		if (!changed.length) return { status: 'up-to-date', changed: [] };
		let inside = path => paths.some(prefix => path === prefix || path.startsWith(`${prefix}/`));
		let unexpected = changed.filter(path => !inside(path));
		if (unexpected.length) {
			return { status: 'staged-pending', reason: `Files staged concurrently outside managed paths: ${unexpected.join(', ')}`, changed };
		}
		let commit = await this.run(['commit', '-m', message], { allowFailure: true });
		if (commit.code) {
			// Leave the plugin's staged files visible and recoverable. Never reset.
			return { status: 'commit-failed', reason: (commit.stderr || commit.stdout).trim(), changed };
		}
		let sha = (await this.run(['rev-parse', 'HEAD'])).stdout.trim();
		if (!push) return { status: 'committed', commit: sha, changed };
		// A normal push is deliberately used. If another computer moved the
		// branch, Git rejects it and the next run fetches/reconciles; never force.
		let pushed = await this.run(['push', this.remote, `HEAD:${this.branch}`], { allowFailure: true });
		if (pushed.code) {
			return { status: 'push-pending', commit: sha, changed, reason: (pushed.stderr || pushed.stdout).trim() };
		}
		return { status: 'pushed', commit: sha, changed };
	}
};
