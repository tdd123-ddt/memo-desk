const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('memoAPI', {
  load: () => ipcRenderer.invoke('load-data'),
  save: (data) => ipcRenderer.invoke('save-data', data),
  expand: () => ipcRenderer.send('expand-panel'),
  collapse: () => ipcRenderer.send('collapse-panel'),
  hideWindow: () => ipcRenderer.send('hide-window'),
  showWindow: () => ipcRenderer.send('show-window'),
  scheduleCollapse: () => ipcRenderer.send('schedule-collapse'),
  cancelCollapse: () => ipcRenderer.send('cancel-collapse'),
  setPinned: (v) => ipcRenderer.send('set-pinned', v),
  quit: () => ipcRenderer.send('quit-app'),
  rebuild: () => ipcRenderer.send('rebuild-window'),
  notify: (title, body) => ipcRenderer.send('notify', { title, body }),
  getAutoStart: () => ipcRenderer.invoke('get-autostart'),
  setAutoStart: (v) => ipcRenderer.invoke('set-autostart', v),
  saveImage: (dataUrl) => ipcRenderer.invoke('save-image', dataUrl),
  openImage: (name) => ipcRenderer.invoke('open-image', name),
  pasteImage: () => ipcRenderer.invoke('paste-image'),
  setDetailOpen: (v) => ipcRenderer.send('detail-open', !!v),
  setDockMode: (mode) => ipcRenderer.send('set-dock-mode', mode),
  setWakeMode: (mode) => ipcRenderer.send('set-wake-mode', mode),
  panelStateNow: () => ipcRenderer.invoke('panel-state-now'),
  resizePanel: (w, h) => ipcRenderer.send('resize-panel', { w, h }),
  resetPanelSize: () => ipcRenderer.send('reset-panel-size'),
  resetFloatPos: () => ipcRenderer.send('reset-float-pos'),
  // 小浮窗气泡：页面按屏幕坐标算位移，主进程负责摆位 / 判定点击展开
  floatDragStart: () => ipcRenderer.send('float-drag-start'),
  floatDragMove: (dx, dy) => ipcRenderer.send('float-drag-move', { dx, dy }),
  floatDragEnd: (moved) => ipcRenderer.send('float-drag-end', !!moved),
  imgUrl: (name) => `memoimg:///${encodeURIComponent(name)}`,
  onPanelState: (cb) => ipcRenderer.on('panel-state', (e, s) => cb(s)),
  // 扩展（手机同步）改了数据后通知界面重新加载
  onDataChanged: (cb) => ipcRenderer.on('ext-data-changed', () => cb()),
  onOpenNew: (cb) => ipcRenderer.on('open-new', () => cb()),
  selftestLog: (line) => ipcRenderer.send('selftest-log', String(line)),
  // 自动化测试辅助：用虚拟鼠标驱动贴边状态机（真实鼠标会被用户操作覆盖，不可控）
  fakeMouse: (pt) => ipcRenderer.send('fake-mouse', pt || null),
  winBounds: () => ipcRenderer.invoke('win-bounds'),
  workArea: () => ipcRenderer.invoke('work-area'),
  probePointer: () => ipcRenderer.invoke('probe-pointer'),
  dockMode: () => ipcRenderer.invoke('dock-mode'),
  // 心跳：渲染进程每 2 秒上报一次，主进程超时收不到就判定页面已死并自动复活。
  // 顺便把页面真实状态（详情页有没有开、图钉状态）带过去，主进程据此校正自己的状态位
  heartbeat: (st) => ipcRenderer.send('heartbeat', st || null),
  // 手动把窗口拉回可见区域（面板找不见了用）
  reviveWindow: () => ipcRenderer.send('revive-window'),
  // 守卫自检：确认看门狗 / 贴边轮询真的在跑（防止"互相监督"变成互相重启的空转）
  guardDiag: () => ipcRenderer.invoke('guard-diag'),
  testHideCycle: () => ipcRenderer.invoke('test-hide-cycle'),
  testSimulateWake: () => ipcRenderer.invoke('test-simulate-wake'),
  testMinimizeCycle: () => ipcRenderer.invoke('test-minimize-cycle'),
  testHideOrphan: () => ipcRenderer.invoke('test-hide-orphan'),
});
