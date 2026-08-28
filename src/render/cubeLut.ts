/**
 * cubeLut — 解析 .cube 3D LUT 文件，产出可直接上传 GPU 的 Float32Array。
 *
 * ## 为什么需要
 *
 * CSS filter **无法表达 LUT** —— 这是能力缺失而非精度问题：
 * 老的 CSS Custom Filters（CSS Shaders）提案早已废弃，且当年也明确禁止
 * 任意采样源纹理，做不了查找表。所以 LUT 预览只能走 WebGL。
 *
 * WebGL2 支持 sampler3D，可以把 LUT 作为真正的三维纹理采样，
 * 硬件自带三线性插值 —— 不必退化成 WebGL1 时代"把 3D LUT 拼成 2D 图集"
 * 的做法（那种做法在图集边界容易采到相邻切片，出现色块）。
 *
 * ## .cube 格式
 *
 * 文本格式，关键行：
 *   LUT_3D_SIZE 33          网格边长（常见 17/33/65）
 *   DOMAIN_MIN 0 0 0        输入域下界（可省，默认 0）
 *   DOMAIN_MAX 1 1 1        输入域上界（可省，默认 1）
 *   0.0 0.0 0.0             size³ 行 RGB，**R 变化最快**
 *
 * 注意数据顺序：R 是最内层循环。写成 3D 纹理时下标要按 (b*size + g)*size + r，
 * 顺序搞反会得到一张颜色错乱但"看起来像那么回事"的图，很难察觉。
 */

export interface CubeLut {
  size: number;
  /** RGB 三通道，长度 size³ × 3，值域 0..1（已按 DOMAIN 归一化） */
  data: Float32Array;
  title?: string;
}

/** 解析 .cube 文本。格式非法时抛错（调用方应提示用户换一个文件）。 */
export function parseCube(text: string): CubeLut {
  let size = 0;
  let title: string | undefined;
  const domainMin = [0, 0, 0];
  const domainMax = [1, 1, 1];
  const values: number[] = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    // 注释与空行。# 之后是注释，但要小心 TITLE 里可能带 #，所以先判关键字
    if (!line || line.startsWith("#")) continue;

    const upper = line.toUpperCase();
    if (upper.startsWith("TITLE")) {
      title = line.slice(5).trim().replace(/^"|"$/g, "");
      continue;
    }
    if (upper.startsWith("LUT_3D_SIZE")) {
      size = parseInt(line.split(/\s+/)[1], 10);
      continue;
    }
    if (upper.startsWith("LUT_1D_SIZE")) {
      // 1D LUT 只做灰阶映射，用 3D 采样器读会得到错误结果，直接拒绝
      throw new Error("暂不支持 1D LUT（LUT_1D_SIZE），请使用 3D LUT（.cube）");
    }
    if (upper.startsWith("DOMAIN_MIN")) {
      const p = line.split(/\s+/).slice(1).map(Number);
      if (p.length === 3 && p.every(Number.isFinite)) domainMin.splice(0, 3, ...p);
      continue;
    }
    if (upper.startsWith("DOMAIN_MAX")) {
      const p = line.split(/\s+/).slice(1).map(Number);
      if (p.length === 3 && p.every(Number.isFinite)) domainMax.splice(0, 3, ...p);
      continue;
    }

    // 数据行
    const nums = line.split(/\s+/).map(Number);
    if (nums.length >= 3 && nums.every(Number.isFinite)) {
      values.push(nums[0], nums[1], nums[2]);
    }
  }

  if (!size || size < 2) throw new Error("缺少有效的 LUT_3D_SIZE");
  const expect = size * size * size * 3;
  if (values.length !== expect) {
    throw new Error(
      `LUT 数据量不符：期望 ${expect / 3} 行（${size}³），实际 ${values.length / 3} 行`);
  }

  // 按 DOMAIN 归一化到 0..1，供 sampler3D 直接使用
  const data = new Float32Array(expect);
  for (let i = 0; i < expect; i += 3) {
    for (let c = 0; c < 3; c++) {
      const span = domainMax[c] - domainMin[c] || 1;
      data[i + c] = (values[i + c] - domainMin[c]) / span;
    }
  }
  return { size, data, title };
}

/** 带缓存的 LUT 拉取：同一个 URL 只解析一次（切镜头会反复用到同一张表） */
const _cache = new Map<string, Promise<CubeLut>>();

export function loadCube(url: string): Promise<CubeLut> {
  let p = _cache.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`LUT 下载失败 ${r.status}`);
        return r.text();
      })
      .then(parseCube)
      .catch((e) => {
        // 失败不留在缓存里，否则一次网络抖动会让这张 LUT 永久用不了
        _cache.delete(url);
        throw e;
      });
    _cache.set(url, p);
  }
  return p;
}
