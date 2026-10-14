/**
 * UI 修复验证（2026-10-05 审计轮）：设置页对齐 + 对比度 + 字号档收敛
 * 用法：PI_GUI_CDP_PORT=9225 PI_GUI_USER_DATA=<独立目录> 启动实例后，node verify-uifix.mjs 9225
 * 断言：① 扩展社区搜索区满宽左贴（不再居中）；② 五 tab 左缘一致（统一左栏）；
 *      ③ 关键 computed style（st-hint 11px/tx2、nav 12px、tab-title 14px、side-title 17px）；
 *      ④ 弹窗无横向溢出；⑤ MCP 工具栏行左对齐；⑥ theme-color meta。
 */
const PORT = process.argv[2] || "9225";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parseSafe = (s) => { try { return JSON.parse(s); } catch { return null; } };

async function main() {
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

  await sleep(2500);
  await call(`document.getElementById('btn-settings').click(); true`);
  await sleep(300);
  await call(`document.querySelector('.st-nav-item[data-tab="ext"]').click(); true`);
  await sleep(200);

  // ① 扩展社区（默认 tab）：搜索区满宽左贴——搜索框宽度 ≈ tab 内容宽（stretch），左缘一致
  const ext = parseSafe(await call(`JSON.stringify((() => {
    const tab = document.querySelector('#st-tab-ext');
    const search = tab?.querySelector('.st-search-wrap');
    if (!tab || !search) return null;
    const cs = getComputedStyle(tab);
    const t = tab.getBoundingClientRect(); const s = search.getBoundingClientRect();
    const expL = Math.round(parseFloat(cs.paddingLeft));
    const expW = expL + Math.round(parseFloat(cs.paddingRight));
    return { leftDiff: Math.round(s.left - t.left), widthDiff: Math.round(t.width - s.width), expL, expW };
  })())`));
  assert(ext && Math.abs(ext.leftDiff - ext.expL) <= 1 && Math.abs(ext.widthDiff - ext.expW) <= 2,
    "① 搜索区满宽左贴（应以内容缘为基准），got " + JSON.stringify(ext));
  console.log("== ① 扩展社区搜索区满宽左贴（leftDiff=" + ext.leftDiff + " widthDiff=" + ext.widthDiff + "）✓");

  // ② 五 tab 左缘一致（统一左栏：title/hint 左缘相同；class 翻转同步，静态标题即时可测）
  const rails = parseSafe(await call(`JSON.stringify((() => {
    const out = {};
    for (const name of ['ext', 'skills', 'mcp', 'models', 'appearance']) {
      document.querySelector('.st-nav-item[data-tab="' + name + '"]').click();
      const tab = document.getElementById('st-tab-' + name);
      const first = tab?.querySelector('.st-tab-title') ?? tab?.firstElementChild;
      out[name] = first ? Math.round(first.getBoundingClientRect().left) : null;
    }
    return out;
  })())`));
  const vals = Object.values(rails ?? {}).filter((v) => v != null);
  assert(vals.length === 5 && new Set(vals).size === 1, "② 五 tab 左缘一致，got " + JSON.stringify(rails));
  console.log("== ② 五 tab 左缘一致（x=" + vals[0] + "）✓");

  // ③ 关键 computed style
  const cs = parseSafe(await call(`JSON.stringify({
    hint: (() => { const e = document.querySelector('.st-hint'); const c = getComputedStyle(e); return c.fontSize + ' ' + c.color; })(),
    nav: (() => { const e = document.querySelector('.st-nav-item'); return getComputedStyle(e).fontSize; })(),
    tabTitle: (() => { const e = document.querySelector('.st-tab-title'); return getComputedStyle(e).fontSize; })(),
    sideTitle: (() => { const e = document.querySelector('.st-side-title'); return getComputedStyle(e).fontSize; })(),
  })`));
  assert(cs?.hint === "11px rgb(110, 103, 90)", "③ st-hint 11px/tx2，got " + cs?.hint);
  assert(cs?.nav === "12px" && cs?.tabTitle === "14px" && cs?.sideTitle === "17px", "③ 字号档 12/14/17，got " + JSON.stringify(cs));
  console.log("== ③ 对比度修复（hint tx2）+ 字号档收敛 ✓");

  // ④ 弹窗无横向溢出
  const ovf = await call(`document.documentElement.scrollWidth <= window.innerWidth + 1`);
  assert(ovf === true, "④ 无横向溢出");
  console.log("== ④ 无横向溢出 ✓");

  // ⑤ MCP tab：工具栏行左对齐 + 列表行内容不居中（align-items 必须 stretch，防双定义级联回归）
  await call(`document.querySelector('.st-nav-item[data-tab="mcp"]').click(); true`);
  await sleep(400);
  const bar = parseSafe(await call(`JSON.stringify((() => {
    const tab = document.getElementById('st-tab-mcp');
    const barEl = tab?.querySelector('.st-actions-bar');
    const title = tab?.querySelector('.st-tab-title');
    const row = tab?.querySelector('#st-mcp-list .st-row');
    if (!tab || !barEl || !title || !row) return null;
    const rc = getComputedStyle(row);
    const rr = row.getBoundingClientRect(); const tr = row.querySelector('.st-row-top')?.getBoundingClientRect();
    const pad = Math.round(parseFloat(rc.paddingLeft));
    return { barLeft: Math.round(barEl.getBoundingClientRect().left), titleLeft: Math.round(title.getBoundingClientRect().left),
             rowAlign: rc.alignItems, topLeft: Math.round(tr.left), rowLeft: Math.round(rr.left), pad };
  })())`));
  assert(bar && Math.abs(bar.barLeft - bar.titleLeft) <= 1, "⑤ 工具栏与标题左缘对齐，got " + JSON.stringify(bar));
  assert(bar.rowAlign === "stretch", "⑤ 行 align-items=stretch（双定义级联已除），got " + bar.rowAlign);
  assert(Math.abs(bar.topLeft - bar.rowLeft - bar.pad) <= 1, "⑤ 行内容左贴内容缘，got " + JSON.stringify({ topLeft: bar.topLeft, rowLeft: bar.rowLeft, pad: bar.pad }));
  console.log("== ⑤ MCP 工具栏左对齐 + 行内容不居中 ✓");

  // ⑥ theme-color
  const tc = await call(`document.querySelector('meta[name="theme-color"]')?.content ?? ''`);
  assert(tc === "#faf8f4", "⑥ theme-color，got " + JSON.stringify(tc));
  console.log("== ⑥ theme-color 与纸面底一致 ✓");

  await call(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  console.log("\n全部通过 ✅  verify-uifix 6/6");
  ws.close();
}

main().catch((e) => { console.error("❌", e.message); process.exit(1); });
