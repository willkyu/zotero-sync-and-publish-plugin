/* Local Workspace -- Better Notes adapter and stable Markdown bindings.
 *
 * Better Notes intentionally remains the converter.  This adapter adds the
 * pieces its public API does not provide: cross-computer identities, explicit
 * completion verification, editor-aware deferral, and image byte repair.
 */

ZoteroGitHubSync.BetterNotes = {
	SCHEMA: 1,

	get api() {
		return Zotero.BetterNotes?.api || null;
	},

	get hooks() {
		return Zotero.BetterNotes?.hooks || null;
	},

	available() {
		let api = this.api;
		return !!(api?.sync?.getMDStatus && api?.sync?.getMDFileName && api?.sync?.getSyncStatus
			&& api?.sync?.isSyncNote && api?.sync?.removeSyncNote
			&& api?.convert?.note2md && api?.$import?.fromMD);
	},

	version() {
		return String(Zotero.BetterNotes?.version || Zotero.BetterNotes?.data?.version || 'unknown');
	},

	libraryRef(item) {
		let library = Zotero.Libraries.get(item.libraryID);
		if (library?.libraryType === 'group') {
			let group = Zotero.Groups.getByLibraryID?.(item.libraryID);
			return { type: 'group', groupID: library.groupID || group?.id || group?.groupID || null };
		}
		return { type: 'user' };
	},

	resolveLibrary(ref) {
		if (!ref || ref.type === 'user') return Zotero.Libraries.userLibraryID;
		if (ref.type === 'group' && ref.groupID) {
			try { return Zotero.Groups.get(Number(ref.groupID))?.libraryID || null; }
			catch (e) { return null; }
		}
		return null;
	},

	async resolveItem(ref, key) {
		let libraryID = this.resolveLibrary(ref);
		return libraryID && key
			? await Zotero.Items.getByLibraryAndKeyAsync(libraryID, key)
			: null;
	},

	activeNoteIDs() {
		let ids = new Set();
		for (let editor of this.editorInstances()) {
			try {
				let element = editor._popup?.closest?.('note-editor');
				let visible = element && !element.hidden && element.getClientRects?.().length;
				if (visible && editor._item?.id) ids.add(editor._item.id);
			}
			catch (e) {}
		}
		return ids;
	},

	editorInstances(noteID = null) {
		return (Zotero.Notes?._editorInstances || []).filter(editor => {
			try {
				let win = editor?._iframeWindow;
				return win && !Components.utils.isDeadWrapper(win)
					&& (noteID === null || editor._item?.id === noteID);
			}
			catch (e) { return false; }
		});
	},

	/** Persist pending editor input before handing the note to Obsidian.
	 * Better Notes Markdown mode owns its own debounce queue, so leave that mode
	 * through its public API first. Zotero's rich-text saveSync() is fire-and-
	 * forget; awaiting _save() keeps the Markdown export from racing the save. */
	async flushNoteEditors(noteID) {
		let editors = this.editorInstances(noteID);
		for (let editor of editors) {
			let editorAPI = this.api?.editor;
			if (editorAPI?.isMarkdownMode?.(editor)) {
				await editorAPI.toggleMarkdownMode(editor);
			}
			let win = editor._iframeWindow;
			let noteData = win?.wrappedJSObject?.getDataSync?.(true);
			if (!noteData) continue;
			noteData = JSON.parse(JSON.stringify(noteData));
			if (typeof editor._save === 'function') await editor._save(noteData);
			else editor.saveSync?.();
		}
		return editors.length;
	},

	md5(value) {
		return Zotero.Utilities.Internal.md5(String(value || ''), false);
	},

	relativePosix(fromDir, target) {
		let from = String(fromDir).replace(/\\/g, '/').split('/').filter(Boolean);
		let to = String(target).replace(/\\/g, '/').split('/').filter(Boolean);
		while (from.length && to.length && from[0].toLowerCase() === to[0].toLowerCase()) {
			from.shift(); to.shift();
		}
		return [...from.map(() => '..'), ...to].join('/') || '.';
	},

	readingNoteFilename(parent, note) {
		let title = parent?.getDisplayTitle?.() || parent?.getField?.('title') || 'Untitled';
		title = String(title).replace(/[/\\:*?"<>|]/g, ' ');
		return `${ZoteroGitHubSync.Utils.sanitizeSegment(title, 100)}-${note.key}.md`;
	},

	isPlaceholderReadingNotePath(path) {
		return /^-?[A-Z0-9]{8}\.md$/i.test(String(path || '').split('/').pop() || '');
	},

	async ensureReadableBindingPath(note, parent, binding, config) {
		if (!this.isPlaceholderReadingNotePath(binding.path)) return false;
		let papers = ZoteroGitHubSync.Workspace.resolve(config, config.papersPath);
		let wanted = PathUtils.join(papers, this.readingNoteFilename(parent, note));
		let current = ZoteroGitHubSync.Workspace.resolve(config, binding.path);
		if (current.toLowerCase() === wanted.toLowerCase()) return false;
		if (await IOUtils.exists(wanted)) {
			throw new Error(`Cannot rename the reading note because the target already exists: ${PathUtils.filename(wanted)}`);
		}
		if (await IOUtils.exists(current)) await IOUtils.move(current, wanted, { noOverwrite: true });
		binding.path = ZoteroGitHubSync.Workspace.relative(config, wanted);
		binding.updated = new Date().toISOString();
		let snapshot = await this.snapshot(note, wanted);
		this.register(note, wanted, snapshot);
		return true;
	},

	unsafeMarkdown(markdown) {
		let withoutCode = String(markdown || '').replace(/```[\s\S]*?```|`[^`\n]*`/g, '');
		let reasons = [];
		if (/^\s*[-*+]\s+\[[ xX]\]\s/m.test(withoutCode)) reasons.push('task lists');
		if (/!\[\[[^\]]+\]\]/.test(withoutCode)) reasons.push('Obsidian embeds');
		return reasons;
	},

	requestedCitationKey(meta) {
		if (!meta || !Object.prototype.hasOwnProperty.call(meta, 'citation-key')) return null;
		let key = String(meta['citation-key'] ?? '').trim();
		if (!key) return null;
		if (/\s|[{},]/u.test(key)) throw new Error('citation-key cannot contain whitespace, commas, or braces.');
		return key;
	},

	async coordinateCitationKey(parent, meta) {
		let wanted;
		try { wanted = this.requestedCitationKey(meta); }
		catch (e) { return { status: 'invalid-citation-key', pending: 1, warnings: [e.message] }; }
		if (!wanted) return { changed: false };
		if (!Zotero.ItemFields?.getID?.('citationKey')) {
			return { status: 'unsupported-citation-key', pending: 1, warnings: ['This Zotero version has no native citationKey field.'] };
		}
		let current = String(parent.getField('citationKey') || '').trim();
		if (current === wanted) return { changed: false };
		let search = new Zotero.Search();
		search.libraryID = parent.libraryID;
		search.addCondition('citationKey', 'is', wanted);
		let duplicates = (await search.search()).filter(id => id !== parent.id);
		if (duplicates.length) {
			return {
				status: 'citation-key-conflict', pending: 1,
				warnings: [`citation-key “${wanted}” is already used by another item in this library.`],
			};
		}
		parent.setField('citationKey', wanted);
		await parent.saveTx();
		if (String(parent.getField('citationKey') || '').trim() !== wanted) {
			return { status: 'citation-key-not-saved', pending: 1, warnings: [`Zotero did not retain citation-key “${wanted}”.`] };
		}
		return { changed: true };
	},

	templateValues(parent, note) {
		let creators = parent.getCreators?.() || [];
		let creatorNames = creators.map(creator => creator.name
			|| [creator.firstName, creator.lastName].filter(Boolean).join(' ')).filter(Boolean);
		let authorNames = creators.filter(creator => {
			try { return Zotero.CreatorTypes.getName(creator.creatorTypeID) === 'author'; }
			catch (e) { return true; }
		}).map(creator => creator.name
			|| [creator.firstName, creator.lastName].filter(Boolean).join(' ')).filter(Boolean);
		if (!authorNames.length) authorNames = creatorNames;
		let tags = (parent.getTags?.() || []).map(tag => tag.tag).filter(Boolean);
		let collections = (parent.getCollections?.() || []).map(id => {
			try { return Zotero.Collections.get(id)?.name || ''; }
			catch (e) { return ''; }
		}).filter(Boolean);
		let field = name => {
			try { return String(parent.getField?.(name) || ''); }
			catch (e) { return ''; }
		};
		let bibliographicDate = field('date');
		let extra = field('extra');
		let citationKey = field('citationKey') || extra.match(/^Citation Key:\s*(.+)$/mi)?.[1]?.trim() || '';
		let today = new Date().toISOString();
		let title = parent.getDisplayTitle?.() || field('title');
		let shortTitle = field('shortTitle');
		return {
			title,
			titleYaml: JSON.stringify(title),
			shortTitle,
			shortTitleYaml: JSON.stringify(shortTitle),
			creators: creatorNames.join('; '),
			authors: authorNames.join('; '),
			firstAuthor: authorNames[0] || '',
			creatorsYaml: JSON.stringify(creatorNames),
			authorsYaml: JSON.stringify(authorNames),
			tags: tags.join(', '),
			tagsYaml: JSON.stringify(tags),
			collections: collections.join('; '),
			collectionsYaml: JSON.stringify(collections),
			date: bibliographicDate,
			dateYaml: JSON.stringify(bibliographicDate),
			year: bibliographicDate.match(/\d{4}/)?.[0] || '',
			today: today.slice(0, 10),
			now: today,
			itemType: parent.itemType || '',
			itemKey: parent.key || '',
			noteKey: note?.key || '',
			citationKey,
			citationKeyYaml: JSON.stringify(citationKey),
			zoteroURI: Zotero.URI?.getItemURI?.(parent) || '',
		};
	},

	formatTemplateDate(format, date = new Date()) {
		if (!/^(?:(?:YYYY|YY|MM|DD|HH|mm|ss)|[^A-Za-z])+$/.test(format)) {
			throw new Error(`Unsupported reading-note date format: ${format}`);
		}
		let pad = value => String(value).padStart(2, '0');
		let tokens = {
			YYYY: String(date.getFullYear()), YY: String(date.getFullYear()).slice(-2),
			MM: pad(date.getMonth() + 1), DD: pad(date.getDate()),
			HH: pad(date.getHours()), mm: pad(date.getMinutes()), ss: pad(date.getSeconds()),
		};
		return format.replace(/YYYY|YY|MM|DD|HH|mm|ss/g, token => tokens[token]);
	},

	renderTemplate(markdown, parent, note) {
		let values = this.templateValues(parent, note);
		let unknown = new Set();
		let rendered = String(markdown || '').replace(/\{\{\s*date:([^{}\n]+?)\s*\}\}/g,
			(match, format) => this.formatTemplateDate(format.trim()));
		rendered = rendered.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_-]*)\s*\}\}/g, (match, name) => {
			if (Object.prototype.hasOwnProperty.call(values, name)) return values[name];
			try {
				if (Zotero.ItemFields?.getID?.(name)) return String(parent.getField(name) || '');
			}
			catch (e) {}
			unknown.add(name);
			return match;
		});
		for (let match of rendered.matchAll(/\{\{\s*([^{}\n]+?)\s*\}\}/g)) unknown.add(match[1].trim());
		if (unknown.size) throw new Error(`Unknown reading-note template variable(s): ${[...unknown].join(', ')}`);
		return rendered;
	},

	noteIsEmpty(note) {
		let html = String(note?.getNote?.() || '');
		if (/<(?:img|svg|math|table|ul|ol|li|blockquote|pre|iframe|object|embed)\b/i.test(html)) return false;
		let text = html.replace(/<!--[^]*?-->/g, '').replace(/<[^>]+>/g, '')
			.replace(/&nbsp;|&#160;|\s/gi, '');
		return !text;
	},

	async applyTemplate(note, parent, templatePath) {
		let source = await Zotero.File.getContentsAsync(templatePath, 'utf-8');
		let rendered = this.renderTemplate(source, parent, note);
		let suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
		let renderedPath = PathUtils.join(PathUtils.parent(templatePath), `.zqws-template-${note.key}-${suffix}.md`);
		let tmpPath = `${renderedPath}.tmp`;
		try {
			await IOUtils.write(renderedPath, new TextEncoder().encode(rendered), { tmpPath });
			let templateStatus = await this.api.sync.getMDStatus(renderedPath);
			let imported = await this.api.$import.fromMD(renderedPath, { noteId: note.id, ignoreVersion: true });
			if (!imported) throw new Error('Better Notes did not import the rendered reading-note template.');
			return { meta: templateStatus.meta, content: templateStatus.content };
		}
		finally {
			await IOUtils.remove(tmpPath, { ignoreAbsent: true });
			await IOUtils.remove(renderedPath, { ignoreAbsent: true });
		}
	},

	withMarkdownBody(exported, content) {
		let match = String(exported || '').match(/^---\r?\n[^]*?\r?\n---(?:\r?\n)?/);
		if (!match) return String(content || '');
		let header = match[0].replace(/\r\n/g, '\n').replace(/\n+$/, '');
		let body = String(content || '').replace(/\r\n/g, '\n');
		return `${header}${body.startsWith('\n') ? '' : '\n'}${body}`;
	},

	async preserveTemplateBody(absolutePath, content) {
		let exported = await Zotero.File.getContentsAsync(absolutePath, 'utf-8');
		let combined = this.withMarkdownBody(exported, content);
		let tmpPath = `${absolutePath}.zqws-tmp`;
		await IOUtils.remove(tmpPath, { ignoreAbsent: true });
		await IOUtils.write(absolutePath, new TextEncoder().encode(combined), { tmpPath });
	},

	async repairEmptyTemplateBinding(note, parent, binding, config) {
		if (!this.noteIsEmpty(note) || !config.noteTemplatePath
			|| !await IOUtils.exists(config.noteTemplatePath)) return false;
		let absolutePath = ZoteroGitHubSync.Workspace.resolve(config, binding.path);
		if (await IOUtils.exists(absolutePath)) {
			let status = await this.api.sync.getMDStatus(absolutePath);
			if (String(status.content || '').trim()) return false;
		}
		let template = await this.applyTemplate(note, parent, config.noteTemplatePath);
		await this.exportNote(note, absolutePath, template.meta);
		await this.preserveTemplateBody(absolutePath, template.content);
		let snapshot = await this.snapshot(note, absolutePath);
		binding.md5 = snapshot.md5;
		binding.noteMd5 = snapshot.noteMd5;
		binding.noteVersion = note.version;
		binding.updated = new Date().toISOString();
		return true;
	},

	async recreateDeletedBinding(parent, binding, config) {
		let note = new Zotero.Item('note');
		note.libraryID = parent.libraryID;
		note.parentID = parent.id;
		note.setNote('<div data-schema-version="9"><p></p></div>');
		await note.saveTx();
		let absolutePath = ZoteroGitHubSync.Workspace.resolve(config, binding.path);
		try {
			let existing = await IOUtils.exists(absolutePath)
				? await this.api.sync.getMDStatus(absolutePath) : null;
			if (String(existing?.content || '').trim()) {
				let imported = await this.api.$import.fromMD(absolutePath, { noteId: note.id, ignoreVersion: true });
				if (!imported) throw new Error('Better Notes did not restore the deleted reading note from Markdown.');
				await this.exportNote(note, absolutePath, existing.meta || {});
				await this.preserveTemplateBody(absolutePath, existing.content);
			}
			else if (config.noteTemplatePath && await IOUtils.exists(config.noteTemplatePath)) {
				let template = await this.applyTemplate(note, parent, config.noteTemplatePath);
				await this.exportNote(note, absolutePath, template.meta);
				await this.preserveTemplateBody(absolutePath, template.content);
			}
			else {
				await this.exportNote(note, absolutePath, existing?.meta || null);
			}
			let snapshot = await this.snapshot(note, absolutePath);
			binding.noteKey = note.key;
			binding.md5 = snapshot.md5;
			binding.noteMd5 = snapshot.noteMd5;
			binding.noteVersion = note.version;
			binding.images = [];
			binding.updated = new Date().toISOString();
			await this.coordinateImages(binding, note, config);
			this.register(note, absolutePath, snapshot);
			return note;
		}
		catch (e) {
			note.deleted = true;
			await note.saveTx();
			throw e;
		}
	},

	async snapshot(note, absolutePath) {
		let exists = await IOUtils.exists(absolutePath);
		let md = exists ? await this.api.sync.getMDStatus(absolutePath) : null;
		return {
			exists,
			md,
			md5: md ? this.md5(md.content) : '',
			noteMd5: this.md5(note.getNote()),
		};
	},

	register(note, absolutePath, hashes) {
		// Managed notes use this adapter's shared stable-key binding instead of
		// Better Notes' machine-local numeric-ID scheduler. Leaving both enabled
		// would allow two background tasks to rewrite the same Markdown file.
		if (this.api.sync.isSyncNote(note.id)) this.api.sync.removeSyncNote(note.id);
	},

	async exportNote(note, absolutePath, cachedMeta = null) {
		await IOUtils.makeDirectory(PathUtils.parent(absolutePath), { ignoreExisting: true });
		let content = await this.api.convert.note2md(note, PathUtils.parent(absolutePath), {
			keepNoteLink: false,
			withYAMLHeader: true,
			cachedYAMLHeader: cachedMeta || undefined,
			// Image bytes are coordinated separately into config.assetsPath. This
			// avoids Better Notes' global attachment folder creating a second copy.
			skipSavingImages: true,
		});
		let tmpPath = `${absolutePath}.zqws-tmp`;
		await IOUtils.remove(tmpPath, { ignoreAbsent: true });
		await IOUtils.write(absolutePath, new TextEncoder().encode(content), { tmpPath });
		let snapshot = await this.snapshot(note, absolutePath);
		this.register(note, absolutePath, snapshot);
		return snapshot;
	},

	async copyAtomic(source, target) {
		let bytes = await IOUtils.read(source);
		await IOUtils.makeDirectory(PathUtils.parent(target), { ignoreExisting: true });
		let tmpPath = `${target}.zqws-tmp`;
		await IOUtils.remove(tmpPath, { ignoreAbsent: true });
		await IOUtils.write(target, bytes, { tmpPath });
	},

	async fileHash(path) {
		if (!path || !await IOUtils.exists(path)) return '';
		return ZoteroGitHubSync.Files.hashFile(path, 'lfs');
	},

	/** Repair an attachment whose Zotero row exists but storage bytes do not,
	 * and detect byte changes even when the filename stayed the same. */
	async coordinateImages(binding, note, config) {
		if (!config.includeNoteImagesLocal) return { pending: [], changed: false };
		let pending = [];
		let changed = false;
		let previous = new Map((binding.images || []).map(image => [image.attachmentKey, image]));
		let images = [];
		let attachments = Zotero.Items.get(note.getAttachments(false) || []);
		let keys = new Set([...attachments.map(a => a?.key).filter(Boolean), ...previous.keys()]);

		for (let key of keys) {
			let attachment = attachments.find(a => a?.key === key)
				|| await Zotero.Items.getByLibraryAndKeyAsync(note.libraryID, key);
			let old = previous.get(key) || {};
			let repositoryPath = old.path || '';
			let storagePath = attachment ? await attachment.getFilePathAsync() : '';
			if (!storagePath && attachment) {
				let filename = attachment.attachmentFilename || PathUtils.filename(repositoryPath || `${key}.png`);
				storagePath = PathUtils.join(Zotero.Attachments.getStorageDirectory(attachment).path, filename);
			}
			let extension = (PathUtils.filename(storagePath || repositoryPath).match(/\.[^.]+$/)?.[0] || '.png').toLowerCase();
			if (!repositoryPath) repositoryPath = `${config.assetsPath}/${key}${extension}`;
			let assetPath;
			try { assetPath = ZoteroGitHubSync.Workspace.resolve(config, repositoryPath); }
			catch (e) { pending.push(`${key}: invalid image path`); continue; }

			let storageHash = await this.fileHash(storagePath);
			let assetHash = await this.fileHash(assetPath);
			let baseHash = old.hash || '';
			let storageChanged = !!baseHash && !!storageHash && storageHash !== baseHash;
			let assetChanged = !!baseHash && !!assetHash && assetHash !== baseHash;
			if (storageChanged && assetChanged && storageHash !== assetHash) {
				pending.push(`${key}: image changed in Zotero and workspace`);
				continue;
			}
			if (assetHash && (!storageHash || (assetChanged && !storageChanged))) {
				if (!attachment) {
					pending.push(`${key}: image file exists but attachment identity is missing`);
					continue;
				}
				await this.copyAtomic(assetPath, storagePath);
				storageHash = assetHash;
				changed = true;
			}
			else if (storageHash && (!assetHash || storageHash !== assetHash)) {
				await this.copyAtomic(storagePath, assetPath);
				assetHash = storageHash;
				changed = true;
			}
			if (!storageHash && !assetHash) {
				pending.push(`${key}: image attachment exists but both files are missing`);
				continue;
			}
			images.push({ attachmentKey: key, path: repositoryPath, hash: storageHash || assetHash });
		}
		binding.images = images.sort((a, b) => a.attachmentKey.localeCompare(b.attachmentKey));
		return { pending, changed };
	},

	async rewriteImageLinks(binding, absolutePath, config) {
		if (!await IOUtils.exists(absolutePath) || !binding.images?.length) return false;
		let markdown = await Zotero.File.getContentsAsync(absolutePath, 'utf-8');
		let original = markdown;
		let fromDir = binding.path.split('/').slice(0, -1).join('/');
		for (let image of binding.images) {
			let wanted = this.relativePosix(fromDir, image.path);
			let key = image.attachmentKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			let pattern = new RegExp(`(!\\[[^\\]]*\\]\\()([^)]*${key}[^)]*)(\\))`, 'gi');
			markdown = markdown.replace(pattern, `$1${wanted}$3`);
		}
		if (markdown === original) return false;
		let tmpPath = `${absolutePath}.zqws-tmp`;
		await IOUtils.remove(tmpPath, { ignoreAbsent: true });
		await IOUtils.write(absolutePath, new TextEncoder().encode(markdown), { tmpPath });
		return true;
	},

	async coordinate(binding, config, options = {}) {
		let note = await this.resolveItem(binding.library, binding.noteKey);
		let parent = await this.resolveItem(binding.library, binding.parentKey);
		if (!parent || parent.deleted) return { status: 'waiting-identity', pending: 1 };
		let absolutePath = ZoteroGitHubSync.Workspace.resolve(config, binding.path);
		let fileExists = await IOUtils.exists(absolutePath);
		if (!note?.isNote?.() || note.deleted) {
			let md = fileExists ? await this.api.sync.getMDStatus(absolutePath) : null;
			let fileChanged = !!md && this.md5(md.content) !== binding.md5;
			return {
				status: fileExists ? 'zotero-note-deleted' : 'reading-note-deleted-both',
				pending: 1, deletion: { side: fileExists ? 'zotero' : 'both', changed: fileChanged },
				warnings: [fileExists
					? `${binding.path}: Zotero note was deleted${fileChanged ? ' while Markdown also changed' : ''}; run manual Sync now to confirm deletion.`
					: `${binding.path}: Zotero note and Markdown are both absent; run manual Sync now to remove the stale binding.`],
			};
		}

		let before = await this.snapshot(note, absolutePath);
		if (!before.exists) {
			if (!options.restoreMissingMarkdown) {
				let noteChanged = before.noteMd5 !== binding.noteMd5;
				return {
					status: 'markdown-deleted', pending: 1,
					deletion: { side: 'markdown', changed: noteChanged },
					warnings: [`${binding.path}: Markdown was deleted${noteChanged ? ' while the Zotero note also changed' : ''}; run manual Sync now to confirm deletion.`],
				};
			}
			if (!options.allowVisibleEditor && this.activeNoteIDs().has(note.id)) return { status: 'editing', pending: 1 };
			await this.exportNote(note, absolutePath);
		}
		let imageResult = await this.coordinateImages(binding, note, config);
		if (imageResult.pending.length) return { status: 'image-conflict', pending: 1, warnings: imageResult.pending };

		before = await this.snapshot(note, absolutePath);
		let citationResult = await this.coordinateCitationKey(parent, before.md?.meta);
		if (citationResult.pending) return citationResult;
		if (!binding.md5 && !binding.noteMd5) {
			// A recovered shared binding is itself the trusted coordination record.
			binding.md5 = before.md5;
			binding.noteMd5 = before.noteMd5;
			this.register(note, absolutePath, before);
			return { status: 'bound', pending: 0 };
		}
		let mdChanged = before.md5 !== binding.md5;
		let noteChanged = before.noteMd5 !== binding.noteMd5;
		if (mdChanged && noteChanged) return { status: 'conflict', pending: 1 };
		if (!options.allowVisibleEditor && (mdChanged || noteChanged) && this.activeNoteIDs().has(note.id)) {
			return { status: 'editing', pending: 1 };
		}
		let unsafe = (mdChanged || noteChanged) ? this.unsafeMarkdown(before.md?.content || '') : [];
		if (noteChanged && unsafe.length) {
			return { status: 'unsupported-markdown', pending: 1, warnings: [`${binding.path}: Zotero changes cannot overwrite external-only ${unsafe.join(', ')}`] };
		}

		this.register(note, absolutePath, { md5: binding.md5, noteMd5: binding.noteMd5 });
		if (mdChanged) {
			// The binding hashes already established that only Markdown changed.
			// Calling onSyncing() here would also compare Zotero's machine-local
			// version number and can manufacture a false two-sided conflict after
			// cross-computer restore. Use Better Notes' public converter APIs with
			// the cached YAML, then verify their recorded hashes below.
			let imported = await this.api.$import.fromMD(absolutePath, { noteId: note.id, ignoreVersion: true });
			if (!imported) {
				return { status: 'not-complete', pending: 1, warnings: [`${binding.path}: Better Notes did not complete Markdown import`] };
			}
			// Task boxes and Obsidian embeds have no lossless Zotero representation.
			// Import the best-effort native copy, but keep the external Markdown as
			// the authority instead of exporting the simplified HTML back over it.
			if (!unsafe.length) await this.exportNote(note, absolutePath, before.md?.meta || {});
		}
		else if (noteChanged) {
			await this.exportNote(note, absolutePath, before.md?.meta || {});
		}
		let converted = await this.snapshot(note, absolutePath);
		if (!converted.exists || (noteChanged && converted.noteMd5 !== before.noteMd5)) {
			return { status: 'not-complete', pending: 1, warnings: [`${binding.path}: Better Notes conversion did not produce the expected note/file state`] };
		}
		await this.coordinateImages(binding, note, config);
		await this.rewriteImageLinks(binding, absolutePath, config);
		let after = await this.snapshot(note, absolutePath);
		binding.md5 = after.md5;
		binding.noteMd5 = after.noteMd5;
		binding.noteVersion = note.version;
		binding.updated = new Date().toISOString();
		this.register(note, absolutePath, after);
		return {
			status: mdChanged && unsafe.length ? 'imported-markdown-external-syntax'
				: mdChanged ? 'imported-markdown'
				: noteChanged ? 'exported-note'
					: citationResult.changed ? 'updated-citation-key' : 'up-to-date',
			pending: 0,
			warnings: mdChanged && unsafe.length
				? [`${binding.path}: kept ${unsafe.join(', ')} in Markdown; Zotero contains a simplified representation.`] : [],
		};
	},

	async resolveDeletion(binding, result, config) {
		let note = await this.resolveItem(binding.library, binding.noteKey);
		let absolutePath = ZoteroGitHubSync.Workspace.resolve(config, binding.path);
		let changed = result.deletion.changed
			? '\n\nThe other side also changed after the last successful sync. Confirming will discard that remaining copy.' : '';
		let message = result.deletion.side === 'zotero'
			? `The Zotero reading note was deleted. Also delete its Markdown file?${changed}`
			: result.deletion.side === 'markdown'
				? `The Markdown reading note was deleted. Also move its Zotero note to Trash?${changed}`
				: 'The Zotero note and Markdown file are both absent. Remove their stale binding?';
		if (!Zotero.getMainWindow()?.confirm(message)) return result;
		if (result.deletion.side === 'zotero') {
			await IOUtils.remove(absolutePath, { ignoreAbsent: true });
		}
		else if (result.deletion.side === 'markdown' && note?.isNote?.() && !note.deleted) {
			note.deleted = true;
			await note.saveTx();
		}
		return { status: 'deleted-reading-note', pending: 0, removeBinding: true, warnings: [] };
	},

	async coordinateAll(bindings, config, options = {}) {
		if (!this.available()) {
			return { pending: bindings.length, warnings: bindings.length ? ['Better Notes 3.3.x is not installed or its public API is unavailable.'] : [], results: [] };
		}
		let results = [];
		let warnings = [];
		let removed = new Set();
		for (let binding of bindings) {
			try {
				let result = await this.coordinate(binding, config);
				if (result.deletion && options.confirmDeletions) {
					result = await this.resolveDeletion(binding, result, config);
				}
				if (result.removeBinding) removed.add(binding);
				results.push({ path: binding.path, ...result });
				warnings.push(...(result.warnings || []));
			}
			catch (e) {
				results.push({ path: binding.path, status: 'error', pending: 1 });
				warnings.push(`${binding.path}: ${e.message || e}`);
			}
		}
		if (removed.size) {
			bindings.splice(0, bindings.length, ...bindings.filter(binding => !removed.has(binding)));
		}
		return { results, warnings, pending: results.reduce((n, r) => n + (r.pending || 0), 0) };
	},

	async discoverBindings(bindings, config) {
		if (!this.available()) return { added: 0, warnings: [] };
		let warnings = [];
		let added = 0;
		let knownNotes = new Set(bindings.map(b => `${JSON.stringify(b.library)}:${b.noteKey}`));
		let knownPaths = new Set(bindings.map(b => b.path.toLowerCase()));
		let add = async (note, absolutePath) => {
			let parent = note?.parentItem;
			if (!note?.isNote?.() || note.deleted || !parent?.isRegularItem?.() || parent.deleted) return;
			let path;
			try { path = ZoteroGitHubSync.Workspace.relative(config, absolutePath); }
			catch (e) { return; }
			if (!(path === config.papersPath || path.startsWith(`${config.papersPath}/`))) return;
			let identity = `${JSON.stringify(this.libraryRef(note))}:${note.key}`;
			if (knownNotes.has(identity) || knownPaths.has(path.toLowerCase())) return;
			let snapshot = await this.snapshot(note, absolutePath);
			if (!snapshot.exists) return;
			let binding = {
				library: this.libraryRef(parent), parentKey: parent.key, noteKey: note.key, path,
				md5: snapshot.md5, noteMd5: snapshot.noteMd5, noteVersion: note.version,
				images: [], updated: new Date().toISOString(),
			};
			await this.coordinateImages(binding, note, config);
			this.register(note, absolutePath, snapshot);
			bindings.push(binding); knownNotes.add(identity); knownPaths.add(path.toLowerCase()); added++;
		};

		// Adopt existing Better Notes sync registrations that point inside this
		// project, without changing their files.
		for (let id of await this.api.sync.getSyncNoteIds()) {
			let note = Zotero.Items.get(id);
			let status = this.api.sync.getSyncStatus(id);
			if (note && status.path && status.filename) await add(note, PathUtils.join(status.path, status.filename));
		}

		// Fallback for a restored repository whose shared binding file was lost.
		// $itemKey is a note key; ignore $libraryID because numeric IDs differ by
		// computer and search editable libraries by stable key instead.
		let papers = ZoteroGitHubSync.Workspace.resolve(config, config.papersPath);
		for (let file of await ZoteroGitHubSync.Workspace.listFiles(papers)) {
			if (!/\.md$/i.test(file.path) || knownPaths.has(`${config.papersPath}/${file.path}`.toLowerCase())) continue;
			let md = await this.api.sync.getMDStatus(file.absolute);
			let key = md.meta?.$itemKey;
			if (!/^[A-Z0-9]{8}$/.test(key || '')) continue;
			let candidates = [];
			for (let library of Zotero.Libraries.getAll()) {
				let note = await Zotero.Items.getByLibraryAndKeyAsync(library.libraryID, key);
				if (note?.isNote?.() && note.parentItem?.isRegularItem?.()) candidates.push(note);
			}
			if (candidates.length === 1) await add(candidates[0], file.absolute);
			else if (candidates.length > 1) warnings.push(`${file.path}: note key is ambiguous across libraries`);
		}
		return { added, warnings };
	},

	async createBinding(note, parent, config, bindings, template = null) {
		let papers = ZoteroGitHubSync.Workspace.resolve(config, config.papersPath);
		await IOUtils.makeDirectory(papers, { ignoreExisting: true });
		let filename = this.readingNoteFilename(parent, note);
		let absolutePath = PathUtils.join(papers, filename);
		if (await IOUtils.exists(absolutePath)) {
			throw new Error(`A reading-note file already exists for the new note: ${filename}`);
		}
		await this.exportNote(note, absolutePath, template?.meta || null);
		if (template) await this.preserveTemplateBody(absolutePath, template.content);
		let path = ZoteroGitHubSync.Workspace.relative(config, absolutePath);
		let snapshot = await this.snapshot(note, absolutePath);
		let binding = {
			library: this.libraryRef(parent),
			parentKey: parent.key,
			noteKey: note.key,
			path,
			md5: snapshot.md5,
			noteMd5: snapshot.noteMd5,
			noteVersion: note.version,
			images: [],
			updated: new Date().toISOString(),
		};
		await this.coordinateImages(binding, note, config);
		await this.rewriteImageLinks(binding, absolutePath, config);
		let after = await this.snapshot(note, absolutePath);
		binding.md5 = after.md5;
		this.register(note, absolutePath, after);
		bindings.push(binding);
		return binding;
	},

	parentFor(item) {
		let current = item;
		for (let i = 0; current && i < 4; i++) {
			if (current.isRegularItem?.()) return current;
			current = current.parentItem || (current.parentID ? Zotero.Items.get(current.parentID) : null);
		}
		return null;
	},

	async recoverBinding(parent, config, bindings) {
		let papers = ZoteroGitHubSync.Workspace.resolve(config, config.papersPath);
		let matches = [];
		for (let file of await ZoteroGitHubSync.Workspace.listFiles(papers)) {
			if (!/\.md$/i.test(file.path)) continue;
			let md = await this.api.sync.getMDStatus(file.absolute);
			let noteKey = md.meta?.$itemKey;
			if (!/^[A-Z0-9]{8}$/.test(noteKey || '')) continue;
			let note = await Zotero.Items.getByLibraryAndKeyAsync(parent.libraryID, noteKey);
			if (!note?.isNote?.() || note.deleted || note.parentID !== parent.id) continue;
			matches.push({ file, md, note });
		}
		if (matches.length > 1) throw new Error('Multiple Markdown files claim notes under this item. Resolve the ambiguity before binding.');
		if (!matches.length) return null;
		let { file, md, note } = matches[0];
		let binding = {
			library: this.libraryRef(parent), parentKey: parent.key, noteKey: note.key,
			path: ZoteroGitHubSync.Workspace.relative(config, file.absolute),
			md5: this.md5(md.content), noteMd5: this.md5(note.getNote()), noteVersion: note.version,
			images: [], updated: new Date().toISOString(),
		};
		this.register(note, file.absolute, binding);
		bindings.push(binding);
		return binding;
	},

	async openReadingNote(item, config, data) {
		if (!this.available()) throw new Error('Better Notes 3.3.x is required.');
		let parent = this.parentFor(item);
		if (!parent) throw new Error('Select a bibliographic item, one of its attachments, or one of its notes.');
		let bindings = data.bindings;
		let binding = bindings.find(b => b.parentKey === parent.key
			&& JSON.stringify(b.library) === JSON.stringify(this.libraryRef(parent)));
		if (!binding) binding = await this.recoverBinding(parent, config, bindings);
		let note = binding ? await this.resolveItem(binding.library, binding.noteKey) : null;

		if (!binding) {
			let notes = Zotero.Items.get(parent.getNotes(false) || []).filter(n => n?.isNote?.() && !n.deleted);
			if (notes.length > 1) throw new Error('This item has multiple notes and no binding. Bind one explicitly before opening to avoid duplicates.');
			note = notes[0] || null;
			let template = null;
			let createdNote = false;
			if (!note) {
				note = new Zotero.Item('note');
				note.libraryID = parent.libraryID;
				note.parentID = parent.id;
				note.setNote('<div data-schema-version="9"><p></p></div>');
				await note.saveTx();
				createdNote = true;
			}
			if (this.noteIsEmpty(note) && config.noteTemplatePath && await IOUtils.exists(config.noteTemplatePath)) {
				try {
					template = await this.applyTemplate(note, parent, config.noteTemplatePath);
				}
				catch (e) {
					if (createdNote) {
						// Do not leave a new blank note that would suppress the template
						// on the next attempt. Keep the failed note recoverable in Trash.
						note.deleted = true;
						await note.saveTx();
					}
					throw e;
				}
			}
			binding = await this.createBinding(note, parent, config, bindings, template);
			await data.save();
		}
		else {
			if (!note?.isNote?.() || note.deleted) {
				note = await this.recreateDeletedBinding(parent, binding, config);
				await data.save();
			}
			else if (await this.repairEmptyTemplateBinding(note, parent, binding, config)) {
				await data.save();
			}
		}
		if (await this.ensureReadableBindingPath(note, parent, binding, config)) await data.save();
		await this.flushNoteEditors(note.id);
		let absolute = ZoteroGitHubSync.Workspace.resolve(config, binding.path);
		// A note selected in Zotero is displayed in a live right-hand editor.
		// Its pending input was flushed above, so that display alone must not
		// prevent coordination of the Markdown file that is about to be opened.
		let result = await this.coordinate(binding, config, { allowVisibleEditor: true, restoreMissingMarkdown: true });
		if (result.pending) throw new Error(`Reading note is not ready: ${result.status}`);
		await data.save();
		let uri = ZoteroGitHubSync.Workspace.obsidianURI(config, absolute);
		Zotero.launchURL(uri);
		return { binding, uri };
	},
};
