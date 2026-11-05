/* Zotero GitHub Sync -- preference pane controller
 *
 * Loaded into a sandbox whose prototype is the preferences window. Inline
 * handlers in preferences.xhtml are compiled against the window itself, so the
 * controller is attached to `window` rather than declared with `var`.
 *
 * Fields carrying a `preference` attribute are wired up by Zotero; everything
 * here is for the parts it can't do: the token (which isn't a preference) and
 * the action buttons.
 */

window.ZoteroGitHubSyncPrefs = {
	_statusTimer: null,


	get plugin() {
		return Zotero.GitHubSync;
	},


	t(key, fallback, ...args) {
		let value = this.plugin.getString(key, ...args);
		if (value !== key) return value;
		for (let arg of args) fallback = fallback.replace('%S', arg);
		return fallback;
	},


	localize() {
		for (let element of document.querySelectorAll('[data-zgs-i18n]')) {
			let key = element.getAttribute('data-zgs-i18n');
			let value = this.plugin.getString(key);
			if (value === key) continue;
			if (element.hasAttribute('label')) element.setAttribute('label', value);
			else if (element.hasAttribute('value') && element.localName === 'label') element.setAttribute('value', value);
			else element.textContent = value;
		}
		for (let element of document.querySelectorAll('[data-zgs-i18n-placeholder]')) {
			let key = element.getAttribute('data-zgs-i18n-placeholder');
			let value = this.plugin.getString(key);
			if (value !== key) element.setAttribute('placeholder', value);
		}
	},


	async init() {
		this.localize();
		this._tokenStatus = document.getElementById('zgs-token-status');
		this._status = document.getElementById('zgs-status');
		this._tokenInput = document.getElementById('zgs-token');
		this._quickWorkspace = document.getElementById('zgs-quick-workspace');
		this._quickRepo = document.getElementById('zgs-quick-repo');
		this._quickToken = document.getElementById('zgs-quick-token');
		this._quickStatus = document.getElementById('zgs-quick-status');
		let initial = this.plugin.Prefs.getConfig();
		this._quickWorkspace.value = initial.workspacePath || '';
		this._quickRepo.value = initial.owner && initial.repo
			? `https://github.com/${initial.owner}/${initial.repo}` : '';

		this._tokenInput.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') {
				this.saveToken();
			}
		});
		document.getElementById('zgs-workspace-transport').addEventListener('change', event => {
			this.plugin.Prefs.set('workspaceTransport', event.target.value);
			setTimeout(() => this.refreshMode(), 0);
		});

		await this.refreshTokenStatus();
		this.refreshObsidianConfirmation();
		this.refreshMode();
		this.refreshStatus();
		// The status block shows the result of syncs started from anywhere, so
		// keep it current while the pane is open
		this._statusTimer = setInterval(() => this.refreshStatus(), 1000);
	},


	async chooseQuickFolder() {
		try {
			let { FilePicker } = ChromeUtils.importESModule('chrome://zotero/content/modules/filePicker.mjs');
			let picker = new FilePicker();
			picker.init(window, this.t('pref.dialog.quickFolder', 'Choose or create the local research workspace'), picker.modeGetFolder);
			let result = await picker.show();
			if (result !== picker.returnOK && result !== picker.returnReplace) return;
			let path = typeof picker.file === 'string' ? picker.file : picker.file?.path;
			if (path) this._quickWorkspace.value = path;
		}
		catch (e) { Zotero.logError(e); }
	},


	async quickSetup() {
		let button = document.getElementById('zgs-quick-run');
		button.disabled = true;
		this._quickStatus.classList.remove('zgs-error', 'zgs-ok');
		this._quickStatus.textContent = this.t('pref.quick.checking', 'Checking repository and downloading the workspace…');
		try {
			if (this.plugin.Sync.isRunning) throw new Error(this.t('pref.quick.wait', 'Wait for the current sync to finish, then run setup again.'));
			if (!this.plugin.BetterNotes.available()) throw new Error(this.t('pref.quick.needBetterNotes', 'Install Better Notes 3.3.x before setting up this computer.'));
			let workspacePath = this._quickWorkspace.value.trim();
			if (!workspacePath || !PathUtils.isAbsolute(workspacePath) || !await IOUtils.exists(workspacePath)) {
				throw new Error(this.t('pref.quick.needWorkspace', 'Choose an existing absolute local workspace folder.'));
			}
			let stat = await IOUtils.stat(workspacePath);
			if (stat.type !== 'directory') throw new Error(this.t('pref.quick.workspaceDirectory', 'The local workspace must be a directory.'));
			let parsed;
			try {
				parsed = this.plugin.Prefs.parseRepositoryURL(this._quickRepo.value);
			}
			catch (e) {
				let keys = {
					'Enter a GitHub repository URL.': ['pref.quick.needRepo', 'Enter a GitHub repository URL.'],
					'Enter a valid GitHub repository URL.': ['pref.quick.invalidRepo', 'Enter a valid GitHub repository URL.'],
					'Repository URL must include an owner and repository.': ['pref.quick.repoOwner', 'Repository URL must include an owner and repository.'],
				};
				let [key, fallback] = keys[e.message] || [];
				throw new Error(key ? this.t(key, fallback) : (e.message || String(e)));
			}
			let token = this._quickToken.value.trim() || await this.plugin.Prefs.getToken();
			if (!token) throw new Error(this.t('pref.quick.needToken', 'Enter a GitHub token with Contents: Read and write access.'));

			let client = new this.plugin.GitHub({
				token, apiURL: parsed.apiURL, owner: parsed.owner, repo: parsed.repo,
			});
			let repo = await client.getRepo();
			if (!repo) throw new Error(this.t('pref.quick.repoInvisible', '%S is not visible to this token.', `${parsed.owner}/${parsed.repo}`));
			if (repo.permissions?.push === false) throw new Error(this.t('pref.quick.repoReadOnly', 'The token cannot write to %S. Grant Contents: Read and write.', repo.full_name));
			let branch = parsed.branch || repo.default_branch || 'main';
			let values = {
				...this.plugin.Prefs.quickSetupValues(workspacePath),
				apiURL: parsed.apiURL, owner: parsed.owner, repo: parsed.repo,
				branch, gitBranch: branch, syncOnChange: true, syncOnStartup: true,
				automationPaused: false,
			};
			this.plugin.Sync._setupInProgress = true;
			for (let [key, value] of Object.entries(values)) this.plugin.Prefs.set(key, value);
			await this.plugin.Prefs.setToken(token);
			this._quickToken.value = '';
			await this.plugin.Workspace.resetSetupState(this.plugin.Prefs.getConfig());
			this.plugin.Sync.updateSchedule();
			let result = await this.plugin.Sync.syncNow({ trigger: 'quick-setup', silent: false });
			if (['error', 'busy', 'not-configured', 'cancelled'].includes(result.status)) {
				throw new Error(result.error || this.t('pref.quick.stopped', 'Setup stopped with status: %S', result.status));
			}
			this._quickStatus.textContent = result.pending
				? this.t('pref.quick.pending', 'Setup completed with %S pending change(s). Review the status below before editing.', result.pending)
				: this.t('pref.quick.complete', 'Setup complete. Restored the workspace and configured %S as the Vault.', values.obsidianVaultPath);
			this._quickStatus.classList.toggle('zgs-error', !!result.pending);
			this._quickStatus.classList.toggle('zgs-ok', !result.pending);
			document.getElementById('zgs-workspace-path').value = workspacePath;
			document.getElementById('zgs-vault-path').value = values.obsidianVaultPath;
			document.getElementById('zgs-template-path').value = values.noteTemplatePath;
			await this.refreshTokenStatus();
			this.refreshMode();
			this.refreshStatus();
			if (!result.pending) this.testObsidian();
		}
		catch (e) {
			Zotero.logError(e);
			this._quickStatus.textContent = e.message || String(e);
			this._quickStatus.classList.add('zgs-error');
		}
		finally {
			this.plugin.Sync._setupInProgress = false;
			button.disabled = false;
		}
	},


	refreshMode() {
		let config = this.plugin.Prefs.getConfig();
		let api = config.workspaceTransport === 'github-api';
		document.getElementById('zgs-workspace-transport').value = config.workspaceTransport;
		document.getElementById('zgs-system-git-settings').hidden = api;
		document.getElementById('zgs-system-auto-push').hidden = api;
		document.getElementById('zgs-github-account').hidden = !api;
		document.getElementById('zgs-github-repository').hidden = !api;
		let pause = document.getElementById('zgs-pause');
		pause.label = config.automationPaused
			? this.t('pref.automation.resume', 'Resume GitHub automation')
			: this.t('pref.automation.pause', 'Pause GitHub automation');
	},


	async chooseFolder(pref, inputID) {
		try {
			let { FilePicker } = ChromeUtils.importESModule('chrome://zotero/content/modules/filePicker.mjs');
			let picker = new FilePicker();
			picker.init(window, this.t('pref.dialog.folder', 'Choose folder'), picker.modeGetFolder);
			let result = await picker.show();
			if (result !== picker.returnOK && result !== picker.returnReplace) return;
			let path = typeof picker.file === 'string' ? picker.file : picker.file?.path;
			if (!path) return;
			this.plugin.Prefs.set(pref, path);
			document.getElementById(inputID).value = path;
			this.refreshMode();
		}
		catch (e) { Zotero.logError(e); }
	},


	async chooseTemplate() {
		try {
			let { FilePicker } = ChromeUtils.importESModule('chrome://zotero/content/modules/filePicker.mjs');
			let picker = new FilePicker();
			picker.init(window, this.t('pref.dialog.template', 'Choose Markdown template'), picker.modeOpen);
			picker.appendFilter('Markdown', '*.md');
			let result = await picker.show();
			if (result !== picker.returnOK) return;
			let path = typeof picker.file === 'string' ? picker.file : picker.file?.path;
			if (!path) return;
			this.plugin.Prefs.set('noteTemplatePath', path);
			document.getElementById('zgs-template-path').value = path;
		}
		catch (e) { Zotero.logError(e); }
	},


	async testWorkspace() {
		let status = document.getElementById('zgs-local-test-status');
		status.textContent = this.t('pref.workspace.checking', 'Checking…');
		try {
			let config = this.plugin.Prefs.getConfig();
			if (!config.workspacePath || !PathUtils.isAbsolute(config.workspacePath)
				|| !await IOUtils.exists(config.workspacePath)) {
				throw new Error(this.t('pref.workspace.needDirectory', 'Choose an existing absolute workspace directory.'));
			}
			let transport;
			if (config.workspaceTransport === 'system-git') {
				await new this.plugin.LocalGit(config).validate();
				transport = this.t('pref.workspace.gitValid', 'System Git workspace and branch are valid.');
			}
			else {
				let token = await this.plugin.Prefs.getToken();
				if (!token || !config.owner || !config.repo || !config.branch) {
					throw new Error(this.t('pref.workspace.needAPI', 'Workspace is valid; configure and save the GitHub API repository and token.'));
				}
				transport = this.t('pref.workspace.apiValid', 'Workspace directory and GitHub API settings are configured.');
			}
			let bn = this.plugin.BetterNotes.available()
				? this.t('pref.workspace.bnDetected', 'Better Notes %S detected.', this.plugin.BetterNotes.version())
				: this.t('pref.workspace.bnUnavailable', 'Better Notes public API is unavailable.');
			status.textContent = `${transport} ${bn}`;
			status.classList.toggle('zgs-error', !this.plugin.BetterNotes.available());
		}
		catch (e) {
			status.textContent = e.message || String(e);
			status.classList.add('zgs-error');
		}
	},


	testObsidian() {
		let config = this.plugin.Prefs.getConfig();
		if (!config.obsidianVaultPath) return;
		let name = config.obsidianVaultName || PathUtils.filename(config.obsidianVaultPath);
		Zotero.launchURL(`obsidian://open?vault=${encodeURIComponent(name)}`);
	},


	refreshObsidianConfirmation() {
		let control = document.getElementById('zgs-obsidian-confirm');
		let hint = document.getElementById('zgs-obsidian-confirm-help');
		let version = this.plugin.Obsidian.majorVersion();
		control.checked = this.plugin.Obsidian.askBeforeOpen();
		hint.textContent = this.plugin.Obsidian.usesSchemePreferences()
			? this.t('pref.obsidian.confirmHelpModern', 'Zotero %S: this controls only obsidian:// links. Changes take effect immediately.', version)
			: this.t('pref.obsidian.confirmHelpLegacy', 'Zotero %S: this setting affects every external protocol, not only obsidian://. Changes take effect immediately.', version);
	},


	setObsidianConfirmation(ask) {
		try {
			this.plugin.Obsidian.setAskBeforeOpen(ask);
			this.refreshObsidianConfirmation();
		}
		catch (e) {
			Zotero.logError(e);
			this.refreshObsidianConfirmation();
		}
	},


	togglePause() {
		let paused = !this.plugin.Prefs.get('automationPaused');
		this.plugin.Prefs.set('automationPaused', paused);
		this.plugin.Sync.updateSchedule();
		this.refreshMode();
	},


	uninit() {
		if (this._statusTimer) {
			clearInterval(this._statusTimer);
			this._statusTimer = null;
		}
	},


	// -- Token -------------------------------------------------------------

	async saveToken() {
		let token = this._tokenInput.value.trim();
		if (!token) {
			this._setTokenStatus(this.t('pref.token.enter', 'Enter a token first.'), 'error');
			return;
		}
		try {
			await this.plugin.Prefs.setToken(token);
			// Don't leave the secret sitting in the field
			this._tokenInput.value = '';
			await this.refreshTokenStatus();
			this._setTokenStatus(this.t('pref.token.saved', 'Token saved. Use "Test connection" to check it.'), 'ok');
		}
		catch (e) {
			Zotero.logError(e);
			this._setTokenStatus(this.t('pref.token.saveFailed', 'Could not save the token: %S', e.message || e), 'error');
		}
	},


	async clearToken() {
		try {
			await this.plugin.Prefs.setToken('');
			this._tokenInput.value = '';
			this._setTokenStatus(this.t('pref.token.removed', 'Token removed.'), '');
		}
		catch (e) {
			Zotero.logError(e);
			this._setTokenStatus(this.t('pref.token.removeFailed', 'Could not remove the token: %S', e.message || e), 'error');
		}
	},


	async refreshTokenStatus() {
		let token = await this.plugin.Prefs.getToken();
		this._setTokenStatus(token
			? this.t('pref.token.exists', 'A token is saved.')
			: this.t('pref.token.missing', 'No token saved yet.'), '');
	},


	async testConnection() {
		let config = this.plugin.Prefs.getConfig();
		let token = await this.plugin.Prefs.getToken();
		if (!token) {
			this._setTokenStatus(this.t('pref.token.saveFirst', 'Save a token first.'), 'error');
			return;
		}
		if (!config.owner || !config.repo) {
			this._setTokenStatus(this.t('pref.token.repoFirst', 'Fill in the owner and repository first.'), 'error');
			return;
		}

		this._setTokenStatus(this.t('pref.workspace.checking', 'Checking…'), '');
		try {
			let client = new this.plugin.GitHub({
				token,
				apiURL: config.apiURL,
				owner: config.owner,
				repo: config.repo,
			});
			let user = await client.getAuthenticatedUser();
			let repo = await client.getRepo();

			if (!repo) {
				let creation = config.autoCreateRepo
					? this.t('pref.token.createEnabled', 'If it does not exist, the first sync will try to create it (that needs Administration: Read and write).')
					: this.t('pref.token.createDisabled', 'Automatic creation is turned off.');
				this._setTokenStatus(
					this.t('pref.token.repoInvisible',
						'Signed in as %S, but %S is not visible to this token. If the repository already exists, edit the token on GitHub, choose the repository under Repository access, and set Contents to Read and write. %S',
						user.login, `${config.owner}/${config.repo}`, creation),
					'error'
				);
				return;
			}
			if (!repo.permissions?.push) {
				this._setTokenStatus(
					this.t('pref.token.noWrite',
						'Signed in as %S, but the token cannot write to %S. Grant it Contents: Read and write.',
						user.login, repo.full_name),
					'error'
				);
				return;
			}
			this._setTokenStatus(
				this.t('pref.token.connected',
					'Signed in as %S. Write access to %S (%S), default branch %S.',
					user.login, repo.full_name,
					repo.private ? this.t('pref.token.private', 'private') : this.t('pref.token.public', 'public'),
					repo.default_branch),
				'ok'
			);
		}
		catch (e) {
			Zotero.logError(e);
			this._setTokenStatus(e.message || String(e), 'error');
		}
	},


	// -- Actions -----------------------------------------------------------

	syncNow() {
		this.plugin.Sync.syncNow({ trigger: 'preferences' })
			.then(() => this.refreshStatus())
			.catch(e => Zotero.logError(e));
	},


	pull() {
		this.plugin.Sync.pull()
			.then(() => this.refreshStatus())
			.catch(e => Zotero.logError(e));
	},


	cancel() {
		this.plugin.Sync.cancel();
		this.refreshStatus();
	},


	openRepo() {
		let config = this.plugin.Prefs.getConfig();
		if (config.workspaceTransport === 'system-git') {
			Zotero.File.reveal(config.workspacePath);
			return;
		}
		let url = this.plugin.Prefs.getRepoURL();
		if (url) {
			Zotero.launchURL(url);
		}
	},


	// -- Status ------------------------------------------------------------

	refreshStatus() {
		let prefs = this.plugin.Prefs;
		let lastLocalSync = prefs.get('lastLocalSync');
		let localLastError = prefs.get('localLastError');
		let localLastWarnings = prefs.get('localLastWarnings');
		let localStatus = prefs.get('localStatus');
		let lastSync = prefs.get('lastSync');
		let lastCommit = prefs.get('lastCommit');
		let lastError = prefs.get('lastError');
		let lastWarnings = prefs.get('lastWarnings');
		let cloudStatus = prefs.get('cloudStatus');

		let lines = [];
		let sync = this.plugin.Sync;
		let running = sync.isRunning;
		if (running) {
			lines.push(this.t('pref.status.syncing', 'Syncing: %S', sync.describeProgress() || '…'), '');
		}
		document.getElementById('zgs-cancel').hidden = !running;
		document.getElementById('zgs-sync-now').disabled = running;
		document.getElementById('zgs-pull').disabled = running;
		lines.push(this.t('pref.status.local', 'Local coordination'));
		lines.push(lastLocalSync
			? this.t('pref.status.lastRun', 'Last run: %S', lastLocalSync)
			: this.t('pref.status.neverRun', 'Not run yet.'));
		if (localStatus) {
			try {
				let value = JSON.parse(localStatus);
				lines.push(this.t('pref.status.state', 'Status: %S; pending: %S', value.status, value.pending || 0));
			}
			catch (e) {}
		}
		if (localLastError) lines.push(this.t('pref.status.lastError', 'Last error: %S', localLastError));
		if (localLastWarnings) {
			lines.push(this.t('pref.status.warnings', 'Pending or warnings:'), ...localLastWarnings.split('\n').map(line => `  ${line}`));
		}

		lines.push('', this.t('pref.status.cloud', 'GitHub cloud sync'));
		lines.push(lastSync
			? this.t('pref.status.lastRun', 'Last run: %S', lastSync)
			: this.t('pref.status.neverRun', 'Not run yet.'));
		if (lastCommit) {
			lines.push(this.t('pref.status.lastCommit', 'Last commit: %S', lastCommit.slice(0, 10)));
		}
		if (lastError) {
			lines.push(this.t('pref.status.lastError', 'Last error: %S', lastError));
		}
		if (lastWarnings) {
			lines.push(this.t('pref.status.warnings', 'Pending or warnings:'), ...lastWarnings.split('\n').map(line => `  ${line}`));
		}
		if (cloudStatus) {
			try {
				let value = JSON.parse(cloudStatus);
				lines.push(this.t('pref.status.cloudState',
					'Status: %S; transport: %S; remote: %S; pending: %S',
					value.status, value.transport, value.remote, value.pending || 0));
			}
			catch (e) {}
		}

		this._status.textContent = lines.join('\n');
		this._status.classList.toggle('zgs-error', !!(lastError || localLastError));
	},


	_setTokenStatus(message, kind) {
		this._tokenStatus.textContent = message;
		this._tokenStatus.classList.toggle('zgs-error', kind === 'error');
		this._tokenStatus.classList.toggle('zgs-ok', kind === 'ok');
	},
};
