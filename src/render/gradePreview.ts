/**
 * GradePreview — WebGL2 调色预览渲染器。
 *
 * ## 为什么不用 CSS filter
 *
 * CSS filter **表达不了 LUT** —— 这是能力缺失，不是精度问题。
 * 老的 CSS Custom Filters 提案早已废弃，且当年也禁止任意采样源纹理。
 * 而 LUT 恰恰是调色的核心手段之一（.cube 导入功能一直摆在滤镜面板里）。
 *
 * 另外 CSS 那套只能"凑"：色温用 sepia 近似、高光/阴影没有分区调整，
 * 跟 ffmpeg 的 eq/colorbalance 差得远，用户按预览调完导出会发现不是一回事。
 *
 * ## 与最终渲染的一致性
 *
 * 本文件的运算**逐条对齐 backend/app/media.py 的 build_transform_filters**：
 *
 *   顺序：eq(brightness/contrast/saturation/gamma)
 *      → colorbalance(色温/色调)
 *      → eq(gamma, gamma_weight=0.35)(阴影)
 *      → lut3d
 *
 *   换算：brightness = exposure/200      contrast = 1+contrast/100
 *        saturation = 1+saturation/100   gamma    = 1+highlights/300
 *        temp = temperature/200          tint     = tint/200
 *        阴影 gamma = 1+shadows/200，只作用暗部
 *
 * 顺序错了结果就不同（调色是非交换的），所以改这里必须同步改 media.py，
 * 反之亦然。锐化(unsharp)未实现 —— 卷积在预览里收益低、成本高，
 * 由 UI 标注"仅渲染时生效"。
 *
 * ## 降级
 *
 * 拿不到 WebGL2（旧显卡/远程桌面/浏览器禁用）时 create 返回 null，
 * 调用方退回 CSS 近似方案。绝不能因为没有 WebGL 就黑屏。
 */

import type { TransformMeta } from "../api";
import { loadCube, type CubeLut } from "./cubeLut";

const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  // 全屏三角形覆盖，比两个三角形的四边形少一次光栅化边界
  v_uv = (a_pos + 1.0) * 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_frame;
uniform sampler3D u_lut;
uniform bool  u_hasLut;
uniform float u_lutSize;

uniform float u_bright;     // -0.5..0.5   (exposure/200)
uniform float u_contrast;   // 1+c/100
uniform float u_satur;      // 1+s/100
uniform float u_gamma;      // 1+highlights/300
uniform float u_temp;       // temperature/200
uniform float u_tint;       // tint/200
uniform float u_shadowGamma;// 1+shadows/200
uniform float u_vignette;   // 0..1
// 模糊：mipmap 层级 + 该层级上的 3x3 取样间距。<0 表示不模糊。
// 为什么不是单纯的 3x3 均值，见下方 main() 里的说明。
uniform float u_blurLod;
uniform vec2  u_blurStep;   // uv 单位

const vec3 LUMA = vec3(0.299, 0.587, 0.114);

// ffmpeg eq 的 gamma：pow(x, 1/gamma)
vec3 applyGamma(vec3 c, float g) {
  return g == 1.0 ? c : pow(max(c, 0.0), vec3(1.0 / g));
}

void main() {
  vec3 c;
  if (u_blurLod >= 0.0) {
    // ⚠️ 这里**不是**「3x3 均值就够了」。
    //
    // CSS 路径写的是 blur(强度/100*6 px)，作用在**显示尺寸**上；
    // 而 shader 跑在**源分辨率**上（1080 宽的片子显示成 400 宽时差 2.7 倍）。
    // 旧实现用固定 3x3、间距只有 blur*6 个**源**像素，实测等效标准差约 5 源像素，
    // 相当于显示尺寸上不到 2px —— 比 CSS 弱一个数量级。
    // 之前这条路径被自举死锁挡着从没跑起来，所以没人发现；一旦 GPU 路径生效，
    // 用户会看到"模糊滑块几乎没用了"，那是**回退**，不是新功能。
    //
    // 直接把 3x3 的间距拉到 ~20 源像素也不行：三个离散抽头会出现三重鬼影。
    // 所以用 mipmap 承担大尺度、3x3 抽头负责把 mip 的方块感抹平：
    //   mip 层级 L 的一次双线性取样 ≈ 宽 2^L 的方块滤波（σ ≈ 0.289·2^L），
    //   取 L 使其 σ 恰为目标的一半，剩下 3/4 的方差交给间距 1.06σ 的 3x3。
    // 两者方差相加即目标 σ²，且抽头间距小于 mip 方块宽度，重叠平滑无鬼影。
    c = vec3(0.0);
    for (int y = -1; y <= 1; y++)
      for (int x = -1; x <= 1; x++)
        c += textureLod(u_frame, v_uv + vec2(float(x), float(y)) * u_blurStep,
                        u_blurLod).rgb;
    c /= 9.0;
  } else {
    c = texture(u_frame, v_uv).rgb;
  }

  // ---- eq: brightness / contrast / saturation / gamma ----
  // 对齐 ffmpeg eq 的实现顺序：先亮度偏移，再以 0.5 为轴做对比度
  c += u_bright;
  c = (c - 0.5) * u_contrast + 0.5;
  float l = dot(c, LUMA);
  c = mix(vec3(l), c, u_satur);
  c = applyGamma(c, u_gamma);

  // ---- colorbalance: 色温推 R/B，色调推 G ----
  // ffmpeg 的 rm/bm/gm 作用于中间调，这里用亮度加权近似其权重曲线
  float mid = 1.0 - abs(dot(c, LUMA) * 2.0 - 1.0);   // 中间调权重
  c.r += u_temp * mid;
  c.b -= u_temp * mid;
  c.g += u_tint * mid;

  // ---- 阴影：gamma_weight=0.35 表示只对暗部生效 ----
  if (u_shadowGamma != 1.0) {
    float lum = dot(clamp(c, 0.0, 1.0), LUMA);
    float w = pow(1.0 - lum, 1.0 / 0.35);            // 越暗权重越大
    c = mix(c, applyGamma(clamp(c, 0.0, 1.0), u_shadowGamma), w);
  }

  c = clamp(c, 0.0, 1.0);

  // ---- 3D LUT ----
  // 半像素内缩：直接用 0..1 采样会在边界取到相邻格子，纯白/纯黑处偏色
  if (u_hasLut) {
    float s = u_lutSize;
    vec3 uvw = c * ((s - 1.0) / s) + (0.5 / s);
    c = texture(u_lut, uvw).rgb;
  }

  // ---- 暗角（渲染端用 vignette 滤镜，这里按半径衰减近似）----
  if (u_vignette > 0.001) {
    vec2 d = v_uv - 0.5;
    float r = length(d) * 1.4142;
    c *= 1.0 - smoothstep(0.45, 1.0, r) * u_vignette * 0.85;
  }

  outColor = vec4(c, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    // 这条会冒到调色面板的 toast 上：说清"预览不可用、但调色参数没丢"，
    // 原始编译日志留给控制台，不塞给用户。
    console.error("[gradePreview] shader compile failed:", log);
    throw new Error("画面预览用不了（显卡或驱动不支持），调色参数已保存，导出不受影响");
  }
  return sh;
}

export class GradePreview {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private frameTex: WebGLTexture;
  private lutTex: WebGLTexture | null = null;
  private lutSize = 0;
  private lutUrl = "";
  /** 无 LUT 时的占位 3D 纹理，见 draw() 里关于纹理单元冲突的说明 */
  private dummyTex: WebGLTexture | null = null;
  private uni: Record<string, WebGLUniformLocation | null> = {};

  /** 1×1×1 的恒等占位：只为让 1 号单元上的 sampler3D 处于"完整"状态 */
  private dummyLut(gl: WebGL2RenderingContext): WebGLTexture {
    if (this.dummyTex) return this.dummyTex;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, t);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, 1, 1, 1, 0, gl.RGB, gl.FLOAT,
                  new Float32Array([0, 0, 0]));
    this.dummyTex = t;
    return t;
  }

  private constructor(gl: WebGL2RenderingContext, prog: WebGLProgram) {
    this.gl = gl;
    this.prog = prog;

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    // 覆盖全屏的大三角形
    gl.bufferData(gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "a_pos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this.frameTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.frameTex);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) {
      gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    for (const n of ["u_frame", "u_lut", "u_hasLut", "u_lutSize", "u_bright",
                     "u_contrast", "u_satur", "u_gamma", "u_temp", "u_tint",
                     "u_shadowGamma", "u_vignette", "u_blurLod", "u_blurStep"]) {
      this.uni[n] = gl.getUniformLocation(prog, n);
    }
  }

  /** 创建渲染器；拿不到 WebGL2 时返回 null（调用方退回 CSS 方案） */
  static create(canvas: HTMLCanvasElement): GradePreview | null {
    const gl = canvas.getContext("webgl2", {
      alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: false,
    });
    if (!gl) return null;
    try {
      const prog = gl.createProgram()!;
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        throw new Error(`link 失败: ${gl.getProgramInfoLog(prog)}`);
      }
      gl.useProgram(prog);
      return new GradePreview(gl, prog);
    } catch (e) {
      console.warn("[GradePreview] 初始化失败，退回 CSS 预览:", e);
      return null;
    }
  }

  /** 上传 LUT 为 3D 纹理。同一 URL 重复调用会跳过。 */
  private async ensureLut(url: string | undefined) {
    if (!url) { this.lutUrl = ""; this.lutSize = 0; return; }
    if (url === this.lutUrl && this.lutTex) return;
    let cube: CubeLut;
    try {
      cube = await loadCube(url);
    } catch (e) {
      console.warn("[GradePreview] LUT 加载失败，本次跳过:", e);
      this.lutUrl = ""; this.lutSize = 0;
      return;
    }
    const gl = this.gl;
    if (!this.lutTex) this.lutTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) {
      gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
    }
    // ⚠️ 内部格式必须是 **RGB16F，不能是 RGB32F**。
    // WebGL2 里 32 位浮点纹理**默认不可线性过滤**：要 LINEAR 必须先
    // `getExtension("OES_texture_float_linear")`，否则该纹理判定为"不完整"，
    // 采样一律返回 (0,0,0,1) —— 表现就是**一加 LUT 画面全黑**，
    // 而且 `getError()` 依然是 0，没有任何报错线索（已实测复现）。
    // 半浮点的线性过滤是 WebGL2 **核心**能力，不依赖任何扩展，各端一致；
    // LUT 值域是 0..1，half 的精度远超 .cube 本身，且显存减半。
    // 硬件三线性插值直接可用，无需在 shader 里手写四面体插值。
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, cube.size, cube.size, cube.size,
                  0, gl.RGB, gl.FLOAT, cube.data);
    this.lutSize = cube.size;
    this.lutUrl = url;
  }

  /** 把一帧画面按 tm 调色后画到 canvas。video 未就绪时静默跳过。 */
  async draw(video: HTMLVideoElement, tm: TransformMeta | null | undefined) {
    const gl = this.gl;
    const w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) return;

    const cv = gl.canvas as HTMLCanvasElement;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    gl.viewport(0, 0, w, h);

    await this.ensureLut(tm?.lut);

    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.frameTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
    gl.uniform1i(this.uni.u_frame, 0);

    // ---- 模糊：按**显示尺寸**换算，再拆成 mipmap + 3x3（见 shader 里的说明）----
    // cv.clientWidth 是 canvas 的 CSS 宽度；为 0（还没布局/隐藏）时退化为 1:1。
    const blurN = (tm?.blur || 0) / 100;
    if (blurN > 0.001) {
      const srcPerCss = cv.clientWidth ? w / cv.clientWidth : 1;
      // CSS 路径是 blur(blurN*6 px)，那是显示像素上的高斯标准差
      const sigma = Math.max(0.5, blurN * 6 * srcPerCss);
      // mip 只在需要时生成：不模糊的帧不该白付一次 generateMipmap
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.generateMipmap(gl.TEXTURE_2D);
      // 0.289·2^L = σ/2  →  L = log2(σ) + 0.79
      gl.uniform1f(this.uni.u_blurLod,
        Math.max(0, Math.min(12, Math.log2(sigma) + 0.79)));
      gl.uniform2f(this.uni.u_blurStep, 1.06 * sigma / w, 1.06 * sigma / h);
    } else {
      // 关掉 mipmap 过滤：不生成 mip 却留着 MIPMAP 过滤会让纹理"不完整"，采样全黑
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.uniform1f(this.uni.u_blurLod, -1);
      gl.uniform2f(this.uni.u_blurStep, 0, 0);
    }

    const hasLut = !!(this.lutTex && this.lutSize);
    // ⚠️ u_lut 必须**始终**指向 1 号单元，哪怕这次不用 LUT。
    // sampler 的默认值是 0，而 u_frame 也在 0 —— 同一个纹理单元同时被
    // sampler2D 和 sampler3D 引用，WebGL 判定为 INVALID_OPERATION(1282)
    // 并丢弃整个 draw call，画面全黑。
    // 症状很有迷惑性：shader 编译/link 都通过，getError 也要在 draw 之后才报。
    gl.uniform1i(this.uni.u_lut, 1);
    gl.activeTexture(gl.TEXTURE1);
    // 没有真 LUT 时也要绑一个占位 3D 纹理，否则 1 号单元上的 sampler3D 未完成
    gl.bindTexture(gl.TEXTURE_3D, this.lutTex ?? this.dummyLut(gl));
    gl.uniform1i(this.uni.u_hasLut, hasLut ? 1 : 0);
    gl.uniform1f(this.uni.u_lutSize, this.lutSize || 2);

    // 换算逐条对齐 media.py（见文件头），改这里要同步改那边
    const n = (v: number | undefined) => v || 0;
    gl.uniform1f(this.uni.u_bright, n(tm?.exposure) / 200);
    gl.uniform1f(this.uni.u_contrast, 1 + n(tm?.contrast) / 100);
    gl.uniform1f(this.uni.u_satur, 1 + n(tm?.saturation) / 100);
    gl.uniform1f(this.uni.u_gamma, 1 + n(tm?.highlights) / 300);
    gl.uniform1f(this.uni.u_temp, n(tm?.temperature) / 200);
    gl.uniform1f(this.uni.u_tint, n(tm?.tint) / 200);
    gl.uniform1f(this.uni.u_shadowGamma, 1 + n(tm?.shadows) / 200);
    gl.uniform1f(this.uni.u_vignette, n(tm?.vignette) / 100);
    // 模糊的两个 uniform 在上面 texImage2D 之后就写好了（要先决定 mip 过滤）

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /**
   * 彻底销毁：释放资源**并丢掉 WebGL 上下文**。
   *
   * ⚠️ 只能在 canvas 元素本身要消失时调用，**绝不能在"切镜头 / 关掉调色"时调用**。
   * `loseContext()` 是不可逆的：同一个 canvas 上再 `getContext("webgl2")`
   * 拿回来的还是那个已丢失的上下文，之后所有调用静默失败、画面永久全黑。
   * 旧代码把它挂在 `active` 的 effect cleanup 上，配合"canvas 无条件挂载"就会
   * 变成「关一次调色 = 这个播放器的 GPU 预览永久报废」。
   *
   * 保留 loseContext 本身是必要的：浏览器同时活跃的 WebGL 上下文有上限（约 16），
   * 播放器反复挂载卸载而不释放，后续创建会静默失败。所以它的正确归属是
   * **卸载**，不是**停用**。停用只需要不画，不需要拆上下文。
   */
  destroy() {
    const gl = this.gl;
    gl.deleteTexture(this.frameTex);
    if (this.lutTex) gl.deleteTexture(this.lutTex);
    if (this.dummyTex) gl.deleteTexture(this.dummyTex);
    gl.deleteProgram(this.prog);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

/** 该 transform 是否需要 WebGL（有 LUT 或调色项时才值得开 GPU 管线）
 *
 *  ⚠️ **故意不含 `opacity`**，这不是遗漏：
 *  不透明度是"整层与背景合成"，不是逐像素调色，shader 里做不划算
 *  （canvas 建的是 `alpha:false` 上下文，输出 alpha 会被丢掉）。
 *  它由 `Player.tsx` 直接写到 canvas 元素的 CSS `opacity` 上 —— 元素级
 *  opacity 与 `filter: opacity()` 的合成结果等价，且 GPU/CSS 两条路径同样生效。
 *  所以 opacity **不参与**是否开 GPU 的判断，也不会在 GPU 路径下丢失。 */
export function needsGpuPreview(tm: TransformMeta | null | undefined): boolean {
  if (!tm) return false;
  return !!(tm.lut || tm.exposure || tm.contrast || tm.saturation
    || tm.temperature || tm.tint || tm.highlights || tm.shadows
    || tm.vignette || tm.blur);
}
