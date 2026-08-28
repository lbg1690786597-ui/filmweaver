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
uniform float u_blur;       // 0..1（近似：小半径均值模糊）
uniform vec2  u_texel;      // 1/分辨率，供模糊取样

const vec3 LUMA = vec3(0.299, 0.587, 0.114);

// ffmpeg eq 的 gamma：pow(x, 1/gamma)
vec3 applyGamma(vec3 c, float g) {
  return g == 1.0 ? c : pow(max(c, 0.0), vec3(1.0 / g));
}

void main() {
  vec3 c;
  if (u_blur > 0.001) {
    // 3x3 均值：CSS blur() 是高斯，这里用均值近似，半径随强度放大。
    // 预览用途够了，真正的模糊在 ffmpeg gblur 里做。
    vec2 r = u_texel * (u_blur * 6.0);
    c = vec3(0.0);
    for (int y = -1; y <= 1; y++)
      for (int x = -1; x <= 1; x++)
        c += texture(u_frame, v_uv + vec2(float(x), float(y)) * r).rgb;
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
    throw new Error(`shader 编译失败: ${log}`);
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
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB32F, 1, 1, 1, 0, gl.RGB, gl.FLOAT,
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
                     "u_shadowGamma", "u_vignette", "u_blur", "u_texel"]) {
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
    // RGB32F：硬件三线性插值直接可用，无需在 shader 里手写四面体插值
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB32F, cube.size, cube.size, cube.size,
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
    gl.uniform1f(this.uni.u_blur, n(tm?.blur) / 100);
    gl.uniform2f(this.uni.u_texel, 1 / w, 1 / h);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose() {
    const gl = this.gl;
    gl.deleteTexture(this.frameTex);
    if (this.lutTex) gl.deleteTexture(this.lutTex);
    if (this.dummyTex) gl.deleteTexture(this.dummyTex);
    gl.deleteProgram(this.prog);
    // 主动释放上下文：浏览器同时活跃的 WebGL 上下文有数量上限（约 16），
    // 反复挂载卸载不释放会让后续创建静默失败
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

/** 该 transform 是否需要 WebGL（有 LUT 或调色项时才值得开 GPU 管线） */
export function needsGpuPreview(tm: TransformMeta | null | undefined): boolean {
  if (!tm) return false;
  return !!(tm.lut || tm.exposure || tm.contrast || tm.saturation
    || tm.temperature || tm.tint || tm.highlights || tm.shadows
    || tm.vignette || tm.blur);
}
