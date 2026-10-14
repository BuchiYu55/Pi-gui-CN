/**
 * 设置中心 R4-2：自定义提供商 models.json 表单化 验证（2026-10-05）
 * 用法：PI_GUI_CDP_PORT=9224 启动测试实例后，node verify-modelsform.mjs 9224
 * 流程（只动自建 test-form-provider；结束还原 models.json 至初始状态——原本不存在则删除）：
 *  ① 模型 tab 自定义区空态；② 新增（models 两行含 |显示名|ctx）→ 行出现 + 文件级断言；
 *  ③ 模型下拉/面板刷新出现新 provider；④ 编辑回填 + 改显示名 → 文件更新；
 *  ⑤ 删除 → 文件清空 + 下拉消失；⑥ 还原。
 */
import { readFileSync, writeFileSync, unlinkSync, existsSync, copyFileSync } from "node:fs";
import os from "node:os";

const PORT = process.argv[2] || "9224";
const HOME = os.homedir().replace(/\\/g, "/"); // 正斜杠：防 CDP 表达式反斜杠转义坑（Windows fs API 通吃）
const F = `${HOME}/.pi/agent/models.json`;
const S = `${HOME}/.pi/agent/settings.json`;
const BAK = `${os.tmpdir().replace(/\\/g, "/")}/models.json.verify-bak`;
const SBAK = `${os.tmpdir().replace(/\\/g, "/")}/settings.json.modelsform-bak`;
const PROV = "test-form-provider";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parseSafe = (s) => { try { return JSON.parse(s); } catch { return null; } };
const readProv = () => parseSafe(existsSync(F) ? readFileSync(F, "utf8") : null)?.providers ?? null;

async function main() {
  const existed = existsSync(F);
  if (existed) copyFileSync(F, BAK);
  const hadSettings = existsSync(S);
  if (hadSettings) copyFileSync(S, SBAK);
  try {
    await run();
  } finally {
    if (existed) copyFileSync(BAK, F);
    else if (existsSync(F)) unlinkSync(F);
    if (hadSettings) copyFileSync(SBAK, S);
    console.log("[finally] models.json 已还原（初始" + (existed ? "备份回写" : "不存在→已删") + "），settings.json 已还原");
  }
}

async function run() {
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
  const $set = (sel, val, ev = "input") => call(`(() => { const e = document.querySelector('${sel}'); e.value = ${JSON.stringify(val)}; e.dispatchEvent(new Event('${ev}', { bubbles: true })); return true; })()`);

  await sleep(2500);
  await call(`document.getElementById('btn-settings').click(); true`);
  await sleep(300);
  await call(`document.querySelector('.st-nav-item[data-tab="models"]').click(); true`);
  await sleep(600);

  // ① 自定义区空态（models.json 不存在）
  const empty1 = await call(`document.querySelector('#st-prov-list .pane-empty')?.textContent ?? ''`);
  assert(empty1.includes("未配置自定义提供商"), "① 空态文案，got " + JSON.stringify(empty1));
  console.log("== ① 自定义区空态 ✓");

  // ② 新增（先临时把测试模型并入 enabledModels 白名单——session:models 白名单过滤会让
  //    测试 provider 进不了下拉/面板；owner 2026-10-07 设 jev 白名单后此断言曾全红，备份还原兜底）
  {
    const st = parseSafe(readFileSync(S, "utf8")) ?? {};
    st.enabledModels = [...(Array.isArray(st.enabledModels) ? st.enabledModels : []), `${PROV}/llama3.1`, `${PROV}/qwen2.5-test`];
    writeFileSync(S, JSON.stringify(st, null, 2) + "\n");
  }
  await call(`document.getElementById('st-prov-add').click(); true`);
  await sleep(200);
  await $set("#st-pf-name", PROV);
  await $set("#st-pf-baseurl", "http://127.0.0.1:11434/v1");
  await $set("#st-pf-apikey", "test-key-123");
  await $set("#st-pf-models", "llama3.1|Llama 3.1 Test|128000\nqwen2.5-test");
  await call(`document.getElementById('st-pf-save').click(); true`);
  await sleep(1800);
  const inDom = await call(`[...document.querySelectorAll('#st-prov-list .st-row-name')].some((e) => e.textContent === '${PROV}')`);
  assert(inDom === true, "② 列表出现新行");
  const p = readProv()?.[PROV];
  assert(p?.api === "openai-completions" && p?.baseUrl === "http://127.0.0.1:11434/v1", "② api/baseUrl 落盘");
  assert(p?.apiKey === "test-key-123", "② apiKey 透传");
  assert(p?.models?.length === 2, "② 两个模型");
  assert(p?.models?.[0]?.id === "llama3.1" && p?.models?.[0]?.name === "Llama 3.1 Test" && p?.models?.[0]?.contextWindow === 128000, "② 模型行 |字段| 解析");
  assert(p?.models?.[1]?.id === "qwen2.5-test" && !("name" in (p?.models?.[1] ?? {})) && !("contextWindow" in (p?.models?.[1] ?? {})), "② 可选字段省略");
  console.log("== ② 新增+写盘+行解析 ✓");

  // ③ 模型下拉刷新（modelRuntime.refresh 后新 provider 可用；dummy apiKey 使 auth 可解析）
  // pi 1.1.0 后刷新时序变宽，单发断言改轮询（最长 15s）
  const t0 = Date.now();
  let inSelect = false;
  while (Date.now() - t0 < 15000) {
    inSelect = await call(`[...document.querySelectorAll('#model-select option')].some((o) => (o.value ?? '').includes('${PROV}'))`);
    if (inSelect === true) break;
    await sleep(1000);
  }
  assert(inSelect === true, "③ composer 下拉出现新 provider 模型");
  const inPanel = await call(`[...document.querySelectorAll('#st-models-list .st-group-head')].some((e) => e.textContent === '${PROV}')`);
  assert(inPanel === true, "③ 模型面板出现新分组");
  console.log("== ③ 下拉/面板热刷新 ✓");

  // ④ 编辑回填 + 改显示名
  await call(`(() => { const btn = [...document.querySelectorAll('#st-prov-list .st-mini')].find((b) => (b.getAttribute('aria-label') ?? '') === '编辑 ${PROV}'); if (btn) { btn.click(); return 'ok'; } return 'no-btn'; })()`).then((r) => assert(r === "ok", "④ 点编辑"));
  await sleep(300);
  const pre = parseSafe(await call(`JSON.stringify({
    name: document.getElementById('st-pf-name').value,
    baseurl: document.getElementById('st-pf-baseurl').value,
    apikey: document.getElementById('st-pf-apikey').value,
    models: document.getElementById('st-pf-models').value,
  })`));
  assert(pre?.name === PROV && pre?.baseurl === "http://127.0.0.1:11434/v1" && pre?.apikey === "test-key-123", "④ 回填基础字段");
  assert(pre?.models === "llama3.1|Llama 3.1 Test|128000\nqwen2.5-test", "④ 回填模型行");
  await $set("#st-pf-display", "Test Provider");
  await call(`document.getElementById('st-pf-save').click(); true`);
  await sleep(1800);
  assert(readProv()?.[PROV]?.name === "Test Provider", "④ 显示名落盘");
  console.log("== ④ 回填+编辑 ✓");

  // ⑤ 删除
  await call(`window.confirm = () => true; true`);
  await call(`(() => { const btn = [...document.querySelectorAll('#st-prov-list .st-mini')].find((b) => (b.getAttribute('aria-label') ?? '') === '删除 ${PROV}'); if (btn) { btn.click(); return 'ok'; } return 'no-btn'; })()`).then((r) => assert(r === "ok", "⑤ 点删除"));
  await sleep(1800);
  assert(readProv()?.[PROV] === undefined, "⑤ 文件无残留");
  const gone = await call(`![...document.querySelectorAll('#model-select option')].some((o) => (o.value ?? '').includes('${PROV}'))`);
  assert(gone === true, "⑤ 下拉已无该 provider");
  const empty2 = await call(`document.querySelector('#st-prov-list .pane-empty')?.textContent ?? ''`);
  assert(empty2.includes("未配置自定义提供商"), "⑤ 空态恢复");
  console.log("== ⑤ 删除+下拉同步 ✓");

  await call(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  console.log("\n全部通过 ✅  verify-modelsform 5/5");
  ws.close();
}

main().catch((e) => { console.error("❌", e.message); process.exit(1); });
