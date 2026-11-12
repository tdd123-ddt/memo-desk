/* 手机同步扩展 —— 扩展入口
 * 被 src/main.js 的扩展加载器 require 并 register(ctx)。
 * 扩展不改动备忘录原有的任何函数，只通过 ctx 暴露的少数几个动作接入。
 * 卸载方式：删除 extensions/sync 目录即可（加载器会自动跳过），原有功能完全不受影响。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const core = require('./sync-core');

/* 参与同步的字段。
   刻意**不包含** images / items / notified / streak / doneCount：
   - 图片不跨设备同步（手机端也不显示），PC 端的图片必须原样保留
   - 清单条目、提醒状态、连续打卡数属于 PC 端本地状态，不能被手机覆盖 */
const SYNC_FIELDS = ['title', 'body', 'due', 'tags', 'done', 'priority',
  'repeat', 'repeatDays', 'repeatDay'];

const PORT_FROM = 8733;
const PORT_TO = 8743;
const EXT_DIR = __dirname;

let ctx = null;
let server = null;
let port = 0;
let panelWin = null;
let running = false;
let lastSyncAt = 0;
let prevIds = new Set();      // 上一次见到的备忘 id 集合，用来发现"哪条被删了"
let cfg = { syncEnabled: false, syncToken: '', syncPairCode: '', syncPort: 0 };

/* ---------- 工具 ---------- */
function rand6() {
  return String(Math.floor(100000 + Math.random() * 900000));
}
function randToken() {
  return Array.from({ length: 4 }, () => Math.random().toString(36).slice(2, 10)).join('');
}
function lanAddresses() {
  const out = [];
  const ifs = os.networkInterfaces();
  Object.keys(ifs).forEach((k) => {
    (ifs[k] || []).forEach((i) => {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    });
  });
  return out;
}
/** Tailscale（虚拟局域网）地址：人在外面时，手机连上 Tailscale 用这个地址照样能同步 */
function tailscaleAddresses() {
  const out = [];
  const ifs = os.networkInterfaces();
  Object.keys(ifs).forEach((k) => {
    if (!/tailscale/i.test(k)) return;
    (ifs[k] || []).forEach((i) => {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    });
  });
  return out;
}
function html(name, repl) {
  let t = fs.readFileSync(path.join(EXT_DIR, name), 'utf-8');
  Object.keys(repl || {}).forEach((k) => {
    t = t.split(k).join(repl[k]);
  });
  return t;
}
function mobilePage() {
  const coreSrc = fs.readFileSync(path.join(EXT_DIR, 'sync-core.js'), 'utf-8');
  return html('mobile.html', { '/*__SYNC_CORE__*/': coreSrc });
}

/* ---------- 备忘文档 ⇄ 电脑数据 ---------- */
function toView(n) {
  const v = { id: n.id, title: n.title || '', body: n.body || '', due: n.due || '',
    tags: Array.isArray(n.tags) ? n.tags : [], done: !!n.done,
    priority: n.priority || 'mid', repeat: n.repeat || 'none',
    repeatDays: Array.isArray(n.repeatDays) ? n.repeatDays : [], repeatDay: n.repeatDay || 0,
    createdAt: n.createdAt || 0, updatedAt: n.updatedAt || 0 };
  return v;
}
function getDoc() {
  const d = ctx.readData();
  return {
    notes: (d.notes || []).map(toView),
    tombstones: Array.isArray(d.tombstones) ? d.tombstones : [],
  };
}
/** 把合并结果写回电脑数据：已存在的只覆盖同步字段，本地字段一律保留 */
function setDoc(doc) {
  const data = ctx.readData();
  const byId = new Map((data.notes || []).map((n) => [n.id, n]));
  const out = [];
  (doc.notes || []).forEach((v) => {
    const cur = byId.get(v.id);
    if (cur) {
      SYNC_FIELDS.forEach((f) => { if (v[f] !== undefined) cur[f] = v[f]; });
      if (v.createdAt) cur.createdAt = v.createdAt;
      cur.updatedAt = v.updatedAt || cur.updatedAt;
      out.push(cur);
    } else {
      const n = { images: [], items: [], notified: false, streak: 0, doneCount: 0 };
      ['id', 'createdAt', 'updatedAt'].forEach((f) => { n[f] = v[f] || Date.now(); });
      SYNC_FIELDS.forEach((f) => { n[f] = v[f] !== undefined ? v[f] : ''; });
      n.tags = Array.isArray(v.tags) ? v.tags : [];
      n.repeatDays = Array.isArray(v.repeatDays) ? v.repeatDays : [];
      out.push(n);
    }
  });
  data.notes = out;
  data.tombstones = doc.tombstones || [];
  ctx.writeData(data);
  prevIds = new Set(out.map((n) => n.id));
  ctx.notifyDataChanged();
}
/** 记一条墓碑：备忘被删了不能只是消失，否则下次同步时另一端又把它当新增推回来 */
function addTombstone(data, id, at) {
  if (!Array.isArray(data.tombstones)) data.tombstones = [];
  data.tombstones = data.tombstones.filter((t) => t.id !== id);
  data.tombstones.push({ id: id, at: at || Date.now() });
}

/* ---------- HTTP ---------- */
function readJson(req, cb) {
  let raw = '';
  let tooBig = false;
  req.on('data', (c) => {
    raw += c;
    if (raw.length > 8 * 1024 * 1024) { tooBig = true; req.destroy(); }
  });
  req.on('end', () => {
    if (tooBig) return cb(null);
    try { cb(raw ? JSON.parse(raw) : {}); } catch (e) { cb(null); }
  });
  req.on('error', () => cb(null));
}
function send(res, code, obj, type) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
function authed(req, url) {
  const t = req.headers['x-memo-token'] || url.searchParams.get('token') || '';
  return cfg.syncToken && t === cfg.syncToken;
}

function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p === '/' || p === '/index.html') {
    return send(res, 200, mobilePage(), 'text/html; charset=utf-8');
  }
  if (p === '/manifest.webmanifest') {
    // Web App 清单：安卓/鸿蒙浏览器据此提供「安装到桌面」，含分享目标
    return send(res, 200, {
      name: '备忘录',
      short_name: '备忘录',
      description: '与电脑同步的桌面备忘录',
      lang: 'zh-CN',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      orientation: 'portrait',
      background_color: '#f7f6f3',
      theme_color: '#4a7c59',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
      share_target: {
        action: '/api/share',
        method: 'GET',
        params: { title: 'title', text: 'text' },
      },
    }, 'application/manifest+json; charset=utf-8');
  }
  if (p === '/icon-192.png' || p === '/icon-512.png' || p === '/icon-maskable-512.png') {
    const buf = fs.readFileSync(path.join(EXT_DIR, p));
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=3600' });
    return res.end(buf);
  }
  if (p === '/api/share') {
    // PWA 分享目标：在任何 App 里「分享 → 备忘录」，文字直接变成一条新备忘
    const token = url.searchParams.get('token') || (req.headers['x-memo-token'] || '');
    if (!authed(req, url)) {
      // 没配对过就先落回主页让用户配对
      res.writeHead(302, { Location: '/' });
      return res.end();
    }
    const title = (url.searchParams.get('title') || '').trim();
    const text = (url.searchParams.get('text') || '').trim();
    const body = (title + (text ? '\n' + text : '')).trim();
    const now = Date.now();
    const n = {
      id: core.newId(), title: title || body.split('\n')[0] || '（分享）',
      body: body, due: '', tags: [], done: false, priority: 'mid',
      repeat: 'none', repeatDays: [], repeatDay: 0,
      createdAt: now, updatedAt: now,
    };
    const merged = core.mergeDocs(getDoc(), { notes: [toView(n)], tombstones: [] });
    setDoc(merged.doc);
    lastSyncAt = now;
    ctx.dbg('share-target: + ' + n.title);
    res.writeHead(302, { Location: '/?added=1' });
    return res.end();
  }
  if (p === '/panel') {
    return send(res, 200, html('panel.html', { __PORT__: String(port) }), 'text/html; charset=utf-8');
  }
  if (p === '/api/hello') return send(res, 200, { ok: true, name: 'memo-desk' });
  if (p === '/api/state') {
    return send(res, 200, {
      ok: true, port: port, addresses: lanAddresses(),
      tailscale: tailscaleAddresses(),
      pairCode: cfg.syncPairCode, notes: (ctx.readData().notes || []).length,
      lastSyncAt: lastSyncAt ? new Date(lastSyncAt).toLocaleString('zh-CN') : '',
    });
  }
  if (p === '/api/pair' && req.method === 'POST') {
    return readJson(req, (j) => {
      if (!j || String(j.code || '').trim() !== String(cfg.syncPairCode || '').trim()) {
        return send(res, 401, { error: '配对码不对' });
      }
      send(res, 200, { token: cfg.syncToken });
    });
  }
  if (p === '/api/regen-code' && req.method === 'POST') {
    cfg.syncPairCode = rand6();
    ctx.persistSettings({ syncPairCode: cfg.syncPairCode });
    return send(res, 200, { pairCode: cfg.syncPairCode });
  }
  if (p === '/api/firewall' && req.method === 'POST') {
    const ok = openFirewall();
    return send(res, 200, { ok: ok, msg: ok ? '请在弹窗中点「是」' : '请手动运行 ' + batPath() });
  }
  if (p === '/api/stop' && req.method === 'POST') {
    send(res, 200, { ok: true });
    setTimeout(stop, 60);
    return;
  }

  if (p === '/api/doc' || p === '/api/sync') {
    if (!authed(req, url)) return send(res, 401, { error: '未配对' });
    if (req.method === 'GET') return send(res, 200, { doc: getDoc() });
    return readJson(req, (incoming) => {
      if (!incoming) return send(res, 400, { error: '请求格式不对' });
      let merged;
      try {
        merged = core.mergeDocs(getDoc(), incoming);
      } catch (e) {
        return send(res, 500, { error: String((e && e.message) || e) });
      }
      setDoc(merged.doc);
      lastSyncAt = Date.now();
      ctx.dbg('sync: ' + JSON.stringify(merged.stats));
      send(res, 200, { doc: merged.doc, stats: merged.stats });
    });
  }

  send(res, 404, { error: 'not found' });
}

/* ---------- 防火墙 ----------
   不放行的话，iPhone 可能连不上。这里不直接调用 netsh/reg（某些终端安全策略会拦截，
   甚至连带把发起调用的进程一起结束掉），改为：写好一个 .bat，
   用一个**脱离本进程**的方式请求管理员权限运行，即使被拦截也不会牵连备忘录本身。 */
function batPath() {
  return path.join(ctx.userDataDir(), 'memo-sync-放行防火墙.bat');
}
function openFirewall() {
  try {
    const bat = batPath();
    fs.writeFileSync(bat,
      '@echo off\r\n'
      + `netsh advfirewall firewall delete rule name="memo-desk 手机同步" >nul 2>&1\r\n`
      + `netsh advfirewall firewall add rule name="memo-desk 手机同步" dir=in action=allow protocol=TCP localport=${port}\r\n`
      + 'echo 已放行，按任意键关闭\r\npause >nul\r\n', 'utf-8');
    const ps = spawn('powershell', ['-NoProfile', '-Command',
      `Start-Process -FilePath "${bat}" -Verb RunAs`],
      { detached: true, stdio: 'ignore', windowsHide: true });
    ps.unref();
    return true;
  } catch (e) {
    ctx.dbg('firewall error: ' + (e && e.message || e));
    return false;
  }
}

/* ---------- 启停 ---------- */
function start() {
  if (running) return { ok: true, port: port };
  return new Promise((resolve) => {
    let i = PORT_FROM;
    const tryPort = () => {
      if (i > PORT_TO) { resolve({ ok: false, port: 0 }); return; }
      const s = http.createServer(handle);
      s.on('error', () => { i++; tryPort(); });
      s.listen(i, '0.0.0.0', () => {
        server = s; port = i; running = true;
        cfg.syncPort = i;
        ctx.persistSettings({ syncPort: i });
        ctx.dbg('sync server on ' + i);
        resolve({ ok: true, port: i });
      });
    };
    tryPort();
  });
}
function stop() {
  if (server) { try { server.close(); } catch (e) {} }
  server = null; running = false; port = 0;
  ctx.persistSettings({ syncEnabled: false });
  cfg.syncEnabled = false;
  if (panelWin && !panelWin.isDestroyed()) panelWin.close();
  panelWin = null;
  ctx.refreshTray();
}

/* ---------- 面板窗口 ---------- */
function openPanel() {
  const { BrowserWindow } = require('electron');
  if (panelWin && !panelWin.isDestroyed()) { panelWin.focus(); return; }
  panelWin = new BrowserWindow({
    width: 470, height: 700, minWidth: 400,
    title: '手机同步',
    backgroundColor: '#f7f6f3',
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  panelWin.on('closed', () => { panelWin = null; });
  panelWin.loadURL(`http://127.0.0.1:${port}/panel`);
}

/* ---------- 扩展接口 ---------- */
module.exports = {
  id: 'sync',

  register(c) {
    ctx = c;
    const s = ctx.readData().settings || {};
    // 没有明确关过（settings 里没有这个键）就默认开启，用户装好扩展重启后即可直接连手机
    cfg.syncEnabled = s.syncEnabled === undefined ? true : !!s.syncEnabled;
    cfg.syncToken = s.syncToken || '';
    cfg.syncPairCode = s.syncPairCode || '';
    if (!cfg.syncToken) { cfg.syncToken = randToken(); ctx.persistSettings({ syncToken: cfg.syncToken }); }
    if (!cfg.syncPairCode) { cfg.syncPairCode = rand6(); ctx.persistSettings({ syncPairCode: cfg.syncPairCode }); }
    const d = ctx.readData();
    prevIds = new Set((d.notes || []).map((n) => n.id));
    if (cfg.syncEnabled) {
      start().then((r) => { if (!r.ok) ctx.dbg('sync: 端口都被占用，没起来'); });
    }
    // 调试入口：--sync-panel 启动即开启并弹出连接信息面板（和 --test-min 等参数一个路子）
    if (process.argv.includes('--sync-panel')) {
      start().then((r) => { if (r.ok) setTimeout(openPanel, 1500); });
    }
  },

  /** 数据被保存后：找出消失的备忘，补墓碑（这样删除才能同步到手机） */
  onSave(data, commit) {
    if (!ctx) return;
    const cur = new Set((data.notes || []).map((n) => n.id));
    const curArr = (data.notes || []);
    let changed = false;
    prevIds.forEach((id) => {
      if (!cur.has(id)) { addTombstone(data, id); changed = true; }
    });
    // 首次运行时 prevIds 为空，别把已有数据误判成删除
    prevIds = cur;
    if (changed) commit(data);
  },

  /** 托盘菜单项（由主进程拼接进菜单） */
  menuItems() {
    const label = running ? `手机同步（已开启 :${port}）` : '手机同步（未开启）';
    return [
      { label: label, enabled: false },
      {
        label: running ? '显示连接信息' : '开启手机同步',
        click: async () => {
          if (running) { openPanel(); return; }
          const r = await start();
          if (!r.ok) { ctx.dbg('sync: 启动失败'); return; }
          cfg.syncEnabled = true;
          ctx.persistSettings({ syncEnabled: true });
          ctx.refreshTray();
          openPanel();
        },
      },
      {
        label: '停止手机同步',
        visible: running,
        click: () => stop(),
      },
      { type: 'separator' },
    ];
  },

  /* 供离线自测直接调用（不经过 Electron 窗口）：node _dev/sync_test.js */
  _start: start,
  _stop: stop,
};
