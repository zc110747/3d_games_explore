/**
 * P2 纹理工厂 —— 全部来自原版真实数据 / 原版真实字符串，不生成虚构游戏内容。
 *
 * 1) 战略地图底板：lib.loadPic(54,1)「城市地图图块」108 帧（12x9, 32x32/帧）。
 *    qs() L4191 用 l=d*((t.y+row)*fn+col) 取帧，本工厂用同一索引拼成整图。
 *    像素格式依据 Vt() L1916-1981 与 packColor() L34：
 *      color=true 时 data 是 Uint32Array，每像素 (a<<24|b<<16|g<<8|r)，
 *      在 little-endian 下内存字节序正好是 RGBA，可直接喂 ImageData。
 * 2) 城市名牌：文字来自 lib.getStr(58, cityId+1)（资源 58 城市名）。
 * 3) 势力旗布：颜色来自表现层 factionColor(id)，文字来自原版君主武将名。
 */
import { LABEL_CONFIG, FLAG_CONFIG, TERRAIN_CONFIG, ORIGINAL_MAP, stableHash } from './config.mjs';

function canvas2d(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D canvas 上下文');
  return { canvas: c, ctx };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/** 把一帧原版图块转成 ImageData（兼容彩色 32 位与灰度索引两种情况）。 */
function frameToImageData(pic, frameIndex) {
  const { sw, sh, frameLen, data, color } = pic;
  const start = frameIndex * frameLen;
  if (start + frameLen > data.length) throw new RangeError(`地形帧 ${frameIndex} 越界`);
  const bytes = new Uint8ClampedArray(frameLen * 4);
  if (color) {
    // Uint32Array -> RGBA 字节视图（packColor 的字节序与 ImageData 一致）
    const src = new Uint8ClampedArray(data.buffer, data.byteOffset + start * 4, frameLen * 4);
    bytes.set(src);
  } else {
    // 四灰阶 LUT（Vt() L1912-1958 / Screen.lut），由黑到白
    const lut = [[255, 255, 255], [170, 170, 170], [85, 85, 85], [0, 0, 0]];
    for (let i = 0; i < frameLen; i++) {
      const v = lut[data[start + i] & 3];
      bytes[i * 4] = v[0]; bytes[i * 4 + 1] = v[1]; bytes[i * 4 + 2] = v[2]; bytes[i * 4 + 3] = 255;
    }
  }
  return new ImageData(bytes, sw, sh);
}

/**
 * 生成 12x9 原版地形图集纹理。
 * @returns {{texture, frames, frameSize, source, degraded:boolean}}
 */
export function createTerrainAtlas(THREE, lib) {
  const o = ORIGINAL_MAP;
  const pic = lib.loadPic(TERRAIN_CONFIG.terrainPicId, 1);
  if (!pic || !pic.data || !pic.frameLen) {
    // 明确降级：不假装这是原版地形
    const { canvas, ctx } = canvas2d(o.cols * 32, o.rows * 32);
    ctx.fillStyle = '#4d5b3c';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#3c4830';
    for (let c = 0; c <= o.cols; c++) { ctx.beginPath(); ctx.moveTo(c * 32, 0); ctx.lineTo(c * 32, canvas.height); ctx.stroke(); }
    for (let r = 0; r <= o.rows; r++) { ctx.beginPath(); ctx.moveTo(0, r * 32); ctx.lineTo(canvas.width, r * 32); ctx.stroke(); }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return { texture, frames: 0, frameSize: [32, 32], degraded: true,
      source: 'DEGRADED: lib.loadPic(54,1) 不可用，使用纯色占位底板（非原版地形）' };
  }
  const { sw, sh, count } = pic;
  if (count !== TERRAIN_CONFIG.expectedFrames) {
    throw new Error(`地形帧数 ${count} != 预期 ${TERRAIN_CONFIG.expectedFrames}（12x9）`);
  }
  const { canvas, ctx } = canvas2d(o.cols * sw, o.rows * sh);
  const tile = canvas2d(sw, sh);
  for (let row = 0; row < o.rows; row++) {
    for (let col = 0; col < o.cols; col++) {
      const frameIndex = row * o.cols + col;    // 与 qs() L4191 一致
      tile.ctx.putImageData(frameToImageData(pic, frameIndex), 0, 0);
      ctx.drawImage(tile.canvas, col * sw, row * sh);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  if (THREE.SRGBColorSpace) texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return {
    texture, frames: count, frameSize: [sw, sh], degraded: false,
    source: `lib.loadPic(54,1) 108 帧，按 qs() 的 (row*12+col) 索引拼合`,
  };
}

/** 城市名称牌纹理。text 必须是原版城市名，本函数不生成名称。 */
export function createCityLabelTexture(THREE, text, { selected = false } = {}) {
  const c = LABEL_CONFIG;
  const { canvas, ctx } = canvas2d(c.canvasWidth, c.canvasHeight);
  ctx.clearRect(0, 0, c.canvasWidth, c.canvasHeight);
  ctx.fillStyle = selected ? c.selectedBackground : c.background;
  ctx.strokeStyle = selected ? c.selectedBorder : c.border;
  ctx.lineWidth = selected ? 5 : 3;
  roundRect(ctx, 4, 4, c.canvasWidth - 8, c.canvasHeight - 8, 10);
  ctx.fill(); ctx.stroke();
  ctx.font = c.font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 6;
  ctx.strokeStyle = c.strokeColor;
  ctx.strokeText(text, c.canvasWidth / 2, c.canvasHeight / 2 + 2);
  ctx.fillStyle = selected ? '#ffe9a8' : c.textColor;
  ctx.fillText(text, c.canvasWidth / 2, c.canvasHeight / 2 + 2);
  const texture = new THREE.CanvasTexture(canvas);
  if (THREE.SRGBColorSpace) texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** 势力旗布纹理：颜色由 factionColor 决定，文字是原版君主武将名（首字）。 */
export function createFlagTexture(THREE, { color, label, empty = false, factionId = 0 }) {
  const c = FLAG_CONFIG;
  const { canvas, ctx } = canvas2d(c.canvasWidth, c.canvasHeight);
  const hex = `#${(color >>> 0 & 0xffffff).toString(16).padStart(6, '0')}`;
  const grad = ctx.createLinearGradient(0, 0, c.canvasWidth, 0);
  grad.addColorStop(0, hex);
  grad.addColorStop(0.55, hex);
  grad.addColorStop(1, empty ? '#4b5563' : '#111827');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, c.canvasWidth, c.canvasHeight);
  // 旗面纹样：按势力 ID 稳定变化（表现层装饰，不是游戏数据）
  const seed = stableHash(`flag:${factionId}`);
  ctx.strokeStyle = 'rgba(255,240,200,0.55)';
  ctx.lineWidth = 3;
  ctx.strokeRect(5, 5, c.canvasWidth - 10, c.canvasHeight - 10);
  ctx.beginPath();
  ctx.arc(c.canvasWidth * 0.5, c.canvasHeight * 0.5, 20 + (seed % 9), 0, Math.PI * 2);
  ctx.stroke();
  ctx.font = 'bold 46px "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineWidth = 5; ctx.strokeStyle = '#241a10';
  ctx.strokeText(label || '·', c.canvasWidth / 2, c.canvasHeight / 2 + 2);
  ctx.fillStyle = '#fff6dc';
  ctx.fillText(label || '·', c.canvasWidth / 2, c.canvasHeight / 2 + 2);
  const texture = new THREE.CanvasTexture(canvas);
  if (THREE.SRGBColorSpace) texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}
