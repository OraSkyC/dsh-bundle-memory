// 客户端半侧验证：走真实的 window.__ModuleLoader__ 注册路径，
// 再驱动 factory / apply / 组件渲染。跑完可删。
import assert from "node:assert/strict";

const registrations = [];
globalThis.window = { __ModuleLoader__: { load: (r) => registrations.push(r) } };
globalThis.document = { addEventListener() {}, removeEventListener() {}, visibilityState: "visible" };
globalThis.AbortController = class { constructor() { this.signal = { aborted: false }; } abort() {} };
globalThis.fetch = async () => { throw new Error("no network in test"); };

await import("./client.js");

let passed = 0;
const ok = (label) => { passed += 1; console.log(`  ✓ ${label}`); };

// ---- 可多次渲染的迷你 React ------------------------------------------
function makeReact() {
	let slots = [], marks = [], pending = [], cleanups = [], cursor = 0;
	const changed = (i, watch) => {
		const prev = marks[i];
		if (watch === undefined || prev === undefined) return true;
		if (watch.length !== prev.length) return true;
		return watch.some((value, k) => value !== prev[k]);
	};
	return {
		createElement(type, props, ...children) {
			const flat = [];
			for (const child of children) Array.isArray(child) ? flat.push(...child) : flat.push(child);
			if (typeof type === "function") {
				const merged = { ...(props ?? {}) };
				// 只在真的有位置子节点时才覆盖 children —— 否则会把通过 props
				// 传进来的 children 抹成 undefined（真实 React 也是这个行为）。
				if (flat.length > 0) merged.children = flat.length === 1 ? flat[0] : flat;
				return type(merged);
			}
			return { type, props: props ?? null, children: flat };
		},
		useState(initial) {
			const i = cursor++;
			if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
			return [slots[i], (next) => { slots[i] = typeof next === "function" ? next(slots[i]) : next; }];
		},
		useEffect(fn, watch) { const i = cursor++; if (changed(i, watch)) { marks[i] = watch; pending.push(fn); } },
		useCallback(fn, watch) { const i = cursor++; if (changed(i, watch)) { marks[i] = watch; slots[i] = fn; } return slots[i]; },
		useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
		begin() { cursor = 0; pending = []; },
		flush() { for (const fn of pending.splice(0)) { const off = fn(); if (typeof off === "function") cleanups.push(off); } },
		teardown() { for (const off of cleanups.splice(0)) { try { off(); } catch { /* ignore */ } } }
	};
}
function renderPanel(reactApi, PanelPage, tt) {
	reactApi.begin();
	const tree = PanelPage({ tt, localeSubscribe: () => () => {} });
	reactApi.flush();
	return tree;
}
function findButtons(node, found = []) {
	if (node === null || typeof node !== "object") return found;
	if (node.type === "button") found.push(node);
	for (const child of node.children ?? []) findButtons(child, found);
	return found;
}
function collectCode(node, found = []) {
	if (node === null || typeof node !== "object") return found;
	if (node.type === "code") found.push((node.children ?? []).join(""));
	for (const child of node.children ?? []) collectCode(child, found);
	return found;
}
let REGISTRATION = null;
function freshReact() {
	const instance = makeReact();
	REGISTRATION.factory(() => instance);
	return instance;
}

console.log("\n[A] 浏览器注册路径");
{
	assert.equal(registrations.length, 1);
	REGISTRATION = registrations[0];
	assert.equal(REGISTRATION.id, "dsh-bundle-memory");
	assert.equal(typeof REGISTRATION.factory, "function");
	ok(`window.__ModuleLoader__ 收到 id=${REGISTRATION.id}`);
}

console.log("\n[B] clientFactory 与 apply()");
const out = REGISTRATION.factory(() => makeReact());
assert.deepEqual(out.inject, ["slots", "locale"]);
assert.equal(typeof out.apply, "function");
ok(`inject=${JSON.stringify(out.inject)}`);

const events = [];
const disposers = [];
out.apply({
	logger: { warn() {}, info() {} },
	locale: {
		register(ns, dicts) { events.push(["register", ns, Object.keys(dicts).join("|")]); return () => {}; },
		bind() { return (key) => key; },
		subscribe() { return () => {}; }
	},
	slots: {
		inject(_slot, fn) { const r = fn(); disposers.push(r); return () => {}; },
		register(meta, component) { events.push(["slot", meta.name, meta.key, meta.locale, typeof component]); return () => {}; }
	},
	effect(fn) { disposers.push(fn()); return () => {}; }
});
{
	const reg = events[0];
	assert.equal(reg[1], "dsh-bundle-memory");
	assert.deepEqual(reg[2].split("|").sort(), ["en", "zh"]);
	const slot = events[1];
	assert.equal(slot[1], "plugins.bundle.config");
	assert.equal(slot[2], "dsh-bundle-memory");
	assert.equal(slot[4], "function");
	ok(`字典注册 → ${reg[1]}；slot 注册 → ${slot[1]} / key=${slot[2]}`);
}
{
	out.apply({ effect: () => {}, slots: { inject() { return () => {}; } } });
	ok("locale 缺失 → 不抛错");
	const realWarn = console.warn;
	console.warn = () => {};
	try {
		out.apply({
			locale: { register() { return () => {}; }, bind() { return (k) => k; }, subscribe() { return () => {}; } },
			slots: { inject(_s, fn) { const r = fn(); if (r) r(); throw new Error("boom"); } },
			effect() {}
		});
	} finally { console.warn = realWarn; }
	ok("slots 注册抛错 → 不向外抛");
}

console.log("\n[C] 组件渲染");
{
	const { PanelPage, SectionCard, StatusRow, Field, BoolField, Button } = out.panel.components;
	for (const [label, c] of [["PanelPage", PanelPage], ["SectionCard", SectionCard], ["StatusRow", StatusRow],
		["Field", Field], ["BoolField", BoolField], ["Button", Button]]) {
		assert.equal(typeof c, "function", `${label} 应为函数`);
	}
	ok("组件均为函数");

	const loadingTree = renderPanel(freshReact(), PanelPage, (k) => k);
	assert.match(JSON.stringify(loadingTree), /panel\.loading/);
	ok("未加载 → loading 分支");

	// Field：左列标签 + 右列控件（标签必须可见，不能只靠 aria-label）
	const fReact = freshReact();
	fReact.begin();
	const field = Field({
		name: "maxEntryBytes", label: "单条记忆上限", hint: "取值范围 1024–4194304",
		value: 262144, kind: "number", tt: (k) => k
	});
	const labelCol = field.children[0];
	assert.match(JSON.stringify(labelCol), /单条记忆上限/, "Field 必须渲染可见标签");
	assert.match(JSON.stringify(labelCol), /取值范围/, "hint 应在标签列");
	assert.ok(!JSON.stringify(labelCol).includes("aria-label"), "标签必须是可见文本");
	assert.equal(field.children[1].children[0].type, "input");
	assert.equal(field.children[1].children[0].props.value, "262144");
	fReact.teardown();
	ok("Field 渲染可见标签 + 说明 + 值");

	// BoolField：标签可见 + 开关几何与配色对齐 DSH 原生组件
	for (const on of [true, false]) {
		const bReact = freshReact();
		bReact.begin();
		const node = BoolField({ name: "autoIndex", label: "自动重建索引", hint: "每次保存后重写", value: on, tt: (k) => k });
		assert.match(JSON.stringify(node.children[0]), /自动重建索引/, `value=${on} 必须渲染标签`);
		const track = findButtons(node).find((b) => b.props?.role === "switch");
		assert.ok(track !== undefined, "应渲染 role=switch");
		assert.equal(track.props["aria-checked"], on);
		assert.equal(track.props.style.width, 36);
		assert.equal(track.props.style.height, 20);
		assert.equal(track.props.style.padding, 2);
		const bg = track.props.style.background;
		assert.ok(typeof bg === "string" && bg.trim() !== "" && bg !== "none", `${on} 态轨道必须有背景色`);
		const thumb = track.children.find((c) => c?.type === "span");
		if (on) {
			assert.equal(thumb.props.style.transform, "translateX(16px)");
			assert.match(JSON.stringify(thumb.props.style), /label-primary-foreground/);
		} else {
			assert.equal(thumb.props.style.transform, undefined);
			assert.match(JSON.stringify(thumb.props.style), /switch-thumb/);
		}
		bReact.teardown();
	}
	ok("BoolField 可见标签 + 开关几何/配色对齐 DSH 原生组件（两态）");

	{
		const bReact = freshReact();
		bReact.begin();
		const onNode = BoolField({ name: "n", label: "L", value: true, tt: (k) => k });
		const offNode = BoolField({ name: "n", label: "L", value: false, tt: (k) => k });
		const bgOf = (n) => findButtons(n).find((b) => b.props?.role === "switch").props.style.background;
		assert.notEqual(bgOf(onNode), bgOf(offNode), "开/关态轨道背景色必须不同");
		bReact.teardown();
	}
	ok("开关开/关两态视觉可区分");
}

console.log("\n[D] 文案键对齐");
{
	const { zh, en } = out.panel.dictionaries;
	assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
	assert.ok(Object.keys(zh).length >= 35);
	ok(`中英各 ${Object.keys(zh).length} 个键，键集一致`);

	const KEY_RE = /^[a-z][a-z0-9]*([.][a-z][a-z0-9]*)+$/i;
	const used = new Set();
	const walk = (node) => {
		if (node === null || typeof node !== "object") return;
		for (const value of Object.values(node)) {
			if (typeof value === "string" && KEY_RE.test(value)) used.add(value);
			else walk(value);
		}
	};
	const { PanelPage, SectionCard, Field, BoolField, StatusRow } = out.panel.components;
	for (const node of [
		PanelPage({ tt: (k) => k, localeSubscribe: () => () => {} }),
		SectionCard({ title: "S", open: true, onToggle: () => {}, tt: (k) => k }),
		StatusRow({ label: "L", value: "V" }),
		Field({ name: "n", label: "L", value: "v", kind: "text", tt: (k) => k }),
		BoolField({ name: "n", label: "L", value: true, tt: (k) => k })
	]) walk(node);
	const missing = [...used].filter((key) => !(key in zh));
	assert.deepEqual(missing, [], "缺字典键: " + missing.join(", "));
	ok(`渲染树引用 ${used.size} 个键，全部在字典中`);

	// 面板把文案当**纯文本**渲染（不是 Markdown），标记只会显示成字面符号。
	// 真出过一次：状态区说明里写了 **当前会话的工作目录**，界面上就是两个星号。
	for (const [lang, dict] of [["zh", zh], ["en", en]]) {
		for (const [key, value] of Object.entries(dict)) {
			assert.ok(
				!value.includes("**") && !value.includes("__"),
				`${lang} 的 ${key} 含 Markdown 标记，会显示成字面符号：${value}`
			);
		}
	}
	ok("文案里没有 Markdown 标记（面板是纯文本渲染）");
}

console.log("\n[E] 端点路径");
{
	const { NS, STATE_PATH, SETTINGS_PATH } = out.panel.paths;
	assert.equal(NS, "dsh-bundle-memory");
	assert.equal(STATE_PATH, "/api/dsh-bundle-memory/state");
	assert.equal(SETTINGS_PATH, "/api/dsh-bundle-memory/settings");
	ok(`面板端点: ${STATE_PATH} / ${SETTINGS_PATH}`);
}

console.log("\n[F] 面板端到端");
{
	const { PanelPage } = out.panel.components;
	const zh = out.panel.dictionaries.zh;
	const tt = (k) => zh[k] ?? k;

	async function mountWith(state) {
		globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => state });
		const reactApi = freshReact();
		renderPanel(reactApi, PanelPage, tt);
		await new Promise((r) => setTimeout(r, 20));
		const tree = renderPanel(reactApi, PanelPage, tt);
		return { reactApi, tree };
	}

	const base = {
		ok: true,
		plugin: { name: "dsh-bundle-memory", entry: "memory" },
		effective: { enabled: true, root: "memory", indexFile: "MEMORY.md", autoIndex: true, maxEntryBytes: 262144, searchMaxResults: 20 },
		defaults: { enabled: true, root: "memory", indexFile: "MEMORY.md", autoIndex: true, maxEntryBytes: 262144, searchMaxResults: 20 },
		configError: null,
		tools: ["memory_save", "memory_recall", "memory_search", "memory_forget"],
		registeredTools: ["memory_save", "memory_recall", "memory_search", "memory_forget"]
	};

	{
		const { reactApi, tree } = await mountWith(base);
		const json = JSON.stringify(tree);
		assert.ok(!json.includes("panel.loading"), "应进入数据分支");
		assert.match(json, /记忆管理/, "应渲染面板标题");
		for (const section of ["状态", "存储位置", "限额"]) assert.ok(json.includes(section), `缺少区块: ${section}`);
		for (const label of ["记忆根目录", "索引文件名", "自动重建索引", "单条记忆上限（字节）", "搜索默认返回条数"]) {
			assert.ok(json.includes(label), `缺少字段标签: ${label}`);
		}
		// 工具必须作为 <code> chip 出现（不能只靠说明文字里的同名串蒙混）
		const chips = collectCode(tree);
		for (const tool of ["memory_save", "memory_recall", "memory_search", "memory_forget"]) {
			assert.ok(chips.includes(tool), `状态区应以 code chip 列出工具 ${tool}`);
		}
		assert.ok(chips.includes("memory/MEMORY.md"), `应显示索引完整相对路径，实际：${JSON.stringify(chips)}`);
		ok(`面板渲染标题、三个区块、字段标签，chip 列出 4 个工具与索引路径`);

		assert.match(json, /当前会话的工作目录/, "必须说明记忆位置随会话工作目录走");
		ok("面板说明记忆位置是相对的（随会话工作目录）");
		reactApi.teardown();
	}

	{
		const { reactApi, tree } = await mountWith({ ...base, effective: { ...base.effective, enabled: false }, registeredTools: [], tools: [] });
		const json = JSON.stringify(tree);
		assert.match(json, /插件已停用/, "enabled=false 应显示停用提示");
		const switches = findButtons(tree).filter((b) => b.props?.role === "switch");
		assert.equal(switches.length, 2, `应有 2 个开关，实际 ${switches.length}`);
		assert.equal(switches.find((b) => b.props["aria-label"] === "启用插件").props.disabled, false);
		assert.equal(switches.find((b) => b.props["aria-label"] === "自动重建索引").props.disabled, true);
		ok("enabled=false → 停用提示，且其余开关被禁用");
		reactApi.teardown();
	}

	{
		const { reactApi, tree } = await mountWith({ ...base, configError: "root 层级不合法（最多 3 级）" });
		assert.match(JSON.stringify(tree), /配置有误/, "configError 应显示出来");
		ok("configError 有显示");
		reactApi.teardown();
	}

	{
		const { reactApi, tree } = await mountWith({ ...base, effective: { ...base.effective, root: "notes/mem", indexFile: "INDEX.md" } });
		assert.match(JSON.stringify(tree), /notes\/mem\/INDEX\.md/, "布局行应跟随设置变化");
		ok("布局行跟随 root / indexFile 设置");
		reactApi.teardown();
	}
}

console.log("\n[G] CSS 变量必须真实存在（回归）");
{
	// 写一个不存在的 CSS 变量会让整条声明被判非法、静默失效，界面无任何报错。
	const DSH_TOKENS = new Set([
		"--dsw-alias-bg-base", "--dsw-alias-bg-layer-1", "--dsw-alias-bg-layer-2",
		"--dsw-alias-bg-layer-3", "--dsw-alias-bg-layer-4", "--dsw-alias-bg-mask-1",
		"--dsw-alias-bg-module-platform", "--dsw-alias-border-l1", "--dsw-alias-border-l2",
		"--dsw-alias-border-l3", "--dsw-alias-border-l4", "--dsw-alias-brand-primary",
		"--dsw-alias-button-primary-fill", "--dsw-alias-button-primary-hover",
		"--dsw-alias-button-ghost-active-border", "--dsw-alias-button-ghost-active-fill",
		"--dsw-alias-interactive-bg-active", "--dsw-alias-interactive-bg-hover",
		"--dsw-alias-interactive-bg-hover-danger", "--dsw-alias-label-caption",
		"--dsw-alias-label-dimmed", "--dsw-alias-label-error", "--dsw-alias-label-primary",
		"--dsw-alias-label-primary-foreground", "--dsw-alias-label-secondary",
		"--dsw-alias-label-shimmer", "--dsw-alias-label-tertiary", "--dsw-alias-link",
		"--dsw-alias-markdown-code-block", "--dsw-alias-markdown-inline-code",
		"--dsw-alias-markdown-tag", "--dsw-alias-state-business-primary",
		"--dsw-alias-state-error-primary", "--dsw-alias-state-idle-primary",
		"--dsw-alias-state-success-primary", "--dsw-alias-state-success-tertiary",
		"--dsw-alias-state-warn-label", "--dsw-alias-state-warn-primary",
		"--dsw-alias-state-warn-tertiary", "--dsw-alias-switch-thumb",
		"--dsw-alias-toast-bg", "--dsw-alias-toast-label", "--dsw-alias-tooltip-bg",
		"--dsw-alias-tooltip-key-bg", "--dsw-alias-scrollbar-bg-l2",
		"--dsw-alias-menu-group-header-fill", "--dsw-alias-menu-icon",
		"--dsw-elevation-panel", "--dsw-elevation-prominent", "--dsw-elevation-soft",
		"--dsw-elevation-stroke-color", "--dsw-focus-ring-color", "--dsw-focus-ring-width",
		"--dsw-font-family", "--dsw-font-markdown-code-font-family",
		"--dsw-font-markdown-base", "--dsw-font-markdown-base-strong",
		"--dsw-font-markdown-code", "--dsw-font-markdown-code-block",
		"--dsw-radius-xs", "--dsw-radius-sm", "--dsw-radius-md", "--dsw-radius-lg",
		"--dsw-radius-panel", "--dsw-shadow-lv3", "--dsw-static-neutral-bluish-00"
	]);
	const { readFile } = await import("node:fs/promises");
	const source = await readFile(new URL("./client.js", import.meta.url), "utf8");
	const used = new Set();
	for (const m of source.matchAll(/var\((--dsw-[a-z0-9-]+)/g)) used.add(m[1]);
	assert.ok(used.size >= 15, `应提取到足够多 token，实际 ${used.size}`);
	const unknown = [...used].filter((t) => !DSH_TOKENS.has(t)).sort();
	assert.deepEqual(unknown, [], "以下变量在 DSH 主题里不存在，会让整条样式静默失效:\n    " + unknown.join("\n    "));
	ok(`用到的 ${used.size} 个 --dsw-* 变量都真实存在`);
}

for (const d of disposers) if (typeof d === "function") d();
console.log(`\n客户端全部通过（${passed} 项断言组）`);
process.exit(0);   // 面板的轮询 setInterval 还挂着，直接退出
