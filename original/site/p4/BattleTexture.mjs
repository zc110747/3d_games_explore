/**
 * P4 战斗图集 —— 直接用原版资源 lib.loadPic(4,1)「战斗地图图块」46 帧 16x16。
 *
 * 依据真实源码：
 *   - yo() L5755 在战斗开始时把 g_TileId 置为 4；
 *   - to() L5628 / eo() L5647 都用 drawPicEx(图集, g_FightMap[格], ...)，
 *     也就是「地图数据里的图块号 = 图集帧号」，本模块只是把同一份帧拼成一张纹理。
 *   - 像素格式与 P2 地形图集一致（Vt() L1912-1981 解码后：
 *     color=true 时 data 为 Uint32Array，每像素 (a<<24|b<<16|g<<8|r)）。
 *
 * 本模块不生成任何虚构美术：帧号越界时用透明格而不是画一个假地形。
 */

function canvas2d(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D canvas 上下文');
  return { canvas: c, ctx };
}

/** 把一帧原版图块转成 ImageData（兼容 32 位彩色与四灰阶索引两种解码结果）。 */
function frameToImageData(pic, frameIndex) {
  const { sw, sh, frameLen, data, color } = pic;
  const start = frameIndex * frameLen;
  const bytes = new Uint8ClampedArray(frameLen * 4);
  if (color) {
    if (start + frameLen > data.length) return new ImageData(sw, sh);
    const src = new Uint8ClampedArray(data.buffer, data.byteOffset + start * 4, frameLen * 4);
    bytes.set(src);
  } else {
    const lut = [[255, 255, 255], [170, 170, 170], [85, 85, 85], [0, 0, 0]];
    for (let i = 0; i < frameLen; i++) {
      const v = lut[(data[start + i] || 0) & 3];
      bytes[i * 4] = v[0]; bytes[i * 4 + 1] = v[1]; bytes[i * 4 + 2] = v[2]; bytes[i * 4 + 3] = 255;
    }
  }
  return new ImageData(bytes, sw, sh);
}

/**
 * 生成战斗图块图集纹理。
 * @returns {{texture, frames, cols, rows, frameSize:[number,number], degraded:boolean, source:string}}
 */
export function createBattleTileAtlas(THREE, lib, picId, gridCols = 8) {
  const pic = lib && typeof lib.loadPic === 'function' ? lib.loadPic(picId, 1) : null;
  const size = (pic && pic.sw) || 16;
  const frames = (pic && pic.count) || 0;
  const cols = gridCols;
  const rows = Math.max(1, Math.ceil(Math.max(frames, 1) / cols));

  if (!pic || !pic.data || !pic.frameLen) {
    // 明确降级：不假装这是原版战斗地形
    const { canvas, ctx } = canvas2d(cols * size, rows * size);
    ctx.fillStyle = '#3c4a36';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const texture = new THREE.CanvasTexture(canvas);
    if (THREE.SRGBColorSpace) texture.colorSpace = THREE.SRGBColorSpace;
    return {
      texture, frames: 0, cols, rows, frameSize: [size, size], degraded: true,
      source: `DEGRADED: lib.loadPic(${picId},1) 不可用，使用纯色占位（非原版图块）`,
    };
  }

  const { canvas, ctx } = canvas2d(cols * pic.sw, rows * pic.sh);
  const cell = canvas2d(pic.sw, pic.sh);
  for (let i = 0; i < frames; i++) {
    cell.ctx.clearRect(0, 0, pic.sw, pic.sh);
    cell.ctx.putImageData(frameToImageData(pic, i), 0, 0);
    ctx.drawImage(cell.canvas, (i % cols) * pic.sw, Math.floor(i / cols) * pic.sh);
  }
  const texture = new THREE.CanvasTexture(canvas);
  if (THREE.SRGBColorSpace) texture.colorSpace = THREE.SRGBColorSpace;
  // 像素图：最近邻 + 不生成 mipmap，避免相邻帧渗色（格子边界必须清楚）
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;

  return {
    texture, frames, cols, rows, frameSize: [pic.sw, pic.sh], degraded: false,
    source: `lib.loadPic(${picId},1) ${frames} 帧 ${pic.sw}x${pic.sh}，帧号 = 地图图块号`,
  };
}

/**
 * 兵种徽章（billboard）：整图视角下 1 格仅 ~15px，纯 3D 方块难以辨认敌我，
 * 因此额外画一个圆形徽章 —— 底色 = 势力色（表现层映射），字 = 原版兵种名首字。
 * 只做视觉标识，不参与任何判定。
 */
export function createUnitBadgeTexture(THREE, { glyph, color, dark = false }) {
  const size = 128;
  const { canvas, ctx } = canvas2d(size, size);
  ctx.clearRect(0, 0, size, size);
  const hex = `#${(color >>> 0 & 0xffffff).toString(16).padStart(6, '0')}`;
  const cx = size / 2, cy = size / 2 - 6, r = size * 0.34;
  // 底部小尖角，像一个插在地图上的标记
  ctx.beginPath();
  ctx.moveTo(cx - 10, cy + r * 0.6);
  ctx.lineTo(cx, size - 8);
  ctx.lineTo(cx + 10, cy + r * 0.6);
  ctx.closePath();
  ctx.fillStyle = hex;
  ctx.fill();
  ctx.strokeStyle = 'rgba(12,10,8,0.85)';
  ctx.lineWidth = 4;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = hex;
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.strokeStyle = dark ? 'rgba(255,240,210,0.92)' : 'rgba(15,12,9,0.85)';
  ctx.stroke();

  ctx.font = 'bold 60px "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = dark ? '#1a140e' : '#fff6dc';
  ctx.fillText(glyph || '?', cx, cy + 2);

  const texture = new THREE.CanvasTexture(canvas);
  if (THREE.SRGBColorSpace) texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** 单位旗帜/名牌用的通用文字纹理（文字一律由调用方给真实名称）。 */
export function createUnitLabelTexture(THREE, text, { width = 256, height = 64, color = '#fff6dc' } = {}) {
  const { canvas, ctx } = canvas2d(width, height);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = 'rgba(18,14,10,0.78)';
  ctx.strokeStyle = 'rgba(224,190,116,0.9)';
  ctx.lineWidth = 3;
  const r = 10;
  ctx.beginPath();
  ctx.moveTo(r, 2); ctx.lineTo(width - r, 2); ctx.quadraticCurveTo(width - 2, 2, width - 2, r);
  ctx.lineTo(width - 2, height - r); ctx.quadraticCurveTo(width - 2, height - 2, width - r, height - 2);
  ctx.lineTo(r, height - 2); ctx.quadraticCurveTo(2, height - 2, 2, height - r);
  ctx.lineTo(2, r); ctx.quadraticCurveTo(2, 2, r, 2);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.font = 'bold 38px "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 5;
  ctx.strokeStyle = '#241a10';
  ctx.strokeText(text, width / 2, height / 2 + 2);
  ctx.fillStyle = color;
  ctx.fillText(text, width / 2, height / 2 + 2);
  const texture = new THREE.CanvasTexture(canvas);
  if (THREE.SRGBColorSpace) texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}
