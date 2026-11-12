const { app, BrowserWindow, screen, ipcMain, Tray, Menu, Notification, shell, protocol, clipboard, globalShortcut, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { execFile } = require('child_process');

const PANEL_WIDTH = 380;   // 侧边模式展开宽度
const FLOAT_W = 320;       // 小浮窗默认尺寸
const FLOAT_H = 430;
const FLOAT_MINI = 58;     // 小浮窗收起后的气泡尺寸
const EDGE_SIZE = { right: 10, top: 48, float: FLOAT_MINI };  // 仅 float 收起后的气泡尺寸（right/top 已改为完全推出屏幕外）
/* 「点击唤出」模式用的独立小把手：做成单独一个极小的无边框窗口，
   主窗口仍然整体推出屏幕，不用为了露一条边而逐帧 resize（软件渲染下会拖黑条）。 */
const HANDLE_SHORT = 8;    // 厚度：贴边只占 8 DIP，几乎不挡桌面
const HANDLE_LONG = 84;    // 长度
const ANIM_IN = 380;       // 滑出时长（ms）
const ANIM_OUT = 260;      // 收回时长

/* 贴边感应的手感参数（单位：DIP） */
/* 贴边唤出的触发区宽度（用户可在托盘「贴边灵敏度」里换挡，不用改代码）。
   默认 precis 档：几乎要把鼠标压到屏幕边缘才弹。
   早先 hover=56 / wide=150 太宽，鼠标只是在屏幕右侧逛一圈就弹出来，很烦手；
   现在热区只有 10px，宽松带缩到 40px 且要停留 1.5 秒才弹，等于只留一道保险。 */
const SENS_LEVELS = {
  precise: { label: '精确（几乎贴到边才弹）', hover: 10, top: 8, wide: 40, topWide: 34, warm: 1500, force: 1000 },
  normal: { label: '适中', hover: 24, top: 20, wide: 80, topWide: 70, warm: 1000, force: 900 },
  loose: { label: '宽松（离边一段距离就弹）', hover: 56, top: 48, wide: 150, topWide: 130, warm: 800, force: 900 },
};
let edgeSens = 'precise';
let SENS = SENS_LEVELS[edgeSens];
function setEdgeSens(key) {
  if (!SENS_LEVELS[key]) return;
  edgeSens = key;
  SENS = SENS_LEVELS[key];
  persistSettings({ edgeSens: key });
}
const HOVER_CONFIRM = 2;   // 连续检测到几次才弹（×80ms ≈ 160ms），避免"路过"误触
const LEAVE_PAD = 34;      // 展开时，鼠标要离窗口边缘这么远才算真的移开了
const LEAVE_DELAY = 400;   // 判定移开后再等这么久才收回（+0.26s 动画 ≈ 0.7s 完全消失）
const BOOT_GRACE = 5000;   // 刚启动的这段时间不自动收起
const POLL_MS = 80;        // 轮询间隔

/* 三种窗口位置 */
const MODES = [
  { key: 'right', label: '右侧贴边' },
  { key: 'top', label: '顶部贴边' },
  { key: 'float', label: '小浮窗（可拖动）' },
];

/* ---------- 数据目录：优先放在程序自己的文件夹 ----------
 * 2026-11-02 真机故障：%APPDATA%\memo-desk 对 electron 进程报"拒绝访问(0x5)"。
 * 连锁后果（三个用户可见的毛病其实是同一条链）：
 *   ① 单实例锁建不出来 -> 每次双击都开新实例 -> 多份内存数据互相覆盖 = 删除不保存
 *   ② memo-icon.png 写不出来 -> 托盘图标创建失败 = 点减号后托盘里找不到
 *   ③ memo-data.json / debug.log 写不出来 -> 界面改了、磁盘没变、日志全空
 * 而程序目录本身 100% 可写（--enable-logging 的日志就写在这里）。
 * 把 userData 整体挪到程序目录下的 memo-userdata/，一次性避开上面全部问题。
 *
 * - 首次切换会把旧数据（笔记 / 图片 / 备份）**复制**过来，只复制不删除，绝不丢数据
 * - 程序目录也不可写（例如解压到 Program Files）时自动退回系统默认目录
 * - 命令行显式给了 --user-data-dir（自测用）时完全不干预，保持 54 项断言行为不变
 */
function chooseUserDataDir() {
  const sysDefault = app.getPath('userData');
  if (process.argv.some((a) => a.startsWith('--user-data-dir'))) return sysDefault;
  const local = path.join(app.getAppPath(), 'memo-userdata');
  try {
    fs.mkdirSync(local, { recursive: true });
    // 探测只用"写"，**绝不删除**：部分机器的安全策略会拦删除操作，
    // 用"写+删"探测会误判成目录不可写，反而把数据搬回坏掉的旧目录。
    fs.writeFileSync(path.join(local, '.write-probe'), String(Date.now()));
  } catch (e) { return sysDefault; }          // 程序目录不可写 -> 用原来的
  try {
    if (fs.existsSync(sysDefault)) {
      for (const name of fs.readdirSync(sysDefault)) {
        // 只搬数据，不搬 Chromium 的 Cache / Code Cache / GPUCache 等缓存目录
        if (name !== 'memo-data.json' && !name.startsWith('memo-data.json.')
            && name !== 'images' && name !== 'memo-icon.png') continue;
        const src = path.join(sysDefault, name);
        const dst = path.join(local, name);
        if (fs.existsSync(dst)) continue;     // 已有本地数据，绝不覆盖
        const st = fs.statSync(src);
        if (st.isDirectory()) fs.cpSync(src, dst, { recursive: true });
        else fs.copyFileSync(src, dst);
      }
    }
  } catch (e) { /* 迁移失败不阻塞启动 */ }
  return local;
}
const USER_DATA_DIR = chooseUserDataDir();
if (USER_DATA_DIR !== app.getPath('userData')) app.setPath('userData', USER_DATA_DIR);

const DATA_FILE = () => path.join(app.getPath('userData'), 'memo-data.json');
const ICON_FILE = () => path.join(app.getPath('userData'), 'memo-icon.png');
const IMAGES_DIR = () => path.join(app.getPath('userData'), 'images');

/* ===================== 扩展机制（EXT HOOK） =====================
   扩展放在 extensions/<名字>/ 下，每个目录一个 main.js，导出 { id, register, menuItems, onSave }。
   扩展只能通过下面 ctx 里的这几个动作影响主程序，碰不到任何原有函数的内部，
   所以**删掉整个扩展目录就等于干净卸载**，原有功能不受一丝影响。 */
const EXT_DIR = path.join(__dirname, '..', 'extensions');
const extModules = [];

function extCtx() {
  return {
    app,
    userDataDir: () => app.getPath('userData'),
    readData,
    writeData,
    persistSettings,
    refreshTray: () => refreshTrayMenu(),
    notifyDataChanged: () => {
      if (win && !win.isDestroyed()) win.webContents.send('ext-data-changed');
    },
    dbg,
  };
}

function loadExtensions() {
  try {
    if (!fs.existsSync(EXT_DIR)) return;
    fs.readdirSync(EXT_DIR, { withFileTypes: true }).forEach((e) => {
      if (!e.isDirectory()) return;
      const entry = path.join(EXT_DIR, e.name, 'main.js');
      if (!fs.existsSync(entry)) return;
      try {
        const m = require(entry);
        if (m && typeof m.register === 'function') { m.register(extCtx()); extModules.push(m); }
      } catch (err) {
        console.error('[memo] ext load error:', err && err.message || err);
      }
    });
  } catch (e) { /* 扩展加载失败绝不影响主程序本身 */ }
}

/** 各扩展想加进托盘的菜单项，拼成一整段 */
function extMenuItems() {
  let out = [];
  extModules.forEach((m) => {
    try { if (typeof m.menuItems === 'function') out = out.concat(m.menuItems() || []); }
    catch (e) { /* 单个扩展出错不影响别的菜单项 */ }
  });
  return out;
}

/** 数据保存后通知扩展：扩展据此补墓碑，这样"删除"也能同步到手机 */
function extOnSave(data) {
  extModules.forEach((m) => {
    try { if (typeof m.onSave === 'function') m.onSave(data, (d) => writeData(d)); }
    catch (e) { /* ignore */ }
  });
}
/* =================== /EXT HOOK =================== */

// 兼容性：部分机器 / 远程会话下 GPU 进程会崩溃导致白屏，这里禁用硬件加速
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');

/*
 * 关掉 Chromium 对隐藏 / 最小化窗口的三条节流路径。
 *
 * 为什么必须关：窗口一旦隐藏或最小化，Chromium 会逐步放缓页面定时器，
 * 久了甚至直接冻结（freeze）整个页面 —— JS 完全停摆。
 * 于是用户点托盘把窗口叫回来，看到的是"窗口出来了，但点什么都没反应"，
 * 而这期间我们的心跳也被冻住，主进程以为是页面死了，跟着一顿乱救。
 *
 * 三个开关各管一段：
 *   disable-background-timer-throttling   —— 不降低后台定时器频率
 *   disable-backgrounding-occluded-windows —— 窗口被遮挡时也不转入后台
 *   disable-renderer-backgrounding         —— 渲染进程不进入后台模式（最根本的一条）
 *
 * 代价是隐藏时仍占用一点资源，对一个常驻的便签小工具来说完全值得。
 */
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
// 上面三个在新版 Chromium 里只覆盖了一半路径，剩下这两条才是"窗口一被遮挡就当它不可见"的元凶：
//   CalculateNativeWinOcclusion —— 计算窗口是否被别的窗口盖住，被盖住就降频/冻结渲染。
//                                  我们的面板贴边、常被别的窗口压住，正好踩中。
//   IntensiveWakeUpThrottling   —— 被冻结后的"重度唤醒节流"，会让页面迟迟不恢复。
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,IntensiveWakeUpThrottling');

process.on('uncaughtException', (err) => console.error('[memo] uncaught:', err && err.stack || err));
process.on('unhandledRejection', (err) => console.error('[memo] unhandledRejection:', err && err.stack || err));

let win = null;
let tray = null;
let isCollapsed = false;
let isPinned = false;      // 图钉锁定：锁定后鼠标移开也不收起
let collapseTimer = null;
let dockMode = 'right';    // right | top | float
let wakeMode = 'hover';    // hover=鼠标划边自动摊开 | handle=边缘细把手，点击才展开
let handleWin = null;      // 「点击唤出」模式下那个独立的小把手窗口
let panelSizes = null;     // 手动调整过的展开尺寸，按贴边模式分别记 { right:{w,h}, top:{...}, float:{...} }
let floatBounds = null;    // 小浮窗记住的位置/尺寸
let animTimer = null;      // 补间动画
let animWatch = null;      // 补间动画的看门狗：动画万一没走到终点，超时强制收尾
let animStartedAt = 0;     // 动画开始时刻：看门狗据此判断"这个动画早该结束了"
let lastHoverTick = 0;     // 贴边轮询最后一次真正跑起来的时刻
let lastWatchdogTick = 0;  // watchdog 最后一次真正跑起来的时刻（两者互相监督）
let watchdogStartedAt = 0; // watchdog 最近一次被启动的时刻：用来给"停摆判定"加冷却期
let lastStateDumpAt = 0;   // 状态快照上次落盘时刻
let fadeTimer = null;      // 模式切换的淡入
let hoverTimer = null;     // 鼠标靠近边缘的检测轮询
let floatSaveTimer = null;
let resizeSaveTimer = null;
let hoverBlockUntil = 0;   // 收回后的冷却期：这段时间内不响应"贴边弹出"，避免反复横跳
let hoverArmed = true;     // 边沿触发标记：弹过一次后，鼠标必须先离开贴边区才允许再弹
let detailOpen = false;    // 详情面板打开时不做自动收起
let userHidden = false;    // 用户点了"最小化"：窗口真的隐藏，只有托盘能叫回来
let lastShowAt = 0;        // showWindow 的时刻：挡住恢复瞬间补发到按钮上的"幽灵点击"
let repaintTimer = null;   // 恢复显示后的强制重绘计时器（透明窗口 DWM 旧帧问题）

/* =========================================================================
   唯一的期望状态 + 持续收敛机制（2026-10-31 架构级修复）
   ---------------------------------------------------------------------
   为什么会有这次重构：之前"卡死"反复复发，我连修三轮，每轮修完又冒出新的。
   根子不在任何一个具体 bug，而在架构：

     窗口的显示 / 隐藏，靠一堆内部标志位（isCollapsed / userHidden /
     detailOpen / keepOpenUntil / hoverArmed / hoverBlockUntil / flapGuardUntil）
     **记忆** 出来。但窗口的真实状态由 Windows 窗口管理器掌控。
     只要发生任何程序没预料到的事 —— 系统休眠唤醒、Win+D 显示桌面、
     锁屏解锁、拔插显示器、虚拟桌面切换、DWM 重启 ——
     「记忆」和「真相」就会分叉；而分叉之后没有任何机制能把它们重新合上，
     因为后续所有决策都基于那个已经错了的标志位。
     于是修掉一种分叉，下一种又冒出来，永远修不完。

   现在的做法（把「记住状态」换成「持续校对」）：
     · panelWanted  = 唯一期望（用户想不想在屏幕上看到面板）
     · isEffectivelyHidden() = 每次决策前现场读窗口真相
     · enforceVisibleNow()   = 幂等收敛，无条件把窗口推到目标态
     · 守卫每 90ms 校对一次  = 任何分叉最多 90ms 内自动合拢

   标志位从此只表达"意图"，不再充当真相。
   ========================================================================= */
let panelWanted = true;    // 期望：窗口是否应该出现在屏幕上（展开态 / 收起条都算"要"）
let guardFailStreak = 0;   // 可见性守卫连续纠正失败的累计次数：够多就重建窗口
let lastHardRebuildAt = 0; // 上次销毁重建的时刻：给重建加冷却，避免救不回来时每 90ms 重建一次
let keepOpenUntil = 0;     // 手动唤出后的宽限期：这段时间内不自动收回（鼠标还没移到窗口上）
let flapGuardUntil = 0;    // 抖动刹车：短时间内反复弹出/收回就冻结自动行为
let blockSince = 0;        // 展开态被"临时状态位"（详情页/宽限期/刹车）挡住不收起的起始时间
let lastToggleAt = 0;
let lastToggleMouse = null;  // 上一次弹/收时的鼠标位置，用来区分"用户操作"和"程序空转"
let toggleStreak = 0;
const BOOT_AT = Date.now();
const DIAG = process.argv.includes('--diag');   // --diag：轮询里打详细状态，排查唤不出来时用
let lastDiagAt = 0;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* ---------- 生成一个简易托盘图标（32x32 PNG，蓝底 + 白色便签线条） ---------- */
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function makeIconPng() {
  const S = 32;
  const px = Buffer.alloc(S * S * 4, 0); // RGBA，全透明
  const set = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const i = (y * S + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  };
  // 圆角矩形便签底
  const BG = [59, 110, 246];
  for (let y = 2; y < 30; y++) {
    for (let x = 4; x < 28; x++) {
      const corner =
        (x < 7 && y < 7 && (7 - x) + (7 - y) > 4) ||
        (x > 24 && y < 7 && (x - 24) + (7 - y) > 4) ||
        (x < 7 && y > 24 && (7 - x) + (y - 24) > 4) ||
        (x > 24 && y > 24 && (x - 24) + (y - 24) > 4);
      if (corner) continue;
      set(x, y, BG[0], BG[1], BG[2], 255);
    }
  }
  // 三条白色横线
  for (const lineY of [11, 16, 21]) {
    for (let x = 9; x < 23; x++) set(x, lineY, 255, 255, 255, 245);
  }
  // 组装 PNG
  const raw = Buffer.alloc(S * (S * 4 + 1));
  for (let y = 0; y < S; y++) {
    raw[y * (S * 4 + 1)] = 0;
    px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- 窗口 ---------- */
function workArea() {
  // 和 pointerDip() 用同一套解析结果，保证"窗口所在的屏"和"唤出判定用的屏"永远一致
  const m = pointerDip();
  if (m && m.wa) return m.wa;
  return screen.getPrimaryDisplay().workArea;
}

/* ---------- 各模式的展开 / 收起尺寸 ---------- */
/** 用户手动拖出来的尺寸（按模式分开记，切模式后各用各的） */
function savedSize(mode) {
  const s = panelSizes && panelSizes[mode];
  if (!s || typeof s.w !== 'number' || typeof s.h !== 'number') return null;
  return { w: clamp(Math.round(s.w), 240, 1600), h: clamp(Math.round(s.h), 180, 1400) };
}

function expandedBounds(mode) {
  const wa = workArea();
  if (mode === 'top') {
    // 顶部面板做成紧凑的下拉条：太大会把半个屏幕都挡住（用户反馈"界面太大"）
    const sz = savedSize('top');
    const w = sz ? Math.min(sz.w, wa.width - 40) : Math.min(680, wa.width - 240);
    const h = sz ? Math.min(sz.h, wa.height - 40) : clamp(Math.round(wa.height * 0.3), 260, 380);
    // 注意：这里的 y 必须和 collapsedBounds('top') 的可见边界对齐，避免鼠标被挤出引发跳动
    return { x: wa.x + Math.round((wa.width - w) / 2), y: wa.y, width: w, height: h };
  }
  if (mode === 'float') {
    const fb = floatBounds || {};
    const sz = savedSize('float');
    const w = clamp(sz ? sz.w : (fb.width || FLOAT_W), 240, 900);
    const h = clamp(sz ? sz.h : (fb.height || FLOAT_H), 220, 900);
    const x = clamp(typeof fb.x === 'number' ? fb.x : wa.x + wa.width - w - 60,
      wa.x - 60, Math.max(wa.x - 60, wa.x + wa.width - w + 60));
    const y = clamp(typeof fb.y === 'number' ? fb.y : wa.y + 96,
      wa.y, Math.max(wa.y, wa.y + wa.height - h));
    return { x, y, width: w, height: h };
  }
  const sz = savedSize('right');
  const w = sz ? Math.min(sz.w, wa.width - 40) : PANEL_WIDTH;
  const h = sz ? Math.min(sz.h, wa.height - 40) : Math.min(Math.max(420, wa.height - 80), wa.height);
  return { x: wa.x + wa.width - w - 8, y: wa.y + 40, width: w, height: h };
}

function collapsedBounds(mode, exp) {
  const wa = workArea();
  if (mode === 'top') {
    // 整窗推到屏幕上方之外，底边正好贴住屏幕顶 —— 收起后一点都看不到，不占屏幕。
    // 实测 Windows 允许窗口完全移出屏幕（负 y 没问题），弹出/收回仍是纯平移、零缩放。
    return { x: exp.x, y: wa.y - exp.height, width: exp.width, height: exp.height };
  }
  if (mode === 'float') {
    const m = FLOAT_MINI;
    return { x: exp.x + exp.width - m, y: exp.y, width: m, height: m };
  }
  // 收起时**不改窗口尺寸**，只把它整体推到屏幕右缘之外 —— 屏幕上完全看不到。
  // 不改尺寸是因为软件渲染下逐帧 resize 会拖黑条；只平移就没这个问题。
  // 弹出靠主进程轮询鼠标位置（鼠标贴近右缘 26px 内就滑出），不依赖露出来的边条。
  return { x: wa.x + wa.width, y: exp.y, width: exp.width, height: exp.height };
}

function createWindow() {
  if (process.platform === 'win32') app.setAppUserModelId('com.memo.desk');

  const settings = readData().settings || {};
  const theme = settings.theme || 'glass';
  const exp = expandedBounds(dockMode);

  win = new BrowserWindow({
    width: exp.width,
    height: exp.height,
    x: exp.x,
    y: exp.y,
    frame: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    /* 2026-11-09 分层实验定位的灰屏/假界面真根因，勿改回：
     * ① 元凶是 win.setOpacity()：在分层(layered)透明窗口上反复改 alpha，
     *    DWM 会停在同一张合成表面。实测 CDP 把 body 刷成纯红并回读到
     *    rgb(255,0,0)，屏幕画面纹丝不动（红色像素 0%）；删掉所有 setOpacity
     *    后立刻 99.3% 变红。之前每 180ms 一次的「强制重绘」补丁就是这么把
     *    画面钉死在旧帧上的 —— 用户报的「灰色、点不动、只能弹入弹出」即此：
     *    位置由主进程 bounds 动画驱动（会动），内容永远是那张旧位图。
     * ② 透明窗口即使修好刷新，半透明 CSS 叠在透明底上仍是灰蒙蒙一片
     *    （基线平均 RGB 150），不透明窗口是干净的 246。
     * 所以这里统一用**不透明窗口**：底色跟主题走，页面自己画半透明层即可，
     * 不再依赖 Windows 的 acrylic / 分层合成。小浮窗气泡的圆角由 CSS 同色底补齐。 */
    transparent: false,
    backgroundColor: theme === 'ink' ? '#12161f' : '#ffffff',
    backgroundMaterial: undefined,
    hasShadow: true,
    icon: ICON_FILE(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  const q = [];
  if (process.argv.includes('--show-detail')) q.push('detail=0');
  if (process.argv.includes('--show-new')) q.push('new=1');
  if (process.argv.includes('--show-pop')) q.push('pop=1');
  if (process.argv.includes('--selftest')) q.push('selftest=1');
  if (process.argv.includes('--show-dock')) q.push('dock=1');
  const dockArg = process.argv.find((a) => a.startsWith('--dock='));
  if (dockArg) q.push('dock=' + dockArg.split('=')[1]);
  const search = q.length ? '?' + q.join('&') : '';
  // 页面重新加载 = 详情页肯定已经关了、动画也都没了。主进程这些状态位必须跟着复位：
  // 之前切主题 / 看门狗重建窗口时没复位，detailOpen 会一直卡在 true，
  // 于是"鼠标移开也不收起"——用户看到的就是整个面板赖在屏幕上不动，像卡死了。
  detailOpen = false;
  keepOpenUntil = 0;
  flapGuardUntil = 0;
  hoverArmed = true;
  pingFailStreak = 0;
  lastHeartbeat = 0;
  blockSince = 0;
  // 页面加载完成之前先别让守卫插手：那时窗口本来就还没到该显示的时候，
  // 否则它会在白屏阶段就把窗口推出来，看着像闪一下。
  panelWanted = false;
  stopAnim();
  if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; }
  win.loadFile(path.join(__dirname, 'index.html'), search ? { search } : undefined);

  win.webContents.on('render-process-gone', (e, d) => console.error('[memo] renderer gone:', JSON.stringify(d)));
  win.webContents.on('did-fail-load', (e, code, desc) => console.error('[memo] load fail:', code, desc));
  win.webContents.on('did-finish-load', () => {
    console.log('[memo] page loaded');
    // 每次加载完都重申一遍：别节流这个页面。
    // webPreferences 里那个 backgroundThrottling:false 是**创建期**选项，
    // reload / 重建窗口之后需要重新声明一次才稳，否则隐藏再回来就是"看得见、点不动"。
    try { win.webContents.setBackgroundThrottling(false); } catch (e) {}
  });

  // 软件渲染下 ready-to-show 可能不触发，用 did-finish-load 显示并加兜底
  const showOnce = () => {
    // 窗口被用户最小化期间页面若被 reload，这个兜底绝不能把窗口又弹出来 ——
    // 用户看到的就是"我明明最小化了，它自己又冒出来了"，非常困惑。
    if (userHidden) return;
    if (win && !win.isDestroyed()) {
      if (!win.isVisible()) {
        win.show();
        panelWanted = true;             // 页面已经就绪，守卫从此开始兜底
      }
      // 切悬挂模式会 app.relaunch()：新进程首次显示是最容易留下"旧帧"的一刻，
      // 以前这里没有任何收敛动作，正是"切横竖之后还是卡死"的缺口。
      setTimeout(() => { if (!app.isQuitting) settleWindow('首次显示'); }, 120);
    }
  };
  win.webContents.once('did-finish-load', showOnce);
  setTimeout(showOnce, 3000);

  // Windows 对窗口有最小宽度限制（DWM 边框），不显式清掉的话收起后会留下一条偏宽的边
  try { win.setMinimumSize(0, 0); } catch (e) {}

  // 小浮窗：拖到哪儿记到哪儿
  const rememberFloat = () => {
    if (dockMode !== 'float' || animTimer) return;
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    if (isCollapsed) {
      // 收起态是 58×58 的小气泡。用户直接拖这枚气泡时，必须把气泡坐标换算回
      // 「展开窗口应该在的位置」，否则一点展开它又跳回老地方（用户反馈的直接原因）。
      // collapsedBounds('float') = { x: exp.x + exp.width - FLOAT_MINI, y: exp.y }
      const sz = savedSize('float');
      const w = sz ? sz.w : ((floatBounds && floatBounds.width) || FLOAT_W);
      const h = sz ? sz.h : ((floatBounds && floatBounds.height) || FLOAT_H);
      // 用气泡的**实测**宽度换算：Windows 会把 58 DIP 的窗口落成 59 像素，
      // 写死 FLOAT_MINI 会每次差 1px，拖一次就漂一点。
      floatBounds = { x: b.x - (w - b.width), y: b.y, width: w, height: h };
    } else {
      floatBounds = b;
    }
    clearTimeout(floatSaveTimer);
    floatSaveTimer = setTimeout(() => persistSettings({ floatBounds }), 600);
  };
  win.on('move', rememberFloat);
  win.on('resize', rememberFloat);

  // 失焦不自动隐藏（否则一点桌面就消失，体验差），只有鼠标移开才收起
  win.on('closed', () => { win = null; });

  /**
   * 系统级最小化：Win+D「显示桌面」、任务栏点最小化都会把窗口真正最小化
   * （minimizable:false 只挡住窗口自己的最小化按钮，挡不住 Win+D）。
   * 最小化期间窗口不参与合成，鼠标划边、贴边轮询都不该再驱动它；
   * 恢复时再统一复位 —— 否则状态机一直按"窗口展开着"跑，
   * 用户点回窗口后就是各种没反应，又是一次"只能退出重开"。
   */
  win.on('minimize', () => {
    dbg('WIN: 窗口被最小化');
    // ⚠️ 这里绝对不能置 userHidden = true。
    //
    // 事故复盘（2026-10-31，用户第三次报"最小化后就用不了"）：
    // 之前为了让「系统级最小化」也能被识别，在这里补置了 userHidden = true。
    // 结果引发了一条更严重的连锁故障：
    //   ① isEffectivelyHidden() 本身已经检查 isMinimized()，根本不需要这个标记；
    //   ② 但 userHidden=true 会让**所有守卫全部退场** ——
    //      reconcileState() 开头 `if (userHidden) return`、
    //      可见性守卫 `if (!panelWanted) return`、贴边轮询 `if (userHidden) return`；
    //   ③ 如果之后没触发 restore 事件（点在托盘上、系统唤醒、虚拟桌面切换都可能漏），
    //      userHidden 就永久卡在 true，于是**再也没人管这个窗口了**。
    // 现场证据：窗口 HWND 完好、位置正确、非最小化、非 cloaked，
    //          唯独 WS_VISIBLE 位被清零 —— 就是被 hide() 之后没人再 show() 回来。
    //
    // 正确做法：只表达「意图」（用户最小化期间别自动弹回来），
    // 把「真相」完全交给窗口本身去回答。
    panelWanted = false;
    stopAnim();
    if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; }
    if (tray) tray.setToolTip('侧边备忘录（已最小化 · 点击显示）');
    refreshTrayMenu();
  });
  win.on('restore', () => {
    dbg('WIN: 窗口从最小化恢复');
    onWindowRestored();
  });
}

/**
 * 窗口从最小化 / 隐藏状态恢复后的全面复位。
 *
 * 最小化隐藏期间会有两个副作用：① 页面定时器被 Chromium 节流甚至冻结，心跳停摆；
 * ② 主进程的状态位（详情页 / 宽限期 / 刹车 / armed）停留在最小化前的那一刻。
 * 恢复瞬间如果不复位，状态机会基于过期信息做判断：
 * 鼠标明明在窗口上却判定"移开了"→ 立刻收起；或者反过来怎么唤都唤不出来。
 * 所以这里一律清干净，再按窗口真实几何重新对账。
 */
function onWindowRestored() {
  userHidden = false;                  // 无论之前是哪种最小化，恢复后一律清掉隐藏标记
  isCollapsed = false;                 // 恢复即视为展开态，避免状态机按"收起"跑
  lastHeartbeat = Date.now();          // 隐藏期间心跳停过，别在恢复瞬间误判成页面死了
  pingFailStreak = 0;
  detailOpen = false;
  keepOpenUntil = Date.now() + 3000;   // 刚恢复先稳住 3 秒，别立刻自己缩回去
  flapGuardUntil = 0;
  hoverBlockUntil = 0;
  blockSince = 0;
  hoverArmed = true;
  stopAnim();
  ensureWindow(true);                  // 窗口可能在最小化期间被系统挪到屏幕外
  reconcileState();
  broadcastPanelState();
  dbg('WIN: 状态机已复位');
}

/** 切换半透明 / 不透明主题时需要重建窗口（transparent 是创建期选项） */
function rebuildWindow() {
  const mode = dockMode;
  const fb = floatBounds;
  const collapsed = isCollapsed;
  if (win && !win.isDestroyed()) win.destroy();
  createWindow();
  dockMode = mode;
  floatBounds = fb;
  isCollapsed = collapsed;
  if (win && !win.isDestroyed()) applyBounds(false);
  syncHandle(collapsed);
}

/* ---------- 补间动画：让面板"缓慢滑出 / 收回" ---------- */
function stopAnim() {
  if (animWatch) { clearTimeout(animWatch); animWatch = null; }
  if (animTimer) { clearInterval(animTimer); animTimer = null; }
  animStartedAt = 0;
}

function animateTo(target, duration, onDone) {
  if (!win || win.isDestroyed()) return;
  const from = win.getBounds();
  const dx = target.x - from.x, dy = target.y - from.y;
  const dw = target.width - from.width, dh = target.height - from.height;
  if (!dx && !dy && !dw && !dh) { if (onDone) onDone(); return; }
  stopAnim();
  const t0 = Date.now();
  animStartedAt = t0;
  let lastKey = '';
  // 兜底：只要 animTimer 一直不清零，看门狗就会被 `if (animTimer) return` 整段跳过、
  // 后续所有 expand/collapse 也被挡住 —— 表现就是"整个程序卡住了，只能退出重开"。
  animWatch = setTimeout(() => {
    if (!animTimer) return;
    dbg('GUARD: 补间动画超时未收尾 -> 强制停止');
    stopAnim();
    if (win && !win.isDestroyed()) { try { win.setBounds(target); } catch (e) {} }
  }, duration + 2000);
  animTimer = setInterval(() => {
    if (!win || win.isDestroyed()) { stopAnim(); return; }
    const p = Math.min(1, (Date.now() - t0) / duration);
    const e = 1 - Math.pow(1 - p, 3);              // easeOutCubic：起步快、收尾缓
    const nx = Math.round(from.x + dx * e);
    const ny = Math.round(from.y + dy * e);
    const nw = Math.round(from.width + dw * e);
    const nh = Math.round(from.height + dh * e);
    // 22ms 一帧（≈45fps）而不是 15ms：软件渲染下每帧都要重绘整个窗口，
    // 帧率太高会来不及画完，屏幕上就会拖出黑色残影。尺寸没变的帧直接跳过。
    const key = nx + ',' + ny + ',' + nw + ',' + nh;
    if (key !== lastKey) { lastKey = key; win.setBounds({ x: nx, y: ny, width: nw, height: nh }); }
    if (p >= 1) { stopAnim(); if (onDone) onDone(); }
  }, 22);
}

function applyBounds(animated) {
  if (!win || win.isDestroyed()) return;
  const exp = expandedBounds(dockMode);
  const target = isCollapsed ? collapsedBounds(dockMode, exp) : exp;
  if (animated) animateTo(target, ANIM_IN);
  else { stopAnim(); win.setBounds(target); }
}

function broadcastPanelState() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('panel-state', { collapsed: isCollapsed, pinned: isPinned, mode: dockMode });
  }
}

/* ---------- 「点击唤出」模式的边缘小把手 ----------
 * 用独立极小窗口，而不是把主窗口缩成一条边：
 *   · 主窗口照旧整体推出屏幕，不用在补间动画里逐帧 resize（软件渲染会拖黑条）；
 *   · 把手只有 8×84 DIP，贴边几乎不挡桌面，也不会抢走主窗口的鼠标命中区；
 *   · 关掉自动划边展开后，只有点它才会把面板叫出来。 */
let lastHandleKey = '';
let lastHandleCheckAt = 0;

function handleBounds() {
  const wa = workArea();
  if (dockMode === 'top') {
    return {
      x: wa.x + Math.round((wa.width - HANDLE_LONG) / 2), y: wa.y,
      width: HANDLE_LONG, height: HANDLE_SHORT,
    };
  }
  return {
    x: wa.x + wa.width - HANDLE_SHORT,
    y: wa.y + Math.round((wa.height - HANDLE_LONG) / 2),
    width: HANDLE_SHORT, height: HANDLE_LONG,
  };
}

function ensureHandleWindow() {
  if (wakeMode !== 'handle' || dockMode === 'float' || userHidden || app.isQuitting) return;
  const b = handleBounds();
  const key = [b.x, b.y, b.width, b.height].join(',');
  if (handleWin && !handleWin.isDestroyed()) {
    if (key !== lastHandleKey) {
      lastHandleKey = key;
      try { handleWin.setBounds(b); } catch (e) {}
    }
    try { if (!handleWin.isVisible()) handleWin.showInactive(); } catch (e) {}
    return;
  }
  try {
    handleWin = new BrowserWindow({
      x: b.x, y: b.y, width: b.width, height: b.height,
      frame: false, transparent: true, backgroundColor: '#00000000',
      alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
      resizable: false, movable: false, minimizable: false, maximizable: false,
      fullscreenable: false, show: false,
      webPreferences: {
        preload: path.join(__dirname, 'handle-preload.js'),
        contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
      },
    });
    lastHandleKey = key;
    try { handleWin.setAlwaysOnTop(true, 'screen-saver'); } catch (e) {}
    handleWin.loadFile(path.join(__dirname, 'handle.html'));
    handleWin.webContents.once('did-finish-load', () => {
      try { if (handleWin && !handleWin.isDestroyed()) handleWin.showInactive(); } catch (e) {}
    });
    handleWin.on('closed', () => { handleWin = null; lastHandleKey = ''; });
  } catch (e) {
    dbg('HANDLE: 小把手创建失败 ' + (e && e.message || e));
  }
}

function hideHandle() {
  if (handleWin && !handleWin.isDestroyed()) {
    try { handleWin.hide(); } catch (e) {}
  }
}

/** 收起=露出把手；展开 / 最小化到托盘 / 切成划边模式=收走 */
function syncHandle(show) {
  if (!show || wakeMode !== 'handle' || dockMode === 'float' || userHidden) { hideHandle(); return; }
  ensureHandleWindow();
}

function setDockMode(m) {
  if (!MODES.some((x) => x.key === m)) return;
  if (m === dockMode) return;
  dockMode = m;
  isCollapsed = false;
  persistSettings({ dockMode: m });          // 同步落盘，重启后才能读到新模式
  hideHandle();
  dbg('DOCK: 切到 ' + m + ' -> 设置已保存，准备自动重启');

  // 自测不能真重启（会打断正在跑的断言），退化成原来的淡入切换
  if (process.argv.includes('--selftest')) {
    switchWithFade();
    broadcastPanelState();
    settleWindow('selftest-切模式');
    refreshTrayMenu();
    return;
  }

  /* 用户明确要求：切换悬挂模式就「退出再重新打开」。
     之前靠 8 秒宽限 + 强制重绘去压住"切换后卡死"，但窗口尺寸、CSS 模式类、
     贴边轮询里的旧坐标基准都会同时变，任何一处没同步上就是假界面。
     干脆重启：新进程读到的所有状态天然一致，这是唯一能保证不卡死的做法。
     app.relaunch 会保留 exe 路径 / 工作目录，比手工 spawn 可靠。 */
  setTimeout(() => {
    const args = process.argv.slice(1).filter((a) => a !== '--hidden');
    if (!args.includes('--no-sandbox')) args.push('--no-sandbox');
    // 心跳文件必须先抹掉：新实例拿不到锁时会看它判断"是不是已有实例活着"，
    // 残留 6 秒内的心跳会让它误判并直接退出 = 切个模式程序就打不开了。
    try { fs.unlinkSync(HEARTBEAT_FILE); } catch (e) {}
    try { app.relaunch({ args }); } catch (e) { dbg('DOCK: relaunch 异常 ' + e.message); }
    dbg('DOCK: 重启中 args=' + args.join(' '));
    app.exit(0);
  }, 320);
}

/** 切换「唤出方式」：划边自动摊开 / 边缘小把手点击才展开 */
function setWakeMode(m) {
  const next = (m === 'handle') ? 'handle' : 'hover';
  wakeMode = next;
  persistSettings({ wakeMode: next });
  dbg('WAKE: 唤出方式 -> ' + next);
  if (next === 'hover') {
    hideHandle();
    hoverArmed = true;                       // 划边模式重新武装，别从上次的状态继承
  } else if (!userHidden) {
    hoverArmed = false;
    if (!isCollapsed) collapse();            // 立刻变成"只露把手"，不用等鼠标自己移开
    else syncHandle(true);
  }
  broadcastPanelState();
  refreshTrayMenu();
}

/**
 * 切换停靠模式时窗口尺寸必然要变。软件渲染下逐帧 resize（老的补间动画做法）
 * 每帧都要整窗重绘，跟不上就会整屏闪烁、拖黑条——小浮窗 ↔ 顶部悬挂切换时尤其明显。
 * 改成：先整体淡出 → 一次性把窗口摆到新位置/新尺寸 → 再快速淡入。
 * 全程只有一次 resize，视觉上是"旧的消失、新的浮现"，不再闪。
 */
function switchWithFade() {
  if (!win || win.isDestroyed()) return;
  stopAnim();
  if (fadeTimer) { clearInterval(fadeTimer); fadeTimer = null; }
  /* 旧的「淡出→摆位→淡入」用 setInterval 逐帧 setOpacity，正是把分层窗口
   * 钉死在旧合成表面的元凶。现在窗口不透明，也不需要淡入：一次摆位 + 提交新帧，
   * 视觉上就是干净的一次切换，且绝不会留下半透明状态。 */
  const target = isCollapsed ? collapsedBounds(dockMode, expandedBounds(dockMode)) : expandedBounds(dockMode);
  win.setBounds(target);
  try { win.webContents.invalidate(); } catch (e) {}
  try {
    const p = win.webContents.executeJavaScript('window.dispatchEvent(new Event("resize")); true', true);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (e) {}
}

/**
 * 抖动刹车：正常情况下用户主动移开又移回来，鼠标位移会很大。
 * 只有「两次弹收之间鼠标几乎没动」才说明是程序自己在空转（比如某处监听误触发），
 * 这时才冻结自动行为几秒。
 *
 * 之前只看次数不看位移，结果用户正常的"移上去→移开→再移上去"被误判成抖动，
 * 而且触发时把 hoverArmed 锁成 false，鼠标又一直贴在边上不离开 → 再也没有代码能解锁，
 * 窗口彻底唤不出来。现在加了位移判定，并且刹车时绝不去动 armed。
 */
function noteToggle() {
  const now = Date.now();
  const m = pointerDip();
  const moved = (m && lastToggleMouse)
    ? Math.hypot(m.x - lastToggleMouse.x, m.y - lastToggleMouse.y)
    : 999;
  if (m) lastToggleMouse = m;
  if (now - lastToggleAt < 1500 && moved < 12) toggleStreak += 1; else toggleStreak = 1;
  lastToggleAt = now;
  if (toggleStreak >= 4) {
    toggleStreak = 0;
    flapGuardUntil = now + 3000;
    dbg('FLAP GUARD: 鼠标没动却反复弹/收，自动行为冻结 3 秒  moved=' + moved.toFixed(1));
  }
}

/* ---------- 窗口健康守卫（WATCHDOG）----------
 * 事故背景：渲染进程崩掉后（内存见底被系统杀、异常退出等），主进程还在、托盘图标还在，
 * 但窗口已经没法显示 —— 于是鼠标划边没反应、点托盘没反应、双击启动也像没反应
 * （新实例被 single-instance 拦下并退出，旧实例又 expand 不动）。
 * 这套守卫负责三件事：窗口没了就重建、页面崩了就重载、跑到屏幕外就拉回来。 */
let watchdogTimer = null;
let pidProbeLogged = false;
let tickCount = 0;
let lastHeartbeat = 0;      // 渲染进程心跳时间戳（0 = 还没收到过）
// "互相监督"的两个重启计数器：这是专门用来抓「无限重启空转」的探针。
// 正常运行时它们应该长期停在 0；一旦某处逻辑出错让监控器反复重启对方，
// 这里会在几秒内飙到几十上百，断言立刻就能发现（而不是等用户报"卡死了"）。
let watchdogRestartCount = 0;
let hoverRestartCount = 0;

/** 返回 true 表示刚刚"救活"了窗口 */
function ensureWindow(force) {
  try {
    // 1) 窗口对象没了 → 重建
    if (!win || win.isDestroyed()) {
      dbg('GUARD: 窗口已销毁 -> 重建');
      createWindow();
      if (win && !win.isDestroyed()) {
        userHidden = false;
        applyBounds(false);
        try { win.show(); } catch (e) {}
      }
      return true;
    }
    // 2) 渲染进程崩了 → 重载页面
    if (win.webContents && win.webContents.isCrashed && win.webContents.isCrashed()) {
      dbg('GUARD: 渲染进程崩溃 -> reload');
      try { win.webContents.reload(); } catch (e) {}
      try { if (!win.isVisible()) win.show(); } catch (e) {}
      userHidden = false;
      return true;
    }
    // 3) 窗口跑出所有屏幕（拔显示器 / 改分辨率 / bounds 异常）→ 拉回来。
    //    动画进行中不检查：滑出动画的起点本来就在屏幕外，别误判。
    if ((force || !isCollapsed) && !animTimer) {
      const b = win.getBounds();
      const onScreen = screen.getAllDisplays().some((d) => {
        const a = d.workArea;
        return b.x < a.x + a.width - 30 && b.x + b.width > a.x + 30
          && b.y < a.y + a.height - 30 && b.y + b.height > a.y + 30;
      });
      if (!onScreen) {
        dbg('GUARD: 窗口跑出屏幕 -> 拉回 bounds=' + JSON.stringify(b));
        applyBounds(false);
        try { win.show(); } catch (e) {}
        return true;
      }
    }
  } catch (e) {
    dbg('GUARD: 异常 ' + (e && e.message));
  }
  return false;
}

/** ⚠️ 已弃用，watchdog 不要再调用它：reload 之后它仍返回那个已被杀死的旧 PID，
 *  导致每隔 5 秒无限 reload，把用户正在输入的内容反复冲掉。留在这里是为了记录这条路走不通。 */
function rendererPidAlive() {
  try {
    if (!win || win.isDestroyed()) return false;
    const wc = win.webContents;
    let pid = null;
    if (typeof wc.getProcessId === 'function') { try { pid = wc.getProcessId(); } catch (e) {} }
    if (!pid && wc.osProcessId) pid = wc.osProcessId;
    if (!pid) {
      if (!pidProbeLogged) {
        pidProbeLogged = true;
        dbg('PROBE: 拿不到 renderer pid  getProcessId=' + (typeof wc.getProcessId)
          + ' osProcessId=' + wc.osProcessId
          + ' isCrashed=' + (typeof wc.isCrashed === 'function' ? wc.isCrashed() : 'n/a'));
      }
      return true;                                   // 拿不到 PID 就别乱重建
    }
    try { process.kill(pid, 0); return true; }       // 存在性探测，不发信号
    catch (e) { return false; }
  } catch (e) { return true; }
}

/** 主动探活：渲染进程被外力杀掉时，Electron 常常既不报 render-process-gone、
 *  isCrashed() 也返回 false —— 界面还在、就是完全没反应。所以只能主动 ping。 */
function pingRenderer() {
  return new Promise((resolve) => {
    try {
      if (!win || win.isDestroyed()) return resolve(false);
      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
      const timer = setTimeout(() => finish(false), 1500);
      Promise.resolve(win.webContents.executeJavaScript('1'))
        .then((v) => { clearTimeout(timer); finish(v === 1); })
        .catch(() => { clearTimeout(timer); finish(false); });
    } catch (e) { resolve(false); }
  });
}

function reviveRenderer() {
  reviveCount += 1;
  if (!win || win.isDestroyed()) { dbg('GUARD: 窗口没了 -> 重建'); ensureWindow(); return; }
  dbg('GUARD: 渲染进程无响应 -> reload');
  try { win.webContents.reload(); } catch (e) {
    dbg('GUARD: reload 异常 -> 重建窗口'); ensureWindow(); return;
  }
  // reload 也不一定救得回来（因为 webContents 本身可能已经废掉），3 秒后复查
  setTimeout(async () => {
    const okNow = await pingRenderer();
    if (okNow) {
      dbg('GUARD: 已复活 OK');
      userHidden = false;
      try { if (win && !win.isDestroyed() && !win.isVisible()) win.show(); } catch (e) {}
    } else {
      dbg('GUARD: reload 没救活 -> 销毁并重建窗口');
      try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) {}
      createWindow();
      userHidden = false;
      applyBounds(false);
      try { win.show(); } catch (e) {}
    }
  }, 3000);
}

function startWatchdog() {
  dbg('watchdog: 已启动（每 5 秒体检一次）');
  if (watchdogTimer) clearInterval(watchdogTimer);
  // ⚠️⚠️ 必须在这里就把时间戳刷成"现在"，绝不能等回调第一次执行！
  //
  // 事故复盘（2026-10-31，用户报"最小化之后再打开就完全没法操作"）：
  // lastWatchdogTick 只在定时器回调里更新，而回调要等 5 秒才首次执行。
  // 系统休眠 6 小时后唤醒，贴边轮询（每 90ms 一次）立刻发现"看门狗 6 小时没 tick 了"，
  // 于是重启它 —— 重启后 lastWatchdogTick 依旧是 6 小时前的旧值，
  // 90ms 后再次判定停摆、再次重启…… **新定时器每次都活不过 90ms，回调一次都没跑过**。
  // 后果：心跳检测、窗口救援全部停摆；同时每 90ms 同步 appendFileSync 写一行日志，
  // 日志到 200KB 还要同步读+截断重写，磁盘 IO 被吃满 → 整个程序彻底无响应。
  // 现场日志里连续 447 条 "GUARD: 看门狗停摆 21753s -> 重启" 就是它。
  //
  // 教训：监控器重启目标之后，必须立刻把目标标记为"健康"，否则监控器会不停地重启它。
  lastWatchdogTick = Date.now();
  watchdogStartedAt = lastWatchdogTick;
  watchdogTimer = setInterval(async () => {
    if (app.isQuitting) return;
    lastWatchdogTick = Date.now();
    // 可见性守卫（第二道）：贴边轮询万一停摆，这里每 5 秒还会再兜一次底
    enforceVisibilityGuard();
    // 补间动画有自己的 2 秒兜底；万一没兜住，这里再补一刀然后继续体检。
    // 以前是「只要 animTimer 在就直接 return」，于是动画一旦漏清，整个体检就被永久跳过
    // —— 程序看着还活着、其实什么都不管了，这正是「只能退出重开」的成因之一。
    if (animTimer) {
      if (animStartedAt && Date.now() - animStartedAt > 8000) {
        dbg('GUARD: 补间动画卡了 ' + Math.round((Date.now() - animStartedAt) / 1000) + 's 未收尾 -> 强制停止');
        stopAnim();
      } else {
        return;
      }
    }
    // 贴边轮询是不是停了？停了就重建。restartHoverWatch 会重建闭包，
    // 顺带把 nearSince / awaySince / blockSince 这些可能卡住的计时基准全部归零。
    if (lastHoverTick && Date.now() - lastHoverTick > 1500) {
      dbg('GUARD: 贴边轮询停摆 ' + Math.round((Date.now() - lastHoverTick) / 1000) + 's -> 重启');
      hoverRestartCount += 1;
      restartHoverWatch();
    }
    if ((++tickCount % 6) === 0) dbg('watchdog tick#' + tickCount);   // 心跳，证明自己活着

    // 用户主动最小化（托盘菜单「最小化到托盘」）时，页面处于 hidden 状态：
    // Chromium 会节流乃至冻结隐藏页面的定时器，此时心跳停摆是完全正常的生理现象。
    // 这种情况下若照常判定"页面已死"去 reload，会有两个后果：
    //   ① did-finish-load 的兜底 showOnce() 会把用户刚最小化的窗口自己弹出来；
    //   ② reload 若救不回来，会走到 destroy + 重建窗口，
    //      用户回头点托盘 / 按热键看到的就是一个彻底乱掉、点什么都没反应的窗口。
    // 所以隐藏期间一律不做页面存活判定，只把状态刷成健康，等 showWindow() 重新开始。
    // 注意：系统级最小化（Win+D）不会置 userHidden，所以这里必须连 isMinimized() 一起看。
    let minimized = false;
    try { minimized = !!(win && !win.isDestroyed() && win.isMinimized && win.isMinimized()); } catch (e) {}
    if (userHidden || minimized) {
      pingFailStreak = 0;
      lastHeartbeat = Date.now();
      return;
    }

    // 页面自己上报心跳最可靠：超时没上报 = 渲染进程已经凉了。
    // 注意：绝不能再拿 webContents.getProcessId() 判定 —— reload 之后它仍返回那个已被杀死的
    // 旧 PID，会导致每隔 5 秒无限 reload，把用户正在输入的内容反复冲掉。
    if (lastHeartbeat && Date.now() - lastHeartbeat > 8000) {
      dbg('GUARD: 心跳超时 ' + (Date.now() - lastHeartbeat) + 'ms -> 复活渲染进程');
      reviveRenderer();
      lastHeartbeat = Date.now();      // 给复活留个窗口，避免短时间内反复重建
      return;
    }
    // 第二重：进程还在但页面卡死（JS 死循环）。只在窗口可见时检测，连续 3 次才动手。
    if (win && !win.isDestroyed() && win.isVisible()) {
      const ok = await pingRenderer();
      if (ok) { pingFailStreak = 0; ensureWindow(); return; }
      pingFailStreak += 1;
      if (pingFailStreak >= 3) {
        dbg('GUARD: 页面连续 ' + pingFailStreak + ' 次无响应 -> 复活');
        reviveRenderer();
        pingFailStreak = 0;
        lastHeartbeat = Date.now();
      }
    } else {
      ensureWindow();
    }
  }, 5000);
}

/** focusIt 只在托盘点击 / 唤起已有实例时用：鼠标划过自动滑出时抢焦点会打断用户手上的活 */
function expand(focusIt) {
  panelWanted = true;                        // 期望=可见：守卫会持续确保它真的在屏幕上
  ensureWindow();                            // WATCHDOG：先把坏掉的窗口救回来
  if (!win || win.isDestroyed()) return;
  // 用统一判据：窗口处于系统最小化（Win+D）时 isVisible() 仍为 true，
  // 只看 userHidden 会漏掉这种情况 —— 结果是"唤出了却看不见、也点不动"。
  if (isEffectivelyHidden()) { enforceVisibleNow('expand'); }
  if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; }
  const wasCollapsed = isCollapsed;
  isCollapsed = false;
  const exp = expandedBounds(dockMode);
  const b = win.getBounds();
  if (!wasCollapsed && b.width === exp.width && b.height === exp.height && b.x === exp.x && b.y === exp.y) {
    broadcastPanelState();
    settleWindow('expand-已就位');       // 几何没变也要确认输入层/合成帧是活的
    return;
  }
  // 手动唤出（托盘点击 / 新建备忘）：给 6 秒宽限，鼠标还没移到窗口上时不许自己缩回去
  if (focusIt) keepOpenUntil = Date.now() + 6000;
  stopAnim();
  animateTo(exp, ANIM_IN);
  if (wasCollapsed) {
    noteToggle();
    const m = pointerDip();
    dbg('expand  mouse=' + (m ? Math.round(m.x) + ',' + Math.round(m.y) : '?'));
  }
  if (focusIt) { try { win.focus(); } catch (e) {} }
  hideHandle();                              // 面板已展开，小把手收走
  broadcastPanelState();
  settleWindow('expand');                    // 贴边自动展开 / 把手展开 / 托盘恢复统一收敛
}

/**
 * 窗口"实际上看不见"的统一判据。
 *
 * 绝不能只看 userHidden：系统级最小化（Win+D「显示桌面」、任务栏点最小化）
 * 不会经过我们的 hideWindow()，userHidden 仍然是 false；
 * 而 Windows 上最小化窗口的 isVisible() 依旧返回 **true**
 * （Chromium 认为它只是被折叠，并非被隐藏）。
 * 于是托盘点击 / 热键的 toggle 会误判成"窗口正展开着" → 执行 collapse() 继续收起，
 * 窗口就一直卡在最小化状态：用户点了托盘毫无变化，正是"显示出来还是没法用"。
 * 所以三个条件取或，缺一不可。
 */
function isEffectivelyHidden() {
  if (!win || win.isDestroyed()) return true;
  try { if (win.isMinimized()) return true; } catch (e) {}
  try { if (!win.isVisible()) return true; } catch (e) {}
  return !!userHidden;
}

/**
 * 从窗口的**真实几何**反推当前形态：是不是正停在展开位。
 * 不查 isCollapsed —— 那个只是"意图"，可能已经和真相分叉了。
 */
function isReallyExpanded() {
  if (!win || win.isDestroyed()) return false;
  try {
    const b = win.getBounds();
    const exp = expandedBounds(dockMode);
    return Math.abs(b.x - exp.x) <= 20 && Math.abs(b.y - exp.y) <= 20
      && Math.abs(b.width - exp.width) <= 20 && Math.abs(b.height - exp.height) <= 20;
  } catch (e) { return false; }
}

/** 托盘图标点击 / 菜单首项：看不见 → 恢复显示；看得见 → 在展开/收起之间切换 */
function trayToggle() {
  dbg('TRAY: toggle 点击  hidden=' + isEffectivelyHidden() + ' collapsed=' + isCollapsed);
  if (isEffectivelyHidden()) return showWindow();
  // 用真实几何判断，而不是信任 isCollapsed
  return (isReallyExpanded() ? (collapse()) : expand(true));
}

/** 最小化到托盘：窗口整个隐藏（不是缩成一条边），托盘图标点击或菜单「显示窗口」恢复 */
function hideWindow() {
  dbg('IPC: hideWindow 入口');
  if (!win || win.isDestroyed()) return;
  // 托盘图标没建出来时，绝不允许"完全隐藏"：那样窗口会彻底消失、又没图标可点，
  // 用户只能杀进程重开。退而求其次缩成一条边，鼠标划边/热键仍能把面板叫回来。
  if (!tray || (tray.isDestroyed && tray.isDestroyed())) {
    dbg('hideWindow: 托盘不可用 -> 降级为收起到边缘（不彻底隐藏）');
    collapse();
    return;
  }
  userHidden = true;
  panelWanted = false;                       // 期望=隐藏：守卫不会再去把它拉回来
  hideHandle();                              // 最小化到托盘时小把手也不能留在屏幕上
  stopAnim();
  if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; }
  try { win.hide(); } catch (e) {}
  if (tray) tray.setToolTip('侧边备忘录（已最小化 · 点击显示）');
  refreshTrayMenu();
}

/**
 * 幂等地把窗口收敛到「可见 + 可交互」这个目标态。
 *
 * 设计要点：**不查任何内部标志位**。
 * 不管之前发生了什么（系统最小化、休眠唤醒、被外力挪到屏幕外、状态位卡住、
 * 页面被 Chromium 冻结），进来就无条件走完整套动作，做完再自查。
 *
 * 这是「卡死」问题的根治点：以前显示窗口是**一次性动作**（调一次 show，
 * 成功与否全凭当时状态对不对），只要那一瞬间的判断错了就永久失灵；
 * 现在改成**持续收敛**（守卫每 90 毫秒校对一次期望与真相，不一致就再推一次），
 * 任何单点失误都只影响最多 90 毫秒，不可能累积成"卡死"。
 *
 * @param {string} reason 谁触发的（写进日志，方便回溯）
 * @returns {boolean} 收敛后窗口是否真的可见
 */
function enforceVisibleNow(reason) {
  ensureWindow(true);                        // 窗口没了就重建（含被系统挪到屏幕外的情况）
  if (!win || win.isDestroyed()) return false;

  // ⓪ 先把「意图」同步好，再执行动作。
  //   顺序不能反：applyBounds() 要读 isCollapsed 来决定摆到展开位还是收起位，
  //   若沿用卡住的旧值（常见为 true=收起），窗口会被摆回贴边条 —— 等于白叫一次。
  userHidden = false;
  isCollapsed = false;
  pingFailStreak = 0;
  lastHeartbeat = Date.now();                // 给页面喘息时间，别刚恢复就被判定死亡
  keepOpenUntil = Date.now() + 6000;         // 刚叫回来先稳住 6 秒

  // ① 解除最小化：Windows 上最小化窗口的 isVisible() 依旧返回 true，
  //    但 show() 拉不回最小化窗口 —— 必须显式 restore()。
  try { if (win.isMinimized()) win.restore(); } catch (e) {}
  // ② 摆好位置（先于 show，否则会以旧 bounds 闪一下）
  try { applyBounds(false); } catch (e) {}
  // ③ 不再碰 setOpacity（分层窗口上改 alpha 会让 DWM 停更，见 createWindow 注释）；
  //    窗口本来就是不透明的，这里只需要后面那次 invalidate 提交新帧。
  // ④ 显示，并提到最前：Win+D「显示桌面」之后窗口常被压在桌面层之下，
  //    看起来在屏幕上，实际点不到。
  try { win.show(); } catch (e) {}
  try { win.moveTop(); } catch (e) {}
  try { win.focus(); } catch (e) {}
  // ⑤ 唤醒页面：隐藏期间 Chromium 会节流乃至冻结渲染进程，
  //    窗口回来了但页面还是"死的"，必须显式激活。
  try { win.webContents.focus(); } catch (e) {}
  // ⑥ 强制重绘：透明 / acrylic 窗口从隐藏恢复后有时不重绘，
  //    屏幕上显示的是一张不响应的旧图。
  try { win.webContents.invalidate(); } catch (e) {}

  broadcastPanelState();
  dbg('ENFORCE: 收敛到可见态（' + (reason || '?') + '）bounds=' + fmtB(win.getBounds()));
  return true;
}

/**
 * 所有「窗口切换」出口的统一收敛点（2026-11-09 架构修复）。
 *
 * 之前每一轮修「假界面」的补丁都只挂在 showWindow / 把手点击 / resize 三处，
 * 而贴边自动展开、收起后再展开、改大小、切模式重启后的首次显示全都没挂 ——
 * 用户换一个入口就又漏一次。现在把这些出口全部收敛到这里。
 *
 * 与页面的关系已经彻底解耦：styles.css 用窗口实际尺寸（媒体查询）决定显示
 * 卡片还是气泡，页面**不需要**收到任何 IPC 就能恢复正常界面。所以这里只负责
 * 主进程这一侧：输入层复位 + 跨帧提交一个新帧 + 留一行可回溯的日志。
 *
 * 绝不动 bounds：补间动画进行中改 setBounds 会打断动画；而同一个 tick 里
 * width+1 再改回来会被 DWM 直接合并掉，等于没做（老 forceRepaint 的毛病）。
 */
let lastSettleAt = 0;
let lastSettleReason = '';
function settleWindow(reason) {
  if (!win || win.isDestroyed()) return;
  const tag = reason || '?';
  const now = Date.now();
  // 贴边轮询可能在几百毫秒内连续 expand/collapse，别把重绘刷成负担
  if (tag === lastSettleReason && now - lastSettleAt < 180) return;
  lastSettleAt = now;
  lastSettleReason = tag;

  // ① 输入层显式复位：透明 acrylic 窗口从 hide / 屏幕外回来，偶尔会停在
  //    「看着在、点不到」的状态。这几个都是幂等的，正常时调了没有副作用。
  try { win.setIgnoreMouseEvents(false); } catch (e) {}
  try { win.setFocusable(true); } catch (e) {}
  try { win.webContents.setBackgroundThrottling(false); } catch (e) {}
  // ② 把次要 UI（图钉 / 边条 / 详情页）拉齐；即便这条没到也不影响主界面
  syncPageDomNow();
  // ③ 跨帧提交新帧。**不要再调 setOpacity**：分层透明窗口上反复改 alpha 会让
  //    DWM 一直停在同一张合成表面，页面画什么屏幕都不更新（灰屏/假界面的元凶之一）。
  try { win.webContents.invalidate(); } catch (e) {}
  setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    try { win.webContents.invalidate(); } catch (e) {}
    try {
      const p = win.webContents.executeJavaScript(
        '(function(){var b=document.body;b.style.transform="translateZ(0)";'
        + 'requestAnimationFrame(function(){b.style.transform="";'
        + 'window.dispatchEvent(new Event("resize"));});return true;})()', true);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) {}
  }, 45);
  try {
    dbg('SETTLE: ' + tag + ' bounds=' + fmtB(win.getBounds())
        + ' vis=' + win.isVisible() + ' collapsed=' + isCollapsed);
  } catch (e) {}
}

/** 延迟到补间动画基本跑完再收敛，并对同一轮连续调用做防抖 */
function forceRepaint(reason) {
  if (repaintTimer) { clearTimeout(repaintTimer); repaintTimer = null; }
  repaintTimer = setTimeout(() => {
    repaintTimer = null;
    settleWindow(reason);
  }, 260);
}

/**
 * 不依赖 IPC 事件通道，直接在渲染进程里把界面状态摆正。
 *
 * 「假界面」最主要的成因（2026-11-09 复盘）：窗口 hide 期间渲染进程被 Chromium
 * 挂起，show 那一刻 push 过去的 panel-state 消息丢了，页面仍挂着 body.collapsed
 * —— CSS 里 `body.collapsed .app{display:none}` 把整个卡片界面藏掉，只剩一条边条。
 * 而主进程的贴边轮询照常改 bounds，于是用户看到"能感应鼠标弹出收回，但界面是假的、
 * 点不动"。executeJavaScript 走的是另一条通道，且自带重排，比被动等 IPC 可靠得多。
 */
function syncPageDomNow() {
  if (!win || win.isDestroyed()) return;
  const code = '(function(){'
    + 'document.body.classList.toggle("collapsed", ' + (isCollapsed ? 'true' : 'false') + ');'
    + 'var a=document.getElementById("app");if(a)a.style.display="";'
    + 'window.dispatchEvent(new Event("resize"));'
    + 'return true;})()';
  try {
    const p = win.webContents.executeJavaScript(code, true);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (e) {}
}

/** 恢复显示后连发几次状态：任何一次到达页面，都能把它从"假界面"拉回来 */
function resendPanelState() {
  [180, 700, 1500, 3000].forEach((t) => {
    setTimeout(() => {
      if (!win || win.isDestroyed() || userHidden) return;
      broadcastPanelState();
      if (t === 700 || t === 3000) syncPageDomNow();
    }, t);
  });
}

function showWindow() {
  dbg('IPC: showWindow 入口');
  lastShowAt = Date.now();
  const wasHidden = userHidden || isEffectivelyHidden();
  panelWanted = true;                        // 期望=可见：守卫从此持续兜底
  enforceVisibleNow('showWindow');
  if (wasHidden) {
    syncPageDomNow();                        // 不靠 IPC，直接把页面 DOM 摆正
    resendPanelState();
  }
  forceRepaint('showWindow');
  if (tray) tray.setToolTip('侧边备忘录');
  refreshTrayMenu();
  verifyWindowAfterShow();
  syncHandle(isCollapsed);
}

/**
 * 恢复显示后的两道复查。
 *
 * 窗口隐藏期间我们刻意关掉了存活判定（避免把被系统节流的正常页面误杀），
 * 所以窗口重新出现后必须自己确认两件事：
 *   ① 窗口是不是**真的**可见、且位置在屏幕内（系统最小化会让 isVisible() 撒谎）；
 *   ② 页面是不是**还活着**（冻结 / 崩溃都会让 executeJavaScript 超时）。
 * 任何一关不过就立刻修，绝不给用户留下"窗口出来了但点不动"的状态。
 */
function verifyWindowAfterShow() {
  // 第一关：几何与可见性
  setTimeout(() => {
    try {
      if (!win || win.isDestroyed()) { ensureWindow(true); return; }
      const b = win.getBounds();
      const wa = workArea();
      const onScreen = b.x < wa.x + wa.width - 30 && b.x + b.width > wa.x + 30
        && b.y < wa.y + wa.height - 30 && b.y + b.height > wa.y + 30;
      if (!win.isVisible() || win.isMinimized() || !onScreen) {
        dbg('GUARD: 恢复显示后窗口仍不可见/不在屏幕内 -> 强制摆回 bounds=' + JSON.stringify(b));
        if (win.isMinimized()) win.restore();
        applyBounds(false);
        try { win.show(); win.moveTop(); win.focus(); } catch (e) {}
      }
      // 第二帧兜底：show 那一刻的抖动若被 DWM 合并掉，这里再逼一次重绘
      broadcastPanelState();
      syncPageDomNow();
      forceRepaint('恢复复查');
    } catch (e) {}
  }, 600);

  // 第二关：页面是否还在响应。
  // 连查两次才动手，避免刚恢复那一瞬间 executeJavaScript 偶尔超时造成误伤
  // （reload 会把用户正在输入的内容冲掉，宁可多等 300 毫秒）。
  setTimeout(async () => {
    const ok = await pingRenderer();
    if (ok) { pingFailStreak = 0; return; }
    await new Promise((r) => setTimeout(r, 300));
    const ok2 = await pingRenderer();
    if (ok2) { pingFailStreak = 0; return; }
    dbg('GUARD: 恢复显示后页面连续 2 次无响应 -> 复活渲染进程');
    reviveRenderer();
  }, 1600);
}

/** 轻量运行日志：只保留最近几百行，避免长期挂着把日志文件写大 */
/**
 * 日志限流：同一句式的消息 1 秒内最多落盘一次，被吞掉的累计成一行汇总。
 *
 * 为什么必须有：dbg 用的是同步写（appendFileSync），一旦某处循环失控
 * （比如监控器每 90ms 重启一次定时器），它会以同样的频率同步写盘，
 * 日志到上限时还要整文件读出来再截断重写 —— 磁盘 IO 直接被吃满。
 * 结果是：本来只是一个逻辑错误，最后表现成"整个程序卡死、只能退出重开"，
 * 而且日志里全是重复行，真正的现场证据反而被冲得看不见。
 * 有了限流，最坏情况也只是每秒一行，程序该有的响应照旧。
 *
 * 自测时关闭限流：断言日志句式高度雷同（"断言 N ..."），限流会把它们压掉。
 */
const DBG_THROTTLE = process.argv.includes('--selftest') ? 0 : 1000;
const dbgRecent = new Map();
const dbgDropped = new Map();

function dbg(msg) {
  const line = String(msg);
  const now = Date.now();
  if (DBG_THROTTLE > 0) {
    const key = line.replace(/\d+(\.\d+)?/g, '#');    // 抹掉数字：同一句式算同一类
    const last = dbgRecent.get(key);
    if (last !== undefined && now - last < DBG_THROTTLE) {
      dbgDropped.set(key, (dbgDropped.get(key) || 0) + 1);
      return;
    }
    dbgRecent.set(key, now);
    if (dbgRecent.size > 200) {                      // 别让 Map 长期挂着变大
      for (const k of dbgRecent.keys()) {
        if (dbgRecent.get(k) < now - 60000) dbgRecent.delete(k);
        if (dbgRecent.size <= 200) break;
      }
    }
  }
  try {
    const f = path.join(app.getPath('userData'), 'debug.log');
    const ts = new Date().toISOString().slice(11, 23);
    let out = ts + ' ' + line + '\n';
    if (DBG_THROTTLE > 0) {
      let dropped = 0;
      for (const [k, v] of dbgDropped) if (v) { dropped += v; dbgDropped.set(k, 0); }
      if (dropped) out += ts + ' ...(同类消息已省略 ' + dropped + ' 条)\n';
    }
    fs.appendFileSync(f, out);
    if (fs.existsSync(f) && fs.statSync(f).size > 200 * 1024) {
      const lines = fs.readFileSync(f, 'utf-8').split('\n');
      fs.writeFileSync(f, lines.slice(-300).join('\n'), 'utf-8');
    }
  } catch (e) { /* 写不了就算了 */ }
}

function collapse() {
  if (!win || win.isDestroyed() || isPinned) return;
  const exp = expandedBounds(dockMode);
  isCollapsed = true;
  // 冷却只需要挡住"收起动画刚开始、鼠标恰好扫过边缘"这一种情况；
  // 补间本身支持中途打断并平滑改向，所以不用等动画跑完。以前设成 1 秒，
  // 用户刚移开又想马上移回来唤出时会被挡住，体感就是"叫不回来"。
  hoverBlockUntil = Date.now() + ANIM_OUT + 60;
  // 关键：armed 直接由"鼠标此刻在不在贴边区"决定，不靠别的地方去复位。
  // 以前只要在别处把 armed 置 false 而鼠标一直停在贴边区，就再也没有代码能把它置回 true，
  // 窗口就永久唤不出来了（用户反馈"放右边放上面都弹不出来"的根因）。
  const m = pointerDip();
  hoverArmed = m ? !isNearEdge(m, dockMode, m.wa) : true;
  stopAnim();
  animateTo(collapsedBounds(dockMode, exp), ANIM_OUT);
  noteToggle();
  dbg('collapse  mouse=' + (m ? Math.round(m.x) + ',' + Math.round(m.y) : '?') + ' armed=' + hoverArmed);
  broadcastPanelState();
  syncHandle(true);                          // 点击唤出模式：露出边缘小把手
  settleWindow('collapse');
}

function scheduleCollapse(delay = 700) {
  if (!win || isPinned) return;
  if (collapseTimer) clearTimeout(collapseTimer);
  collapseTimer = setTimeout(() => collapse(), delay);
}

/* 鼠标位置（换算成 DIP，跟 win.getBounds() 同一套单位才能直接比大小。
   注意：getCursorScreenPoint() 返回的是物理像素，125% 缩放下 1 DIP = 1.25 px） */
/**
 * fakeMouse 只给自动化测试用：真实鼠标会被用户自己的操作随时覆盖，
 * 靠 SetCursorPos 做断言完全不可靠（日志里读到的坐标永远是"别人的鼠标"）。
 * 有了虚拟鼠标，自测就能确定性地驱动整套唤出/归位状态机。
 */
let fakeMouse = null;

/**
 * 把 getCursorScreenPoint() 的原始值解析成「和 win.getBounds() 同一套单位的 DIP 坐标」。
 *
 * 这里踩过一个致命的坑：以前无脑除以 scaleFactor。实测本机（Windows 125% 缩放，
 * 工作区 DIP 宽 2048）鼠标压在最右缘时 getCursorScreenPoint() 返回的就是 2047 —— 它已经是
 * DIP；再除 1.25 变成 1637，而唤出区要求 x >= 2048-56=1992，于是鼠标在数学上永远
 * "到不了屏幕边缘"，窗口彻底唤不出来。自测当初没抓到，是因为 fakeMouse 直接喂 DIP，
 * 恰好绕过了这段换算 —— 测试通过 ≠ 真机能用。
 *
 * 不同 Electron 版本 / 系统缩放下返回值单位并不统一，所以这里做自适应：
 * 先按 DIP 原样判断落在哪个显示器的工作区内，不行再按物理像素除以 scaleFactor 试一次。
 */
function resolvePointer(p) {
  const displays = screen.getAllDisplays();
  /**
   * 判断坐标是否落在某个显示器的范围内。
   *
   * ⚠️ 必须用 bounds（整块屏幕，含任务栏）而不是 workArea：
   * 鼠标停在任务栏上时，workArea 的纵向判定会失败 → 误以为"这个坐标不是 DIP"
   * → 退到第 2 步按物理像素再除以 scaleFactor → 贴边坐标被缩小成 80%
   * → 唤出区要求 x >= 2048-56，解析后只有 1637，鼠标在数学上永远到不了边缘
   * → 面板唤不出来。这个坑踩过两次（一次无脑除、一次判定范围用错）。
   */
  const inside = (x, y, d) =>
    x >= d.bounds.x - 8 && x <= d.bounds.x + d.bounds.width + 8 &&
    y >= d.bounds.y - 8 && y <= d.bounds.y + d.bounds.height + 8;
  // 1) 返回值本身就是 DIP（本机实测属于这种）：原样返回，绝不做任何换算
  for (const d of displays) if (inside(p.x, p.y, d)) return { x: p.x, y: p.y, wa: d.workArea, bounds: d.bounds };
  // 2) 返回值是物理像素：换算成 DIP 后再找一次
  for (const d of displays) {
    const sf = d.scaleFactor || 1;
    if (sf === 1) continue;
    const x = p.x / sf, y = p.y / sf;
    if (inside(x, y, d)) return { x, y, wa: d.workArea, bounds: d.bounds };
  }
  const pr = screen.getPrimaryDisplay();
  return { x: p.x, y: p.y, wa: pr.workArea, bounds: pr.bounds };
}

function pointerDip() {
  if (fakeMouse) {
    return { x: fakeMouse.x, y: fakeMouse.y, wa: screen.getPrimaryDisplay().workArea };
  }
  let p;
  try { p = screen.getCursorScreenPoint(); } catch (e) { return null; }
  // 系统休眠唤醒、显卡驱动切换、远程桌面断开时，getCursorScreenPoint() 偶尔会吐垃圾值
  // （实机日志里抓到过 mouse=-1145324672,-1145324672）。这种读数绝不能拿去做判定：
  // isNearEdge 会永远返回 false，鼠标划到边上也没用 —— 面板就"卡死"了。
  // 读数无效时直接告诉调用方"这次没有可信坐标"，跳过本次判定即可。
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)
    || Math.abs(p.x) > 100000 || Math.abs(p.y) > 100000) {
    return null;
  }
  return resolvePointer(p);
}

/**
 * 鼠标落在哪一级唤出区：'hot' = 贴边窄带（快速弹），'warm' = 宽松带（停留一下也弹），false = 不在。
 *
 * 分两级是为了不再逼用户"精确贴边"：以前触发带只有 56 DIP（约 70 物理像素），
 * 鼠标停在屏幕右侧区域但没压到最边缘就完全唤不出来，用户会以为"功能坏了"。
 * 现在：真的贴边 → 160ms 立刻弹；只是靠近边缘 → 停 0.8 秒也弹。
 * 两级的纵向/横向范围都覆盖整条边，鼠标放在屏幕左上角同样能唤出顶部面板。
 */
function isNearEdge(m, mode, wa) {
  if (mode === 'right') {
    if (m.y < wa.y - 20 || m.y > wa.y + wa.height + 20) return false;
    if (m.x >= wa.x + wa.width - SENS.hover) return 'hot';
    if (m.x >= wa.x + wa.width - SENS.wide) return 'warm';
    return false;
  }
  if (m.x < wa.x - 20 || m.x > wa.x + wa.width + 20) return false;
  if (m.y <= wa.y + SENS.top) return 'hot';
  if (m.y <= wa.y + SENS.topWide) return 'warm';
  return false;
}

/**
 * 自动展开 / 自动收起，统一放在主进程这一个轮询里。
 *
 * 为什么不让渲染进程插手：窗口弹出/收回时几何一直在变，Chromium 会误报
 * mouseenter / mouseleave，于是「刚弹出来又缩回去」，鼠标不动却反复弹收。
 *
 * 三条设计原则：
 * 1. 靠近贴边用「边沿触发」：鼠标停在边上不动只弹一次，必须先移开再靠过来才会再弹；
 * 2. armed 的复位只认"鼠标离开贴边区"这一个事实，且 collapse() 里会按鼠标位置重新定，
 *    绝不依赖别处的赋值 —— 否则一旦卡在 false，窗口就永久唤不出来；
 * 3. 长按边缘强制唤出：不管 armed / 冷却 / 刹车处于什么状态，鼠标压在边上超过
 *    FORCE_PEEK 就无条件弹出。这样任何状态机 bug 都只让你多等 1 秒，不会彻底失灵。
 */
function fmtB(b) {
  return 'x=' + b.x + ' y=' + b.y + ' ' + b.width + 'x' + b.height;
}

/**
 * 状态对账：isCollapsed 只是个内部标志位。一旦它和窗口的真实几何对不上
 * （补间动画被中途打断、系统休眠唤醒后窗口被系统挪位、外力改了 bounds……），
 * 状态机就会一直按错误的分支跑下去：面板明明已经看不见了，鼠标划边却永远唤不出来；
 * 或者反过来，明明收起了却判定成展开、再也不响应贴边。
 * 用户的最终感受就是"程序卡死了，只能退出重开"—— 这才是反复复发的真正根因。
 *
 * 所以这里以窗口的真实几何为准反推状态并纠正。阈值给得比较松（完全出屏 / 偏离 60px），
 * 是为了不跟用户自己拖动窗口打架（窗口是 movable 的，拖动后位置本来就会变）。
 */
function reconcileState() {
  if (animTimer || !win || win.isDestroyed()) return;   // 动画进行中几何本来就在变
  if (userHidden || dockMode === 'float') return;
  const wa = workArea();
  const exp = expandedBounds(dockMode);
  const col = collapsedBounds(dockMode, exp);
  let b;
  try { b = win.getBounds(); } catch (e) { return; }
  // 完全跑到屏幕外：面板一点都看不见
  const offscreen = b.x >= wa.x + wa.width - 4 || b.x + b.width <= wa.x + 4
    || b.y >= wa.y + wa.height - 4 || b.y + b.height <= wa.y + 4;
  const diff = (c) => Math.abs(b.x - c.x) + Math.abs(b.y - c.y);
  if (!isCollapsed && offscreen) {
    dbg('RECONCILE: 标志位=展开，窗口却完全在屏幕外（' + fmtB(b) + '）-> 摆回展开位');
    try { win.setBounds(exp); } catch (e) {}
    return;
  }
  if (isCollapsed && !offscreen && diff(col) > 60) {
    dbg('RECONCILE: 标志位=收起，窗口却停在屏幕内（' + fmtB(b) + '）-> 归位');
    try { win.setBounds(col); } catch (e) {}
  }
}

/**
 * 可见性守卫：只要「期望在屏幕上」，就必须真的看得见。
 *
 * 这是「卡死」问题的终结者，也是本次重构的核心。
 *
 * 以前的模型：显示窗口是**一次性动作** —— 托盘点击 → 调一次 show()，
 * 成功与否全凭调用那一刻的内部标志位对不对。只要那一刻的判断是错的
 * （最常见：窗口已被系统最小化，而 isVisible() 仍返回 true，
 *   于是误判成"正展开着" → 反过来执行 collapse() 继续收起），
 * 这一次调用就白费了，而且**再也没有第二次机会**。
 *
 * 现在的模型：显示窗口是**持续收敛的目标态** ——
 * 用户操作只负责设定 panelWanted；守卫每 90 毫秒拿窗口的真实状态
 * （isMinimized / isVisible / getBounds）跟期望比对，不一致就再推一次。
 * 于是任何单点失误最多影响 90 毫秒，绝不可能累积成永久失灵。
 */
function enforceVisibilityGuard() {
  if (app.isQuitting) return false;
  if (!panelWanted) return false;              // 用户主动隐藏：合法状态，别去打扰
  if (dockMode === 'float') return false;      // 小浮窗是普通窗口，交给系统管
  if (animTimer) return false;                 // 动画进行中几何本来就在变
  if (!win || win.isDestroyed()) { ensureWindow(true); return true; }

  let hidden = false;
  let minimized = false;
  try { hidden = !win.isVisible(); } catch (e) {}
  try { minimized = !!win.isMinimized(); } catch (e) {}
  if (!hidden && !minimized) { guardFailStreak = 0; return false; }

  // 确实错位了：窗口和期望对不上，收敛一次
  dbg('GUARD: 期望可见但窗口实际 hidden=' + hidden + ' minimized=' + minimized + ' -> 收敛');
  enforceVisibleNow('可见性守卫');

  // 收敛后立刻复查：救回来就没事，救不回来说明窗口对象本身已经废了
  let stillBad = true;
  try {
    stillBad = !win || win.isDestroyed() || win.isMinimized() || !win.isVisible();
  } catch (e) {}
  if (stillBad) {
    guardFailStreak += 1;
    dbg('GUARD: 可见性守卫纠正失败第 ' + guardFailStreak + ' 次');
    if (guardFailStreak >= 3) {
      guardFailStreak = 0;
      // 冷却：销毁重建是重手段。若环境本身有问题（比如显卡驱动异常），
      // 不限流的话会变成每 90 毫秒重建一次窗口，反而把机器拖垮。
      if (Date.now() - lastHardRebuildAt < 10000) {
        dbg('GUARD: 需要重建但距上次不足 10 秒 -> 本次跳过，等待冷却');
        return true;
      }
      lastHardRebuildAt = Date.now();
      dbg('GUARD: 连续 3 次纠正失败 -> 销毁并重建窗口');
      try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) {}
      createWindow();
      userHidden = false;
      panelWanted = true;
      try { applyBounds(false); } catch (e) {}
      try { win.show(); win.moveTop(); win.focus(); } catch (e) {}
      broadcastPanelState();
    }
  } else {
    guardFailStreak = 0;
  }
  return true;
}

/** 每 30 秒落一行状态快照：下次再"卡住"时，日志里直接就有现场证据，不用再靠猜 */
function dumpState() {
  if (!win || win.isDestroyed()) { dbg('STATE win=已销毁 hoverAlive=' + (Date.now() - lastHoverTick) + 'ms'); return; }
  const m = pointerDip();
  dbg('STATE collapsed=' + isCollapsed + ' visible=' + win.isVisible() + ' hidden=' + userHidden
    + ' pinned=' + isPinned + ' detail=' + detailOpen + ' mode=' + dockMode
    + ' anim=' + !!animTimer + ' bounds=' + fmtB(win.getBounds()) + ' exp=' + fmtB(expandedBounds(dockMode))
    + ' mouse=' + (m ? Math.round(m.x) + ',' + Math.round(m.y) : '?')
    + ' armed=' + hoverArmed
    + ' block=' + Math.max(0, hoverBlockUntil - Date.now())
    + ' flap=' + Math.max(0, flapGuardUntil - Date.now())
    + ' hoverAlive=' + (Date.now() - lastHoverTick) + 'ms');
}

function startHoverWatch() {
  if (hoverTimer) return;
  lastHoverTick = Date.now();
  let nearStreak = 0;
  let awaySince = 0;
  let nearSince = 0;
  hoverTimer = setInterval(() => {
    lastHoverTick = Date.now();
    // 反向监督：看门狗自己是不是也停了。两个定时器互相盯着，谁先死，另一个负责把它拉起来。
    //
    // 冷却期是硬要求：刚 startWatchdog() 出来的定时器，要 5 秒后才第一次执行，
    // 在此之前 lastWatchdogTick 必然还是旧值。若不给 15 秒冷却，轮询（每 90ms）会在
    // 它跑起来之前就把它再杀掉 —— 无限重启，看门狗形同虚设，还会同步刷日志写满磁盘。
    // 所以判定条件必须是「启动已满 15 秒」且「最后一次 tick 已超过 20 秒」两条同时成立。
    if (lastWatchdogTick && Date.now() - lastWatchdogTick > 20000
        && Date.now() - watchdogStartedAt > 15000) {
      dbg('GUARD: 看门狗停摆 ' + Math.round((Date.now() - lastWatchdogTick) / 1000) + 's -> 重启');
      watchdogRestartCount += 1;
      if (watchdogTimer) clearInterval(watchdogTimer);
      watchdogTimer = null;
      startWatchdog();
    }
    // 状态对账：内部标志位必须和窗口的真实几何一致，否则状态机会一直跑错分支
    reconcileState();
    // 可见性守卫：期望在屏幕上就必须真的看得见（错位后 90ms 内自动合拢）
    enforceVisibilityGuard();
    // 常驻快照：每 30 秒一行，下次再卡住时现场证据直接在日志里，不用靠猜
    if (Date.now() - lastStateDumpAt > 30000) { lastStateDumpAt = Date.now(); dumpState(); }
    if (!win || win.isDestroyed() || dockMode === 'float') {
      nearStreak = 0; awaySince = 0; nearSince = 0; return;
    }
    if (userHidden) { nearStreak = 0; awaySince = 0; nearSince = 0; return; }
    const m = pointerDip();
    if (!m) return;
    const wa = m.wa;
    const b = win.getBounds();

    if (isCollapsed) {
      awaySince = 0;
      blockSince = 0;
      // 点击唤出模式：鼠标划边绝不自动展开，只有小把手的点击能把面板叫出来。
      // 每秒兜底看一眼把手窗口还在不在（主窗口重建 / 换显示器后可能丢）。
      if (wakeMode === 'handle' && dockMode !== 'float') {
        if (Date.now() - lastHandleCheckAt > 1000) {
          lastHandleCheckAt = Date.now();
          ensureHandleWindow();
        }
        nearStreak = 0; nearSince = 0;
        return;
      }
      const zone = isNearEdge(m, dockMode, wa);
      if (DIAG && Date.now() - lastDiagAt > 500) {
        lastDiagAt = Date.now();
        dbg('tick collapsed mouse=' + m.x.toFixed(0) + ',' + m.y.toFixed(0)
          + ' wa=' + wa.x + ',' + wa.y + ',' + wa.width + 'x' + wa.height
          + ' mode=' + dockMode + ' zone=' + zone + ' armed=' + hoverArmed
          + ' block=' + Math.max(0, hoverBlockUntil - Date.now())
          + ' flap=' + Math.max(0, flapGuardUntil - Date.now()));
      }
      if (!zone) { hoverArmed = true; nearStreak = 0; nearSince = 0; return; }  // 离开唤出区 → 复位
      // 长按兜底：不管 armed / 冷却 / 刹车处于什么状态，鼠标在唤出区待够久就无条件弹出。
      // 这样哪怕还有没考虑到的状态 bug，也只让你多等不到 1 秒，绝不会彻底失灵。
      if (!nearSince) nearSince = Date.now();
      const peekMs = zone === 'hot' ? SENS.force : SENS.warm;
      if (Date.now() - nearSince >= peekMs) {
        nearSince = 0; nearStreak = 0; hoverArmed = false;
        dbg('force-peek(' + zone + '): 鼠标停留 ' + peekMs + 'ms，强制弹出');
        expand();
        return;
      }
      if (zone !== 'hot') return;                     // 宽松带只走长按，不做快速触发
      if (!hoverArmed || Date.now() < hoverBlockUntil || Date.now() < flapGuardUntil) return;
      nearStreak++;
      if (nearStreak >= HOVER_CONFIRM) { nearStreak = 0; nearSince = 0; hoverArmed = false; expand(); }
      return;
    }

    // 展开态：鼠标离开窗口（含缓冲带）并持续 LEAVE_DELAY 才收起
    nearSince = 0;
    let inside;
    if (dockMode === 'top') {
      // 顶部条横向不占满屏幕，所以只判纵向：鼠标还在面板上下 LEAVE_PAD 范围内就算"还在用"。
      // 之前下方缓冲给到 LEAVE_PAD*3（102 DIP），结果鼠标都移到面板下方 70 像素了面板还挂着不收，
      // 用户感觉就是"移开了也不归位"。这里改回和标准一致的 34，移开即收。
      inside = m.y >= b.y - LEAVE_PAD && m.y <= b.y + b.height + LEAVE_PAD;
    } else {
      inside = m.x >= b.x - LEAVE_PAD && m.x <= b.x + b.width + LEAVE_PAD
            && m.y >= b.y - LEAVE_PAD && m.y <= b.y + b.height + LEAVE_PAD;
    }
    if (inside) { awaySince = 0; blockSince = 0; return; }

    // 鼠标已经在外面了，这时还挡着不让收起的只剩这几个"临时状态位"。
    // 图钉是用户主动锁的，尊重它；其余三个是程序自己设的量，一旦漏清就再也没人管
    // （详情页关了但 IPC 没送到、看门狗重建窗口后没复位……），
    // 表现就是面板赖在屏幕上纹丝不动、像整个程序卡死。
    // 兜底：挡满 60 秒就把它们全部复位并强制收起，日志里写清楚是被谁挡的。
    if (isPinned || Date.now() - BOOT_AT < BOOT_GRACE) { awaySince = 0; blockSince = 0; return; }
    const blocked = detailOpen || Date.now() < keepOpenUntil || Date.now() < flapGuardUntil;
    if (blocked) {
      if (!blockSince) { blockSince = Date.now(); awaySince = 0; return; }
      if (Date.now() - blockSince > 60000) {
        dbg('GUARD: 面板被临时状态卡住 ' + Math.round((Date.now() - blockSince) / 1000)
          + 's（detail=' + detailOpen + ' keep=' + Math.max(0, keepOpenUntil - Date.now())
          + 'ms flap=' + Math.max(0, flapGuardUntil - Date.now()) + 'ms）-> 复位并收起');
        detailOpen = false; keepOpenUntil = 0; flapGuardUntil = 0; blockSince = 0; awaySince = 0;
        collapse();
        return;
      }
      awaySince = 0;
      return;
    }
    blockSince = 0;
    if (!awaySince) { awaySince = Date.now(); return; }
    if (Date.now() - awaySince >= LEAVE_DELAY) { awaySince = 0; collapse(); }
  }, POLL_MS);
}

/**
 * 重建贴边轮询。
 *
 * 为什么必须是"重建"而不是"接着用"：nearSince / awaySince / blockSince / nearStreak
 * 这几个计时基准都是 startHoverWatch 闭包里的局部变量，外面根本碰不到。
 * 系统休眠唤醒后 Date.now() 会整段跳跃，这些基准算出来的时长就会离谱到
 * 让状态机做出错误决定。清掉定时器重建闭包 = 一次性把它们全部归零，最干净。
 */
function restartHoverWatch() {
  if (hoverTimer) clearInterval(hoverTimer);
  hoverTimer = null;
  lastHoverTick = Date.now();
  startHoverWatch();
}

/**
 * 系统休眠 / 锁屏时，主进程里的定时器会跟着沉寂很长一段时间。
 * 唤醒后 Date.now() 整段跳跃，贴边状态机里那些基于时间戳的判定就会做出错误决定
 * （面板永远唤不出来，或者赖在屏幕上不收）。日志里能看到"心跳超时 34809204ms"这种
 * 长达 9 小时的跳变，就是这么来的。
 * 所以唤醒后直接重建定时器 + 复位所有时间基准，不留下任何被拉长的时间差。
 */
function watchPowerEvents() {
  try {
    powerMonitor.on('suspend', () => { dbg('POWER: 系统休眠'); });
    powerMonitor.on('resume', () => { dbg('POWER: 系统唤醒'); onSystemWake(); });
    powerMonitor.on('unlock-screen', () => { dbg('POWER: 屏幕解锁'); onSystemWake(); });
  } catch (e) { dbg('POWER: 注册电源事件失败 ' + (e && e.message || e)); }
}

function onSystemWake() {
  lastHeartbeat = Date.now();      // 别在唤醒瞬间被误判成"页面死了"而白白 reload 一次
  restartHoverWatch();             // 重建贴边轮询（闭包里的计时基准一并归零）
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = null;
  startWatchdog();
  ensureWindow(true);              // 窗口可能被系统挪到屏幕外了，先拉回来
  dbg('POWER: 定时器已重建');
}

/**
 * 全局热键 Ctrl+Alt+M：强制展开 / 收起面板。
 *
 * 最后一道兜底。不管贴边状态机处于什么状态（armed 卡在 false、冷却没过、抖动刹车中、
 * 详情页标记漏清、窗口被推到屏幕外），按一下就能把面板叫出来，再按一下收回去。
 * 有了它，"卡住就只能退出程序重开"这件事就彻底结束了。
 */
/** 热键备选清单：Ctrl+Alt+M 常被 QQ / 输入法抢走，注册失败就顺位往下试 */
const HOTKEY_CANDIDATES = [
  { acc: 'CommandOrControl+Alt+M', text: 'Ctrl + Alt + M' },
  { acc: 'CommandOrControl+Alt+N', text: 'Ctrl + Alt + N' },
  { acc: 'CommandOrControl+Shift+M', text: 'Ctrl + Shift + M' },
];
let activeHotkey = '';   // 实际生效的那个，托盘菜单显示它

function registerHotkey() {
  if (activeHotkey) {
    try { globalShortcut.unregister(activeHotkey); } catch (e) { /* ignore */ }
    activeHotkey = '';
  }
  const fire = () => {
    dbg('HOTKEY: 按下  hidden=' + isEffectivelyHidden() + ' collapsed=' + isCollapsed);
    ensureWindow(true);
    reconcileState();
    if (isEffectivelyHidden()) {
      enforceVisibleNow('热键');
      verifyWindowAfterShow();
      dbg('HOTKEY: 面板不可见（最小化/隐藏）-> 已恢复显示');
      return;
    }
    // 用真实几何判断当前形态，不信任 isCollapsed
    const shown = isReallyExpanded();
    // 一律先清掉所有临时状态位，再决定展开还是收起
    detailOpen = false; keepOpenUntil = 0;
    flapGuardUntil = 0; hoverBlockUntil = 0; blockSince = 0;
    stopAnim();
    if (shown) { collapse(); dbg('HOTKEY: 强制收起面板'); }
    else { expand(true); dbg('HOTKEY: 强制展开面板'); }
  };
  for (const c of HOTKEY_CANDIDATES) {
    try {
      if (globalShortcut.register(c.acc, fire)) {
        activeHotkey = c.text;
        dbg('HOTKEY: 已注册 ' + c.acc);
        return;
      }
      dbg('HOTKEY: ' + c.acc + ' 被占用，试下一个');
    } catch (e) { dbg('HOTKEY: 注册异常 ' + (e && e.message || e)); }
  }
  activeHotkey = '';
  dbg('HOTKEY: 全部候选都被占用，请改用托盘菜单「修复窗口」');
}

/** 往 memo-data.json 的 settings 里合并写入，不碰 notes */
function persistSettings(patch) {
  try {
    const d = readData();
    d.settings = Object.assign({}, d.settings || {}, patch);
    writeData(d);
  } catch (e) { /* 写不进去不影响使用 */ }
}

/* ---------- 开机自启 ----------
   不用 app.setLoginItemSettings：免打包运行时它会把 electron.exe 本身注册成启动项，
   下次开机很可能起不来。这里直接写注册表 Run 项，指向静默启动的 .vbs，最稳。 */
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_NAME = 'MemoDesk';

function autoStartCommand() {
  const root = process.env.SystemRoot || 'C:\\Windows';
  const wscript = path.join(root, 'System32', 'wscript.exe');
  const vbs = path.join(__dirname, '..', '启动备忘录.vbs');
  return `"${wscript}" "${vbs}"`;
}

/**
 * 注册表读写的两条通道。
 * 重要：**PowerShell 优先，reg.exe 只作兜底**。
 * 受限环境（公司终端安全软件 / 沙箱）里 reg.exe 在黑名单上，调用它不只是失败——
 * 安全策略会连带把发起调用的整个进程树结束掉，表现就是"应用刚启动就消失"。
 * 另外结果做缓存，避免每次刷托盘菜单都拉起一个 PowerShell 进程。
 */
let autoStartCache = null;
let autoStartPending = false;

/**
 * 查开机自启。**绝不能在托盘菜单里同步拉 PowerShell** —— execFileSync 会把整个主进程
 * 卡住直到超时（最长 15 秒），期间贴边轮询、补间动画、IPC 全部停摆，
 * 用户看到的就是"右键托盘之后整个程序卡死了"。改成后台异步查 + 缓存。
 */
function psRegQueryAsync() {
  const psCmd = `$v=[Microsoft.Win32.Registry]::GetValue('HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run','${RUN_NAME}',$null); if($v){exit 0}else{exit 1}`;
  return new Promise((resolve) => {
    try {
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', psCmd],
        { windowsHide: true, timeout: 8000 }, (err) => {
          if (!err) return resolve(true);
          if (err && err.code === 1) return resolve(false);   // 正常返回"没设置"
          resolve(null);                                      // PowerShell 起不来
        });
    } catch (e) { resolve(null); }
  });
}

function prefetchAutoStart() {
  if (process.platform !== 'win32') return Promise.resolve(false);
  if (autoStartCache !== null || autoStartPending) return Promise.resolve(autoStartCache || false);
  autoStartPending = true;
  return psRegQueryAsync().then((v) => {
    autoStartPending = false;
    if (v !== null) { autoStartCache = v; return v; }
    return new Promise((resolve) => {
      try {
        execFile('reg', ['query', RUN_KEY, '/v', RUN_NAME], { windowsHide: true, timeout: 5000 }, (err, out) => {
          autoStartCache = !err && String(out || '').indexOf(RUN_NAME) !== -1;
          resolve(autoStartCache);
        });
      } catch (e) { autoStartCache = false; resolve(false); }
    });
  });
}

function getAutoStart() {
  if (process.platform !== 'win32') return false;
  if (autoStartCache !== null) return autoStartCache;
  prefetchAutoStart().then(() => refreshTrayMenu());   // 查到再刷一次菜单，不同步等
  return false;
}

async function setAutoStart(on) {
  if (process.platform !== 'win32') return false;
  const ok = await psRegAsync(on ? 'add' : 'delete');
  if (ok) { autoStartCache = !!on; return true; }
  try {
    if (on) {
      await execFileAsync('reg', ['add', RUN_KEY, '/v', RUN_NAME, '/t', 'REG_SZ', '/d', autoStartCommand(), '/f']);
    } else {
      await execFileAsync('reg', ['delete', RUN_KEY, '/v', RUN_NAME, '/f']);
    }
    autoStartCache = !!on;
    return true;
  } catch (err) {
    console.error('[memo] autostart failed:', err && err.message || err);
    return false;
  }
}

function execFileAsync(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 8000 }, (err) => (err ? reject(err) : resolve(true)));
  });
}

function psRegAsync(action) {
  const subKey = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
  const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const psCmd = action === 'query'
    ? `$v=[Microsoft.Win32.Registry]::GetValue('HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run','${RUN_NAME}',$null); if($v){exit 0}else{exit 1}`
    : action === 'add'
      ? `[Microsoft.Win32.Registry]::SetValue('HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run','${RUN_NAME}',${lit(autoStartCommand())},[Microsoft.Win32.RegistryValueKind]::String)`
      : `[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Run',$true).DeleteValue('${RUN_NAME}',$false)`;
  return execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', psCmd]).catch((err) => {
    console.error('[memo] autostart powershell failed:', err && err.message || err);
    return false;
  });
}

/* ---------- 开机自启 / 图片IPC ---------- */
ipcMain.handle('get-autostart', () => getAutoStart());
ipcMain.handle('set-autostart', (e, on) => setAutoStart(!!on));

/** 把图片二进制存到 userData/images，返回文件名 */
function saveImageBuffer(buf, ext) {
  try {
    fs.mkdirSync(IMAGES_DIR(), { recursive: true });
    let e = String(ext || 'png').toLowerCase().replace(/^\./, '');
    if (e === 'jpeg') e = 'jpg';
    if (e === 'svg+xml') e = 'svg';
    if (!/^(png|jpg|gif|bmp|webp|svg)$/.test(e)) e = 'png';
    const name = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}.${e}`;
    fs.writeFileSync(path.join(IMAGES_DIR(), name), buf);
    return name;
  } catch (err) {
    console.error('[memo] save image buffer:', err && err.message || err);
    return null;
  }
}

/**
 * 直接读系统剪贴板拿图片。比渲染进程的 paste 事件可靠得多：
 * 截图工具 / 微信 QQ 截图 / 网页右键复制图片，走的都是 CF_DIB、CF_BITMAP 这些原生格式，
 * DOM 的 clipboardData 有时拿不到，但 clipboard.readImage() 一定能拿到。
 */
function readClipboardImage() {
  try {
    const img = clipboard.readImage();
    if (img && !img.isEmpty()) return saveImageBuffer(img.toPNG(), 'png');
  } catch (err) {
    console.error('[memo] paste-image native:', err && err.message || err);
  }
  // 退路：在资源管理器里「复制」的图片文件
  try {
    if (clipboard.availableFormats().includes('FileNameW')) {
      const raw = clipboard.readBuffer('FileNameW').toString('utf16le');
      const files = raw.split('\u0000').filter(Boolean);
      const hit = files.find((f) => /\.(png|jpe?g|gif|bmp|webp|svg)$/i.test(f) && fs.existsSync(f));
      if (hit) return saveImageBuffer(fs.readFileSync(hit), path.extname(hit).slice(1));
    }
  } catch (err) {
    console.error('[memo] paste-image file:', err && err.message || err);
  }
  return null;
}

ipcMain.handle('paste-image', () => readClipboardImage());

/** 把 base64 图片存到 userData/images，返回文件名 */
ipcMain.handle('save-image', (e, dataUrl) => {
  try {
    const m = /^data:image\/([a-zA-Z+]+);base64,/.exec(dataUrl || '');
    if (!m) return null;
    fs.mkdirSync(IMAGES_DIR(), { recursive: true });
    let ext = m[1].toLowerCase();
    if (ext === 'jpeg') ext = 'jpg';
    if (ext === 'svg+xml') ext = 'svg';
    const name = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    fs.writeFileSync(path.join(IMAGES_DIR(), name), Buffer.from(dataUrl.slice(m[0].length), 'base64'));
    return name;
  } catch (err) {
    console.error('[memo] save image:', err && err.message || err);
    return null;
  }
});

ipcMain.handle('open-image', (e, name) => {
  try {
    const ret = shell.openPath(path.join(IMAGES_DIR(), path.basename(String(name))));
    return ret;
  } catch (err) { return String(err); }
});

/** 图片用自定义协议读取，避免和页面 CSP 打架 */
function registerImageProtocol() {
  try {
    protocol.registerFileProtocol('memoimg', (req, cb) => {
      const raw = decodeURIComponent(
        String(req.url).replace(/^memoimg:\/\//, '').replace(/^\/+/, '').split('?')[0].split('#')[0]
      );
      const file = path.join(IMAGES_DIR(), path.basename(raw));
      fs.access(file, fs.constants.F_OK, (err) => {
        cb(err ? { statusCode: 404 } : { path: file });
      });
    });
  } catch (err) {
    console.error('[memo] protocol error:', err && err.message || err);
  }
}

/* ---------- 托盘 ---------- */
function buildTray() {
  // 图标直接在内存里生成，**不往磁盘写文件**。
  // 之前是 writeFileSync(ICON_FILE()) + new Tray(路径)：数据目录一旦写不进去就
  // 降级成 createEmpty() 空图标，Windows 上表现为"托盘里根本没有图标"——
  // 用户点了减号隐藏窗口后就再也找不回来了。内存图标彻底避开这个坑。
  try {
    const { nativeImage } = require('electron');
    tray = new Tray(nativeImage.createFromBuffer(makeIconPng()));
  } catch (err) {
    console.error('[memo] tray error:', err && err.stack || err);
    try { tray = new Tray(require('electron').nativeImage.createEmpty()); } catch (e2) {}
  }
  if (!tray) return;
  tray.setToolTip('侧边备忘录');
  refreshTrayMenu(trayToggle);
  tray.on('click', trayToggle);
}

function refreshTrayMenu(toggle) {
  if (!tray) return;
  if (!toggle) toggle = trayToggle;
  const theme = currentTheme();
  const menu = Menu.buildFromTemplate([
    { label: userHidden ? '显示窗口' : '展开 / 收起', click: toggle },
    {
      label: '最小化到托盘（完全隐藏）',
      click: () => hideWindow(),
    },
    {
      label: '修复窗口（面板找不见了点这里）',
      click: () => {
        showWindow();                            // 先 restore + show + focus + 探活
        expand(true);
        dbg('TRAY: 手动修复窗口');
      },
    },
    {
      label: '强制收起 / 复位面板（卡住不动了点这个）',
      click: () => {
        detailOpen = false;
        keepOpenUntil = 0;
        flapGuardUntil = 0;
        hoverBlockUntil = 0;
        blockSince = 0;
        isPinned = false;
        userHidden = false;
        stopAnim();
        if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; }
        ensureWindow(true);
        collapse();
        dbg('TRAY: 手动复位面板状态并强制收起');
      },
    },
    {
      label: activeHotkey
        ? ('快捷键 ' + activeHotkey + '：随时叫出 / 收起面板')
        : '快捷键都被别的软件占用了，请用下面的「修复窗口」',
      enabled: false,
    },
    {
      label: '新建备忘',
      click: () => {
        expand(true);                                  // 先滑出来，再打开编辑面板
        if (win && !win.isDestroyed()) win.webContents.send('open-new');
      },
    },
    {
      label: '锁定展开（不自动收起）',
      type: 'checkbox',
      checked: isPinned,
      click: (item) => {
        isPinned = item.checked;
        if (isPinned) expand(); else scheduleCollapse(300);
        broadcastPanelState();
      },
    },
    { type: 'separator' },
    { label: '窗口位置', enabled: false },
    ...MODES.map((m) => ({
      label: m.label,
      type: 'radio',
      checked: dockMode === m.key,
      click: () => setDockMode(m.key),
    })),
    {
      label: '重置小浮窗位置',
      click: () => {
        floatBounds = null;
        persistSettings({ floatBounds: null });
        if (dockMode === 'float') { isCollapsed = false; applyBounds(true); }
      },
    },
    {
      label: '始终置顶',
      type: 'checkbox',
      checked: true,
      click: (item) => { win && win.setAlwaysOnTop(item.checked); },
    },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: getAutoStart(),
      click: (item) => {
        setAutoStart(item.checked).then(() => refreshTrayMenu());
      },
    },
    { type: 'separator' },
    { label: '贴边灵敏度', enabled: false },
    ...Object.keys(SENS_LEVELS).map((k) => ({
      label: SENS_LEVELS[k].label,
      type: 'radio',
      checked: edgeSens === k,
      click: () => { setEdgeSens(k); refreshTrayMenu(); },
    })),
    ...extMenuItems(),          // EXT HOOK：扩展（手机同步）的菜单项
    { type: 'separator' },
    { label: '窗口样式（切换会重建窗口）', enabled: false },
    ...THEMES.map((t) => ({
      label: t.label,
      type: 'radio',
      checked: theme === t.key,
      click: () => applyTheme(t.key),
    })),
    { type: 'separator' },
    {
      label: '打开数据文件所在目录',
      click: () => shell.showItemInFolder(DATA_FILE()),
    },
    { label: '退出', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

/* ---------- 数据读写 ---------- */
function readData() {
  try {
    const txt = fs.readFileSync(DATA_FILE(), 'utf-8');
    const obj = JSON.parse(txt);
    return Array.isArray(obj) ? { notes: obj, settings: {} } : obj;
  } catch (e) {
    return { notes: [], settings: {} };
  }
}

function writeData(data) {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE()), { recursive: true });
    // 写入前把当前文件备份一份：万一数据被意外覆盖（比如多实例并行写），
    // memo-data.bak.json 里总有上一版可以手工找回
    try {
      if (fs.existsSync(DATA_FILE())) {
        fs.copyFileSync(DATA_FILE(), DATA_FILE() + '.bak.json');
      }
    } catch (e) { /* 备份失败不阻塞正常保存 */ }
    const tmp = DATA_FILE() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, DATA_FILE());
    gcImages(data);
    return true;
  } catch (err) {
    console.error('[memo] write error:', err && err.message || err);
    return false;
  }
}

/** 清理已不被任何备忘引用的图片；为避免误删刚粘贴但还没保存的图，只删 24 小时前的 */
function gcImages(data) {
  try {
    const dir = IMAGES_DIR();
    if (!fs.existsSync(dir)) return;
    const used = new Set();
    (data.notes || []).forEach((n) => (n.images || []).forEach((x) => {
      used.add(path.basename(typeof x === 'string' ? x : x.name));
    }));
    const deadline = Date.now() - 24 * 3600 * 1000;
    fs.readdirSync(dir).forEach((f) => {
      if (used.has(f)) return;
      const st = fs.statSync(path.join(dir, f));
      if (st.mtimeMs < deadline) fs.unlinkSync(path.join(dir, f));
    });
  } catch (e) { /* 清理失败无所谓 */ }
}

const THEMES = [
  { key: 'glass', label: '毛玻璃（半透明）' },
  { key: 'ink', label: '暗夜玻璃' },
  { key: 'light', label: '简约浅色（不透明）' },
];

function currentTheme() {
  return (readData().settings || {}).theme || 'glass';
}

function applyTheme(key) {
  const data = readData();
  data.settings = Object.assign({}, data.settings, { theme: key });
  writeData(data);
  refreshTrayMenu();
  rebuildWindow();
}

/* ---------- IPC ---------- */
ipcMain.handle('load-data', () => readData());

// 渲染进程在打开/关闭详情面板时同步状态，主进程据此暂停自动收起
ipcMain.on('detail-open', (e, open) => {
  detailOpen = !!open;
  if (detailOpen && collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; }
});

// 自测日志通道（GUI 进程拿不到 stdout，只能落文件）
ipcMain.on('selftest-log', (e, line) => dbg('[SELFTEST] ' + line));

// 自动化测试辅助：虚拟鼠标 / 读窗口矩形 / 读工作区
ipcMain.on('fake-mouse', (e, pt) => { fakeMouse = pt || null; });

/**
 * 守卫自检通道。
 * 用来验证"两个定时器互相监督"这套机制真的在跑，而不是在原地空转：
 *   - lastWatchdogTick 必须 **晚于** watchdogStartedAt，否则说明回调一次都没执行过
 *     （2026-10-31 的事故：监控器每 90ms 重启一次看门狗，新定时器活不过 90ms，
 *       日志里刷了 447 条"停摆"记录，实际上心跳检测和窗口救援全程停摆）；
 *   - reviveCount 用来确认"最小化期间不会再被误判成页面已死而反复 reload"。
 */
let reviveCount = 0;
ipcMain.handle('guard-diag', () => ({
  now: Date.now(),
  watchdogStartedAt,
  lastWatchdogTick,
  lastHoverTick,
  lastHeartbeat,
  reviveCount,
  watchdogRestartCount,
  hoverRestartCount,
  userHidden,
  isCollapsed,
  isPinned,
  detailOpen,
  dockMode,
  anim: !!animTimer,
  bounds: win && !win.isDestroyed() ? win.getBounds() : null,
}));

/**
 * 自测用：走一遍完整的「用户最小化 → 等待 → 恢复显示」，并回报期间是否发生过误杀。
 *
 * 整段放在主进程里跑是有讲究的：窗口一旦隐藏，渲染进程的定时器会被 Chromium 节流
 * （隐藏越久对齐越狠，最长能拖到 1 分钟一跳），在那边 sleep 根本不准，
 * 而且页面要是真被 reload 了，测试自己就断了。主进程的 Node 定时器不受影响。
 *
 * 断言的是两件事：
 *   ① 隐藏期间不许判定"页面已死"去 reload（心跳停摆是隐藏窗口的正常生理现象）；
 *   ② 恢复之后窗口必须真的可见、状态位正确 —— 这正是用户报的"打开后没法操作"。
 */
ipcMain.handle('test-hide-cycle', async () => {
  const reviveBefore = reviveCount;
  dbg('[SELFTEST] 模拟用户最小化');
  hideWindow();
  const hiddenVisible = win && !win.isDestroyed() ? win.isVisible() : null;
  await new Promise((r) => setTimeout(r, 11000));    // 心跳阈值 8 秒，等够 11 秒看会不会误杀
  const reviveAfter = reviveCount;
  showWindow();
  await new Promise((r) => setTimeout(r, 1500));
  const b = win && !win.isDestroyed() ? win.getBounds() : null;
  const wa = workArea();
  const onScreen = !!b && b.x < wa.x + wa.width - 30 && b.x + b.width > wa.x + 30
    && b.y < wa.y + wa.height - 30 && b.y + b.height > wa.y + 30;
  const visibleNow = win && !win.isDestroyed() ? win.isVisible() : null;
  const hbFresh = Date.now() - lastHeartbeat < 4000;
  return { reviveBefore, reviveAfter, hiddenVisible, visibleNow, onScreen, hbFresh, userHidden };
});

/**
 * 自测用：模拟"系统休眠 6 小时后唤醒"，验证守卫不会陷入无限重启。
 *
 * 这正是 2026-10-31 事故的确切触发路径：休眠期间定时器全部沉寂，
 * lastWatchdogTick 停留在 6 小时前；唤醒后贴边轮询每次 tick 都判定
 * "看门狗停摆"并重启它，而新定时器要 5 秒后才首次执行 —— 于是它被
 * 每 90ms 重启一次，回调一次都没跑成功，日志里刷出 447 条停摆记录。
 *
 * 修复后：重启一次即把时间戳刷成"现在"，之后 watchdog 正常 tick。
 * 所以这里断言「重启次数最多 1~2 次」且「最终心跳确实在推进」。
 */
ipcMain.handle('test-simulate-wake', async () => {
  const SIX_HOURS = 6 * 3600 * 1000;
  const wdBefore = watchdogRestartCount;
  const hvBefore = hoverRestartCount;
  dbg('[SELFTEST] 模拟休眠 6 小时后唤醒（回拨守卫时间戳）');
  if (lastWatchdogTick) lastWatchdogTick -= SIX_HOURS;
  if (lastHoverTick) lastHoverTick -= SIX_HOURS;
  await new Promise((r) => setTimeout(r, 9000));    // 覆盖 watchdog 一个完整周期（5s）
  return {
    wdRestarts: watchdogRestartCount - wdBefore,
    hvRestarts: hoverRestartCount - hvBefore,
    watchdogFresh: Date.now() - lastWatchdogTick < 12000,
    hoverFresh: Date.now() - lastHoverTick < 3000,
  };
});

/**
 * 自测用：模拟「系统级最小化（Win+D / 显示桌面）→ 再点托盘图标叫回来」。
 *
 * 这条路径和用户主动点托盘菜单「最小化到托盘」**不是一回事**：
 * 系统最小化不经过 hideWindow()，userHidden 仍是 false，
 * 而 Windows 上最小化窗口的 isVisible() 依旧返回 true（Chromium 认为它只是被折叠，不是被隐藏）。
 * 于是托盘点击会误判成"窗口正展开着" → 执行 collapse() 继续收起
 * → 窗口永远卡在最小化状态，用户看到的正是"叫出来了却没法操作"。
 *
 * 断言：最小化之后点托盘，窗口必须真的取消最小化且可见。
 */
ipcMain.handle('test-minimize-cycle', async () => {
  dbg('[SELFTEST] 模拟系统级最小化');
  try { if (win && !win.isDestroyed()) win.minimize(); } catch (e) {}
  await new Promise((r) => setTimeout(r, 1200));
  const during = (win && !win.isDestroyed())
    ? { minimized: !!win.isMinimized(), visible: !!win.isVisible(), userHidden }
    : null;

  dbg('[SELFTEST] 模拟点击托盘图标');
  trayToggle();                                  // 与托盘图标点击走完全相同的代码
  await new Promise((r) => setTimeout(r, 1500));

  const b = (win && !win.isDestroyed()) ? win.getBounds() : null;
  const wa = workArea();
  const onScreen = !!b && b.x < wa.x + wa.width - 30 && b.x + b.width > wa.x + 30
    && b.y < wa.y + wa.height - 30 && b.y + b.height > wa.y + 30;
  const after = (win && !win.isDestroyed())
    ? { minimized: !!win.isMinimized(), visible: !!win.isVisible(), collapsed: isCollapsed, userHidden, onScreen }
    : null;
  return { during, after };
});
/**
 * 自测用：制造「孤儿隐藏窗口」——本次事故的确切现场。
 *
 * 现场特征（2026-10-31 从运行中的实例上实测到）：
 *   窗口 HWND 完好、位置正确、非最小化、非 cloaked，
 *   唯独 WS_VISIBLE 位被清零，而程序内部 isCollapsed 仍是 false（以为展开着）。
 * 后果是贴边轮询认为"已经是展开态"，再也不会去显示它 —— 只能退出重开。
 *
 * 这里人为复现它，然后断言可见性守卫能在 1 秒内自动纠正。
 */
ipcMain.handle('test-hide-orphan', async () => {
  dbg('[SELFTEST] 制造孤儿隐藏窗口（窗口被 hide，但期望仍是可见）');
  ensureWindow(true);
  if (!win || win.isDestroyed()) return { ok: false };

  panelWanted = true;                         // 期望=可见（模拟状态位卡住）
  userHidden = false;
  isCollapsed = false;
  try { win.hide(); } catch (e) {}

  const before = { visible: !!win.isVisible(), minimized: !!win.isMinimized() };
  dbg('test-hide-orphan: 制造完成 visible=' + before.visible);

  // 守卫每 90ms 一次，给 1 秒足够它发现并纠正
  await new Promise((r) => setTimeout(r, 1000));

  const b = (win && !win.isDestroyed()) ? win.getBounds() : null;
  const wa = workArea();
  const onScreen = !!b && b.x < wa.x + wa.width - 30 && b.x + b.width > wa.x + 30
    && b.y < wa.y + wa.height - 30 && b.y + b.height > wa.y + 30;
  const after = (win && !win.isDestroyed())
    ? { visible: !!win.isVisible(), minimized: !!win.isMinimized(),
        collapsed: isCollapsed, userHidden, onScreen }
    : null;

  const fixed = !!after && after.visible === true && after.minimized === false && after.onScreen === true;
  dbg('[SELFTEST] orphan-guard ' + (fixed ? 'PASS' : 'FAIL')
    + ' 孤儿隐藏窗口应被守卫自动恢复可见'
    + (after ? '（visible=' + after.visible + ' minimized=' + after.minimized
        + ' onScreen=' + after.onScreen + '）' : '（窗口没了）'));

  return { ok: true, before, after, fixed };
});

ipcMain.handle('win-bounds', () => (win && !win.isDestroyed() ? win.getBounds() : null));
ipcMain.handle('work-area', () => {
  const wa = workArea();
  return { x: wa.x, y: wa.y, width: wa.width, height: wa.height };
});
ipcMain.handle('dock-mode', () => dockMode);

ipcMain.handle('save-data', (e, data) => {
  const ok = writeData(data);
  extOnSave(data);            // EXT HOOK：让扩展有机会记录删除墓碑等
  return ok;
});

ipcMain.on('expand-panel', () => expand());
ipcMain.on('collapse-panel', () => collapse());
ipcMain.on('hide-window', () => {
  // 从托盘叫回来的瞬间，Windows 常把之前按在按钮上的鼠标事件补发一次，
  // 于是 showWindow 后 2~3 秒又来一条 hide-window（日志里 04:09:34 → 04:09:37 那条），
  // 刚叫出的窗口立刻又被藏回去，用户看到的就是"显示出来是个假界面、卡住"。
  // 真想立刻最小化请用托盘菜单，那条路径不经过这里。
  const since = lastShowAt ? Date.now() - lastShowAt : Infinity;
  if (since < 2500) {
    dbg('IPC: hide-window 忽略（刚显示 ' + Math.round(since) + 'ms，疑似恢复瞬间的重复点击）');
    return;
  }
  hideWindow();
});
ipcMain.on('show-window', () => showWindow());
ipcMain.on('schedule-collapse', () => scheduleCollapse());
ipcMain.on('cancel-collapse', () => {
  if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; }
});
ipcMain.on('set-pinned', (e, pinned) => {
  isPinned = pinned;
  if (pinned) expand(); else scheduleCollapse(400);
});
ipcMain.on('quit-app', () => { app.isQuitting = true; app.quit(); });

// 主题切换：数据由渲染进程写盘，这里只负责按新主题重建窗口
ipcMain.on('rebuild-window', () => rebuildWindow());

ipcMain.on('set-dock-mode', (e, mode) => setDockMode(mode));
ipcMain.on('set-wake-mode', (e, mode) => setWakeMode(mode));
ipcMain.on('handle-open', () => {
  dbg('HANDLE: 点击小把手 -> 展开面板');
  hideHandle();
  userHidden = false;
  panelWanted = true;
  expand(true);
  // 鼠标若已经落在展开后的窗口里，说明用户正准备操作，给很短宽限即可，
  // 移开就立刻收回；若鼠标还在别处（例如从托盘/热键唤出），给足时间让他移过来。
  const hm = pointerDip();
  const hb = win && !win.isDestroyed() ? win.getBounds() : null;
  const hInside = !!(hm && hb && hm.x >= hb.x - 20 && hm.x <= hb.x + hb.width + 20
    && hm.y >= hb.y - 20 && hm.y <= hb.y + hb.height + 20);
  keepOpenUntil = Date.now() + (hInside ? 900 : 4000);
  forceRepaint('把手点击展开');
  resendPanelState();
});
/* 页面恢复可见时主动来拉一次真实状态，不依赖"主进程恰好推过来"的那一条 IPC */
ipcMain.handle('panel-state-now', () => ({
  collapsed: !!isCollapsed, pinned: !!isPinned, mode: dockMode, hidden: !!userHidden,
}));
/* 手动调整页面大小：拖右下角/右边缘时由页面持续送来目标尺寸 */
ipcMain.on('resize-panel', (e, size) => {
  if (!win || win.isDestroyed()) return;
  const w = clamp(Math.round(Number(size && size.w) || 0), 240, 1600);
  const h = clamp(Math.round(Number(size && size.h) || 0), 180, 1400);
  const wa = workArea();
  const exp = expandedBounds(dockMode);
  let x = exp.x, y = exp.y;
  if (dockMode === 'right') {
    x = wa.x + wa.width - w - 8;                       // 右边贴住屏幕，改宽度时左边界跟着走
    y = Math.min(exp.y, Math.max(wa.y, wa.y + wa.height - h - 8));
  } else if (dockMode === 'top') {
    x = wa.x + Math.round((wa.width - w) / 2);
  } else {
    const b = win.getBounds(); x = b.x; y = b.y;      // 小浮窗：以左上角为锚
  }
  panelSizes = Object.assign({}, panelSizes || {}, { [dockMode]: { w, h } });
  // 拖动过程中每次 mousemove 都会走到这里，绝不能逐帧写盘；停下 500ms 再落一次。
  clearTimeout(resizeSaveTimer);
  resizeSaveTimer = setTimeout(() => {
    persistSettings({ panelSizes });
    settleWindow('调整大小完成');        // 拖动结束后收敛一次，不在逐帧 mousemove 里重绘
  }, 500);
  isCollapsed = false;
  keepOpenUntil = Date.now() + 5000;         // 拖尺寸时鼠标常在窗口外，别刚拖完就被自动收起
  try { win.setBounds({ x, y, width: w, height: h }); } catch (e2) {}
});
ipcMain.on('reset-panel-size', () => {
  panelSizes = Object.assign({}, panelSizes || {});
  delete panelSizes[dockMode];
  persistSettings({ panelSizes });
  if (dockMode === 'float') { floatBounds = null; persistSettings({ floatBounds: null }); }
  isCollapsed = false;
  keepOpenUntil = Date.now() + 4000;
  applyBounds(false);
  broadcastPanelState();
  settleWindow('恢复默认大小');
});
/* 自测用：把「真实鼠标原始坐标 → DIP」这一步的结果暴露出来做断言。
   曾经因为多除了一次 scaleFactor，自测（虚拟鼠标）全过而真机彻底唤不出窗口，
   所以这段换算必须被测试覆盖到。 */
ipcMain.handle('probe-pointer', () => {
  let p;
  try { p = screen.getCursorScreenPoint(); } catch (e) { return null; }
  const r = resolvePointer(p);
  return { raw: { x: p.x, y: p.y }, x: r.x, y: r.y, wa: r.wa, bounds: r.bounds };
});

ipcMain.on('reset-float-pos', () => {
  floatBounds = null;
  persistSettings({ floatBounds: null });
  if (dockMode === 'float') { isCollapsed = false; applyBounds(true); }
});

/* ---------- 小浮窗气泡：拖动 + 点击展开 ----------
 * 以前整块气泡是 -webkit-app-region:drag，Windows 接管鼠标后页面连
 * click / dblclick 都收不到 —— 用户看到的就是「气泡能拖，但双击打不开」。
 * 现在气泡是普通可点击区域：
 *   页面用 pointer 事件的 screenX/screenY（屏幕绝对坐标，窗口跟着动也不衰减）
 *   算位移，位移 < 4px 判为点击 -> 主进程展开；否则把增量送过来摆位。
 * 刻意**不**在主进程用 getCursorScreenPoint() 跟随光标：休眠唤醒 / 远程桌面
 * 下这个读数会突然跳几百像素，会把一次普通点击误判成拖动并把窗口甩飞。
 * 位置仍由 win.on('move') 的 rememberFloat 换算并保存，和以前一致。 */
let floatDrag = null;

function endFloatDrag(moved) {
  const d = floatDrag;
  if (!d) return;
  floatDrag = null;
  if (d.timeout) clearTimeout(d.timeout);
  const shouldExpand = !moved && dockMode === 'float' && isCollapsed
    && !userHidden && !app.isQuitting;
  dbg('FLOAT-DRAG: end moved=' + !!moved + ' -> '
      + (shouldExpand ? '点击，展开面板' : '拖动/放弃，保持收起'));
  if (shouldExpand) expand(true);
}

ipcMain.on('float-drag-start', () => {
  endFloatDrag(true);                       // 清掉上一次没收尾的拖动（不展开）
  if (dockMode !== 'float' || !isCollapsed || userHidden || app.isQuitting) return;
  if (!win || win.isDestroyed()) return;
  let base;
  try { base = win.getBounds(); } catch (e) { return; }
  const d = { base, timeout: null };
  floatDrag = d;
  // pointerup 万一丢了（拖出窗口 / 页面被挂起），8 秒后自动收尾
  d.timeout = setTimeout(() => { if (floatDrag === d) endFloatDrag(true); }, 8000);
  dbg('FLOAT-DRAG: start bounds=' + base.x + ',' + base.y + ' '
      + base.width + 'x' + base.height);
});

ipcMain.on('float-drag-move', (e, p) => {
  const d = floatDrag;
  if (!d || !p || !win || win.isDestroyed()) return;
  const dx = Number(p.dx), dy = Number(p.dy);
  if (!isFinite(dx) || !isFinite(dy)) return;
  // 垃圾坐标防护：单次位移过大（休眠唤醒 / 显示器切换）宁可忽略这一帧
  if (Math.abs(dx) > 2000 || Math.abs(dy) > 2000) return;
  try {
    win.setBounds({
      x: Math.round(d.base.x + dx), y: Math.round(d.base.y + dy),
      width: d.base.width, height: d.base.height,
    });
  } catch (err) {}
});

ipcMain.on('float-drag-end', (e, moved) => endFloatDrag(!!moved));

/* ---------- 渲染进程心跳 ----------
 * 渲染进程被外力杀掉时，Electron 常常既不 emit render-process-gone、isCrashed() 也返回 false，
 * webContents.getProcessId() 给的还是另一个活着的进程 —— 主进程用任何"查进程"的办法都会误判。
 * 所以反过来：让页面自己每 2 秒上报心跳，主进程超时收不到 = 页面已死。 */
ipcMain.on('heartbeat', (e, st) => {
  lastHeartbeat = Date.now();
  // 页面每 2 秒把真实 UI 状态带过来。主进程的状态位（详情页 / 图钉）万一和页面对不上，
  // 一律以页面为准 —— 这是"面板赖着不收起"最有效的解药，2 秒内自愈。
  if (!st || typeof st !== 'object') return;
  if (typeof st.detail === 'boolean' && st.detail !== detailOpen) {
    dbg('GUARD: 详情页状态不一致（主进程=' + detailOpen + ' 页面=' + st.detail + '）-> 以页面为准');
    detailOpen = st.detail;
  }
  if (typeof st.pinned === 'boolean' && st.pinned !== isPinned) {
    isPinned = st.pinned;
    persistSettings({ pinned: isPinned });
  }
  // 页面每 2 秒报一次自己看到的收起态。只要和主进程对不上就重发 ——
  // 这是"托盘恢复后出现假界面/点不动"最便宜的自愈手段（2 秒内必然纠正）。
  if (typeof st.collapsed === 'boolean' && st.collapsed !== isCollapsed) {
    dbg('GUARD: 页面收起态不一致（主=' + isCollapsed + ' 页=' + st.collapsed + '）-> 重发状态');
    broadcastPanelState();
    // 重发走的还是同一条可能丢的 IPC 通道；补一条直通渲染进程的摆正动作
    syncPageDomNow();
  }
});

ipcMain.on('revive-window', () => {
  dbg('IPC: revive-window');
  // 统一走 showWindow()：它会先 restore（对付最小化状态）再 show + focus，
  // 并在恢复后主动探活，页面真被冻住时自动 reload。
  showWindow();
  expand(true);
});

ipcMain.on('notify', (e, { title, body }) => {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: ICON_FILE(), silent: false });
  n.show();
});

/* ---------- 实例心跳：用来区分「真有另一个实例在跑」和「锁压根建不出来」 ----------
 *
 * Electron 的 requestSingleInstanceLock() 在两种完全不同的情况下都返回 false：
 *   ① 确实已经有实例在跑（这是正常的，第二个实例应该退出）
 *   ② 锁文件**根本创建不出来** —— Windows 下报 ERROR_ACCESS_DENIED(5)，
 *      目录权限异常、残留锁文件、安全软件拦截都可能导致。
 *
 * 以前不区分这两种情况，一律 app.quit()：一旦撞上 ②，用户双击就是"毫无反应"，
 * 看上去跟程序彻底坏了一模一样，而且**没有任何日志**，极难排查。
 *
 * 两种错误的代价严重不对等：多开一个实例最多有点乱，
 * 而一个都开不出来等于程序完全不可用。所以这里用心跳文件区分：
 * 只有真正活着的实例才会持续刷新它。
 */
const HEARTBEAT_FILE = path.join(app.getPath('userData'), '.instance-hb');
let hbTimer = null;

function startInstanceHeartbeat() {
  const beat = () => { try { fs.writeFileSync(HEARTBEAT_FILE, String(Date.now())); } catch (e) {} };
  beat();
  try { if (hbTimer) clearInterval(hbTimer); } catch (e) {}
  hbTimer = setInterval(beat, 3000);
  try { hbTimer.unref(); } catch (e) {}   // 别因为这个定时器拖着进程不让退出
}

/** 最近 6 秒内有人刷新过心跳 = 确实还有一个活着的实例（容忍漏掉一次 3 秒的心跳） */
function anotherInstanceAlive() {
  try {
    return (Date.now() - fs.statSync(HEARTBEAT_FILE).mtimeMs) < 6000;
  } catch (e) { return false; }
}

// 干净退出时立刻抹掉心跳：否则用户关掉程序 6 秒内再双击，
// 新实例会误以为老实例还活着而拒绝启动 —— 又变成"打不开"。
app.on('before-quit', () => {
  try { if (hbTimer) clearInterval(hbTimer); } catch (e) {}
  try { fs.unlinkSync(HEARTBEAT_FILE); } catch (e) {}
});

/* ---------- 生命周期 ---------- */
app.whenReady().then(() => {
  let gotLock = false;
  try { gotLock = app.requestSingleInstanceLock(); }
  catch (e) { dbg('BOOT: 申请单实例锁抛异常 ' + e.message); }

  if (!gotLock) {
    if (anotherInstanceAlive()) {
      // ① 确实有实例活着 —— 第二个实例必须**干净地**退出。
      // 之前只调 app.quit()：若此刻还有未收尾的定时器 / IPC，退出会被拖延，
      // 结果就是系统托盘里出现两个一模一样的图标，用户点到的未必是管事的那个
      // —— 表现又是"点了没反应"。所以加一道 exit 兜底，确保它真的走人。
      dbg('BOOT: 检测到已有一个存活实例 -> 本实例干净退出');
      app.quit();
      setTimeout(() => { try { app.exit(0); } catch (e) {} }, 1500);
      return;
    }
    // ② 没有活着的实例，说明是锁文件本身建不出来。清掉可能的残留再试一次；
    //    仍然不行就降级为"允许多开"——宁肯多开，也不能让用户面对打不开的程序。
    dbg('BOOT: 单实例锁不可用且无存活实例 -> 清理残留锁后重试');
    const ud = app.getPath('userData');
    for (const n of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']) {
      try { fs.unlinkSync(path.join(ud, n)); } catch (e) {}
    }
    try { gotLock = app.requestSingleInstanceLock(); } catch (e) {}
    dbg('BOOT: 重试结果 gotLock=' + gotLock + (gotLock ? '（已恢复）' : ' -> 降级为允许多开'));
  } else {
    // 用户重新装了个 verifier；程序关掉 USER.Pro 2 然后照样能跑起来：这是预期行为。
    startInstanceHeartbeat();
  }
  startInstanceHeartbeat();
  // 第二个实例会被拦下；此时必须真的把窗口叫出来，否则用户双击启动"像没反应"
  app.on('second-instance', () => {
    dbg('second-instance: 已有实例被唤起');
    panelWanted = true;                        // 用户又双击了 = 想看面板
    enforceVisibleNow('second-instance');
    verifyWindowAfterShow();
  });

  const s = readData().settings || {};
  if (MODES.some((m) => m.key === s.dockMode)) dockMode = s.dockMode;
  wakeMode = (s.wakeMode === 'handle') ? 'handle' : 'hover';
  panelSizes = (s.panelSizes && typeof s.panelSizes === 'object') ? s.panelSizes : null;
  floatBounds = s.floatBounds || null;
  if (SENS_LEVELS[s.edgeSens]) { edgeSens = s.edgeSens; SENS = SENS_LEVELS[edgeSens]; }

  registerImageProtocol();
  createWindow();
  loadExtensions();          // EXT HOOK：加载 extensions/ 下的扩展
  registerHotkey();          // 叫出面板的快捷键（要早于 buildTray，菜单里得显示实际生效的那个）
  buildTray();
  startHoverWatch();
  startWatchdog();           // WATCHDOG：每 5 秒体检一次，窗口坏了自动修
  watchPowerEvents();        // 休眠/解锁后重建定时器、复位时间基准
  prefetchAutoStart();       // 开机自启状态后台查一次，避免以后同步拉 PowerShell 卡住主进程
  // 开机自启时若以参数 --hidden 启动则先收起
  if (process.argv.includes('--hidden')) setTimeout(() => collapse(), 1500);
  // 点击唤出模式：启动就直接收起、只留边缘小把手，不用等用户先把鼠标移开
  if (wakeMode === 'handle' && dockMode !== 'float' && !process.argv.includes('--selftest')) {
    setTimeout(() => { if (!userHidden) collapse(); }, 1400);
  }

  // 自检：验证"最小化到托盘"——4 秒后隐藏、8 秒后恢复
  if (process.argv.includes('--test-min')) {
    setTimeout(() => { dbg('test-min: hide'); hideWindow(); }, 4000);
    setTimeout(() => { dbg('test-min: show'); showWindow(); }, 8000);
  }

  // 自检：人为制造「标志位说已展开、窗口却完全在屏幕外」，验证对账机制能自己纠正回来。
  // 这正是反复复发的「面板看不见、划边也没反应、只能退出重开」的成因。
  if (process.argv.includes('--test-reconcile')) {
    setTimeout(() => {
      try {
        isCollapsed = false;                                        // 谎称已展开
        win.setBounds({ x: 3000, y: 40, width: 380, height: 1152 }); // 实际推到屏幕外
        dbg('test-reconcile: 已制造错位（isCollapsed=false，窗口 x=3000）');
      } catch (e) { dbg('test-reconcile: 制造错位失败 ' + (e && e.message || e)); }
    }, 5000);
    setTimeout(() => {
      const fixed = win && !win.isDestroyed() && win.getBounds().x < 2500;
      dbg('[SELFTEST] reconcile ' + (fixed ? 'PASS' : 'FAIL')
        + ' 错位窗口应被对账机制拉回屏幕内（当前 x=' + (win && !win.isDestroyed() ? win.getBounds().x : '?') + '）');
      setTimeout(() => app.quit(), 800);
    }, 9000);
  }

  // 自检：往剪贴板写一张图，再走一遍读取流程，确认粘贴链路通
  if (process.argv.includes('--test-paste')) {
    setTimeout(() => {
      try {
        const { nativeImage } = require('electron');
        clipboard.writeImage(nativeImage.createFromBuffer(makeIconPng()));
        console.log('[memo] test-paste result:', readClipboardImage());
      } catch (err) { console.error('[memo] test-paste error:', err && err.stack || err); }
    }, 2500);
  }
});

app.on('window-all-closed', () => {
  // 托盘常驻，不退出
});

app.on('before-quit', () => { app.isQuitting = true; });
