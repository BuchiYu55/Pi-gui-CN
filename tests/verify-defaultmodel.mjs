/**
 * 设置中心 R4-3：设默认模型（新会话默认）验证（2026-10-05）
 * 用法：PI_GUI_CDP_PORT=9225 PI_GUI_USER_DATA=<独立目录> 启动测试实例后，node verify-defaultmodel.mjs 9225
 * 流程（结束还原 settings.json 初始默认）：
 *  ① 模型 tab：当前默认行有「默认」徽标 + 星标 on；② 点另一模型星标 → 徽标迁移 + settings.json 落盘；
 *  ③ 新会话 → 该会话模型即新默认（composer 下拉选中值）；④ 星标点回原默认 → 文件还原。
 */
import { readFileSync, copyFileSync } from "node:fs";
import os from "node:os";

const PORT = process.argv[2] || "9225";
const HOME = os.homedir().replace(/\\/g, "/"); // 正斜杠：防 CDP 表达式反斜杠转义坑（Windows fs API 通吃）
const S = `${HOME}/.pi/agent/settings.json`;
const BAK = `${os.tmpdir().replace(/\\/g, "/")}/settings.json.verify-bak`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parseSafe = (s) => { try { return JSON.parse(s); } catch { return null; } };
const readDefault = () => {
  const d = parseSafe(readFileSync(S, "utf8"));
  return d ? d.defaultProvider + "|" + d.defaultModel : null;
};

async function main() {
  const orig = readDefault();
  copyFileSync(S, BAK);
  try {
    await run(orig);
  } finally {
    copyFileSync(BAK, S);
    console.log("[finally] settings.json 已还原，默认 = " + readDefault());
  }
}

async function run(origRef) {
  const [, origModel] = String(origRef).split("|");
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && /Pi/.test(t.title ?? ""));
  if (!page) throw new Error("CDP target 未找到");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  ws.addEventListener("close", () => { console.error("[diag] ws CLOSED"); process.exit(2); });
  await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
  let n = 0;
  const call = (expression) => new Promise((resolve, reject) => {
    const id = ++n;
    const onMsg = (ev) => { try { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener("message", onMsg); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result?.result?.value); } } catch { /* 忽略 */ } };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
  });
  const assert = (cond, label) => { if (!cond) throw new Error("断言失败: " + label); };
  const waitFor = async (expression, test, timeoutMs, label) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      let v = null;
      try { v = await call(expression); } catch { /* 瞬时失败忽略 */ }
      let ok = false;
      try { ok = v != null && test(v); } catch { ok = false; }
      if (ok) return v;
      await sleep(1200);
    }
    throw new Error("超时等待: " + label);
  };
  // 行定位：动态——星标 on 的行即当前默认（2026-10-08 改：原硬编码 GLM-5.3-Flash 在 jev/auto 设默认后失效）；
  // ref 从星标 aria-label「设为默认：provider/id」提取（settings.json 为 provider|id，斜杠换竖线对齐）
  const EXPR_ROWS = `JSON.stringify([...document.querySelectorAll('#st-models-list .st-model-wrap')].map((w) => ({
    label: w.querySelector('.st-row-name')?.textContent ?? '',
    ref: (w.querySelector('.st-star')?.getAttribute('aria-label') ?? '').replace('设为默认：', ''),
    def: !!w.querySelector('.st-badge.def'),
    starOn: w.querySelector('.st-star')?.classList.contains('on') ?? false,
  })))`;

  await sleep(2500);
  await call(`document.getElementById('btn-settings').click(); true`);
  await sleep(300);
  await call(`document.querySelector('.st-nav-item[data-tab="models"]').click(); true`);
  await sleep(800);

  // ① 原默认行（星标 on）有徽标；另取一行作迁移目标
  let rows = parseSafe(await call(EXPR_ROWS));
  assert(rows && rows.length >= 2, "① 模型行≥2，got " + rows?.length);
  const origRow = rows.find((r) => r.starOn);
  const targetRow = rows.find((r) => !r.starOn);
  assert(origRow && origRow.def === true, "① 原默认星标 on + 徽标，got " + JSON.stringify(origRow));
  assert(targetRow && targetRow.def === false, "① 目标行无默认徽标");
  const pipe = (ref) => String(ref).replace("/", "|");
  assert(pipe(origRow.ref) === String(origRef), "① 星标 ref 与 settings.json 一致，got " + pipe(origRow.ref) + " vs " + origRef);
  console.log("== ① 默认徽标在 " + origRow.label + " ✓");

  // ② 点目标行星标
  const clicked = await call(`(() => {
    const w = [...document.querySelectorAll('#st-models-list .st-model-wrap')].find((x) => x.querySelector('.st-row-name')?.textContent === ${JSON.stringify(targetRow.label)});
    if (!w) return 'no-wrap';
    w.querySelector('.st-star').click();
    return 'ok';
  })()`);
  assert(clicked === "ok", "② 点星标: " + clicked);
  await sleep(1200);
  rows = parseSafe(await call(EXPR_ROWS));
  const t2 = rows.find((r) => r.label === targetRow.label);
  const o2 = rows.find((r) => r.label === origRow.label);
  assert(t2?.def === true && t2?.starOn === true, "② 徽标迁移到目标行");
  assert(o2?.def === false, "② 原行徽标消失");
  assert(readDefault() === pipe(targetRow.ref), "② settings.json 落盘，got " + readDefault());
  console.log("== ② 设默认+落盘 ✓");

  // ③ 新会话用新默认
  await call(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  await sleep(300);
  await call(`document.getElementById('btn-new-session').click(); true`);
  await waitFor(`(() => {
    const sel = document.getElementById('model-select');
    return sel && sel.value === '${pipe(targetRow.ref)}' ? sel.value : null;
  })()`, (v) => v === pipe(targetRow.ref), 20000, "新会话模型为新默认");
  console.log("== ③ 新会话即新默认 ✓");

  // ④ 星标点回原默认
  await call(`document.getElementById('btn-settings').click(); true`);
  await sleep(300);
  await call(`document.querySelector('.st-nav-item[data-tab="models"]').click(); true`);
  await sleep(800);
  const back = await call(`(() => {
    const w = [...document.querySelectorAll('#st-models-list .st-model-wrap')].find((x) => x.querySelector('.st-row-name')?.textContent === ${JSON.stringify(origRow.label)});
    if (!w) return 'no-wrap';
    w.querySelector('.st-star').click();
    return 'ok';
  })()`);
  assert(back === "ok", "④ 点回星标: " + back);
  await sleep(1200);
  assert(readDefault() === String(origRef), "④ settings.json 还原为原默认，got " + readDefault() + " 期望 " + origRef);
  console.log("== ④ 还原原默认 ✓");

  await call(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  console.log("\n全部通过 ✅  verify-defaultmodel 4/4");
  ws.close();
}

main().catch((e) => { console.error("❌", e.message); process.exit(1); });
