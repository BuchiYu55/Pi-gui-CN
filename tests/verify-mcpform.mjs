/**
 * 设置中心 R4：MCP 增删改表单化 验证（2026-10-05）
 * 用法：PI_GUI_CDP_PORT=9224 启动测试实例后，node verify-mcpform.mjs 9224
 * 流程（全程只动自建的 test-form-srv*，结束语义比对 + 还原 mcp.json 备份）：
 *  ① 设置→MCP 列表加载（≥5 行，全局行有编辑/停用/删除按钮）；
 *  ② 新增 url 型（headers 带 ${VAR} 引用）→ 行出现 + 文件级断言（url/headers 原样、enabled 省略）；
 *  ③ 停用→启用往返 → 文件 enabled:false 出现又移除；
 *  ④ 编辑回填正确（url/headers/description）；
 *  ⑤ 改名 → 旧键删除新键存在；
 *  ⑥ 非法名称被拦（空名保存失败出 notice）；
 *  ⑦ 删除（confirm 覆写）→ 行消失 + 文件无残留；
 *  ⑧ 语义还原：最终 mcpServers 与备份深度相等。
 */
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import os from "node:os";

const PORT = process.argv[2] || "9224";
const HOME = os.homedir().replace(/\\/g, "/"); // 正斜杠：防 CDP 表达式反斜杠转义坑（Windows fs API 通吃）
const MCP_FILE = `${HOME}/.pi/agent/mcp.json`;
const BAK = `${os.tmpdir().replace(/\\/g, "/")}/mcp.json.verify-bak`;
const SRV = "test-form-srv";
const SRV2 = "test-form-srv2";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parseSafe = (s) => { try { return JSON.parse(s); } catch { return null; } };
const readServers = () => parseSafe(readFileSync(MCP_FILE, "utf8"))?.mcpServers ?? null;

async function main() {
  copyFileSync(MCP_FILE, BAK);
  try {
    await run();
  } finally {
    copyFileSync(BAK, MCP_FILE);
    console.log("[finally] mcp.json 已从备份还原");
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

  await sleep(2500); // 等 init
  await call(`document.getElementById('btn-settings').click(); true`);
  await sleep(300);
  await call(`document.querySelector('.st-nav-item[data-tab="mcp"]').click(); true`);
  await sleep(800);

  // ① 列表加载 + 操作按钮
  const rows = parseSafe(await call(`JSON.stringify([...document.querySelectorAll('#st-mcp-list .st-row')].map((r) => ({
    name: r.querySelector('.st-row-name')?.textContent ?? '',
    acts: r.querySelectorAll('.st-mini').length,
  })))`));
  assert(rows && rows.length >= 5, "① 行数≥5，got " + JSON.stringify(rows?.length));
  const globalRow = rows.find((r) => r.acts === 3);
  assert(!!globalRow, "① 全局行有 3 个操作按钮");
  console.log(`== ① 列表 ${rows.length} 行，操作按钮在位 ✓`);

  // ② 新增 url 型服务器
  await call(`document.getElementById('st-mcp-add').click(); true`);
  await sleep(200);
  assert(await call(`document.getElementById('st-tab-mcp').classList.contains('editing')`), "② 表单打开（替换视图 editing）");
  await $set("#st-mf-name", SRV);
  await $set("#st-mf-type", "url", "change");
  await $set("#st-mf-url", "https://example.invalid/mcp");
  await $set("#st-mf-headers", "Authorization=Bearer ${TEST_VAR}");
  await $set("#st-mf-desc", "表单验证临时服务器");
  await call(`document.getElementById('st-mf-save').click(); true`);
  await sleep(1500);
  assert(await call(`!document.getElementById('st-tab-mcp').classList.contains('editing')`), "② 保存后表单关闭");
  const inDom = await call(`[...document.querySelectorAll('#st-mcp-list .st-row-name')].some((e) => e.textContent === '${SRV}')`);
  assert(inDom === true, "② 列表出现新行");
  const s2 = readServers()?.[SRV];
  assert(s2 && s2.url === "https://example.invalid/mcp", "② 文件 url 正确");
  assert(s2?.headers?.Authorization === "Bearer ${TEST_VAR}", "② ${VAR} 引用原样保留");
  assert(s2?.description === "表单验证临时服务器" && s2?.exposure === "deferred", "② description/exposure 正确");
  assert(!("enabled" in (s2 ?? {})), "② enabled=true 省略不落盘");
  console.log("== ② 新增+写盘+${VAR} 原样 ✓");

  // ③ 停用→启用往返
  const clickAct = (srv, label) => call(`(() => {
    const row = [...document.querySelectorAll('#st-mcp-list .st-row')].find((r) => r.querySelector('.st-row-name')?.textContent === '${srv}');
    if (!row) return 'no-row';
    const btn = [...row.querySelectorAll('.st-mini')].find((b) => (b.getAttribute('aria-label') ?? '').startsWith('${label}'));
    if (!btn) return 'no-btn';
    btn.click();
    return 'ok';
  })()`);
  assert((await clickAct(SRV, "停用")) === "ok", "③ 点停用");
  await sleep(1200);
  assert(readServers()?.[SRV]?.enabled === false, "③ 文件 enabled:false");
  const badge = await call(`(() => { const row = [...document.querySelectorAll('#st-mcp-list .st-row')].find((r) => r.querySelector('.st-row-name')?.textContent === '${SRV}'); return row?.querySelector('.st-badge.dim')?.textContent ?? ''; })()`);
  assert(badge === "已停用", "③ 行内已停用徽标，got " + JSON.stringify(badge));
  assert((await clickAct(SRV, "启用")) === "ok", "③ 点启用");
  await sleep(1200);
  assert(!("enabled" in (readServers()?.[SRV] ?? { enabled: 1 })), "③ enabled 字段移除");
  console.log("== ③ 停用/启用往返（pi 权威 update 语义）✓");

  // ④ 编辑回填
  assert((await clickAct(SRV, "编辑")) === "ok", "④ 点编辑");
  await sleep(300);
  const pre = parseSafe(await call(`JSON.stringify({
    name: document.getElementById('st-mf-name').value,
    type: document.getElementById('st-mf-type').value,
    url: document.getElementById('st-mf-url').value,
    headers: document.getElementById('st-mf-headers').value,
    desc: document.getElementById('st-mf-desc').value,
  })`));
  assert(pre?.name === SRV && pre?.type === "url" && pre?.url === "https://example.invalid/mcp", "④ 回填 name/type/url");
  assert(pre?.headers === "Authorization=Bearer ${TEST_VAR}", "④ 回填 headers");
  await $set("#st-mf-desc", "改过的描述");
  await $set("#st-mf-name", SRV2);
  await call(`document.getElementById('st-mf-save').click(); true`);
  await sleep(1500);
  const servers5 = readServers();
  assert(servers5?.[SRV2]?.description === "改过的描述", "⑤ 改名后新键内容正确");
  assert(servers5?.[SRV] === undefined, "⑤ 旧键已删");
  console.log("== ④ 回填正确 / ⑤ 改名（写新删旧）✓");

  // ⑥ 非法名称拦截
  await call(`document.getElementById('st-mcp-add').click(); true`);
  await sleep(200);
  await $set("#st-mf-name", "");
  await $set("#st-mf-type", "stdio", "change");
  await $set("#st-mf-command", "echo");
  await call(`document.getElementById('st-mf-save').click(); true`);
  await sleep(600);
  const errNotice = await call(`document.getElementById('notice')?.textContent ?? ''`);
  assert(/保存失败/.test(errNotice) && /服务器名/.test(errNotice), "⑥ 空名被拦出 notice，got " + JSON.stringify(errNotice));
  await call(`document.getElementById('st-mf-cancel').click(); true`);
  console.log("== ⑥ 名称白名单拦截 ✓");

  // ⑦ 删除（覆写 confirm）
  await call(`window.confirm = () => true; true`);
  assert((await clickAct(SRV2, "删除")) === "ok", "⑦ 点删除");
  await sleep(1200);
  assert(readServers()?.[SRV2] === undefined, "⑦ 文件无残留");
  assert(await call(`![...document.querySelectorAll('#st-mcp-list .st-row-name')].some((e) => e.textContent === '${SRV2}')`) === true, "⑦ 行已消失");
  console.log("== ⑦ 删除 ✓");

  // ⑧ 语义还原比对
  const before = parseSafe(readFileSync(BAK, "utf8"))?.mcpServers;
  const after = readServers();
  assert(JSON.stringify(before) === JSON.stringify(after), "⑧ mcpServers 与备份语义相等");
  console.log("== ⑧ 语义还原 ✓");

  await call(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  console.log("\n全部通过 ✅  verify-mcpform 8/8");
  ws.close();
}

main().catch((e) => { console.error("❌", e.message); process.exit(1); });
