/**
 * 记忆管理 (Memory) —— Host 半侧。
 *
 * 给智能体一个**跟着工作区走**的记忆库：默认落在会话工作目录下的 `./memory/`，
 * 根目录放一个 `MEMORY.md` 索引，其余记忆按需要分到子目录、或直接写在根目录下。
 *
 *   <会话工作目录>/memory/
 *   ├── MEMORY.md              ← 索引，由本插件自动生成
 *   ├── 用-pnpm-而不是-npm.md   ← 无需分类的，直接写根目录
 *   └── 项目约定/
 *       └── 提交信息用中文.md
 *
 * 关键设计：
 *   - **工作目录来自 `exec.agent.session.header.cwd`**，所以每个工作区记忆互相隔离；
 *   - **索引是「投影」不是「账本」**：MEMORY.md 每次都从磁盘上的记忆文件重新生成，
 *     因此永远不会和实际内容漂移；
 *   - **写入路径强制锁在记忆根目录内**，`..`、绝对路径、非法字符一律拒绝；
 *   - 刻意不静态 import 任何 @deepseek-ai/* 同伴包。
 *
 * @module dsh-bundle-memory
 */
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

/** 宿主侧 entry 名。 */
const name = 'memory';
/** 包名：状态目录与面板路由都以它为根。 */
const pkg = 'dsh-bundle-memory';
/**
 * 硬依赖声明。Cordis 的 ctx 是受限代理 —— 读未声明在 inject 里的属性会抛错
 * （`cannot get property "webServer" without inject`），而不是返回 undefined。
 */
const inject = ['tools', 'webServer'];

/* ------------------------------------------------------------------ */
/* 配置契约                                                            */
/* ------------------------------------------------------------------ */

const DEFAULTS = {
	/** 总开关：关闭后不注册任何工具。 */
	enabled: true,
	/** 记忆根目录，相对于会话工作目录。 */
	root: 'memory',
	/** 索引文件名（位于记忆根目录下）。 */
	indexFile: 'MEMORY.md',
	/** 每次保存/删除后自动重写索引。 */
	autoIndex: true,
	/** 单条记忆正文上限（字节）。 */
	maxEntryBytes: 262144,
	/** memory_search 默认返回条数上限。 */
	searchMaxResults: 20,
};

const ROOT_MAX_SEGMENTS = 3;
const ENTRY_MIN_BYTES = 1024;
const ENTRY_MAX_BYTES = 4 * 1024 * 1024;
const SEARCH_MIN = 1;
const SEARCH_MAX = 100;
/** 扫描记忆时的最大递归深度（相对记忆根目录）。 */
const SCAN_MAX_DEPTH = 4;
/** 单个文件读进来做搜索的上限，避免拿一个巨无霸文件把内存打爆。 */
const SEARCH_READ_LIMIT = 1024 * 1024;

const str = (value, fallback = '') => (typeof value === 'string' ? value.trim() : fallback);
const clampInt = (value, fallback, min, max) => {
	const parsed = typeof value === 'number' && Number.isFinite(value) ? value : Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(Math.max(Math.round(parsed), min), max);
};

/**
 * Windows 保留设备名，不能作为文件名（带扩展名也不行）。
 * 大小写不敏感，且 `CON.md` 同样是保留的。
 */
const WINDOWS_RESERVED = new Set([
	'con', 'prn', 'aux', 'nul',
	...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
	...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/** 文件名里绝不能出现的字符：路径分隔符 + Windows 非法字符 + 控制字符。 */
// eslint-disable-next-line no-control-regex
const ILLEGAL_IN_NAME = /[\\/:*?"<>|\u0000-\u001f]/;

/**
 * 校验并归一化一个路径片段（目录名或文件名主体）。
 * 这是写入路径的唯一闸门：拒绝 `..`、绝对路径、非法字符、保留名、超长。
 * @param {unknown} raw - 原始片段。
 * @param {string} label - 出错时的字段名。
 * @returns {string} 安全的片段。
 * @throws {Error} 片段不可用时。
 */
function safeSegment(raw, label) {
	const text = str(raw);
	if (text === '') throw new Error(`${label} 不能为空`);
	if (text === '.' || text === '..') throw new Error(`${label} 不能是 "${text}"`);
	if (isAbsolute(text)) throw new Error(`${label} 不能是绝对路径：${text}`);
	if (ILLEGAL_IN_NAME.test(text)) throw new Error(`${label} 含非法字符（\\ / : * ? " < > |）：${text}`);
	if (text.length > 64) throw new Error(`${label} 过长（最多 64 字符）：${text}`);
	if (/[. ]$/.test(text)) throw new Error(`${label} 不能以点或空格结尾：${text}`);
	const stem = text.includes('.') ? text.slice(0, text.indexOf('.')) : text;
	if (WINDOWS_RESERVED.has(stem.toLowerCase())) throw new Error(`${label} 是系统保留名：${text}`);
	return text;
}

/**
 * 校验并归一化一个分类路径（`a` 或 `a/b`）。
 * @returns {string[]} 逐级校验后的片段数组；空数组表示「未分类」。
 */
function safeCategory(raw) {
	const text = str(raw);
	if (text === '') return [];
	const parts = text.split('/').map((p) => p.trim()).filter((p) => p !== '');
	if (parts.length === 0) return [];
	if (parts.length > ROOT_MAX_SEGMENTS) {
		throw new Error(`分类层级过深（最多 ${ROOT_MAX_SEGMENTS} 级）：${text}`);
	}
	return parts.map((p) => safeSegment(p, '分类'));
}

/**
 * 由标题派生一个安全的文件名主体。
 * 保留中文与字母数字，其余折成 `-`；全空时回落到时间戳。
 * @param {string} title - 记忆标题。
 * @returns {string} 不带扩展名的文件名主体。
 */
function slugify(title) {
	const text = str(title);
	const slug = text
		.toLowerCase()
		.replace(/[\s\u3000]+/g, '-')
		.replace(/[^\p{L}\p{N}._-]+/gu, '-')
		.replace(/-{2,}/g, '-')
		.replace(/^[-._]+|[-._]+$/g, '')
		.slice(0, 60)
		.replace(/[-._]+$/, '');
	if (slug !== '' && !WINDOWS_RESERVED.has(slug.toLowerCase())) return slug;
	// 标题被清空或撞上保留名时，用时间戳兜底，保证一定能落盘
	return `memory-${Date.now().toString(36)}`;
}

function resolveSettings(raw = {}) {
	const source = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
	const out = {};
	let configError = null;

	out.enabled = typeof source.enabled === 'boolean' ? source.enabled : DEFAULTS.enabled;
	out.autoIndex = typeof source.autoIndex === 'boolean' ? source.autoIndex : DEFAULTS.autoIndex;
	out.maxEntryBytes = clampInt(source.maxEntryBytes, DEFAULTS.maxEntryBytes, ENTRY_MIN_BYTES, ENTRY_MAX_BYTES);
	out.searchMaxResults = clampInt(source.searchMaxResults, DEFAULTS.searchMaxResults, SEARCH_MIN, SEARCH_MAX);

	out.indexFile = (() => {
		const text = str(source.indexFile, DEFAULTS.indexFile) || DEFAULTS.indexFile;
		try {
			return safeSegment(text, 'indexFile');
		} catch (error) {
			configError = configError ?? `indexFile 不可用（${error.message}），已回落 ${DEFAULTS.indexFile}`;
			return DEFAULTS.indexFile;
		}
	})();

	out.root = (() => {
		const text = str(source.root, DEFAULTS.root) || DEFAULTS.root;
		const parts = text.split(/[/\\]+/).map((p) => p.trim()).filter((p) => p !== '');
		if (parts.length === 0 || parts.length > ROOT_MAX_SEGMENTS) {
			configError = configError ?? `root 层级不合法（最多 ${ROOT_MAX_SEGMENTS} 级），已回落 ${DEFAULTS.root}`;
			return DEFAULTS.root;
		}
		try {
			return parts.map((p) => safeSegment(p, 'root')).join('/');
		} catch (error) {
			configError = configError ?? `root 不可用（${error.message}），已回落 ${DEFAULTS.root}`;
			return DEFAULTS.root;
		}
	})();

	return { settings: out, configError };
}

/* ------------------------------------------------------------------ */
/* 工作目录与路径安全                                                   */
/* ------------------------------------------------------------------ */

/**
 * 会话工作目录。
 *
 * 这是整个插件的立足点：记忆跟着工作区走，所以必须从工具执行上下文里拿，
 * 不能用进程的 cwd（那是 DSH 自己的安装目录）。
 * @param {object} exec - 工具执行上下文。
 * @returns {string} 绝对路径。
 */
function cwdOf(exec) {
	const cwd = exec?.agent?.session?.header?.cwd;
	if (typeof cwd === 'string' && cwd !== '') return cwd;
	return process.cwd();
}

/** 记忆根目录的绝对路径。 */
function memoryRoot(cwd, settings) {
	return resolve(cwd, ...settings.root.split('/'));
}

/**
 * 把若干片段拼到记忆根目录下，并强制结果仍在根目录内。
 *
 * 这是防目录穿越的最后一道闸门：即使前面的校验被绕过，
 * 这里也会因为 `relative()` 以 `..` 开头而拒绝。
 * @throws {Error} 结果逃出根目录时。
 */
function resolveInside(root, ...segments) {
	const target = resolve(root, ...segments);
	const rel = relative(root, target);
	if (rel === '' ) return target;
	if (rel.startsWith('..') || isAbsolute(rel)) {
		throw new Error(`拒绝越界写入：${target} 不在记忆根目录 ${root} 内`);
	}
	return target;
}

/* ------------------------------------------------------------------ */
/* 记忆文件格式                                                        */
/* ------------------------------------------------------------------ */

/**
 * 记忆文件 = 一小段 front matter + Markdown 正文。
 *
 * 刻意不引入 YAML 解析器：格式只有 `key: value` 行，手写解析更可预测，
 * 而且遇到用户手改坏的行只会忽略、不会抛错。
 */
const FRONT_KEYS = ['title', 'tags', 'created', 'updated'];

/** 解析记忆文件；任何异常都回落到「没有 front matter」。 */
function parseMemory(raw) {
	const text = typeof raw === 'string' ? raw : '';
	if (!text.startsWith('---')) return { meta: {}, body: text };
	const end = text.indexOf('\n---', 3);
	if (end < 0) return { meta: {}, body: text };
	const head = text.slice(3, end);
	const body = text.slice(end + 4).replace(/^\r?\n/, '');
	const meta = {};
	for (const line of head.split(/\r?\n/)) {
		const at = line.indexOf(':');
		if (at <= 0) continue;
		const key = line.slice(0, at).trim().toLowerCase();
		if (!FRONT_KEYS.includes(key)) continue;
		const value = line.slice(at + 1).trim();
		if (key === 'tags') {
			meta.tags = value.split(/[,，]/).map((t) => t.trim()).filter((t) => t !== '');
		} else {
			meta[key] = value;
		}
	}
	return { meta, body };
}

/** 组装记忆文件正文。 */
function composeMemory({ title, tags, created, updated, body }) {
	const lines = ['---', `title: ${title}`];
	if (Array.isArray(tags) && tags.length > 0) lines.push(`tags: ${tags.join(', ')}`);
	lines.push(`created: ${created}`);
	lines.push(`updated: ${updated}`);
	lines.push('---', '');
	const text = String(body ?? '').replace(/\s+$/, '');
	lines.push(text, '');
	return lines.join('\n');
}

/** 把字节数变成人话。 */
function sizeOf(bytes) {
	if (!Number.isFinite(bytes) || bytes < 0) return '';
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
	return `${Math.round(bytes / 1024 / 102.4) / 10} MB`;
}

/** 只取日期部分，索引里不需要精确到秒。 */
function dayOf(iso) {
	const text = str(iso);
	return text.length >= 10 ? text.slice(0, 10) : text;
}

/* ------------------------------------------------------------------ */
/* 扫描与索引                                                          */
/* ------------------------------------------------------------------ */

/**
 * 递归扫描记忆根目录，收集所有记忆文件。
 * @returns {Promise<Array<{rel: string, title: string, tags: string[], created: string, updated: string, size: number, group: string}>>}
 */
async function scanMemories(root, indexFile) {
	const found = [];
	const walk = async (dir, depth) => {
		if (depth > SCAN_MAX_DEPTH) return;
		let items;
		try {
			items = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const item of items) {
			if (item.name.startsWith('.')) continue;
			const full = join(dir, item.name);
			if (item.isDirectory()) {
				await walk(full, depth + 1);
				continue;
			}
			if (!item.isFile() || !item.name.toLowerCase().endsWith('.md')) continue;
			if (item.name === indexFile) continue;
			let info;
			try {
				info = await stat(full);
			} catch {
				continue;
			}
			let parsed = { meta: {}, body: '' };
			try {
				parsed = parseMemory(await readFile(full, 'utf8'));
			} catch {
				/* 读不了就只留下路径，不影响其它条目 */
			}
			const rel = relative(root, full).split(/[/\\]/).join('/');
			const group = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
			found.push({
				rel,
				group,
				title: str(parsed.meta.title) || rel.replace(/\.md$/i, ''),
				tags: Array.isArray(parsed.meta.tags) ? parsed.meta.tags : [],
				created: str(parsed.meta.created),
				updated: str(parsed.meta.updated),
				size: info.size,
			});
		}
	};
	await walk(root, 0);
	found.sort((a, b) => (a.group === b.group ? a.rel.localeCompare(b.rel) : a.group.localeCompare(b.group)));
	return found;
}

/**
 * 把扫描结果渲染成 MEMORY.md。
 *
 * 索引是**投影**：每次都由磁盘上的记忆文件重新生成，因此不存在「索引和实际内容不一致」
 * 这种状态。反过来说，手工往 MEMORY.md 里加的内容会在下次重建时消失 —— 文件头写明了这点。
 */
function renderIndex(entries, { root, indexFile, cwd, now }) {
	const lines = [
		'# 记忆索引',
		'',
		'> 本文件由 dsh-bundle-memory **自动生成**，手工改动会在下次保存记忆时被覆盖。',
		'> 要加记忆请让智能体用 `memory_save` 工具，或直接往本目录放 Markdown 文件。',
		'',
		`- 工作区：\`${cwd}\``,
		`- 记忆根目录：\`${root}\``,
		`- 索引文件：\`${indexFile}\``,
		`- 更新时间：${now}`,
		`- 共 ${entries.length} 条记忆`,
		'',
	];
	if (entries.length === 0) {
		lines.push('_还没有任何记忆。_', '');
		return lines.join('\n');
	}
	const groups = new Map();
	for (const entry of entries) {
		if (!groups.has(entry.group)) groups.set(entry.group, []);
		groups.get(entry.group).push(entry);
	}
	// 未分类的放最前，其余按名字排序
	const order = [...groups.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
	for (const group of order) {
		lines.push(group === '' ? '## 未分类' : `## ${group}/`, '');
		for (const entry of groups.get(group)) {
			const link = entry.group === '' ? `./${entry.rel}` : `./${entry.rel}`;
			const meta = [];
			if (entry.tags.length > 0) meta.push(entry.tags.join(', '));
			const when = dayOf(entry.updated) || dayOf(entry.created);
			if (when !== '') meta.push(when);
			meta.push(sizeOf(entry.size));
			lines.push(`- [${entry.title}](${link}) — ${meta.join(' · ')}`);
		}
		lines.push('');
	}
	return lines.join('\n');
}

/** 重建索引并写盘。autoIndex 关闭时只返回内容、不写。 */
async function writeIndex(root, settings, cwd, { force = false } = {}) {
	const entries = await scanMemories(root, settings.indexFile);
	const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
	const text = renderIndex(entries, { root, indexFile: settings.indexFile, cwd, now });
	const path = join(root, settings.indexFile);
	if (settings.autoIndex || force) {
		await mkdir(root, { recursive: true });
		await writeFile(path, text, 'utf8');
	}
	return { path, text, entries };
}

/* ------------------------------------------------------------------ */
/* 状态存储（面板设置）                                                 */
/* ------------------------------------------------------------------ */

function stateDirectory() {
	const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
		? process.env.DSH_HOME.trim()
		: join(homedir(), '.dsh');
	return join(home, 'state', pkg);
}

class FileStore {
	constructor(location) {
		this.location = location;
		this.pending = Promise.resolve();
		this.latest = null;
	}
	get file() {
		return join(this.location.dir, this.location.file);
	}
	read() {
		const run = this.pending.then(async () => {
			if (this.latest !== null) return this.latest;
			const value = await this.readRaw();
			this.latest = value;
			return value;
		});
		this.pending = run.then(() => undefined, () => undefined);
		return run;
	}
	async readRaw() {
		try {
			const parsed = JSON.parse(await readFile(this.file, 'utf8'));
			return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
		} catch {
			return {};
		}
	}
	mutate(mutator) {
		const run = this.pending.then(async () => {
			const current = this.latest ?? (await this.readRaw());
			const next = mutator(current) ?? current;
			await mkdir(this.location.dir, { recursive: true });
			await writeFile(this.file, JSON.stringify(next, null, 2) + '\n', 'utf8');
			this.latest = next;
			return next;
		});
		this.pending = run.then(() => undefined, () => undefined);
		return run;
	}
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

const TOOL_NAMES = ['memory_save', 'memory_recall', 'memory_search', 'memory_forget'];

/** 只读的呈现卡片。 */
const presentRead = (title) => ({ card: 'generic', kind: 'read', title });
/** 有副作用的呈现卡片。 */
const presentAct = (title) => ({ card: 'generic', kind: 'act', title });

const READ_HINT =
	'记忆默认存在当前工作目录的 ./memory/ 下，索引是 ./memory/MEMORY.md。想换位置请让用户去插件设置里改 root。';

/**
 * 注册四个记忆工具。
 * @param ctx - 宿主根 context。
 * @param wiring - apply() 装配的依赖集合。
 * @returns {Function} 反注册回调。
 */
function registerTools(ctx, wiring) {
	const unregisters = [];
	if (wiring.settings.enabled !== true) return () => {};

	const context = async (exec) => {
		const cwd = cwdOf(exec);
		const root = memoryRoot(cwd, wiring.settings);
		return { cwd, root, settings: wiring.settings };
	};

	unregisters.push(ctx.tools.register({
		name: 'memory_save',
		description:
			'Save a durable memory into the current workspace\'s ./memory/ store. Use it for things worth remembering across sessions: user preferences, project conventions, decisions and their reasons, people, gotchas. ' +
			'Give a short `title`; `category` optionally puts it in a subdirectory (e.g. "项目约定" or "people/work") — omit it for anything that needs no classification, and the file goes straight into the memory root. ' +
			'Saving the same title again updates the existing memory when `overwrite` is true, otherwise it errors so nothing is silently lost. ' +
			'The MEMORY.md index is regenerated automatically. ' + READ_HINT,
		parameters: {
			type: 'object',
			properties: {
				title: { type: 'string', description: 'Short human title, e.g. "用户偏好用 pnpm".' },
				content: { type: 'string', description: 'Markdown body — the memory itself.' },
				category: { type: 'string', description: 'Optional subdirectory, "/"-separated, at most 3 levels. Omit for no classification.' },
				tags: { type: 'string', description: 'Optional comma-separated tags.' },
				name: { type: 'string', description: 'Optional explicit file name stem; defaults to a slug of the title.' },
				overwrite: { type: 'boolean', description: 'Replace an existing memory with the same name (default false).' },
			},
			required: ['title', 'content'],
		},
		output: { schema: {} },
		presentCall: (args) => presentAct(`Remember "${args?.title ?? '?'}"`),
		timeoutMs: 15000,
		async execute(args, exec) {
			const { cwd, root, settings } = await context(exec);
			const title = str(args?.title);
			const content = typeof args?.content === 'string' ? args.content : '';
			if (title === '') throw new Error('memory_save 需要非空的 title');
			if (content.trim() === '') throw new Error('memory_save 需要非空的 content');
			const bytes = Buffer.byteLength(content, 'utf8');
			if (bytes > settings.maxEntryBytes) {
				throw new Error(`content 过大：${sizeOf(bytes)} 超过上限 ${sizeOf(settings.maxEntryBytes)}`);
			}
			const category = safeCategory(args?.category);
			const stem = safeSegment(str(args?.name) || slugify(title), 'name');
			const dir = category.length === 0 ? root : resolveInside(root, ...category);
			const target = resolveInside(root, ...category, `${stem}.md`);

			const existing = await stat(target).catch(() => undefined);
			if (existing !== undefined && args?.overwrite !== true) {
				throw new Error(
					`记忆已存在：${relative(cwd, target)}。要覆盖请传 overwrite: true，或换个 name。`,
				);
			}
			let created = new Date().toISOString();
			if (existing !== undefined) {
				try {
					const previous = parseMemory(await readFile(target, 'utf8'));
					if (str(previous.meta.created) !== '') created = previous.meta.created;
				} catch { /* 读不出来就当新建 */ }
			}
			const tags = str(args?.tags).split(/[,，]/).map((t) => t.trim()).filter((t) => t !== '');
			await mkdir(dir, { recursive: true });
			await writeFile(target, composeMemory({
				title,
				tags,
				created,
				updated: new Date().toISOString(),
				body: content,
			}), 'utf8');

			const index = await writeIndex(root, settings, cwd);
			return {
				ok: true,
				path: relative(cwd, target).split(/[/\\]/).join('/'),
				absolutePath: target,
				category: category.join('/'),
				name: `${stem}.md`,
				overwritten: existing !== undefined,
				bytes,
				indexPath: relative(cwd, index.path).split(/[/\\]/).join('/'),
				total: index.entries.length,
			};
		},
	}));

	unregisters.push(ctx.tools.register({
		name: 'memory_recall',
		description:
			'Read memories from the current workspace\'s ./memory/ store. ' +
			'Call it with no `name` to get the MEMORY.md index (the list of everything remembered, grouped by category) — do that first when you are unsure what is known. ' +
			'Pass `name` (a path relative to the memory root, e.g. "项目约定/提交信息用中文.md", or a unique suffix like "提交信息用中文") to read one memory in full. ' +
			READ_HINT,
		parameters: {
			type: 'object',
			properties: {
				name: { type: 'string', description: 'Optional memory path relative to the memory root, or a unique file-name suffix.' },
			},
		},
		output: { schema: {} },
		presentCall: (args) => presentRead(args?.name ? `Recall "${args.name}"` : 'Read memory index'),
		timeoutMs: 15000,
		async execute(args, exec) {
			const { cwd, root, settings } = await context(exec);
			const wanted = str(args?.name);
			if (wanted === '') {
				const index = await writeIndex(root, settings, cwd);
				return {
					ok: true,
					mode: 'index',
					root: relative(cwd, root).split(/[/\\]/).join('/') || '.',
					absoluteRoot: root,
					count: index.entries.length,
					entries: index.entries.map((e) => ({ path: e.rel, title: e.title, tags: e.tags, size: e.size })),
					markdown: index.text,
				};
			}
			// 先按相对路径找，找不到再退化成「唯一后缀匹配」
			const direct = (() => {
				try {
					return resolveInside(root, ...wanted.split(/[/\\]+/).filter((p) => p !== ''));
				} catch {
					return null;
				}
			})();
			let target = null;
			if (direct !== null && (await stat(direct).catch(() => undefined))?.isFile()) {
				target = direct;
			} else {
				const entries = await scanMemories(root, settings.indexFile);
				const bare = wanted.replace(/\.md$/i, '').toLowerCase();
				const hits = entries.filter((e) => {
					const rel = e.rel.toLowerCase();
					return rel === wanted.toLowerCase() || rel.endsWith(`/${wanted.toLowerCase()}`) ||
						rel.replace(/\.md$/, '').endsWith(`/${bare}`) || rel.replace(/\.md$/, '') === bare;
				});
				if (hits.length === 1) target = join(root, ...hits[0].rel.split('/'));
				else if (hits.length > 1) {
					throw new Error(`"${wanted}" 匹配到多条记忆，请给出更完整的路径：${hits.map((h) => h.rel).join('、')}`);
				}
			}
			if (target === null) throw new Error(`找不到记忆 "${wanted}"。先不带参数调用 memory_recall 看索引。`);
			const parsed = parseMemory(await readFile(target, 'utf8'));
			return {
				ok: true,
				mode: 'entry',
				path: relative(cwd, target).split(/[/\\]/).join('/'),
				title: str(parsed.meta.title) || wanted,
				tags: parsed.meta.tags ?? [],
				created: str(parsed.meta.created),
				updated: str(parsed.meta.updated),
				body: parsed.body,
			};
		},
	}));

	unregisters.push(ctx.tools.register({
		name: 'memory_search',
		description:
			'Full-text search across every memory in the current workspace\'s ./memory/ store (title, tags, and body), case-insensitive. ' +
			'Use it when you remember something exists but not where it lives. Returns matching paths with a short excerpt around the hit. ' +
			READ_HINT,
		parameters: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Text to look for.' },
				limit: { type: 'integer', description: 'Max results (default from settings).' },
			},
			required: ['query'],
		},
		output: { schema: {} },
		presentCall: (args) => presentRead(`Search memories for "${args?.query ?? '?'}"`),
		timeoutMs: 20000,
		async execute(args, exec) {
			const { cwd, root, settings } = await context(exec);
			const query = str(args?.query);
			if (query === '') throw new Error('memory_search 需要非空的 query');
			const limit = clampInt(args?.limit, settings.searchMaxResults, SEARCH_MIN, SEARCH_MAX);
			const needle = query.toLowerCase();
			const entries = await scanMemories(root, settings.indexFile);
			const results = [];
			for (const entry of entries) {
				if (results.length >= limit) break;
				if (entry.size > SEARCH_READ_LIMIT) continue;
				let text = '';
				try {
					text = await readFile(join(root, ...entry.rel.split('/')), 'utf8');
				} catch {
					continue;
				}
				const haystack = text.toLowerCase();
				const at = haystack.indexOf(needle);
				const inTitle = entry.title.toLowerCase().includes(needle);
				const inTags = entry.tags.some((t) => t.toLowerCase().includes(needle));
				if (at < 0 && !inTitle && !inTags) continue;
				const source = at >= 0 ? text : '';
				const from = at >= 0 ? Math.max(0, at - 60) : 0;
				results.push({
					path: entry.rel,
					title: entry.title,
					tags: entry.tags,
					matchedIn: [inTitle ? 'title' : null, inTags ? 'tags' : null, at >= 0 ? 'body' : null].filter(Boolean),
					excerpt: source === '' ? '' : source.slice(from, from + 160).replace(/\s+/g, ' ').trim(),
				});
			}
			return {
				ok: true,
				query,
				scanned: entries.length,
				count: results.length,
				truncated: results.length >= limit,
				results,
			};
		},
	}));

	unregisters.push(ctx.tools.register({
		name: 'memory_forget',
		description:
			'Delete one memory from the current workspace\'s ./memory/ store, by path relative to the memory root. ' +
			'Only accepts a single .md file — it never deletes directories, and it never touches anything outside ./memory/. ' +
			'The index is regenerated afterwards. ' + READ_HINT,
		parameters: {
			type: 'object',
			properties: {
				name: { type: 'string', description: 'Memory path relative to the memory root, e.g. "项目约定/提交信息用中文.md".' },
			},
			required: ['name'],
		},
		output: { schema: {} },
		presentCall: (args) => presentAct(`Forget "${args?.name ?? '?'}"`),
		timeoutMs: 15000,
		async execute(args, exec) {
			const { cwd, root, settings } = await context(exec);
			const wanted = str(args?.name);
			if (wanted === '') throw new Error('memory_forget 需要非空的 name');
			if (!wanted.toLowerCase().endsWith('.md')) throw new Error('memory_forget 只接受 .md 文件');
			const target = resolveInside(root, ...wanted.split(/[/\\]+/).filter((p) => p !== ''));
			if (target === join(root, settings.indexFile)) {
				throw new Error('不能删除索引文件本身');
			}
			const info = await stat(target).catch(() => undefined);
			if (info === undefined || !info.isFile()) throw new Error(`找不到记忆 "${wanted}"`);
			await rm(target, { force: true });
			const index = await writeIndex(root, settings, cwd);
			return {
				ok: true,
				deleted: relative(cwd, target).split(/[/\\]/).join('/'),
				remaining: index.entries.length,
			};
		},
	}));

	return () => {
		for (const unregister of unregisters) {
			if (typeof unregister === 'function') unregister();
		}
	};
}

/* ------------------------------------------------------------------ */
/* 面板 HTTP 路由                                                      */
/* ------------------------------------------------------------------ */

const STATE_PATH = `/api/${pkg}/state`;
const SETTINGS_PATH = `/api/${pkg}/settings`;
const NO_CACHE = { 'cache-control': 'no-store' };
const MAX_BODY_BYTES = 8192;
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1'];

/** Host 头里的裸主机名；裸 IPv6（≥2 个冒号）不按 host:port 剥端口。 */
function bareHost(host) {
	const text = String(host ?? '').split(',')[0]?.trim() ?? '';
	if (text === '') return '';
	const lower = text.toLowerCase();
	const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(lower);
	if (bracketed) return bracketed[1];
	if (/^[0-9a-f:]+$/.test(lower) && (lower.match(/:/g) ?? []).length >= 2) return lower;
	return lower.replace(/:\d+$/, '');
}
function isAdmitted(request) {
	const host = bareHost(request?.headers?.host);
	if (host === '') return false;
	return LOOPBACK_HOSTS.some((entry) => host === entry);
}
function writeJson(res, status, body) {
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...NO_CACHE });
	res.end(JSON.stringify(body));
}
async function readJsonBody(request, limit = MAX_BODY_BYTES) {
	const chunks = [];
	let received = 0;
	try {
		for await (const chunk of request) {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			received += buffer.byteLength;
			if (received > limit) return { ok: false, error: '请求体过大' };
			chunks.push(buffer);
		}
	} catch {
		return { ok: false, error: '无法读取请求体' };
	}
	if (chunks.length === 0) return { ok: false, error: '需要一个 JSON 请求体' };
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? { ok: true, value: parsed }
			: { ok: false, error: '请求体必须是 JSON 对象' };
	} catch {
		return { ok: false, error: '请求体不是合法 JSON' };
	}
}

function buildState(wiring) {
	return {
		ok: true,
		now: Date.now(),
		plugin: { name: pkg, entry: name },
		effective: { ...wiring.settings },
		defaults: { ...DEFAULTS },
		configError: wiring.configError,
		tools: wiring.settings.enabled === true ? TOOL_NAMES.slice() : [],
		registeredTools: wiring.registeredTools.slice(),
		note: '记忆根目录相对于**当前会话的工作目录**，面板本身不属于任何会话，因此这里只显示相对路径。',
	};
}

function registerRoutes(ctx, wiring) {
	let webServer = null;
	try {
		webServer = ctx.webServer ?? ctx.get?.('webServer') ?? null;
	} catch {
		webServer = null;
	}
	if (webServer === null || typeof webServer.register !== 'function') return null;

	const register = (path, handler) => {
		try {
			return webServer.register({ kind: 'exact', path, handler });
		} catch (error) {
			wiring.logger?.warn?.(`${pkg}: 路由注册失败 ${path}: ${error?.message ?? error}`);
			return null;
		}
	};

	const onState = register(STATE_PATH, (request, response) => {
		if (!isAdmitted(request)) return writeJson(response, 403, { ok: false, error: '禁止：来源不匹配' });
		const method = request.method === undefined ? 'GET' : request.method;
		if (method !== 'GET' && method !== 'HEAD') return writeJson(response, 405, { ok: false, error: '方法不允许' });
		try {
			writeJson(response, 200, buildState(wiring));
		} catch (error) {
			writeJson(response, 200, { ok: false, error: error?.message ?? String(error) });
		}
	});

	const onSettings = register(SETTINGS_PATH, async (request, response) => {
		if (!isAdmitted(request)) return writeJson(response, 403, { ok: false, error: '禁止：来源不匹配' });
		if (request.method !== undefined && request.method !== 'POST') {
			return writeJson(response, 405, { ok: false, error: '方法不允许' });
		}
		const body = await readJsonBody(request);
		if (!body.ok) return writeJson(response, 400, { ok: false, error: body.error });
		const { field, value } = body.value;
		if (typeof field !== 'string' || field === '') {
			return writeJson(response, 400, { ok: false, error: '缺少 field' });
		}
		if (!(field in DEFAULTS)) {
			return writeJson(response, 400, { ok: false, error: `未知字段 '${field}'` });
		}
		try {
			const next = await wiring.store.mutate((current) => {
				const copy = { ...current };
				if (value === null) delete copy[field];
				else copy[field] = value;
				return copy;
			});
			const { settings, configError } = resolveSettings({ ...wiring.patchConfig, ...next });
			wiring.settings = settings;
			wiring.configError = configError;
			syncTools(wiring);
			writeJson(response, 200, {
				ok: true,
				effective: { ...settings },
				defaults: { ...DEFAULTS },
				configError,
				registeredTools: wiring.registeredTools.slice(),
			});
		} catch (error) {
			writeJson(response, 500, { ok: false, error: error?.message ?? String(error) });
		}
	});

	return () => {
		for (const off of [onState, onSettings]) {
			if (typeof off === 'function') {
				try {
					off();
				} catch {
					/* 宿主可能已拆除 */
				}
			}
		}
	};
}

/** 按当前设置重挂工具。 */
function syncTools(wiring) {
	if (wiring.disposed) return;
	if (typeof wiring.offTools === 'function') {
		try {
			wiring.offTools();
		} catch {
			/* ignore */
		}
		wiring.offTools = null;
	}
	wiring.registeredTools = [];
	if (wiring.settings.enabled !== true) return;
	if (typeof wiring.ctx.tools?.register !== 'function') return;
	try {
		wiring.offTools = registerTools(wiring.ctx, wiring);
		wiring.registeredTools = TOOL_NAMES.slice();
	} catch (error) {
		wiring.logger?.warn?.(`${pkg}: 工具注册失败：${error?.message ?? error}`);
	}
}

async function refreshFromSettings(wiring) {
	if (wiring.disposed === true) return null;
	if (wiring.refreshing === true) return null;
	wiring.refreshing = true;
	try {
		const layer = await wiring.store.read();
		const { settings, configError } = resolveSettings({ ...wiring.patchConfig, ...layer });
		wiring.settings = settings;
		wiring.configError = configError;
		syncTools(wiring);
		return settings;
	} catch (error) {
		wiring.logger?.warn?.(`${pkg}: 读取设置失败：${error?.message ?? error}`);
		return null;
	} finally {
		wiring.refreshing = false;
	}
}

/**
 * 挂载：装配设置、按设置注册工具、挂面板路由。
 * 任何一处拿不到服务都静默降级，绝不在挂载时抛错。
 */
function apply(ctx, config = {}) {
	const logger = ctx.logger ?? null;
	const patchConfig = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) };
	const initial = resolveSettings(patchConfig);
	const wiring = {
		ctx,
		logger,
		store: new FileStore({ dir: stateDirectory(), file: 'settings.json' }),
		patchConfig,
		settings: initial.settings,
		configError: initial.configError,
		disposed: false,
		refreshing: false,
		offTools: null,
		registeredTools: [],
	};

	const offRoutes = registerRoutes(ctx, wiring);
	syncTools(wiring);
	void refreshFromSettings(wiring);

	const stop = () => {
		wiring.disposed = true;
		if (typeof wiring.offTools === 'function') {
			try {
				wiring.offTools();
			} catch { /* ignore */ }
			wiring.offTools = null;
		}
		if (typeof offRoutes === 'function') {
			try {
				offRoutes();
			} catch { /* ignore */ }
		}
	};
	if (typeof ctx.effect === 'function') {
		ctx.effect(() => () => stop(), `${pkg}: mount`);
	} else {
		ctx.once?.('disposed', stop);
	}
}

export {
	DEFAULTS as CONFIG_DEFAULTS,
	DEFAULTS,
	FileStore,
	TOOL_NAMES,
	apply,
	buildState,
	composeMemory,
	cwdOf,
	inject,
	isAdmitted,
	memoryRoot,
	name,
	parseMemory,
	pkg,
	registerRoutes,
	registerTools,
	renderIndex,
	resolveInside,
	resolveSettings,
	safeCategory,
	safeSegment,
	scanMemories,
	sizeOf,
	slugify,
	stateDirectory,
	writeIndex,
};
