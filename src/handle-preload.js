const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('memoHandle', {
  // 点一下小把手就把主面板叫出来（不经过贴边轮询，鼠标划边不会误触发）
  open: () => ipcRenderer.send('handle-open'),
});
