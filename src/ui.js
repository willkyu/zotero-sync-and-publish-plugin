/* Zotero GitHub Sync -- menus, toolbar button and status feedback
 *
 * Everything added to a window is recorded so removeFromWindow() can take it all
 * back out again when the plugin is disabled or upgraded, which Zotero requires
 * of bootstrapped plugins.
 */

ZoteroGitHubSync.UI = {
	// window -> Element[] we created
	_added: new WeakMap(),
	_windows: new Set(),

	addToWindow(win) {
		if (this._added.has(win)) {
			return;
		}
		let elements = [];
		this._added.set(win, elements);
		this._windows.add(win);

		for (let add of [
			'_addStylesheet',
			'_addToolbarButton',
			'_addToolsMenu',
			'_addItemContextMenu',
			'_addReadingNoteShortcut',
		]) {
			try {
				this[add](win, elements);
			}
			catch (e) {
				ZoteroGitHubSync.logError(e);
			}
		}
		this.onStatusChange(ZoteroGitHubSync.Sync.status, ZoteroGitHubSync.Sync.progress);
	},


	removeFromWindow(win) {
		let elements = this._added.get(win);
		if (elements) {
			for (let element of elements) {
				element.remove();
			}
			this._added.delete(win);
		}
		this._windows.delete(win);
	},


	/**
	 * Reflect sync state and progress on every open window's toolbar button.
	 *
	 * @param {String} status - idle | syncing | error
	 * @param {Object|null} progress - Sync.progress
	 */
	onStatusChange(status, progress) {
		let Sync = ZoteroGitHubSync.Sync;
		let get = (key, ...args) => ZoteroGitHubSync.getString(key, ...args);
		let lines = [get('progress.headline')];
		if (status === 'syncing') {
			lines.push(Sync.describeProgress(progress) || get('progress.collecting'), get('toolbar.clickForProgress'));
		}
		else if (status === 'attention') {
			let local = Number(ZoteroGitHubSync.Prefs.get('localPendingReview')) || 0;
			let cloud = Number(ZoteroGitHubSync.Prefs.get('cloudPendingReview')) || 0;
			lines.push(get('toolbar.attention', String(local + cloud), String(local), String(cloud)));
		}
		else {
			let lastError = ZoteroGitHubSync.Prefs.get('lastError');
			let lastSync = ZoteroGitHubSync.Prefs.get('lastSync');
			if (status === 'error' && lastError) {
				lines.push(get('toolbar.lastError', lastError));
			}
			lines.push(lastSync ? get('toolbar.lastSync', new Date(lastSync).toLocaleString()) : get('toolbar.never'));
			lines.push(get('toolbar.clickToSync'));
		}
		let tooltip = lines.join('\n');
		let percent = status === 'syncing' ? Sync.percent(progress) : null;
		let waiting = !!(progress?.waitUntil && progress.waitUntil > Date.now());

		for (let win of this._windows) {
			let button = win.document?.getElementById('zotero-github-sync-button');
			if (!button) {
				continue;
			}
			button.setAttribute('zgs-status', status);
			button.setAttribute('zgs-waiting', String(waiting));
			button.setAttribute('tooltiptext', tooltip);
			button.setAttribute('label', percent === null ? '' : `${percent}%`);
		}
	},


	// -- Builders ----------------------------------------------------------

	_addStylesheet(win, elements) {
		let doc = win.document;
		let link = doc.createElementNS('http://www.w3.org/1999/xhtml', 'link');
		link.id = 'zotero-github-sync-stylesheet';
		link.setAttribute('rel', 'stylesheet');
		link.setAttribute('href', `${ZoteroGitHubSync.rootURI}content/toolbar.css`);
		doc.documentElement.appendChild(link);
		elements.push(link);

		let reviewLink = doc.createElementNS('http://www.w3.org/1999/xhtml', 'link');
		reviewLink.id = 'zotero-github-sync-review-stylesheet';
		reviewLink.setAttribute('rel', 'stylesheet');
		reviewLink.setAttribute('href', `${ZoteroGitHubSync.rootURI}content/review.css`);
		doc.documentElement.appendChild(reviewLink);
		elements.push(reviewLink);
	},


	_addToolbarButton(win, elements) {
		let doc = win.document;
		// Beside Zotero's own sync button in the title bar; the items toolbar is
		// the fallback for layouts that don't have one
		let zoteroSync = doc.getElementById('zotero-tb-sync');
		let container = zoteroSync?.parentNode || doc.getElementById('zotero-items-toolbar');
		if (!container) {
			return;
		}

		let button = doc.createXULElement('toolbarbutton');
		button.id = 'zotero-github-sync-button';
		button.className = 'zotero-tb-button';
		button.setAttribute('tabindex', '-1');
		button.setAttribute('zgs-status', 'idle');

		let popup = doc.createXULElement('menupopup');
		popup.id = 'zotero-github-sync-button-menu';
		let rebuild = () => {
			popup.replaceChildren();
			let running = ZoteroGitHubSync.Sync.isRunning;
			let entries = running
				? [
					{ label: ZoteroGitHubSync.getString('menu.showProgress'), command: () => ZoteroGitHubSync.Sync._openProgressWindow() },
					{ label: ZoteroGitHubSync.getString('menu.cancel'), command: () => ZoteroGitHubSync.Sync.cancel() },
					{ separator: true },
				]
				: [];
			for (let entry of [...entries, ...this._menuEntries(win)]) {
				let item = this._createMenuItem(doc, entry);
				if (running && entry.id === 'sync-now') {
					item.setAttribute('disabled', 'true');
				}
				popup.append(item);
			}
		};
		popup.addEventListener('popupshowing', rebuild);

		button.addEventListener('command', () => {
			let Sync = ZoteroGitHubSync.Sync;
			if (Sync.isRunning) {
				Sync._openProgressWindow();
				return;
			}
			Sync.syncNow({ trigger: 'button' })
				.catch(e => ZoteroGitHubSync.logError(e));
		});
		button.addEventListener('contextmenu', (event) => {
			event.preventDefault();
			popup.openPopup(button, 'after_end', 0, 0, true, false, event);
		});

		let popupset = doc.querySelector('popupset') || doc.documentElement;
		popupset.append(popup);
		elements.push(popup);

		if (zoteroSync) {
			container.insertBefore(button, zoteroSync);
		}
		else {
			container.append(button);
		}
		elements.push(button);
	},


	_addToolsMenu(win, elements) {
		let doc = win.document;
		let toolsPopup = doc.getElementById('menu_ToolsPopup');
		if (!toolsPopup) {
			return;
		}

		let menu = doc.createXULElement('menu');
		menu.id = 'zotero-github-sync-tools-menu';
		menu.setAttribute('label', ZoteroGitHubSync.getString('menu.root'));

		let popup = doc.createXULElement('menupopup');
		for (let entry of this._menuEntries(win)) {
			popup.append(this._createMenuItem(doc, entry));
		}
		menu.append(popup);
		toolsPopup.append(menu);
		elements.push(menu);
	},


	_addItemContextMenu(win, elements) {
		let doc = win.document;
		let itemMenu = doc.getElementById('zotero-itemmenu');
		if (!itemMenu) {
			return;
		}

		let separator = doc.createXULElement('menuseparator');
		separator.id = 'zotero-github-sync-item-separator';

		let openNote = doc.createXULElement('menuitem');
		openNote.id = 'zotero-quartz-open-reading-note';
		openNote.setAttribute('label', 'Open Reading Note in Obsidian');
		openNote.setAttribute('key', 'zotero-quartz-open-reading-note-key');
		openNote.addEventListener('command', () => this._openReadingNote(win));

		// ZoteroPane rebuilds this menu by index, so appended items survive, but
		// their visibility is ours to manage
		let onPopupShowing = () => {
			let selected = win.ZoteroPane?.getSelectedItems?.() || [];
			let visible = !!ZoteroGitHubSync.Prefs.getConfig().workspacePath && selected.length > 0;
			separator.hidden = !visible;
			openNote.hidden = !visible;
		};
		itemMenu.addEventListener('popupshowing', onPopupShowing);
		elements.push({
			remove: () => {
				itemMenu.removeEventListener('popupshowing', onPopupShowing);
				separator.remove();
				openNote.remove();
			},
		});

		itemMenu.append(separator, openNote);
	},


	_addReadingNoteShortcut(win, elements) {
		let doc = win.document;
		let keyset = doc.getElementById('mainKeyset') || doc.querySelector('keyset');
		if (!keyset) return;
		let key = doc.createXULElement('key');
		key.id = 'zotero-quartz-open-reading-note-key';
		key.setAttribute('key', 'O');
		key.setAttribute('modifiers', 'accel,alt');
		key.addEventListener('command', () => this._openReadingNote(win));
		keyset.append(key);
		elements.push(key);
	},


	/**
	 * The entries shared by the Tools menu and the toolbar dropdown.
	 */
	_menuEntries(win) {
		let entries = [
			{
				id: 'sync-now',
				label: ZoteroGitHubSync.getString('menu.syncNow'),
				command: () => ZoteroGitHubSync.Sync.syncNow({ trigger: 'menu' })
					.catch(e => ZoteroGitHubSync.logError(e)),
			},
			{
				id: 'open-reading-note',
				label: 'Open Reading Note in Obsidian',
				command: () => this._openReadingNote(win),
			},
			{ id: 'separator', separator: true },
			{
				id: 'open-repo',
				label: ZoteroGitHubSync.getString('menu.openRepo'),
				command: () => {
					let config = ZoteroGitHubSync.Prefs.getConfig();
					if (config.workspaceTransport === 'system-git') Zotero.File.reveal(config.workspacePath);
					else {
						let url = ZoteroGitHubSync.Prefs.getRepoURL();
						if (url) Zotero.launchURL(url);
					}
				},
			},
			{
				id: 'settings',
				label: ZoteroGitHubSync.getString('menu.settings'),
				command: () => this._openPreferences(),
			},
		];
		return entries;
	},


	_createMenuItem(doc, entry) {
		if (entry.separator) {
			return doc.createXULElement('menuseparator');
		}
		let menuitem = doc.createXULElement('menuitem');
		menuitem.setAttribute('label', entry.label);
		menuitem.addEventListener('command', entry.command);
		return menuitem;
	},


	// -- Actions -----------------------------------------------------------

	async _openReadingNote(win) {
		try {
			let item = win.ZoteroPane?.getSelectedItems?.()?.[0];
			if (!item) {
				ZoteroGitHubSync.Sync._notify('Select a paper, attachment, or note first.', { error: true });
				return;
			}
			await ZoteroGitHubSync.Workspace.openReadingNote(item);
		}
		catch (e) {
			ZoteroGitHubSync.logError(e);
			ZoteroGitHubSync.Sync._notify(e.message || String(e), { error: true });
		}
	},


	_openPreferences() {
		try {
			Zotero.Utilities.Internal.openPreferences(ZoteroGitHubSync.prefPaneID);
		}
		catch (e) {
			ZoteroGitHubSync.logError(e);
		}
	},
};
