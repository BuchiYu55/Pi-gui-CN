/**
 * 代理 tab + 主题系统验证（2026-10-08 批次②）
 * 用法：PI_GUI_CDP_PORT=9226 启动测试实例后，node verify-agent-theme.mjs 9226
 * 流程（settings.json 备份还原；notify 配置存测试实例独立 userData，天然隔离）：
 *  ① 代理 tab 六行渲染；
 *  ② 默认权限档切换 + perm:getDefault 回读 + 还原；
 *  ③ 默认思考强度落盘 defaultThinkingLevel + 清档回「跟随模型」；
 *  ④ 压缩档落盘 compaction.keepRecentTokens；
 *  ⑤ 通知闸：总开关/勿扰（含跨零点、伪造时刻探针）/提示音 + 还原；
 *  ⑥ 主题：html[data-theme] 切换 + 底色变量 + localStorage + 还原宣纸。
 */
import { readFileSync, copyFileSync } from "node:fs";
import os from "node:os";

const PORT = process.argv[2] || "9226";
const HOME = os.homedir().replace(/\\/g, "/"); // 正斜杠：防 CDP 表达式反斜杠转义坑（Windows fs API 通吃）
const S = `${HOME}/.pi/agent/settings.json`;
const BAK = `${os.tmpdir().replace(/\\/g, "/")}/settings.json.agenttheme-bak`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parseSafe = (s) => { try { return JSON.parse(s); } catch { return null; } };

async function main() {
  copyFileSync(S, BAK);
  try {
    await run();
  } finally {
    copyFileSync(BAK, S);
    console.log("[finally] settings.json 已还原");
  }
}

async function run() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && /Pi/.test(t.title ?? ""));
  if (!page) throw new Error("CDP target 未找到");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let ended = false; // 主动收尾置位：ws close 是正常路径，不退 2（曾致 smoke 误判失败）
  ws.addEventListener("close", () => { if (!ended) { console.error("[diag] ws CLOSED"); process.exit(2); } });
  await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
  let n = 0;
  const call = (expression, awaitPromise = false) => new Promise((resolve, reject) => {
    const id = ++n;
    const onMsg = (ev) => { try { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener("message", onMsg); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result?.result?.value); } } catch { /* 忽略 */ } };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise } }));
  });
  // window.pi.* 都是 IPC Promise：必须 awaitPromise，否则拿到的是未决 Promise 序列化物
  const ipc = (expr) => call(expr, true);
  const assert = (cond, label) => { if (!cond) throw new Error("断言失败: " + label); };
  const clickChip = (rowIdx, name) => call(`(() => {
    const row = document.querySelectorAll('#st-agent .st-app-row')[${rowIdx}];
    if (!row) return 'no-row';
    const chip = [...row.querySelectorAll('.chip')].find((c) => c.textContent === '${name}');
    if (!chip) return 'no-chip';
    chip.click();
    return 'ok';
  })()`);

  await sleep(2500); // 等 init

  // ① 代理 tab 六行
  await call(`document.getElementById('btn-settings').click(); true`);
  await sleep(300);
  await call(`document.querySelector('.st-nav-item[data-tab="agent"]').click(); true`);
  await sleep(1200);
  const rows = await call(`document.querySelectorAll('#st-agent .st-app-row').length`);
  assert(rows === 6, "① 代理 tab 六行，got " + rows);
  const labels = await call(`JSON.stringify([...document.querySelectorAll('#st-agent .st-app-label')].map((l) => l.textContent))`);
  assert(JSON.parse(labels).join(",") === "默认权限档,默认思考强度,上下文压缩,任务通知,通知提示音,勿扰时段", "① 行标签序，got " + labels);
  console.log("== ① 代理 tab 六行 ✓");

  // ② 默认权限档：切「完全」→ perm:getDefault 回读 → 还原
  const permOrig = await ipc(`window.pi.permGetDefault()`);
  assert((await clickChip(0, "完全")) === "ok", "② 点完全");
  await sleep(600);
  assert((await ipc(`window.pi.permGetDefault()`)) === "full", "② perm 默认=full");
  await clickChip(0, permOrig === "plan" ? "计划" : permOrig === "full" ? "完全" : "默认");
  await sleep(600);
  assert((await ipc(`window.pi.permGetDefault()`)) === permOrig, "② 权限还原 " + permOrig);
  console.log("== ② 默认权限档读写+还原 ✓");

  // ③ 默认思考强度：低 → 文件落盘 → 跟随模型 → 键删除
  assert((await clickChip(1, "低")) === "ok", "③ 点低");
  await sleep(800);
  assert(parseSafe(readFileSync(S, "utf8"))?.defaultThinkingLevel === "low", "③ settings defaultThinkingLevel=low");
  assert((await ipc(`window.pi.agentGet()`)).thinking === "low", "③ agentGet 回读 low");
  assert((await clickChip(1, "跟随模型")) === "ok", "③ 点跟随模型");
  await sleep(800);
  assert(parseSafe(readFileSync(S, "utf8"))?.defaultThinkingLevel === undefined, "③ 清档后键已删");
  console.log("== ③ 默认思考强度落盘+清档 ✓");

  // ④ 压缩档：激进 → keepRecentTokens=12000
  assert((await clickChip(2, "激进")) === "ok", "④ 点激进");
  await sleep(800);
  assert(parseSafe(readFileSync(S, "utf8"))?.compaction?.keepRecentTokens === 12000, "④ compaction.keepRecentTokens=12000");
  assert((await ipc(`window.pi.agentGet()`)).keep === 12000, "④ agentGet 回读 12000");
  console.log("== ④ 压缩档落盘 ✓");

  // ⑤ 通知闸：总开关 / 勿扰（跨零点+伪造时刻）/ 提示音
  let probe = await ipc(`window.pi.notifyProbe()`);
  assert(probe?.allowed === true, "⑤ 初始放行");
  await clickChip(3, "关");
  await sleep(500);
  probe = await ipc(`window.pi.notifyProbe()`);
  assert(probe?.allowed === false && probe?.reason === "disabled", "⑤ 总开关关=抑制");
  await clickChip(3, "开");
  await sleep(500);
  // 提示音：开 → gate.sound true（必须在设勿扰窗【前】断言：gate 用真实当前时间，
  // 夜间跑测试时"现在"落在 22:00-08:00 勿扰窗内 → gate.sound 恒 false 误红，2026-10-08 踩）
  await clickChip(4, "开");
  await sleep(500);
  const snd = await ipc(`window.pi.notifyGet()`);
  assert(snd?.sound === true && snd?.gate?.sound === true, "⑤ 提示音透传 gate.sound");
  // 勿扰：直接 IPC 设跨零点窗（22:00-08:00），伪造 23:30（命中）与 12:00（窗外）
  await ipc(`window.pi.notifySet({ dndStart: "22:00", dndEnd: "08:00" })`);
  await sleep(400);
  const inWin = await ipc(`window.pi.notifyProbe("2026-10-08T23:30:00")`);
  const outWin = await ipc(`window.pi.notifyProbe("2026-10-08T12:00:00")`);
  assert(inWin?.allowed === false && inWin?.reason === "dnd", "⑤ 勿扰窗内抑制");
  assert(outWin?.allowed === true, "⑤ 窗外放行");
  // 还原通知配置
  await ipc(`window.pi.notifySet({ sound: false, dndStart: "", dndEnd: "" })`);
  await sleep(400);
  const ntRestored = await ipc(`window.pi.notifyGet()`);
  assert(ntRestored?.sound === false && ntRestored?.dndStart === "" && ntRestored?.dndEnd === "", "⑤ 通知配置还原");
  console.log("== ⑤ 通知闸（开关/勿扰跨零点/提示音）✓");

  // ⑥ 主题：青瓷 → data-theme + CSSOM 规则值 + localStorage → 宣纸还原
  // ⚠️ 不用 computed bodyBg 断言：无头实例不可见窗口样式管线节流，computed 滞后于真实
  //    状态（实测 dataset/CSSOM 已新而 body 底色读旧值，晚读又自愈）——断言走数据层
  await call(`document.querySelector('.st-nav-item[data-tab="appearance"]').click(); true`);
  await sleep(800);
  assert((await call(`(() => { const row = [...document.querySelectorAll('#st-appearance .st-app-row')].find((r) => r.querySelector('.st-app-label')?.textContent === '主题'); const chip = [...(row?.querySelectorAll('.chip') ?? [])].find((c) => c.textContent === '青瓷'); if (!chip) return 'no-chip'; chip.click(); return 'ok'; })()`)) === "ok", "⑥ 点青瓷");
  await sleep(600);
  assert((await call(`document.documentElement.dataset.theme`)) === "qingci", "⑥ data-theme=qingci");
  const qingciVar = await call(`(() => { for (const sh of document.styleSheets) { for (const r of sh.cssRules) { if (r.selectorText === 'html[data-theme="qingci"]') { const m = r.cssText.match(/--bg1:\\s*([^;]+);/); return m ? m[1].trim() : null; } } } return null; })()`);
  assert(qingciVar === "#f5f8f0", "⑥ CSSOM 青瓷 --bg1 在位，got " + qingciVar);
  assert((await call(`localStorage.getItem('pi-gui:theme')`)) === "qingci", "⑥ localStorage 持久化");
  assert((await call(`(() => { const row = [...document.querySelectorAll('#st-appearance .st-app-row')].find((r) => r.querySelector('.st-app-label')?.textContent === '主题'); const chip = [...(row?.querySelectorAll('.chip') ?? [])].find((c) => c.textContent === '宣纸'); chip.click(); return 'ok'; })()`)) === "ok", "⑥ 点回宣纸");
  await sleep(600);
  assert((await call(`document.documentElement.dataset.theme ?? ''`)) === "", "⑥ 宣纸还原（data-theme 移除）");
  assert((await call(`localStorage.getItem('pi-gui:theme')`)) === "paper", "⑥ localStorage=paper");
  console.log("== ⑥ 主题切换（青瓷↔宣纸，数据层断言）✓");

  await call(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  console.log("\n全部通过 ✅  verify-agent-theme 6/6");
  ended = true;
  ws.close();
}

main().catch((e) => { console.error("❌", e.message); process.exit(1); });
