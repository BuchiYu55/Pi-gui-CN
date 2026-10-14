/* 日志 tab 端到端验证（2026-10-10）：原启动顶部 fatal 提醒条迁入 设置→日志。
 * 前置：PI_GUI_CDP_PORT=9223 起测试实例（userData 用 PI_GUI_USER_DATA 指到本脚本可写的目录）。
 * 流程：种 run.err.log → 进日志 tab 断言未确认高亮+按钮 → 点「标记已读」→ 断言 .acked 改名+行变已确认 → 清场。
 * 零 token，不真打开日志文件（只断言 DOM 与磁盘改名）。 */
import { writeFileSync, existsSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const PORT = process.argv[2] || "9223";
// userData 路径不依赖本进程 env（smoke 下 verify 子进程拿不到 PI_GUI_USER_DATA）：
// 开场先问主进程 fatalInfo().dir，种文件种在应用真正读的目录
let USER_DATA = process.env.PI_GUI_USER_DATA || join(process.env.TEMP ?? "/tmp", "pi-gui-autotest-logtab");
let RUN_LOG = join(USER_DATA, "run.err.log");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 清场：种文件前先删残留（含 .acked）
for (const f of [RUN_LOG, RUN_LOG + ".acked"]) { try { if (existsSync(f)) unlinkSync(f); } catch {} }

let ended = false;
let ws = null;
try {
  // 等 CDP 就绪
  let version;
  for (let i = 0; i < 30 && !version; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(1000); }
  }
  if (!version) throw new Error("CDP 未就绪");
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = targets.find((t) => t.type === "page" && /Pi|index\.html/.test((t.title ?? "") + t.url));
  if (!page) throw new Error("找不到页面 target");

  // 以应用视角拿 userData：种文件/清场都指向应用真正读的目录
  // （坑：send 必须在 await open 之后直接发，再挂 open listener 已错过事件永不触发，smoke 实测 300s 挂死）
  const dirProbe = await new Promise(async (res) => {
    const w = new WebSocket(page.webSocketDebuggerUrl);
    w.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.id === 1) { w.close(); res(m.result?.result?.value); }
    });
    await new Promise((r, j) => { w.addEventListener("open", r); w.addEventListener("error", j); });
    w.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "window.pi.fatalInfo()", awaitPromise: true, returnByValue: true } }));
  });
  if (dirProbe?.dir) { USER_DATA = dirProbe.dir; RUN_LOG = join(USER_DATA, "run.err.log"); }
  console.log("userData =", USER_DATA);

  const w = new WebSocket(page.webSocketDebuggerUrl);
  ws = w;
  await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const { res } = pending.get(m.id); pending.delete(m.id); res(m); }
  });
  function send(method, params) {
    const id = ++seq;
    return new Promise((res) => { pending.set(id, { res }); ws.send(JSON.stringify({ id, method, params })); });
  }
  async function call(expression) {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error("页面表达式异常: " + JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text));
    return r.result?.result?.value;
  }

  // 打开设置并切到日志 tab 的页面端动作（2026-10-10 验收加固：弹层/导航改轮询——smoke 连跑多实例时固定 sleep 不够，负载 flake 两装）
  const OPEN_LOGS = `
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const until = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await wait(200); } return null; };
      document.getElementById("btn-settings")?.click();
      const nav = await until(() => document.querySelector('.st-nav-item[data-tab="logs"]'), 10000);
      if (!nav) return { fail: "logs nav 不存在（10s）" };
      nav.click();
      await until(() => {
        const el = document.querySelector("#st-logs .st-app-label");
        return el && el.textContent ? true : null; // label 由 fatalInfo IPC 异步填充，须等真值（smoke 负载下空读=假红）
      }, 8000);
      await until(() => !document.getElementById("st-tab-logs").classList.contains("hidden"), 5000);
      return {
        label: document.querySelector("#st-logs .st-app-label")?.textContent ?? null,
        warn: !!document.querySelector("#st-logs .st-log-warn"),
        acts: [...document.querySelectorAll("#st-logs .st-mini")].map((b) => b.textContent),
        tabVisible: !document.getElementById("st-tab-logs").classList.contains("hidden"),
      };
    })()
  `;

  // ── 场景1：无 run.err.log → 无异常记录 + 打开日志目录
  let r = await call(OPEN_LOGS);
  console.log("场景1（无日志）:", JSON.stringify(r));
  assert(r && !r.fail && r.tabVisible && /无异常记录/.test(r.label ?? ""), "无日志时显示无异常记录");
  assert((r.acts ?? []).includes("打开日志目录"), "无日志时有打开目录按钮");
  // 关设置，准备种文件
  await call(`(async()=>{document.getElementById("st-close")?.click();await new Promise(r=>setTimeout(r,300));return true;})()`);

  // ── 场景2：种 run.err.log（真实告警种类）→ 未确认高亮 + 查看/标记已读
  writeFileSync(RUN_LOG, "[2026-10-10T08:00:00.000Z] [uncaughtException] TestFatalError: verify-logtab 种入的测试日志（栈略）\n", "utf8");
  r = await call(OPEN_LOGS);
  console.log("场景2（未确认）:", JSON.stringify(r));
  assert(r.tabVisible && /上次运行有异常记录/.test(r.label ?? ""), "未确认时高亮提醒文案");
  assert(r.warn === true, "未确认时 warn 样式在位");
  assert(/uncaughtException @ 2026-10-10/.test(r.label ?? ""), "kind 与时间入文案");
  assert((r.acts ?? []).includes("查看日志") && (r.acts ?? []).includes("标记已读"), "查看/标记已读按钮在位");
  assert(existsSync(RUN_LOG), "run.err.log 未被提前改名");

  // ── 场景3：点「标记已读」→ 改名 .acked + 行变已确认
  await call(`
    (async () => {
      const btn = [...document.querySelectorAll("#st-logs .st-mini")].find((b) => b.textContent === "标记已读");
      btn.click();
      await new Promise((r) => setTimeout(r, 800));
      return {
        label: document.querySelector("#st-logs .st-app-label")?.textContent ?? null,
        warn: !!document.querySelector("#st-logs .st-log-warn"),
        acts: [...document.querySelectorAll("#st-logs .st-mini")].map((b) => b.textContent),
      };
    })()
  `).then((x) => { r = x; });
  console.log("场景3（已读）:", JSON.stringify(r));
  assert(!existsSync(RUN_LOG) && existsSync(RUN_LOG + ".acked"), "ack 后 run.err.log → .acked 改名留现场");
  assert(/最近异常（已确认）/.test(r.label ?? "") && r.warn === false, "行变已确认且高亮撤销");

  // ── 场景4（2026-10-08 新语义）：纯自证无害日志（dispose-timeout）→ 不触发异常提醒，tail 仍可预览
  writeFileSync(RUN_LOG, "[2026-10-10T09:00:00.000Z] [dispose-timeout] entry=s1 budget=800ms elapsed=804ms running=false —— 已弃该 entry 继续退出，会话数据不受影响\n", "utf8");
  r = await call(OPEN_LOGS);
  console.log("场景4（纯无害日志）:", JSON.stringify(r));
  assert(r.tabVisible && /无异常记录/.test(r.label ?? ""), "纯 dispose-timeout 日志不触发异常提醒");
  assert(r.warn === false, "纯无害日志无 warn 高亮");

  console.log("\n== verify-logtab：4/4 通过 ==");
  ended = true;
} catch (err) {
  console.error("❌", err?.message ?? err);
  process.exitCode = 2;
} finally {
  // 清场：删种入文件
  for (const f of [RUN_LOG, RUN_LOG + ".acked"]) { try { if (existsSync(f)) unlinkSync(f); } catch {} }
  try { rmSync(join(USER_DATA, "SingletonLock"), { force: true }); } catch {}
  try { ws?.close(); } catch {}
  process.exit(ended ? 0 : 2); // 显式退出：WebSocket 会吊住事件循环（2026-10-10 实测挂死）
}

function assert(cond, name) {
  if (!cond) throw new Error("断言失败: " + name);
}
