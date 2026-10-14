/**
 * 设置中心 R2 验证（Skills / MCP / 模型 / 外观 四面板 + tab 切换 + 外观真实生效）
 * 用法：PI_GUI_CDP_PORT=9223 启动测试实例后，node verify-r2.mjs 9223
 */
const PORT = process.argv[2] || "9223";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findTarget() {
  for (let i = 0; i < 20; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && /Pi/.test(t.title ?? ""));
      if (page) return page;
    } catch { /* 未就绪 */ }
    await sleep(1000);
  }
  throw new Error("CDP target 未找到");
}

// 页面端脚本：独立文件读入，规避多层转义坑
const OPEN_AND_SWITCH = String.raw`
(async () => {
  const r = {};
  document.getElementById('btn-settings').click();
  const navs = [...document.querySelectorAll('.st-nav-item')];
  r.navCount = navs.length;
  r.navDisabled = navs.filter(b => b.disabled).map(b => b.textContent.trim());
  r.tabs = [...document.querySelectorAll('.st-tab')].map(t => t.id);
  const vis = () => [...document.querySelectorAll('.st-tab:not(.hidden)')].map(t => t.id);
  r.visibleOnOpen = vis();
  // 逐 tab 切换（等渲染）
  const wait = (ms) => new Promise(res => setTimeout(res, ms));
  const clickNav = async (tab) => {
    const b = navs.find(x => x.dataset.tab === tab);
    b.click(); await wait(600);
    return {
      visible: vis(),
      rows: document.querySelectorAll('#st-tab-' + tab + ' .st-row').length,
      empty: document.querySelector('#st-tab-' + tab + ' .pane-empty')?.textContent ?? null,
    };
  };
  r.skills = await clickNav('skills');
  r.skillsBadges = [...document.querySelectorAll('#st-skills-list .st-badge')].map(b => b.textContent);
  r.skillsFirstName = document.querySelector('#st-skills-list .st-row-name')?.textContent ?? null;
  r.mcp = await clickNav('mcp');
  r.mcpDots = [...document.querySelectorAll('#st-mcp-list .st-mdot')].map(d => d.className.replace('st-mdot', '').trim());
  r.mcpCounts = [...document.querySelectorAll('#st-mcp-list .st-count')].map(c => c.textContent);
  r.mcpRows = [...document.querySelectorAll('#st-mcp-list .st-row')].map(row => ({
    name: row.querySelector('.st-row-name')?.textContent ?? '',
    count: row.querySelector('.st-count')?.textContent ?? '',
    dot: (row.querySelector('.st-mdot')?.className ?? '').replace('st-mdot', '').trim(),
    disabled: !!row.querySelector('.st-badge.dim'),
  }));
  r.mcpOpenBtn = !!document.getElementById('st-mcp-open');
  r.models = await clickNav('models');
  r.modelsCount = document.querySelectorAll('#st-models-list .st-model').length;
  r.modelsCurrent = document.querySelector('#st-models-list .st-model.current .st-row-name')?.textContent ?? null;
  r.modelsCurBadge = !!document.querySelector('#st-models-list .st-badge.cur');
  r.modelsHeads = [...document.querySelectorAll('#st-models-list .st-group-head')].map(h => h.textContent);
  r.appearance = await clickNav('appearance');
  r.appearanceRows = document.querySelectorAll('#st-appearance .st-app-row').length;
  r.appearanceChips = [...document.querySelectorAll('#st-appearance .chip')].map(c => c.textContent);
  r.logs = await clickNav('logs'); // 2026-10-10 新增：异常记录入口（原启动顶部提醒条迁入）
  r.logsText = document.querySelector('#st-logs .st-app-label')?.textContent ?? null;
  r.logsActs = [...document.querySelectorAll('#st-logs .st-mini')].map(b => b.textContent);
  return JSON.stringify(r);
})()
`;

const APPEAR_APPLY = String.raw`
(async () => {
  const wait = (ms) => new Promise(res => setTimeout(res, ms));
  const r = {};
  const chips = () => [...document.querySelectorAll('#st-appearance .st-app-row')];
  // 行1=字号：点「大」
  let row = chips()[0];
  [...row.querySelectorAll('.chip')].find(c => c.textContent === '大').click();
  await wait(100);
  r.mdSizeAfterLarge = document.documentElement.style.getPropertyValue('--md-size');
  // 行2=列宽：点「宽」
  row = chips()[1];
  [...row.querySelectorAll('.chip')].find(c => c.textContent === '宽').click();
  await wait(100);
  r.colWAfterWide = document.documentElement.style.getPropertyValue('--col-w');
  r.chatComputed = getComputedStyle(document.querySelector('.chat > :first-child') || document.querySelector('.chat')).maxWidth;
  // 行3=动效：点「减弱」
  row = chips()[2];
  [...row.querySelectorAll('.chip')].find(c => c.textContent === '减弱').click();
  await wait(100);
  r.noAnim = document.documentElement.classList.contains('no-anim');
  // 持久化断言
  r.persist = {
    size: localStorage.getItem('pi-gui:msize'),
    width: localStorage.getItem('pi-gui:colw'),
    motion: localStorage.getItem('pi-gui:motion'),
  };
  // 还原默认
  [...chips()[0].querySelectorAll('.chip')].find(c => c.textContent === '标准').click();
  [...chips()[1].querySelectorAll('.chip')].find(c => c.textContent === '标准').click();
  [...chips()[2].querySelectorAll('.chip')].find(c => c.textContent === '正常').click();
  await wait(100);
  r.restored = {
    mdSize: document.documentElement.style.getPropertyValue('--md-size'),
    colW: document.documentElement.style.getPropertyValue('--col-w'),
    noAnim: document.documentElement.classList.contains('no-anim'),
  };
  // 模型切换点一下第一个非 current 行（只验证可点击不报错；切换本身有 notice）
  const target = [...document.querySelectorAll('.st-model:not(.current)')][0];
  if (target) { target.click(); await wait(700); }
  r.modelSwitchNotice = document.getElementById('notice')?.textContent ?? null;
  // 关闭设置
  document.getElementById('st-close').click();
  await wait(100);
  r.closedAfter = document.getElementById('settings-overlay').classList.contains('hidden');
  return JSON.stringify(r);
})()
`;

async function main() {
  const target = await findTarget();
  console.log("target:", target.title, target.url);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });

  let nextId = { n: 1 };
  const call = (expression) =>
    new Promise((resolve, reject) => {
      const id = nextId.n++;
      const onMsg = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id === id) {
          ws.removeEventListener("message", onMsg);
          if (msg.error) reject(new Error(JSON.stringify(msg.error)));
          else resolve(msg.result?.result?.value);
        }
      };
      ws.addEventListener("message", onMsg);
      ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
    });

  const r1 = JSON.parse(await call(OPEN_AND_SWITCH));
  console.log("\n== R2 面板：打开设置 + 逐 tab 切换 ==");
  console.log(JSON.stringify(r1, null, 1));

  // 断言
  const errs = [];
  const ok = (cond, name) => { if (!cond) errs.push(name); };
  ok(r1.navCount === 7 && r1.navDisabled.length === 0, "7 个 tab 全部可点（批次②增代理，10-10 增日志）");
  ok(r1.visibleOnOpen.length === 1 && r1.visibleOnOpen[0] === "st-tab-models", "打开默认在模型页（2026-10-12 开源 UI 审查改：原 ext 首开即拉全量社区目录）");
  ok(r1.skills.rows > 0 || r1.skills.empty, "skills 有内容或明确空态");
  ok((r1.skillsBadges ?? []).every(b => b === "用户级" || b === "项目级"), "skills 徽标合法");
  ok(r1.mcp.rows > 0 || r1.mcp.empty, "mcp 有内容或明确空态");
  ok(r1.mcpCounts.length === r1.mcp.rows, "mcp 每行有工具数");
  ok(r1.mcpOpenBtn, "打开 mcp.json 按钮存在");
  // B4（2026-10-07）：deferred server 呈现「按需」而非误导读 0/未挂载；direct 型照常计数
  const DEFERRED = ["cloudbase", "zai-vision", "playwright", "zread"];
  const DIRECT = ["web-search-prime", "web-reader"]; // zread 已改 deferred（2026-10-10 审计 P2：偶发用途省常驻声明）
  for (const nm of DEFERRED) {
    const row = (r1.mcpRows ?? []).find(x => x.name === nm);
    ok(row && row.count === "按需" && row.dot.includes("on-demand") && !row.disabled, `B4 deferred ${nm} 显示按需+中性点`);
  }
  for (const nm of DIRECT) {
    const row = (r1.mcpRows ?? []).find(x => x.name === nm);
    ok(row && /\d+ 工具|未挂载/.test(row.count) && row.count !== "按需", `B4 direct ${nm} 正常计数语义`);
  }
  ok(r1.modelsCount > 0, "models 有模型行");
  ok(r1.modelsCurrent !== null && r1.modelsCurBadge, "models 有当前高亮");
  ok((r1.modelsHeads ?? []).length >= 1, "models 有 provider 分组头");
  ok(r1.appearance.rows === 4, "appearance 四行设置（批次②增主题行）");
  ok(r1.appearanceChips.length === 10, "appearance 共 10 个选项 chip（批次②增宣纸/青瓷）");
  ok(r1.logs.visible.length === 1 && r1.logs.visible[0] === "st-tab-logs", "logs tab 切换可见");
  ok(r1.logs.rows >= 1, "logs 有状态行");
  ok(r1.logsText !== null && /无异常记录|异常/.test(r1.logsText), "logs 状态文案合法（无异常或异常记录）");
  ok((r1.logsActs ?? []).length >= 1, "logs 有动作按钮");

  const r2 = JSON.parse(await call(APPEAR_APPLY));
  console.log("\n== 外观生效 + 模型切换 + 关闭 ==");
  console.log(JSON.stringify(r2, null, 1));
  ok(r2.mdSizeAfterLarge === "15.5px", "字号「大」生效 --md-size=15.5px");
  ok(r2.colWAfterWide === "1080px", "列宽「宽」生效 --col-w=1080px");
  ok(r2.noAnim === true, "动效「减弱」生效 html.no-anim");
  ok(r2.persist.size === "large" && r2.persist.width === "wide" && r2.persist.motion === "reduced", "localStorage 持久化");
  ok(r2.restored.mdSize === "14px" && r2.restored.colW === "860px" && r2.restored.noAnim === false, "还原默认");
  ok(r2.closedAfter === true, "设置弹层可关闭");

  ws.close();
  if (errs.length) { console.error("\n❌ 断言失败:", errs); process.exit(1); }
  console.log("\n✅ R2 四面板验证全绿");
}

main().catch((e) => { console.error("验证脚本失败:", e.message, "\nSTACK:", e.stack); process.exit(1); });
