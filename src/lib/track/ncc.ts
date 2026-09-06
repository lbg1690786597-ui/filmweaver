/**
 * lib/track/ncc.ts — 灰度归一化互相关（NCC）模板匹配（批次 6 / 6.5，纯函数）
 *
 * ## 为什么是 NCC，为什么不引第三方
 *
 * ffmpeg 4.4 **没有可用的目标跟踪滤镜**（`vidstab` 是整幅防抖，不是跟某个目标），
 * 所以跟踪只能在客户端算。候选里 OpenCV.js 是 ~8 MB 的 WASM，为「把一个遮挡框
 * 跟住 5 秒」引入它不成比例；而 NCC 模板匹配是**二十行数学**，且正好命中本项目
 * 的场景：短镜、目标不怎么变形、只要位移。
 *
 * NCC 而不是 SSD/SAD 的理由是**它对亮度线性变化免疫**：
 *   `ncc = Σ(t−t̄)(p−p̄) / √(Σ(t−t̄)²·Σ(p−p̄)²)`
 * 分子分母同时消掉了均值与增益，所以镜头里一次打光变化、一次淡入
 * 不会把匹配打崩 —— 而 SAD 会当场跟丢。代价是每个候选位置多两个平方和，
 * 在下面的单遍计算式里是同一趟循环里的两次乘加，可以忽略。
 *
 * ## 三个把"能算"变成"够快"的决定（都是可量的，不是拍脑袋）
 *
 * 1. **降采样到宽 ~320px 再匹配**（由调用方在抽帧时完成，本模块只吃已降采样的帧）。
 *    1080×1920 全分辨率下一次匹配是 ~10⁹ 次乘加，没法在主线程上跑；
 *    320 宽下同样的搜索是 ~10⁷。而遮挡框的定位精度只需要到「像素的百分之几」，
 *    320 宽下 1px = 0.31%，远细于用户拖动的精度。
 * 2. **模板按 stride 抽样，上限 `MAX_SAMPLES` 个点**。NCC 的代价是
 *    `候选数 × 模板点数`，而模板点数从 1024 涨到 10000 并不会让峰值更准
 *    —— 它只是在同一个相关面上多采了点。抽样把这一项钉死成常数。
 * 3. **把「模板点 → 帧内偏移」预计算成一维数组 `off`**（见 `Template.off`）。
 *    内层循环因此只有一次加法和一次取数，没有乘法、没有二维下标。
 *    这就是为什么 `Template` 记住了它是给哪个宽度的帧用的（`fw`）：
 *    `off` 只对那个宽度成立，换了宽度必须重建模板，否则会**静默**读错像素。
 *
 * ## 一个刻意不做的东西：模板自适应更新
 *
 * 常见做法是「匹配得分高就把模板换成当前帧的патch」，好处是能跟住缓慢的形变，
 * 代价是**漂移会累积且完全没有信号**：每帧半个像素的偏差，200 帧后框已经跑到
 * 隔壁去了，而每一帧的得分都很高，算法自己认为一切正常。
 *
 * 本模块**固定用第一帧的模板**。后果是目标转身/变形时得分会掉下去 ——
 * 那正是我们想要的：掉到阈值以下就判跟丢、停在最后可信帧、跟用户说人话
 * （见 `track.ts`）。**宁可诚实地停下，也不要悄悄写一串烂数据进去。**
 *
 * 本文件零 import、无 DOM、无 `import.meta.env`，所以 `verify-track.ts` 能在
 * node 下把每一条性质真跑一遍，而不是靠 grep 源码断言。
 */

/** 已降采样的灰度帧。`data.length === w * h`，每字节一个像素（0..255）。 */
export interface GrayFrame {
  w: number;
  h: number;
  data: Uint8Array;
}

/** 整数像素框（左上角 + 宽高）。 */
export interface BoxPx {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 比例框（0..1，与 `MosaicParams` / `RegionKeyframe` 同口径）。 */
export interface BoxRel {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 模板点数上限。
 *
 * 1024 是「代价常数化」与「峰值可辨」之间的取值：一个 96×77 的框有 7392 个像素，
 * 抽到 1024 个点仍是每 3px 取一个，足以让相关峰比旁瓣高出一大截；
 * 而代价从 `候选数×7392` 掉到 `候选数×1024`，正好把一次匹配压进个位数毫秒
 * （实测见 §0.6 的 6.5 行）。
 */
export const MAX_SAMPLES = 1024;

/**
 * 模板对比度（灰度标准差）的下限。
 *
 * 低于它意味着这块区域几乎是纯色 —— **纯色没有可跟踪的信息**：NCC 的分母
 * 里有 `Σ(t−t̄)²`，纯色时它是 0，相关系数根本没有定义。这种输入不该产出
 * 一串"看起来在动"的关键帧，而该在开始之前就告诉用户「这块区域没有纹理」。
 *
 * 6 是 0..255 灰度上的经验值：一面被均匀打光的白墙实测 sd < 3，
 * 而带一点织物纹理的衣服就已经在 12 以上。
 */
export const MIN_TEMPLATE_SD = 6;

/**
 * 预处理好的模板。**只对宽度为 `fw` 的帧有效**（见文件头第 3 点）。
 *
 * `sumT` / `sumT2` 在建模板时算一次，之后每个候选位置都复用 ——
 * 匹配的内层循环因此只需要累加 `p`、`p²`、`t·p` 三项。
 */
export interface Template {
  /** 模板宽高（整数像素），也是匹配时候选框的宽高 */
  w: number;
  h: number;
  /** 本模板的 `off` 是按这个帧宽算的；换宽度必须重建 */
  fw: number;
  /** 采样点相对模板左上角的一维偏移（`ty * fw + tx`） */
  off: Int32Array;
  /** 各采样点的灰度值 */
  val: Float64Array;
  n: number;
  sumT: number;
  sumT2: number;
  /** 模板灰度标准差；`< MIN_TEMPLATE_SD` 表示这块区域没有纹理 */
  sd: number;
}

/** 匹配结果。`score` 是 NCC，取值 −1..1；1 = 完全一致。 */
export interface MatchResult {
  x: number;
  y: number;
  score: number;
}

const clampInt = (v: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, Math.round(v)));

/**
 * RGBA 字节 → 灰度帧。系数用 ITU-R BT.601 的 `0.299/0.587/0.114`
 * （`getImageData` 给的是 sRGB，601 的亮度系数是这套值上的标准做法）。
 *
 * ⚠️ 长度不匹配时**抛**而不是截断：`getImageData` 的返回长度与传入的 w/h
 * 对不上，说明抽帧那一侧算错了尺寸，静默截断会让整段跟踪对着半张图跑。
 */
export function grayFromRGBA(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): GrayFrame {
  if (w <= 0 || h <= 0) throw new Error(`grayFromRGBA: 非法尺寸 ${w}x${h}`);
  if (rgba.length < w * h * 4) {
    throw new Error(`grayFromRGBA: 字节数 ${rgba.length} 不足 ${w}x${h}x4`);
  }
  const out = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) {
    out[i] = (rgba[j] * 0.299 + rgba[j + 1] * 0.587 + rgba[j + 2] * 0.114) | 0;
  }
  return { w, h, data: out };
}

/** 比例框 → 帧内整数像素框，并夹持进画面（至少 1×1）。 */
export function toPx(box: BoxRel, frame: { w: number; h: number }): BoxPx {
  const x = clampInt(box.x * frame.w, 0, Math.max(0, frame.w - 1));
  const y = clampInt(box.y * frame.h, 0, Math.max(0, frame.h - 1));
  const w = clampInt(box.w * frame.w, 1, frame.w - x);
  const h = clampInt(box.h * frame.h, 1, frame.h - y);
  return { x, y, w, h };
}

/** 整数像素框 → 比例框。 */
export function toRel(box: BoxPx, frame: { w: number; h: number }): BoxRel {
  return {
    x: box.x / frame.w,
    y: box.y / frame.h,
    w: box.w / frame.w,
    h: box.h / frame.h,
  };
}

/**
 * 从一帧里截出模板。
 *
 * 采样 stride 由框的面积推出：`stride = ceil(√(area / maxSamples))`，
 * 于是任意大小的框都落在 `maxSamples` 附近，代价与框大小无关。
 * 小框（面积 < maxSamples）stride = 1，即全采。
 */
export function makeTemplate(
  frame: GrayFrame, box: BoxPx, maxSamples: number = MAX_SAMPLES,
): Template {
  const bw = Math.max(1, Math.min(box.w, frame.w - box.x));
  const bh = Math.max(1, Math.min(box.h, frame.h - box.y));
  const area = bw * bh;
  const stride = Math.max(1, Math.ceil(Math.sqrt(area / Math.max(1, maxSamples))));

  const off: number[] = [];
  const val: number[] = [];
  let sumT = 0, sumT2 = 0;
  for (let ty = 0; ty < bh; ty += stride) {
    for (let tx = 0; tx < bw; tx += stride) {
      const v = frame.data[(box.y + ty) * frame.w + (box.x + tx)];
      off.push(ty * frame.w + tx);
      val.push(v);
      sumT += v;
      sumT2 += v * v;
    }
  }
  const n = val.length;
  const mean = n ? sumT / n : 0;
  // `Math.max(0, …)` 挡的是浮点误差把一个恒为 0 的方差算成 −1e−13，`sqrt` 会给 NaN
  const varT = n ? Math.max(0, sumT2 / n - mean * mean) : 0;
  return {
    w: bw, h: bh, fw: frame.w,
    off: Int32Array.from(off), val: Float64Array.from(val),
    n, sumT, sumT2, sd: Math.sqrt(varT),
  };
}

export interface MatchOpts {
  /** 搜索窗相对模板尺寸的**每边**外扩比例，缺省 0.5（= 上一帧框外扩 50%） */
  expand?: number;
  /** 搜索半径的像素下限，缺省 8。小框在 320 宽的帧上只有十几像素，
   *  只按比例算会让搜索窗小到跟不上快速移动的目标。 */
  minRadiusPx?: number;
}

/**
 * 在 `frame` 里、以 `prev` 为中心的搜索窗内找模板的最佳位置。
 *
 * 搜索窗被夹持成「候选框整个落在画面内」——**这是有意的**，不是偷懒：
 * 只有整框在画面内，NCC 才是在比同样多的像素；让框超出边界再补零，
 * 会造出一个"边界处相关性特别高"的假峰（补的零与模板暗部相关）。
 * 目标真的走出画面时，得分自然掉下去 → 由 `track.ts` 判跟丢并如实告诉用户。
 *
 * 返回的 `score` 在以下两种情况下是 0（= 必然低于任何合理阈值，判跟丢）：
 *   · 模板或候选块方差为 0（纯色），相关系数无定义；
 *   · 画面比模板还小，压根没有合法候选位置。
 */
export function matchTemplate(
  frame: GrayFrame, tpl: Template, prev: BoxPx, opts: MatchOpts = {},
): MatchResult {
  if (frame.w !== tpl.fw) {
    // 静默读错像素是最难查的一类 bug：`off` 是按 `tpl.fw` 展平的，
    // 换个宽度还照用，等于每行都错位一点点，跟踪结果看起来"只是不太准"。
    throw new Error(`matchTemplate: 帧宽 ${frame.w} 与模板的 ${tpl.fw} 不一致`);
  }
  const expand = opts.expand ?? 0.5;
  const minR = opts.minRadiusPx ?? 8;
  const rx = Math.max(minR, Math.round(expand * tpl.w));
  const ry = Math.max(minR, Math.round(expand * tpl.h));

  const xLo = Math.max(0, prev.x - rx);
  const xHi = Math.min(frame.w - tpl.w, prev.x + rx);
  const yLo = Math.max(0, prev.y - ry);
  const yHi = Math.min(frame.h - tpl.h, prev.y + ry);
  if (xHi < xLo || yHi < yLo || tpl.n === 0) return { x: prev.x, y: prev.y, score: 0 };

  const { off, val, n, sumT, sumT2, fw } = tpl;
  // 分母里模板那一半是常数，提到循环外
  const varT = n * sumT2 - sumT * sumT;
  if (varT <= 0) return { x: prev.x, y: prev.y, score: 0 };

  const data = frame.data;
  let bestX = prev.x, bestY = prev.y, best = -2;
  for (let oy = yLo; oy <= yHi; oy++) {
    const rowBase = oy * fw;
    for (let ox = xLo; ox <= xHi; ox++) {
      const base = rowBase + ox;
      let sumP = 0, sumP2 = 0, sumTP = 0;
      for (let i = 0; i < n; i++) {
        const p = data[base + off[i]];
        sumP += p;
        sumP2 += p * p;
        sumTP += val[i] * p;
      }
      const varP = n * sumP2 - sumP * sumP;
      if (varP <= 0) continue;               // 纯色候选块，相关系数无定义
      const s = (n * sumTP - sumT * sumP) / Math.sqrt(varT * varP);
      if (s > best) { best = s; bestX = ox; bestY = oy; }
    }
  }
  return { x: bestX, y: bestY, score: best <= -2 ? 0 : best };
}
