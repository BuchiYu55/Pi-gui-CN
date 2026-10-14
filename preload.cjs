const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pi", {
	// sessionPath 必须透传：丢了它主进程永远开新会话，历史会话点开只有空白（2026-10-03 实测坑）
	createSession: (cwd, sessionPath) => ipcRenderer.invoke("session:create", cwd, sessionPath),
	// 渲染端 reload 后认领主进程现存会话（刷新不丢对话/不打断任务）
	attachSession: () => ipcRenderer.invoke("session:attach"),
	listCommands: () => ipcRenderer.invoke("commands:list"),
	getState: () => ipcRenderer.invoke("session:state"),
	getModels: () => ipcRenderer.invoke("session:models"),
	setModel: (providerId, modelId) => ipcRenderer.invoke("session:setModel", providerId, modelId),
	sessionThinkingLevels: () => ipcRenderer.invoke("session:thinkingLevels"),
	setThinkingLevel: (level) => ipcRenderer.invoke("session:setThinkingLevel", level),
	steer: (text, images) => ipcRenderer.invoke("session:steer", text, images),
	selfcheck: () => ipcRenderer.invoke("sys:selfcheck"),
	// 消息复制（2026-10-06）：主进程 clipboard 写入
	writeClipboard: (text) => ipcRenderer.invoke("sys:clipboard", text),
	readDir: (dir, showHidden) => ipcRenderer.invoke("fs:readDir", dir, showHidden),
	pathKind: (p) => ipcRenderer.invoke("fs:pathKind", p),
	readFile: (p) => ipcRenderer.invoke("fs:readFile", p),
	searchFiles: (dir, query, showHidden) => ipcRenderer.invoke("fs:searchFiles", dir, query, showHidden),
	openPath: (p) => ipcRenderer.invoke("fs:openPath", p),
	openExternal: (url) => ipcRenderer.invoke("open:external", url),
	gitStatus: (cwd) => ipcRenderer.invoke("git:status", cwd),
	zaiUsage: () => ipcRenderer.invoke("zai:usage"),
	prompt: (text, images, opts) => ipcRenderer.invoke("session:prompt", text, images, opts),
	compact: () => ipcRenderer.invoke("session:compact"),
	openFatalLog: () => ipcRenderer.invoke("app:openFatalLog"),
	ackFatalLog: () => ipcRenderer.invoke("app:ackFatalLog"),
	fatalInfo: () => ipcRenderer.invoke("app:fatalInfo"),
	followUp: (text, images) => ipcRenderer.invoke("session:followUp", text, images),
	abort: () => ipcRenderer.invoke("session:abort"),
	closeSession: (sessionPath) => ipcRenderer.invoke("session:close", sessionPath),
	// /rename：带参数直接改名；无参数主进程用临时会话读历史自动起名
	renameSession: (name) => ipcRenderer.invoke("session:rename", name),
	autoNameSession: () => ipcRenderer.invoke("session:autoName"),
	branches: () => ipcRenderer.invoke("session:branches"),
	navigateBranch: (id) => ipcRenderer.invoke("session:navigate", id),
	scanBranches: (opts) => ipcRenderer.invoke("branches:scanAll", opts),
	navigateToBranch: (file, cwd, leafId) => ipcRenderer.invoke("session:navigateTo", file, cwd, leafId),
	wsList: () => ipcRenderer.invoke("ws:list"),
	wsAdd: (cwd) => ipcRenderer.invoke("ws:add", cwd),
	wsRemove: (id) => ipcRenderer.invoke("ws:remove", id),
	wsSetActive: (id) => ipcRenderer.invoke("ws:setActive", id),
	wsSetColor: (id, color) => ipcRenderer.invoke("ws:setColor", id, color),
	// 压缩档工作区级覆盖（2026-10-09 设计共识批次B3）：keep=null 清除覆盖回落全局档
	wsSetKeep: (cwd, keep) => ipcRenderer.invoke("ws:setKeep", cwd, keep),
	wsFavAdd: (cwd) => ipcRenderer.invoke("ws:favAdd", cwd),
	wsFavRemove: (id) => ipcRenderer.invoke("ws:favRemove", id),
	wsSessions: (cwd) => ipcRenderer.invoke("ws:sessions", cwd),
	// 任务完成强提示：任务栏角标（dataUrl=null 清除；2026-10-07）
	setOverlayIcon: (dataUrl) => ipcRenderer.invoke("win:overlay", dataUrl),
	wsArchive: (p, archived) => ipcRenderer.invoke("ws:archive", p, archived),
	cmpStart: (payload) => ipcRenderer.invoke("cmp:start", payload),
	cmpAbort: () => ipcRenderer.invoke("cmp:abort"),
	// 设置中心：pi.dev 社区包（2026-10-04 R1）
	catalogSearch: (query, type, page) => ipcRenderer.invoke("settings:catalogSearch", query, type, page),
	pkgList: () => ipcRenderer.invoke("settings:pkgList"),
	pkgInstall: (name) => ipcRenderer.invoke("settings:pkgInstall", name),
	pkgWeekly: (opts) => ipcRenderer.invoke("pkg:weekly", opts),
	pkgRemove: (source, scope) => ipcRenderer.invoke("settings:pkgRemove", source, scope),
	// 设置中心 R2：MCP 服务器配置（只读，2026-10-04）
	mcpList: () => ipcRenderer.invoke("mcp:list"),
	// 设置中心 R4：MCP 增删改（op: set|delete|toggle，走主进程权威变更函数，2026-10-05）
	mcpSave: (op, name, config) => ipcRenderer.invoke("mcp:save", op, name, config),
	// 设置中心 R4-2：自定义提供商 models.json（2026-10-05）
	modelsCustomList: () => ipcRenderer.invoke("models:customList"),
	modelsCustomSave: (op, name, config) => ipcRenderer.invoke("models:customSave", op, name, config),
	// 设置中心 R4-3：默认模型（新会话默认，2026-10-05）
	settingsDefaultModel: (op, provider, model) => ipcRenderer.invoke("settings:defaultModel", op, provider, model),
	// 引导向导（2026-10-12 开源阶段 1：首启动配置环境）
	onboardPresets: () => ipcRenderer.invoke("onboard:presets"),
	onboardTest: (preset, baseUrl, apiKey) => ipcRenderer.invoke("onboard:test", preset, baseUrl, apiKey),
	onboardSave: (preset, cfg) => ipcRenderer.invoke("onboard:save", preset, cfg),
	// 三档权限（2026-10-08 zcode 套用批次1）：会话切档 / 新会话默认档 / 纯函数探针（verify 用）
	permSetMode: (entryId, mode) => ipcRenderer.invoke("perm:setMode", entryId, mode),
	permSetDefault: (mode) => ipcRenderer.invoke("perm:setDefault", mode),
	permGetDefault: () => ipcRenderer.invoke("perm:getDefault"),
	permProbe: (mode, toolName) => ipcRenderer.invoke("perm:probe", mode, toolName),
	// ask_user 提问卡（2026-10-08 批次2；同日晚改对话内卡片）
	askAnswer: (sessionId, toolCallId, text) => ipcRenderer.invoke("ask:answer", sessionId, toolCallId, text),
	askPendingList: () => ipcRenderer.invoke("ask:pendingList"),
	askTestDispatch: (params) => ipcRenderer.invoke("ask:testDispatch", params),
	onAsk: (cb) => {
		const listener = (_e, req) => cb(req);
		ipcRenderer.on("ask:request", listener);
		return () => ipcRenderer.removeListener("ask:request", listener);
	},
	// design-gate 通知式提示（2026-10-10 owner 拍板：不弹卡，对话流一嘴）
	onGateNotice: (cb) => {
		const listener = (_e, n) => cb(n);
		ipcRenderer.on("gate:notice", listener);
		return () => ipcRenderer.removeListener("gate:notice", listener);
	},
	// ContextRing 三合一弹层数据（2026-10-08 批次3）
	// wiki 知识图谱（2026-10-08）：工作区双链图/自由会话聚合总图
	wikiGraph: (cwd) => ipcRenderer.invoke("wiki:graph", cwd),
	// 自由浏览器查看器（2026-10-08 阶段二）：web tab 管理与 bounds 同步
	webOpen: (url) => ipcRenderer.invoke("web:open", url),
	webNavigate: (tabId, url) => ipcRenderer.invoke("web:navigate", tabId, url),
	webClose: (tabId) => ipcRenderer.invoke("web:close", tabId),
	webSetBounds: (payload) => ipcRenderer.invoke("web:setBounds", payload),
	webAction: (tabId, action) => ipcRenderer.invoke("web:action", tabId, action),
	webDetachAll: () => ipcRenderer.invoke("web:detachAll"), // reload/崩溃自愈孤儿视图兜底（2026-10-12 甲批）
	webList: () => ipcRenderer.invoke("web:list"), // verify-webtab 专用（生产链路 vwTabs 本地为权威）
	// 浏览器工具验证钩子（PI_GUI_TEST_BROWSER=1 实例才注册）：直调与真实注册同一 execute
	testBrowserTool: (name, params) => ipcRenderer.invoke("web:testTool", name, params),
	// design-gate 测试钩子（PI_GUI_TEST_GATE=1 实例才注册）
	gateProbe: (kind, arg) => ipcRenderer.invoke("gate:probe", kind, arg),
	gateCalls: () => ipcRenderer.invoke("gate:calls"),
	// 随手问辅助对话（2026-10-08 阶段三）：cwd 归属的独立小会话
	auxSend: (cwd, text, withContext) => ipcRenderer.invoke("aux:send", cwd, text, withContext),
	auxAbort: (cwd) => ipcRenderer.invoke("aux:abort", cwd),
	auxState: (cwd) => ipcRenderer.invoke("aux:state", cwd),
	pickFolder: () => ipcRenderer.invoke("dialog:pickFolder"),
	onEvent: (cb) => {
		const listener = (_e, evt) => cb(evt);
		ipcRenderer.on("pi:event", listener);
		return () => ipcRenderer.removeListener("pi:event", listener);
	},
	onState: (cb) => {
		const listener = (_e, s) => cb(s);
		ipcRenderer.on("pi:state", listener);
		return () => ipcRenderer.removeListener("pi:state", listener);
	},
	// 代理行为（2026-10-08 批次②）：默认思考/压缩档 + 通知设置/纯函数探针 + 主题窗口底色同步
	agentGet: () => ipcRenderer.invoke("agent:get"),
	agentSetThinking: (level) => ipcRenderer.invoke("agent:setThinking", level),
	agentSetKeep: (keep) => ipcRenderer.invoke("agent:setKeep", keep),
	notifyGet: () => ipcRenderer.invoke("notify:get"),
	notifySet: (patch) => ipcRenderer.invoke("notify:set", patch),
	notifyProbe: (iso) => ipcRenderer.invoke("notify:probe", iso),
	setThemeBg: (color) => ipcRenderer.invoke("app:themeBg", color),
	// 更新提示（2026-10-08）：主进程 npm 检测结果推送 + 主动拉取（渲染端 init 兜底，防早到丢事件）
	getUpdateState: () => ipcRenderer.invoke("update:state:get"),
	onUpdateState: (cb) => {
		const listener = (_e, s) => cb(s);
		ipcRenderer.on("update:state", listener);
		return () => ipcRenderer.removeListener("update:state", listener);
	},
});
