/**
 * Pi 桌面版 —— Electron 主进程
 * 内嵌 @earendil-works/pi-coding-agent SDK，通过 IPC 与渲染进程通信。
 * 复用全局 pi 安装与 ~/.pi/agent 下的全部配置（凭据/技能/MCP/设置）。
 */
import { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Tray, Menu, nativeImage, Notification, screen, WebContentsView, session } from "electron";
import { pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import pathGuardFactory from "./extensions-builtin/path-guard.mjs"; // 内置扩展（阶段 2 收编）
import notifyFactory from "./extensions-builtin/notify.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** pi SDK 包根目录（2026-10-12 开源改造：SDK 已进 dependencies 本地化，取代写死的 D:/nodejs 全局路径）。
 *  __dirname 直拼 node_modules 相对路径——零解析器依赖（import.meta.resolve 在 Electron ESM 主进程
 *  不可靠、createRequire().resolve 被 pi 的非法数组形态 exports 拒绝，两路皆实测翻车）；
 *  开发态与 electron-builder asar 打包态布局一致（main.js 与 node_modules 同级）均成立 */
let PI_ROOT;
function piRoot() {
  if (PI_ROOT === undefined) {
    const cand = path.resolve(__dirname, "node_modules", "@earendil-works", "pi-coding-agent");
    try {
      fs.accessSync(path.join(cand, "dist", "index.js"));
      PI_ROOT = cand;
    } catch {
      PI_ROOT = false;
    }
  }
  return PI_ROOT || null;
}

/* ---------- Windows PATH 补偿（必须在 import pi 之前执行） ----------
 * 根因：pi SDK 的 bash 工具用 bash -c（非 login）拉起 Git Bash，env 全量继承本进程。
 * 从桌面图标启动时继承系统 PATH——Git 装在非 ProgramFiles 时（如 D:\Git）只有
 * <Git>\cmd 在 PATH，<Git>\usr\bin 不在；非 login bash 不会自己补 /usr/bin，
 * 于是 ls/cat 等全部 command not found(127)。SDK 的 getShellEnv() 是 spawn 时
 * 实时读 process.env，所以这里补 PATH 即可根治（TUI 不受影响）。
 */
function patchPathForGitBash() {
  if (process.platform !== "win32") return;
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "Path";
  const parts = (process.env[pathKey] ?? "").split(";").map((s) => s.trim().replace(/[\\/]+$/, "")).filter(Boolean);
  if (parts.some((p) => /[/\\]usr[/\\]bin$/i.test(p))) return; // 已有 usr/bin，不用补
  // 1) 从 PATH 里的 git.exe 推 Git 根（<root>/cmd/git.exe 或 <root>/bin/git.exe）
  let gitRoot = null;
  for (const p of parts) {
    for (const sub of ["cmd", "bin"]) {
      if (fs.existsSync(path.join(p, sub, "git.exe"))) { gitRoot = path.join(p, sub, ".."); break; }
    }
    if (gitRoot) break;
  }
  // 2) 兑底：常见安装位置
  if (!gitRoot) {
    const candidates = [
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Git"),
      process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Git"),
      "D:\\Git",
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Git"),
    ].filter(Boolean);
    gitRoot = candidates.find((c) => fs.existsSync(path.join(c, "usr", "bin", "bash.exe")));
  }
  if (!gitRoot) return;
  const add = [path.join(gitRoot, "usr", "bin"), path.join(gitRoot, "bin")].filter((p) => fs.existsSync(p));
  if (add.length) {
    process.env[pathKey] = [...add, ...parts].join(";");
    console.log("[path] 补充 Git Bash 工具目录到 PATH:", add.join(";"));
  }
}
patchPathForGitBash();

// 无头静默测试（2026-10-08 owner 拍板：测试实例不弹窗不抢前台、零通知）：
// PI_GUI_CDP_PORT 在场且未显式 PI_GUI_TEST_SHOW=1 时生效（声明前置：createWindow 在下方引用，避免 TDZ 隐患）
// 2026-10-10 owner 拍板加严：凡 PI_GUI_CDP_PORT 在场=测试实例（无论无头还是 SHOW），一律静默——
// 验证/后台任务零横幅零声音；SHOW 只管窗口可见性，不再豁免通知（此前 SHOW 实例完成通知照样弹+出声，
// f60acf5 只落了「少用 SHOW」的纪律条文没堵代码，同日 16:19 实测打扰复发后改代码级强制）
const TEST_SILENT = !!process.env.PI_GUI_CDP_PORT;
const TEST_HEADLESS = TEST_SILENT && process.env.PI_GUI_TEST_SHOW !== "1";

let piLoadError = null;
let piVersion = null;

async function loadPi() {
  try {
    return await import("@earendil-works/pi-coding-agent");
  } catch (e) {
    piLoadError = String(e?.message ?? e);
    return null;
  }
}

const pi = await loadPi();

if (pi) {
  try {
    const root = piRoot();
    if (root) piVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  } catch {
    piVersion = null;
  }
}

let win = null;

/* ---------- 后台常驻（托盘）与关闭确认（2026-10-06 owner 需求） ----------
 * 点窗口 ×：无任务→最小化到托盘驻留（后台任务继续跑）；有任务→确认框
 * （驻留继续 / 退出中断 / 取消）。真退出走托盘菜单「退出」，有任务同样确认；
 * 系统关机/注销经 before-quit 置 isQuitting 放行，不驻留。 */
let tray = null;
let isQuitting = false;
let trayHintShown = false;

/** 内存里正在跑任务的会话（agentRunning 由 agent_start/settled/host_error 驱动） */
function runningEntries() {
  return [...sessionMap.values()].filter((e) => e.agentRunning);
}

function updateTrayTooltip() {
  if (!tray || tray.isDestroyed()) return;
  const n = runningEntries().length;
  tray.setToolTip(n > 0 ? `pi 桌面版 — ${n} 个任务运行中` : "pi 桌面版");
}

function showMainWindow() {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  } else {
    createWindow();
  }
}

function hideToTray() {
  if (!win || win.isDestroyed()) return;
  win.hide();
  updateTrayTooltip();
  console.log("[lifecycle] 最小化到托盘，进程驻留");
  if (!trayHintShown) {
    trayHintShown = true; // 仅首次提示驻留位置，避免每次关闭都打扰
    tray?.displayBalloon?.({
      iconType: "info",
      title: "pi 桌面版",
      content: "已最小化到托盘，任务继续后台执行；点击托盘图标恢复窗口。",
    });
  }
}

function quitApp() {
  isQuitting = true;
  app.quit();
}

/** 退出前二次确认（托盘「退出」等明确退出意图用）；返回 true=继续退出。无任务直接放行 */
async function confirmQuitIfNeeded() {
  const n = runningEntries().length;
  if (n === 0) return true;
  const opts = {
    type: "warning",
    title: "pi 桌面版",
    message: `有 ${n} 个任务正在执行`,
    detail: "退出将中断正在执行的任务。",
    buttons: ["取消", "退出（中断任务）"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const mb = win && !win.isDestroyed() ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
  return mb.response === 1;
}

/** 窗口 × 的关闭流程（close 事件已 preventDefault 后走这里） */
async function handleCloseRequest() {
  const n = runningEntries().length;
  if (n === 0) {
    hideToTray();
    return;
  }
  const opts = {
    type: "warning",
    title: "pi 桌面版",
    message: `有 ${n} 个任务正在执行`,
    detail: "关闭窗口会中断任务；可最小化到托盘，任务继续后台执行。",
    buttons: ["最小化到托盘，任务继续", "仍然退出（中断任务）", "取消"],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  };
  const mb = win && !win.isDestroyed() ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
  if (mb.response === 0) {
    console.log("[lifecycle] 用户选择驻留，任务继续后台执行");
    hideToTray();
  } else if (mb.response === 1) {
    console.log("[lifecycle] 用户确认退出，中断", n, "个任务");
    quitApp();
  } // 2=取消，保持现状
}

function createTray() {
  if (tray) return;
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, "icon.ico"));
    if (img.isEmpty()) throw new Error("icon.ico 读取为空");
    tray = new Tray(img.resize({ width: 32 })); // 托盘小图标，高 DPI 下 32px 更清晰
    updateTrayTooltip();
    tray.on("click", () => showMainWindow());
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "显示主窗口", click: () => showMainWindow() },
        { type: "separator" },
        {
          label: "退出",
          click: () => {
            void (async () => {
              if (await confirmQuitIfNeeded()) quitApp();
            })();
          },
        },
      ])
    );
    console.log("[tray] 托盘就绪");
  } catch (err) {
    // 托盘不可用时降级：点 × 不驻留（否则窗口消失无入口找回），走确认后退出
    tray = null;
    console.error("[tray] 托盘创建失败，关闭行为降级为确认退出:", err?.message ?? err);
  }
}

/* 主进程未捕获异常兜底（2026-10-04）：默认行为是模态弹窗并卡死退出流程——
   曾因 second-instance 访问已销毁窗口连弹错误框、进程变僵尸。改为记日志不弹窗，
   会话状态在主进程，进程活着比死了好。
   2026-10-07 加落盘：owner 报闪退但 stdout 随启动方式丢失，append 到 userData/run.err.log 留证据 */
/* B3 启动自检（2026-10-07 优化计划）：启动读 userData/run.err.log，有未确认 fatal
   → 渲染端提示条（查看日志一键打开）。确认动作（查看或×）= 重命名 .acked 留现场，
   下次启动不再提示；新 fatal 再落新 run.err.log。让静默事故可见化（owner 报闪退但 stdout 随启动方式丢失）。 */
let unackedFatal = null;
// 自证无害的已知事件（如 dispose-timeout：超时弃子、会话数据不受影响）：留痕但不触发「异常记录」提醒，
// 否则每次退出都产生一条，下次启动设置→日志 tab 常驻 warn 高亮（2026-10-08 owner 报「设置页坏了」的误报源）
const BENIGN_FATAL_KINDS = new Set(["dispose-timeout"]);
function lastAlarmLine(text) {
  const lines = text.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^\[([^\]]+)\]\s*\[([^\]]+)\]/);
    if (!m || !BENIGN_FATAL_KINDS.has(m[2])) return { line: lines[i], kind: m?.[2] ?? "unknown", time: m?.[1] ?? "?" };
  }
  return null;
}
function readUnackedFatal() {
  try {
    const p = path.join(app.getPath("userData"), "run.err.log");
    const text = fs.readFileSync(p, "utf8").trim();
    if (!text) return null;
    const alarm = lastAlarmLine(text);
    if (!alarm) return null; // 全部是已知无害事件，不当作异常
    return { path: p, kind: alarm.kind, time: alarm.time };
  } catch { return null; }
}
function ackFatalLog() {
  unackedFatal = null;
  try {
    const p = path.join(app.getPath("userData"), "run.err.log");
    if (fs.existsSync(p)) fs.renameSync(p, p + ".acked"); // 保留现场供回查，下次不再提示
  } catch (err) { console.error("[b3] ack 失败:", err?.message ?? err); }
}

function logFatal(kind, err) {
  console.error("[main:" + kind + "]", err);
  try {
    const line = `[${new Date().toISOString()}] [${kind}] ${String(err?.stack ?? err)}\n`;
    fs.appendFileSync(path.join(app.getPath("userData"), "run.err.log"), line);
  } catch { /* userData 不可写时只能 console */ }
}
process.on("uncaughtException", (err) => logFatal("uncaughtException", err));
try {
  process.on("unhandledRejection", (reason) => logFatal("unhandledRejection", reason));
} catch { /* 忽略 */ }

/* ---- 多会话注册表（2026-10-03）：每个会话独立 entry 并行存活，切换只换指针、绝不 abort ——
   新会话/切历史会话都不打断正在跑的任务；事件经 subscribe 打上 sessionId，渲染端按当前会话过滤 ---- */
const sessionMap = new Map(); // id -> { id, session, resourceLoader, mcpPollTimer, cwd, sessionPath, agentRunning }
let currentKey = null;
let keySeq = 0;
let currentCwd = null; // 当前视图会话的 cwd（git:status / zai:usage 等默认目录用）
function cur() { return sessionMap.get(currentKey) ?? null; }
function curSession() { return cur()?.session ?? null; }

/* ---------- 更新检测（2026-10-08 owner 需求：logo 右侧更新提示框） ----------
 * 出站目标仅 registry.npmjs.org（npm CLI 同源，owner 已拍板）；失败一律静默，绝不阻塞启动。
 * 节流：24h 内复用 userData 缓存不重复打 npm；PI_GUI_TEST_UPDATE 环境变量强制指定 latest（仅测试）。 */
const UPDATE_CHECK_URL = "https://registry.npmjs.org/@earendil-works/pi-coding-agent/latest";
const UPDATE_TTL_MS = 24 * 3600 * 1000;
let updateState = null; // { current, latest }

// 版本号比较：latest > current 返回 true；只按 major.minor.patch 数字比，容错前缀（v1.2.3）
function isNewerPiVersion(latest, current) {
  const num = (v) => String(v || "").replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  if (!latest || !current) return false;
  const a = num(latest), b = num(current);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

function updateCacheFile() { return path.join(app.getPath("userData"), "update-check.json"); }
function readUpdateCache() {
  try { return JSON.parse(fs.readFileSync(updateCacheFile(), "utf8")); } catch { return null; }
}

function sendUpdateState() {
  if (!win || win.isDestroyed()) return;
  try { win.webContents.send("update:state", { current: piVersion, latest: updateState?.latest ?? null, error: updateState?.error ?? null }); } catch { /* 窗口销毁竞态，静默 */ }
}

ipcMain.handle("update:state:get", () =>
  updateState ? { current: piVersion, latest: updateState.latest ?? null, error: updateState.error ?? null } : { current: piVersion, latest: null, error: null, pending: true });

async function checkPiUpdate() {
  let latest = null, updError = null;
  try {
    if (process.env.PI_GUI_TEST_UPDATE) {
      latest = process.env.PI_GUI_TEST_UPDATE; // 测试钩子：不联网，强制渲染提示框
    } else {
      const cache = readUpdateCache();
      if (cache && typeof cache.latest === "string" && Date.now() - (cache.checkedAt || 0) < UPDATE_TTL_MS) {
        latest = cache.latest;
        if (cache.error) updError = cache.error;
      } else {
        const r = await fetch(UPDATE_CHECK_URL, { signal: AbortSignal.timeout(15000), headers: { accept: "application/json" } });
        if (r.ok) {
          const j = await r.json();
          if (j && typeof j.version === "string" && j.version) {
            latest = j.version;
            try { fs.writeFileSync(updateCacheFile(), JSON.stringify({ latest, checkedAt: Date.now() }, null, 2)); } catch { /* 缓存写失败不影响本次结果 */ }
          } else { updError = "响应无 version 字段"; }
        } else {
          updError = "HTTP " + r.status;
        }
      }
    }
  } catch (e) { updError = String(e?.cause?.message ?? e?.message ?? e).slice(0, 200); }
  updateState = { current: piVersion || null, latest, error: updError };
  // 检测历史落盘（2026-10-08 owner 报“静默失败查无可查”：成败都记一行；24h 节流下体积极小）
  try {
    fs.appendFileSync(path.join(app.getPath("userData"), "update-check.log"),
      `[${new Date().toISOString()}] current=${piVersion ?? "?"} latest=${latest ?? "null"}${updError ? " error=" + updError : ""}\n`);
  } catch { /* userData 不可写时只能 console */ }
  console.log(`[update] current=${piVersion ?? "?"} latest=${latest ?? "?"} hasUpdate=${isNewerPiVersion(latest, piVersion)}${updError ? " error=" + updError : ""}`);
  sendUpdateState();
}

/* ---------- 事件转发 ---------- */

function emit(evt) {
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send("pi:event", evt);
  } catch {
    // 事件不可结构化克隆时退化为 JSON
    try {
      win.webContents.send("pi:event", JSON.parse(JSON.stringify(evt)));
    } catch {
      /* 忽略不可序列化事件 */
    }
  }
}

/* ---------- 状态序列化 ---------- */

/** 本地（=北京）时间 yyyy-MM-dd HH:mm：toISOString 是 UTC 差 8h，侧栏时间全用它（2026-10-03 owner 反馈） */
function fmtLocal(d) {
  if (!(d instanceof Date) || isNaN(d)) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function modelInfo(m) {
  if (!m) return null;
  const provider =
    typeof m.provider === "string" ? m.provider : (m.provider?.id ?? m.providerId ?? "");
  return {
    id: m.id,
    name: m.name ?? m.id,
    provider,
    contextWindow: m.contextWindow ?? null,
    input: Array.isArray(m.input) ? m.input : null, // 能力透传（["text","image"]，视觉自动切换依据，2026-10-05）
  };
}

function getState(en) {
  en = en ?? cur();
  if (!en) return null;
  return {
    sessionId: en.id,
    cwd: en.cwd,
    // 动态读 sessionFile：新会话首轮落盘后路径才有值，比创建时记录的更准
    sessionPath: en.session.sessionFile ?? en.sessionPath ?? null,
    model: modelInfo(en.session.model),
    thinkingLevel: en.session.thinkingLevel ?? "medium",
    tools: en.session.getActiveToolNames(),
    messageCount: en.session.messages.length,
    running: en.agentRunning, // 权威运行态（此前写死 false，2026-10-03 修）
    permMode: en.permMode ?? "default", // 三档权限（2026-10-08 zcode 套用批次1）
    permSidOk: Boolean(en.piSessionId), // 桥归属钥匙捕获成功与否（verify 断言用，只读）
  };
}

/* ---------- 启动自检 ---------- */

ipcMain.handle("sys:clipboard", (_e, text) => {
  clipboard.writeText(String(text ?? ""));
  return true;
});

ipcMain.handle("sys:selfcheck", () => {
  const envKeys = ["ZAI_CODING_CN_API_KEY", "ZAI_API_KEY", "ANTHROPIC_AUTH_TOKEN", "TENCENTCLOUD_SECRETID", "TENCENTCLOUD_SECRETKEY"];
  const env = envKeys.map((k) => ({ key: k, present: Boolean(process.env[k]) })).filter((e) => e.present);
  return {
    piLoaded: Boolean(pi),
    piLoadError,
    piVersion,
    electron: process.versions.electron,
    envKeysPresent: env.map((e) => e.key),
  };
});

/* ---------- 会话生命周期 ---------- */

function validCwd(cwd) {
  if (!cwd || typeof cwd !== "string") return null;
  try {
    return fs.statSync(cwd).isDirectory() ? cwd : null;
  } catch {
    return null;
  }
}

/* ---------- 安全①（2026-10-07 owner 拍板）：fs 通道白名单 ----------
   GUI 内部读文件只服务右栏项目树/查看器，只允许：已登记工作区 + 收藏目录 + 主目录。
   agent 本身的文件访问由扩展层路径守卫（②）弹确认管控，两层独立。 */
function allowedFsRoots() {
  const roots = new Set([os.homedir()]);
  try {
    loadWsConfig();
    for (const w of wsConfig?.workspaces ?? []) if (w.cwd) roots.add(path.resolve(w.cwd));
    for (const f of wsConfig?.favorites ?? []) if (f.cwd) roots.add(path.resolve(f.cwd));
  } catch { /* 配置不可读时仅主目录 */ }
  return [...roots];
}
/* 路径归一（安全①配套）：git-bash 盘符挂载式 /e/xx → e:\xx、正斜杠统一、resolve；
   Windows 大小写不敏感由 isAllowedFsPath 的 lowercase 比较处理（2026-10-07 图裂排查发现两误杀源） */
function normalizeFsPath(p) {
  let s = String(p ?? "");
  const m = s.match(/^[\/\\]([a-zA-Z])[\/\\](.*)$/); // /e/xxx 或 \e\xxx → 盘符式
  if (m) s = m[1] + ":\\" + m[2];
  return path.resolve(s.replace(/\//g, "\\"));
}
function isAllowedFsPath(p) {
  try {
    const raw = String(p ?? "");
    const full = normalizeFsPath(raw);
    if (/^\\\\/.test(full)) return false; // UNC/设备路径（\\server\share、\\?\）：白名单根全是盘符式，一律拒（P1 修复 2026-10-10 审计）
    if (!/^[a-zA-Z]:/.test(full)) return true; // 相对路径：由调用方 cwd 语义决定，GUI 内部调用均为白名单内根
    // 符号链接/junction 归一（P1 修复）：根内链接指向根外即越界；根与目标两侧都 realpath 后前缀比较。
    // 不存在的路径按归一值继续判（调用方随后自会报「不存在」，UX 不变）
    let real = full;
    try { real = fs.realpathSync(full); } catch { /* ENOENT 等：按未解析路径 */ }
    const fl = real.toLowerCase();
    return allowedFsRoots().some((r) => {
      let rl = path.resolve(r).toLowerCase();
      try { rl = fs.realpathSync(r).toLowerCase(); } catch { /* 根不存在按归一值 */ }
      return fl === rl || fl.startsWith(rl + "\\");
    });
  } catch { return false; }
}

/* 安全②：路径守卫确认桥——agent（bash/edit/write 等）访问白名单外路径时，
   扩展（~/.pi/agent/extensions/path-guard.ts）经此桥弹原生确认，owner 允许才放行。
   无窗口（退出中）放行；裸 TUI 无此桥，扩展自判。 */
globalThis.__piGuardRoots = () => allowedFsRoots();

/* ---------- 三档权限（2026-10-08 zcode 套用批次1：plan/default/full） ----------
 * 判定逻辑全在本文件（verify-perm 的 perm:probe 直测同一函数）；path-guard.ts 只做薄层问桥。
 * 档位语义：plan=拦截 write/edit/bash/powershell（只读探索）；default=现状路径守卫；
 *   full=全放行（跳过路径守卫）。档位挂 sessionMap entry，按会话隔离，切档即时生效（下次 tool_call 即中）。
 * 归属钥匙：AgentSession.sessionManager.getSessionId()（ExtensionContext 侧同源）。 */
const PERM_MODES = new Set(["plan", "default", "full"]);
const PERM_WRITE_TOOLS = new Set(["write", "edit", "bash", "powershell"]);
function permGateDecision(mode, toolName) {
  if (mode === "plan" && PERM_WRITE_TOOLS.has(String(toolName))) {
    return {
      block: true,
      reason:
        "当前为计划模式（只读探索）：写文件与执行命令已被拦截。请继续用 read/grep/glob 等只读工具完成调研，" +
        "整理出完整计划呈给用户；用户把权限档位切到「默认」或「完全」后即可执行修改（也可用 /approve 直接批准执行）。",
    };
  }
  return null; // default 交回路径守卫；full 在桥层放行
}
globalThis.__piGuardGate = (sessionId, toolName) => {
  try {
    for (const en of sessionMap.values()) {
      if (en.piSessionId && en.piSessionId === sessionId) {
        if (en.permMode === "full") return { allow: true }; // 完全访问：连路径守卫一起跳过
        const d = permGateDecision(en.permMode, toolName);
        if (d) return { block: true, reason: d.reason };
        return null; // default：交回 path-guard 的路径检查
      }
    }
    return null; // 未登记会话（子代理临时会话/无头 SDK）：维持路径守卫现状语义
  } catch {
    return null; // 桥自身故障不添乱
  }
};

globalThis.__piGuardConfirm = async ({ tool, paths }) => {
  if (!win || win.isDestroyed()) return true;
  const shown = paths.slice(0, 5).join("\n");
  const more = paths.length > 5 ? "\n...deng " + paths.length + " chu" : "";
  const r = await dialog.showMessageBox(win, {
    type: "warning",
    title: "路径守卫",
    message: "agent 请求访问工作区外的路径",
    detail: "工具：" + tool + "\n路径：\n" + shown + more + "\n\n白名单 = 已登记工作区 + 收藏 + 主目录。允许本次访问？拒绝则该次工具调用被拦截。",
    buttons: ["拒绝", "允许"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  const allowed = r.response === 1;
  console.log(`[path-guard] ${tool} -> ${paths[0] ?? "?"} -> ${allowed ? "allow" : "deny"}`);
  return allowed;
};

/* ---------- ask_user 提问卡（2026-10-08 批次2；同日晚 owner 反馈改对话内卡片） ----------
 * 对话内卡片必答（非模态，不遮挡对话流）：execute 悬挂 Promise 直到 owner 在渲染端点选/作答
 * （无限等待不超时，安全优先）；abort（停止任务）时以「未作答」文本 resolve，不 reject——模型可自处。
 * payload 留存于 askPending，渲染端重载/冷启经 ask:pendingList 找回（ask:request 只推一次不重放）。 */
const askPending = new Map(); // `${entryId}:${toolCallId}` -> { resolve, payload }
let askTestSeq = 0;

function dispatchAskUser(entryId, toolCallId, params, signal) {
  return new Promise((resolve) => {
    // 入参净化：question/options 钳制，recommended 落到合法区间
    const question = String(params?.question ?? "").trim().slice(0, 500) || "（模型未给出问题文本）";
    const rawOpts = Array.isArray(params?.options) ? params.options : [];
    const options = rawOpts
      .filter((o) => o && typeof o.label === "string" && o.label.trim())
      .slice(0, 4)
      .map((o) => ({ label: String(o.label).trim().slice(0, 80), description: o.description ? String(o.description).slice(0, 200) : "" }));
    let recommended = Number.isInteger(params?.recommended) ? params.recommended : -1;
    if (recommended < 0 || recommended >= options.length) recommended = -1;
    const context = params?.context ? String(params.context).slice(0, 300) : "";
    const payload = { question, options: (options.length >= 2 ? options : [{ label: "继续", description: "" }, { label: "停止", description: "" }]), recommended, context };

    const key = entryId + ":" + toolCallId;
    const settle = (text) => {
      askPending.delete(key);
      resolve({ content: [{ type: "text", text: String(text) }], details: {} });
    };
    const onAbort = () => settle("owner 中止了当前任务，问题未作答。");
    signal?.addEventListener("abort", onAbort, { once: true });
    askPending.set(key, { resolve: settle, payload: { sessionId: entryId, toolCallId, ...payload } });
    if (win && !win.isDestroyed()) {
      win.webContents.send("ask:request", { sessionId: entryId, toolCallId, ...payload });
    }
    try { globalThis.__piGuiNotify?.("pi 提问待答", question.slice(0, 90)); } catch { /* toast 失败不打断 */ }
    console.log(`[ask] ${entryId} ${toolCallId} ${question.slice(0, 60)}`);
  });
}

ipcMain.handle("ask:answer", (_e, sessionId, toolCallId, text) => {
  const p = askPending.get(sessionId + ":" + toolCallId);
  if (!p) return { ok: false, error: "问题已失效（可能已被回答或中止）" };
  p.resolve(text);
  return { ok: true };
});
// 渲染端重载/冷启找回仍在等待的问题（2026-10-08 对话内卡片改造新增）
ipcMain.handle("ask:pendingList", () => [...askPending.values()].map((p) => p.payload));

/* ---------- design-gate 桥（2026-10-09 设计共识批次C；2026-10-10 owner 拍板扩四选） ----------
 * design-gate.ts 扩展拦到「设计文档缺信源段」时经此桥弹 ask 卡片（对话内非模态，owner 拍板形态）。
 * 四选：放行落盘 / 先跑 verify / 拒绝 / 一直允许（此路径入 allowlist 跨会话静默放行）；作答文本映射回 verdict。
 * TEST_HEADLESS 自动放行（测试实例不挂起等待）；PI_GUI_TEST_GATE=1 时记录调用供 verify-designgate 探针。
 * 2026-10-10 owner 二次拍板：不再弹卡问询（必答卡对 owner 是负担），改通知式——对话流插一条 gate:notice
 * 提示行（路径+缺信源提醒，无需作答）+ 自动放行。写入照常落盘。 */
let designGateSeq = 0;
globalThis.__piGuiDesignConfirm = async ({ tool, path: gatePath, hasVerify }) => {
  if (TEST_HEADLESS) {
    if (process.env.PI_GUI_TEST_GATE === "1") {
      globalThis.__designGateCalls = [...(globalThis.__designGateCalls ?? []), { tool, path: gatePath, hasVerify }];
    }
    return "allow";
  }
  const en = cur();
  if (!en || !win || win.isDestroyed()) return "allow"; // 无会话/窗口异常：gate 不挡路
  // 通知式（owner 2026-10-10 拍板）：不再进 askPending 弹卡，对话流一嘴提示 + 直接放行；
  // allowlist 命中时扩展侧已提前 return（不会走到桥），此处均为未命中首次提醒
  win.webContents.send("gate:notice", {
    sessionId: en.id,
    seq: ++designGateSeq,
    tool,
    path: gatePath,
    text: `design-gate：已放行 ${gatePath}（缺「## 信源」段）——建议补信源脚注表（断言/数值/信源/数据版本/验证）`,
  });
  return "allow";
};

/* design-gate 只读探针（无条件注册，verify-designgate/smoke 用；桥调用记录仍限 TEST_GATE 实例） */
ipcMain.handle("gate:probe", (_e, kind, arg) => {
  const probe = globalThis.__piDesignGateProbe;
  if (!probe) return { loaded: false };
  try {
    // 2026-10-10 owner 拍板四选扩展：allowlist 探针（allowHas/allowList/allowAdd/allowClear 供 verify 测试）
    let result;
    if (kind === "scope") result = probe.inScope(String(arg ?? ""));
    else if (kind === "allowHas") result = probe.allowHas(String(arg ?? ""));
    else if (kind === "allowList") result = probe.allowList();
    else if ((kind === "allowAdd" || kind === "allowClear") && process.env.PI_GUI_TEST_GATE === "1") {
      // P2 修复（2026-10-10 审计）：allowlist 写操作原本无条件开放，渲染端可改白名单绕 design-gate——现仅测试实例可写
      if (kind === "allowAdd") { probe.allowAdd(String(arg ?? "")); } else { probe.allowClear(); }
      result = true;
    }
    else result = probe.hasSource(String(arg ?? ""));
    return { loaded: true, result };
  } catch (err) {
    return { loaded: true, error: String(err?.message ?? err) };
  }
});
ipcMain.handle("gate:calls", () => (globalThis.__designGateCalls ?? []).slice(-5));
// 测试钩子（verify-ask 零 token 全链路）：模拟一次工具派发，返回值即工具返回
if (process.env.PI_GUI_TEST_ASK === "1") {
  ipcMain.handle("ask:testDispatch", (_e, params) => {
    const en = cur();
    if (!en) return Promise.resolve({ content: [{ type: "text", text: "无会话" }], isError: true });
    return dispatchAskUser(en.id, "asktest-" + ++askTestSeq, params, null);
  });
}
// subagent:testStatus 测试钩子已删（2026-10-08）：右栏子代理面板 owner 拍板移除（spawn_subagent 工具与 subagent_status 推送链保留，渲染端忽略）

// 排障知识 wiki 图谱（2026-10-08 owner 需求）：当前会话在工作区→该工作区 wiki/ 的双链图；
// 自由会话/未登记目录→所有工作区 wiki/ 聚合总图。解析 md 相对链接与 [[wikilink]] 两种边。
ipcMain.handle("wiki:graph", async (_e, cwd) => {
  try {
    loadWsConfig();
    const dir = validCwd(cwd) ?? currentCwd ?? os.homedir();
    // 归属：包含 dir 的工作区（或 dir 本身是工作区根）；无归属=总图（聚合全部工作区）
    const wsList = (wsConfig?.workspaces ?? []).filter((w) => w && w.cwd);
    let host = wsList.find((w) => {
      const r = path.resolve(w.cwd);
      return r === dir || dir.startsWith(r + path.sep);
    });
    let roots = (host ? [host] : wsList).map((w) => ({ root: path.join(path.resolve(w.cwd), "wiki"), name: w.name || path.basename(w.cwd) }))
      .filter((x) => { try { return fs.statSync(x.root).isDirectory(); } catch { return false; } });
    // 回退：归属工作区无 wiki/（如测试钩子目录等被登记但未建 wiki 的）→ 退聚合总图，好过空白
    if (host && !roots.length) {
      host = null;
      roots = wsList.map((w) => ({ root: path.join(path.resolve(w.cwd), "wiki"), name: w.name || path.basename(w.cwd) }))
        .filter((x) => { try { return fs.statSync(x.root).isDirectory(); } catch { return false; } });
    }
    const nodes = [];
    const byPath = new Map();
    const byName = new Map(); // wikilink 按文件名解析
    // 同步长跑预算（2026-10-12 审计乙批）：walk+读文全程主线程，无上限=不定时炸弹（工作区 wiki 增长后
    // 秒级冻结整个主进程 IPC/流式转发）。2s deadline + 2000 文件上限，超限用已收集数据出图（truncated 标记）
    const GRAPH_DEADLINE = Date.now() + 2000;
    const GRAPH_MAX_FILES = 2000;
    let truncated = false;
    for (const g of roots) {
      const walk = (d) => {
        if (truncated) return;
        let items = [];
        try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const it of items) {
          if (truncated || nodes.length >= GRAPH_MAX_FILES || Date.now() > GRAPH_DEADLINE) { truncated = true; return; }
          const p = path.join(d, it.name);
          if (it.isDirectory()) walk(p);
          else if (it.name.toLowerCase().endsWith(".md")) {
            // 坑账档案页不进图谱（2026-10-10 坑账搬家实测踩中：六页 66 条孤本把节点 9→75，fit 撞 0.3 下限仍溢出；
            // 坑账页=纯档案无双链，不是知识节点——图谱语义纯化）
            if (it.name.startsWith("坑账-")) continue;
            const node = { path: p, name: it.name.replace(/\.md$/i, ""), group: g.name };
            byPath.set(p, node);
            if (!byName.has(node.name)) byName.set(node.name, node); // 同名取首个，其余靠相对链接可达
            nodes.push(node);
          }
        }
      };
      walk(g.root);
    }
    // 边：md 相对链接 + [[wikilink]]
    const edges = [];
    const seen = new Set();
    const link = (from, to) => {
      if (!to || !byPath.has(to) || to === from) return;
      const k = from + "→" + to;
      if (seen.has(k)) return;
      seen.add(k);
      edges.push([from, to]);
    };
    for (const node of nodes) {
      if (Date.now() > GRAPH_DEADLINE) { truncated = true; break; } // 边构建同样受预算（2026-10-12 乙批）
      let text = "";
      try { text = fs.readFileSync(node.path, "utf8"); } catch { continue; }
      const baseDir = path.dirname(node.path);
      for (const m of text.matchAll(/\[[^\]]*\]\(([^)#\s]+?\.md)(?:#[^)\s]*)?\)/g)) {
        try { link(node.path, path.resolve(baseDir, decodeURIComponent(m[1]))); } catch { /* 坏链接跳过 */ }
      }
      for (const m of text.matchAll(/\[\[([^\]|#]+)(?:#[^\]]*)?\]\]/g)) {
        const t = byName.get(String(m[1]).trim());
        if (t) link(node.path, t.path);
      }
    }
    return {
      mode: host ? "workspace" : "global",
      host: host?.name ?? null,
      roots: roots.map((r) => r.root),
      nodes: nodes.map((n) => ({ path: n.path, name: n.name, group: n.group })),
      edges,
      truncated,
    };
  } catch (err) {
    return { mode: "error", error: String(err?.message ?? err) };
  }
});

/* ---------- 临时会话（子代理/双模型对比用） ---------- */

// spawn_subagent 工具档位（2026-10-08，借鉴 zcode agent type「类型即工具白名单」）：
// general=全工具；explore=纯读调研（旧 readOnly:true 的等价别名）；verify=裁判档（多给 bash 跑验证脚本/CDP 探针，仍无 write/edit）
const SUB_PRESETS = {
  general: null,
  explore: ["read", "grep", "find", "ls"],
  verify: ["read", "bash", "grep", "find", "ls"],
};

async function createEphemeralSession(modelRef, noTools = false, preset = "general") {
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd: currentCwd ?? os.homedir(),
    agentDir: pi.getAgentDir(),
    extensionFactories: [],
  });
  await resourceLoader.reload();
  const created = await pi.createAgentSession({
    cwd: currentCwd ?? os.homedir(),
    resourceLoader,
    sessionManager: pi.SessionManager.inMemory(),
    ...(noTools ? { noTools: true } : {}),
  });
  const s = created.session;
  // 档位收窄（批次4 起家，preset 化后支持三档）：白名单外的名字被 SDK 忽略，收窄失败则保持全工具不阻断
  const presetTools = SUB_PRESETS[preset];
  if (presetTools) {
    try { s.setActiveToolsByName(presetTools); } catch { /* 收窄失败则保持全工具，不阻断 */ }
  }
  if (modelRef) {
    // modelRef = "providerId|modelId"，双字段匹配避免同 id 不同 provider 撞车
    const [pid, mid] = String(modelRef).split("|");
    let candidates = [];
    try { candidates = [...(s.modelRuntime?.getAvailableSnapshot?.() ?? [])]; } catch { /* 回退全目录 */ }
    if (!candidates.length) candidates = s.modelRuntime?.getModels?.() ?? [];
    const m =
      candidates.find((x) => (x.provider?.id ?? x.providerId) === pid && x.id === mid) ??
      candidates.find((x) => x.id === mid);
    if (m) await s.setModel(m);
  }
  return s;
}

/* ---------- 子代理任务面板状态（2026-10-08 批次5）：fan-out 进度推送 ---------- */
const subBatches = new Map(); // batchId -> { sessionId, items: [{i, task, status, chars, cost, error}], done, total, at }
function subPush(batchId) {
  const b = subBatches.get(batchId);
  if (!b) return;
  if (win && !win.isDestroyed()) win.webContents.send("pi:event", { type: "subagent_status", sessionId: b.sessionId, batchId, items: b.items.map((x) => ({ ...x })), at: b.at });
}
function subItem(b, i, patch) {
  const it = b.items[i];
  if (!it) return;
  Object.assign(it, patch);
  subPush(b.batchId);
}

async function runSubagentTask(params, signal, onUpdate, toolCallId = "sub-0", sessionId = null) {
  const taskList = Array.isArray(params?.tasks) && params.tasks.length >= 2
    ? params.tasks.map((t) => String(t ?? "")).filter(Boolean).slice(0, 8)
    : [String(params?.task ?? "").trim()].filter(Boolean);
  if (!taskList.length) return { content: [{ type: "text", text: "task/tasks 不能为空" }], isError: true };

  const batchId = toolCallId;
  const batch = { sessionId, batchId, items: taskList.map((t, i) => ({ i, task: t.slice(0, 60), status: "running", chars: 0, cost: null, error: null })), total: taskList.length, at: Date.now() };
  subBatches.set(batchId, batch);
  // 面板最多留 20 个批次（防长会话膨胀）
  while (subBatches.size > 20) subBatches.delete(subBatches.keys().next().value);
  subPush(batchId);

  const modelRef = params?.model || undefined;
  // preset 档位解析：合法 preset 优先；旧 readOnly:true 兼容映射 explore；非法/缺省兜底 general
  const preset = Object.hasOwn(SUB_PRESETS, params?.preset) ? params.preset : (params?.readOnly === true ? "explore" : "general");
  let finished = 0;
  const results = await Promise.all(taskList.map(async (task, i) => {
    const r = await runSingleSubagent(task, modelRef, preset, signal, (chars) => {
      subItem(batch, i, { chars });
    });
    finished++;
    subItem(batch, i, r.isError ? { status: "error", error: String(r.content?.[0]?.text ?? "").slice(0, 120) } : { status: "done", cost: r.cost ?? null });
    try { onUpdate?.({ content: [{ type: "text", text: `子代理并行中…${finished}/${taskList.length} 完成` }], details: {} }); } catch { /* 忽略 */ }
    return r;
  }));
  subBatches.delete(batchId);

  if (taskList.length === 1) {
    const r = results[0];
    if (!r.isError && typeof r.cost === "number") {
      return { ...r, content: [{ type: "text", text: r.content[0].text + `\n\n[子代理消耗: $${r.cost.toFixed(4)}]` }] };
    }
    return r;
  }
  const summary = results
    .map((r, i) => `[${i + 1}/${taskList.length}] ${taskList[i].slice(0, 40)}\n${r.content?.[0]?.text ?? ""}${typeof r.cost === "number" ? `（$${r.cost.toFixed(4)}）` : ""}`)
    .join("\n\n");
  const totalCost = results.reduce((s, r) => s + (typeof r.cost === "number" ? r.cost : 0), 0);
  return { content: [{ type: "text", text: summary + `\n\n[批量子代理 ${taskList.length} 个全部返回，合计 $${totalCost.toFixed(4)}]` }], details: {} };
}

/** 单个子代理执行（batch/单任务共用）；cost 挂返回对象供面板与汇总（2026-10-08 批次5） */
async function runSingleSubagent(task, modelRef, preset, signal, onChars) {
  let sub;
  try {
    sub = await createEphemeralSession(modelRef, false, preset);
  } catch (err) {
    return { content: [{ type: "text", text: "子代理启动失败: " + String(err?.message ?? err) }], isError: true };
  }
  let chars = 0;
  let lastPush = 0;
  const un = sub.subscribe((evt) => {
    if (evt.type === "message_update") {
      const e = evt.assistantMessageEvent;
      if (e?.type === "text_delta") {
        chars += e.delta.length;
        const now = Date.now();
        if (now - lastPush > 1200) {
          lastPush = now;
          try { onChars(chars); } catch { /* 忽略 */ }
        }
      }
    }
  });
  const abortFn = () => { try { sub.abort(); } catch { /* 忽略 */ } };
  signal?.addEventListener("abort", abortFn, { once: true });
  try {
    await sub.prompt(task);
    const out = sub.getLastAssistantText?.() || "（子代理没有文本输出）";
    const last = [...(sub.messages ?? [])].reverse().find((m) => m.role === "assistant");
    const cost = last?.usage?.cost?.total;
    return {
      content: [{ type: "text", text: out }],
      details: {},
      ...(typeof cost === "number" ? { cost } : {}),
    };
  } catch (err) {
    return { content: [{ type: "text", text: "子代理执行失败: " + String(err?.message ?? err) }], isError: true };
  } finally {
    signal?.removeEventListener("abort", abortFn);
    un();
    try { sub.dispose(); } catch { /* 忽略 */ }
  }
}

/** 销毁一个会话 entry（空壳回收/UI 关闭/退出清理；正常切换绝不调用，否则任务被中断）。
 * B1（2026-10-07 优化计划）：abort/dispose 包 800ms 超时预算，超时弃 entry 继续 + logFatal 指认。
 * 历史土壤：fire-and-forget 无预算时，dispose 内部等待卡死 → quit 走不完 → 僵尸持锁
 * （三次事故共同根因，仅靠全局 2.5s app.exit 强退兑底）。返回 Promise，调用方可不 await（语义不变）。 */
const DISPOSE_BUDGET_MS = 800;
function disposeEntry(id) {
  const en = sessionMap.get(id);
  if (!en) return Promise.resolve();
  sessionMap.delete(id);
  if (en.mcpPollTimer) clearInterval(en.mcpPollTimer);
  updateTrayTooltip(); // 被卸载的会话可能在跑，托盘计数同步
  if (currentKey === id) currentKey = sessionMap.keys().next().value ?? null;
  const startedAt = Date.now();
  const doDispose = (async () => {
    // 测试钩子（verify-b1 专用）：模拟 dispose 内部等待永久卡死，验证超时预算与日志指认
    if (process.env.PI_GUI_TEST_HANG_DISPOSE === "1") {
      await new Promise(() => {}); // 永不 resolve
    }
    try { await en.session.abort(); } catch { /* 已空闲 */ }
    try { en.session.dispose(); } catch { /* 已销毁 */ }
  })();
  return Promise.race([
    doDispose,
    new Promise((resolve) => setTimeout(() => {
      logFatal("dispose-timeout", `entry=${id} budget=${DISPOSE_BUDGET_MS}ms elapsed=${Date.now() - startedAt}ms running=${en.agentRunning ?? false} file=${en.session.sessionFile ?? en.sessionPath ?? "(inMemory)"} —— 已弃该 entry 继续退出，会话数据不受影响`);
      resolve("timeout");
    }, DISPOSE_BUDGET_MS)),
  ]);
}

const pendingCreates = new Map(); // sessionPath → in-flight createSession promise（2026-10-12 审计乙批：去重检查与入表之间隔两个 await，双击历史会话即双 entry 双写同一 jsonl）
async function createSession(cwd, sessionPath) {
  if (sessionPath) {
    const pend = pendingCreates.get(sessionPath);
    if (pend) {
      console.log("[session] coalesce in-flight create:", sessionPath);
      return pend;
    }
  }
  const p = createSessionInner(cwd, sessionPath);
  if (sessionPath) {
    pendingCreates.set(sessionPath, p);
    p.finally(() => pendingCreates.delete(sessionPath)).catch(() => {});
  }
  return p;
}

async function createSessionInner(cwd, sessionPath) {
  // 同一磁盘会话已在内存（可能正在后台运行）→ 直接切换视图，绝不重复创建/中止（多会话并行核心）
  if (sessionPath) {
    for (const [id, en] of sessionMap) {
      if (en.sessionPath === sessionPath || en.session.sessionFile === sessionPath) {
        currentKey = id;
        currentCwd = en.cwd;
        console.log("[session] switch to live entry", id, sessionPath);
        return safeSerialize({ ...getState(en), messages: en.session.messages });
      }
    }
  }
  // 新建空白会话前，回收一个"空且空闲且非当前"的旧空壳 entry（未发过消息、磁盘无文件，dispose 零损失），防内存膨胀
  for (const [id, en] of sessionMap) {
    if (id !== currentKey && !en.agentRunning && (en.session.messages?.length ?? 0) === 0) {
      disposeEntry(id);
      break;
    }
  }
  // PI_GUI_TEST_CWD（2026-10-07）：测试实例会话 cwd 防污染主实例侧栏。2026-10-08 精准化：
  // 只改写「会落 home」的入口（UI 点「新会话」/自由区/null 兑底 homedir），显式非 home cwd（右键子目录
  // 开会话/切工作区验证链）放行——原全量强制版把 verify 的 cwd 断言全部打穿，豁免写宽又跳过建会话流程
  let dir = validCwd(cwd) ?? os.homedir();
  if (process.env.PI_GUI_TEST_CWD && dir === os.homedir()) {
    dir = validCwd(process.env.PI_GUI_TEST_CWD) ?? dir;
  }
  const __t0 = Date.now(); // [perf] 切换热点拆分：rl 重载 vs 会话构建(含 jsonl 解析) vs bind vs 序列化
  currentCwd = dir;
  const entryId = "s" + ++keySeq;
  const mySessionPath = sessionPath ?? null;
  // 加载扩展：子代理工具 + MCP（读取 ~/.pi/agent/mcp.json 与受信项目的 .pi/mcp.json，同 CLI）
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd: dir,
    agentDir: pi.getAgentDir(),
    extensionFactories: [
      (piApi) => {
        piApi.registerTool({
          name: "spawn_subagent",
          label: "子代理",
          description:
            "派发独立子代理在临时会话中完成自包含任务，返回其最终结论文本。支持两种形态：" +
            "单任务（task）或一批任务（tasks，2-8 个并行 fan-out——互不依赖的调研/批量分析用这个，又快又省上下文）。" +
            "按任务性质选 preset：大范围找代码/纯调研/纯分析选 explore（只读，省 token 零误伤）；验收与核对类任务" +
            "（跑验证脚本、检查实现是否到位、下 pass/fail 结论）选 verify（可执行 bash 但不可改文件）；只有子代理确实要动手改文件时才用 general。" +
            "任务描述必须完整自包含（子代理看不到当前对话）；适合可独立完成的辅助工作，不适合需要与用户来回确认的事。",
          parameters: {
            type: "object",
            properties: {
              task: { type: "string", description: "单个任务描述（与 tasks 二选一）" },
              tasks: {
                type: "array", minItems: 2, maxItems: 8,
                items: { type: "string" },
                description: "一批并行任务（与 task 二选一，全批共用 model/preset）",
              },
              model: { type: "string", description: "可选，覆盖子代理模型 id（默认与主会话相同），如 glm-5.3-flash" },
              preset: {
                type: "string", enum: ["general", "explore", "verify"],
                description: "工具档位（默认 general）。explore=只读（read/grep/find/ls），调研找代码用；verify=裁判档（read/bash/grep/find/ls，可跑验证脚本与探针、不可改文件），验收核对用；general=全工具，仅当确实需要改文件时用",
              },
              readOnly: { type: "boolean", description: "已弃用：等价 preset=\"explore\"，为兼容旧对话保留；与 preset 同传时 preset 优先" },
            },
          },
          execute: async (toolCallId, params, signal, onUpdate) => runSubagentTask(params, signal, onUpdate, toolCallId, entryId),
        });
      },
      // ask_user 提问卡（2026-10-08 zcode 套用批次2）：模态必答，选项点选或自由作答回传
      (piApi) => {
        piApi.registerTool({
          name: "ask_user",
          label: "向 owner 提问",
          description:
            "当需要 owner 做决策/拍板时使用：给出问题与 2-4 个互斥选项（各可附一句说明），owner 会点选或自由作答。" +
            "有明确推荐时填 recommended（选项序号，0 起，推荐项会排到最前并标注）。" +
            "适合方案取舍、范围确认、不可逆操作前确认；不要用于自己能查到答案的事实问题。",
          parameters: {
            type: "object",
            properties: {
              question: { type: "string", description: "要问的问题（一句话，具体可答）" },
              options: {
                type: "array",
                minItems: 2,
                maxItems: 4,
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string", description: "选项短标签" },
                    description: { type: "string", description: "一句补充说明（可选）" },
                  },
                  required: ["label"],
                },
                description: "互斥选项列表（2-4 个）",
              },
              recommended: { type: "number", description: "推荐选项序号（0 起）；无明确推荐省略" },
              context: { type: "string", description: "问题背景补充，一两句（可选）" },
            },
            required: ["question", "options"],
          },
          execute: async (toolCallId, params, signal) => dispatchAskUser(entryId, toolCallId, params, signal),
        });
      },
      /* 自由浏览器 agent 操作套件（2026-10-08 计划书阶段二 3b）：snapshot→click/type 操作回路。
       * 容器底线在 WebContentsView 侧统一把守（sandbox/权限拒/下载不执行）；本层只做互斥与 ref 定位。 */
      (piApi) => {
        const reg = (tool) => { WEB_TOOL_EXECS.set(tool.name, tool.execute); piApi.registerTool(tool); };
        const webTarget = (tabId) => {
          const t = webViews.get(String(tabId || webAgentTabId || "")) || [...webViews.values()][0];
          if (!t) throw new Error("没有已打开的浏览器 tab（先调 browser_open，或用 browser_tabs list 查看）");
          return t;
        };
        const webPageCall = async (t, js, _timeoutMs = 8000) => { // 2026-10-10 lint 修：存量未用参数下划线前缀（零语义变化）
          try {
            return await t.view.webContents.executeJavaScript(js);
          } catch (err) {
            throw new Error("页面执行失败：" + String(err?.message ?? err));
          }
        };
        const sanitizeRef = (ref) => {
          const s = String(ref ?? "").trim();
          if (!/^e\d{1,4}$/.test(s)) throw new Error('非法 ref（应为 snapshot 返回的 "e<数字>"）');
          return s;
        };
        reg({
          name: "browser_open",
          label: "打开网页",
          description:
            "在 GUI 内置浏览器面板打开网页并等加载完成，返回标题与正文文本；owner 能实时看到页面。" +
            "需要操作页面元素时，接着用 browser_snapshot 拿可交互元素清单，再用 browser_click / browser_type 按 ref 操作。" +
            "每次操作会返回当前视口小结，支持连续多步自主操作。",
          parameters: { type: "object", properties: { url: { type: "string", description: "完整 URL（http/https）" } }, required: ["url"] },
          execute: async (_id, params) => {
            const url = String(params?.url ?? "").trim();
            if (!/^https?:\/\//i.test(url)) return { content: [{ type: "text", text: "url 必须以 http(s):// 开头" }], isError: true };
            if (!webAgentLock(entryId)) return { content: [{ type: "text", text: "浏览器正被其他会话使用中，请稍后重试" }], isError: true };
            try {
              const t = await webOpen(url);
              webAgentTabId = t.id;
              const ok = await webWaitSettled(t);
              const text = await webExtractText(t);
              return { content: [{ type: "text", text: `已打开（tab ${t.id}${ok ? "" : "，加载超时"}）：${t.title}\nURL: ${t.url}\n\n页面正文（截断 8KB）：\n${text}` }], details: {} };
            } finally { webAgentUnlock(entryId); }
          },
        });
        reg({
          name: "browser_snapshot",
          label: "浏览器元素清单",
          description:
            "列出浏览器页面当前可视可交互元素（带 ref 编号），是 browser_click / browser_type 的定位依据。" +
            "页面可能随时重渲染使 ref 失效：**每次连续操作序列开始前必须先重新 snapshot**；操作报 ref 不存在时同样重新 snapshot。",
          parameters: {
            type: "object",
            properties: { tabId: { type: "string", description: "可选，缺省用最近 browser_open 的 tab" } },
          },
          execute: async (_id, params) => {
            if (!webAgentLock(entryId)) return { content: [{ type: "text", text: "浏览器正被其他会话使用中，请稍后重试" }], isError: true };
            try {
              const t = webTarget(params?.tabId);
              const snap = await webPageCall(t, `(() => {
                const out = [];
                let i = 0;
                const nodes = document.querySelectorAll('a, button, input, textarea, select, summary, [role="button"], [role="link"], [role="tab"], [onclick]');
                for (const el of nodes) {
                  const r = el.getBoundingClientRect();
                  if (r.width < 2 || r.height < 2) continue;
                  const st = getComputedStyle(el);
                  if (st.display === 'none' || st.visibility === 'hidden') continue;
                  const ref = 'e' + (++i);
                  try { el.setAttribute('data-pigui-ref', ref); } catch (e) { continue; }
                  const text = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || el.alt || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
                  out.push({ ref, tag: el.tagName.toLowerCase(), text, href: (el.tagName === 'A' && el.href) ? String(el.href).slice(0, 120) : undefined });
                  if (out.length >= 120) break;
                }
                return { title: document.title, url: location.href, count: out.length, els: out };
              })()`);
              const lines = (snap?.els ?? []).map((e2) => `[${e2.ref}] <${e2.tag}> ${e2.text}${e2.href ? " → " + e2.href : ""}`);
              return { content: [{ type: "text", text: `页面：${snap?.title ?? "?"}\nURL: ${snap?.url ?? "?"}\n可交互元素 ${snap?.count ?? 0} 个：\n${lines.join("\n") || "（无可交互元素）"}` }], details: {} };
            } catch (err) {
              return { content: [{ type: "text", text: String(err?.message ?? err) }], isError: true };
            } finally { webAgentUnlock(entryId); }
          },
        });
        reg({
          name: "browser_click",
          label: "点击页面元素",
          description: "按 snapshot 给的 ref 点击页面元素（滚动到可视区后真实点击）。返回操作结果与当前页面标题。",
          parameters: {
            type: "object",
            properties: {
              ref: { type: "string", description: 'snapshot 返回的元素编号（如 "e12"）' },
              tabId: { type: "string", description: "可选，缺省用最近操作的 tab" },
            },
            required: ["ref"],
          },
          execute: async (_id, params) => {
            if (!webAgentLock(entryId)) return { content: [{ type: "text", text: "浏览器正被其他会话使用中，请稍后重试" }], isError: true };
            try {
              const t = webTarget(params?.tabId);
              const ref = sanitizeRef(params?.ref);
              const r = await webPageCall(t, `(() => {
                const el = document.querySelector('[data-pigui-ref="${ref}"]');
                if (!el) return { ok: false, error: "ref 不存在（页面可能已重渲染，请重新 snapshot）" };
                el.scrollIntoView({ block: "center" });
                el.click();
                return { ok: true, clicked: ((el.innerText || el.value || "") + " " + el.tagName).trim().slice(0, 60) };
              })()`);
              if (!r?.ok) return { content: [{ type: "text", text: r?.error ?? "点击失败" }], isError: true };
              await webWaitSettled(t, 6000);
              return { content: [{ type: "text", text: `已点击：${r.clicked}\n页面：${t.title}\nURL: ${t.url}${t.loading ? "\n（仍在加载中）" : ""}` }], details: {} };
            } catch (err) {
              return { content: [{ type: "text", text: String(err?.message ?? err) }], isError: true };
            } finally { webAgentUnlock(entryId); }
          },
        });
        reg({
          name: "browser_type",
          label: "输入文本",
          description: "按 ref 向输入框/文本域写入文本（触发 input/change 事件，兼容 React 受控组件）。不自动提交，需要回车用 browser_press。",
          parameters: {
            type: "object",
            properties: {
              ref: { type: "string", description: 'snapshot 返回的输入框编号' },
              text: { type: "string", description: "要写入的文本" },
              tabId: { type: "string", description: "可选" },
            },
            required: ["ref", "text"],
          },
          execute: async (_id, params) => {
            if (!webAgentLock(entryId)) return { content: [{ type: "text", text: "浏览器正被其他会话使用中，请稍后重试" }], isError: true };
            try {
              const t = webTarget(params?.tabId);
              const ref = sanitizeRef(params?.ref);
              const text = String(params?.text ?? "");
              const r = await webPageCall(t, `(() => {
                const el = document.querySelector('[data-pigui-ref="${ref}"]');
                if (!el) return { ok: false, error: "ref 不存在（请重新 snapshot）" };
                el.scrollIntoView({ block: "center" });
                el.focus();
                const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
                const setter = Object.getOwnPropertyDescriptor(proto, "value") && Object.getOwnPropertyDescriptor(proto, "value").set;
                const val = ${JSON.stringify(text)};
                if (setter) setter.call(el, val); else el.value = val;
                el.dispatchEvent(new Event("input", { bubbles: true }));
                el.dispatchEvent(new Event("change", { bubbles: true }));
                return { ok: true };
              })()`);
              if (!r?.ok) return { content: [{ type: "text", text: r?.error ?? "输入失败" }], isError: true };
              return { content: [{ type: "text", text: `已输入 ${text.length} 字符到 [${ref}]` }], details: {} };
            } catch (err) {
              return { content: [{ type: "text", text: String(err?.message ?? err) }], isError: true };
            } finally { webAgentUnlock(entryId); }
          },
        });
        reg({
          name: "browser_press",
          label: "按键",
          description: '向页面当前聚焦元素派发按键（如 "Enter"）。注意合成键盘事件不触发表单原生提交，提交类动作优先用 browser_click 点提交按钮。',
          parameters: {
            type: "object",
            properties: {
              key: { type: "string", description: '键名（如 "Enter"）' },
              tabId: { type: "string", description: "可选" },
            },
            required: ["key"],
          },
          execute: async (_id, params) => {
            if (!webAgentLock(entryId)) return { content: [{ type: "text", text: "浏览器正被其他会话使用中，请稍后重试" }], isError: true };
            try {
              const t = webTarget(params?.tabId);
              const key = String(params?.key ?? "").slice(0, 20);
              const r = await webPageCall(t, `(() => {
                const target = document.activeElement || document.body;
                const opts = { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true };
                target.dispatchEvent(new KeyboardEvent("keydown", opts));
                target.dispatchEvent(new KeyboardEvent("keyup", opts));
                return { ok: true, focused: (target.tagName || "") + (target.name ? ":" + target.name : "") };
              })()`);
              return { content: [{ type: "text", text: `已派发 ${key}（聚焦于 ${r?.focused ?? "?"}）` }], details: {} };
            } catch (err) {
              return { content: [{ type: "text", text: String(err?.message ?? err) }], isError: true };
            } finally { webAgentUnlock(entryId); }
          },
        });
        reg({
          name: "browser_scroll",
          label: "滚动页面",
          description: "滚动浏览器页面（正数向下，单位像素）。",
          parameters: {
            type: "object",
            properties: {
              dy: { type: "number", description: "滚动量（像素，正=向下）" },
              tabId: { type: "string", description: "可选" },
            },
            required: ["dy"],
          },
          execute: async (_id, params) => {
            if (!webAgentLock(entryId)) return { content: [{ type: "text", text: "浏览器正被其他会话使用中，请稍后重试" }], isError: true };
            try {
              const t = webTarget(params?.tabId);
              const dy = Math.round(Number(params?.dy) || 0);
              const y = await webPageCall(t, `(() => { window.scrollBy(0, ${dy}); return window.scrollY; })()`);
              return { content: [{ type: "text", text: `已滚动，当前 scrollY=${y}` }], details: {} };
            } catch (err) {
              return { content: [{ type: "text", text: String(err?.message ?? err) }], isError: true };
            } finally { webAgentUnlock(entryId); }
          },
        });
        reg({
          name: "browser_read",
          label: "读取页面文本",
          description: "读取浏览器页面正文文本（截断 16KB）。操作若干步之后想看页面现状时用。",
          parameters: {
            type: "object",
            properties: { tabId: { type: "string", description: "可选" } },
          },
          execute: async (_id, params) => {
            if (!webAgentLock(entryId)) return { content: [{ type: "text", text: "浏览器正被其他会话使用中，请稍后重试" }], isError: true };
            try {
              const t = webTarget(params?.tabId);
              const text = await webExtractText(t, 16000);
              return { content: [{ type: "text", text: `页面：${t.title}\nURL: ${t.url}\n\n${text}` }], details: {} };
            } catch (err) {
              return { content: [{ type: "text", text: String(err?.message ?? err) }], isError: true };
            } finally { webAgentUnlock(entryId); }
          },
        });
        reg({
          name: "browser_tabs",
          label: "管理浏览器标签",
          description: "浏览器多 tab 管理：list 列出全部；new 开新 tab；close 关闭；select 切换为 agent 操作目标。",
          parameters: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["list", "new", "close", "select"], description: "动作" },
              url: { type: "string", description: "action=new 时的初始 URL" },
              tabId: { type: "string", description: "action=close/select 的目标 tab" },
            },
            required: ["action"],
          },
          execute: async (_id, params) => {
            if (!webAgentLock(entryId)) return { content: [{ type: "text", text: "浏览器正被其他会话使用中，请稍后重试" }], isError: true };
            try {
              const act = String(params?.action ?? "list");
              if (act === "list") {
                const list = [...webViews.values()].map((t) => ({ id: t.id, url: t.url, title: t.title }));
                return { content: [{ type: "text", text: list.length ? list.map((t) => `${t.id === webAgentTabId ? "▶ " : ""}${t.id}: ${t.title} — ${t.url}`).join("\n") : "（无打开的 web tab）" }], details: {} };
              }
              if (act === "new") {
                const t = await webOpen(String(params?.url ?? "about:blank"));
                webAgentTabId = t.id;
                return { content: [{ type: "text", text: `已新开 ${t.id}: ${t.title} — ${t.url}` }], details: {} };
              }
              if (act === "close") {
                const id = String(params?.tabId ?? webAgentTabId ?? "");
                const ok = webClose(id);
                return { content: [{ type: "text", text: ok ? `已关闭 ${id}` : "tab 不存在" }], isError: !ok };
              }
              if (act === "select") {
                const t = webTarget(params?.tabId);
                webAgentTabId = t.id;
                return { content: [{ type: "text", text: `agent 操作目标已切到 ${t.id}: ${t.title} — ${t.url}` }], details: {} };
              }
              throw new Error("未知 action: " + act);
            } catch (err) {
              return { content: [{ type: "text", text: String(err?.message ?? err) }], isError: true };
            } finally { webAgentUnlock(entryId); }
          },
        });
        reg({
          name: "browser_screenshot",
          label: "页面截图",
          description: "对浏览器页面截图，PNG 落盘后返回文件路径（owner 可直接在查看器打开）。",
          parameters: {
            type: "object",
            properties: { tabId: { type: "string", description: "可选" } },
          },
          execute: async (_id, params) => {
            if (!webAgentLock(entryId)) return { content: [{ type: "text", text: "浏览器正被其他会话使用中，请稍后重试" }], isError: true };
            try {
              const t = webTarget(params?.tabId);
              const img = await t.view.webContents.capturePage();
              const dir = path.join(app.getPath("userData"), "browser-screenshots");
              fs.mkdirSync(dir, { recursive: true });
              const file = path.join(dir, "shot-" + Date.now() + ".png");
              fs.writeFileSync(file, img.toPNG());
              return { content: [{ type: "text", text: "截图已保存：" + file }], details: {} };
            } catch (err) {
              return { content: [{ type: "text", text: String(err?.message ?? err) }], isError: true };
            } finally { webAgentUnlock(entryId); }
          },
        });
      },
      pi.createMcpExtension(),
      // 内置扩展（2026-10-12 开源阶段 2 收编：path-guard 三档权限拦截 / notify 任务完成通知——
      // 随 GUI 程序化注册，用户无需手动放文件；本机 ~/.pi/agent/extensions 同名件已 .disabled 防双拦）
      { name: "builtin-path-guard", factory: pathGuardFactory },
      { name: "builtin-notify", factory: notifyFactory },
    ],
  });
  await resourceLoader.reload();
  const __tRl = Date.now();
  // 压缩档工作区级覆盖（2026-10-09 批次B3）：新会话注入 inMemory settings；历史会话 open 沿用磁盘
  const wsKeep = loadWsConfig().workspaces.find((w) => w.cwd === dir)?.compactionKeep;
  const created = await pi.createAgentSession({
    cwd: dir,
    resourceLoader,
    ...(mySessionPath ? { sessionManager: pi.SessionManager.open(mySessionPath, undefined, dir) } : {}),
    ...(wsKeep ? { settingsManager: pi.SettingsManager.inMemory({ compaction: { keepRecentTokens: wsKeep } }) } : {}),
  });
  const __tCreate = Date.now();
  // 新会话默认模型走 settings.json 全局默认（2026-10-08 晚 owner 拍板改回直选 glm-5.3（思考档 settings.json 现为 high），弃 jev/auto 默认：
  // 分类器每轮 ~2s 往返拖首字，判无用；旧版 jev pin 是因 SDK 默认解析不认虚拟模型，现在默认是物理模型无需显式切）；
  // 打开历史会话保持原模型不动
  // 新会话档位取全局默认（批次1）；历史会话 attach 同样以默认档起步（档位是内存态，不落盘）
  let piSid = null;
  try { piSid = created.session.sessionManager?.getSessionId?.() ?? null; } catch { /* 无头兼容 */ }
  const en = {
    id: entryId,
    session: created.session,
    resourceLoader,
    mcpPollTimer: null,
    cwd: dir,
    sessionPath: mySessionPath,
    agentRunning: false,
    permMode: loadWsConfig().defaultPermMode ?? "default",
    piSessionId: piSid,
  };
  sessionMap.set(entryId, en);
  currentKey = entryId;
  en.session.subscribe((evt) => {
    if (evt.type === "agent_start") en.agentRunning = true;
    else if (evt.type === "agent_settled" || evt.type === "host_error") en.agentRunning = false;
    updateTrayTooltip(); // 托盘 tooltip 同步运行中任务数（无托盘时空操作）
    // 事件带来源会话 + 落盘路径（渲染端「完成未读」徽标按 path 匹配；空会话首轮落盘前无 path）
    emit({ ...evt, sessionId: entryId, sessionPath: en.session.sessionFile ?? en.sessionPath ?? null });
  });
  // 触发 session_start，后台连接 MCP 服务器
  try { await en.session.bindExtensions({}); } catch (err) {
    emit({ type: "host_error", sessionId: entryId, message: "MCP 扩展加载失败: " + String(err?.message ?? err) });
  }
  // MCP 异步连接：轮询工具表，数量稳定后推送渲染端（避免慢启动的 npx 型 server 被漏掉）
  let lastToolCount = (en.session.getActiveToolNames?.() ?? []).length;
  let lastPushAt = 0; // pi:state 推送节流：MCP server 反复连断时工具数震荡会让轮询永不收敛，高频 IPC+渲染端重建是长期运行闪退头号嫌疑（2026-10-07）
  let stableRuns = 0;
  let tries = 0;
  en.mcpPollTimer = setInterval(() => {
    tries++;
    if (!sessionMap.has(entryId)) { clearInterval(en.mcpPollTimer); return; }
    const tools = en.session.getActiveToolNames?.() ?? [];
    const mcpReady = tools.some((t) => String(t).startsWith("mcp__"));
    if (tools.length !== lastToolCount) {
      lastToolCount = tools.length;
      stableRuns = 0;
      console.log("[mcp] active tools:", tools.length, mcpReady ? "(connecting)" : "");
      if (win && !win.isDestroyed() && Date.now() - lastPushAt > 5000) {
        lastPushAt = Date.now();
        win.webContents.send("pi:state", getState());
      }
    } else {
      stableRuns++;
    }
    // 就位且连续 ~8s 无新增，或超时 120s，才收手
    if ((mcpReady && stableRuns >= 4) || tries > 60) clearInterval(en.mcpPollTimer);
  }, 2000);
  const __tBind = Date.now();
  const __out = safeSerialize({ ...getState(en), messages: en.session.messages });
  console.log(`[perf] createSession rl=${__tRl - __t0}ms create(open+ctx)=${__tCreate - __tRl}ms bind=${__tBind - __tCreate}ms ser=${Date.now() - __tBind}ms msgs=${__out.messages?.length ?? 0} ${mySessionPath ? "(历史会话)" : "(新建)"}`);
  return __out;
}

/* ---------- IPC ---------- */

/** IPC 返回值安全序列化：agent 消息里若有不可结构化克隆的对象，整个 invoke 会报错（防御） */
function safeSerialize(obj) {
  try { return JSON.parse(JSON.stringify(obj)); } catch { return obj; }
}

ipcMain.handle("session:create", async (_e, cwd, sessionPath) => {
  console.log("[ipc] session:create", cwd, sessionPath ?? "(new)");
  try {
    const st = await createSession(cwd, sessionPath);
    console.log("[ipc] session:create ok, cwd=", st?.cwd, "model=", st?.model?.id);
    return st;
  } catch (err) {
    console.error("[ipc] session:create FAILED:", err);
    throw err;
  }
});

/* 渲染端 reload 后认领现存会话：会话在主进程，渲染端只是视图（2026-10-03 实测刷新丢会话坑） */
ipcMain.handle("session:attach", async () => {
  const en = cur();
  if (!en) return null;
  console.log("[ipc] session:attach ->", en.id, en.session.sessionFile ?? "(unsaved)", "msgs:", en.session.messages.length);
  return { ...getState(en), messages: safeSerialize(en.session.messages) };
});

ipcMain.handle("session:state", () => getState());

/* ---------- 三档权限 IPC（批次1）：切档/默认档/探针 ---------- */
ipcMain.handle("perm:setMode", (_e, entryId, mode) => {
  if (!PERM_MODES.has(mode)) return { ok: false, error: "非法档位" };
  const en = sessionMap.get(entryId);
  if (!en) return { ok: false, error: "会话不存在" };
  en.permMode = mode;
  if (win && !win.isDestroyed()) win.webContents.send("pi:state", getState());
  console.log(`[perm] ${entryId} -> ${mode}`);
  return { ok: true, mode };
});
ipcMain.handle("perm:setDefault", (_e, mode) => {
  if (!PERM_MODES.has(mode)) return { ok: false };
  loadWsConfig();
  wsConfig.defaultPermMode = mode;
  saveWsConfig();
  return { ok: true, mode };
});
ipcMain.handle("perm:getDefault", () => {
  loadWsConfig();
  return wsConfig.defaultPermMode ?? "default";
});
// 纯函数只读探针（verify 用）：返回 block 判定，与 __piGuardGate 内核同一函数
ipcMain.handle("perm:probe", (_e, mode, toolName) => permGateDecision(mode, toolName));

/* ---------- 通知设置（批次②）：总开关/提示音/勿扰时段（存 pi-gui-config.json notify 段） ---------- */
function notifyCfg() {
  loadWsConfig();
  const n = wsConfig.notify ?? {};
  const hm = (v) => (typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : "");
  return { enabled: n.enabled !== false, sound: n.sound === true, dndStart: hm(n.dndStart), dndEnd: hm(n.dndEnd) };
}
// 纯函数闸门（notify:probe 可测）：关/勿扰命中 → 吞；声音随开关透传给 Notification.silent
function notifyGateDecision(now = new Date()) {
  const cfg = notifyCfg();
  if (!cfg.enabled) return { allowed: false, reason: "disabled", sound: false };
  if (cfg.dndStart && cfg.dndEnd && cfg.dndStart !== cfg.dndEnd) {
    const [sh, sm] = cfg.dndStart.split(":").map(Number);
    const [eh, em] = cfg.dndEnd.split(":").map(Number);
    const cur = now.getHours() * 60 + now.getMinutes();
    const s = sh * 60 + sm;
    const e = eh * 60 + em;
    const inWin = s < e ? cur >= s && cur < e : cur >= s || cur < e; // 跨零点：start > end
    if (inWin) return { allowed: false, reason: "dnd", sound: false };
  }
  return { allowed: true, reason: "ok", sound: cfg.sound };
}
ipcMain.handle("notify:get", () => ({ ...notifyCfg(), gate: notifyGateDecision() }));
ipcMain.handle("notify:set", (_e, patch) => {
  const p = patch ?? {};
  loadWsConfig();
  const prev = notifyCfg();
  const next = {
    enabled: typeof p.enabled === "boolean" ? p.enabled : prev.enabled,
    sound: typeof p.sound === "boolean" ? p.sound : prev.sound,
    dndStart: typeof p.dndStart === "string" ? p.dndStart.trim() : prev.dndStart,
    dndEnd: typeof p.dndEnd === "string" ? p.dndEnd.trim() : prev.dndEnd,
  };
  wsConfig.notify = next;
  saveWsConfig();
  return { ...next, gate: notifyGateDecision() };
});
ipcMain.handle("notify:probe", (_e, iso) => notifyGateDecision(iso ? new Date(iso) : new Date()));

/* ---------- 上下文/缓存/配额三合一弹层数据（2026-10-08 zcode 套用批次3） ----------
 * ctx:stats 聚合当前会话 messages 的 usage：最近一次请求（驱动环）+ 全程累计（命中率/成本）。
 * PI_GUI_TEST_CTX=1 时返回注水样例（verify-ctxpop 零 token 断言渲染全链路）。 */



/* ---------- / 命令菜单数据（skills + prompt templates） ---------- */

ipcMain.handle("commands:list", () => {
  const rl = cur()?.resourceLoader;
  if (!rl) return { skills: [], prompts: [] };
  try {
    const sk = rl.getSkills();
    const pr = rl.getPrompts();
    return {
      skills: sk.skills.map((s) => ({
        name: s.name,
        description: s.description ?? "",
        scope: s.sourceInfo?.scope === "project" ? "project" : "user",
        path: s.baseDir ?? "",
      })),
      prompts: pr.prompts.map((p) => ({
        name: p.name,
        description: p.description ?? "",
        argumentHint: p.argumentHint ?? "",
      })),
    };
  } catch (err) {
    console.warn("[commands:list]", err?.message ?? err);
    return { skills: [], prompts: [] };
  }
});

/* ---------- 设置中心 R2：MCP 服务器配置（只读展示，2026-10-04） ---------- */
let mcpConfigMod = null;
async function getMcpConfigMod() {
  if (!mcpConfigMod) {
    const root = piRoot();
    if (!root) throw new Error("pi SDK 根目录解析失败");
    mcpConfigMod = await import(pathToFileURL(path.join(root, "dist", "extensions", "mcp", "config.js").replace(/\\/g, "/")).href);
  }
  return mcpConfigMod;
}
ipcMain.handle("mcp:list", async () => {
  try {
    const mod = await getMcpConfigMod();
    const agentDir = pi.getAgentDir();
    const cwd = cur()?.cwd ?? os.homedir();
    let projectTrusted = false;
    try {
      const tm = await import(pathToFileURL(path.join(piRoot() ?? "", "dist", "core", "trust-manager.js").replace(/\\/g, "/")).href);
      projectTrusted = new tm.ProjectTrustStore(agentDir).get(cwd) === true;
    } catch { /* 信任库不可读时按不信任处理：只列全局 */ }
    const loaded = mod.loadMcpConfig({ agentDir, cwd, projectTrusted });
    return {
      servers: (loaded.servers ?? []).map((s) => ({
        name: s.name,
        scope: s.scope ?? "global",
        enabled: s.config?.enabled !== false,
        exposure: s.config?.exposure ?? "direct", // B4：按需暴露语义呈现（全 scope 透传，项目级也有）
        transport: "url" in (s.config ?? {}) ? s.config.url : [s.config.command, ...(s.config.args ?? [])].join(" "),
        // R4：全局服务器透传原始配置供表单回填（含 ${VAR} 引用字符串，无明文密钥）；项目级不透传（不可表单编辑）
        ...(s.scope !== "project" ? { config: s.config } : {}),
      })),
      errors: loaded.errors ?? [],
      configPath: path.join(agentDir, "mcp.json"),
    };
  } catch (err) {
    return { servers: [], errors: [String(err?.message ?? err)], configPath: "" };
  }
});

/* ---------- 设置中心 R4：MCP 增删改（走 pi 权威变更函数，保留缩进与未知字段，2026-10-05） ---------- */
/** env/headers 键值对白名单化：仅保留非空字符串对，${VAR} 原样保留不解析 */
function normalizeMcpKV(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const kk = String(k ?? "").trim();
    const vv = String(v ?? "").trim();
    if (kk && vv) out[kk] = vv;
  }
  return Object.keys(out).length ? out : null;
}

/** 表单配置白名单化：类型字段二选一，公共字段仅收已知项；enabled=true 省略（与 pi 默认语义一致） */
function sanitizeMcpConfig(cfg) {
  if (!cfg || typeof cfg !== "object") throw new Error("服务器配置为空");
  const out = {};
  if (cfg.type === "url") {
    const u = String(cfg.url ?? "").trim();
    if (!/^https?:\/\//i.test(u)) throw new Error("URL 必须以 http(s):// 开头");
    out.url = u;
    const headers = normalizeMcpKV(cfg.headers);
    if (headers) out.headers = headers;
  } else {
    const cmd = String(cfg.command ?? "").trim();
    if (!cmd || /[\r\n]/.test(cmd)) throw new Error("command 不能为空且不能含换行");
    out.command = cmd;
    const args = Array.isArray(cfg.args) ? cfg.args.map((a) => String(a ?? "").trim()).filter((a) => a !== "") : [];
    if (args.length) out.args = args;
    const env = normalizeMcpKV(cfg.env);
    if (env) out.env = env;
  }
  const desc = String(cfg.description ?? "").trim();
  if (desc) out.description = desc;
  if (cfg.exposure === "direct" || cfg.exposure === "deferred" || cfg.exposure === "codemode") {
    out.exposure = cfg.exposure; // 三态直通：codemode 是合法值，编辑时不得降级（2026-10-05 补漏）
  } else {
    out.exposure = "deferred"; // 非法值回退默认
  }
  if (cfg.enabled === false) out.enabled = false;
  return out;
}

ipcMain.handle("mcp:save", async (_e, op, name, cfg) => {
  const mod = await getMcpConfigMod();
  const file = path.join(pi.getAgentDir(), "mcp.json");
  const n = String(name ?? "");
  // 名称白名单：字母数字开头，仅 ._ - 连接；禁双下划线（会砸坏 mcp__<server>__<tool> 工具名聚合）
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(n) || n.includes("__")) {
    throw new Error(`非法服务器名: ${n}（字母数字开头，仅 ._ - ，不含双下划线）`);
  }
  if (op === "delete") {
    mod.removeMcpServerConfig(file, n);
  } else if (op === "toggle") {
    mod.updateMcpServerConfig(file, n, { enabled: !!cfg });
  } else if (op === "set") {
    const clean = sanitizeMcpConfig(cfg);
    const orig = typeof cfg?.__origName === "string" ? cfg.__origName : "";
    // addMcpServerConfig 替换语义：同名覆盖；改名 = 写新键 + 删旧键
    mod.addMcpServerConfig(file, n, clean);
    if (orig && orig !== n) mod.removeMcpServerConfig(file, orig);
  } else {
    throw new Error("未知操作: " + String(op));
  }
  console.log("[settings] mcp.json saved:", op, n);
  await reloadIdleSessions();
  return { ok: true };
});

/* ---------- 设置中心 R4-2：自定义提供商 models.json 表单化（2026-10-05） ----------
 * models.json 无权威变更函数（pi 只读它），读-改-写只碰 providers[name] 键，
 * 根上其他字段（令未来扩展）原样保留；保存后刷新各会话 modelRuntime，新 provider 立即进模型列表。 */
const CUSTOM_MODEL_APIS = new Set([
  "openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai",
  "azure-openai-responses", "openai-codex-responses", "google-vertex", "pi-messages",
  "zai-coding-cn", // 智谱 Coding 套餐官方协议（2026-10-13 向导 preset 用；pi 原生 models.json 不限 api 枚举，白名单是本侧加严）
]);
function customModelsPath() {
  return path.join(pi.getAgentDir(), "models.json");
}
function readCustomModels() {
  const p = customModelsPath();
  let text;
  try {
    text = fs.readFileSync(p, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return { root: {}, exists: false };
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(text); // 坏 JSON 直接抛给 UI 显示，绝不覆盖用户文件
  } catch (err) {
    throw err; // 原样上抛，保持既有行为
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("models.json 根必须是对象");
  if (parsed.providers !== undefined && (typeof parsed.providers !== "object" || Array.isArray(parsed.providers))) {
    throw new Error("models.json 的 providers 必须是对象");
  }
  return { root: parsed, exists: true };
}
ipcMain.handle("models:customList", async () => {
  const p = customModelsPath();
  try {
    const { root, exists } = readCustomModels();
    return { path: p, exists, providers: root.providers ?? {} };
  } catch (err) {
    return { path: p, exists: true, providers: {}, error: String(err?.message ?? err) };
  }
});
/** 表单配置白名单化：api 只收已知八类，模型条目仅收 id/name/contextWindow；apiKey 原样透传（${VAR}/$VAR/!command/字面量） */
function sanitizeCustomProvider(cfg) {
  if (!cfg || typeof cfg !== "object") throw new Error("提供商配置为空");
  const out = {};
  const disp = String(cfg.name ?? "").trim();
  if (disp) out.name = disp;
  const base = String(cfg.baseUrl ?? "").trim();
  if (!/^https?:\/\//i.test(base)) throw new Error("baseUrl 必须以 http(s):// 开头");
  out.baseUrl = base;
  const api = String(cfg.api ?? "openai-completions");
  if (!CUSTOM_MODEL_APIS.has(api)) throw new Error("不支持的 API 类型: " + api);
  out.api = api;
  const key = String(cfg.apiKey ?? "").trim();
  if (key) out.apiKey = key; // 建议渲染端引导 ${VAR}，此处不强制（本地 llama.cpp 类常填 dummy）
  const modelsIn = Array.isArray(cfg.models) ? cfg.models : [];
  if (!modelsIn.length) throw new Error("至少配置一个模型（每行一个 id）");
  const models = [];
  for (const m of modelsIn) {
    const id = String(m?.id ?? "").trim();
    if (!id) throw new Error("模型 id 不能为空");
    const mm = { id };
    const nm = String(m?.name ?? "").trim();
    if (nm) mm.name = nm;
    const cw = Number(m?.contextWindow);
    if (Number.isFinite(cw) && cw > 0) mm.contextWindow = Math.round(cw);
    // reasoning 声明（2026-10-13 三档锁死 bug 修复）：缺省时 pi-ai 判定模型仅支持 off 思考档——
    // 场景三档/思考 chips 全部静默 clamp 回 off（getSupportedThinkingLevels: !model.reasoning → ["off"]）
    if (m?.reasoning === true) mm.reasoning = true;
    models.push(mm);
  }
  out.models = models;
  return out;
}
async function saveCustomProvider(op, name, cfg) {
  const n = String(name ?? "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(n)) throw new Error(`非法提供商名: ${n}（字母数字开头，仅 ._ -）`);
  const { root } = readCustomModels();
  if (op === "delete") {
    if (root.providers?.[n] !== undefined) delete root.providers[n];
  } else if (op === "set") {
    const orig = typeof cfg?.__origName === "string" ? cfg.__origName : "";
    const clean = sanitizeCustomProvider(cfg);
    root.providers ??= {};
    root.providers[n] = clean; // 同名覆盖；改名 = 写新键删旧键
    if (orig && orig !== n) delete root.providers[orig];
  } else {
    throw new Error("未知操作: " + String(op));
  }
  fs.writeFileSync(customModelsPath(), JSON.stringify(root, null, 2) + "\n");
  console.log("[settings] models.json saved:", op, n);
  // 刷新各会话模型运行时：新 provider 立即进模型列表（getAvailable 重读 models.json）
  for (const [, en] of sessionMap) {
    try { await en.session?.modelRuntime?.refresh?.(); } catch { /* 单会话失败不阻塞 */ }
  }
}
ipcMain.handle("models:customSave", async (_e, op, name, cfg) => {
  await saveCustomProvider(op, name, cfg);
  return { ok: true };
});

/* ---------- 引导向导（2026-10-12 开源阶段 1：首启动配置环境，交互稿 design/onboarding-wizard-20261012.html） ----------
 * 四家预置 + 自定义兜底；key 明文落 ~/.pi/agent/models.json（Q7 拍板，README 披露）；
 * onboard:test 只打一次 /models 列表接口（零 token 零费用）；PI_GUI_TEST_ONBOARD=1 时全链路零网络零写盘（verify 用）。 */
const ONBOARD_PRESETS = {
  zhipu: {
    label: "智谱 GLM", providerName: "zhipu",
    // zai 官方协议 + Coding 端点（2026-10-13 实测定案）：open.bigmodel.cn 开放平台端点为 OpenAI 兼容形态
    // 思考档最高只到 high；api.z.ai coding 端点走 zai-coding-cn 协议支持完整三档（max），与 owner 正式环境同构。
    // ⚠️ 需 Coding 套餐 key；开放平台 key 在此端点会 401（测试连接时报错可见）
    api: "zai-coding-cn",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    regUrl: "https://open.bigmodel.cn", regHost: "open.bigmodel.cn",
    desc: "GLM-5.3 系列。有面向编程的包月套餐，也有按量计费；国内直连稳定。",
    tags: ["推荐", "人民币直付", "Coding 套餐"],
    steps: ["打开 open.bigmodel.cn（智谱开放平台）注册并登录（手机号即可）", "进入「API Keys」页面，点击「创建 API Key」", "复制生成的 Key（只显示一次），粘贴到下一步"],
    models: [
      { id: "glm-5.3", name: "GLM-5.3", contextWindow: 1000000, desc: "旗舰：推理+编程综合最强，100 万上下文", badge: "推荐" },
      { id: "glm-5.3-flash", name: "GLM-5.3-Flash", contextWindow: 1000000, desc: "轻量快速：日常问答与简单任务，价格约为旗舰 1/10", badge: "省钱" },
    ],
  },
  deepseek: {
    label: "DeepSeek", providerName: "deepseek",
    baseUrl: "https://api.deepseek.com",
    regUrl: "https://platform.deepseek.com", regHost: "platform.deepseek.com",
    desc: "deepseek-chat / reasoner，价格厚道，推理能力强。",
    tags: ["人民币直付", "按量计费"],
    steps: ["打开 platform.deepseek.com 注册并登录", "左侧「API keys」→「创建 API key」", "复制 Key（只显示一次），粘贴到下一步"],
    models: [
      { id: "deepseek-chat", name: "DeepSeek-Chat (V3)", desc: "通用对话与编程，性价比高", badge: "推荐" },
      { id: "deepseek-reasoner", name: "DeepSeek-Reasoner (R1)", desc: "深度推理：复杂问题更慢但更强", badge: null },
    ],
  },
  kimi: {
    label: "Kimi（月之暗面）", providerName: "moonshot",
    baseUrl: "https://api.moonshot.cn/v1",
    regUrl: "https://platform.moonshot.cn", regHost: "platform.moonshot.cn",
    desc: "Kimi K2 系列，超长上下文窗口适合大型项目。",
    tags: ["人民币直付", "长上下文"],
    steps: ["打开 platform.moonshot.cn（月之暗面开放平台）注册登录", "「API Key 管理」→「新建」", "复制 Key，粘贴到下一步"],
    models: [
      { id: "kimi-k2", name: "Kimi K2", desc: "MoE 旗舰，256K 上下文", badge: "推荐" },
      { id: "kimi-k2-flash", name: "Kimi K2 Flash", desc: "轻量快速档", badge: null },
    ],
  },
  openrouter: {
    label: "OpenRouter", providerName: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    regUrl: "https://openrouter.ai", regHost: "openrouter.ai",
    desc: "一个 Key 用遍 Claude / GPT / Gemini 等国际模型。国内访问可能需要网络条件。",
    tags: ["聚合 400+ 模型", "需外币卡"],
    steps: ["打开 openrouter.ai 注册登录（支持 Google / GitHub 账号）", "头像 → Keys →「Create key」", "复制以 sk-or- 开头的 Key，粘贴到下一步"],
    models: [
      { id: "anthropic/claude-sonnet", name: "Claude Sonnet", desc: "Anthropic 旗舰，编程能力顶级", badge: null },
      { id: "openai/gpt-5", name: "GPT-5", desc: "OpenAI 旗舰", badge: null },
      { id: "deepseek/deepseek-chat", name: "DeepSeek V3", desc: "聚合通道里的性价比之选", badge: "省钱" },
    ],
  },
  custom: {
    label: "自定义 OpenAI 兼容端点", providerName: "custom",
    baseUrl: "",
    regUrl: "", regHost: "（你的服务商控制台）",
    desc: "中转站、私有部署或任何兼容 OpenAI API 的服务（手填地址与 Key）。",
    tags: ["进阶"],
    steps: ["在你的服务商控制台创建 API Key", "记下服务的 API 地址（OpenAI 兼容端点，以 http(s):// 开头）", "把地址与 Key 都填到下一步"],
    models: [], // custom：测试连接成功后用 /models 返回的 id 列表动态填充
  },
};
ipcMain.handle("onboard:presets", () => ONBOARD_PRESETS);
ipcMain.handle("onboard:test", async (_e, preset, baseUrl, apiKey) => {
  if (process.env.PI_GUI_TEST_ONBOARD === "1") return { ok: true, count: 2, ids: ["demo-model-a", "demo-model-b"] }; // 测试钩子：零网络
  const P = ONBOARD_PRESETS[preset];
  const base = String(baseUrl || P?.baseUrl || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) return { ok: false, error: "地址必须以 http(s):// 开头" };
  const key = String(apiKey ?? "").trim();
  try {
    const r = await fetch(base + "/models", { headers: { Authorization: "Bearer " + key }, signal: AbortSignal.timeout(12000) });
    if (r.status === 401 || r.status === 403) return { ok: false, error: `验证失败（${r.status}）：Key 无效或无权限` };
    if (!r.ok) return { ok: false, error: `验证失败（HTTP ${r.status}）——检查端点地址是否为 OpenAI 兼容 base` };
    let ids = [];
    try { const j = await r.json(); if (Array.isArray(j?.data)) ids = j.data.map((m) => String(m?.id ?? "")).filter(Boolean).slice(0, 30); } catch { /* 非 JSON 响应按连通成功处理 */ }
    return { ok: true, count: ids.length || (P?.models?.length ?? 0), ids };
  } catch (e) {
    const msg = e?.name === "TimeoutError" ? "超时（12s）——检查网络或端点地址" : String(e?.message ?? e);
    return { ok: false, error: "连接失败：" + msg };
  }
});
ipcMain.handle("onboard:save", async (_e, preset, cfg) => {
  const P = ONBOARD_PRESETS[preset];
  if (!P) throw new Error("未知服务商: " + String(preset));
  const isTest = process.env.PI_GUI_TEST_ONBOARD === "1";
  const provName = preset === "custom" ? String(cfg?.providerName ?? "").trim() || "custom" : P.providerName;
  let modelsIn;
  if (preset === "custom") {
    modelsIn = (Array.isArray(cfg?.models) ? cfg.models : []).map((m) => (typeof m === "string" ? { id: m } : m));
    if (!modelsIn.length) throw new Error("custom 端点至少需要一个模型 id");
  } else {
    // reasoning: true 必带（2026-10-13 三档锁死修复）：preset 模型全是推理模型，缺声明会被 pi-ai
    // 判定仅支持 off 思考档——场景三档/思考档全部静默失效
    modelsIn = P.models.map((m) => ({ id: m.id, reasoning: true, ...(m.name ? { name: m.name } : {}), ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}) }));
  }
  if (!isTest) {
    await saveCustomProvider("set", provName, {
      name: preset === "custom" ? provName : P.label,
      baseUrl: String(cfg?.baseUrl || P.baseUrl || "").trim(),
      api: String(P.api || "openai-completions"), // preset 可声明协议（zhipu=zai-coding-cn 官方协议）
      apiKey: String(cfg?.apiKey ?? "").trim(),
      models: modelsIn,
    });
    // 设默认模型：refresh 已在 saveCustomProvider 内跑过，curSession 的 runtime 此时应认识新 provider
    const rt = curSession()?.modelRuntime;
    const modelId = String(cfg?.modelId ?? "");
    const found = rt?.getModel?.(provName, modelId);
    if (!found) throw new Error(`模型 ${provName}/${modelId} 在刷新后仍不可见——请重启应用后在设置中手动设默认`);
    const sm = pi.SettingsManager.create(cur()?.cwd ?? os.homedir(), pi.getAgentDir());
    sm.setDefaultModelAndProvider(found.provider, found.id);
    // 三档在配置环节就位（owner 2026-10-13 建议）：默认思考强度=high（「工作」档语义），
    // 新会话开箱即在三档体系内；用户自定义去设置中心改
    sm.setDefaultThinkingLevel("high");
    // enabledModels 白名单在场时追加新模型（2026-10-12 冒烟实锤：老用户白名单只列旧 provider，新 provider 会被过滤出下拉；
    // 全新用户无此键不受影响）。storage.withLock("global") 是 SDK 权威写原语（agent:setKeep 同款，保其余字段原样）
    try {
      sm.storage.withLock("global", (current) => {
        let obj;
        try { obj = current ? JSON.parse(current) : {}; } catch { throw new Error("settings.json 不是合法 JSON，enabledModels 未追加"); }
        if (Array.isArray(obj.enabledModels)) {
          const add = modelsIn.map((m) => provName + "/" + m.id).filter((x) => !obj.enabledModels.includes(x));
          if (add.length) obj.enabledModels = [...obj.enabledModels, ...add];
        }
        return JSON.stringify(obj, null, 2) + "\n";
      });
    } catch (e) { console.log("[onboard] enabledModels 追加失败（不影响主流程）:", String(e?.message ?? e)); }
    console.log("[onboard] provider saved + default set:", provName, modelId);
    return { ok: true, provider: provName, model: cfg?.modelId ?? "" };
  }
  return { ok: true, provider: provName, model: cfg?.modelId ?? "" };
});

/* ---------- 设置中心 R4-3：设默认模型（新会话默认，2026-10-05） ----------
 * createAgentSession 每次都 SettingsManager.create() 重读 settings.json，
 * 写入后新建会话即时生效；只影响新会话，不动当前会话。 */
ipcMain.handle("settings:defaultModel", async (_e, op, providerId, modelId) => {
  const sm = pi.SettingsManager.create(cur()?.cwd ?? undefined, pi.getAgentDir());
  if (op === "get") {
    return { provider: sm.getDefaultProvider() ?? null, model: sm.getDefaultModel() ?? null };
  }
  if (op === "set") {
    // 校验模型在当前目录真实存在（防写坏 settings）
    const rt = curSession()?.modelRuntime;
    const m = rt?.getModel?.(String(providerId ?? ""), String(modelId ?? ""));
    if (!m) throw new Error(`模型不存在或未接入: ${providerId}/${modelId}`);
    sm.setDefaultModelAndProvider(m.provider, m.id);
    console.log("[settings] default model set:", m.provider + "/" + m.id);
    return { ok: true };
  }
  throw new Error("未知操作: " + String(op));
});

/* ---------- 代理行为（批次②）：默认思考强度 + 压缩档（写 settings.json，新会话生效） ---------- */
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]); // P2：补 off——与渲染端会话档位集对齐（原缺档导致 set off 报「非法」）
const KEEP_PRESETS = new Set([32000, 20000, 12000]); // 保守多留 / 平衡(SDK 默认 2 万) / 激进早剪
ipcMain.handle("agent:get", () => {
  const sm = pi.SettingsManager.create(cur()?.cwd ?? os.homedir(), pi.getAgentDir());
  return { thinking: sm.getDefaultThinkingLevel() ?? null, keep: sm.getCompactionKeepRecentTokens() };
});
ipcMain.handle("agent:setThinking", (_e, level) => {
  const sm = pi.SettingsManager.create(cur()?.cwd ?? os.homedir(), pi.getAgentDir());
  if (level === null || level === "") {
    // 清档=删键回「跟随模型」：setDefaultThinkingLevel 签名必传，删键走 storage.withLock 权威原语
    // （withLock 在 storage 上而非 SettingsManager 实例——d.ts 声明有迷惑性，实测实例无此方法）
    sm.storage.withLock("global", (current) => {
      if (!current) return current;
      let obj;
      try { obj = JSON.parse(current); } catch { throw new Error("settings.json 不是合法 JSON，拒改（消档未执行）"); }
      delete obj.defaultThinkingLevel;
      return JSON.stringify(obj, null, 2) + "\n";
    });
    console.log("[settings] default thinking level cleared");
    return { ok: true, thinking: null };
  }
  if (!THINKING_LEVELS.has(level)) throw new Error("非法思考档位: " + level);
  sm.setDefaultThinkingLevel(level);
  console.log("[settings] default thinking level:", level);
  return { ok: true, thinking: level };
});
ipcMain.handle("agent:setKeep", (_e, keep) => {
  const n = Number(keep);
  if (!KEEP_PRESETS.has(n)) throw new Error("非法压缩档: " + keep);
  const sm = pi.SettingsManager.create(cur()?.cwd ?? os.homedir(), pi.getAgentDir());
  // keepRecentTokens 无专属 setter：storage.withLock 是 SDK 的权威写原语（保其余字段原样）
  sm.storage.withLock("global", (current) => {
    let obj;
    try { obj = current ? JSON.parse(current) : {}; } catch { throw new Error("settings.json 不是合法 JSON，拒改（压缩档未写入）"); }
    obj.compaction = { ...(obj.compaction ?? {}), keepRecentTokens: n };
    return JSON.stringify(obj, null, 2) + "\n";
  });
  console.log("[settings] compaction.keepRecentTokens:", n);
  return { ok: true, keep: n };
});

/* 主题窗口底色同步（批次②）：渲染端切主题后把 BrowserWindow 底色对齐（白名单防任意写） */
const THEME_BGS = new Set(["#faf8f4", "#f4f7ef"]);
ipcMain.handle("app:themeBg", (_e, color) => {
  if (!THEME_BGS.has(color)) return { ok: false };
  if (win && !win.isDestroyed()) win.setBackgroundColor(color);
  return { ok: true };
});

ipcMain.handle("session:models", async () => {
  const rt = curSession()?.modelRuntime;
  if (!rt) return [];
  try {
    // 只返回已接入（有凭据）的模型，而非全量目录
    const models = (await rt.getAvailable?.()) ?? rt.getModels?.() ?? [];
    let list = models.map(modelInfo);
    // 2026-10-06：尊重 settings.json enabledModels（pi 语义：空=不圈选全显示，非空=白名单，大小写不敏感精确匹配，对齐 TUI 循环范围）
    try {
      const sm = pi.SettingsManager.create(cur()?.cwd ?? os.homedir(), pi.getAgentDir());
      const enabled = sm.getEnabledModels();
      if (Array.isArray(enabled) && enabled.length) {
        const allow = new Set(enabled.map((s) => String(s).toLowerCase()));
        list = list.filter((m) => allow.has((m.provider + "/" + m.id).toLowerCase()));
      }
    } catch { /* enabled 读取失败按不过滤处理，不阻塞模型列表 */ }
    return list;
  } catch (err) {
    console.error("[ipc] getAvailable failed, fallback to all:", err);
    return (rt.getModels?.() ?? []).map(modelInfo);
  }
});

ipcMain.handle("session:setModel", async (_e, providerId, modelId) => {
  const s = curSession();
  if (!s) throw new Error("会话未创建");
  const m = s.modelRuntime.getModel(providerId, modelId);
  if (!m) throw new Error(`模型不存在: ${providerId}/${modelId}`);
  await s.setModel(m);
  return getState();
});

/* 当前模型真实可用思考档（2026-10-13 三档动态适配）：不同端点能力不同——如智谱兼容端点仅
 * off/low/medium/high（无 max），场景三档据此动态取值，杜绝硬编码档位的静默降级 */
ipcMain.handle("session:thinkingLevels", () => {
  const s = curSession();
  return s?.getAvailableThinkingLevels?.() ?? [];
});

/* B3 启动自检 IPC：打开上次 fatal 日志（顺便 ack）/ 仅确认。preload 白名单暴露 */
ipcMain.handle("app:openFatalLog", () => {
  // 顺序坑（2026-10-07 owner 实测点查看无反应）：先 ack 改名再 openPath 旧路径 = 文件不存在静默失败。
  // 先解析存在的一方（ack 前后兼容），再 ack，再打开；返回结构化结果供 verify 断言
  const base = unackedFatal?.path ?? path.join(app.getPath("userData"), "run.err.log");
  const target = fs.existsSync(base) ? base : base + ".acked";
  ackFatalLog();
  return shell.openPath(target).then((result) => {
    // openPath 失败实测根因（2026-10-08 run.err.log 铁证）：.log 在本机无关联打开程序 → "Failed to open path"。
    // 兑底链：资源管理器定位文件（showItemInFolder 不依赖文件关联，必达）→ 再失败才 logFatal。
    let fallback = null;
    if (result) {
      try { shell.showItemInFolder(target); fallback = "located"; }
      catch { logFatal("openFatalLog", `openPath(${target}) 且兑底均失败: ${result}`); fallback = "failed"; }
    }
    return { opened: target, result, fallback };
  });
});
ipcMain.handle("app:ackFatalLog", () => { ackFatalLog(); return true; });

/* 设置→日志 tab 数据源（2026-10-10 owner 拍板：启动顶部提醒条撤销，异常记录入口收进设置）。
   run.err.log 存在 = 未确认（设置里高亮提醒）；不存在则回看 .acked 历史 = 已确认。tail 供页内预览。 */
ipcMain.handle("app:fatalInfo", () => {
  try {
    const p = path.join(app.getPath("userData"), "run.err.log");
    const dir = app.getPath("userData");
    const target = fs.existsSync(p) ? p : p + ".acked";
    if (!fs.existsSync(target)) return { has: false, dir };
    const text = fs.readFileSync(target, "utf8").trim();
    if (!text) return { has: false, dir };
    // has 只看「值得报警的异常」（过滤自证无害的 BENIGN_FATAL_KINDS）；tail 照常预览全部条目
    const alarm = lastAlarmLine(text);
    if (!alarm) return { has: false, dir, tail: text.slice(-4000) };
    return { has: true, unacked: fs.existsSync(p), kind: alarm.kind, time: alarm.time, path: target, dir, tail: text.slice(-4000) };
  } catch (err) { return { has: false, error: String(err?.message ?? err) }; }
});

/* ---------- 图片附件 ---------- */

const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024; // 单张上限（base64 后约 20MB）

/** 校验渲染端传来的图片，返回合法的 ImageContent[]（多余/非法直接丢弃） */
function sanitizeImages(images) {
  if (!Array.isArray(images)) return [];
  const out = [];
  for (const im of images) {
    if (out.length >= MAX_IMAGES) break;
    if (!im || typeof im.data !== "string" || !IMAGE_MIME.has(im.mimeType)) continue;
    if (!im.data || im.data.length > MAX_IMAGE_BYTES * 1.4) continue;
    out.push({ type: "image", data: im.data, mimeType: im.mimeType });
  }
  return out;
}

ipcMain.handle("session:prompt", async (_e, text, images, opts) => {
  const s = curSession();
  if (!s) throw new Error("会话未创建");
  const imgs = sanitizeImages(images);
  const hasText = typeof text === "string" && text.trim();
  if (!hasText && !imgs.length) return false;
  try {
    // opts.streamingBehavior：流式期间 prompt 必带（SDK 约束）——命令文本走此通道，流式中也能立即处理扩展命令
    await s.prompt(hasText ? text : "（见图片）", {
      ...(imgs.length ? { images: imgs } : {}),
      ...(opts?.streamingBehavior === "followUp" || opts?.streamingBehavior === "steer" ? { streamingBehavior: opts.streamingBehavior } : {}),
    });
  } catch (err) {
    emit({ type: "host_error", sessionId: cur()?.id, message: String(err?.message ?? err) });
    return "error";
  }
  return true;
});

ipcMain.handle("session:compact", async () => {
  const en = cur();
  if (!en || !en.session) throw new Error("会话未创建");
  if (en.agentRunning) return { ok: false, error: "任务运行中，请先停止再压缩" };
  try {
    const r = await en.session.compact();
    const ok = !!(r && JSON.stringify(r).includes("fastJev"));
    return { ok, engine: ok ? "fast-jev-compaction" : "内置摘要" };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
});

ipcMain.handle("session:followUp", async (_e, text, images) => {
  const s = curSession();
  if (!s) throw new Error("会话未创建");
  const imgs = sanitizeImages(images);
  try {
    return await s.followUp(text, imgs.length ? imgs : undefined);
  } catch (err) {
    emit({ type: "host_error", sessionId: cur()?.id, message: String(err?.message ?? err) });
    return "error";
  }
});

ipcMain.handle("session:abort", async () => {
  const en = cur();
  if (en) {
    try {
      await en.session.abort();
    } finally {
      en.agentRunning = false; // abort 抛错也复位：托盘 tooltip/关闭确认不再永挂「运行中」（2026-10-12 审计乙批）
    }
  }
  return true;
});

/* UI 级关闭（2026-10-03）：按磁盘路径卸载内存中的会话 entry（与归档不同：归档仅列表隐藏，不动内存）
   - 关的是当前会话 → 切到内存中剩余的任一 entry；一个不剩则返回 state:null，由渲染端新建
   - 会话文件保留，可随时从侧栏重新打开（走磁盘重新加载） */
ipcMain.handle("session:close", async (_e, sessionPath) => {
  if (!sessionPath) throw new Error("缺少 sessionPath");
  let targetId = null;
  for (const [id, en] of sessionMap) {
    if ((en.session.sessionFile ?? en.sessionPath) === sessionPath) { targetId = id; break; }
  }
  if (!targetId) return { closed: false, reason: "not-in-memory" };
  const wasCurrent = targetId === currentKey;
  disposeEntry(targetId);
  let nextState = null;
  if (wasCurrent && cur()) nextState = getState(); // 切到剩余 entry；全空则 state:null 由渲染端新建
  console.log("[ipc] session:close", sessionPath, "wasCurrent:", wasCurrent, "remaining:", sessionMap.size);
  return { closed: true, wasCurrent, state: nextState };
});

/* ---------- 会话分支（查看/切换） ---------- */

function entryPreview(sm, leafEntry) {
  let id = leafEntry?.id;
  while (id) {
    const e = sm.getEntry(id);
    if (!e) break;
    if (e.type === "message" && e.message?.role === "user") {
      const c = e.message.content;
      const t = typeof c === "string"
        ? c
        : Array.isArray(c)
          ? c.filter((b) => b?.type === "text").map((b) => b.text).join(" ")
          : "";
      if (t.trim()) return t.trim().slice(0, 80);
    }
    id = e.parentId;
  }
  return "";
}

ipcMain.handle("session:branches", () => {
  const sm = curSession()?.sessionManager;
  if (!sm) return { leafId: null, leaves: [] };
  const leafId = sm.getLeafId();
  const activeSet = new Set(sm.getBranch().map((e) => e.id));
  const leaves = [];
  const walk = (node) => {
    if (!node.children?.length) leaves.push(node);
    for (const c of node.children ?? []) walk(c);
  };
  for (const root of sm.getTree()) walk(root);
  return {
    leafId,
    leaves: leaves.map((l) => ({
      id: l.entry.id,
      active: l.entry.id === leafId,
      onActive: activeSet.has(l.entry.id),
      preview: entryPreview(sm, l.entry),
      time: fmtLocal(new Date(l.entry.timestamp ?? "")),
    })).sort((a, b) => (a.active === b.active ? (b.time > a.time ? 1 : -1) : a.active ? -1 : 1)),
  };
});

ipcMain.handle("session:navigate", async (_e, targetId) => {
  const en = cur();
  if (!en) throw new Error("会话未创建");
  const r = await en.session.navigateTree(String(targetId), { summarize: false });
  if (r.cancelled) return { cancelled: true };
  return { cancelled: false, state: getState(en), messages: safeSerialize(en.session.messages) };
});

/* D1 跨会话分支拾遗（2026-10-07 owner 拍板拓展现有分支面板）：
   弃用分支数据全在磁盘（会话树），缺的只是入口。离线扫描 sessions 目录多叶子（>1）会话，
   SessionManager.open 只读建树（无写副作用；正被活跃会话写入的文件解析失败自然跳过）。 */
ipcMain.handle("branches:scanAll", async (_e, opts) => {
  const root = path.join(pi.getAgentDir(), "sessions");
  const dirs = [];
  if (opts?.dir && fs.statSync(path.join(root, opts.dir)).isDirectory()) {
    dirs.push(opts.dir); // verify 可限定目录注入 fixture，不扫全库
  } else {
    for (const d of fs.readdirSync(root)) {
      try { if (fs.statSync(path.join(root, d)).isDirectory()) dirs.push(d); } catch { /* 忽略 */ }
    }
  }
  const out = [];
  for (const d of dirs) {
    const full = path.join(root, d);
    let files = [];
    try { files = fs.readdirSync(full).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    for (const f of files) {
      const p = path.join(full, f);
      try {
        const sm = pi.SessionManager.open(p);
        const leafId = sm.getLeafId();
        const activeSet = new Set(sm.getBranch().map((e) => e.id));
        const leaves = [];
        const walk = (node) => {
          if (!node.children?.length) leaves.push(node);
          for (const c of node.children ?? []) walk(c);
        };
        for (const r of sm.getTree()) walk(r);
        if (leaves.length < 2) continue; // 单分支会话不列
        // cwd 取首行：流式局部读 4KB（2026-10-12 审计乙批——此前 readFileSync 整文件只为首行，
        // 73 会话 63MB 存量下同步秒级阻塞）；name 从已解析的 sm 树找 session_info entry，零重读
        let cwd = "";
        try {
          const fh = fs.openSync(p, "r");
          try {
            const buf = Buffer.alloc(4096);
            const nread = fs.readSync(fh, buf, 0, 4096, 0);
            const first = buf.toString("utf8", 0, nread).split("\n")[0] || "{}";
            try { cwd = JSON.parse(first).cwd ?? ""; } catch { /* 首行异常 */ }
          } finally { fs.closeSync(fh); }
        } catch { /* 读不出按空 */ }
        let name = "";
        const findInfo = (node) => {
          if (node.entry?.type === "session_info") {
            const m = JSON.stringify(node.entry).match(/"name":"([^"]{1,40})"/);
            if (m) { name = m[1]; return true; }
          }
          for (const c of node.children ?? []) if (findInfo(c)) return true;
          return false;
        };
        for (const r of sm.getTree()) if (findInfo(r)) break;
        out.push({
          file: p,
          name: name || f.slice(0, 19),
          cwd,
          leafCount: leaves.length,
          mtime: fs.statSync(p).mtimeMs,
          leaves: leaves.map((l) => ({
            id: l.entry.id,
            active: l.entry.id === leafId,
            onActive: activeSet.has(l.entry.id),
            preview: entryPreview(sm, l.entry) || "（无用户消息）",
            time: fmtLocal(new Date(l.entry.timestamp ?? "")),
          })).sort((a, b) => (a.active === b.active ? (b.time > a.time ? 1 : -1) : a.active ? -1 : 1)),
        });
      } catch { /* 坏文件/并发写入：跳过 */ }
    }
  }
  return { sessions: out.sort((a, b) => b.mtime - a.mtime) };
});

/* D1 跨会话导航：打开（或切到内存中的）目标会话并直接切到指定叶子，一次返回目标分支视图 */
ipcMain.handle("session:navigateTo", async (_e, sessionPath, cwd, leafId) => {
  await createSession(cwd || undefined, sessionPath); // 内存有则切视图，无则 open 磁盘
  const r = await cur().session.navigateTree(String(leafId), { summarize: false });
  if (r.cancelled) return { cancelled: true };
  return { cancelled: false, state: getState(), messages: safeSerialize(cur().session.messages) };
});

/* ---------- /rename：整理任务历史并改名当前会话（2026-10-04 owner 需求） ---------- */

/* 从会话历史提取精简对话文本（用户消息为主）：自动起名用，命令消息不参与 */
function transcriptForNaming(en) {
  const parts = [];
  for (const m of en.session.messages ?? []) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const c = m.content;
    let text = "";
    if (typeof c === "string") text = c;
    else if (Array.isArray(c)) text = c.filter((b) => b?.type === "text").map((b) => b.text).join(" ");
    text = text.replace(/\s+/g, " ").trim();
    if (!text || text.startsWith("/")) continue;
    parts.push((m.role === "user" ? "用户: " : "助手: ") + text.slice(0, 300));
  }
  // 过长时保头（任务目标通常在开头）+保尾（最新进展）
  const MAX_PARTS = 60;
  const picked = parts.length > MAX_PARTS
    ? [...parts.slice(0, 30), "……（中间省略）……", ...parts.slice(-29)]
    : parts;
  return picked.join("\n").slice(0, 24000);
}

/* 清洗模型输出成可用会话名：取首行、去引号标点、限长 */
function cleanSessionName(raw) {
  let out = String(raw ?? "").trim().split("\n")[0];
  out = out.replace(/^["'「『【]+|["'」』】。.]+$/g, "").trim();
  return out.slice(0, 40);
}

ipcMain.handle("session:rename", (_e, name) => {
  const en = cur();
  if (!en) throw new Error("会话未创建");
  const clean = cleanSessionName(name);
  if (!clean) throw new Error("名字不能为空");
  en.session.setSessionName(clean); // appendSessionInfo 落盘，侧栏 SessionManager.list 即可读到
  console.log("[ipc] session:rename ->", clean);
  return { name: en.session.name ?? clean };
});

/* 无参数 /rename：临时会话读历史自动起名（noTools 纯文本，不进主对话、不占用主上下文） */
ipcMain.handle("session:autoName", async () => {
  const en = cur();
  if (!en) throw new Error("会话未创建");
  const transcript = transcriptForNaming(en);
  if (!transcript) throw new Error("会话还没有对话内容，无法自动起名");
  const m = en.session.model;
  const modelRef = m ? `${typeof m.provider === "string" ? m.provider : (m.provider?.id ?? m.providerId ?? "")}|${m.id}` : undefined;
  let sub;
  try {
    sub = await createEphemeralSession(modelRef, true);
  } catch (err) {
    throw new Error("临时会话启动失败: " + String(err?.message ?? err));
  }
  try {
    await sub.prompt(
      "你在给一个编码助手会话起名。根据下面的对话历史概括该任务主题，起一个简短准确的中文会话名。\n" +
      "要求：不超过 14 个字；不含引号、句号等标点；直接输出名字本身，不要任何解释或前缀。\n\n对话历史：\n" + transcript
    );
    const out = cleanSessionName(sub.getLastAssistantText?.());
    if (!out) throw new Error("模型没有返回有效名字");
    en.session.setSessionName(out);
    console.log("[ipc] session:autoName ->", out);
    return { name: out };
  } finally {
    try { sub.dispose(); } catch { /* 忽略 */ }
  }
});

/* ---------- 设置中心：pi.dev 社区包浏览与安装（2026-10-04 R1，owner 拍板接入 pi.dev 出站目标） ---------- */

/* pi.dev 无公开 JSON API（/api/* 返回 501），包数据内嵌在 SSR HTML 的 data-* 属性里；
   ?name= 服务端模糊匹配名称/描述/作者，?type= 过滤类型，?page= 分页（50/页） */
const CATALOG_BASE = "https://pi.dev/packages";

function decodeHtmlEntities(text) {
  return text
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;/g, "'").replace(/&nbsp;/g, " ");
}

function parseCatalogCard(card) {
  const pick = (re) => card.match(re)?.[1] ?? "";
  const name = pick(/data-package-name="([^"]+)"/);
  if (!name) return null;
  const types = pick(/data-package-types="([^"]*)"/).trim().split(/\s+/).filter(Boolean);
  return {
    name,
    description: decodeHtmlEntities(pick(/<p class="packages-desc">([\s\S]*?)<\/p>/).trim()),
    author: pick(/<div class="packages-meta">\s*<span>([^<]*)<\/span>/).trim(),
    types: types.length ? types : ["package"],
    downloads: Number(pick(/data-package-downloads="(\d+)"/) || 0),
    updatedAt: Number(pick(/data-package-date="(\d+)"/) || 0),
  };
}

async function fetchPackageCatalog({ query, type, page, sort }) {
  let url;
  try {
    url = new URL(CATALOG_BASE); // 常量基底不抛，合规包一层
  } catch (err) {
    throw err;
  }
  const q = String(query ?? "").trim();
  if (q) url.searchParams.set("name", q);
  if (type && ["extension", "skill", "prompt", "theme"].includes(type)) url.searchParams.set("type", type);
  if (sort === "date") url.searchParams.set("sort", "date"); // 周榜用：本周新发布在前
  const p = Math.max(1, Math.floor(Number(page) || 1));
  if (p > 1) url.searchParams.set("page", String(p));
  const res = await fetch(url, {
    headers: { "User-Agent": "pi-gui", Accept: "text/html" },
    signal: AbortSignal.timeout(20000), // pi.dev 首字节实测 ~7s，给足
  });
  if (!res.ok) throw new Error(`pi.dev 返回 HTTP ${res.status}`);
  const html = await res.text();
  const packages = [];
  for (const m of html.matchAll(/<article[^>]*data-package-card="true"[\s\S]*?<\/article>/g)) {
    const pkg = parseCatalogCard(m[0]);
    if (pkg) packages.push(pkg);
  }
  const totalText = html.match(/\d+-\d+\s*\/\s*([\d,]+)/)?.[1];
  const total = totalText ? Number(totalText.replace(/,/g, "")) : packages.length;
  return { packages, total, page: p, pageSize: 50 };
}

/* ---------- 每周插件精选（2026-10-08 owner 拍板：社区 tab 改每周推送，双源=pi.dev 社区 + GitHub 高星，
   契合 owner 工作生活流打分）---------- */
/* 契合画像：正分词（命中加分，理由回显）+ 负分词（遥测云服务/重型链——owner 用不上）。
 * 可按 owner 反馈随时调词表。 */
const FIT_POSITIVE = [
  ["chinese|中文|i18n|zh-", 3, "中文生态"],
  ["gui|desktop|electron|window", 2, "桌面/GUI"],
  ["todo|task|plan|workflow", 2, "任务/流程"],
  ["image|vision|photo|ocr", 2, "图像/视觉"],
  ["search|web|browser|fetch", 2, "搜索/联网"],
  ["memory|note|knowledge|wiki", 2, "记忆/笔记"],
  ["usage|cost|token|quota", 2, "用量/成本"],
  ["theme|appearance", 1, "外观"],
  ["markdown|report|weekly", 1, "文档/周报"],
  ["automation|schedule|notify", 2, "自动化"],
  ["xiaohongshu|wechat|social|content", 2, "内容运营"],
];
const FIT_NEGATIVE = [
  ["observability|langfuse|langsmith|tracing|telemetry|otlp", -6, "云遥测类（需账号/云服务）"],
  ["kubernetes|terraform|devops|ci/cd|jenkins", -5, "重型运维链"],
  ["lisp|haskell|erlang", -4, "小众语言栈"],
];
function fitScore(name, desc) {
  const text = `${name} ${desc}`.toLowerCase();
  let score = 0;
  const reasons = [];
  for (const [pat, w, label] of FIT_POSITIVE) {
    if (new RegExp(pat).test(text)) { score += w; reasons.push(label); }
  }
  for (const [pat, w, label] of FIT_NEGATIVE) {
    if (new RegExp(pat).test(text)) { score += w; reasons.push(label); }
  }
  return { score, reason: reasons.slice(0, 3).join("·") };
}

/** GitHub 高星 pi 生态（owner 2026-10-08 建议：按 stars；两查询实测精准，防树莓派 pi 乱入靠绑定 coding-agent 语境） */
async function fetchGitHubPiRepos() {
  const out = [];
  for (const q of ["pi-coding-agent+extension", "pi-coding-agent+skill"]) {
    try {
      const res = await fetch(`https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=15`, {
        headers: { "User-Agent": "pi-gui", Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);
      const j = await res.json();
      for (const it of j.items ?? []) {
        out.push({
          source: "github",
          name: it.full_name,
          npmName: it.name, // 仓库名与 npm 包名同名的可一键安装（渲染端按已装列表比对展示）
          description: String(it.description ?? "").slice(0, 140),
          types: ["github"],
          stars: it.stargazers_count ?? 0,
          url: it.html_url,
          updatedAt: Date.parse(it.updated_at ?? "") || 0,
        });
      }
    } catch (err) { console.log(`[pkg-weekly] GitHub 源失败（${q}）:`, err?.message ?? err); }
  }
  // 双查询去重
  const seen = new Map();
  for (const r of out) if (!seen.has(r.name) || r.stars > seen.get(r.name).stars) seen.set(r.name, r);
  return [...seen.values()];
}

const PKG_WEEKLY_TOP = 10;
function weeklyCachePath() { return path.join(app.getPath("userData"), "pkg-weekly.json"); }
function weekKey(d = new Date()) {
  // ISO 周（周一首日）：缓存键与红点判定用
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${String(1 + Math.round(((t - y0) / 86400000 - 1) / 7)).padStart(2, "0")}`;
}

async function buildWeeklyRank() {
  // 社区源：默认页（高下载）+ 本周新发布页
  const sources = [];
  try {
    const hot = await fetchPackageCatalog({ page: 1 });
    sources.push(...hot.packages.map((p) => ({ ...p, source: "community" })));
  } catch (err) { console.log("[pkg-weekly] 社区热榜失败:", err?.message ?? err); }
  try {
    const fresh = await fetchPackageCatalog({ page: 1, sort: "date" });
    sources.push(...fresh.packages.map((p) => ({ ...p, source: "community" })));
  } catch (err) { console.log("[pkg-weekly] 社区新发布失败:", err?.message ?? err); }
  sources.push(...(await fetchGitHubPiRepos()));
  // 去重：npm 名（社区 name vs GitHub 仓库名尾段）——社区优先（npm 名确切可安装）
  const byKey = new Map();
  for (const s of sources) {
    const key = s.source === "github" ? s.name.split("/").pop().toLowerCase() : s.name.toLowerCase();
    const prev = byKey.get(key);
    if (!prev) byKey.set(key, s);
    else {
      // 合并：热度取高者、来源标双、URL 带上
      prev.stars = Math.max(prev.stars ?? 0, s.stars ?? 0);
      if (s.source === "github") { prev.githubUrl = s.url; prev.stars = s.stars ?? prev.stars ?? 0; }
      if (prev.source === "github" && s.source === "community") Object.assign(prev, s, { githubUrl: prev.url, stars: Math.max(prev.stars ?? 0, s.downloads ? 0 : prev.stars ?? 0) });
    }
  }
  // 评分：契合分 × 源内热度百分位（两源量纲不同——downloads 数值远大于 stars，绝对值 log 后社区仍碾压，
  // 故按源内排名归一到 0~1 同量纲）× 本周发布/更新加成；GitHub 保底记 stars 供展示
  const now = Date.now();
  const withHeat = [...byKey.values()].map((p) => ({ ...p, _srcRankHeat: 0 }));
  for (const src of ["community", "github"]) {
    const pool = withHeat.filter((p) => p.source === src)
      .sort((a, b) => (src === "github" ? (b.stars ?? 0) - (a.stars ?? 0) : (b.downloads ?? 0) - (a.downloads ?? 0)));
    pool.forEach((p, i) => { p._srcRankHeat = pool.length > 1 ? 1 - i / pool.length : 1; });
  }
  const ranked = withHeat.map((p) => {
    const fit = fitScore(p.name, p.description);
    const freshBoost = p.updatedAt && now - p.updatedAt < 7 * 86400000 ? 1.2 : 1;
    return {
      name: p.name,
      npmName: p.source === "github" ? p.npmName : p.name,
      description: p.description,
      types: p.types,
      source: p.source,
      stars: p.stars ?? null,
      downloads: p.downloads ?? null,
      url: p.url ?? p.githubUrl ?? null,
      updatedAt: p.updatedAt ?? null,
      score: Math.round(((2 + fit.score) * (1 + p._srcRankHeat) * 2) * freshBoost * 10) / 10,
      reason: fit.reason || "热度入选",
    };
  }).sort((a, b) => b.score - a.score);
  return { week: weekKey(), fetchedAt: now, items: ranked.slice(0, PKG_WEEKLY_TOP) };
}

ipcMain.handle("pkg:weekly", async (_e, opts) => {
  const cp = weeklyCachePath();
  try {
    const cached = JSON.parse(fs.readFileSync(cp, "utf8"));
    if (!opts?.refresh && cached?.week === weekKey()) return cached;
  } catch { /* 无缓存/坏缓存 */ }
  const fresh = await buildWeeklyRank();
  try { fs.writeFileSync(cp, JSON.stringify(fresh, null, 2)); } catch { /* 写失败不阻塞返回 */ }
  return fresh;
});

/* 包管理器（用户级装卸，写 ~/.pi/agent/settings.json；懒加载单例） */
let _pkgManager = null;
function pkgManager() {
  if (!_pkgManager) {
    const cwd = currentCwd ?? os.homedir();
    _pkgManager = new pi.DefaultPackageManager({
      cwd,
      agentDir: pi.getAgentDir(),
      settingsManager: pi.SettingsManager.create(cwd, pi.getAgentDir()),
    });
  }
  return _pkgManager;
}

/* npm ENOENT（GUI 启动 PATH 不含 npm）→ 可读中文提示（Percho issue #18 同坑） */
function rethrowPkgError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (/(^|\b)spawn(\s+[^\s]+)*\s+npm(\.\w+)?\s+ENOENT\b/.test(msg) ||
      ((err?.code === "ENOENT") && typeof err?.syscall === "string" && /\bnpm\b/.test(err.syscall))) {
    throw new Error("找不到 npm：请安装 Node.js 并重后 GUI（设置→扩展的包安装依赖 npm）");
  }
  throw err;
}

/* 装/卸包后对空闲会话热重载（流式中跳过，对齐 CLI /reload），扩展立即生效 */
async function reloadIdleSessions() {
  for (const [, en] of sessionMap) {
    if (en.session.isStreaming) continue;
    try { await en.session.reload(); } catch (err) {
      console.warn("[settings] session reload failed:", err?.message ?? err);
    }
  }
}

ipcMain.handle("settings:catalogSearch", async (_e, query, type, page) => {
  try {
    return await fetchPackageCatalog({ query, type, page });
  } catch (err) {
    return { error: String(err?.message ?? err) };
  }
});

ipcMain.handle("settings:pkgList", () => {
  try {
    // 同步返回：[{ source, scope }]（scope: user/project）
    return { packages: pkgManager().listConfiguredPackages() };
  } catch (err) {
    return { packages: [], error: String(err?.message ?? err) };
  }
});

ipcMain.handle("settings:pkgInstall", async (_e, name) => {
  const n = String(name ?? "");
  if (!/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(n)) throw new Error(`非法包名: ${n}`);
  // P0 修复（2026-10-10 审计）：installAndPersist 在 Electron 主进程 stdout 形态下可能永不 resolve
  // （坑账：cmd.exe/npm 链 exit 事件不冒泡，按钮永久「安装中…」）——超时竞速 + pkgList 复核判真实成败
  const INSTALL_TIMEOUT_MS = 120_000;
  let timeoutTimer = null;
  const timedOut = new Promise((_, rej) => { timeoutTimer = setTimeout(() => rej(new Error("__pkg_timeout__")), INSTALL_TIMEOUT_MS); });
  try {
    await Promise.race([pkgManager().installAndPersist(`npm:${n}`), timedOut]);
  } catch (err) {
    if (String(err?.message) === "__pkg_timeout__") {
      const listed = pkgManager().listConfiguredPackages().some((p2) => {
        const src = String(p2?.source ?? "");
        return src === `npm:${n}` || src.startsWith(`npm:${n}@`);
      });
      if (listed) {
        console.log(`[settings] package install timed out but verified installed: ${n}`);
        await reloadIdleSessions();
        return { ok: true, note: "安装完成（超时后复核确认）" };
      }
      rethrowPkgError(new Error(`安装超时（${INSTALL_TIMEOUT_MS / 1000}s 无响应且配置未落盘）——请重试；反复超时查网络/npm 源`));
    }
    rethrowPkgError(err);
  } finally {
    clearTimeout(timeoutTimer);
  }
  console.log("[settings] package installed:", n);
  await reloadIdleSessions();
  return { ok: true };
});

ipcMain.handle("settings:pkgRemove", async (_e, source, scope) => {
  let removed;
  try {
    removed = await pkgManager().removeAndPersist(String(source ?? ""), { local: scope === "project" });
  } catch (err) { rethrowPkgError(err); }
  if (!removed) throw new Error(`未安装的包: ${source}`);
  console.log("[settings] package removed:", source);
  await reloadIdleSessions();
  return { ok: true };
});

/* ---------- 双模型对比 ---------- */

const cmpRuns = new Map();

ipcMain.handle("cmp:start", (_e, payload) => {
  if (!cur()) throw new Error("会话未创建"); // 旧全局 session 残留同步修（2026-10-05）
  const question = String(payload?.question ?? "").trim();
  if (!question) throw new Error("问题不能为空");
  const cmpId = "cmp" + Date.now();
  const run = { aborted: false, sessions: [] };
  cmpRuns.set(cmpId, run);
  const t0 = Date.now();
  const sides = [
    ["a", payload?.modelA],
    ["b", payload?.modelB],
  ];
  (async () => {
    await Promise.all(
      sides.map(async ([side, modelId]) => {
        let s;
        try {
          s = await createEphemeralSession(modelId || undefined, true); // 对比纯文本，不开工具
        } catch (err) {
          emit({ type: "cmp_event", cmpId, side, event: { type: "cmp_error", message: String(err?.message ?? err) } });
          return null;
        }
        run.sessions.push(s);
        if (run.aborted) {
          try { s.dispose(); } catch { /* 忽略 */ }
          return null;
        }
        s.subscribe((evt) => {
          if (run.aborted) return;
          if (evt.type === "message_update") {
            const e = evt.assistantMessageEvent;
            if (e && (e.type === "text_delta" || e.type === "thinking_delta")) {
              emit({
                type: "cmp_event", cmpId, side,
                event: { type: e.type, delta: e.delta, usage: evt.usage },
              });
            }
          } else if (evt.type === "tool_execution_start") {
            emit({ type: "cmp_event", cmpId, side, event: { type: "tool_used" } });
          } else if (evt.type === "agent_settled") {
            emit({ type: "cmp_event", cmpId, side, event: { type: "settled", usage: evt.usage } });
          }
        });
        try {
          await s.prompt(question);
        } catch (err) {
          emit({ type: "cmp_event", cmpId, side, event: { type: "cmp_error", message: String(err?.message ?? err) } });
        }
        return null;
      }),
    );
    const ms = Date.now() - t0;
    for (const s of run.sessions) {
      try { s.dispose(); } catch { /* 忽略 */ }
    }
    cmpRuns.delete(cmpId);
    emit({ type: "cmp_done", cmpId, ms });
  })();
  return { cmpId };
});

ipcMain.handle("cmp:abort", () => {
  for (const run of cmpRuns.values()) {
    run.aborted = true;
    for (const s of run.sessions) {
      try { s.abort().catch(() => {}); } catch { /* 忽略 */ }
      try { s.dispose(); } catch { /* 忽略 */ }
    }
  }
  cmpRuns.clear();
  return true;
});

/* ---------- 工作区管理（常驻侧栏，多会话，归档） ---------- */

// 工作区识别色板（2026-10-06 设计轮拍板）：低饱和矿物色 6 色轮转，存 ws-config 永不漂移；
// 渲染端 CSS 同名类引用，换色只改这里与 :root 变量
const WS_PALETTE = ["cinnabar", "indigo", "pine", "ochre", "plum", "umber"];

function configFile() {
  return path.join(app.getPath("userData"), "pi-gui-config.json");
}
let wsConfig = null;

function loadWsConfig() {
  try {
    wsConfig = JSON.parse(fs.readFileSync(configFile(), "utf8"));
  } catch {
    wsConfig = null;
  }
  if (!wsConfig || !Array.isArray(wsConfig.workspaces)) {
    wsConfig = { workspaces: [], activeId: null, archivedSessions: [] };
  }
  if (!Array.isArray(wsConfig.archivedSessions)) wsConfig.archivedSessions = [];
  if (!Array.isArray(wsConfig.favorites)) wsConfig.favorites = [];
  // 三档权限默认档（2026-10-08 批次1）：非法值回 default
  if (!PERM_MODES.has(wsConfig.defaultPermMode)) wsConfig.defaultPermMode = "default";
  // 迁移（2026-10-06 owner 拍板）：主目录不属于任何工作区（自由会话区专用），
  // 既有 init quirk 会把它误登记成工作区——加载时剔除，activeId 指向它则回退首个
  const homeDir0 = os.homedir();
  if (wsConfig.workspaces.some((w) => w && w.cwd === homeDir0)) {
    wsConfig.workspaces = wsConfig.workspaces.filter((w) => w.cwd !== homeDir0);
    if (wsConfig.activeId && !wsConfig.workspaces.some((w) => w.id === wsConfig.activeId)) {
      wsConfig.activeId = wsConfig.workspaces[0]?.id ?? null;
    }
  }
  // 迁移：老配置无 color 字段——按登记顺序补齐（已有着不动，不因删除重排）
  let idx = wsConfig.workspaces.filter((w) => w && WS_PALETTE.includes(w.color)).length;
  for (const w of wsConfig.workspaces) {
    if (w && !WS_PALETTE.includes(w.color)) w.color = WS_PALETTE[idx++ % WS_PALETTE.length];
  }
  return wsConfig;
}

function saveWsConfig() {
  try {
    fs.mkdirSync(path.dirname(configFile()), { recursive: true });
    fs.writeFileSync(configFile(), JSON.stringify(wsConfig, null, 2));
  } catch (err) {
    console.error("[config] 保存失败:", err?.message ?? err);
  }
}

ipcMain.handle("ws:list", () => ({ ...loadWsConfig(), homeDir: os.homedir() }));

ipcMain.handle("ws:add", (_e, cwd) => {
  const dir = validCwd(cwd);
  if (!dir) throw new Error("目录无效或不存在");
  loadWsConfig();
  let ws = wsConfig.workspaces.find((w) => w.cwd === dir);
  if (!ws) {
    const used = wsConfig.workspaces.filter((w) => WS_PALETTE.includes(w.color)).length;
    ws = {
      id: "ws" + Date.now(),
      cwd: dir,
      name: path.basename(dir),
      addedAt: new Date().toISOString(),
      color: WS_PALETTE[used % WS_PALETTE.length], // 新登记工作区轮转取色
    };
    wsConfig.workspaces.push(ws);
  }
  wsConfig.activeId = ws.id;
  saveWsConfig();
  return wsConfig;
});

ipcMain.handle("ws:remove", (_e, id) => {
  loadWsConfig();
  wsConfig.workspaces = wsConfig.workspaces.filter((w) => w.id !== id);
  if (wsConfig.activeId === id) wsConfig.activeId = wsConfig.workspaces[0]?.id ?? null;
  saveWsConfig();
  return wsConfig;
});

ipcMain.handle("ws:setActive", (_e, id) => {
  loadWsConfig();
  if (wsConfig.workspaces.some((w) => w.id === id)) {
    wsConfig.activeId = id;
    saveWsConfig();
  }
  return wsConfig;
});

// 手动换色（右键调色板；2026-10-06 设计轮 C 方案：自动轮转 + 手动覆盖出口）
ipcMain.handle("ws:setColor", (_e, id, color) => {
  if (!WS_PALETTE.includes(color)) throw new Error("未知颜色: " + color);
  loadWsConfig();
  const ws = wsConfig.workspaces.find((w) => w.id === id);
  if (!ws) throw new Error("工作区不存在");
  ws.color = color;
  saveWsConfig();
  return wsConfig;
});

// 压缩档工作区级覆盖（2026-10-09 设计共识批次B3）：KEEP_PRESETS 与设置中心三档同源；
// 菜单「标准」=清除覆盖（回落 settings.json 全局档）；仅新会话生效（历史会话 attach 沿用打开时档位）
const WS_KEEP_PRESETS = new Set([32000, 20000, 12000]);
ipcMain.handle("ws:setKeep", (_e, cwd, keep) => {
  const dir = validCwd(cwd);
  if (!dir) throw new Error("目录无效或不存在");
  loadWsConfig();
  const ws = wsConfig.workspaces.find((w) => w.cwd === dir);
  if (!ws) throw new Error("工作区未登记: " + dir);
  if (keep == null) {
    delete ws.compactionKeep;
  } else {
    const n = Number(keep);
    if (!WS_KEEP_PRESETS.has(n)) throw new Error("非法压缩档: " + keep);
    ws.compactionKeep = n;
  }
  saveWsConfig();
  console.log("[ipc] ws:setKeep", dir, keep ?? "(清除覆盖)");
  return wsConfig;
});

// 收藏目录根（2026-10-06 设计轮）：任意文件夹挂进右栏树纯浏览定位，不建会话不进左栏
ipcMain.handle("ws:favAdd", (_e, cwd) => {
  const dir = validCwd(cwd);
  if (!dir) throw new Error("目录无效或不存在");
  loadWsConfig();
  if (wsConfig.workspaces.some((w) => w.cwd === dir)) throw new Error("该目录已是工作区");
  if (wsConfig.favorites.some((f) => f.cwd === dir)) throw new Error("该目录已在树中");
  wsConfig.favorites.push({
    id: "fav" + Date.now(),
    cwd: dir,
    name: path.basename(dir) || dir,
    addedAt: new Date().toISOString(),
  });
  saveWsConfig();
  return wsConfig;
});

// 摘引用不删文件——只从树配置里移除收藏条目
ipcMain.handle("ws:favRemove", (_e, id) => {
  loadWsConfig();
  wsConfig.favorites = wsConfig.favorites.filter((f) => f.id !== id);
  saveWsConfig();
  return wsConfig;
});

// 任务完成强提示：任务栏角标（Windows overlay icon，渲染端画好 PNG dataURL 传主进程；null=清除）
ipcMain.handle("win:overlay", (_e, dataUrl) => {
  if (!win || win.isDestroyed()) return false;
  try {
    if (!dataUrl) {
      win.setOverlayIcon(null, "");
    } else {
      win.setOverlayIcon(nativeImage.createFromDataURL(String(dataUrl)), "有会话任务完成未查看");
    }
    return true;
  } catch (err) {
    console.error("[win:overlay]", err);
    return false;
  }
});

ipcMain.handle("ws:sessions", async (_e, cwd) => {
  const dir = validCwd(cwd);
  loadWsConfig();
  if (!dir) return { sessions: [], archived: [] };
  try {
    const list = await pi.SessionManager.list(dir);
    // 多会话：current=当前视图会话；running=内存中任一 entry 正在跑任务（后台运行也标出）；inMemory=该会话在内存养着实例（可 UI 关闭）
    const curEn = cur();
    const runningPaths = new Set(
      [...sessionMap.values()].filter((e) => e.agentRunning).map((e) => e.session.sessionFile ?? e.sessionPath).filter(Boolean)
    );
    const memPaths = new Set(
      [...sessionMap.values()].map((e) => e.session.sessionFile ?? e.sessionPath).filter(Boolean)
    );
    const map = (s) => ({
      path: s.path,
      name: s.name || s.firstMessage?.slice(0, 60) || "（空会话）",
      modified: s.modified instanceof Date ? fmtLocal(s.modified) : "",
      messageCount: s.messageCount ?? 0,
      current: !!(curEn && curEn.cwd === dir && (curEn.session.sessionFile ?? curEn.sessionPath) === s.path),
      running: runningPaths.has(s.path),
      inMemory: memPaths.has(s.path),
    });
    return {
      sessions: list.filter((s) => !wsConfig.archivedSessions.includes(s.path))
        .map(map).sort((a, b) => (b.modified > a.modified ? 1 : -1)).slice(0, 30),
      archived: list.filter((s) => wsConfig.archivedSessions.includes(s.path)).map(map),
    };
  } catch (err) {
    return { sessions: [], archived: [], error: String(err?.message ?? err) };
  }
});

ipcMain.handle("ws:archive", (_e, sessionPath, archived) => {
  loadWsConfig();
  const p = String(sessionPath ?? "");
  if (!p) return false;
  if (archived) {
    if (!wsConfig.archivedSessions.includes(p)) wsConfig.archivedSessions.push(p);
  } else {
    wsConfig.archivedSessions = wsConfig.archivedSessions.filter((x) => x !== p);
  }
  saveWsConfig();
  return true;
});

/* ---------- 侧栏底部：git 仓库状态 + 智谱套餐真实用量（2026-10-03） ---------- */

ipcMain.handle("git:status", async (_e, cwd) => {
  const dir = validCwd(cwd);
  if (!dir) return null;
  return await new Promise((resolve) => {
    execFile(
      "git",
      ["-C", dir, "status", "--porcelain=v1", "--branch", "--ahead-behind"],
      { timeout: 6000, windowsHide: true, maxBuffer: 1024 * 512 },
      (err, stdout) => {
        if (err || !stdout) return resolve(null); // 非仓库 / git 不可用
        const lines = stdout.split("\n").filter((l) => l.trim());
        const head = lines[0] ?? "";
        if (!head.startsWith("##")) return resolve(null);
        const m = head.match(/^## ([^\s.]+)/);
        const ab = head.match(/\[ahead (\d+), behind (\d+)\]|\[ahead (\d+)\]|\[behind (\d+)\]/);
        resolve({
          branch: m?.[1] ?? "",
          dirty: Math.max(0, lines.length - 1),
          ahead: Number(ab?.[1] ?? ab?.[3] ?? 0),
          behind: Number(ab?.[2] ?? ab?.[4] ?? 0),
        });
      },
    );
  });
});

let zaiCache = { at: 0, data: null };
ipcMain.handle("zai:usage", async () => {
  const key = process.env.ZAI_CODING_CN_API_KEY || process.env.ZAI_API_KEY;
  if (!key) return null;
  if (Date.now() - zaiCache.at < 60_000 && zaiCache.data) return zaiCache.data;
  try {
    // 非官方公开文档接口，社区监控工具验证可用：Bearer key，返回套餐 limits（TOKENS/TIME/CREDIT）
    const res = await fetch("https://open.bigmodel.cn/api/monitor/usage/quota/limit", {
      headers: { Authorization: "Bearer " + key },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.json();
    const limits = Array.isArray(body) ? body : (body.data?.limits ?? []);
    const data = {
      level: body.data?.level ?? "",
      items: limits.map((l) => ({
        type: l.type,
        unit: l.unit,
        number: l.number,
        pct: Math.round(l.percentage ?? 0),
        remaining: l.remaining ?? null,
        usage: l.usage ?? null,
        nextReset: l.nextResetTime ?? null,
      })),
    };
    zaiCache = { at: Date.now(), data };
    return data;
  } catch {
    return null;
  }
});

ipcMain.handle("session:steer", async (_e, text, images) => {
  const en = cur();
  if (!en) throw new Error("会话未创建");
  const imgs = sanitizeImages(images);
  const hasText = typeof text === "string" && text.trim();
  if (!hasText && !imgs.length) return "ignored";
  // 空闲时 steer 没有回合会消费它（死信）→ 直接作为新回合发送（2026-10-03 实测坑）
  if (!en.agentRunning) {
    try {
      await en.session.prompt(hasText ? text : "（见图片）", imgs.length ? { images: imgs } : undefined);
      return "prompted";
    } catch (err) {
      emit({ type: "host_error", sessionId: en.id, message: String(err?.message ?? err) });
      return "error";
    }
  }
  try {
    return await en.session.steer(hasText ? text : "（见图片）", imgs.length ? imgs : undefined);
  } catch (err) {
    emit({ type: "host_error", sessionId: en.id, message: String(err?.message ?? err) });
    return "error";
  }
});

ipcMain.handle("session:setThinkingLevel", (_e, level) => {
  const s = curSession();
  if (!s) throw new Error("会话未创建");
  const allowed = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  if (!allowed.includes(level)) throw new Error("未知思考强度: " + level);
  s.setThinkingLevel(level);
  return getState();
});

ipcMain.handle("fs:readDir", (_e, dir, showHidden) => {
  const root = validCwd(dir);
  if (!root) return { error: "目录不可读" };
  if (!isAllowedFsPath(root)) return { error: "目录不在允许范围（已登记工作区/收藏/主目录）——安全①白名单 2026-10-07" };
  try {
    let dirents = fs.readdirSync(root, { withFileTypes: true });
    // showHidden（2026-10-06 设计轮）：右栏树「显示隐藏」开关——关=滤点开头/node_modules/__pycache__
    if (!showHidden) {
      dirents = dirents.filter((d) => !d.name.startsWith(".") && d.name !== "node_modules" && d.name !== "__pycache__");
    }
    const entries = dirents
      .slice(0, 500)
      .map((d) => {
        let isDir = d.isDirectory();
        if (d.isSymbolicLink()) {
          try { isDir = fs.statSync(path.join(root, d.name)).isDirectory(); } catch { isDir = false; }
        }
        return { name: d.name, dir: isDir };
      })
      .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, "zh"));
    return { entries };
  } catch (err) {
    return { error: String(err?.message ?? err) };
  }
});

ipcMain.handle("fs:openPath", async (_e, p) => {
  if (typeof p !== "string" || !p.trim()) return false;
  // 安全①白名单（2026-10-12 审计甲批补口）：fs 家族此前唯一没设卡的通道，且 shell.openPath
  // 对可执行文件是执行语义——与 readDir 同款守卫（渲染端调用全部传白名单内路径，零 UX 损失）
  if (!isAllowedFsPath(p)) {
    emit({ type: "host_error", message: "打开被拒：路径不在允许范围（已登记工作区/收藏/主目录）" });
    return false;
  }
  try {
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
      await shell.openPath(p);
    } else {
      shell.showItemInFolder(p); // 打开资源管理器并高亮文件
    }
    return true;
  } catch (err) {
    emit({ type: "host_error", message: "打开失败: " + String(err?.message ?? err) });
    return false;
  }
});

ipcMain.handle("open:external", async (_e, url) => {
  if (typeof url === "string" && /^https?:\/\//i.test(url)) {
    await shell.openExternal(url);
    return true;
  }
  return false;
});

/* ---------- 文件查看器与树检索（2026-10-06 设计轮） ---------- */

// 路径类型（file | dir | null）：路径点击改道入壳的前提——文件开查看器、目录定位到树
ipcMain.handle("fs:pathKind", (_e, p) => {
  if (!isAllowedFsPath(p)) return null; // 安全①：越界路径按不存在处理
  try {
    const st = fs.statSync(String(p ?? ""));
    return st.isDirectory() ? "dir" : "file";
  } catch {
    return null;
  }
});

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico"]);
const TEXT_HEAD_LIMIT = 512 * 1024; // 大文本截读：头 512KB
const TEXT_TAIL_LIMIT = 256 * 1024; // 尾 256KB
const TEXT_FULL_LIMIT = 2 * 1024 * 1024; // 超过则截读
const IMAGE_SIZE_LIMIT = 25 * 1024 * 1024;

// 读文件给查看器：image=dataUrl；text=全文或头尾截读；binary/toobig 由渲染端降级提示
ipcMain.handle("fs:readFile", (_e, p) => {
  const file = String(p ?? "");
  if (!isAllowedFsPath(file)) return { kind: "error", error: "路径不在允许范围（已登记工作区/收藏/主目录）——安全①白名单 2026-10-07" }; // 复用查看器 error 通道，渲染端零改动
  try {
    const st = fs.statSync(file);
    if (st.isDirectory()) return { kind: "dir" };
    const ext = path.extname(file).toLowerCase();
    if (IMAGE_EXTS.has(ext)) {
      if (st.size > IMAGE_SIZE_LIMIT) return { kind: "toobig", size: st.size };
      const buf = fs.readFileSync(file);
      const mime = ext === ".jpg" ? "image/jpeg" : "image/" + ext.slice(1);
      return { kind: "image", dataUrl: `data:${mime};base64,${buf.toString("base64")}`, size: st.size };
    }
    // 二进制嗅探：前 8KB 含 NUL 即按二进制处理（utf8 文本不会含 0 字节）
    const fd = fs.openSync(file, "r");
    try {
      const probe = Buffer.alloc(8192);
      const n = fs.readSync(fd, probe, 0, probe.length, 0);
      if (probe.subarray(0, n).includes(0)) return { kind: "binary", size: st.size };
      if (st.size <= TEXT_FULL_LIMIT) {
        const buf = Buffer.alloc(st.size);
        fs.readSync(fd, buf, 0, st.size, 0);
        return { kind: "text", text: buf.toString("utf8"), size: st.size };
      }
      // 截读：头 + 「…（截断）」+ 尾，都在同一 fd 上按偏移读
      const head = Buffer.alloc(TEXT_HEAD_LIMIT);
      const tail = Buffer.alloc(TEXT_TAIL_LIMIT);
      fs.readSync(fd, head, 0, TEXT_HEAD_LIMIT, 0);
      fs.readSync(fd, tail, 0, TEXT_TAIL_LIMIT, st.size - TEXT_TAIL_LIMIT);
      return {
        kind: "text",
        truncated: true,
        text: head.toString("utf8") + "\n\n…（文件较大，中间已截断）\n\n" + tail.toString("utf8"),
        size: st.size,
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    return { kind: "error", error: String(err?.message ?? err) };
  }
});

// 树过滤检索：BFS 全子树按文件名包含匹配（浅层优先），限时限量防大目录卡死
ipcMain.handle("fs:searchFiles", (_e, dir, query, showHidden) => {
  const root = validCwd(dir);
  if (!isAllowedFsPath(root)) return { results: [], error: "目录不在允许范围（安全①白名单）" };
  const q = String(query ?? "").trim().toLowerCase();
  if (!root || !q) return { results: [] };
  const skip = showHidden
    ? null
    : new Set(["node_modules", "__pycache__", "$RECYCLE.BIN", "System Volume Information", ".git"]);
  const results = [];
  const deadline = Date.now() + 3000;
  let visited = 0;
  let truncated = false;
  const queue = [root];
  while (queue.length) {
    if (results.length >= 200 || Date.now() > deadline || visited >= 3000) {
      truncated = true;
      break;
    }
    const d = queue.shift();
    visited++;
    let dirents;
    try {
      dirents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const de of dirents) {
      if (!showHidden && (de.name.startsWith(".") || skip.has(de.name))) continue;
      const full = path.join(d, de.name);
      if (de.name.toLowerCase().includes(q)) results.push({ name: de.name, dir: de.isDirectory(), path: full });
      if (de.isDirectory()) queue.push(full);
      if (results.length >= 200) break;
    }
  }
  results.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, "zh"));
  return { results, truncated };
});

ipcMain.handle("dialog:pickFolder", async () => {
  const r = await dialog.showOpenDialog(win, {
    title: "选择工作目录",
    properties: ["openDirectory"],
    defaultPath: cur() ? undefined : os.homedir(), // 旧全局 session 残留致 ReferenceError、invoke 静默 reject（2026-10-05 owner 报「点击没反应」），改当前会话 entry 判空
  });
  return r.canceled ? null : r.filePaths[0];
});

/* ---------- 自由浏览器查看器（2026-10-08 计划书阶段二：WebContentsView 多 tab） ----------
 * 定位（owner 拍板）：自由强大的浏览器操作入口，不做域白名单、不做应用层出站限制；
 * 若本机网络层有出站代理，拦截发生在网络层，GUI 不重复设卡，页面失败如实显现。
 * 只保两条与白名单无关的容器底线：浏览页永远够不到主进程/文件系统（sandbox+contextIsolation+无 node）、
 * 权限请求（位置/通知/摄像头等）默认拒。下载落系统下载目录不自动执行。
 * persist:webpane 分区：登录态跨重启留存。渲染端经 web:setBounds 上报占位区（窗口内容坐标系 DIP），
 * 激活 tab 挂载、其余摘除保活（导航/滚动/登录态不丢）。 */
const webViews = new Map(); // tabId -> { id, view, url, title, loading, attached }
let webSeq = 0;
let webLastRect = null; // 渲染端最近一次上报的占位区 bounds
let webAgentHolder = null; // agent 操作互斥：持有者 entryId（多会话并发操作同一浏览器时排队报错）
let webAgentTabId = null; // agent 最近操作的 tab（snapshot/click 等默认目标）
let webSessionHooked = false; // will-download 分区级一次性注册标记（2026-10-12 甲批）

function webNavCan(t, dir) {
  const wc = t.view.webContents;
  try { return dir === "back" ? wc.navigationHistory.canGoBack() : wc.navigationHistory.canGoForward(); }
  catch {
    try { return dir === "back" ? wc.canGoBack() : wc.canGoForward(); }
    catch { return false; }
  }
}
function webNavGo(t, dir) {
  try { if (dir === "back") t.view.webContents.goBack(); else t.view.webContents.goForward(); } catch { /* 忽略 */ }
}

function webEmitState(tabId) {
  const t = webViews.get(tabId);
  if (!t) return;
  emit({ type: "web_event", tabId, url: t.url, title: t.title, loading: t.loading, canBack: webNavCan(t, "back"), canFwd: webNavCan(t, "fwd") });
}

function webCreateView(tabId) {
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: "persist:webpane",
    },
  });
  const wc = view.webContents;
  const t = { id: tabId, view, url: "about:blank", title: "新标签页", loading: false, attached: false };
  webViews.set(tabId, t);
  wc.on("did-navigate", (_e, url) => { t.url = url; webEmitState(tabId); });
  wc.on("did-navigate-in-page", (_e, url) => { t.url = url; webEmitState(tabId); });
  wc.on("page-title-updated", (_e, title) => { t.title = title || t.title; webEmitState(tabId); });
  wc.on("did-start-loading", () => { t.loading = true; webEmitState(tabId); });
  wc.on("did-stop-loading", () => { t.loading = false; webEmitState(tabId); });
  // 加载失败呈现（2026-10-12 owner 报「不显示」：https://edge 类无效地址此前整页纯白零反馈）——
  // 主框架失败注入自绘错误页（宣纸风、含错误码与重试链接）；ERR_ABORTED(-3)=导航中断不视为错误，
  // 子资源失败不动主页面
  wc.on("did-fail-load", (_e, code, desc, validatedURL, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    t.loading = false;
    t.title = "加载失败";
    webEmitState(tabId);
    try {
      const descJson = JSON.stringify(String(desc ?? "加载失败"));
      const urlJson = JSON.stringify(String(validatedURL ?? t.url ?? ""));
      wc.executeJavaScript(`(() => {
        document.open();
        document.write("<!DOCTYPE html><html><meta charset='utf-8'><title>加载失败</title><body style='margin:0;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;background:#faf8f4;color:#6e675a'><div style='text-align:center'><div style='font-size:15px;color:#27231c;margin-bottom:10px'>页面加载失败</div><div id='r' style='font-size:12px;opacity:.85'></div><div style='font-size:12px;margin-top:16px'><a id='retry' href='#' style='color:#b4483c'>重试</a></div></div><script>document.getElementById('r').textContent=JSON.parse(${JSON.stringify(descJson)});document.getElementById('retry').href=JSON.parse(${JSON.stringify(urlJson)});<\/script></body></html>");
        document.close();
      })(); true`);
    } catch { /* 注入失败保持空白但 tab 已标「加载失败」 */ }
  });
  wc.setWindowOpenHandler(({ url }) => {
    // 新窗/弹窗：http(s) 开新 web tab（GUI 内聚），其余拒绝
    if (/^https?:\/\//i.test(url)) void webOpen(url);
    return { action: "deny" };
  });
  try { wc.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false)); } catch { /* 老版本无此 API 则忽略 */ }
  // will-download 挂在分区 session（单例）上一次性注册（2026-10-12 审计甲批：此前每 tab 挂一个
  // 到同一 session 对象且 webClose 不清——开 5 个 tab 一次下载触发 5 条通知）
  if (!webSessionHooked) {
    webSessionHooked = true;
    try {
      session.fromPartition("persist:webpane").on("will-download", (_e, item) => {
        try {
          // 文件名消毒（审计 P2 6b 顺手）：basename 剥路径分量，防恶意 Content-Disposition 拼 ..\
          const safeName = path.basename(item.getFilename() || ("download-" + Date.now()));
          item.setSavePath(path.join(app.getPath("downloads"), safeName));
          globalThis.__piGuiNotify?.("浏览器下载", safeName + " 已开始下载（系统下载目录）");
        } catch { /* 忽略 */ }
      });
    } catch { /* 忽略 */ }
  }
  wc.on("context-menu", (_e, params) => {
    if (!win || win.isDestroyed()) return;
    Menu.buildFromTemplate([
      { label: "后退", enabled: webNavCan(t, "back"), click: () => webNavGo(t, "back") },
      { label: "前进", enabled: webNavCan(t, "fwd"), click: () => webNavGo(t, "fwd") },
      { label: "刷新", click: () => { try { wc.reload(); } catch { /* 忽略 */ } } },
      { type: "separator" },
      { label: "复制", role: "copy", enabled: params.editFlags.canCopy },
      { label: "粘贴", role: "paste", enabled: params.editFlags.canPaste },
      { label: "全选", role: "selectAll" },
      { type: "separator" },
      { label: "在系统浏览器打开", enabled: /^https?:/i.test(t.url), click: () => { if (/^https?:/i.test(t.url)) void shell.openExternal(t.url); } },
      { label: "检查元素", click: () => { try { wc.openDevtools({ mode: "detach" }); } catch { /* 忽略 */ } } },
    ]).popup({ window: win });
  });
  return t;
}

function webApplyBounds() {
  if (!win || win.isDestroyed() || !webLastRect) return;
  for (const t of webViews.values()) {
    if (!t.attached) continue;
    try {
      t.view.setBounds({
        x: Math.round(webLastRect.x),
        y: Math.round(webLastRect.y),
        width: Math.max(1, Math.round(webLastRect.w)),
        height: Math.max(1, Math.round(webLastRect.h)),
      });
    } catch { /* 忽略 */ }
  }
}

async function webOpen(url) {
  const tabId = "w" + (++webSeq);
  const t = webCreateView(tabId);
  t.url = String(url || "about:blank");
  if (win && !win.isDestroyed()) {
    try { win.contentView.addChildView(t.view); t.attached = true; } catch { /* 窗口竞态，等渲染端 setBounds 再挂 */ }
    webApplyBounds();
  }
  if (t.url && t.url !== "about:blank") {
    try { await t.view.webContents.loadURL(t.url); } catch { /* ERR_ABORTED 等导航中断不视为错误 */ }
  }
  webEmitState(tabId);
  return t; // 内部记录（含 view）；IPC 层映射成精简对象再出进程
}

function webClose(tabId) {
  const t = webViews.get(tabId);
  if (!t) return false;
  webViews.delete(tabId);
  if (webAgentTabId === tabId) webAgentTabId = null;
  if (win && !win.isDestroyed() && t.attached) {
    try { win.contentView.removeChildView(t.view); } catch { /* 忽略 */ }
  }
  try { t.view.webContents.close(); } catch { /* 忽略 */ }
  return true;
}

/* reload/崩溃自愈孤儿视图兜底（2026-10-12 审计甲批）：web 视图注册表在主进程、tab 态在渲染端，
   渲染端 reload 即清零——已挂载的 WebContentsView 仍按旧 bounds 盖在新界面上方（挡点击、页面
   继续活、UI 永远触达不了）。渲染端 init 时调本通道全关；persist:webpane 登录态在分区里不丢 */
ipcMain.handle("web:detachAll", () => {
  let n = 0;
  for (const tabId of [...webViews.keys()]) if (webClose(tabId)) n++;
  return { closed: n };
});

function webWaitSettled(t, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const wc = t.view.webContents;
    if (!wc.isLoading()) { setTimeout(() => resolve(true), 300); return; }
    const done = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { try { wc.removeListener("did-stop-loading", done); } catch { /* 忽略 */ } resolve(false); }, timeoutMs);
    wc.once("did-stop-loading", done);
  });
}

async function webExtractText(t, limit = 8000) {
  try {
    const txt = await t.view.webContents.executeJavaScript("(document.body && document.body.innerText) || ''");
    return String(txt ?? "").replace(/\n{3,}/g, "\n\n").slice(0, limit);
  } catch (err) {
    return "（页面文本提取失败：" + String(err?.message ?? err) + "）";
  }
}

/* agent 操作互斥：同一时刻一个会话持有浏览器操作权，被占时文本化报错（模型可自处） */
function webAgentLock(entryId) {
  if (webAgentHolder && webAgentHolder !== entryId) return false;
  webAgentHolder = entryId;
  return true;
}
function webAgentUnlock(entryId) {
  if (webAgentHolder === entryId) webAgentHolder = null;
}
/* 工具 execute 注册表（web:testTool 验证钩子直调同一函数体，零 token 全链路） */
const WEB_TOOL_EXECS = new Map();

/* ---------- 自由浏览器 IPC ---------- */

/* ---------- 辅助对话 pane「随手问」（2026-10-08 计划书阶段三） ----------
 * 每工作区一个 in-memory 临时会话（懒创建不 dispose），模型跟随 settings 默认模型+low 档（2026-10-12 开源改造：
 * 原钉 zai glm-5.3-flash 对无智谱凭据的用户必坏；随手问直连物理模型零分类的拍板不变）。
 * 「附上下文」开：取当前主会话最近 8 条 user/assistant 文本，总量 4K 字符封顶、超长取尾部（pi 补丁）。
 * 事件 aux_event 必带 cwd 归属，渲染端按当前工作区过滤（pi 补丁：pi:event 共享通道防串台）。
 * 完成判定用 await s.prompt() 返回（agent_settled 可能不来，AGENTS 有案）。 */
const auxSessions = new Map(); // cwd -> { session, busy }
const AUX_CONTEXT_CHARS = 4000;

function auxTextOf(m) {
  const c = m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter((b) => b && b.type === "text").map((b) => b.text).join(" ");
  return "";
}

function auxContextBlock() {
  const en = cur();
  if (!en) return "";
  const parts = [];
  for (const m of en.session.messages ?? []) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const text = auxTextOf(m).replace(/\s+/g, " ").trim();
    if (!text || text.startsWith("/")) continue;
    parts.push((m.role === "user" ? "用户: " : "助手: ") + text.slice(0, 500));
  }
  if (!parts.length) return "";
  const block = parts.slice(-8).join("\n"); // 最近 8 条
  return block.length > AUX_CONTEXT_CHARS ? block.slice(-AUX_CONTEXT_CHARS) : block; // 4K 封顶取尾部
}

const auxPending = new Map(); // cwd → in-flight ensure promise（2026-10-12 审计乙批：createEphemeralSession await 期间第二发各建一个临时会话，先完成者整会话泄漏）
async function auxEnsureSession(cwd) {
  let rec = auxSessions.get(cwd);
  if (rec) return rec;
  const pend = auxPending.get(cwd);
  if (pend) return pend;
  const p = auxEnsureSessionInner(cwd);
  auxPending.set(cwd, p);
  try { return await p; } finally { auxPending.delete(cwd); }
}

async function auxEnsureSessionInner(cwd) {
  let rec = auxSessions.get(cwd);
  if (rec) return rec;
  let session;
  if (process.env.PI_GUI_TEST_AUX === "1") {
    // 测试注水（verify-aux 零 token 全链路）：文本含 __slow__ 时延迟 4s（测 abort），其余立即回
    session = {
      messages: [],
      async prompt(p) {
        this.messages.push({ role: "user", content: p });
        if (p.includes("__slow__")) {
          await new Promise((r) => setTimeout(r, 4000));
          if (this.aborted) { const e = new Error("Aborted"); e.name = "AbortError"; throw e; }
        }
        const out = "测试回复：OK";
        this.messages.push({ role: "assistant", content: out });
        emit({ type: "aux_event", cwd, event: { type: "delta", text: out } });
        return undefined;
      },
      getLastAssistantText() { return this.aborted ? "" : "测试回复：OK"; }, // abort 后无部分文本 → 渲染端显（已停止）
      async abort() { this.aborted = true; },
      subscribe() { return () => {}; },
    };
  } else {
    // 模型跟随 settings 默认模型（2026-10-12 开源改造：原直钉 zai-coding-cn|glm-5.3-flash 对无智谱凭据的用户必坏）
    const sm = pi.SettingsManager.create(dir, pi.getAgentDir());
    const dp = sm.getDefaultProvider(), dm = sm.getDefaultModel();
    if (!dp || !dm) throw new Error("尚未设置默认模型——请先在 设置 → 模型与提供商 里配置并设为默认");
    session = await createEphemeralSession(dp + "|" + dm, true); // noTools 纯文本
    try { session.setThinkingLevel("low"); } catch { /* 档位不可设则保持默认 */ }
  }
  rec = { session, busy: false };
  auxSessions.set(cwd, rec);
  return rec;
}

ipcMain.handle("aux:send", async (_e, cwd, text, withContext) => {
  const dir = validCwd(cwd) ?? currentCwd ?? os.homedir();
  const q = String(text ?? "").trim();
  if (!q) throw new Error("问题不能为空");
  const rec = await auxEnsureSession(dir);
  if (rec.busy) throw new Error("上一问还在跑，稍等或点停止");
  rec.busy = true;
  const prompt = withContext
    ? "【以下是你没有参与的主对话最近内容，仅作背景参考】\n" + (auxContextBlock() || "（主对话暂无可引用内容）") + "\n【背景结束】\n\n我的问题：" + q
    : q;
  void (async () => {
    const un = rec.session.subscribe((evt) => {
      if (evt.type === "message_update") {
        const e = evt.assistantMessageEvent;
        if (e && e.type === "text_delta") emit({ type: "aux_event", cwd: dir, event: { type: "delta", text: e.delta } });
      }
    });
    try {
      await rec.session.prompt(prompt);
      const out = rec.session.getLastAssistantText ? rec.session.getLastAssistantText() : "";
      emit({ type: "aux_event", cwd: dir, event: { type: "done", text: out } });
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      const aborted = /abort/i.test(msg) || rec.session.aborted === true;
      emit({ type: "aux_event", cwd: dir, event: aborted ? { type: "done", text: (rec.session.getLastAssistantText ? rec.session.getLastAssistantText() : ""), stopped: true } : { type: "error", message: msg } });
    } finally {
      try { un(); } catch { /* 忽略 */ }
      rec.busy = false;
    }
  })();
  return { ok: true };
});

ipcMain.handle("aux:abort", async (_e, cwd) => {
  const dir = validCwd(cwd) ?? currentCwd ?? os.homedir();
  const rec = auxSessions.get(dir);
  if (rec) { try { await rec.session.abort(); } catch { /* 忽略 */ } }
  return true;
});

ipcMain.handle("aux:state", (_e, cwd) => {
  const dir = validCwd(cwd) ?? currentCwd ?? os.homedir();
  const rec = auxSessions.get(dir);
  if (!rec) return { messages: [], busy: false };
  const messages = [];
  for (const m of rec.session.messages ?? []) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const text = auxTextOf(m).trim();
    if (text) messages.push({ role: m.role, text: text.slice(0, 8000) });
  }
  return { messages, busy: rec.busy };
});

ipcMain.handle("web:open", async (_e, url) => {
  const t = await webOpen(String(url ?? ""));
  return { tabId: t.id, url: t.url, title: t.title };
});

ipcMain.handle("web:navigate", (_e, tabId, url) => {
  const t = webViews.get(String(tabId ?? ""));
  if (!t) throw new Error("web tab 不存在: " + tabId);
  const u = String(url ?? "");
  if (!/^https?:\/\//i.test(u) && u !== "about:blank") throw new Error("url 必须以 http(s):// 开头");
  t.url = u;
  return t.view.webContents.loadURL(u).then(() => ({ tabId: t.id, url: t.url })).catch((err) => ({ tabId: t.id, url: t.url, aborted: String(err?.message ?? err).includes("ABORTED") }));
});

ipcMain.handle("web:close", (_e, tabId) => webClose(String(tabId ?? "")));

/* 渲染端每次视图变化全量上报期望态：tabId=应挂载的激活 web tab（null=全部摘除） */
ipcMain.handle("web:setBounds", (_e, payload) => {
  if (!win || win.isDestroyed()) return false;
  const r = payload ?? {};
  webLastRect = { x: Number(r.x) || 0, y: Number(r.y) || 0, w: Number(r.w) || 0, h: Number(r.h) || 0 };
  const wantId = r.tabId ? String(r.tabId) : null;
  for (const t of webViews.values()) {
    const shouldAttach = wantId ? t.id === wantId : false;
    if (shouldAttach && !t.attached) {
      try { win.contentView.addChildView(t.view); t.attached = true; } catch { /* 忽略 */ }
    } else if (!shouldAttach && t.attached) {
      try { win.contentView.removeChildView(t.view); t.attached = false; } catch { /* 忽略 */ }
    }
  }
  if (!wantId) webLastRect = null;
  webApplyBounds();
  return true;
});

ipcMain.handle("web:action", (_e, tabId, action) => {
  const t = webViews.get(String(tabId ?? ""));
  if (!t) throw new Error("web tab 不存在: " + tabId);
  const wc = t.view.webContents;
  switch (String(action ?? "")) {
    case "back": webNavGo(t, "back"); break;
    case "fwd": webNavGo(t, "fwd"); break;
    case "reload": try { wc.reload(); } catch { /* 忽略 */ } break;
    case "stop": try { wc.stop(); } catch { /* 忽略 */ } break;
    case "devtools": try { wc.openDevtools({ mode: "detach" }); } catch { /* 忽略 */ } break;
    case "external": if (/^https?:/i.test(t.url)) void shell.openExternal(t.url); break;
    default: throw new Error("未知 web 动作: " + action);
  }
  return true;
});

if (process.env.PI_GUI_TEST_BROWSER === "1") {
  ipcMain.handle("web:testTool", (_e, name, params) => {
    const exec = WEB_TOOL_EXECS.get(String(name ?? ""));
    if (!exec) throw new Error("未知浏览器工具: " + name + "（需先建会话触发工具注册）");
    return exec("test-entry", params ?? {});
  });
}

ipcMain.handle("web:list", () => [...webViews.values()].map((t) => ({ id: t.id, url: t.url, title: t.title, loading: t.loading, attached: t.attached })));

/* ---------- 窗口 ---------- */

/* ---------- 窗口 ---------- */

/* 窗口状态记忆（2026-10-06 设计轮拍板 C）：位置/大小/是否最大化存盘，首次启动最大化。
 * 最大化时用 getNormalBounds 存「还原后的正常尺寸」，恢复时不丢小窗几何。 */
function windowStateFile() {
  return path.join(app.getPath("userData"), "window-state.json");
}
function loadWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(windowStateFile(), "utf8"));
    if (s && Number.isFinite(s.width) && Number.isFinite(s.height)) return s;
  } catch { /* 无状态或坏 JSON → 首次 */ }
  return null;
}
function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  try {
    const b = win.getNormalBounds();
    fs.writeFileSync(windowStateFile(), JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() }));
  } catch (err) {
    console.error("[window-state] 保存失败:", err?.message ?? err);
  }
}
let winStateTimer = null;
function scheduleWinStateSave() {
  clearTimeout(winStateTimer);
  winStateTimer = setTimeout(saveWindowState, 600);
}

/* bundle 新鲜度守卫（2026-10-07 A1）：esbuild 只打包 app.js，bundle 不入 git——
   源码/HTML 改了没重新 build（git checkout、并行会话、直接 electron .）时旧 bundle 顶层选择器撞新 HTML，
   IIFE 求值即抛 → 界面出来但全部哑火（2026-10-05 已实咬两次且无任何可见信号）。
   启动时比对 mtime：源较新或 bundle 缺失 → 渲染端注入警告条 + logFatal 留痕。零构建系统改动。 */
function checkBundleFreshness() {
  const src = path.join(__dirname, "renderer", "app.js");
  const bundle = path.join(__dirname, "renderer", "app.bundle.js");
  try {
    const srcM = fs.statSync(src).mtimeMs;
    const bM = fs.statSync(bundle).mtimeMs; // bundle 缺失时 statSync 抛错走 catch
    if (srcM > bM + 2000) return "源码 app.js 比打包产物 app.bundle.js 新";
    return null;
  } catch (err) {
    if (err?.code === "ENOENT") return fs.existsSync(bundle) ? "源码 app.js 缺失" : "打包产物 app.bundle.js 不存在，请先跑 npm run build";
    return "bundle 新鲜度检查失败：" + String(err?.message ?? err);
  }
}

function createWindow() {
  unackedFatal = readUnackedFatal(); // B3：启动读一次未确认 fatal（ack 后重命名，重启不再提示）
  const saved = loadWindowState();
  const common = {
    minWidth: 1100, // 三面同屏下限：右栏340 + 聊天420 + 查看器320（2026-10-06 设计轮）
    minHeight: 600,
    backgroundColor: "#faf8f4",
    title: "Pi 桌面版",
    autoHideMenuBar: true,
    show: !TEST_HEADLESS, // 测试实例不弹窗不抢前台（2026-10-08）；后台节流同步关，页面 JS 照常跑
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
  if (saved) {
    // 防飞屏：显示器拔掉后旧坐标可能在可视区外——四边都够不到就丢弃坐标
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return saved.x < a.x + a.width - 80 && saved.x + saved.width > a.x + 80 && saved.y < a.y + a.height - 40 && saved.y + saved.height > a.y + 40;
    });
    win = new BrowserWindow({
      ...common,
      width: saved.width,
      height: saved.height,
      ...(visible ? { x: saved.x, y: saved.y } : {}),
    });
    if (saved.maximized && !TEST_HEADLESS) win.maximize();
  } else {
    win = new BrowserWindow({ width: 1280, height: 860, ...common });
    if (!TEST_HEADLESS) win.maximize(); // 首次启动最大化（设计轮拍板：分栏查看器吃屏幕）；测试实例不弹窗
  }
  win.on("resize", scheduleWinStateSave);
  win.on("move", scheduleWinStateSave);
  win.setMenuBarVisibility(false);
  if (TEST_HEADLESS) {
    try { win.webContents.setBackgroundThrottling(false); } catch { /* 老 Electron 不支持则忽略，验证脚本轮询在 node 侧兑底 */ }
  }
  createTray(); // 后台常驻：托盘与窗口生命周期同步建（已存在则跳过）

  // 关闭拦截（2026-10-06 后台常驻）：× 不直接退出，按任务状态驻留/确认；退出链路放行
  win.on("close", (e) => {
    if (isQuitting) return;
    e.preventDefault();
    void handleCloseRequest();
  });

  // ---- 渲染面加固 ----
  // 只允许本地页面内导航，外部 URL 一律拦截
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("file://")) e.preventDefault();
  });
  // 新窗口请求：http(s) 转系统浏览器，其余拒绝
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  // 生产环境屏蔽 devtools 快捷键
  win.webContents.on("before-input-event", (e, input) => {
    const isDevtoolsKey =
      input.type === "keyDown" &&
      (input.key === "F12" || (input.control && input.shift && (input.key === "I" || input.key === "J" || input.key === "C")));
    if (isDevtoolsKey) e.preventDefault();
  });
  // 崩溃自愈：渲染进程崩溃后自动重载（会话状态在主进程，不丢失）。
  // B2（2026-10-07 优化计划）：置标志，reload 后 did-finish-load 注入一次性恢复提示条，
  // 让静默崩溃可见化（owner 可能完全无感，误以为只是卡了一下）
  let rendererCrashedSinceLoad = false;
  win.webContents.on("render-process-gone", (_e, details) => {
    console.error("[render-process-gone]", details.reason);
    rendererCrashedSinceLoad = true;
    if (win && !win.isDestroyed()) win.webContents.reload();
  });
  win.webContents.on("did-finish-load", () => {
    if (!rendererCrashedSinceLoad || win.isDestroyed()) return;
    rendererCrashedSinceLoad = false; // 一次性：注入前先清，防注入失败死循环复现
    win.webContents
      .executeJavaScript(
        `(() => {
          if (document.getElementById("crash-recover-bar")) return;
          const bar = document.createElement("div");
          bar.id = "crash-recover-bar";
          bar.textContent = "界面曾崩溃，已自动恢复（会话数据在主进程，未受影响）。";
          Object.assign(bar.style, {
            position: "fixed", top: "0", left: "0", right: "0", zIndex: "99998",
            background: "#8a6d3b", color: "#FAF8F4", padding: "8px 16px",
            font: "13px/1.5 system-ui", textAlign: "center", boxShadow: "0 2px 8px rgba(0,0,0,.2)",
          });
          const x = document.createElement("span");
          x.textContent = " ×";
          Object.assign(x.style, { position: "absolute", right: "12px", cursor: "pointer", fontWeight: "bold" });
          x.onclick = () => bar.remove();
          bar.appendChild(x);
          document.body.appendChild(bar);
        })()`,
      )
      .catch((err) => console.error("[crash-recover] 注入提示条失败:", err?.message ?? err));
  });

  // B3 启动自检（2026-10-10 撤销顶部提醒条，owner 拍板）：异常入口迁 设置→日志 tab（app:fatalInfo）。
  // 保留落盘/ack 机制本身：新 fatal 照旧记 run.err.log，设置里可查可确认。

  // 自动化端到端测试钩子：PI_GUI_AUTOTEST=1 时启动后自动发一条测试消息
  if (process.env.PI_GUI_AUTOTEST) {
    win.webContents.on("did-finish-load", () => {
      setTimeout(() => {
        win.webContents
          .executeJavaScript(
            `(() => { const i = document.getElementById("input"); i.value = "请只回复一句话：Pi桌面GUI端到端测试成功，不要使用任何工具。"; document.getElementById("btn-send").click(); })()`
          )
          .catch((err) => console.error("[autotest]", err));
      }, 2500);
    });
  }

  // 渲染进程日志/错误转发到主进程 stdout，便于排查
  win.webContents.on("console-message", (...args) => {
    const e = args[0];
    const d = e?.detail ?? {};
    const level = d.level ?? args[1];
    const message = d.message ?? args[2];
    const line = d.lineNumber ?? args[3];
    const sourceId = d.sourceId ?? args[4];
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
  });
  win.webContents.on("preload-error", (_e, p, err) => console.error("[preload-error]", p, err));
  win.webContents.on("did-fail-load", (_e, code, desc) => console.error("[did-fail-load]", code, desc));

  win.on("closed", () => {
    win = null; // 窗口销毁即清引用，防 second-instance 等处访问已销毁对象
    // web tab 的原生视图挂在窗口 contentView 上：窗口没了视图全成孤儿，就地销毁（渲染端 reload 会重建）
    for (const t of webViews.values()) {
      try { t.view.webContents.close(); } catch { /* 忽略 */ }
    }
    webViews.clear();
    webLastRect = null;
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));

  // bundle 新鲜度警告（did-finish-load 每次加载后注入，覆盖 reload/崩溃自愈）：
  // 显眼置顶横幅但不阻塞交互——守卫是提醒不是拦截，owner 可能有意跑旧产物排查
  win.webContents.on("did-finish-load", () => {
    const stale = checkBundleFreshness();
    if (!stale) return;
    logFatal("bundle-stale", stale);
    win.webContents
      .executeJavaScript(
        `(() => {
          if (document.getElementById("bundle-stale-bar")) return;
          const bar = document.createElement("div");
          bar.id = "bundle-stale-bar";
          bar.textContent = "⚠ 界面可能不是最新：${stale.replace(/[\\"'`<>]/g, "")}。请重启（走 npm start / 启动.bat）或跑 npm run build。";
          Object.assign(bar.style, {
            position: "fixed", top: "0", left: "0", right: "0", zIndex: "99999",
            background: "#B4483C", color: "#FAF8F4", padding: "8px 16px",
            font: "13px/1.5 system-ui", textAlign: "center", boxShadow: "0 2px 8px rgba(0,0,0,.25)",
          });
          const x = document.createElement("span");
          x.textContent = " ×";
          Object.assign(x.style, { position: "absolute", right: "12px", cursor: "pointer", fontWeight: "bold" });
          x.onclick = () => bar.remove();
          bar.appendChild(x);
          document.body.appendChild(bar);
        })()`,
      )
      .catch((err) => console.error("[bundle-stale] 注入警告条失败:", err?.message ?? err));
  });
}

// userData 可用 PI_GUI_USER_DATA 独立另指（2026-10-13 拆出独立分支——原绑在 CDP_PORT 分支内，
// 单独设置不生效成坑账；演示快捷方式/并行实例都需要独立的 userData 隔离锁与缓存）
if (process.env.PI_GUI_USER_DATA) {
  const customUserData = path.resolve(process.env.PI_GUI_USER_DATA);
  try { fs.mkdirSync(customUserData, { recursive: true }); } catch { /* 忽略 */ }
  app.setPath("userData", customUserData);
}
// 自动化验证钩子：PI_GUI_CDP_PORT=xxxx 时开 CDP（未显式 USER_DATA 时默认独立 userData 绕开单实例锁）
// 无头静默（2026-10-08 owner 报「测试实例弹窗+完成通知打扰」）：TEST_HEADLESS 已前置声明（顶部）
if (process.env.PI_GUI_CDP_PORT) {
  app.commandLine.appendSwitch("remote-debugging-port", process.env.PI_GUI_CDP_PORT);
  if (!process.env.PI_GUI_USER_DATA) {
    const testUserData = path.join(os.tmpdir(), "pi-gui-autotest");
    try { fs.mkdirSync(testUserData, { recursive: true }); } catch { /* 忽略 */ }
    app.setPath("userData", testUserData);
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    console.log("[lifecycle] second-instance: win=", win ? (win.isDestroyed() ? "destroyed" : win.isVisible() ? "visible" : "hidden") : "null");
    if (win && !win.isDestroyed()) {
      showMainWindow(); // 常驻托盘时 win 只是隐藏未销毁，show 唤回（旧版只 restore+focus，隐藏窗口唤不回）
    } else {
      // 僵尸自愈：窗口已没了却还持单实例锁（quit 被 dispose 卡死没退成），自爆释放锁，
      // 用户再点一次快捷方式即可正常启动（2026-10-04 实测：点击无反应的根因）
      console.log("[lifecycle] second-instance but no live window: zombie, force exiting");
      app.exit(0);
    }
  });

  // Windows toast 通知身份：Electron 不设 AUMID 时，本进程树（含 pi/bash/powershell 子进程）
  // 发出的系统 toast 会被 Win11 静默丢弃——只响声无横幅、中心无记录、不报错。
  // ZCode 逆向分析定位 + 本机最小复现验证（2026-10-06）。
  if (process.platform === "win32") app.setAppUserModelId("io.github.buchiyu55.pi-gui");

  // 任务完成通知桥：pi 扩展（notify.ts）在 SDK 上下文里 require 不到 electron（模块解析
  // 从扩展目录向上走，够不着本包），通过全局钩子借用主进程原生 Notification。
  // ZCode 同款守卫：防 GC 强引用（Notification 被 GC 会让 toast 闪没/不显示）。
  // 守卫链：title/body 非空；返回 true=已交原生发出，false=调用方走自身兑底。
  const notifyRefs = new Set();
  globalThis.__piGuiNotify = (header, body) => {
    try {
      // 测试实例静默（2026-10-08 无头；2026-10-10 owner 拍板扩到 SHOW：验证/后台任务零弹窗零声音）：
      // 返回 true 骗过 notify.ts 的「已交原生发出」判定，跳过其 powershell toast 兑底——两条通道全灭
      if (TEST_SILENT) return true;
      // 通知设置闸（批次②）：关/勿扰同样「吞」——返回 true 防兜底通道复活横幅
      const gate = notifyGateDecision();
      if (!gate.allowed) return true;
      if (typeof header !== "string" || typeof body !== "string") return false;
      if (!header.trim() || !body.trim()) return false;
      const n = new Notification({ title: header, body, silent: !gate.sound });
      notifyRefs.add(n);
      n.once("close", () => notifyRefs.delete(n));
      n.show();
      return true;
    } catch {
      return false;
    }
  };
  // 蜂鸣闸（2026-10-12 审计甲批）：notify.ts 的 SystemSounds 蜂鸣此前绕过全部三道闸
  // （TEST_SILENT/总开关/勿扰+提示音）——桥暴露同一套决策给扩展，playSound 前询问；
  // 桥不存在（裸 TUI）时扩展维持 10-06 拍板的「勿扰不拦 SystemSounds」现状
  globalThis.__piGuiNotifyGate = () => ({ silent: TEST_SILENT, ...notifyGateDecision() });

/* ---------- 内置技能包（2026-10-13 开源：skills-builtin/ 随包分发） ----------
 * 首启把内置技能复制到用户 agentDir/skills/：copy-once 语义——同名已存在（用户自装/已改）一律不覆盖，
 * 用户可自由修改；删除会在下次启动恢复（内置始终可用的取舍，README 披露）。
 * 全部为 MIT 来源的移植技能（SKILL.md 带来源注），已脱敏（无个人语境/本机路径）。 */
function syncBuiltinSkills() {
  try {
    const srcRoot = path.join(__dirname, "skills-builtin");
    if (!fs.existsSync(srcRoot)) return;
    const dstRoot = path.join(pi.getAgentDir(), "skills");
    fs.mkdirSync(dstRoot, { recursive: true });
    let n = 0;
    for (const name of fs.readdirSync(srcRoot)) {
      const dst = path.join(dstRoot, name);
      if (fs.existsSync(dst)) continue; // copy-once：用户目录同名优先
      fs.cpSync(path.join(srcRoot, name), dst, { recursive: true });
      n++;
    }
    if (n) console.log(`[skills] builtin synced: ${n} skill(s) -> ${dstRoot}`);
  } catch (e) {
    console.log("[skills] builtin sync failed (非致命):", String(e?.message ?? e));
  }
}

  app.whenReady().then(() => {
    syncBuiltinSkills();
    createWindow();
    // 更新检测：错峰启动 4s，不抢启动期带宽（2026-10-08）
    setTimeout(() => { checkPiUpdate().catch(() => {}); }, 4000);
  });

  // 系统关机/注销等外部退出也走 before-quit；置标志放行窗口 close，否则会被驻留拦截卡住关机。
  // B1：dispose 预算挂 before-quit（唯一能取消退出的钩子；显式 app.quit 流程里 window-all-closed
  // 的 preventDefault 拦不住后续 will-quit——2026-10-07 verify-b1 实测 499ms 退出无日志）。全部路径
  // （× 确认退出/托盘退出/window-all-closed 默认退出/系统关机）均过此处，单点收敛。
  let quitDisposeDone = false;
  app.on("before-quit", (event) => {
    isQuitting = true;
    saveWindowState(); // 退出前兑底存一次窗口几何（托盘驻留隐藏不改几何，平时 resize/move 已防抖存）
    if (quitDisposeDone) return; // dispose 已落定（或无 entry），放行退出
    event.preventDefault(); // 挡住本次 quit，等 dispose（各 800ms 预算、并行）落定后二次 quit
    const ids = [...sessionMap.keys()];
    console.log(`[lifecycle] before-quit: disposing ${ids.length} entries (budget ${DISPOSE_BUDGET_MS}ms each)`);
    void Promise.allSettled(ids.map((id) => disposeEntry(id))).then(() => {
      console.log(`[lifecycle] ${ids.length} entries disposed, quitting`);
      quitDisposeDone = true;
      app.quit();
    });
    // 兑底：dispose 内部等待永久卡死 → 进程变僵尸持锁，下次点图标毫无反应（2026-10-04 实测）。
    // 2.5s 后无条件强退，app.exit 跳过一切钩子
    setTimeout(() => {
      console.log("[lifecycle] graceful quit timed out, force exit");
      app.exit(0);
    }, 2500);
  });
  app.on("will-quit", () => {
    tray?.destroy();
    tray = null;
    // web tab 原生视图兜底销毁（正常路径走 win closed； quit 中窗口已被走时补位）
    for (const t of webViews.values()) {
      try { t.view.webContents.close(); } catch { /* 忽略 */ }
    }
    webViews.clear();
  });
}
