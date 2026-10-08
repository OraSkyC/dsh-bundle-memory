/**
 * dsh-bundle-memory —— 浏览器半侧。
 *
 * 在「设置 → 插件 → 记忆管理」页里渲染一张配置卡。
 * 与宿主之间只有两个端点：
 *   GET  /api/dsh-bundle-memory/state     读状态（只读）
 *   POST /api/dsh-bundle-memory/settings  写一个字段（null = 删除覆盖，回落部署默认值）
 *
 * 写法约定（与仓库里其它 DSH 插件一致）：
 *   - 整个文件是一个 IIFE，返回一个模块对象；
 *   - REGISTRATION = { id, factory } 通过 window.__ModuleLoader__.load() 注册；
 *   - React 由 factory 收到的 loaderRequire("react") 交进来，不是依赖。
 *
 * 样式只用 @deepseek-ai/dsh-client-ui-theme 里**真实存在**的 --dsw-* 变量：
 * 写错一个变量名会让整条 CSS 声明被判非法、静默失效，界面上不会有任何报错。
 *
 * @module dsh-bundle-memory/client
 */
var dsh_bundle_memory_client = (function () {

	const NS = "dsh-bundle-memory";
	const STATE_PATH = "/api/" + NS + "/state";
	const SETTINGS_PATH = "/api/" + NS + "/settings";

	/* ------------------------------------------------------------------ */
	/* 文案                                                                 */
	/* ------------------------------------------------------------------ */
	const zh = {
		"panel.title": "记忆管理",
		"panel.subtitle": "给智能体一个跟着工作区走的记忆库。",
		"panel.loading": "读取中…",
		"panel.error": "读取失败：{error}",
		"panel.updated": "更新于 {time}",
		"panel.refresh": "刷新",
		"panel.configError": "配置有误：{error}",
		"panel.disabled": "插件已停用：不注册任何记忆工具。",
		"section.status": "状态",
		"section.storage": "存储位置",
		"section.limits": "限额",
		"section.expand": "展开",
		"section.collapse": "收起",
		"status.tools": "已注册的工具",
		"status.toolsNone": "无",
		"status.entry": "宿主 entry",
		"status.layout": "目录结构",
		"status.layoutValue": "{root}/MEMORY.md + 记忆文件",
		"status.note": "记忆根目录相对于「当前会话的工作目录」。面板本身不属于任何会话，所以这里只能显示相对路径 —— 每个工作区各有自己的一份记忆。",
		"field.enabled": "启用插件",
		"field.enabledHint": "关闭后不注册任何记忆工具，面板仍可打开。",
		"field.root": "记忆根目录",
		"field.rootHint": "相对于会话工作目录，最多 3 级（如 memory 或 notes/mem）。默认放在工作目录下的 ./memory/。",
		"field.indexFile": "索引文件名",
		"field.indexFileHint": "位于记忆根目录下。插件每次保存记忆后都会重新生成它 —— 索引是磁盘内容的投影，不是独立账本。",
		"field.autoIndex": "自动重建索引",
		"field.autoIndexHint": "每次保存或删除记忆后重写索引。关掉后只有你自己放进去的文件会出现在索引里，需要用 memory_recall 触发一次。",
		"field.maxEntryBytes": "单条记忆上限（字节）",
		"field.maxEntryBytesHint": "取值范围 {min}–{max}。防止一次把整个大文件塞进一条记忆。",
		"field.searchMaxResults": "搜索默认返回条数",
		"field.searchMaxResultsHint": "取值范围 {min}–{max}。工具调用时仍可用 limit 参数覆盖。",
		"action.save": "保存",
		"action.saving": "保存中…",
		"action.reset": "恢复默认",
		"action.resetting": "恢复中…",
		"action.saved": "已保存",
		"action.saveError": "保存失败：{error}",
		"action.dirty": "未保存",
		"switch.on": "已开启",
		"switch.off": "已关闭"
	};
	const en = {
		"panel.title": "Memory",
		"panel.subtitle": "A memory store that travels with each workspace.",
		"panel.loading": "Loading…",
		"panel.error": "Failed to load: {error}",
		"panel.updated": "Updated {time}",
		"panel.refresh": "Refresh",
		"panel.configError": "Invalid config: {error}",
		"panel.disabled": "Plugin disabled: no memory tools are registered.",
		"section.status": "Status",
		"section.storage": "Storage",
		"section.limits": "Limits",
		"section.expand": "Expand",
		"section.collapse": "Collapse",
		"status.tools": "Registered tools",
		"status.toolsNone": "none",
		"status.entry": "Host entry",
		"status.layout": "Layout",
		"status.layoutValue": "{root}/MEMORY.md + memory files",
		"status.note": "The memory root is relative to \"the current session's working directory\". This panel belongs to no session, so only the relative path is shown — every workspace gets its own memory.",
		"field.enabled": "Enable plugin",
		"field.enabledHint": "When off, no memory tools are registered; the panel still opens.",
		"field.root": "Memory root",
		"field.rootHint": "Relative to the session working directory, at most 3 levels (e.g. memory or notes/mem). Defaults to ./memory/ under the working directory.",
		"field.indexFile": "Index file name",
		"field.indexFileHint": "Lives inside the memory root. It is regenerated after every save — the index is a projection of what is on disk, not a separate ledger.",
		"field.autoIndex": "Rebuild the index automatically",
		"field.autoIndexHint": "Rewrite the index after every save or delete. With this off, only files you place yourself show up, until a memory_recall triggers a rebuild.",
		"field.maxEntryBytes": "Max bytes per memory",
		"field.maxEntryBytesHint": "Range {min}–{max}. Stops a single call from dumping a huge file into one memory.",
		"field.searchMaxResults": "Default search results",
		"field.searchMaxResultsHint": "Range {min}–{max}. A tool call can still override it with limit.",
		"action.save": "Save",
		"action.saving": "Saving…",
		"action.reset": "Reset",
		"action.resetting": "Resetting…",
		"action.saved": "Saved",
		"action.saveError": "Save failed: {error}",
		"action.dirty": "Unsaved",
		"switch.on": "On",
		"switch.off": "Off"
	};

	/* ------------------------------------------------------------------ */
	/* HTTP                                                                 */
	/* ------------------------------------------------------------------ */
	async function getJson(path) {
		const response = await fetch(path, { headers: { accept: "application/json" }, cache: "no-store" });
		const body = await response.json().catch(() => null);
		return { status: response.status, body };
	}
	async function postJson(path, payload) {
		const response = await fetch(path, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			cache: "no-store",
			body: JSON.stringify(payload)
		});
		const body = await response.json().catch(() => null);
		return { status: response.status, body };
	}
	async function postJsonOrThrow(path, payload) {
		const { status, body } = await postJson(path, payload);
		if (body === null || body.ok !== true) {
			throw new Error(typeof body?.error === "string" ? body.error : "HTTP " + status);
		}
		return body;
	}

	/* ------------------------------------------------------------------ */
	/* React（由 loader 注入）                                              */
	/* ------------------------------------------------------------------ */
	let api = null;
	function provideClientReact(value) {
		if (typeof value !== "object" || value === null) {
			throw new Error("client: the loader did not hand over a react module");
		}
		api = value;
	}
	function reactApi() {
		if (api === null) throw new Error("client: react used before clientFactory ran");
		return api;
	}
	const h = (type, props, ...children) => reactApi().createElement(type, props, ...children);
	const useState = (initial) => reactApi().useState(initial);
	const useEffect = (effect, deps) => reactApi().useEffect(effect, deps);
	const useCallback = (callback, deps) => reactApi().useCallback(callback, deps);
	const useRef = (initial) => reactApi().useRef(initial);

	/* ------------------------------------------------------------------ */
	/* 样式（只用真实存在的 --dsw-* token）                                  */
	/* ------------------------------------------------------------------ */
	const CONTROL_HEIGHT = 32;
	const BUTTON = {
		display: "inline-flex",
		alignItems: "center",
		justifyContent: "center",
		gap: 6,
		height: CONTROL_HEIGHT,
		padding: "0 12px",
		borderRadius: "var(--dsw-radius-md, 8px)",
		border: "1px solid var(--dsw-alias-border-l2)",
		background: "var(--dsw-alias-bg-layer-2)",
		color: "var(--dsw-alias-label-primary)",
		fontSize: 13,
		fontWeight: 500,
		fontFamily: "inherit",
		lineHeight: 1,
		whiteSpace: "nowrap",
		cursor: "pointer",
		transition: "background .12s ease, border-color .12s ease, opacity .12s ease"
	};
	const S = {
		page: {
			flex: "1 1 auto",
			height: "100%",
			minHeight: 0,
			display: "flex",
			flexDirection: "column",
			overflow: "hidden",
			color: "var(--dsw-alias-label-primary)",
			fontSize: 14,
			lineHeight: "22px"
		},
		header: { flex: "none", display: "flex", alignItems: "flex-start", gap: 12, padding: "16px 0 12px" },
		titleBlock: { flex: 1, minHeight: 0 },
		title: { margin: 0, fontSize: 20, fontWeight: 600, lineHeight: "28px" },
		subtitle: { margin: "2px 0 0", fontSize: 13, color: "var(--dsw-alias-label-secondary)" },
		updated: { color: "var(--dsw-alias-label-secondary)", fontSize: 12, whiteSpace: "nowrap" },
		versionChip: {
			display: "inline-block",
			marginLeft: 8,
			padding: "0 7px",
			borderRadius: 999,
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-bg-layer-2)",
			color: "var(--dsw-alias-label-secondary)",
			fontSize: 12,
			fontWeight: 400,
			lineHeight: "19px",
			verticalAlign: "middle",
			cursor: "help"
		},
		scroll: { flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden" },
		content: { padding: "6px 0 56px" },
		cluster: { display: "inline-flex", alignItems: "center", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" },

		button: BUTTON,
		buttonHover: { background: "var(--dsw-alias-interactive-bg-hover)", borderColor: "var(--dsw-alias-border-l3)" },
		buttonPrimary: {
			...BUTTON,
			background: "var(--dsw-alias-button-primary-fill)",
			borderColor: "transparent",
			color: "var(--dsw-alias-label-primary-foreground)",
			fontWeight: 600
		},
		buttonPrimaryHover: { background: "var(--dsw-alias-button-primary-hover)" },
		buttonGhost: {
			...BUTTON,
			background: "transparent",
			borderColor: "transparent",
			color: "var(--dsw-alias-label-secondary)"
		},
		buttonGhostHover: { background: "var(--dsw-alias-interactive-bg-hover)", color: "var(--dsw-alias-label-primary)" },
		buttonDisabled: { opacity: 0.45, cursor: "default" },

		notice: {
			display: "flex",
			alignItems: "flex-start",
			gap: 8,
			margin: "0 0 14px",
			padding: "10px 14px",
			borderRadius: "var(--dsw-radius-md, 8px)",
			fontSize: 13,
			lineHeight: "20px",
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-bg-layer-2)",
			color: "var(--dsw-alias-label-secondary)"
		},
		noticeBad: {
			display: "flex",
			alignItems: "flex-start",
			gap: 8,
			margin: "0 0 14px",
			padding: "10px 14px",
			borderRadius: "var(--dsw-radius-md, 8px)",
			fontSize: 13,
			lineHeight: "20px",
			border: "1px solid var(--dsw-alias-state-error-primary)",
			background: "var(--dsw-alias-bg-layer-2)",
			color: "var(--dsw-alias-state-error-primary)"
		},

		sectionCard: {
			border: "1px solid var(--dsw-alias-border-l1)",
			borderRadius: "var(--dsw-radius-lg, 12px)",
			background: "var(--dsw-alias-bg-layer-1)",
			overflow: "hidden",
			marginTop: 16
		},
		sectionHead: {
			display: "flex",
			alignItems: "center",
			gap: 10,
			width: "100%",
			padding: "12px 16px",
			background: "none",
			border: "none",
			cursor: "pointer",
			textAlign: "left",
			font: "inherit",
			color: "inherit"
		},
		sectionHeadTitle: { flex: 1, minWidth: 0, fontSize: 15, fontWeight: 600 },
		sectionBody: { padding: "4px 16px 16px" },

		fieldGrid: {
			display: "grid",
			gridTemplateColumns: "minmax(110px, 190px) minmax(0, 1fr)",
			gap: "4px 20px",
			alignItems: "start",
			padding: "14px 0",
			borderTop: "1px solid var(--dsw-alias-border-l1)"
		},
		fieldGridFirst: {
			display: "grid",
			gridTemplateColumns: "minmax(110px, 190px) minmax(0, 1fr)",
			gap: "4px 20px",
			alignItems: "start",
			padding: "6px 0 14px"
		},
		fieldLabel: { fontSize: 13, fontWeight: 600, lineHeight: "20px", color: "var(--dsw-alias-label-primary)" },
		fieldHint: { marginTop: 3, fontSize: 12, lineHeight: "17px", color: "var(--dsw-alias-label-tertiary)" },
		fieldControl: { minWidth: 0 },
		fieldActions: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 8 },
		value: { fontSize: 13, lineHeight: "20px", overflowWrap: "anywhere", wordBreak: "break-word" },
		valueMuted: {
			fontSize: 13,
			lineHeight: "20px",
			color: "var(--dsw-alias-label-secondary)",
			overflowWrap: "anywhere",
			wordBreak: "break-word"
		},
		code: {
			display: "inline",
			fontFamily: "var(--dsw-font-markdown-code-font-family, ui-monospace, SFMono-Regular, Menlo, monospace)",
			fontSize: 12,
			padding: "1px 6px",
			borderRadius: "var(--dsw-radius-xs, 4px)",
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-markdown-inline-code, var(--dsw-alias-bg-layer-2))",
			overflowWrap: "anywhere",
			wordBreak: "break-word"
		},
		toolChip: {
			display: "inline-block",
			margin: "0 6px 6px 0",
			padding: "0 8px",
			borderRadius: 999,
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-bg-layer-2)",
			fontFamily: "var(--dsw-font-markdown-code-font-family, ui-monospace, monospace)",
			fontSize: 12,
			lineHeight: "20px"
		},
		input: {
			width: "100%",
			minWidth: 0,
			height: CONTROL_HEIGHT,
			padding: "0 10px",
			borderRadius: "var(--dsw-radius-md, 8px)",
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-bg-base)",
			color: "var(--dsw-alias-label-primary)",
			fontFamily: "inherit",
			fontSize: 13,
			outline: "none",
			transition: "border-color .12s ease"
		},
		inputFocus: { borderColor: "var(--dsw-alias-brand-primary)" },

		// 与 DSH 自带开关组件（web-frontend 的 ._switch_1ik0f_5）完全一致
		switchTrack: {
			boxSizing: "border-box",
			position: "relative",
			flex: "0 0 auto",
			width: 36,
			height: 20,
			padding: 2,
			border: 0,
			borderRadius: 999,
			cursor: "pointer",
			transition: "background .12s ease"
		},
		switchTrackOn: { background: "var(--dsw-alias-brand-primary)" },
		switchTrackOff: { background: "var(--dsw-alias-border-l3)" },
		switchTrackFocus: {
			outline: "var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))",
			outlineOffset: 2
		},
		switchThumb: {
			display: "block",
			width: 16,
			height: 16,
			borderRadius: "50%",
			background: "var(--dsw-alias-label-primary-foreground)",
			transition: "transform .12s ease, background .12s ease"
		},
		switchThumbOn: { transform: "translateX(16px)" },
		switchThumbOff: { background: "var(--dsw-alias-switch-thumb)" },
		switchTextOn: { fontSize: 13, color: "var(--dsw-alias-label-primary)" },
		switchTextOff: { fontSize: 13, color: "var(--dsw-alias-label-tertiary)" },

		dirty: { fontSize: 12, color: "var(--dsw-alias-state-warn-label)", whiteSpace: "nowrap" },
		saved: { fontSize: 12, color: "var(--dsw-alias-state-success-primary)", whiteSpace: "nowrap" },
		error: { fontSize: 12, color: "var(--dsw-alias-state-error-primary)", overflowWrap: "anywhere" }
	};

	/* ------------------------------------------------------------------ */
	/* 小组件                                                               */
	/* ------------------------------------------------------------------ */
	function Button({ variant = "secondary", disabled, onClick, children, title, label }) {
		const [hover, setHover] = useState(false);
		const base = variant === "primary" ? S.buttonPrimary : variant === "ghost" ? S.buttonGhost : S.button;
		const hoverStyle = variant === "primary"
			? S.buttonPrimaryHover
			: variant === "ghost" ? S.buttonGhostHover : S.buttonHover;
		const off = disabled === true;
		return h("button", {
			type: "button",
			style: off ? { ...base, ...S.buttonDisabled } : hover ? { ...base, ...hoverStyle } : base,
			disabled: off,
			title,
			"aria-label": label,
			onClick: off ? undefined : onClick,
			onMouseEnter: () => setHover(true),
			onMouseLeave: () => setHover(false)
		}, children);
	}

	function SectionCard({ title, open, onToggle, children, tt }) {
		return h("div", { style: S.sectionCard },
			h("button", {
				type: "button",
				style: S.sectionHead,
				"aria-expanded": open,
				"aria-label": tt(open ? "section.collapse" : "section.expand") + ": " + title,
				onClick: onToggle
			},
				h("span", { style: S.sectionHeadTitle }, title),
				h("svg", {
					viewBox: "0 0 16 16",
					width: 14,
					height: 14,
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 1.5,
					strokeLinecap: "round",
					strokeLinejoin: "round",
					"aria-hidden": "true",
					style: { transition: "transform .15s ease", transform: open ? "rotate(180deg)" : "none" }
				}, h("path", { d: "M4 6l4 4 4-4" }))
			),
			open ? h("div", { style: S.sectionBody }, children) : null
		);
	}

	function StatusRow({ label, value, muted, first, children }) {
		return h("div", { style: first ? S.fieldGridFirst : S.fieldGrid },
			h("div", { style: S.fieldLabel }, label),
			h("div", { style: S.fieldControl },
				children !== undefined
					? children
					: h("div", { style: muted ? S.valueMuted : S.value }, value))
		);
	}

	function clock(ms) {
		if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "";
		const date = new Date(ms);
		const pad = (n) => String(n).padStart(2, "0");
		return pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
	}

	function BoolField({ name, label, hint, value, disabled, tt }) {
		const [busy, setBusy] = useState(false);
		const [error, setError] = useState(null);
		const [notice, setNotice] = useState(null);
		const [focused, setFocused] = useState(false);
		const flash = (kind, message) => {
			setNotice({ kind, message });
			setTimeout(() => setNotice(null), 2200);
		};
		const toggle = useCallback(async (next) => {
			if (busy) return;
			setBusy(true);
			setError(null);
			setNotice(null);
			try {
				await postJsonOrThrow(SETTINGS_PATH, { field: name, value: next });
				flash("ok", tt("action.saved"));
			} catch (reason) {
				setError(tt("action.saveError").replace("{error}", reason instanceof Error ? reason.message : String(reason)));
			} finally {
				setBusy(false);
			}
		}, [name, busy, tt]);
		const on = value === true;
		const locked = busy === true || disabled === true;
		return h("div", { style: S.fieldGrid },
			h("div", null,
				h("div", { style: S.fieldLabel }, label),
				hint ? h("div", { style: S.fieldHint }, hint) : null
			),
			h("div", { style: S.fieldControl },
				h("div", { style: S.fieldActions },
					h("button", {
						type: "button",
						role: "switch",
						"aria-checked": on,
						"aria-label": label,
						disabled: locked,
						style: {
							...S.switchTrack,
							...(on ? S.switchTrackOn : S.switchTrackOff),
							...(focused ? S.switchTrackFocus : null),
							...(locked ? S.buttonDisabled : null)
						},
						onClick: () => toggle(!on),
						onFocus: () => setFocused(true),
						onBlur: () => setFocused(false)
					},
						h("span", { style: { ...S.switchThumb, ...(on ? S.switchThumbOn : S.switchThumbOff) } })
					),
					h("span", { style: on ? S.switchTextOn : S.switchTextOff }, tt(on ? "switch.on" : "switch.off")),
					busy ? h("span", { style: S.saved }, tt("action.saving")) : null,
					notice ? h("span", { style: S.saved }, notice.message) : null
				),
				error ? h("div", { style: { ...S.error, marginTop: 6 }, role: "alert" }, error) : null
			)
		);
	}

	function Field({ name, label, hint, value, kind, placeholder, disabled, emptyMeansDefault, tt }) {
		const asText = (v) => (v === undefined || v === null ? "" : String(v));
		const [draft, setDraft] = useState(asText(value));
		const [busy, setBusy] = useState(false);
		const [error, setError] = useState(null);
		const [notice, setNotice] = useState(null);
		const [focused, setFocused] = useState(false);
		useEffect(() => { setDraft(asText(value)); }, [value]);
		const dirty = draft !== asText(value);
		const flash = (kind, message) => {
			setNotice({ kind, message });
			setTimeout(() => setNotice(null), 2200);
		};
		const commit = useCallback(async (payloadValue) => {
			if (busy) return;
			setBusy(true);
			setError(null);
			setNotice(null);
			try {
				await postJsonOrThrow(SETTINGS_PATH, { field: name, value: payloadValue });
				if (payloadValue === null) setDraft("");
				flash("ok", tt("action.saved"));
			} catch (reason) {
				setError(tt("action.saveError").replace("{error}", reason instanceof Error ? reason.message : String(reason)));
			} finally {
				setBusy(false);
			}
		}, [name, busy, tt]);
		return h("div", { style: S.fieldGrid },
			h("div", null,
				h("div", { style: S.fieldLabel }, label),
				hint ? h("div", { style: S.fieldHint }, hint) : null
			),
			h("div", { style: S.fieldControl },
				h("input", {
					style: focused && !disabled ? { ...S.input, ...S.inputFocus } : S.input,
					type: kind === "number" ? "number" : "text",
					value: draft,
					placeholder,
					disabled: disabled || busy,
					"aria-label": label,
					onChange: (event) => setDraft(event.target.value),
					onFocus: () => setFocused(true),
					onBlur: () => setFocused(false)
				}),
				h("div", { style: S.fieldActions },
					h(Button, {
						variant: dirty ? "primary" : "secondary",
						disabled: busy || !dirty,
						onClick: () => commit(draft),
						label: tt("action.save") + " " + label
					}, busy ? tt("action.saving") : tt("action.save")),
					emptyMeansDefault
						? h(Button, {
							variant: "ghost",
							disabled: busy || draft === "",
							onClick: () => commit(null),
							label: tt("action.reset") + " " + label
						}, busy ? tt("action.resetting") : tt("action.reset"))
						: null,
					dirty ? h("span", { style: S.dirty }, tt("action.dirty")) : null,
					notice ? h("span", { style: S.saved }, notice.message) : null
				),
				error ? h("div", { style: { ...S.error, marginTop: 6 }, role: "alert" }, error) : null
			)
		);
	}

	/* ------------------------------------------------------------------ */
	/* 面板主体                                                             */
	/* ------------------------------------------------------------------ */
	function PanelPage({ tt, localeSubscribe }) {
		const [data, setData] = useState(null);
		const [error, setError] = useState(null);
		const [loadedOnce, setLoadedOnce] = useState(false);
		const [updatedAt, setUpdatedAt] = useState(0);
		const [, setLocaleRevision] = useState(0);
		const [openSections, setOpenSections] = useState({ status: true, storage: true, limits: true });
		const generation = useRef(0);
		const inFlight = useRef(null);

		useEffect(() => {
			if (typeof localeSubscribe !== "function") return undefined;
			return localeSubscribe(() => setLocaleRevision((revision) => revision + 1));
		}, [localeSubscribe]);

		const load = useCallback(async () => {
			generation.current += 1;
			const mine = generation.current;
			const isCurrent = () => generation.current === mine;
			inFlight.current?.abort?.();
			const controller = typeof AbortController === "function" ? new AbortController() : null;
			inFlight.current = controller;
			try {
				const { status, body } = await getJson(STATE_PATH);
				if (!isCurrent()) return;
				if (body === null || body.ok !== true) {
					setData(null);
					setError(typeof body?.error === "string" ? body.error : "HTTP " + status);
					return;
				}
				setData(body);
				setError(null);
				setUpdatedAt(Date.now());
			} catch (reason) {
				if (!isCurrent()) return;
				setError(reason instanceof Error ? reason.message : String(reason));
			} finally {
				if (isCurrent()) setLoadedOnce(true);
				if (inFlight.current === controller) inFlight.current = null;
			}
		}, []);

		useEffect(() => {
			let alive = true;
			let timer = null;
			const run = () => { if (alive) load(); };
			const start = () => { if (timer === null) timer = setInterval(run, 30000); };
			const stop = () => { if (timer !== null) { clearInterval(timer); timer = null; } };
			run();
			start();
			const onVisibility = () => {
				if (!alive) return;
				if (document.visibilityState === "hidden") stop();
				else { run(); start(); }
			};
			document.addEventListener("visibilitychange", onVisibility);
			return () => {
				alive = false;
				stop();
				document.removeEventListener("visibilitychange", onVisibility);
			};
		}, [load]);

		const toggleSection = useCallback((key) => {
			setOpenSections((current) => ({ ...current, [key]: !current[key] }));
		}, []);

		const effective = data?.effective ?? {};
		const defaults = data?.defaults ?? {};
		const registered = Array.isArray(data?.registeredTools) ? data.registeredTools : [];
		const disabled = effective.enabled === false;
		const root = String(effective.root ?? defaults.root ?? "memory");

		if (loadedOnce === false) {
			return h("div", { style: S.page },
				h("div", { style: S.header }, h("span", { style: S.subtitle }, tt("panel.loading"))));
		}

		return h("div", { style: S.page },
			h("div", { style: S.header },
				h("div", { style: S.titleBlock },
					h("h2", { style: S.title }, tt("panel.title")),
					h("p", { style: S.subtitle }, tt("panel.subtitle"))
				),
				h("div", { style: S.cluster },
					updatedAt ? h("span", { style: S.updated }, tt("panel.updated").replace("{time}", clock(updatedAt))) : null,
					h(Button, { onClick: () => load(), label: tt("panel.refresh") }, tt("panel.refresh"))
				)
			),
			h("div", { style: S.scroll },
				h("div", { style: S.content },
					error ? h("div", { style: S.noticeBad, role: "alert" },
						tt("panel.error").replace("{error}", error)) : null,
					data && data.configError ? h("div", { style: S.noticeBad, role: "alert" },
						tt("panel.configError").replace("{error}", data.configError)) : null,
					disabled ? h("div", { style: S.notice }, tt("panel.disabled")) : null,

					data && openSections.status ? h(SectionCard, {
						title: tt("section.status"),
						open: true,
						onToggle: () => toggleSection("status"),
						tt
					},
						h(StatusRow, {
							label: tt("status.tools"),
							first: true,
							children: registered.length === 0
								? h("div", { style: S.valueMuted }, tt("status.toolsNone"))
								: h("div", null, registered.map((tool) => h("code", { key: tool, style: S.toolChip }, tool)))
						}),
						h(StatusRow, { label: tt("status.entry"), muted: true, value: String(data?.plugin?.entry ?? "") }),
						h(StatusRow, {
							label: tt("status.layout"),
							children: h("div", null,
								h("code", { style: S.code }, `${root}/${effective.indexFile ?? defaults.indexFile ?? "MEMORY.md"}`),
								h("span", { style: S.valueMuted }, " + 记忆文件"))
						}),
						h("div", { style: { ...S.notice, marginTop: 14, marginBottom: 0 } }, tt("status.note"))
					) : null,

					data && openSections.storage ? h(SectionCard, {
						title: tt("section.storage"),
						open: true,
						onToggle: () => toggleSection("storage"),
						tt
					},
						h(BoolField, {
							name: "enabled",
							label: tt("field.enabled"),
							hint: tt("field.enabledHint"),
							value: effective.enabled,
							tt
						}),
						h(Field, {
							name: "root",
							label: tt("field.root"),
							hint: tt("field.rootHint"),
							value: effective.root,
							kind: "text",
							placeholder: defaults.root,
							disabled: disabled,
							tt
						}),
						h(Field, {
							name: "indexFile",
							label: tt("field.indexFile"),
							hint: tt("field.indexFileHint"),
							value: effective.indexFile,
							kind: "text",
							placeholder: defaults.indexFile,
							disabled: disabled,
							emptyMeansDefault: true,
							tt
						}),
						h(BoolField, {
							name: "autoIndex",
							label: tt("field.autoIndex"),
							hint: tt("field.autoIndexHint"),
							value: effective.autoIndex,
							disabled: disabled,
							tt
						})
					) : null,

					data && openSections.limits ? h(SectionCard, {
						title: tt("section.limits"),
						open: true,
						onToggle: () => toggleSection("limits"),
						tt
					},
						h(Field, {
							name: "maxEntryBytes",
							label: tt("field.maxEntryBytes"),
							hint: tt("field.maxEntryBytesHint").replace("{min}", "1024").replace("{max}", String(4 * 1024 * 1024)),
							value: effective.maxEntryBytes,
							kind: "number",
							disabled: disabled,
							tt
						}),
						h(Field, {
							name: "searchMaxResults",
							label: tt("field.searchMaxResults"),
							hint: tt("field.searchMaxResultsHint").replace("{min}", "1").replace("{max}", "100"),
							value: effective.searchMaxResults,
							kind: "number",
							disabled: disabled,
							tt
						})
					) : null
				)
			)
		);
	}

	/* ------------------------------------------------------------------ */
	/* 挂载                                                                 */
	/* ------------------------------------------------------------------ */
	function apply(ctx) {
		ctx.effect(() => {
			try {
				return ctx.locale.register(NS, { zh, en });
			} catch {
				return () => {};
			}
		}, NS + ": dictionaries");

		let translate = (key) => key;
		try {
			translate = ctx.locale.bind(NS);
		} catch { /* locale 服务不可用时按原文渲染 */ }
		const tt = (key) => {
			try {
				return translate(key);
			} catch {
				return key;
			}
		};

		const disposers = [];
		try {
			disposers.push(ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
				name: "plugins.bundle.config",
				key: NS,
				locale: NS,
				inject: () => ({
					tt,
					localeSubscribe: ctx.locale.subscribe.bind(ctx.locale)
				})
			}, PanelPage)));
		} catch (error) {
			console.warn("[" + NS + "] config card registration failed:", error);
		}
		ctx.effect(() => () => {
			for (const dispose of disposers.splice(0)) try { dispose(); } catch { /* 宿主可能已拆除 */ }
		}, NS + ": ui mounts");
	}

	const inject = ["slots", "locale"];

	function clientFactory(loaderRequire) {
		provideClientReact(loaderRequire("react"));
		return {
			inject,
			apply,
			/** Node 侧测试面：宿主只读 inject/apply。 */
			panel: Object.freeze({
				dictionaries: Object.freeze({ zh, en }),
				styles: S,
				paths: Object.freeze({ NS, STATE_PATH, SETTINGS_PATH }),
				helpers: Object.freeze({ clock }),
				components: Object.freeze({ PanelPage, SectionCard, StatusRow, Field, BoolField, Button })
			})
		};
	}

	const REGISTRATION = { id: NS, factory: clientFactory };
	if (typeof window !== "undefined") {
		const loader = window.__ModuleLoader__;
		if (loader !== undefined) loader.load(REGISTRATION);
	}
	if (typeof module !== "undefined" && module !== null && module.exports !== undefined) {
		module.exports = REGISTRATION;
	}

	return REGISTRATION;
})();
