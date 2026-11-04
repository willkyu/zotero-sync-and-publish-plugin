import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const context = vm.createContext({
	Zotero: { locale: 'zh-CN' },
	console,
});

vm.runInContext(readFileSync(`${ROOT}/src/core.js`, 'utf8'), context);
vm.runInContext(readFileSync(`${ROOT}/src/locale-zh-CN.js`, 'utf8'), context);

const plugin = vm.runInContext('ZoteroGitHubSync', context);
assert.equal(plugin.getString('plugin.name'), 'Sync & Publish');
assert.equal(plugin.getString('progress.uploading', 3), '正在上传 3 个文件…');

context.Zotero.locale = 'zh';
assert.equal(plugin.getString('menu.settings'), 'Sync & Publish 设置…');

context.Zotero.locale = 'fr-FR';
assert.equal(plugin.getString('menu.root'), 'Sync & Publish', 'unsupported locales fall back to English');

const xhtml = readFileSync(`${ROOT}/content/preferences.xhtml`, 'utf8');
const keys = [...xhtml.matchAll(/data-zgs-i18n(?:-placeholder)?="([^"]+)"/g)].map(match => match[1]);
const chinese = plugin._strings['zh-CN'];
for (const key of Object.keys(plugin._strings['en-US'])) {
	assert.ok(chinese[key], `missing Simplified Chinese runtime string: ${key}`);
}
for (const key of keys) {
	assert.ok(chinese[key], `missing Simplified Chinese preference string: ${key}`);
}

console.log(`localization tests passed (${new Set(keys).size} preference keys)`);
