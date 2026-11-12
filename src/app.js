/* 侧边备忘录 —— 渲染进程 */
const $ = (id) => document.getElementById(id);
const api = window.memoAPI;

/* 全局错误兜底：把渲染进程里的异常写进主进程的 debug.log。
   遇到过"点按钮完全没反应"却查不到原因的情况（多半是某行 JS 抛错中断了整个流程），
   界面看起来是死的、控制台又看不到，这条日志是唯一的线索。 */
window.addEventListener('error', (e) => {
  try {
    const f = String(e.filename || '').split(/[\\/]/).pop();
    api.selftestLog('UI-ERROR ' + (e.message || '') + ' @' + f + ':' + (e.lineno || 0));
  } catch (_) { /* 连日志都写不了就算了 */ }
});
window.addEventListener('unhandledrejection', (e) => {
  try {
    const r = e.reason;
    api.selftestLog('UI-REJECT ' + ((r && (r.stack || r.message)) || r || ''));
  } catch (_) { }
});

let state = { notes: [], settings: {} };
let filterTag = '全部';
let searchKey = '';
let editingId = null;   // 正在编辑的备忘 id，null = 列表页
let pinned = false;
let armed = false;      // 鼠标曾进入过窗口，才允许自动收起
let saveTimer = null;
let editItems = [];     // 详情页里的要求清单 { text, done }
let editImages = [];    // 详情页里的图片文件名
let pendingDeleteId = null;
let lastDeleted = null;   // { note, index } —— 删完给一次反悔机会

/* 外观：主题 + 曲线排布 */
let theme = 'glass';
let curveOn = true;
let curveAmp = 40;
let dockMode = 'right';   // right | top | float，跟主进程保持一致
let wakeMode = 'hover';   // hover=划边自动摊开 | handle=边缘细把手点击才展开
let toastTimer = null;
const isGlass = (t) => t === 'glass' || t === 'ink';

/* ---------- 轻提示 ----------
   toast('文字')              普通提示，1.9s 后消失
   toast('文字','ok','撤销',fn) 带撤销按钮，6s 内可点 */
function toast(msg, kind, actionLabel, onAction) {
  const el = $('toast');
  if (!el) return;
  const act = $('toastAct');
  $('toastText').textContent = msg;
  act.hidden = !actionLabel;
  act.onclick = null;
  if (actionLabel) {
    act.textContent = actionLabel;
    act.onclick = () => { hideToast(); if (onAction) onAction(); };
  }
  el.className = 'toast' + (kind ? ' ' + kind : '') + (actionLabel ? ' has-act' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, actionLabel ? 6000 : 1900);
}

function hideToast() {
  const el = $('toast');
  if (!el) return;
  el.hidden = true;
  const act = $('toastAct');
  if (act) { act.hidden = true; act.onclick = null; }
}

/* ---------- 工具 ---------- */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const pad = (n) => String(n).padStart(2, '0');

function toLocalInput(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function dayDiff(iso) {
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const d = new Date(iso); d.setHours(0, 0, 0, 0);
  return Math.round((d - t) / 86400000);
}

/** 返回 { text, cls } */
function dueInfo(iso) {
  if (!iso) return { text: '无截止日期', cls: 'none' };
  const d = new Date(iso);
  if (isNaN(d)) return { text: '无截止日期', cls: 'none' };
  const diff = dayDiff(iso);
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (diff < 0) return { text: `已逾期 ${-diff} 天 · ${md}`, cls: 'over' };
  if (diff === 0) return { text: `今天到期 · ${hm}`, cls: 'today' };
  if (diff === 1) return { text: `明天到期 · ${hm}`, cls: 'soon' };
  if (diff <= 3) return { text: `${md} · 剩 ${diff} 天`, cls: 'today' };
  if (diff <= 7) return { text: `${md} · 剩 ${diff} 天`, cls: 'soon' };
  return { text: `${md} · 剩 ${diff} 天`, cls: '' };
}

/* ---------- 生效时段：开始 / 结束 ----------
 * 两个可选字段 startAt / endAt（datetime-local 本地时间字符串），与 due 完全独立，
 * 不改重复备忘的 due 锚点，也不碰刚修好的「本期保持已完成」逻辑。
 * 一次性备忘：直接按这两个时间点判断。
 * 重复备忘：只取「时分」当每期时段模板，日期取当前期锚点 due 的日期；
 *   结束时刻早于开始时刻视为跨午夜（如 22:00→01:00），自动顺延一天。
 * 状态仅影响显示：未开始 / 已结束都不算完成，不会自动打勾或隐藏。
 */
const WIN_LABEL = { upcoming: '未开始', active: '进行中', ended: '已结束' };
let winSig = null;

function parseLocal(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

function windowText(s, e) {
  const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const mdhm = (d) => `${d.getMonth() + 1}/${d.getDate()} ${hm(d)}`;
  if (s && e) return `${mdhm(s)} → ${mdhm(e)}`;
  if (s) return `${mdhm(s)} 起`;
  return `截至 ${mdhm(e)}`;
}

/** 返回 { start, end, recurring, text }；没填任何时段返回 null */
function windowFor(n) {
  const s = parseLocal(n.startAt), e = parseLocal(n.endAt);
  if (!s && !e) return null;
  const recurring = !!(n.repeat && n.repeat !== 'none');
  if (!recurring) return { start: s, end: e, recurring: false, text: windowText(s, e) };
  const anchor = parseLocal(n.due) || new Date();
  const at = (base, plusDays) => {
    if (!base) return null;
    const d = new Date(anchor);
    d.setHours(base.getHours(), base.getMinutes(), 0, 0);
    if (plusDays) d.setDate(d.getDate() + plusDays);
    return d;
  };
  const start = at(s, 0);
  let end = at(e, 0);
  if (start && end && end <= start) end = at(e, 1);   // 跨午夜
  return { start, end, recurring: true, text: windowText(start, end) };
}

/** 'none' | 'upcoming' | 'active' | 'ended' */
function windowState(n, now) {
  const w = windowFor(n);
  if (!w) return 'none';
  const t = (now || new Date()).getTime();
  if (w.start && t < w.start.getTime()) return 'upcoming';
  if (w.end && t >= w.end.getTime()) return 'ended';
  return 'active';
}

/** 跨过开始 / 结束点时自动把卡片状态刷新，不必等用户重启 */
function windowSignature() {
  return state.notes.map((n) => {
    const w = windowFor(n);
    return `${n.id}:${windowState(n)}:${w && w.start ? w.start.getTime() : 0}`;
  }).join('|');
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

/* ---------- 重复备忘：每天 / 每周固定 / 每月固定 ----------
   重复卡片在列表里始终只有一张，代表「当前这一期」：
   - 打勾完成后**本期保持已完成**（灰掉、排到列表末尾、不再提醒），
     直到下一期开始才自动变回未完成、清单重置；当天/本周绝不会又冒出来；
   - due 仍会推进到下一期当内部锚点，doneUntil 记录「到什么时候之前都算做完了」；
   - 万一某一期没做完就被跨过去了，下次看到它时自动补跳到今天（连续次数清零）；
   - 卡片上用 🔁 标出重复规则，完成时会提示下一期的时间。
   数据字段：repeat = none|daily|weekly|monthly
             repeatDays = [0..6]（每周，0=周日）；repeatDay = 1..31，0=月末（每月）
             doneUntil = ISO 时间，本期已完成到这个时间点为止 */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'];
const isRepeat = (n) => !!(n && n.repeat && n.repeat !== 'none');

/** 把重复规则翻译成人话：每天 / 每周一、三 / 每月15号 */
function repeatText(n) {
  if (!isRepeat(n)) return '';
  if (n.repeat === 'daily') return '每天';
  if (n.repeat === 'weekly') {
    const ds = (n.repeatDays || []).slice().sort((a, b) => WEEK_ORDER.indexOf(a) - WEEK_ORDER.indexOf(b));
    return ds.length ? `每周${ds.map((d) => WEEK_CN[d]).join('、')}` : '每周';
  }
  if (n.repeat === 'monthly') return n.repeatDay ? `每月${n.repeatDay}号` : '每月月末';
  return '';
}

/** 取 y 年 m 月 day 号的那一天，时分沿用 src；day=0 或超过当月天数时取当月最后一天 */
function monthDate(y, m, day, src) {
  const last = new Date(y, m + 1, 0).getDate();
  const d = new Date(src);
  d.setFullYear(y, m, day === 0 ? last : Math.min(day, last));
  return d;
}

/** 在 src 之后的下一次发生时间（保留原来的时分） */
function nextOccur(n, src) {
  const base = new Date(src);
  if (n.repeat === 'daily') {
    const d = new Date(base); d.setDate(d.getDate() + 1); return d;
  }
  if (n.repeat === 'weekly') {
    const days = (n.repeatDays && n.repeatDays.length) ? n.repeatDays : [base.getDay()];
    for (let i = 1; i <= 7; i++) {                     // 往后找第一个命中的星期
      const c = new Date(base); c.setDate(c.getDate() + i);
      if (days.indexOf(c.getDay()) !== -1) return c;
    }
    const c = new Date(base); c.setDate(c.getDate() + 7); return c;
  }
  if (n.repeat === 'monthly') {
    const day = n.repeatDay || 0;
    let y = base.getFullYear(), m = base.getMonth();
    for (let k = 0; k < 13; k++) {
      const c = monthDate(y, m, day, base);
      if (c > base) return c;
      m += 1; if (m > 11) { m = 0; y += 1; }
    }
  }
  return null;
}

/** 打勾完成 → 本期保持已完成，锚点推到下一期，累加连续次数。
 *  旧实现顺延后立刻把 done 清成 false，用户看到的就是「勾了又冒出来」，
 *  只有把整张卡片删掉才不会再出现。现在用 doneUntil 记住「什么时候才轮到下一期」。 */
function bumpRecur(n) {
  const now = new Date();
  let d = new Date(n.due || now);
  for (let i = 0; i < 500; i++) {
    const nx = nextOccur(n, d);
    if (!nx) return false;
    d = nx;
    if (d > now) break;
  }
  n.due = toLocalInput(d);      // 内部锚点：下一期（排序 / 提醒 / 补跳用）
  n.doneUntil = n.due;          // 到这个时间之前，本期都算已完成
  n.done = true;                // 关键：不再立刻清成 false
  n.notified = false;           // 下一期到点时允许再提醒
  n.streak = (n.streak || 0) + 1;
  n.doneCount = (n.doneCount || 0) + 1;
  n.lastDoneAt = Date.now();
  return true;
}

/** 下一期到了：把「本期已完成」复位成新的一期（清单重置、可再提醒）。
 *  由 load() 和 checkReminder() 各调一次，关机跨期也能补上。 */
function expireCompletedRecur() {
  const now = Date.now();
  let changed = false;
  state.notes.forEach((n) => {
    if (!isRepeat(n) || !n.done || !n.doneUntil) return;
    const t = new Date(n.doneUntil).getTime();
    if (!isFinite(t) || t > now) return;
    n.done = false;
    n.doneUntil = '';
    n.notified = false;
    if (Array.isArray(n.items)) n.items.forEach((it) => { it.done = false; });
    changed = true;
  });
  return changed;
}

/**
 * 重复备忘不设截止日期：由规则推算出「当前这一期」的时间，写进 due 只当作内部锚点
 * （用于排序、提醒、打勾后顺延），界面上不再把它当截止日期展示。
 * 时间沿用原来那条备忘的时分；新备忘默认当天 23:59。
 */
function alignRepeatDue(n) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const prev = n.due ? new Date(n.due) : null;
  const validPrev = prev && !isNaN(prev.getTime()) ? prev : null;
  const hh = validPrev ? validPrev.getHours() : 23;
  const mm = validPrev ? validPrev.getMinutes() : 59;
  let d = new Date(today);
  if (n.repeat === 'weekly') {
    const days = (n.repeatDays && n.repeatDays.length) ? n.repeatDays : [today.getDay()];
    d = null;
    for (let i = 0; i < 7; i++) {                    // 从今天起往后找第一个命中的星期
      const c = new Date(today); c.setDate(c.getDate() + i);
      if (days.indexOf(c.getDay()) !== -1) { d = c; break; }
    }
    if (!d) d = new Date(today);
  } else if (n.repeat === 'monthly') {
    const day = n.repeatDay || 0;
    let y = today.getFullYear(), m = today.getMonth();
    d = null;
    for (let k = 0; k < 13; k++) {
      const c = monthDate(y, m, day, today);
      if (c >= today) { d = c; break; }
      m += 1; if (m > 11) { m = 0; y += 1; }
    }
    if (!d) d = new Date(today);
  }
  d.setHours(hh, mm, 0, 0);
  return toLocalInput(d);
}

/**
 * 判断某个日期是否符合这条重复备忘的规则（每周要看是不是指定的星期，每月要看是不是指定的号）。
 * 每天永远符合。
 */
function matchesRepeatRule(n, d) {
  if (n.repeat === 'weekly') {
    const days = (n.repeatDays && n.repeatDays.length) ? n.repeatDays : null;
    return !days || days.indexOf(d.getDay()) !== -1;
  }
  if (n.repeat === 'monthly') {
    const day = n.repeatDay || 0;
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    return d.getDate() === (day === 0 ? last : Math.min(day, last));
  }
  return true;
}

/**
 * 把 due 拉回到「当前这一期」：只在锚点过期了、或者压根没落在规则指定的星期/号数上时才动。
 * 已经排在未来、又符合规则的那一期原样保留（今天刚打勾顺延出去的那种，绝不能被拉回来）。
 * 返回是否发生了变化。
 */
function syncRepeatDue(n) {
  const cur = n.due ? new Date(n.due) : null;
  const valid = cur && !isNaN(cur.getTime()) ? cur : null;
  if (valid && valid.getTime() > Date.now() && matchesRepeatRule(n, valid)) return false;
  const target = alignRepeatDue(n);
  if (target === n.due) return false;
  n.due = target;
  n.notified = false;
  return true;
}

/** 启动时把重复备忘的锚点理顺：老数据可能还留着当初当一次性备忘填的截止日期 */
function alignRepeatAll() {
  let changed = false;
  state.notes.forEach((n) => { if (isRepeat(n) && syncRepeatDue(n)) changed = true; });
  return changed;
}

/** 已经过期却还没做的期数自动补跳到「今天」——早上打开看到的就是当天这一期 */
function rollRecurring() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let changed = false;
  state.notes.forEach((n) => {
    if (!isRepeat(n) || !n.due) return;
    let d = new Date(n.due);
    let moved = false, guard = 0;
    while (d < today && guard++ < 500) {
      const nx = nextOccur(n, d);
      if (!nx) break;
      d = nx; moved = true;
    }
    if (!moved) return;
    n.due = toLocalInput(d);
    n.notified = false;
    n.done = false;
    n.streak = 0;                       // 有一期没做完就被跨过去了，连续记录从头算
    if (Array.isArray(n.items)) n.items.forEach((it) => { it.done = false; });
    changed = true;
  });
  return changed;
}

/** 「明天 09:00」这样的短日期，用在提示条里 */
function shortDue(iso) {
  if (!iso) return '未设置时间';
  const d = new Date(iso);
  if (isNaN(d)) return '未设置时间';
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const diff = dayDiff(iso);
  if (diff === 0) return `今天 ${hm}`;
  if (diff === 1) return `明天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

/* ---------- 数据 ---------- */
async function load() {
  const d = await api.load();
  state.notes = Array.isArray(d && d.notes) ? d.notes : [];
  state.settings = (d && d.settings) || {};
  initMonthDayOptions();
  // 每天/每周的备忘：本期做完了但已跨到下一期的先复位，
  // 再补跳过期的期数、把还留着旧截止日期的本期时间对齐
  let rollChanged = expireCompletedRecur();
  if (rollRecurring()) rollChanged = true;
  if (alignRepeatAll()) rollChanged = true;
  if (rollChanged) await api.save(pack());
  if (state.settings.sortBy) $('sortBy').value = state.settings.sortBy;
  pinned = !!state.settings.pinned;
  theme = state.settings.theme || 'glass';
  curveOn = state.settings.curve !== false;
  curveAmp = state.settings.curveAmp || 46;
  dockMode = ['right', 'top', 'float'].includes(state.settings.dockMode) ? state.settings.dockMode : 'right';
  wakeMode = state.settings.wakeMode === 'handle' ? 'handle' : 'hover';
  applyThemeUI();
  syncDockUI();
  syncPinBtn();
  render();
}

function applyThemeUI() {
  document.body.dataset.theme = theme;
  $('curveRange').value = curveAmp;
  $('curveSwitch').classList.toggle('on', curveOn);
  $('btnCurve').classList.toggle('curve-on', curveOn);
  $('list').classList.toggle('curve-on', curveOn);
  document.querySelectorAll('#themePop .tp-item').forEach((b) => b.classList.toggle('active', b.dataset.theme === theme));
}

/* ---------- 窗口位置 ---------- */
function syncDockUI() {
  document.body.classList.remove('mode-right', 'mode-top', 'mode-float');
  document.body.classList.add('mode-' + dockMode);
  document.querySelectorAll('#dockPop .tp-item').forEach((b) => {
    if (b.dataset.dock) b.classList.toggle('active', b.dataset.dock === dockMode);
    if (b.dataset.wake) b.classList.toggle('active', b.dataset.wake === wakeMode);
  });
  $('btnDock').classList.toggle('active', dockMode !== 'right' || wakeMode === 'handle');
}

/** 切换窗口位置：先把设置完整落盘，再让主进程重启程序。
    重启是用户要求的，也是唯一能彻底避开"切完模式卡死"的做法。 */
async function chooseDock(mode) {
  dockMode = mode;
  state.settings.dockMode = mode;
  syncDockUI();
  clearTimeout(saveTimer);
  try { await api.save(pack()); } catch (e) { /* 主进程自己也会写一份 */ }
  toast('窗口位置已切换，程序正在自动重启…', 'warn');
  setTimeout(() => api.setDockMode(mode), 120);
}

function chooseWake(mode) {
  wakeMode = mode === 'handle' ? 'handle' : 'hover';
  state.settings.wakeMode = wakeMode;
  syncDockUI();
  save();
  api.setWakeMode(wakeMode);
  toast(wakeMode === 'handle' ? '已改为：点边缘细把手才打开' : '已改为：鼠标碰到边缘就摊开', 'ok');
}

function setDockPop(open) {
  $('dockPop').hidden = !open;
  syncPopMask();
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    let ok = false;
    try { ok = await api.save(pack()); } catch (e) { ok = false; }
    // 以前这里不检查返回值：写盘失败时界面照样显示"已删除/已保存"，
    // 用户完全不知情，直到重开才发现数据没变。现在立刻给出可见提示。
    if (!ok) toast('保存失败：数据没能写入磁盘，请检查程序目录是否可写', 'err');
  }, 300);
}

function pack() {
  return {
    notes: state.notes,
    settings: Object.assign({}, state.settings, {
      pinned, sortBy: $('sortBy').value, theme, curve: curveOn, curveAmp, dockMode, wakeMode,
    }),
  };
}

/** 切换主题：半透明 ↔ 不透明需要重建窗口（transparent 是创建期选项） */
async function setTheme(next) {
  const prev = theme;
  theme = next;
  state.settings.theme = next;
  applyThemeUI();
  clearTimeout(saveTimer);
  await api.save(pack());
  if (isGlass(prev) !== isGlass(next)) api.rebuild();
  else curveLayout();
}

function toggleCurve() {
  curveOn = !curveOn;
  state.settings.curve = curveOn;
  applyThemeUI();
  save();
  curveLayout();
}

/* ---------- 渲染 ---------- */
function visibleNotes() {
  let list = state.notes.slice();
  if (filterTag !== '全部') list = list.filter((n) => (n.tags || []).includes(filterTag));
  if (searchKey) {
    const k = searchKey.toLowerCase();
    list = list.filter((n) =>
      (n.title || '').toLowerCase().includes(k) ||
      (n.body || '').toLowerCase().includes(k) ||
      (n.tags || []).join(',').toLowerCase().includes(k) ||
      (n.items || []).map((i) => i.text || '').join(',').toLowerCase().includes(k)
    );
  }
  const pRank = { high: 0, mid: 1, low: 2 };
  const sortBy = $('sortBy').value;
  list.sort((a, b) => {
    if (!!a.done !== !!b.done) return a.done ? 1 : -1;      // 未完成在前
    if (sortBy === 'priority') return (pRank[a.priority] ?? 3) - (pRank[b.priority] ?? 3);
    if (sortBy === 'created') return (b.createdAt || 0) - (a.createdAt || 0);
    // 按截止日期
    if (!a.due && !b.due) return (pRank[a.priority] ?? 3) - (pRank[b.priority] ?? 3);
    if (!a.due) return 1;
    if (!b.due) return -1;
    return new Date(a.due) - new Date(b.due);
  });
  return list;
}

/* ---------- 曲线排布：卡片沿一条抛物线贴着右侧墙面流动 ---------- */
function curveLayout() {
  const list = $('list');
  const cards = list.querySelectorAll('.card');
  if (!cards.length) return;
  // 顶部模式是多列铺开的，曲线排布会互相打架，直接让位
  if (!curveOn || dockMode === 'top') {
    cards.forEach((c) => { c.style.transform = ''; c.style.opacity = ''; });
    return;
  }
  const viewH = list.clientHeight || 1;
  const half = viewH / 2;
  const viewCenter = list.scrollTop + half;
  for (const c of cards) {
    const raw = (c.offsetTop + c.offsetHeight / 2 - viewCenter) / half;
    const dy = Math.max(-1, Math.min(1, raw));       // -1(上) ~ 1(下)
    const bend = 1 - dy * dy;                        // 越靠中间越突出
    const x = -curveAmp * bend;
    const ry = dy * 6;                               // 绕右侧竖轴微微偏转
    const z = -Math.abs(dy) * 26;
    const sc = 1 - Math.abs(dy) * 0.025;
    const base = c.classList.contains('done') ? 0.5 : 1;
    const op = Math.max(0.3, base * (1 - Math.abs(raw) * 0.15));
    c.style.transform = `translateX(${x.toFixed(2)}px) translateZ(${z.toFixed(1)}px) rotateY(${ry.toFixed(2)}deg) scale(${sc.toFixed(3)})`;
    c.style.opacity = op.toFixed(3);
  }
}

function render() {
  const list = visibleNotes();
  const pending = state.notes.filter((n) => !n.done).length;
  $('count').textContent = pending;
  $('edgeCount').textContent = pending;   // 小浮窗收起后气泡上显示的待办数
  renderChips();

  const box = $('list');
  box.innerHTML = list.map((n) => {
    const d = dueInfo(n.due);
    const tags = (n.tags || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('');
    const body = (n.body || '').trim();
    const items = n.items || [];
    const doneCnt = items.filter((i) => i.done).length;
    const itemBadge = items.length
      ? `<span class="c-item-badge ${doneCnt === items.length ? 'all' : ''}">☑ ${doneCnt}/${items.length}</span>`
      : '';
    const imgs = n.images || [];
    const rpt = repeatText(n);
    const rptBadge = rpt
      ? `<span class="c-rpt-badge" title="重复备忘：勾完成后本期保持已完成，到下一期才重新开始">🔁 ${escapeHtml(rpt)}${
          n.done ? ' · 本期已完成' : ''
        }${n.streak > 1 ? ` · 连续${n.streak}次` : ''}</span>`
      : '';
    const names = imgs.map((x) => (typeof x === 'string' ? x : x.name));
    const thumbs = names.length
      ? `<div class="c-thumbs">${names.slice(0, 3).map((nm) => `<span class="c-thumb"><img src="${api.imgUrl(nm)}" alt="" /></span>`).join('')}${
          names.length > 3 ? `<span class="c-thumb more">+${names.length - 3}</span>` : ''
        }</div>`
      : '';
    // 重复备忘不显示「剩 X 天 / 已逾期 X 天」，页面上只留 🔁 规则徽标
    const dueBadge = !rpt
      ? `<span class="due ${d.cls}">${n.done ? '已完成' : d.text}</span>`
      : '';
    const w = windowFor(n);
    const ws = windowState(n);
    const winBadge = w
      ? `<span class="c-win-badge ${ws}" title="生效时段">${WIN_LABEL[ws]} · ${escapeHtml(w.text)}</span>`
      : '';
    return `
      <div class="card pri-${n.priority || 'low'} ${n.done ? 'done' : ''} ${!rpt && d.cls === 'over' && !n.done ? 'overdue' : ''} ${ws !== 'none' ? 'win-' + ws : ''}" data-id="${n.id}">
        <div class="c-del" data-act="del" title="删除">🗑</div>
        <div class="c-head">
          <div class="c-check" data-act="toggle">✓</div>
          <div class="c-title">${escapeHtml(n.title || '（无标题）')}</div>
        </div>
        ${body ? `<div class="c-body">${escapeHtml(body)}</div>` : ''}
        ${thumbs}
        <div class="c-foot">
          ${winBadge}
          ${dueBadge}
          ${itemBadge}
          ${rptBadge}
          ${tags}
        </div>
      </div>`;
  }).join('');

  if (state.notes.length === 0) {
    box.innerHTML = '';
    $('empty').hidden = false;
  } else if (list.length === 0) {
    box.innerHTML = `<div class="empty"><span>没有匹配的卡片</span></div>`;
    $('empty').hidden = true;
  } else {
    $('empty').hidden = true;
  }
  requestAnimationFrame(curveLayout);
}

function renderChips() {
  const tags = new Set();
  state.notes.forEach((n) => (n.tags || []).forEach((t) => tags.add(t)));
  const arr = ['全部', ...Array.from(tags)];
  $('tagChips').innerHTML = arr
    .map((t) => `<button class="chip ${t === filterTag ? 'active' : ''}" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</button>`)
    .join('');
}

/* ---------- 详情 / 编辑 ---------- */
function openDetail(id) {
  const n = id ? state.notes.find((x) => x.id === id) : null;
  editingId = n ? n.id : null;
  $('fTitle').value = n ? n.title || '' : '';
  $('fBody').value = n ? n.body || '' : '';
  $('fDue').value = n && n.due ? n.due : '';
  $('fStartAt').value = n && n.startAt ? n.startAt : '';
  $('fEndAt').value = n && n.endAt ? n.endAt : '';
  $('fTags').value = n ? (n.tags || []).join(', ') : '';
  $('fDone').checked = n ? !!n.done : false;
  setPrio(n ? n.priority || 'mid' : 'mid');
  setRepeat(n ? n.repeat || 'none' : 'none');
  const anchor = n && n.due ? new Date(n.due) : new Date();
  setWeekdays(n && Array.isArray(n.repeatDays) && n.repeatDays.length ? n.repeatDays : [anchor.getDay()]);
  $('fMonthDay').value = String(n && n.repeatDay ? n.repeatDay : anchor.getDate());
  syncRepeatUI();
  updateDueHint();
  renderTagSuggest();
  editItems = n ? (n.items || []).map((i) => ({ text: i.text || '', done: !!i.done })) : [];
  editImages = n ? (n.images || []).map((x) => (typeof x === 'string' ? x : x.name)).filter(Boolean) : [];
  renderChecklist();
  renderImages();
  $('detail').hidden = false;
  $('btnDelete').hidden = !n;
  hideConfirm();
  api.setDetailOpen(true);      // 编辑中不自动收起
  $('fTitle').focus();
}

function closeDetail() {
  $('detail').hidden = true;
  editingId = null;
  editItems = [];
  editImages = [];
  hideConfirm();
  api.setDetailOpen(false);
}

/* ---------- 要求清单 ---------- */
function renderChecklist() {
  const box = $('fItems');
  if (!box) return;
  if (!editItems.length) {
    box.innerHTML = `<div class="checklist-empty">还没有条目，点下面「+ 添加一项」</div>`;
  } else {
    box.innerHTML = editItems.map((it, idx) => `
      <div class="ci ${it.done ? 'checked' : ''}" data-idx="${idx}">
        <input type="checkbox" data-role="ck" ${it.done ? 'checked' : ''} />
        <input type="text" data-role="tx" value="${escapeHtml(it.text)}" placeholder="要求、注意事项…" />
        <button class="ci-del" data-role="rm" title="移除">×</button>
      </div>`).join('');
  }
  updateItemsProgress();
}

function updateItemsProgress() {
  const el = $('itemsProgress');
  if (!el) return;
  if (!editItems.length) { el.textContent = ''; return; }
  const done = editItems.filter((i) => i.done).length;
  el.textContent = `完成 ${done}/${editItems.length}`;
}

$('fItems').addEventListener('input', (e) => {
  const row = e.target.closest('.ci');
  if (!row) return;
  const idx = parseInt(row.dataset.idx, 10);
  if (Number.isNaN(idx) || !editItems[idx]) return;
  if (e.target.dataset.role === 'ck') {
    editItems[idx].done = e.target.checked;
    row.classList.toggle('checked', e.target.checked);
    updateItemsProgress();
  } else if (e.target.dataset.role === 'tx') {
    editItems[idx].text = e.target.value;
  }
});

$('fItems').addEventListener('click', (e) => {
  const rm = e.target.closest('[data-role="rm"]');
  if (!rm) return;
  const idx = parseInt(rm.closest('.ci').dataset.idx, 10);
  if (Number.isNaN(idx)) return;
  editItems.splice(idx, 1);
  renderChecklist();
});

$('btnAddItem').addEventListener('click', () => {
  editItems.push({ text: '', done: false });
  renderChecklist();
  const rows = $('fItems').querySelectorAll('input[type="text"]');
  if (rows.length) rows[rows.length - 1].focus();
});

/* ---------- 图片 ---------- */
function renderImages() {
  const box = $('fImages');
  if (!box) return;
  box.innerHTML = editImages.map((nm, idx) => `
    <div class="img-cell" data-idx="${idx}">
      <img src="${api.imgUrl(nm)}" alt="" data-role="view" title="点击用系统看图软件打开" />
      <button class="img-del" data-role="rm" title="移除">×</button>
    </div>`).join('');
  $('btnClearImg').hidden = editImages.length === 0;
}

$('fImages').addEventListener('click', (e) => {
  const cell = e.target.closest('.img-cell');
  if (!cell) return;
  const idx = parseInt(cell.dataset.idx, 10);
  if (Number.isNaN(idx)) return;
  if (e.target.closest('[data-role="rm"]')) {
    editImages.splice(idx, 1);
    renderImages();
  } else if (e.target.closest('[data-role="view"]')) {
    api.openImage(editImages[idx]);
  }
});

$('btnPasteImg').addEventListener('click', async () => {
  const ok = await pasteFromClipboard();
  if (ok) toast('图片已粘贴', 'ok');
  else toast('剪贴板里没有图片，先截图或复制一张', 'warn');
});
$('btnPickImg').addEventListener('click', () => $('fileImg').click());
$('fileImg').addEventListener('change', (e) => {
  addImageFiles(e.target.files);
  e.target.value = '';
});
$('btnClearImg').addEventListener('click', () => {
  editImages = [];
  renderImages();
});

/** 从剪贴板取图片：优先走主进程的原生剪贴板（截图工具 / 微信截图 / 网页复制图都拿得到） */
async function pasteFromClipboard() {
  const name = await api.pasteImage();
  if (!name) return false;
  if ($('detail').hidden) openDetail(null);   // 在列表页粘贴 → 自动新建一条
  editImages.push(name);
  renderImages();
  return true;
}

/** 从一次 paste/drop 事件里挑出图片文件 */
function collectImageFiles(dt) {
  const files = [];
  if (!dt) return files;
  if (dt.files && dt.files.length) {
    for (const f of dt.files) files.push(f);
  } else if (dt.items && dt.items.length) {
    for (const it of dt.items) {
      if (it.kind === 'file' && String(it.type).indexOf('image/') === 0) {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
  }
  return files.filter((f) => String(f.type || '').indexOf('image/') === 0);
}

function clipboardHasText(dt) {
  if (!dt || !dt.types) return false;
  if (!dt.types.includes('text/plain')) return false;
  try { return !!(dt.getData('text/plain') || '').trim(); } catch (e) { return true; }
}

/** Ctrl+V：有图片就存图；有文字就让它正常粘到输入框里 */
document.addEventListener('paste', async (e) => {
  const dt = e.clipboardData || window.clipboardData;
  const imgs = collectImageFiles(dt);
  if (imgs.length) {
    e.preventDefault();
    if ($('detail').hidden) openDetail(null);
    addImageFiles(imgs);
    toast('图片已粘贴', 'ok');
    return;
  }
  // 剪贴板里是文字 → 让它正常粘到输入框里，不抢
  if (clipboardHasText(dt)) return;
  // DOM 拿不到文件时（部分截图工具只给裸位图），走主进程的原生剪贴板
  e.preventDefault();
  const ok = await pasteFromClipboard();
  if (ok) toast('图片已粘贴', 'ok');
  else toast('剪贴板里没有图片，先截图或复制一张', 'warn');
});

/** 直接把图片文件拖进来 */
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer) return;
  dragDepth++;
  if (!$('detail').hidden) $('imgDrop').classList.add('drag');
});
window.addEventListener('dragover', (e) => { e.preventDefault(); });
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('imgDrop').classList.remove('drag');
});
window.addEventListener('drop', (e) => {
  dragDepth = 0;
  $('imgDrop').classList.remove('drag');
  const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
  const imgs = files.filter((f) => String(f.type || '').indexOf('image/') === 0);
  if (!imgs.length) return;
  e.preventDefault();
  if ($('detail').hidden) openDetail(null);
  addImageFiles(imgs);
  toast('图片已添加', 'ok');
});

function addImageFiles(fileList) {
  const arr = Array.from(fileList || []);
  if (!arr.length) return;
  arr.forEach((f) => {
    const fr = new FileReader();
    fr.onload = async () => {
      const name = await api.saveImage(fr.result);
      if (name) { editImages.push(name); renderImages(); }
    };
    fr.readAsDataURL(f);
  });
}

function setPrio(p) {
  document.querySelectorAll('#fPrio button').forEach((b) => b.classList.toggle('active', b.dataset.prio === p));
}
function getPrio() {
  const b = document.querySelector('#fPrio button.active');
  return b ? b.dataset.prio : 'mid';
}

/* ---------- 重复控件的读写 ---------- */
function initMonthDayOptions() {
  const sel = $('fMonthDay');
  if (!sel || sel.options.length) return;
  let html = '<option value="0">每月最后一天</option>';
  for (let i = 1; i <= 31; i++) html += `<option value="${i}">每月 ${i} 号</option>`;
  sel.innerHTML = html;
}

function setRepeat(r) {
  document.querySelectorAll('#fRepeat button').forEach((b) => b.classList.toggle('active', b.dataset.rpt === r));
}
function getRepeat() {
  const b = document.querySelector('#fRepeat button.active');
  return b ? b.dataset.rpt : 'none';
}
function uiWeekdays() {
  return Array.from(document.querySelectorAll('#fWeekdays button.active'))
    .map((b) => parseInt(b.dataset.wd, 10));
}
function setWeekdays(days) {
  const arr = days || [];
  document.querySelectorAll('#fWeekdays button')
    .forEach((b) => b.classList.toggle('active', arr.indexOf(parseInt(b.dataset.wd, 10)) !== -1));
}
function syncRepeatUI() {
  const r = getRepeat();
  const recur = r !== 'none';
  $('rptWeekly').hidden = r !== 'weekly';
  $('rptMonthly').hidden = r !== 'monthly';
  // 设了重复就不要截止日期了：隐藏那一栏，换成一行说明
  const rptObj = { repeat: r, repeatDays: uiWeekdays(), repeatDay: parseInt($('fMonthDay').value, 10) || 0 };
  $('dueField').hidden = recur;
  $('dueLocked').hidden = !recur;
  $('winHint').textContent = recur
    ? '重复备忘只取「时分」当每期时段（例：每周三 10:00→11:40），日期由重复规则决定。'
    : '留空 = 不限时间。到点自动切换「未开始 / 进行中 / 已结束」，不会自动打勾、不会隐藏。';
  if (recur) {
    $('dueLocked').innerHTML = `<b>${escapeHtml(repeatText(rptObj))}</b>重复 · 不设截止日期，`
      + `完成后本期保持已完成，到下一期自动重新开始`;
  }
  if (!recur) { $('rptTip').textContent = '一次性备忘，完成后归档'; return; }
  const txt = repeatText(rptObj);
  $('rptTip').textContent = `${txt}重复 · 完成后自动跳到下一次`;
}

function updateDueHint() {
  const v = $('fDue').value;
  const el = $('dueHint');
  if (!v) { el.textContent = '未设置截止日期'; el.className = 'due-hint'; return; }
  const d = dueInfo(v);
  el.textContent = d.text;
  el.className = 'due-hint ' + (d.cls === 'over' ? 'over' : d.cls === 'today' ? 'today' : '');
}

function renderTagSuggest() {
  const tags = new Set();
  state.notes.forEach((n) => (n.tags || []).forEach((t) => tags.add(t)));
  const arr = Array.from(tags).slice(0, 8);
  $('tagSuggest').innerHTML = arr.map((t) => `<button data-tag="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join('');
}

function saveFromForm() {
  const title = $('fTitle').value.trim();
  const body = $('fBody').value;
  let due = $('fDue').value;
  let startAt = $('fStartAt').value.trim();
  let endAt = $('fEndAt').value.trim();
  // 结束早于开始：多半是填反了，自动对调并提示，别存一份永远判不了状态的数据
  if (startAt && endAt) {
    const ds = parseLocal(startAt), de = parseLocal(endAt);
    if (ds && de && de < ds) {
      const tmp = startAt; startAt = endAt; endAt = tmp;
      toast('结束时间早于开始时间，已自动对调', 'warn');
    }
  }
  const tags = $('fTags').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  const done = $('fDone').checked;
  const priority = getPrio();
  const repeat = getRepeat();
  const repeatDays = repeat === 'weekly' ? uiWeekdays().slice() : [];
  const repeatDay = repeat === 'monthly' ? (parseInt($('fMonthDay').value, 10) || 0) : 0;
  const cur = editingId ? state.notes.find((x) => x.id === editingId) : null;

  // 什么都没填就点保存：直接退出，不落盘空标题。
  // 编辑已有备忘时也是直接退出、保持原来的内容不变，不会把它清成空白。
  const items = editItems.filter((i) => (i.text || '').trim());
  if (!title && !body.trim() && !items.length && !editImages.length) {
    closeDetail();
    toast('内容为空，已取消', 'warn');
    return;
  }
  // 有内容但没写标题：拿正文首行 / 第一条要求补一个，别留「无标题」
  const finalTitle = title
    || (body.trim() ? body.trim().split('\n')[0].slice(0, 24) : '')
    || (items[0] ? items[0].text.trim().slice(0, 24) : '')
    || (editImages.length ? '（图片备忘）' : '');

  // 重复备忘没有截止日期：面板上那一栏已隐藏，这里按规则推算「当前这一期」的时间当内部锚点，
  // 用户输入 / 以前残留的截止日期只在规则对不上时才重排，已经排好的未来一期不动
  if (repeat !== 'none') {
    const tmp = { repeat, repeatDays, repeatDay, due: cur ? cur.due : '' };
    syncRepeatDue(tmp);
    due = tmp.due;
  }
  const finalDue = due;

  let bumped = false;
  const n = cur;
  if (editingId) {
    if (n) {
      const prevDue = n.due;                       // 得在覆盖前记下来，否则改了日期不会重新提醒
      const prevDone = !!n.done;
      Object.assign(n, {
        title: finalTitle, body, due: finalDue, tags, done, priority,
        startAt, endAt,
        repeat, repeatDays: repeatDays.slice(), repeatDay,
        items: items.slice(), images: editImages.slice(),
        updatedAt: Date.now(),
      });
      if (finalDue !== prevDue) n.notified = false;
      // 在编辑页里勾「已完成」的重复备忘，跟列表上打勾一样：本期保持已完成
      if (repeat !== 'none') {
        if (done && !prevDone && bumpRecur(n)) bumped = true;
        else if (!done && prevDone) n.doneUntil = '';   // 撤销完成，别留下期的完成标记
      }
    }
  } else {
    state.notes.push({
      id: uid(), title: finalTitle, body, due: finalDue, tags, done, priority,
      startAt, endAt,
      repeat, repeatDays: repeatDays.slice(), repeatDay,
      items: items.slice(), images: editImages.slice(),
      createdAt: Date.now(), updatedAt: Date.now(), notified: false,
      streak: 0, doneCount: 0,
    });
  }
  save();
  closeDetail();
  render();
  if (bumped) toast('本期已完成，到下一期会自动重新开始', 'ok');
}

/* ---------- 删除：卡片上的 🗑 / 详情页的删除，都走同一个确认框 ---------- */
$('btnDelete').addEventListener('click', () => {
  if (editingId) askDelete(editingId);
  else closeDetail();
});

function askDelete(id) {
  const n = state.notes.find((x) => x.id === id);
  if (!n) return;
  pendingDeleteId = id;
  $('cfTitle').textContent = `删除「${n.title || '（无标题）'}」？`;
  $('cfDesc').textContent = '删除后无法恢复，包括里面的要求清单和图片。';
  $('confirmMask').hidden = false;
}

function hideConfirm() {
  $('confirmMask').hidden = true;
  pendingDeleteId = null;
}

$('cfCancel').addEventListener('click', hideConfirm);
$('cfOk').addEventListener('click', () => {
  const id = pendingDeleteId;
  hideConfirm();
  if (id) deleteNote(id);
});

/** 删除一条备忘，并留 6 秒的撤销窗口 */
function deleteNote(id) {
  const idx = state.notes.findIndex((n) => n.id === id);
  if (idx < 0) return;
  const note = state.notes[idx];
  state.notes.splice(idx, 1);
  lastDeleted = { note, index: idx };
  save();
  if (editingId === id) closeDetail();
  render();
  toast(`已删除「${note.title || '（无标题）'}」`, '', '撤销', () => {
    if (!lastDeleted) return;
    const { note, index } = lastDeleted;
    lastDeleted = null;
    state.notes.splice(Math.min(index, state.notes.length), 0, note);
    save();
    render();
    toast('已恢复', 'ok');
  });
}

/* ---------- 事件 ---------- */
$('btnNew').addEventListener('click', () => openDetail(null));
$('btnBack').addEventListener('click', closeDetail);
$('btnSave').addEventListener('click', saveFromForm);
$('fDue').addEventListener('input', updateDueHint);

$('btnPin').addEventListener('click', () => {
  pinned = !pinned;
  syncPinBtn();
  api.setPinned(pinned);
  save();
});
function syncPinBtn() {
  $('btnPin').classList.toggle('active', pinned);
  $('btnPin').textContent = pinned ? '📍' : '📌';
}
$('btnHide').addEventListener('click', () => api.collapse());
// 最小化：整个窗口隐藏，只剩右下角托盘图标；点托盘图标（或菜单「显示窗口」）叫回来
$('btnMin').addEventListener('click', () => api.hideWindow());

/* 外观：主题弹层 / 曲线开关（打开时加暗遮罩，避免和下面的卡片糊在一起） */
function setThemePop(open) {
  $('themePop').hidden = !open;
  syncPopMask();
}
function syncPopMask() {
  $('popMask').hidden = $('dockPop').hidden && $('themePop').hidden;
}
$('btnTheme').addEventListener('click', (e) => {
  e.stopPropagation();
  setDockPop(false);
  setThemePop($('themePop').hidden);
});
$('btnDock').addEventListener('click', (e) => {
  e.stopPropagation();
  setThemePop(false);
  setDockPop($('dockPop').hidden);
});
$('popMask').addEventListener('click', () => { setThemePop(false); setDockPop(false); });
document.addEventListener('click', (e) => {
  const inTheme = e.target.closest('#themePop') || e.target.closest('#btnTheme');
  const inDock = e.target.closest('#dockPop') || e.target.closest('#btnDock');
  if (!$('themePop').hidden && !inTheme) setThemePop(false);
  if (!$('dockPop').hidden && !inDock) setDockPop(false);
});
$('themePop').addEventListener('click', (e) => {
  const it = e.target.closest('.tp-item');
  if (it) { setTheme(it.dataset.theme); setThemePop(false); }
});
$('dockPop').addEventListener('click', (e) => {
  const it = e.target.closest('.tp-item');
  if (it) {
    if (it.dataset.dock) chooseDock(it.dataset.dock);
    else if (it.dataset.wake) chooseWake(it.dataset.wake);
    else if (it.id === 'btnResetPos') { api.resetFloatPos(); toast('小浮窗位置已重置', 'ok'); }
    else if (it.id === 'btnResetSize') { api.resetPanelSize(); toast('页面大小已恢复默认', 'ok'); }
  }
  setDockPop(false);
});
$('curveSwitch').addEventListener('click', toggleCurve);
$('btnCurve').addEventListener('click', (e) => { e.stopPropagation(); toggleCurve(); });
$('curveRange').addEventListener('input', (e) => {
  curveAmp = parseInt(e.target.value, 10);
  state.settings.curveAmp = curveAmp;
  curveLayout();
  save();
});

// 滚动时实时更新曲线
let rafPending = false;
$('list').addEventListener('scroll', () => {
  if (!curveOn || rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; curveLayout(); });
}, { passive: true });
window.addEventListener('resize', curveLayout);

$('search').addEventListener('input', (e) => {
  searchKey = e.target.value.trim();
  $('clearSearch').hidden = !searchKey;
  render();
});
$('clearSearch').addEventListener('click', () => {
  $('search').value = ''; searchKey = ''; $('clearSearch').hidden = true; render();
});
$('sortBy').addEventListener('change', () => { save(); render(); });

$('tagChips').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  filterTag = b.dataset.tag;
  render();
});

$('tagSuggest').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const cur = $('fTags').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  if (!cur.includes(b.dataset.tag)) cur.push(b.dataset.tag);
  $('fTags').value = cur.join(', ');
});

$('list').addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  const id = card.dataset.id;
  const act = e.target.closest('[data-act]');
  if (act && act.dataset.act === 'toggle') {
    const n = state.notes.find((x) => x.id === id);
    if (!n) return;
    // 重复备忘：打勾 = 本期做完，保持已完成直到下一期；再点一次可撤销
    if (isRepeat(n)) {
      if (!n.done) {
        const okBump = bumpRecur(n);
        if (okBump) {
          const tail = n.streak > 1 ? `，连续 ${n.streak} 次` : '';
          toast(`「${n.title || '这条备忘'}」本期已完成，${shortDue(n.due)} 重新开始${tail}`, 'ok');
        }
      } else {
        n.done = false;
        n.doneUntil = '';
        n.updatedAt = Date.now();
      }
      save();
      render();
      return;
    }
    n.done = !n.done;
    n.updatedAt = Date.now();
    save();
    render();
    return;
  }
  if (act && act.dataset.act === 'del') {
    e.stopPropagation();
    askDelete(id);
    return;
  }
  openDetail(id);
});

/* 右键卡片 → 直接问删不删（不用点进去） */
$('list').addEventListener('contextmenu', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  e.preventDefault();
  askDelete(card.dataset.id);
});

document.querySelectorAll('#fPrio button').forEach((b) => {
  b.addEventListener('click', () => setPrio(b.dataset.prio));
});

/* 重复：切换类型时顺手补一个起始日期；周几 / 每月几号一改就刷新说明 */
$('fRepeat').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const r = b.dataset.rpt;
  setRepeat(r);
  if (r === 'weekly' && !uiWeekdays().length) setWeekdays([new Date().getDay()]);
  syncRepeatUI();
});
$('fWeekdays').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  b.classList.toggle('active');
  syncRepeatUI();
});
$('fMonthDay').addEventListener('change', syncRepeatUI);

document.querySelectorAll('.quick-due button').forEach((b) => {
  b.addEventListener('click', () => {
    const days = parseInt(b.dataset.days, 10);
    if (days === -1) { $('fDue').value = ''; }
    else {
      const d = new Date();
      d.setDate(d.getDate() + days);
      d.setHours(days === 0 ? new Date().getHours() + 1 : 9, 0, 0, 0);
      $('fDue').value = toLocalInput(d);
    }
    updateDueHint();
  });
});
$('btnWinClear').addEventListener('click', () => {
  $('fStartAt').value = '';
  $('fEndAt').value = '';
});

// 快捷键：Ctrl+Enter 保存，Esc 返回
document.addEventListener('keydown', (e) => {
  if (!$('confirmMask').hidden) {
    if (e.key === 'Escape') hideConfirm();
    if (e.key === 'Enter') $('cfOk').click();
    return;
  }
  if (!$('detail').hidden) {
    if (e.key === 'Escape') closeDetail();
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveFromForm();
  } else if (e.key === 'Escape') {
    if (!$('dockPop').hidden) setDockPop(false);
    else if (!$('themePop').hidden) setThemePop(false);
    else api.collapse();
  }
});

/* ---------- 自动收起 / 展开 ----------
   自动收起统一交给主进程按鼠标位置判断（见 main.js 的 startHoverWatch）。
   之前由渲染进程的 mouseleave 负责，但窗口弹出/收回时尺寸一直在变，
   Chromium 会误报 mouseleave，于是「刚弹出来就又缩回去」，看起来就是不停跳动。
   这里只保留：鼠标回到窗口时，取消正在倒计时的收起动作。 */
document.addEventListener('mouseenter', () => { armed = true; api.cancelCollapse(); });
// 注意：这里**不要**再给 edgeHint 绑 mouseenter → api.expand()。
// 收起瞬间提示条会铺满整窗变成可见，鼠标只要还在窗口矩形里，Chromium 立刻派发
// mouseenter 把窗口又拉出来 → 主进程判定离开 → 再收 → 再拉……鼠标压根没动却反复弹收，
// 3 次后触发抖动刹车并锁死 armed，结果就是"怎么都唤不出来"。
// 现在收起后整窗在屏幕外，这个提示条根本碰不到，绑了只有害处。
/* 小浮窗气泡：以前整块是 -webkit-app-region:drag，Windows 接管鼠标后页面
   收不到 click / dblclick —— 「能拖动，但双击打不开」就是这么来的。
   现在气泡是普通可点击区域：按下/抬起通知主进程，由主进程按屏幕坐标跟随鼠标
   完成拖动；位移不足 4px 就判定为点击并展开。页面只保留 pointer 事件丢失时的
   click / dblclick 兜底，正常路径上用 pointerHandled 避免重复展开或拖动误展开。 */
(() => {
  const el = $('edgeHint');
  let down = false;
  let moved = false;
  let sx = 0, sy = 0;
  let pointerHandled = false;
  let resetTimer = null;
  el.addEventListener('pointerdown', (e) => {
    if (dockMode !== 'float' || e.button !== 0 || !api.floatDragStart) return;
    down = true; moved = false;
    // screenX/Y 是屏幕绝对坐标：窗口跟着鼠标移动也不会像 clientX 那样衰减
    sx = e.screenX; sy = e.screenY;
    pointerHandled = true;
    clearTimeout(resetTimer);
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
    api.floatDragStart();
  });
  el.addEventListener('pointermove', (e) => {
    if (!down) return;
    const dx = e.screenX - sx, dy = e.screenY - sy;
    if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    moved = true;
    if (api.floatDragMove) api.floatDragMove(dx, dy);
  });
  const finish = (e, cancelled) => {
    if (!down) return;
    down = false;
    try { el.releasePointerCapture(e.pointerId); } catch (_) {}
    if (api.floatDragEnd) api.floatDragEnd(cancelled ? true : moved);
    // 让紧随 pointerup 派发的 click 走兜底屏蔽；350ms 后恢复，不影响下一次点击
    resetTimer = setTimeout(() => { pointerHandled = false; }, 350);
  };
  el.addEventListener('pointerup', (e) => finish(e, false));
  el.addEventListener('pointercancel', (e) => finish(e, true));
  const fallback = () => {
    if (dockMode !== 'float' || pointerHandled) return;
    api.expand();
  };
  el.addEventListener('click', fallback);
  el.addEventListener('dblclick', fallback);
})();

api.onOpenNew(() => openDetail(null));

// 扩展（手机同步）在后台改了数据 → 直接重载，不用重启应用
if (api.onDataChanged) api.onDataChanged(() => { load(); });

function applyPanelState(s) {
  if (!s) return;
  document.body.classList.toggle('collapsed', !!s.collapsed);
  pinned = !!s.pinned;
  syncPinBtn();
  if (s.mode && s.mode !== dockMode) { dockMode = s.mode; syncDockUI(); }
  if (s.collapsed) { closeDetail(); armed = false; }
}
api.onPanelState(applyPanelState);

/* 从托盘 / 最小化恢复时，主进程 push 的那一条 panel-state 可能在渲染进程
   被挂起期间丢掉，页面就一直挂着 collapsed 类：`.app` 被 display:none，
   只剩一条边条 —— 用户说的"假界面、点不动，只能弹出收回"。
   所以页面每次重新可见 / 拿到焦点都主动去拉一次真实状态，不靠运气。 */
async function pullPanelState() {
  try { applyPanelState(await api.panelStateNow()); } catch (e) { /* 忽略 */ }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) pullPanelState(); });
window.addEventListener('focus', pullPanelState);
window.addEventListener('pageshow', pullPanelState);
setTimeout(pullPanelState, 800);

/* ---------- 到期提醒 ---------- */
function checkReminder() {
  // 半夜跨天时：本期做完的复位成新的一期，没做完的期数补跳到当天
  let changed = expireCompletedRecur();
  if (rollRecurring()) changed = true;
  // 生效时段跨过开始 / 结束点时，自动刷新卡片状态（只在真的变了才重绘，
  // 否则每 30 秒重建一次列表会打断正在拖动的卡片）
  const sig = windowSignature();
  const winChanged = sig !== winSig;
  winSig = sig;
  if (changed) save();
  if (changed || winChanged) render();
  const now = Date.now();
  state.notes.forEach((n) => {
    if (!n.due || n.done || n.notified) return;
    const t = new Date(n.due).getTime();
    if (t <= now && t > now - 24 * 3600 * 1000) {
      n.notified = true;
      api.notify(`备忘到期：${n.title || '（无标题）'}`, n.body ? n.body.slice(0, 80) : '到时间啦');
      save();
    }
  });
}

/* ---------- 启动 ---------- */

/* 临时：自动化自测入口（?selftest=1），验证完会删除 */
function runSelfTest() {
  const log = (...a) => api.selftestLog(a.join(' '));
  const ok = (cond, name) => log((cond ? 'PASS' : 'FAIL ::') + ' ' + name);

  setTimeout(async () => {
    // 0) 真实鼠标坐标换算：raw 本身已落在工作区内时，解析结果必须等于 raw。
    //    这里曾经多除了一次 scaleFactor（125% 缩放下屏幕右缘 2047 被算成 1637），
    //    鼠标在数学上永远"到不了边缘" → 窗口彻底唤不出来。
    //    虚拟鼠标自测会绕过这段换算，所以必须单独断言，否则又是"测试全过、真机失灵"。
    const pr = await api.probePointer();
    if (pr) {
      // 只要返回值本身能当 DIP 解释（x 落在屏幕宽度内），就绝不允许再被除以 scaleFactor。
      // 以前这里的判据还捎带了 y、且限定在 workArea 内：鼠标停在任务栏上时 y 越界
      // → canBeDip 为 false → 断言被短路跳过，所以一直没抓到"贴边坐标被算成 80%"这个坑。
      const canBeDip = pr.raw.x >= pr.wa.x - 8 && pr.raw.x <= pr.wa.x + pr.wa.width + 8;
      ok(!canBeDip || Math.abs(pr.x - pr.raw.x) < 1,
        '真实鼠标坐标未被重复缩放（raw=' + pr.raw.x + ' → ' + pr.x.toFixed(0) + '，屏幕宽 ' + pr.wa.width + '）');
      // 用整块屏幕 bounds 而不是 workArea：鼠标停在任务栏上时本来就该超出工作区，
      // 用 workArea 判定会把正常情况误报成失败。
      ok(pr.x >= pr.bounds.x - 8 && pr.x <= pr.bounds.x + pr.bounds.width + 8
        && pr.y >= pr.bounds.y - 8 && pr.y <= pr.bounds.y + pr.bounds.height + 8,
        '换算后的鼠标坐标仍落在屏幕内');
    }

    // 1) 空白界面点保存 → 直接退出、不新增
    const before = state.notes.length;
    openDetail(null);
    saveFromForm();
    ok(state.notes.length === before && $('detail').hidden, '空白保存：不新增、面板直接关闭');

    // 2) 没标题但有正文 → 自动拿正文首行当标题
    openDetail(null);
    $('fBody').value = '自动标题测试正文';
    saveFromForm();
    const added = state.notes[state.notes.length - 1];
    ok(state.notes.length === before + 1 && added.title === '自动标题测试正文',
      '正文自动补标题（title=' + added.title + '）');

    // 3) 编辑已有备忘时清空全部内容 → 直接退出、原数据不动
    //    自己先造一条 id=t2 的备忘，不再依赖预置数据 ——
    //    否则第一次运行（空库）时下面 .card[data-id="t2"] 取不到元素，会直接抛异常中断自测
    state.notes = state.notes.filter((n) => n.id !== 't2');
    openDetail(null);
    $('fTitle').value = '买牛奶';
    saveFromForm();
    state.notes[state.notes.length - 1].id = 't2';
    openDetail('t2');
    $('fTitle').value = '';
    $('fBody').value = '';
    saveFromForm();
    const t2 = state.notes.find((n) => n.id === 't2');
    ok(!!t2 && t2.title === '买牛奶' && t2.body === '', '编辑态全空：保持原数据不保存');

    // 4) 列表卡片上的 🗑 → 确认框 → 删除
    //    上一步走的是「内容全空 → 直接退出」分支，那条路径不刷新列表，
    //    所以这里显式渲染一次，保证卡片 DOM 存在（空库第一次运行时尤其重要）
    render();
    const t2del = document.querySelector('.card[data-id="t2"] .c-del');
    if (!t2del) { ok(false, '列表里应能看到刚建的 t2 卡片'); return; }
    t2del.click();
    ok(!$('confirmMask').hidden, '卡片🗑点击弹出确认框');
    $('cfOk').click();
    ok(!state.notes.some((n) => n.id === 't2') && !!lastDeleted && lastDeleted.note.id === 't2',
      '确认后删除成功');

    // 5) 撤销恢复
    $('toastAct').click();
    ok(state.notes.some((n) => n.id === 't2'), '撤销后卡片恢复');

    // 6) 每天：打勾后本期保持已完成，下一期锚点顺延到明天同一时刻
    const t0 = new Date(); t0.setHours(9, 0, 0, 0);
    const dly = { id: 'rx1', title: '每天背单词', due: toLocalInput(t0), repeat: 'daily' };
    bumpRecur(dly);
    const exp1 = new Date(t0.getTime()); exp1.setDate(exp1.getDate() + 1);
    ok(new Date(dly.due).getDate() === exp1.getDate() && new Date(dly.due).getHours() === 9
       && dly.streak === 1 && dly.done === true && dly.doneUntil === dly.due,
      '每天：完成后本期保持已完成、下一期锚点顺延到明天 9:00（' + dly.due + '）');

    // 6b) 只有跨到下一期才复位（用户反复反馈的「勾了又冒出来」就靠这条守住）
    state.notes.push(Object.assign({}, dly, {
      id: 'rx1b', items: [{ text: '喝水', done: false }],
    }));
    const rx1b = state.notes.find((n) => n.id === 'rx1b');
    rx1b.doneUntil = toLocalInput(new Date(Date.now() - 3600000));
    const expired = expireCompletedRecur();
    ok(expired && rx1b.done === false && rx1b.doneUntil === '' && rx1b.items[0].done === false,
      '跨到下一期才复位：之前一直保持已完成');
    state.notes = state.notes.filter((n) => n.id !== 'rx1b');

    // 7) 每周一/三：周一做完 → 下一次是周三
    const mon = new Date(2026, 9, 19, 20, 0);        // 2026-10-19 是周一
    const nw = nextOccur({ repeat: 'weekly', repeatDays: [1, 3] }, mon);
    ok(nw.getDay() === 3 && nw.getDate() === 21 && nw.getHours() === 20,
      '每周一、三：周一之后的下一次是周三（' + toLocalInput(nw) + '）');

    // 8) 每月 31 号 → 2 月自动落到 28 号
    const mn = nextOccur({ repeat: 'monthly', repeatDay: 31 }, new Date(2026, 0, 31, 8, 30));
    ok(mn.getMonth() === 1 && mn.getDate() === 28 && mn.getHours() === 8,
      '每月31号：2 月自动落到 28 号（' + toLocalInput(mn) + '）');

    // 9) 昨天那期没做 → 自动补跳到今天，连续次数清零
    const yst = new Date(); yst.setDate(yst.getDate() - 1); yst.setHours(9, 0, 0, 0);
    state.notes.push({ id: 'rx9', title: '每天喝水', due: toLocalInput(yst), repeat: 'daily', streak: 4 });
    const moved = rollRecurring();
    const r9 = state.notes.find((n) => n.id === 'rx9');
    ok(moved && new Date(r9.due).getDate() === new Date().getDate() && r9.streak === 0,
      '跨天补跳：昨天没做的每天备忘推进到今天，连续次数清零');

    // 10) 卡片上出现 🔁 徽标
    render();
    const rptEl = document.querySelector('.card[data-id="rx9"] .c-rpt-badge');
    ok(!!rptEl && rptEl.textContent.indexOf('每天') !== -1,
      '卡片显示重复徽标（' + (rptEl ? rptEl.textContent.trim() : '无') + '）');
    state.notes = state.notes.filter((n) => n.id !== 'rx9');

    // 11) 重复面板的显示切换：选每周/每月只露出对应选项
    openDetail(null);
    document.querySelector('#fRepeat button[data-rpt="weekly"]').click();
    ok(!$('rptWeekly').hidden && $('rptMonthly').hidden, '选每周：显示周几面板、隐藏每月面板');
    document.querySelector('#fRepeat button[data-rpt="monthly"]').click();
    ok($('rptWeekly').hidden && !$('rptMonthly').hidden, '选每月：显示每月面板、隐藏周几面板');

    // 12) 每周备忘保存（默认带上起始那天的星期）
    document.querySelector('#fRepeat button[data-rpt="weekly"]').click();
    $('fTitle').value = '每周五例会';
    saveFromForm();
    const wkNote = state.notes[state.notes.length - 1];
    ok(wkNote.repeat === 'weekly' && wkNote.repeatDays.indexOf(new Date().getDay()) !== -1,
      '每周备忘保存成功（repeatDays=' + JSON.stringify(wkNote.repeatDays) + '）');

    // 13) 设了重复就不要截止日期：那一栏必须真的看不见（不能只加 hidden 属性——
    //     .field 是 display:flex，作者样式会盖掉浏览器默认的 [hidden]{display:none}）
    const hiddenNow = (el) => el.hidden && getComputedStyle(el).display === 'none';
    const shownNow = (el) => !el.hidden && getComputedStyle(el).display !== 'none';
    openDetail(null);
    document.querySelector('#fRepeat button[data-rpt="weekly"]').click();
    ok(hiddenNow($('dueField')) && shownNow($('dueLocked')), '选了重复：截止日期栏真的隐藏、显示「不设截止日期」说明');
    document.querySelector('#fRepeat button[data-rpt="none"]').click();
    ok(shownNow($('dueField')) && hiddenNow($('dueLocked')), '选回不重复：截止日期栏恢复显示');

    // 14) 每周固定某天：due 必须自动排到最近一个命中的星期，而不是随便落到「今天」
    const TARGET_WD = 3;                                     // 周三
    openDetail(null);
    document.querySelector('#fRepeat button[data-rpt="weekly"]').click();
    document.querySelectorAll('#fWeekdays button').forEach((b) => b.classList.remove('active'));
    document.querySelector(`#fWeekdays button[data-wd="${TARGET_WD}"]`).click();
    $('fTitle').value = '每周三例会';
    saveFromForm();
    const wedNote = state.notes[state.notes.length - 1];
    const expectWed = new Date(); expectWed.setHours(0, 0, 0, 0);
    while (expectWed.getDay() !== TARGET_WD) expectWed.setDate(expectWed.getDate() + 1);
    const wedDue = new Date(wedNote.due);
    ok(wedDue.getDay() === TARGET_WD && wedDue.getDate() === expectWed.getDate(),
      '每周三：自动排到下一个周三（' + wedNote.due + '）');

    // 15) 重复卡片上不再出现「剩 X 天 / 已逾期 X 天」
    render();
    const wedCardDue = document.querySelector('.card[data-id="' + wedNote.id + '"] .due');
    ok(!wedCardDue, '重复卡片不显示截止日期倒计时（.due 徽标已去掉）');
    state.notes = state.notes.filter((n) => n.id !== wedNote.id);

    // 16) 今天刚打完勾、已顺延到明天的一期，改标题再保存不能被拉回今天（否则等于白做完）
    const tmr = new Date(); tmr.setDate(tmr.getDate() + 1); tmr.setHours(9, 0, 0, 0);
    state.notes.push({ id: 'rx16', title: '每天喝水', repeat: 'daily', repeatDays: [], repeatDay: 0,
      due: toLocalInput(tmr), streak: 3 });
    openDetail('rx16');
    $('fTitle').value = '每天喝水（改标题）';
    saveFromForm();
    const rx16 = state.notes.find((n) => n.id === 'rx16');
    ok(rx16 && new Date(rx16.due).getDate() === tmr.getDate(),
      '改标题保存：已顺延到明天的一期不被拉回来（' + (rx16 ? rx16.due : '丢') + '）');
    state.notes = state.notes.filter((n) => n.id !== 'rx16');

    // 17) 标签行必须能换行：以前是单行 + 隐藏滚动条，标签一多就被切掉且拖不动，
    //     用户看到的就是"标签被挡住、没法看全"
    const chipsStyle = getComputedStyle($('tagChips'));
    ok(chipsStyle.flexWrap === 'wrap' && chipsStyle.overflowY === 'auto',
      '标签行自动换行（flex-wrap=' + chipsStyle.flexWrap + ' overflow-y=' + chipsStyle.overflowY + '）');
    const footStyle = getComputedStyle(document.querySelector('.card .c-foot') || $('tagChips'));
    ok(footStyle.flexWrap === 'wrap', '卡片底栏标签也允许换行');

    // 18) 图片链路：存盘 -> 生成 URL -> 真能加载出来
    //     （剪贴板那一步在无焦点环境下测不了，这里至少把"进了程序之后"的整条路走通）
    const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
    const imgName = await api.saveImage(TINY_PNG);
    ok(!!imgName && /\.png$/.test(imgName), '图片存盘成功（' + imgName + '）');
    const imgUrl = imgName ? api.imgUrl(imgName) : '';
    ok(!!imgUrl, '图片 URL 能生成');
    const imgOk = await new Promise((res) => {
      if (!imgUrl) return res(false);
      const im = new Image();
      im.onload = () => res(true);
      im.onerror = () => res(false);
      im.src = imgUrl;
      setTimeout(() => res(false), 3000);   // 协议挂了的话别把自测卡死
    });
    ok(imgOk, '图片能通过自定义协议真的加载出来（存+读+显示三步全通）');

    // 19) 清单：卡片底栏要显示"已完成 / 总数"进度徽标
    state.notes.push({ id: 'it1', title: '清单测试', items: [
      { text: '买菜', done: true }, { text: '做饭', done: false }, { text: '洗碗', done: false },
    ] });
    render();
    const itCard = document.querySelector('.card[data-id="it1"] .c-item-badge');
    ok(itCard && itCard.textContent.replace(/\s/g, '').includes('1/3'),
      '清单进度徽标显示 1/3（' + (itCard ? itCard.textContent.trim() : '没渲染出来') + '）');

    // 20) 搜索：能按关键词过滤，且能命中清单内容
    searchKey = '清单测试';
    render();
    const hitByTitle = document.querySelectorAll('.card[data-id="it1"]').length;
    searchKey = '洗碗';                       // 只存在于清单项里
    render();
    const hitByItem = document.querySelectorAll('.card[data-id="it1"]').length;
    searchKey = '这个词肯定不存在zzz';
    render();
    const hitNone = document.querySelectorAll('.card').length;
    searchKey = '';
    render();
    ok(hitByTitle === 1 && hitByItem === 1 && hitNone === 0,
      '搜索：标题命中=' + hitByTitle + ' 清单内容命中=' + hitByItem + ' 无匹配时卡数=' + hitNone);

    // 21) 排序：按优先级排，高优先级必须排在低优先级前面
    state.notes.push({ id: 's1', title: '低优先', priority: 'low', due: '' });
    state.notes.push({ id: 's2', title: '高优先', priority: 'high', due: '' });
    $('sortBy').value = 'priority';
    render();
    const order = [].map.call(document.querySelectorAll('.card'), (c) => c.dataset.id);
    ok(order.indexOf('s2') !== -1 && order.indexOf('s1') !== -1 && order.indexOf('s2') < order.indexOf('s1'),
      '按优先级排序：高优先排在低优先前面（顺序 ' + order.join('>') + '）');
    state.notes = state.notes.filter((n) => n.id !== 'it1' && n.id !== 's1' && n.id !== 's2');
    render();

    await testHoverStateMachine(log, ok);

    // 22) 守卫自检：两个定时器必须"真的在跑"，而不只是"存在"。
    //     2026-10-31 事故：看门狗每隔 90ms 就被监督者重启一次，回调一次都没执行过
    //     —— 心跳检测、窗口救援全程停摆，同时每 90ms 同步刷日志把磁盘写满，
    //     用户看到的就是"最小化之后再打开，点什么都没反应"。
    //     所以判据必须是"最后一次 tick 的时间戳在推进"，而不是"定时器非 null"。
    const d1 = await api.guardDiag();
    ok(!!d1 && d1.lastWatchdogTick >= d1.watchdogStartedAt,
      '看门狗回调真的执行过（启动后 ' + (d1 ? d1.lastWatchdogTick - d1.watchdogStartedAt : '?') + 'ms 首次上报）');
    ok(!!d1 && d1.now - d1.lastWatchdogTick < 12000,
      '看门狗心跳在推进（距上次 ' + (d1 ? d1.now - d1.lastWatchdogTick : '?') + 'ms）');
    ok(!!d1 && d1.now - d1.lastHoverTick < 3000,
      '贴边轮询在推进（距上次 ' + (d1 ? d1.now - d1.lastHoverTick : '?') + 'ms）');

    // 23) 最小化 → 恢复 全流程：期间不许误判页面已死去 reload，
    //     恢复后窗口必须真的可见且在屏幕内（否则就是"打开后用不了"）。
    const hc = await api.testHideCycle();
    ok(hc && hc.reviveAfter === hc.reviveBefore,
      '最小化 11 秒内不会被误判页面已死而 reload（revive 次数 ' + (hc ? hc.reviveBefore + '→' + hc.reviveAfter : '?') + '）');
    ok(hc && hc.visibleNow === true && hc.onScreen === true,
      '恢复显示后窗口可见且在屏幕内（visible=' + (hc ? hc.visibleNow : '?') + ' onScreen=' + (hc ? hc.onScreen : '?') + '）');
    ok(hc && hc.hbFresh === true && hc.userHidden === false,
      '恢复后心跳恢复上报、状态位已复位（hbFresh=' + (hc ? hc.hbFresh : '?') + ' hidden=' + (hc ? hc.userHidden : '?') + '）');

    // 24) 模拟"系统休眠 6 小时后唤醒"：守卫不许陷入无限重启。
    //     这是本次事故的确切触发路径 —— 修好之后最多各重启一次就该恢复健康，
    //     如果这里的重启次数是几十上百，说明又空转了。
    const wk = await api.testSimulateWake();
    ok(!!wk && wk.wdRestarts <= 2 && wk.hvRestarts <= 2,
      '休眠唤醒后守卫只重启有限次（watchdog=' + (wk ? wk.wdRestarts : '?')
      + ' 次, hover=' + (wk ? wk.hvRestarts : '?') + ' 次，非无限空转）');
    ok(!!wk && wk.watchdogFresh === true && wk.hoverFresh === true,
      '唤醒后两个定时器都恢复心跳（watchdogFresh=' + (wk ? wk.watchdogFresh : '?')
      + ' hoverFresh=' + (wk ? wk.hoverFresh : '?') + '）');

    // 25) 系统级最小化（Win+D「显示桌面」）→ 点托盘图标叫回来。
    //     这条路径不经过 hideWindow()，userHidden 仍是 false，
    //     而 Windows 上最小化窗口的 isVisible() 还是 true；
    //     以前托盘点击因此误判成"窗口正展开着" → 执行 collapse() 继续收起，
    //     窗口就永远卡在最小化状态 —— 用户看到的就是"显示出来了但没法操作"。
    const mc = await api.testMinimizeCycle();
    ok(!!mc && mc.during && mc.during.minimized === true,
      '前置条件：窗口确实进入了最小化状态（minimized=' + (mc && mc.during ? mc.during.minimized : '?') + '）');
    ok(!!mc && mc.after && mc.after.minimized === false && mc.after.visible === true
      && mc.after.collapsed === false && mc.after.onScreen === true,
      '系统最小化后点托盘能真的恢复可见（minimized=' + (mc && mc.after ? mc.after.minimized : '?')
      + ' visible=' + (mc && mc.after ? mc.after.visible : '?')
      + ' onScreen=' + (mc && mc.after ? mc.after.onScreen : '?') + '）');

    // 26) 孤儿隐藏窗口自动复原 —— 2026-10-31 事故的确切现场。
    //     程序以为面板展开着，Windows 却说窗口被隐藏了（WS_VISIBLE 被清零），
    //     两边各说各话，再也没人去显示它 → "最小化后再打开就没法操作"。
    //     可见性守卫存在的意义就是：只要期望还是"可见"，1 秒内必须自动纠正。
    const og = await api.testHideOrphan();
    ok(!!og && og.before && og.before.visible === false,
      '前置条件：已制造出孤儿隐藏窗口（before.visible=' + (og && og.before ? og.before.visible : '?') + '）');
    ok(!!og && og.fixed === true,
      '孤儿隐藏窗口被守卫自动恢复可见（visible=' + (og && og.after ? og.after.visible : '?')
      + ' minimized=' + (og && og.after ? og.after.minimized : '?')
      + ' onScreen=' + (og && og.after ? og.after.onScreen : '?') + '）');

    // NN) 生效时段：未开始 / 进行中 / 已结束，都不算完成
    const tn = new Date();
    const tPast = new Date(tn.getTime() - 3600e3);
    const tFuture = new Date(tn.getTime() + 3600e3);
    const ws = (o) => windowState(Object.assign({ id: 'tw', title: '时段测试' }, o));
    ok(ws({ startAt: toLocalInput(tFuture) }) === 'upcoming', '只填未来开始 → 未开始');
    ok(ws({ startAt: toLocalInput(tPast) }) === 'active', '开始已过且无结束 → 进行中');
    ok(ws({ endAt: toLocalInput(tPast) }) === 'ended', '结束已过 → 已结束');
    ok(ws({ startAt: toLocalInput(tPast), endAt: toLocalInput(tFuture) }) === 'active',
      '区间内 → 进行中');
    ok(ws({}) === 'none', '老卡片没填时段 → 无状态、行为不变');
    const wRep = windowFor({ repeat: 'weekly', repeatDays: [3], due: toLocalInput(tn),
      startAt: '2026-01-01T10:00', endAt: '2026-01-01T11:40' });
    ok(!!wRep && wRep.recurring && wRep.start.getHours() === 10
      && wRep.end.getHours() === 11 && wRep.end.getMinutes() === 40,
      '重复备忘：时段按当前期日期滚动（10:00→11:40）');
    const wCross = windowFor({ repeat: 'daily', due: toLocalInput(tn),
      startAt: '2026-01-01T22:00', endAt: '2026-01-01T01:00' });
    ok(!!wCross && wCross.end.getDate() !== wCross.start.getDate(),
      '跨午夜时段：结束自动顺延一天');
    state.notes = state.notes.filter((n) => n.id !== 'tw1');
    state.notes.push({ id: 'tw1', title: '选课窗口', startAt: toLocalInput(tFuture),
      endAt: toLocalInput(new Date(tFuture.getTime() + 3600e3)) });
    render();
    const cw = document.querySelector('.card[data-id="tw1"]');
    ok(!!cw && cw.classList.contains('win-upcoming') && !cw.classList.contains('done'),
      '未开始卡片灰显但绝不算完成');
    ok(!!cw && !!cw.querySelector('.c-win-badge.upcoming'),
      '卡片显示「未开始」徽标与区间');
    state.notes = state.notes.filter((n) => n.id !== 'tw1');
    render();

    log('SELFTEST DONE');
  }, 600);
}

/**
 * 贴边唤出 / 移开归位 的确定性自测。
 *
 * 为什么不用 SetCursorPos 模拟真实鼠标：用户自己随时在动鼠标，程序设的坐标立刻被覆盖，
 * 日志里读回来的永远是"别人的鼠标位置"，断言完全不可信（这次就是被它坑了——
 * 测出来"唤不出来"，实际是我的 SetCursorPos 压根没生效）。
 * 改用虚拟鼠标直接驱动主进程的状态机，结果可复现。
 */
async function testHoverStateMachine(log, ok) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isOpen = (b, mode, wa) => {
    if (!b) return false;
    return mode === 'top' ? b.y >= wa.y - 6 : b.x <= wa.x + wa.width - 300;
  };
  const isHidden = (b, mode, wa) => {
    if (!b) return false;
    return mode === 'top' ? b.y + b.height <= wa.y + 6 : b.x >= wa.x + wa.width - 6;
  };

  try {
    closeDetail();
    // 主进程启动后有一段时间不自动收起，等它过去再测，否则第一步就会误判超时
    await sleep(4800);

    const wa = await api.workArea();
    const mode = await api.dockMode();
    const far = { x: wa.x + Math.round(wa.width * 0.25), y: wa.y + Math.round(wa.height * 0.75) };
    const pts = mode === 'top'
      ? {
        hot: { x: wa.x + Math.round(wa.width / 2), y: wa.y + 2 },
        warm: { x: wa.x + Math.round(wa.width * 0.12), y: wa.y + 90 },  // 屏幕左上角，顺便验证横向不限
      }
      : {
        hot: { x: wa.x + wa.width - 4, y: wa.y + Math.round(wa.height / 2) },
        warm: { x: wa.x + wa.width - 110, y: wa.y + Math.round(wa.height * 0.3) },
      };

    const waitFor = async (pred, ms) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const b = await api.winBounds();
        if (pred(b, mode, wa)) return Date.now() - t0;
        await sleep(60);
      }
      return null;
    };

    // 0) 鼠标远离 → 自动收起
    api.fakeMouse(far);
    let t = await waitFor(isHidden, 6000);
    ok(t !== null, '鼠标远离时自动收起（' + (t === null ? '超时' : t + 'ms') + '）');

    // 1~3) 三轮来回，验证"边沿触发"不会在第 N 次之后卡死（这正是之前唤不出来的原因）
    for (let i = 1; i <= 3; i++) {
      api.fakeMouse(pts.hot);
      const tIn = await waitFor(isOpen, 3500);
      ok(tIn !== null, '第' + i + '轮 贴边唤出（' + (tIn === null ? '超时=卡死' : tIn + 'ms') + '）');
      await sleep(1500);
      ok(isOpen(await api.winBounds(), mode, wa), '第' + i + '轮 停留 1.5 秒不被误收');
      api.fakeMouse(far);
      const tOut = await waitFor(isHidden, 3500);
      ok(tOut !== null, '第' + i + '轮 移开后归位（' + (tOut === null ? '超时' : tOut + 'ms') + '）');
    }

    // 4) 「只是靠近、没贴到边」不许弹出 —— 用户明确要求别远远地就把窗口叫出来
    api.fakeMouse(pts.warm);
    const tWarm = await waitFor(isOpen, 2500);
    ok(tWarm === null, '只靠近不贴边（' + (mode === 'top' ? 'y=90' : '距右缘110') + '）保持不动、不弹出'
      + (tWarm === null ? '' : '（竟然在 ' + tWarm + 'ms 弹了）'));

    // 5) 真正压到边缘要能立刻唤出（前面三轮已验证，这里最后确认一次灵敏度没被拖慢）
    api.fakeMouse(pts.hot);
    const tEdge = await waitFor(isOpen, 3000);
    ok(tEdge !== null && tEdge < 1000, '压到边缘 ' + (mode === 'top' ? 'y≤8' : '距右缘≤10')
      + ' 立刻唤出（' + (tEdge === null ? '超时' : tEdge + 'ms') + '）');

    api.fakeMouse(far);
    await waitFor(isHidden, 3000);
    api.fakeMouse(null);                 // 交还给真实鼠标
    log('-- 贴边状态机测试完成（当前模式 ' + mode + '）');
  } catch (e) {
    ok(false, '贴边测试异常：' + (e && e.message || e));
    try { api.fakeMouse(null); } catch (e2) { /* ignore */ }
  }
}

load().then(() => {
  render();
  checkReminder();
  setInterval(checkReminder, 30000);
  const p = new URLSearchParams(location.search);
  if (p.has('selftest')) runSelfTest();
  if (p.has('new')) openDetail(null);
  if (p.has('detail')) {
    const idx = parseInt(p.get('detail'), 10);
    openDetail(Number.isNaN(idx) ? null : state.notes[idx].id);
  }
  if (p.has('pop')) setThemePop(true);
  if (p.has('dock')) { setDockPop(true); if (p.get('dock') !== '1') chooseDock(p.get('dock')); }
  // 启动自检：写进主进程 debug.log。排查"点了没反应/界面假死"时，
  // 有这一行就说明渲染进程活着、数据也加载出来了；没有就是页面根本没跑起来。
  try {
    api.selftestLog('UI-READY dock=' + dockMode + ' notes=' + state.notes.length
      + ' detail=' + ($('detail').hidden ? 'closed' : 'open'));
  } catch (e) { /* ignore */ }

  // 心跳：每 2 秒向主进程报到。超过 8 秒没报到，主进程就判定页面已死并自动复活窗口。
  // 这是"界面还在但完全没反应"这类事故的唯一可靠检测手段（Electron 自己不会报）。
  // 顺便上报页面真实状态：主进程那边一旦状态位对不上（比如详情页关了它以为还开着），
  // 就以页面为准纠正，避免"鼠标移开面板死活不收起"这种卡死感。
  setInterval(() => {
    try {
      api.heartbeat({
        detail: !$('detail').hidden,
        pinned: !!pinned,
        collapsed: document.body.classList.contains('collapsed'),
      });
    } catch (e) { /* ignore */ }
  }, 2000);
});

/* ---------- 手动调整页面大小 ----------
   右下角小三角同时改宽高，旁边两条极窄热区分别只改宽 / 只改高。
   screenX / innerWidth 都是 DIP，和主进程 setBounds 同一套单位。
   用 pointer capture，拖到窗口外面也不会半途断掉。 */
(function initResizePanel() {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  let start = null;
  const MIN_W = 240, MIN_H = 180, MAX_W = 1600, MAX_H = 1400;

  const begin = (e, mode) => {
    if (e.button !== 0) return;
    start = {
      x: e.screenX, y: e.screenY,
      w: window.innerWidth, h: window.innerHeight,
      mode,
    };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    e.preventDefault();
    e.stopPropagation();
  };
  const move = (e) => {
    if (!start) return;
    const dx = e.screenX - start.x, dy = e.screenY - start.y;
    // 右侧贴边：右缘固定，向左拖才变宽；顶部贴边：居中，左右各扩一半
    const kx = dockMode === 'right' ? -1 : (dockMode === 'top' ? 2 : 1);
    let w = start.w, h = start.h;
    if (start.mode !== 'h') w = clamp(Math.round(start.w + kx * dx), MIN_W, MAX_W);
    if (start.mode !== 'w') h = clamp(Math.round(start.h + dy), MIN_H, MAX_H);
    api.resizePanel(w, h);
  };
  const end = () => {
    if (!start) return;
    start = null;
    try { curveLayout(); } catch (e) { /* ignore */ }
  };
  [['resizeGrip', 'both'], ['resizeEdgeR', 'w'], ['resizeEdgeB', 'h']].forEach(([id, mode]) => {
    const el = $(id);
    if (el) el.addEventListener('pointerdown', (e) => begin(e, mode));
  });
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('blur', end);
})();
