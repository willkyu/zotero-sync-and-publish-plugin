/* Zotero GitHub Sync -- preference access and token storage
 *
 * Ordinary settings live on the `extensions.zotero-github-sync.` branch (see
 * prefs.js in the plugin root for the defaults). The personal access token does
 * not: it goes into the login manager, the same place Zotero keeps its own API
 * key, so it isn't sitting in prefs.js in the profile directory in plain text.
 */

ZoteroGitHubSync.Prefs = {
	LOGIN_ORIGIN: 'chrome://zotero-github-sync',
	LOGIN_REALM: 'GitHub Personal Access Token',

	_observers: [],
	_tokenCache: null,


	// -- Plain preferences -------------------------------------------------

	get(key) {
		return Zotero.Prefs.get(ZoteroGitHubSync.PREF_BRANCH + key, true);
	},


	set(key, value) {
		return Zotero.Prefs.set(ZoteroGitHubSync.PREF_BRANCH + key, value, true);
	},


	clear(key) {
		try {
			Zotero.Prefs.clear(ZoteroGitHubSync.PREF_BRANCH + key, true);
		}
		catch (e) {
			// Clearing a pref that was never set throws; nothing to do
		}
	},


	/**
	 * @param {String[]} keys
	 * @param {Function} handler - Called with no arguments when any key changes
	 */
	observe(keys, handler) {
		for (let key of keys) {
			this._observers.push(
				Zotero.Prefs.registerObserver(ZoteroGitHubSync.PREF_BRANCH + key, handler, true)
			);
		}
	},


	unobserveAll() {
		for (let symbol of this._observers) {
			Zotero.Prefs.unregisterObserver(symbol);
		}
		this._observers = [];
	},


	/**
	 * Reserved for renaming preferences in later versions without losing the
	 * user's settings.
	 */
	migrate() {},


	parseRepositoryURL(value) {
		let raw = String(value || '').trim();
		if (!raw) throw new Error('Enter a GitHub repository URL.');
		let host = 'github.com';
		let path = '';
		let ssh = raw.match(/^git@([^:]+):(.+)$/i);
		if (ssh) {
			host = ssh[1];
			path = ssh[2];
		}
		else {
			let url;
			try { url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); }
			catch (e) { throw new Error('Enter a valid GitHub repository URL.'); }
			host = url.hostname;
			path = url.pathname.replace(/^\/+/, '');
		}
		let parts = path.replace(/\.git\/?$/i, '').split('/').filter(Boolean).map(decodeURIComponent);
		if (parts.length < 2) throw new Error('Repository URL must include an owner and repository.');
		let branch = parts[2] === 'tree' && parts.length > 3 ? parts.slice(3).join('/') : '';
		return {
			owner: parts[0], repo: parts[1], branch,
			apiURL: host.toLowerCase() === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`,
		};
	},


	quickSetupValues(workspacePath) {
		return {
			workspaceTransport: 'github-api', workspacePath,
			managedPaths: 'content,zotero', basePath: 'zotero',
			papersPath: 'content/papers', assetsPath: 'content/assets',
			obsidianVaultPath: PathUtils.join(workspacePath, 'content'),
			obsidianVaultName: 'content',
			noteTemplatePath: PathUtils.join(workspacePath, 'content', 'templates', 'paper.md'),
			autoCommit: true,
		};
	},


	// -- Derived configuration ---------------------------------------------

	/**
	 * @return {Object} Everything the sync engine needs, already normalized
	 */
	getConfig() {
		let relative = (value, fallback) => {
			try {
				let raw = String(value || fallback || '').replace(/\\/g, '/');
				let segments = raw.split('/');
				if (/^[A-Za-z]:/.test(raw) || raw.startsWith('/')
					|| segments.some(s => s === '.' || s === '..')) throw new Error('not relative');
				return segments.map(s => s.trim()).filter(Boolean).join('/');
			}
			catch (e) {
				return fallback;
			}
		};
		let managedPaths = String(this.get('managedPaths') || 'content,zotero')
			.split(',').map(p => relative(p.trim(), '')).filter(Boolean);
		let branch = String(this.get('branch') || 'main').trim() || 'main';
		return {
			workspaceTransport: this.get('workspaceTransport') === 'github-api' ? 'github-api' : 'system-git',
			workspacePath: String(this.get('workspacePath') || '').trim(),
			gitExecutable: String(this.get('gitExecutable') || 'git').trim() || 'git',
			gitRemote: String(this.get('gitRemote') || 'origin').trim() || 'origin',
			gitBranch: String(this.get('gitBranch') || branch).trim() || branch,
			managedPaths: [...new Set(managedPaths)],
			papersPath: relative(this.get('papersPath'), 'content/papers'),
			assetsPath: relative(this.get('assetsPath'), 'content/assets'),
			obsidianVaultPath: String(this.get('obsidianVaultPath') || '').trim(),
			obsidianVaultName: String(this.get('obsidianVaultName') || '').trim(),
			noteTemplatePath: String(this.get('noteTemplatePath') || '').trim(),
			includePDFsLocal: !!this.get('includePDFsLocal'),
			includeNoteImagesLocal: this.get('includeNoteImagesLocal') !== false,
			autoCommit: this.get('autoCommit') !== false,
			autoPush: this.get('autoPush') !== false,
			automationPaused: !!this.get('automationPaused'),
			openNoteWithPDF: !!this.get('openNoteWithPDF'),
			openBoundNoteOnDoubleClick: !!this.get('openBoundNoteOnDoubleClick'),
			apiURL: (this.get('apiURL') || 'https://api.github.com').replace(/\/+$/, ''),
			owner: (this.get('owner') || '').trim(),
			repo: (this.get('repo') || '').trim(),
			branch,
			basePath: ZoteroGitHubSync.Utils.normalizeBasePath(this.get('basePath')),
			autoCreateRepo: !!this.get('autoCreateRepo'),
			repoPrivate: !!this.get('repoPrivate'),

			includeGroupLibraries: !!this.get('includeGroupLibraries'),
			exportJSON: !!this.get('exportJSON'),
			exportMarkdown: !!this.get('exportMarkdown'),
			exportBibTeX: !!this.get('exportBibTeX'),
			exportIndex: !!this.get('exportIndex'),
			includeNotes: !!this.get('includeNotes'),
			includeAttachments: !!this.get('includeAttachments'),
			includeLinkedFiles: !!this.get('includeLinkedFiles'),
			maxAttachmentBytes: Math.max(0, Number(this.get('maxAttachmentMB')) || 0) * 1024 * 1024,
			lfsEnabled: !!this.get('lfsEnabled'),
			// Git objects are capped at 100 MB, and the blob API takes them as
			// base64 JSON, so keep a margin below that
			lfsThresholdBytes: Math.min(95, Math.max(1, Number(this.get('lfsThresholdMB')) || 50)) * 1024 * 1024,
			lfsURL: (this.get('lfsURL') || '').trim(),
			prune: !!this.get('prune'),

			intervalEnabled: !!this.get('intervalEnabled'),
			intervalMinutes: Math.max(5, Number(this.get('intervalMinutes')) || 60),
			// This controls GitHub transport only. Local Zotero/workspace
			// coordination is always enabled while Zotero is running.
			syncOnChange: !!this.get('syncOnChange'),
			changeDelayMinutes: Math.max(1, Number(this.get('changeDelayMinutes')) || 5),
			syncOnStartup: !!this.get('syncOnStartup'),
			syncAfterZoteroSync: !!this.get('syncAfterZoteroSync'),

			commitMessage: this.get('commitMessage') || 'Zotero sync: {changes} ({date})',
			authorName: (this.get('authorName') || '').trim(),
			authorEmail: (this.get('authorEmail') || '').trim(),
		};
	},


	/**
	 * The repository coordinates are enough to attempt a sync; the token is
	 * checked separately because reading it is async.
	 *
	 * @return {Boolean}
	 */
	hasRepoConfig() {
		let config = this.getConfig();
		return !!config.workspacePath && (config.workspaceTransport !== 'github-api'
			|| !!(config.owner && config.repo && config.branch));
	},


	/**
	 * @return {Promise<Boolean>}
	 */
	async isConfigured() {
		let config = this.getConfig();
		return this.hasRepoConfig()
			&& (config.workspaceTransport !== 'github-api' || !!(await this.getToken()));
	},


	/**
	 * @return {String} Browser URL of the configured repository, or ''
	 */
	getRepoURL() {
		let config = this.getConfig();
		if (!config.owner || !config.repo) {
			return '';
		}
		// api.github.com -> github.com; a GitHub Enterprise API URL looks like
		// https://ghe.example.com/api/v3, whose web root is the host
		let host = 'https://github.com';
		try {
			let url = new URL(config.apiURL);
			if (url.hostname !== 'api.github.com') {
				host = `${url.protocol}//${url.host}`;
			}
		}
		catch (e) {
			ZoteroGitHubSync.logError(e);
		}
		return `${host}/${config.owner}/${config.repo}/tree/${config.branch}`;
	},


	/**
	 * @param {Object} config - From getConfig()
	 * @return {String} Git LFS API root for the configured repository
	 */
	getLFSURL(config) {
		if (config.lfsURL) {
			return config.lfsURL.replace(/\/+$/, '');
		}
		// api.github.com -> github.com; a GitHub Enterprise API URL looks like
		// https://ghe.example.com/api/v3, whose Git host is the same host
		let host = 'https://github.com';
		try {
			let url = new URL(config.apiURL);
			if (url.hostname !== 'api.github.com') {
				host = `${url.protocol}//${url.host}`;
			}
		}
		catch (e) {
			ZoteroGitHubSync.logError(e);
		}
		return `${host}/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}.git/info/lfs`;
	},


	// -- Token -------------------------------------------------------------

	/**
	 * @return {Promise<String>} The stored token, or '' if there is none
	 */
	async getToken() {
		if (this._tokenCache !== null) {
			return this._tokenCache;
		}
		let login = await this._findLogin();
		this._tokenCache = login ? login.password : '';
		return this._tokenCache;
	},


	/**
	 * @param {String} token - Pass '' to remove the stored token
	 */
	async setToken(token) {
		token = (token || '').trim();
		let existing = await this._findLogin();

		if (!token) {
			if (existing) {
				// The synchronous form: removeLoginAsync() doesn't exist in Zotero 10
				Services.logins.removeLogin(existing);
			}
			this._tokenCache = '';
			return;
		}

		let nsLoginInfo = new Components.Constructor(
			'@mozilla.org/login-manager/loginInfo;1',
			Components.interfaces.nsILoginInfo,
			'init'
		);
		let loginInfo = new nsLoginInfo(
			this.LOGIN_ORIGIN,
			null,
			this.LOGIN_REALM,
			'token',
			token,
			'',
			''
		);
		if (existing) {
			// The synchronous form: modifyLoginAsync() doesn't exist in Zotero 10
			Services.logins.modifyLogin(existing, loginInfo);
		}
		else {
			await Services.logins.addLoginAsync(loginInfo);
		}
		this._tokenCache = token;
	},


	async _findLogin() {
		try {
			let logins = await Services.logins.searchLoginsAsync({
				origin: this.LOGIN_ORIGIN,
				httpRealm: this.LOGIN_REALM,
			});
			return logins.length ? logins[0] : null;
		}
		catch (e) {
			ZoteroGitHubSync.logError(e);
			return null;
		}
	},
};
