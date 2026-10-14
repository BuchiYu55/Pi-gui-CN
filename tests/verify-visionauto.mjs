/**
 * 视觉模型自动切换 验证（2026-10-05 建；2026-10-10 审计轮重写为 UI 无关版）：
 * 断言一律锚 window.pi.getState() 的模型真值——不依赖 composer 控件形态
 * （model-select 下拉已在 6ef4037 改「工作/深想/日常」三键，旧锚失效）；jev/auto 场景段已随撤场删除。
 * 用法：PI_GUI_CDP_PORT=9225 PI_GUI_USER_DATA=<独立目录> 启动实例后，node verify-visionauto.mjs 9225
 * 流程：① 设置行在位，目标下拉只列视觉模型；② setModel 到 glm-5.3（文本模型）；
 *      ③ 注入 png + 发送 → 自动切 flash（abort 截断）；④ 无图发送 → 回切 glm-5.3；
 *      ⑤ 配置持久化 + 开关落库。
 */
import { writeFileSync } from "node:fs";
import os from "node:os";

const PORT = process.argv[2] || "9225";
const PNG = `${os.tmpdir().replace(/\\/g, "/")}/vision-test-1px.png`; // 正斜杠：防 CDP 表达式反斜杠转义坑（Windows fs API 通吃）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parseSafe = (s) => { try { return JSON.parse(s); } catch { return null; } };
// 1x1 红色 png（最小合法图）
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function main() {
  writeFileSync(PNG, Buffer.from(PNG_B64, "base64"));
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && /Pi/.test(t.title ?? ""));
  if (!page) throw new Error("CDP target 未找到");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let ended = false;
  ws.addEventListener("close", () => { if (!ended) { console.error("[diag] ws CLOSED"); process.exit(2); } });
  await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
  let n = 0;
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++n + 1000;
    const onMsg = (ev) => { try { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener("message", onMsg); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); } } catch { /* 忽略 */ } };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const call = (expression) => send("Runtime.evaluate", { expression, returnByValue: true }).then((r) => r?.result?.value);
  const callA = (expression) => send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }).then((r) => r?.result?.value);
  const assert = (cond, label) => { if (!cond) throw new Error("断言失败: " + label); };
  // 模型真值探针（UI 无关）：getState 的 provider|id
  const EXPR_MODEL = `window.pi.getState().then(s => (s?.model?.provider ?? "") + "|" + (s?.model?.id ?? ""))`;
  const waitForModel = async (test, timeoutMs, label) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      let v = null;
      try { v = await callA(EXPR_MODEL); } catch { /* 瞬时失败忽略 */ }
      let ok = false;
      try { ok = typeof v === "string" && test(v); } catch { ok = false; }
      if (ok) return v;
      await sleep(1000);
    }
    throw new Error("超时等待: " + label);
  };

  await sleep(3000); // 等 init + loadModels

  // ① 设置行 + 目标下拉只列视觉模型
  const row = parseSafe(await call(`JSON.stringify({
    hasRow: !!document.getElementById('st-vision-on'),
    on: document.getElementById('st-vision-on')?.checked,
    opts: [...document.querySelectorAll('#st-vision-target option')].map((o) => o.value),
  })`));
  assert(row?.hasRow && row.on === true, "① 设置行在位且默认开，got " + JSON.stringify(row));
  assert(row.opts.includes("zai-coding-cn|glm-5.3-flash"), "① 目标含 flash（2026-10-06 收敛后唯一视觉模型，4.6v 已删）");
  assert(!row.opts.some((v) => v.endsWith("|glm-5.3") || v.endsWith("|glm-5.3-highspeed")), "① 纯文本模型不入列");
  console.log("== ① 设置行/目标下拉（仅视觉模型 " + row.opts.length + " 个）✓");

  // ② 手动切到 glm-5.3（文本模型，模拟 owner 默认；直走 IPC——2026-10-10 起控件形态无关）。
  // 直连 IPC 只改主进程，渲染端 state.model 需 reload 重取（旧版靠下拉 change 处理器回写 state；
  // 漏了这环渲染端会自以为在视觉模型上而静默跳过切换——2026-10-10 重写实测踩中）
  await callA(`window.pi.setModel("zai-coding-cn", "glm-5.3").then(() => true)`);
  await call(`location.reload(); true`);
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    try {
      const ready = await call(`document.readyState === "complete" && !!document.getElementById("input")`);
      if (ready) break;
    } catch { /* 未就绪 */ }
  }
  await sleep(1500);
  const m2 = await waitForModel((v) => v === "zai-coding-cn|glm-5.3", 15000, "手动切到 glm-5.3");
  console.log("== ② 手动切 glm-5.3 ✓（" + m2 + "）");

  // ③ 注入图片附件 + 发送 → 自动切 5.3-flash（2026-10-10 Q10：切换确认黄条已删，结果由真值自证）
  const doc = await send("DOM.getDocument", {});
  const { nodeId } = await send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#file-input" });
  await send("DOM.setFileInputFiles", { files: [PNG], nodeId });
  await sleep(600);
  const attOk = await call(`!document.getElementById('attachments')?.classList.contains('hidden')`);
  assert(attOk === true, "③ 附件条出现");
  await call(`(() => { const i = document.getElementById('input'); i.value = '看下这张图'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
  const m3 = await waitForModel((v) => v === "zai-coding-cn|glm-5.3-flash", 20000, "带图发送自动切 5.3-flash");
  console.log("== ③ 带图发送 → 自动切 5.3-flash ✓（" + m3 + "）");
  await callA(`window.pi.abort().then(() => true)`).catch(() => {});
  await sleep(800);

  // ④ 无图发送 → 回切 glm-5.3
  await call(`(() => { const i = document.getElementById('input'); i.value = '继续，不用看图'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
  const m4 = await waitForModel((v) => v === "zai-coding-cn|glm-5.3", 20000, "无图发送回切 glm-5.3");
  console.log("== ④ 无图发送 → 回切 glm-5.3 ✓（" + m4 + "）");
  await callA(`window.pi.abort().then(() => true)`).catch(() => {});
  await sleep(600);

  // ⑤ 配置持久化 + 开关落库
  const cfg1 = parseSafe(await call(`localStorage.getItem('pi-gui:vision-auto')`));
  assert(cfg1?.on === true && cfg1.target === "zai-coding-cn|glm-5.3-flash", "⑤ 配置落库，got " + JSON.stringify(cfg1));
  await call(`(() => { const c = document.getElementById('st-vision-on'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await sleep(300);
  const cfg2 = parseSafe(await call(`localStorage.getItem('pi-gui:vision-auto')`));
  assert(cfg2?.on === false, "⑤ 关开关落库 off");
  await call(`(() => { const c = document.getElementById('st-vision-on'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  console.log("== ⑤ 配置持久化/开关 ✓");

  console.log("\n全部通过 ✅  verify-visionauto 5 段（jev 场景段已随撤场删除，2026-10-10）");
  ended = true;
  ws.close();
}

main().catch((e) => { console.error("❌", e.message); process.exit(1); });
