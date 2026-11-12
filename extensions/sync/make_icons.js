/* 给手机页面生成 App 图标（纯 Node，手写 PNG 编码，不依赖任何第三方库）。
   产出 icon-192.png / icon-512.png / icon-maskable-512.png，给 manifest 和 iOS 用。
   用法：node extensions/sync/make_icons.js */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

/* ---- 极简 PNG 编码 ---- */
let table = null;
function crc32(buf) {
  if (!table) {
    table = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0;
    rgba.copy(raw, o, y * w * 4, (y + 1) * w * 4);
    o += w * 4;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---- 绘制 ---- */
const GREEN = [0x4a, 0x7c, 0x59, 255];
const WHITE = [255, 255, 255, 255];
const SOFT = [255, 255, 255, 110];

function px(buf, w, x, y, c) {
  if (x < 0 || y < 0 || x >= w || y >= buf.length / w / 4) return;
  const i = (y * w + x) * 4;
  const a = c[3] / 255;
  buf[i] = Math.round(buf[i] * (1 - a) + c[0] * a);
  buf[i + 1] = Math.round(buf[i + 1] * (1 - a) + c[1] * a);
  buf[i + 2] = Math.round(buf[i + 2] * (1 - a) + c[2] * a);
  buf[i + 3] = 255;
}
function rect(buf, w, x0, y0, x1, y1, c) {
  for (let y = Math.round(y0); y <= Math.round(y1); y++)
    for (let x = Math.round(x0); x <= Math.round(x1); x++) px(buf, w, x, y, c);
}
function roundCorners(buf, w, h, r) {
  const cut = (x, y, cx, cy) => {
    const dx = x - cx, dy = y - cy;
    if (dx * dx + dy * dy > r * r) buf[(y * w + x) * 4 + 3] = 0;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x < r && y < r) cut(x, y, r, r);
      else if (x > w - 1 - r && y < r) cut(x, y, w - 1 - r, r);
      else if (x < r && y > h - 1 - r) cut(x, y, r, h - 1 - r);
      else if (x > w - 1 - r && y > h - 1 - r) cut(x, y, w - 1 - r, h - 1 - r);
    }
  }
}

/** 便签 + 三条横线 + 折角。padRatio：四周留白比例（maskable 图标要留安全区） */
function draw(size, padRatio) {
  const rgba = Buffer.alloc(size * size * 4);
  const pad = Math.round(size * padRatio);
  const s = size - pad * 2;
  rect(rgba, size, pad, pad, size - pad, size - pad, GREEN);
  roundCorners(rgba, size, size, Math.round(size * 0.22));

  const bx = pad + s * 0.23, by = pad + s * 0.15;
  const bw = s * 0.54, bh = s * 0.70;
  rect(rgba, size, bx, by, bx + bw, by + bh, WHITE);          // 便签纸
  rect(rgba, size, bx + bw - s * 0.14, by, bx + bw, by + s * 0.14, SOFT);  // 折角
  const lh = Math.max(1, Math.round(s * 0.05));                // 三条横线
  for (let i = 0; i < 3; i++) {
    const ly = by + bh * (0.22 + i * 0.26);
    rect(rgba, size, bx + bw * 0.17, ly, bx + bw * 0.17 + bw * 0.66, ly + lh, GREEN);
  }
  return rgba;
}

const targets = [
  ['icon-192.png', 192, 0],
  ['icon-512.png', 512, 0],
  ['icon-maskable-512.png', 512, 0.14],   // 安卓自适应图标：四周留 14% 安全区
];
targets.forEach(([name, size, pad]) => {
  const buf = encodePng(size, size, draw(size, pad));
  fs.writeFileSync(path.join(__dirname, name), buf);
  console.log('生成 ' + name + '  ' + size + 'x' + size + '  ' + Math.round(buf.length / 1024) + ' KB');
});
