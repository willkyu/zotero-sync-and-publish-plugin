/* Obsidian protocol permission preferences.
 *
 * Zotero 8 moved external-protocol confirmation from the old global security
 * preference to per-scheme network preferences. Keep this adapter separate so
 * the preference pane always reflects Zotero's actual state.
 */

ZoteroGitHubSync.Obsidian = {
	LEGACY_PERMISSION_PREF: 'security.external_protocol_requires_permission',
	EXTERNAL_PREF: 'network.protocol-handler.external.obsidian',
	WARNING_PREF: 'network.protocol-handler.warn-external.obsidian',

	majorVersion(version = Zotero.version) {
		let match = String(version || '').match(/^(\d+)/);
		return match ? Number(match[1]) : 0;
	},

	usesSchemePreferences(version = Zotero.version) {
		return this.majorVersion(version) >= 8;
	},

	askBeforeOpen(version = Zotero.version) {
		let key = this.usesSchemePreferences(version)
			? this.WARNING_PREF
			: this.LEGACY_PERMISSION_PREF;
		return Services.prefs.getBoolPref(key, true);
	},

	setAskBeforeOpen(ask, version = Zotero.version) {
		ask = !!ask;
		if (this.usesSchemePreferences(version)) {
			// Mark obsidian:// as an external protocol and control only its warning.
			Services.prefs.setBoolPref(this.EXTERNAL_PREF, true);
			Services.prefs.setBoolPref(this.WARNING_PREF, ask);
			return { ask, scope: 'obsidian', version: this.majorVersion(version) };
		}
		// Zotero 7 and older expose only a global external-protocol permission.
		Services.prefs.setBoolPref(this.LEGACY_PERMISSION_PREF, ask);
		return { ask, scope: 'all-external-protocols', version: this.majorVersion(version) };
	},
};
