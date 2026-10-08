// 宿主半侧验证：配置、路径安全、front matter、索引、四个工具、面板路由。
// 跑完可删。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "dsh-mem-test-"));
process.env.DSH_HOME = ROOT;

const {
	FileStore, TOOL_NAMES, apply, composeMemory, cwdOf, inject, isAdmitted, memoryRoot,
	name, parseMemory, pkg, registerRoutes, registerTools, renderIndex, resolveInside,
	resolveSettings, safeCategory, safeSegment, scanMemories, slugify, stateDirectory, writeIndex
} = await import("./lib/index.js");

let passed = 0;
const ok = (label) => { passed += 1; console.log(`  ✓ ${label}`); };
const tick = () => new Promise((r) => setTimeout(r, 15));
async function until(p, timeoutMs = 3000, stepMs = 15) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (p()) return;
		if (Date.now() > deadline) throw new Error("until() 超时");
		await new Promise((r) => setTimeout(r, stepMs));
	}
}

/** 假的宿主 context + 一个工作目录，模拟「某个会话里的工作区」。 */
function makeHost(config = {}) {
	const workspace = mkdtempSync(join(ROOT, "ws-"));
	const routes = [];
	const tools = [];
	const disposers = [];
	const ctx = {
		logger: { warn() {}, info() {}, error() {} },
		get(n) {
			if (n === "tools") return ctx.tools;
			if (n === "webServer") return ctx.webServer;
			return undefined;
		},
		webServer: { register(def) { routes.push(def); return () => { const i = routes.indexOf(def); if (i >= 0) routes.splice(i, 1); }; } },
		tools: { register(def) { tools.push(def); return () => { const i = tools.indexOf(def); if (i >= 0) tools.splice(i, 1); }; } },
		effect(fn) { disposers.push(fn()); return () => {}; },
		once() {}
	};
	apply(ctx, config);
	/** 模拟一次工具调用：exec 里带着会话工作目录。 */
	const exec = { agent: { session: { header: { cwd: workspace, id: "sess-1" } } } };
	const tool = (n) => tools.find((t) => t.name === n);
	return { ctx, routes, tools, disposers, workspace, exec, tool };
}
function makeResponse() {
	const res = { status: 0, headers: {}, body: "" };
	res.writeHead = (s, h) => { res.status = s; res.headers = h; };
	res.end = (b) => { res.body = b; };
	return res;
}
function makeRequest(method, headers = {}, body) {
	const req = { method, headers };
	if (body !== undefined) {
		const chunk = Buffer.from(JSON.stringify(body), "utf8");
		req[Symbol.asyncIterator] = async function* () { yield chunk; };
	}
	return req;
}

// ---- 0. 回归：inject 与受限代理 --------------------------------------
console.log("\n[0] inject 声明与受限代理");
{
	assert.ok(inject.includes("webServer"), `inject 应含 webServer，实际 ${JSON.stringify(inject)}`);
	assert.ok(inject.includes("tools"));
	ok(`inject = ${JSON.stringify(inject)}`);

	const ctx = { logger: { warn() {} }, get() { return undefined; }, effect(fn) { return fn(); }, once() {} };
	Object.defineProperty(ctx, "webServer", {
		get() { throw new Error('cannot get property "webServer" without inject'); },
		configurable: true
	});
	let threw = null;
	try { apply(ctx, {}); } catch (e) { threw = e; }
	assert.equal(threw, null, `apply() 不应抛错: ${threw?.message}`);
	ok("ctx.webServer 抛受限代理错误 → apply() 静默降级");
}

// ---- 1. 配置归一化 ---------------------------------------------------
console.log("\n[1] 配置归一化");
{
	const d = resolveSettings({}).settings;
	assert.equal(d.enabled, true);
	assert.equal(d.root, "memory");
	assert.equal(d.indexFile, "MEMORY.md");
	assert.equal(d.autoIndex, true);
	assert.equal(d.maxEntryBytes, 262144);
	assert.equal(d.searchMaxResults, 20);
	ok("空配置 → 默认值");

	assert.equal(resolveSettings({ maxEntryBytes: 1 }).settings.maxEntryBytes, 1024);
	assert.equal(resolveSettings({ maxEntryBytes: 1e12 }).settings.maxEntryBytes, 4 * 1024 * 1024);
	assert.equal(resolveSettings({ searchMaxResults: 0 }).settings.searchMaxResults, 1);
	assert.equal(resolveSettings({ searchMaxResults: 9999 }).settings.searchMaxResults, 100);
	ok("数值夹取");

	const bad = resolveSettings({ root: "../outside" });
	assert.equal(bad.settings.root, "memory", "含 .. 的 root 必须回落");
	assert.match(bad.configError, /root/);
	ok(`非法 root → 回落 + configError`);

	const nested = resolveSettings({ root: "a/b/c" });
	assert.equal(nested.settings.root, "a/b/c");
	const tooDeep = resolveSettings({ root: "a/b/c/d" });
	assert.equal(tooDeep.settings.root, "memory");
	ok("root 最多 3 级");
}

// ---- 2. 路径片段安全 -------------------------------------------------
console.log("\n[2] 路径片段安全");
{
	for (const bad of ["..", ".", "a/b", "a\\b", "CON", "con.md", "nul", "x".repeat(70), "trail.", "q?x", ""]) {
		assert.throws(() => safeSegment(bad, "name"), undefined, `应拒绝 ${JSON.stringify(bad)}`);
	}
	ok("safeSegment 拒绝 .. / 分隔符 / 保留名 / 超长 / 非法字符 / 空");

	assert.equal(safeSegment("用户偏好", "name"), "用户偏好");
	assert.equal(safeSegment("notes-2026.md", "name"), "notes-2026.md");
	ok("safeSegment 放行中文与常规名字");

	assert.deepEqual(safeCategory(""), []);
	assert.deepEqual(safeCategory("项目约定"), ["项目约定"]);
	assert.deepEqual(safeCategory("people/work"), ["people", "work"]);
	assert.throws(() => safeCategory("a/b/c/d"), /层级过深/);
	assert.throws(() => safeCategory("../x"), /不能是/);
	ok("safeCategory：空 = 未分类、支持多级、限深、拒绝穿越");

	const root = resolve(ROOT, "mem-root");
	assert.equal(resolveInside(root, "a.md"), join(root, "a.md"));
	assert.equal(resolveInside(root, "sub", "b.md"), join(root, "sub", "b.md"));
	assert.throws(() => resolveInside(root, "..", "evil.md"), /越界/);
	assert.throws(() => resolveInside(root, "..", "..", "evil.md"), /越界/);
	assert.throws(() => resolveInside(root, "sub", "..", "..", "evil.md"), /越界/);
	ok("resolveInside 挡住目录穿越（含嵌套 ..）");
}

// ---- 3. slug 派生 ----------------------------------------------------
console.log("\n[3] 文件名派生");
{
	assert.equal(slugify("用户偏好用 pnpm"), "用户偏好用-pnpm");
	assert.equal(slugify("Meeting Notes 2026-10-08"), "meeting-notes-2026-10-08");
	assert.match(slugify("!!!"), /^memory-/);
	assert.match(slugify("CON"), /^memory-/, "保留名要兜底");
	assert.ok(slugify("x".repeat(200)).length <= 60);
	ok("slugify：保留中文、折掉标点、兜底、限长");
}

// ---- 4. front matter 往返 -------------------------------------------
console.log("\n[4] front matter 往返");
{
	const text = composeMemory({
		title: "用户偏好用 pnpm", tags: ["工具链", "偏好"],
		created: "2026-10-08T00:00:00.000Z", updated: "2026-10-08T01:00:00.000Z",
		body: "正文第一行\n\n- 要点"
	});
	const parsed = parseMemory(text);
	assert.equal(parsed.meta.title, "用户偏好用 pnpm");
	assert.deepEqual(parsed.meta.tags, ["工具链", "偏好"]);
	assert.equal(parsed.meta.created, "2026-10-08T00:00:00.000Z");
	assert.match(parsed.body, /正文第一行/);
	assert.match(parsed.body, /- 要点/);
	ok("composeMemory → parseMemory 往返一致");

	assert.deepEqual(parseMemory("没有 front matter").meta, {});
	assert.equal(parseMemory("没有 front matter").body, "没有 front matter");
	assert.deepEqual(parseMemory("---\n坏行没有冒号\ntitle: 好行\n---\n正文").meta, { title: "好行" });
	ok("解析容错：无 front matter、坏行被忽略");
}

// ---- 5. 索引是投影 ---------------------------------------------------
console.log("\n[5] 扫描与索引");
{
	const root = join(ROOT, "index-probe");
	await mkdir(join(root, "项目约定"), { recursive: true });
	await writeFile(join(root, "MEMORY.md"), "# 手工写的索引\n", "utf8");
	await writeFile(join(root, "甲.md"), composeMemory({ title: "甲", tags: ["t1"], created: "2026-10-01T00:00:00Z", updated: "2026-10-02T00:00:00Z", body: "甲的正文" }), "utf8");
	await writeFile(join(root, "项目约定", "乙.md"), composeMemory({ title: "乙", tags: [], created: "2026-10-03T00:00:00Z", updated: "2026-10-03T00:00:00Z", body: "乙的正文" }), "utf8");
	await writeFile(join(root, "无头.md"), "没有 front matter 的记忆\n", "utf8");
	await writeFile(join(root, "忽略.txt"), "不是 markdown\n", "utf8");

	const entries = await scanMemories(root, "MEMORY.md");
	const rels = entries.map((e) => e.rel).sort();
	assert.deepEqual(rels, ["无头.md", "甲.md", "项目约定/乙.md"].sort(), "索引文件与非 md 应被排除");
	ok(`扫描到 ${entries.length} 条记忆，排除了索引文件与 .txt`);

	const headless = entries.find((e) => e.rel === "无头.md");
	assert.equal(headless.title, "无头", "没有 front matter 时用文件名（去掉 .md）兜底");
	const grouped = entries.find((e) => e.rel === "项目约定/乙.md");
	assert.equal(grouped.group, "项目约定");
	ok("无 front matter 用文件名兜底；子目录归组正确");

	const md = renderIndex(entries, { root, indexFile: "MEMORY.md", cwd: ROOT, now: "2026-10-08 00:00:00" });
	assert.match(md, /## 未分类/);
	assert.match(md, /## 项目约定\//);
	assert.match(md, /\[甲\]\(\.\/甲\.md\)/);
	assert.match(md, /\[乙\]\(\.\/项目约定\/乙\.md\)/);
	assert.match(md, /共 3 条记忆/);
	assert.match(md, /自动生成/, "必须写明是自动生成的");
	ok("索引按分类分组、带链接与元信息、声明自动生成");

	// 重建索引会覆盖手工内容 —— 这是刻意的（索引是投影，不是账本）
	const settings = resolveSettings({}).settings;
	const out = await writeIndex(root, settings, ROOT, { force: true });
	assert.ok(!(await readFile(out.path, "utf8")).includes("手工写的索引"), "重建应覆盖手工内容");
	ok("重建索引覆盖手工改动（索引是投影，避免与实际内容漂移）");

	// autoIndex=false 时不写盘
	const root2 = join(ROOT, "no-autoindex");
	await mkdir(root2, { recursive: true });
	const off = resolveSettings({ autoIndex: false }).settings;
	await writeIndex(root2, off, ROOT);
	assert.equal(existsSync(join(root2, "MEMORY.md")), false, "autoIndex=false 不应写索引");
	ok("autoIndex=false → 只返回内容不写盘");
}

// ---- 6. apply()：工具与路由 -----------------------------------------
console.log("\n[6] apply() 装配");
{
	const host = makeHost();
	await until(() => host.routes.length === 2 && host.tools.length === 4);
	assert.equal(host.routes.length, 2);
	ok(`路由: ${host.routes.map((r) => r.path).join(" | ")}`);
	assert.deepEqual(host.tools.map((t) => t.name).sort(), TOOL_NAMES.slice().sort());
	ok(`工具: ${TOOL_NAMES.join(", ")}`);
	for (const d of host.disposers) if (typeof d === "function") d();
}

// ---- 7. memory_save --------------------------------------------------
console.log("\n[7] memory_save");
{
	const host = makeHost();
	await until(() => host.tools.length === 4);
	const save = host.tool("memory_save");

	// 未分类 → 直接写根目录
	const r1 = await save.execute(
		{ title: "用户偏好用 pnpm", content: "不要在文档里写 npm。", tags: "工具链, 偏好" },
		host.exec
	);
	assert.equal(r1.path, "memory/用户偏好用-pnpm.md");
	assert.ok(r1.absolutePath.startsWith(host.workspace));
	assert.ok(existsSync(r1.absolutePath));
	assert.equal(r1.overwritten, false);
	assert.equal(r1.category, "");
	ok(`未分类 → 直接写在记忆根目录：${r1.path}`);

	const body1 = await readFile(r1.absolutePath, "utf8");
	assert.match(body1, /^---\ntitle: 用户偏好用 pnpm/);
	assert.match(body1, /tags: 工具链, 偏好/);
	assert.match(body1, /不要在文档里写 npm。/);
	ok("落盘内容含 front matter 与正文");

	// 有分类 → 进子目录
	const r2 = await save.execute(
		{ title: "提交信息用中文", content: "commit message 用中文写。", category: "项目约定" },
		host.exec
	);
	assert.equal(r2.path, "memory/项目约定/提交信息用中文.md");
	assert.ok(existsSync(r2.absolutePath));
	ok(`有分类 → 进子目录：${r2.path}`);

	const r3 = await save.execute(
		{ title: "张三", content: "后端负责人。", category: "people/work" },
		host.exec
	);
	assert.equal(r3.category, "people/work");
	assert.ok(existsSync(r3.absolutePath));
	ok("分类支持多级");

	// 索引自动更新
	const index = await readFile(join(host.workspace, "memory", "MEMORY.md"), "utf8");
	assert.match(index, /用户偏好用 pnpm/);
	assert.match(index, /提交信息用中文/);
	assert.match(index, /## 未分类/);
	assert.match(index, /## 项目约定\//);
	assert.match(index, /## people\/work\//);
	assert.match(index, /共 3 条记忆/);
	ok("每次保存后索引自动重建，分类分组正确");

	// 重名保护
	await assert.rejects(
		() => save.execute({ title: "用户偏好用 pnpm", content: "改了" }, host.exec),
		/记忆已存在/,
		"同名默认应报错而不是静默覆盖"
	);
	ok("同名再存 → 报错（不静默丢内容）");

	const r4 = await save.execute(
		{ title: "用户偏好用 pnpm", content: "换成 pnpm 了。", overwrite: true },
		host.exec
	);
	assert.equal(r4.overwritten, true);
	assert.match(await readFile(r4.absolutePath, "utf8"), /换成 pnpm 了。/);
	assert.equal((await scanMemories(join(host.workspace, "memory"), "MEMORY.md")).length, 3, "覆盖不应新增条目");
	ok("overwrite=true → 覆盖原文件且不新增条目");

	// 校验
	await assert.rejects(() => save.execute({ title: "", content: "x" }, host.exec), /title/);
	await assert.rejects(() => save.execute({ title: "t", content: "   " }, host.exec), /content/);
	await assert.rejects(() => save.execute({ title: "t", content: "x", category: "../逃逸" }, host.exec), /不能是|越界/);
	await assert.rejects(() => save.execute({ title: "t", content: "x", name: "../../evil" }, host.exec), /非法字符|不能是/);
	ok("拒绝空标题 / 空正文 / 穿越式 category 与 name");

	// 超大正文（用一个上限很小的宿主来测，免得真写 256 KB）
	{
		const small = makeHost({ maxEntryBytes: 1024 });
		await until(() => small.tools.length === 4);
		await assert.rejects(
			() => small.tool("memory_save").execute({ title: "大", content: "x".repeat(2000) }, small.exec),
			/过大/,
			"应拒绝超过 maxEntryBytes 的内容"
		);
		// 刚好在上限内应放行
		const fits = await small.tool("memory_save").execute({ title: "刚好", content: "y".repeat(900) }, small.exec);
		assert.ok(fits.bytes <= 1024);
		ok("超出 maxEntryBytes → 拒绝；上限内放行");
		for (const d of small.disposers) if (typeof d === "function") d();
	}

	for (const d of host.disposers) if (typeof d === "function") d();
}

// ---- 8. memory_recall -----------------------------------------------
console.log("\n[8] memory_recall");
{
	const host = makeHost();
	await until(() => host.tools.length === 4);
	const save = host.tool("memory_save");
	const recall = host.tool("memory_recall");

	await save.execute({ title: "甲记忆", content: "甲的内容" }, host.exec);
	await save.execute({ title: "乙记忆", content: "乙的内容", category: "组" }, host.exec);

	const idx = await recall.execute({}, host.exec);
	assert.equal(idx.mode, "index");
	assert.equal(idx.count, 2);
	assert.equal(idx.root, "memory");
	assert.match(idx.markdown, /甲记忆/);
	assert.equal(idx.entries.length, 2);
	ok("不带 name → 返回索引（含分组 markdown 与结构化 entries）");

	const one = await recall.execute({ name: "甲记忆.md" }, host.exec);
	assert.equal(one.mode, "entry");
	assert.equal(one.title, "甲记忆");
	assert.match(one.body, /甲的内容/);
	ok("按文件名读单条");

	const bySuffix = await recall.execute({ name: "乙记忆" }, host.exec);
	assert.equal(bySuffix.title, "乙记忆");
	assert.equal(bySuffix.path, "memory/组/乙记忆.md");
	ok("按唯一后缀匹配（不带 .md、不带目录）");

	const byPath = await recall.execute({ name: "组/乙记忆.md" }, host.exec);
	assert.equal(byPath.title, "乙记忆");
	ok("按相对路径读");

	await assert.rejects(() => recall.execute({ name: "不存在" }, host.exec), /找不到/);
	await assert.rejects(() => recall.execute({ name: "../../../etc/passwd" }, host.exec), /找不到|越界/);
	ok("找不到时报错；穿越式 name 不会读到根目录外");

	// 歧义检测
	await save.execute({ title: "同名", content: "x", category: "组A" }, host.exec);
	await save.execute({ title: "同名", content: "y", category: "组B" }, host.exec);
	await assert.rejects(() => recall.execute({ name: "同名.md" }, host.exec), /匹配到多条/);
	ok("后缀匹配到多条 → 报错并列出候选（不猜）");

	for (const d of host.disposers) if (typeof d === "function") d();
}

// ---- 9. memory_search -----------------------------------------------
console.log("\n[9] memory_search");
{
	const host = makeHost();
	await until(() => host.tools.length === 4);
	const save = host.tool("memory_save");
	const search = host.tool("memory_search");

	await save.execute({ title: "构建工具", content: "这个项目用 Vite 而不是 Webpack。", tags: "前端" }, host.exec);
	await save.execute({ title: "部署", content: "上线走 GitHub Actions。", category: "运维" }, host.exec);

	const hit = await search.execute({ query: "webpack" }, host.exec);
	assert.equal(hit.count, 1);
	assert.equal(hit.results[0].path, "构建工具.md");
	assert.deepEqual(hit.results[0].matchedIn, ["body"], "应大小写不敏感地命中正文");
	assert.match(hit.results[0].excerpt, /Webpack/);
	ok("正文命中（大小写不敏感）+ 摘录");

	const byTitle = await search.execute({ query: "部署" }, host.exec);
	assert.equal(byTitle.count, 1);
	assert.ok(byTitle.results[0].matchedIn.includes("title"));
	ok("标题命中");

	const byTag = await search.execute({ query: "前端" }, host.exec);
	assert.equal(byTag.count, 1);
	assert.ok(byTag.results[0].matchedIn.includes("tags"));
	ok("标签命中");

	const none = await search.execute({ query: "不存在的词" }, host.exec);
	assert.equal(none.count, 0);
	assert.equal(none.scanned, 2);
	ok("无命中时返回 0 条并报告扫描总数");

	await assert.rejects(() => search.execute({ query: "  " }, host.exec), /query/);
	ok("空 query → 报错");

	for (const d of host.disposers) if (typeof d === "function") d();
}

// ---- 10. memory_forget ----------------------------------------------
console.log("\n[10] memory_forget");
{
	const host = makeHost();
	await until(() => host.tools.length === 4);
	const save = host.tool("memory_save");
	const forget = host.tool("memory_forget");
	const recall = host.tool("memory_recall");

	const saved = await save.execute({ title: "临时记忆", content: "用完就删", category: "杂" }, host.exec);
	assert.ok(existsSync(saved.absolutePath));

	const gone = await forget.execute({ name: "杂/临时记忆.md" }, host.exec);
	assert.equal(gone.remaining, 0);
	assert.equal(existsSync(saved.absolutePath), false);
	assert.ok(!(await readFile(join(host.workspace, "memory", "MEMORY.md"), "utf8")).includes("临时记忆"));
	ok("删除文件并同步重建索引");

	await assert.rejects(() => forget.execute({ name: "不存在.md" }, host.exec), /找不到/);
	await assert.rejects(() => forget.execute({ name: "临时记忆" }, host.exec), /\.md/);
	await assert.rejects(() => forget.execute({ name: "MEMORY.md" }, host.exec), /索引文件/);
	await assert.rejects(() => forget.execute({ name: "../../evil.md" }, host.exec), /找不到|越界/);
	ok("拒绝：不存在的文件 / 非 .md / 索引本身 / 穿越路径");

	// 确保不会误删目录
	await save.execute({ title: "保住", content: "x", category: "目录" }, host.exec);
	await assert.rejects(() => forget.execute({ name: "目录" }, host.exec), /\.md/);
	assert.ok(existsSync(join(host.workspace, "memory", "目录")), "目录必须还在");
	ok("非 .md 一律拒绝，目录不会被删");

	for (const d of host.disposers) if (typeof d === "function") d();
}

// ---- 11. 多个工作区互相隔离 ------------------------------------------
console.log("\n[11] 工作区隔离");
{
	const hostA = makeHost();
	const hostB = makeHost();
	await until(() => hostA.tools.length === 4 && hostB.tools.length === 4);
	await hostA.tool("memory_save").execute({ title: "只属于A", content: "A 的秘密" }, hostA.exec);
	await hostB.tool("memory_save").execute({ title: "只属于B", content: "B 的秘密" }, hostB.exec);

	const idxA = await hostA.tool("memory_recall").execute({}, hostA.exec);
	const idxB = await hostB.tool("memory_recall").execute({}, hostB.exec);
	assert.equal(idxA.count, 1);
	assert.equal(idxB.count, 1);
	assert.match(idxA.markdown, /只属于A/);
	assert.ok(!idxA.markdown.includes("只属于B"), "A 的工作区不应看到 B 的记忆");
	ok("不同工作区的记忆完全隔离（cwd 来自 exec.agent.session.header.cwd）");

	for (const h of [hostA, hostB]) for (const d of h.disposers) if (typeof d === "function") d();
}

// ---- 12. 自定义 root 与 enabled=false -------------------------------
console.log("\n[12] 自定义 root 与停用");
{
	const host = makeHost({ root: "notes/mem" });
	await until(() => host.tools.length === 4);
	const r = await host.tool("memory_save").execute({ title: "x", content: "y" }, host.exec);
	assert.ok(r.absolutePath.startsWith(join(host.workspace, "notes", "mem")), r.absolutePath);
	ok(`自定义 root 生效：${r.absolutePath.replace(host.workspace, "<ws>")}`);
	for (const d of host.disposers) if (typeof d === "function") d();

	const off = makeHost({ enabled: false });
	await until(() => off.routes.length === 2);
	assert.equal(off.tools.length, 0);
	ok("enabled=false → 路由仍在（面板能开），工具一个都不注册");
	for (const d of off.disposers) if (typeof d === "function") d();
}

// ---- 13. 面板路由 ---------------------------------------------------
console.log("\n[13] 面板路由");
{
	const host = makeHost();
	await until(() => host.routes.length === 2 && host.tools.length === 4);
	const stateRoute = host.routes.find((r) => r.path.endsWith("/state"));
	const settingsRoute = host.routes.find((r) => r.path.endsWith("/settings"));

	const res = makeResponse();
	await stateRoute.handler(makeRequest("GET", { host: "localhost" }), res);
	const state = JSON.parse(res.body);
	assert.equal(state.ok, true);
	assert.equal(state.plugin.name, pkg);
	assert.equal(state.plugin.entry, name);
	assert.equal(state.registeredTools.length, 4);
	assert.equal(state.effective.root, "memory");
	ok("GET state → 只读快照 + 已注册工具");

	const refused = makeResponse();
	await stateRoute.handler(makeRequest("GET", { host: "evil.example" }), refused);
	assert.equal(refused.status, 403);
	const badMethod = makeResponse();
	await stateRoute.handler(makeRequest("DELETE", { host: "localhost" }), badMethod);
	assert.equal(badMethod.status, 405);
	ok("非回环 → 403；非 GET → 405");

	const put = makeResponse();
	await settingsRoute.handler(makeRequest("POST", { host: "localhost" }, { field: "root", value: "记忆库" }), put);
	assert.equal(JSON.parse(put.body).effective.root, "记忆库");
	ok("POST settings 改 root → 生效");

	const badRoot = makeResponse();
	await settingsRoute.handler(makeRequest("POST", { host: "localhost" }, { field: "root", value: "../逃" }), badRoot);
	const badBody = JSON.parse(badRoot.body);
	assert.equal(badBody.effective.root, "memory", "非法 root 应回落");
	assert.match(badBody.configError, /root/);
	ok("写入非法 root → 回落并回报 configError");

	const unknown = makeResponse();
	await settingsRoute.handler(makeRequest("POST", { host: "localhost" }, { field: "nope", value: 1 }), unknown);
	assert.equal(unknown.status, 400);
	const nulled = makeResponse();
	await settingsRoute.handler(makeRequest("POST", { host: "localhost" }, { field: "root", value: null }), nulled);
	assert.equal(JSON.parse(nulled.body).effective.root, "memory");
	ok("未知字段 → 400；value=null → 删除覆盖回落默认值");

	// 停用后工具要立刻消失
	const disable = makeResponse();
	await settingsRoute.handler(makeRequest("POST", { host: "localhost" }, { field: "enabled", value: false }), disable);
	assert.equal(host.tools.length, 0, "停用后应立刻注销工具");
	ok("POST enabled=false → 工具立即注销（无需重启）");

	for (const d of host.disposers) if (typeof d === "function") d();
}

// ---- 14. 降级与工具函数 ---------------------------------------------
console.log("\n[14] 降级与纯函数");
{
	const ctx = { logger: { warn() {} }, get() { return undefined; }, effect(fn) { return fn(); }, once() {} };
	let threw = null;
	try { apply(ctx, {}); } catch (e) { threw = e; }
	assert.equal(threw, null, `apply() 不应抛错: ${threw?.message}`);
	ok("无 webServer / tools → apply() 不抛错");

	assert.equal(registerRoutes({ get() { return undefined; } }, { settings: {}, logger: null }), null);
	ok("registerRoutes 无 webServer → 返回 null");

	assert.equal(cwdOf({}), process.cwd(), "没有会话时回落到进程 cwd");
	assert.equal(cwdOf({ agent: { session: { header: { cwd: "C:/x" } } } }), "C:/x");
	assert.equal(cwdOf({ agent: { session: { header: { cwd: "" } } } }), process.cwd());
	ok("cwdOf：有会话用会话 cwd，否则回落");

	assert.equal(memoryRoot("C:/x", { root: "memory" }), resolve("C:/x", "memory"));
	assert.equal(memoryRoot("C:/x", { root: "a/b" }), resolve("C:/x", "a", "b"));
	ok("memoryRoot 拼接多级 root");

	assert.ok(stateDirectory().endsWith(join("state", pkg)));
	ok(`状态目录 → ${stateDirectory()}`);

	// FileStore 稀疏覆盖
	const store = new FileStore({ dir: join(ROOT, "store-probe"), file: "settings.json" });
	assert.deepEqual(await store.read(), {});
	await store.mutate((c) => ({ ...c, root: "x" }));
	assert.deepEqual(await store.read(), { root: "x" });
	await store.mutate((c) => { const n = { ...c }; delete n.root; return n; });
	assert.deepEqual(await store.read(), {});
	ok("FileStore 稀疏覆盖：删除即回落");

	// 工具表里绝不该出现删除目录/写任意路径的工具
	assert.deepEqual(TOOL_NAMES, ["memory_save", "memory_recall", "memory_search", "memory_forget"]);
	ok("工具表固定为四个（没有任意路径写入/删除的能力）");
}

await rm(ROOT, { recursive: true, force: true });
console.log(`\n宿主全部通过（${passed} 项断言组）`);
