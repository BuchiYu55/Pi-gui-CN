/**
 * 冒烟套餐 runner（2026-10-07 A2，优化计划方案一）：
 *   外部实例型 10 脚本：每脚本全新临时 PI_GUI_USER_DATA + 独立端口（9230+序号）起 electron →
 *     node tests/<脚本> <端口> → 按端口 OwningProcess 归属杀 PID → 确认端口释放，串行。
 *   自闭环型（verify-bundleguard 等）：直接 node 跑（脚本自带起杀）。
 *   任一失败退出码非零，末尾 PASS/FAIL 汇总表。
 *
 * 实测坑吸收（计划 A2 + AGENTS 账）：
 *   ① 杀进程必须按端口 OwningProcess 验归属（绝不按进程名——owner 主实例绝不能碰）；
 *   ② spawner 的 stdout 管道必须保持开放（关闭会 EPIPE 杀死无头实例）；
 *   ③ 等待/轮询一律放 node 侧（隐藏窗口页面端任务队列全停）。
 * 端口占用预处理：目标端口已被占（非本 runner 起的）→ 该脚本记 FAIL 并提示，绝不误杀不明进程。
 * 用法：npm test（仓库根）或 node tests/smoke.mjs [脚本名过滤]。
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."); // 仓库根
const PORT_BASE = 9230;

/** 外部实例型：脚本名（tests/ 下，不带 .mjs）。 */
const EXTERNAL = [
  "verify-ui",          // 界面基线（page 注入）
  "verify-design",      // 右栏/项目树 52 断言
  "verify-projtree",    // 项目树+右键+子目录登记
  "verify-workspace",   // 工作区增删切换拖拽语义
  "verify-todopanel",   // todo pane 形态
  "verify-rightbar-w",  // 右栏宽度可拖（2026-10-08 阶段一）
  "verify-graph",       // wiki 图谱交互重设计（pan/zoom/拖拽/fit）
  "verify-keep",       // 压缩档工作区级覆盖（2026-10-09 设计共识批次B3）
  "verify-designgate", // design-gate 扩展探针（2026-10-09 批次C，零 token）
  "verify-webtab",      // 浏览器 web tab UI 链路（2026-10-08 阶段二，自带 http fixture）
  "verify-slashfix",    // slash 命令菜单（断言不派发 Enter，零 token）
  "verify-draft",       // 草稿隔离
  "verify-multi-session",// 并行不打断（1 条真实短消息，极低 token）
  "verify-newsession-sidebar",// 新会话发送后侧栏即时出现（1 条真实短消息，极低 token）
  "verify-open-session",// 历史会话打开（纯 IPC/DOM，零 token）
  "verify-r2",          // 设置中心面板（零 token）
  "verify-logtab",      // 设置→日志 tab（原启动顶部异常提醒条迁入，零 token）
  "verify-thinking-line",// 思考流单行横向改版（钩子注入 DOM，零 token）
  "verify-agent-theme",// 代理 tab + 主题切换（零 token，备份还原 settings.json）
  "verify-loose",      // E1.1 间隙文本弱化（钩子注入 DOM，零 token，2026-10-11 计划书）
  "verify-toolcard",   // E1.3 长输出 elide + E1.2 收拢回归锁（钩子注入 DOM，零 token，2026-10-11 计划书）
  "verify-approve",    // E2.1 /approve 计划审批（钩子截流，零 token，2026-10-11 计划书）
  "verify-webopen",    // 侧栏全局浏览器入口（常显+开壳+地址条聚焦，2026-10-12 owner 需求）
  "verify-sidebarecon",// 侧栏事件路径防抖合并（戊批：5 次调用 1 次重建，2026-10-12 审计）
  "verify-onboarding",// 引导向导五步全流程（阶段 1，TEST_ONBOARD 钩子零网络零写盘，2026-10-12 开源路线图）
  "verify-builtin-ext",// 内置扩展收编（阶段 2：接线断言+真会话 plan 档拦截冒烟，1 条真实短消息极低 token，2026-10-12 开源路线图）
];
/** 自闭环型：脚本自带起实例+自杀清场。 */
const SELF = ["verify-bundleguard", "verify-browser-tools", "verify-aux"]; // A1 守卫（9228）+ 浏览器 agent 工具（9261，TEST_BROWSER）+ 随手问（9263，TEST_AUX）
/** 纯文件型：不占端口不起实例，直接 node 跑（秒级）。 */
const PURE = ["lint-docs"]; // 文档/知识库机械对账（2026-10-10 预防批次；ZCode 周一巡检跑同款）

const filter = process.argv[2];
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portPids(port) {
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-Command",
      `@((Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess) | ForEach-Object { if($_){[int]$_} } | Select-Object -Unique`],
      { encoding: "utf8" });
    return [...new Set(out.split(/\r?\n/).map((l) => parseInt(l.trim(), 10)).filter((n) => n > 0))];
  } catch { return []; }
}
function killPids(pids) {
  for (const pid of pids) {
    try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* 已退 */ }
  }
}
async function waitPortFree(port, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!portPids(port).length) return true;
    await sleep(400);
  }
  return !portPids(port).length;
}
async function waitCDP(port, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json`);
      if (r.ok) { const t = await r.json(); if (t.some((x) => x.type === "page")) return true; }
    } catch { /* 未起 */ }
    await sleep(300);
  }
  return false;
}

/** 页面就绪探针（node 侧一次性 evaluate，禁页面端长轮询）：readyState complete + 输入区挂载，
 *  再给 1.2s grace——命令列表/MCP 异步就位比 CDP 晚（slashfix 断言依赖技能菜单数据，2026-10-07 实测踩坑）。 */
async function waitPageReady(port, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    let ws = null;
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) {
        const ok = await new Promise((res) => {
          const timer = setTimeout(() => { try { ws?.close(); } catch { /* 忽略 */ } res(false); }, 3000);
          ws = new WebSocket(page.webSocketDebuggerUrl);
          ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: {
            expression: "document.readyState==='complete' && !!document.getElementById('input')",
            returnByValue: true } }));
          ws.onmessage = (m) => {
            const d = JSON.parse(m.data);
            if (d.id === 1) { clearTimeout(timer); try { ws.close(); } catch { /* 忽略 */ } res(d.result?.result?.value === true); }
          };
          ws.onerror = () => { clearTimeout(timer); res(false); };
        });
        if (ok) { await sleep(1200); return true; } // grace：命令列表/MCP 异步就位
      }
    } catch { /* 页面未就绪，重试 */ }
    await sleep(400);
  }
  return false;
}

/** 跑一个测试脚本（子进程），透传输出，返回 {code, ms}。stdout 管道全程保持开放。 */
function runScript(name, args, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [path.join(ROOT, "tests", name + ".mjs"), ...args], {
      cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"],
    });
    const pump = (d) => process.stdout.write(d);
    child.stdout.on("data", pump); // 持续消费保持管道开
    child.stderr.on("data", pump);
    const timer = setTimeout(() => {
      console.log(`\n[smoke] ${name} 超时（${timeoutMs / 1000}s），杀进程组`);
      try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* 已退 */ } }
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, ms: Date.now() - t0 });
    });
    child.on("error", (e) => { clearTimeout(timer); console.log(`[smoke] ${name} 启动失败: ${e.message}`); resolve({ code: 1, ms: Date.now() - t0 }); });
  });
}

async function runExternal(name, idx) {
  const port = PORT_BASE + idx;
  const label = `${name}(:${port})`;
  if (portPids(port).length) {
    results.push({ label, pass: false, info: `端口 ${port} 已被占用（非本 runner 起的进程，不误杀）` });
    console.log(`❌ ${label} 端口占用，跳过`);
    return;
  }
  const userData = path.join(os.tmpdir(), `pi-gui-smoke-${port}-${Date.now()}`);
  // 测试会话专用 cwd（2026-10-07）：会话落盘在专用编码目录，owner 主实例侧栏永不显示（配套 main.js PI_GUI_TEST_CWD 钩子）
  const testCwd = path.join(os.tmpdir(), "pi-gui-test-cwd");
  try { fs.mkdirSync(testCwd, { recursive: true }); } catch { /* 已存在 */ }
  fs.mkdirSync(userData, { recursive: true });
  // ② stdout 管道保持开放：pipe 且持续消费；实例日志静默吞（脚本自己的输出才是主角）
  const app = spawn(process.execPath, [path.join(ROOT, "node_modules", "electron", "cli.js"), "."], {
    cwd: ROOT,
    // 脚本专属实例环境（2026-10-10 审计）：verify-designgate 的 allowlist 写探针限 TEST_GATE 实例（生产实例只读）
    env: {
      ...process.env,
      PI_GUI_CDP_PORT: String(port),
      PI_GUI_USER_DATA: userData,
      PI_GUI_TEST_CWD: testCwd,
      ...(name === "verify-designgate" ? { PI_GUI_TEST_GATE: "1" } : {}),
      ...(name === "verify-onboarding" ? { PI_GUI_TEST_ONBOARD: "1" } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });
  app.stdout.on("data", () => {});
  app.stderr.on("data", () => {});
  try {
    // ③ CDP+页面就绪轮询在 node 侧；就绪探针含 grace，防命令列表未挂载时放行（slashfix 踩坑）
    if (!(await waitCDP(port))) throw new Error(`CDP ${port} 等待超时`);
    if (!(await waitPageReady(port))) throw new Error(`页面就绪 ${port} 等待超时`);
    const { code, ms } = await runScript(name, [String(port)], 300_000);
    results.push({ label, pass: code === 0, info: `${(ms / 1000).toFixed(1)}s` });
  } catch (e) {
    results.push({ label, pass: false, info: String(e.message ?? e) });
  } finally {
    // ① 按端口归属杀（不按名），随后确认释放
    try { app.kill(); } catch { /* 兜底走端口 */ }
    await sleep(400);
    killPids(portPids(port));
    const freed = await waitPortFree(port);
    if (!freed) results[results.length - 1].info += "；⚠ 端口未释放";
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* Windows 句柄延迟，留下次清 */ }
  }
}

async function runSelfContained(name) {
  const { code, ms } = await runScript(name, [], 300_000);
  results.push({ label: name + "(自闭环)", pass: code === 0, info: `${(ms / 1000).toFixed(1)}s` });
}

console.log(`== pi-gui 冒烟套餐（${EXTERNAL.length + SELF.length + PURE.length} 脚本：实例串行 + 纯文件）==\n`);
const t0 = Date.now();
let i = 0;
for (const name of EXTERNAL) {
  if (filter && !name.includes(filter)) continue;
  console.log(`\n---- [${i + 1}/${EXTERNAL.length}] ${name} ----`);
  await runExternal(name, i);
  i++;
}
for (const name of SELF) {
  if (filter && !name.includes(filter)) continue;
  console.log(`\n---- [自闭环] ${name} ----`);
  await runSelfContained(name);
}
for (const name of PURE) {
  if (filter && !name.includes(filter)) continue;
  console.log(`\n---- [纯文件] ${name} ----`);
  const { code, ms } = await runScript(name, [], 60_000);
  results.push({ label: name + "(纯文件)", pass: code === 0, info: `${(ms / 1000).toFixed(1)}s` });
}

const pass = results.filter((r) => r.pass).length;
console.log(`\n\n== 汇总（${pass}/${results.length}，总耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s）==`);
for (const r of results) console.log(`${r.pass ? "✅" : "❌"} ${r.label}  ${r.info}`);
process.exit(pass === results.length ? 0 : 1);
