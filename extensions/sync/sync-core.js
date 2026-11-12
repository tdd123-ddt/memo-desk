/* memo-desk 手机同步扩展 —— 共享合并算法
 * 一个文件两处用：电脑端 require()，手机端作为 <script> 内嵌。
 * 两端跑的是同一份逻辑，避免"电脑一套、手机一套"导致的漂移。
 *
 * 合并策略：LWW（最后写入者胜）+ 墓碑（tombstone）
 *   - 每条备忘以 updatedAt 决胜负，新的覆盖旧的
 *   - 删除不能只是"消失"，否则下次同步时另一端又把它当新增推回来（删了又复活）
 *     所以删除要留一条墓碑 { id, at }；只有墓碑时间 >= 备忘最后修改时间，这条才算真的删了
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MemoSync = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TOMB_TTL = 30 * 24 * 3600 * 1000;   // 墓碑保留 30 天，之后压缩掉

  function up(n) {
    return n && typeof n.updatedAt === 'number' ? n.updatedAt : 0;
  }

  function normDoc(d) {
    return {
      notes: Array.isArray(d && d.notes) ? d.notes : [],
      tombstones: Array.isArray(d && d.tombstones) ? d.tombstones : [],
    };
  }

  function mergeTombs(a, b) {
    var m = {};
    [].concat(a || [], b || []).forEach(function (t) {
      if (!t || !t.id) return;
      if (!m[t.id] || t.at > m[t.id]) m[t.id] = t.at;
    });
    return m;
  }

  /**
   * 双向合并。
   * @param {{notes:Array,tombstones:Array}} localDoc     本地文档
   * @param {{notes:Array,tombstones:Array}} incomingDoc  对面推来的文档
   * @returns {{doc:Object, stats:Object}} 合并后的文档（本地与对面会得到同一份结果）
   */
  function mergeDocs(localRaw, incomingRaw) {
    var local = normDoc(localRaw);
    var incoming = normDoc(incomingRaw);
    var tombs = mergeTombs(local.tombstones, incoming.tombstones);

    // 1) 两端各自的备忘按 id 汇总，updatedAt 大的胜出
    var merged = {};
    var order = [];                                  // 保持"先来后到"的顺序，别让列表每次都跳
    function offer(n) {
      if (!n || !n.id) return;
      var cur = merged[n.id];
      if (!cur) { order.push(n.id); merged[n.id] = n; return; }
      if (up(n) > up(cur)) merged[n.id] = n;
    }
    local.notes.forEach(offer);
    incoming.notes.forEach(offer);

    // 2) 用墓碑把"已经删掉的"筛掉
    var notes = [];
    var removed = [];
    order.forEach(function (id) {
      var n = merged[id];
      var t = tombs[id] || 0;
      if (t && t >= up(n)) { removed.push(id); return; }
      notes.push(n);
    });

    // 3) 压缩过期墓碑
    var cut = Date.now() - TOMB_TTL;
    var tombstones = [];
    Object.keys(tombs).forEach(function (id) {
      if (tombs[id] >= cut) tombstones.push({ id: id, at: tombs[id] });
    });

    // 4) 统计这次同步各自得到了什么（用于给用户的提示语）
    var localMap = {};
    local.notes.forEach(function (n) { localMap[n.id] = n; });
    var localTomb = {};
    (local.tombstones || []).forEach(function (t) { localTomb[t.id] = t.at; });

    var pulled = 0;      // 对面 -> 本地 的改动条数
    var pushed = 0;      // 本地 -> 对面 的改动条数
    var pulledDel = 0;
    var pushedDel = 0;

    // 对面有的：本地没有、或对面的更新 → 算拉进来
    incoming.notes.forEach(function (n) {
      var cur = localMap[n.id];
      if (!cur) { if (!(localTomb[n.id] >= up(n))) pulled++; }
      else if (up(n) > up(cur)) pulled++;
    });
    // 对面的墓碑干掉了本地还活着的备忘
    (incoming.tombstones || []).forEach(function (t) {
      var cur = localMap[t.id];
      if (cur && t.at >= up(cur)) pulledDel++;
    });

    // 反过来：本地有而对面没有（也没墓碑）、或本地更新 → 算推出去
    local.notes.forEach(function (n) {
      var theirs = null;
      incoming.notes.forEach(function (x) { if (x.id === n.id) theirs = x; });
      if (!theirs) { if (!(tombs[n.id] >= up(n))) pushed++; }
      else if (up(n) > up(theirs)) pushed++;
    });
    (local.tombstones || []).forEach(function (t) {
      var theirs = null;
      incoming.notes.forEach(function (x) { if (x.id === t.id) theirs = x; });
      if (theirs && t.at >= up(theirs)) pushedDel++;
    });

    return {
      doc: { notes: notes, tombstones: tombstones },
      stats: {
        pulled: pulled, pulledDeleted: pulledDel,
        pushed: pushed, pushedDeleted: pushedDel,
        total: notes.length,
      },
    };
  }

  return {
    mergeDocs: mergeDocs,
    TOMB_TTL: TOMB_TTL,
    /** 生成新备忘的 id：时间戳 + 随机，够短也够不撞 */
    newId: function () {
      return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    },
  };
});
