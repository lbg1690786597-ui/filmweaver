/**
 * verify-grade-preview.ts — WebGL 调色预览的真机验证（批次 1 / A1）
 *
 * ## 为什么必须有这个脚本
 *
 * `render/gradePreview.ts` 整整 300 多行，在修复前**一行都没被执行过**：
 * `useGradePreview` 里存在自举死锁 ——
 *
 *     canvasRef.current 非空 ⇐ canvas 已挂载 ⇐ gpuActive ⇐ gpuOk
 *                       ⇐ create(cv) 成功 ⇐ canvasRef.current 非空
 *
 * tsc 全绿、CSS 覆盖全绿、导出基线全绿，**没有任何一道现有关卡能发现它**，
 * 因为它既不是类型错误也不碰导出链路。用户侧的表现只是
 * 「LUT 在预览里看不见」+「预览为近似效果 常亮」，很容易被当成设计如此。
 *
 * 所以这一条只能靠**真的开一个 WebGL2 上下文、真的画一帧、真的读回像素**来守。
 * 脚本分两段：
 *   ① 静态守卫：把当初造成死锁的那几个写法直接钉死，改回去就报错
 *   ② 真机：Playwright 起 chromium，编译本文件里**真实的** shader 源码
 *      （从 gradePreview.ts 里抠出来，不是抄一份），逐项读回像素比对
 *
 * 用法：npx tsx scripts/verify-grade-preview.ts
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (...p: string[]) => readFileSync(join(SRC, ...p), "utf8");
const gradeSrc = read("render", "gradePreview.ts");

/** 静态守卫必须只看**代码**：这三个文件的注释里逐字写着当年的错误写法
 *  （`{gpuActive && <canvas …/>}`、`GradePreview.destroy()`），
 *  不剥注释的话守卫会被自己的说明文字触发。 */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
const hookSrc = stripComments(read("hooks", "useGradePreview.ts"));
const playerSrc = stripComments(read("features", "editor", "Player.tsx"));
const gradeCode = stripComments(gradeSrc);

let fails = 0;
const ok = (cond: boolean, name: string, detail = "") => {
  console.log(`   ${cond ? "✅" : "❌"} ${name}${detail ? `   ${detail}` : ""}`);
  if (!cond) fails++;
};

/* ------------------------------------------------------------------ *
 * ① 静态守卫 —— 直接钉死当初造成死锁的写法
 * ------------------------------------------------------------------ */
console.log("① 自举死锁的静态守卫");

// canvas 必须**无条件**挂载。写成 {gpuActive && <canvas …/>} 就是死锁本体。
ok(/<canvas\s+ref=\{canvasRef\}/.test(playerSrc),
  "Player.tsx 挂了 <canvas ref={canvasRef}>");
ok(!/gpuActive\s*&&\s*\(?\s*<canvas/.test(playerSrc),
  "canvas 没有被 gpuActive 条件包住",
  "（一旦包住就回到死锁：canvas 等 gpuActive、gpuActive 等 create(canvas)）");

// canvasRef 必须是 callback ref（挂载能触发 effect），不能是普通 useRef。
ok(/const canvasRef = useCallback\(/.test(hookSrc),
  "canvasRef 是 callback ref（元素挂载/替换能触发 effect 重跑）");
ok(!/const canvasRef = useRef<HTMLCanvasElement>/.test(hookSrc),
  "canvasRef 不再是普通 useRef");

// destroy()（含不可逆的 loseContext）只能挂在 canvas 元素的生命周期上。
ok(!/dispose\s*\(\)\s*\{/.test(gradeCode),
  "gradePreview 不再暴露会被误用的 dispose()（已改名 destroy 并写清适用时机）");
const destroyCalls = (hookSrc.match(/\.destroy\(\)/g) ?? []).length;
ok(destroyCalls === 1,
  "hook 里只有一处调用 destroy()", `实际 ${destroyCalls} 处`);
ok(/\}, \[canvasEl\]\);/.test(hookSrc),
  "存在一个 deps 恰为 [canvasEl] 的 effect（销毁只跟 canvas 元素走）");

// 绘制循环不能把 transform 放进 deps（它每次 refreshDetail 都是新对象）。
const loopDeps = hookSrc.match(/\}, \[active, gpuOk, canvasEl, videoKey, videoRef\]\);/);
ok(!!loopDeps, "绘制循环的 deps 不含 transform（避免 SSE 一推送就断帧同步）");

// LUT 纹理不能用 32 位浮点：WebGL2 下它默认不可线性过滤，采样直接全黑
// 且 getError()==0（下方 3b 有实测对照组）。
ok(!/RGB32F/.test(gradeCode) && /RGB16F/.test(gradeCode),
  "LUT 用 RGB16F 而非 RGB32F（32F 需要 OES_texture_float_linear，否则采样全黑）");

/* ------------------------------------------------------------------ *
 * ② 真机：编译 gradePreview.ts 里**真实的** shader 并读回像素
 * ------------------------------------------------------------------ */
function grabShader(name: string): string {
  const m = gradeSrc.match(new RegExp(`const ${name} = \`([\\s\\S]*?)\`;`));
  if (!m) throw new Error(`没能从 gradePreview.ts 里抠出 ${name}`);
  return m[1];
}
const VERT = grabShader("VERT");
const FRAG = grabShader("FRAG");

// 抽出来的必须是真货，不是空串/被注释掉的残片
ok(FRAG.includes("textureLod") && FRAG.includes("u_blurLod"),
  "抠到的 FRAG 是当前版本（含 mipmap 模糊）");
ok(FRAG.includes("sampler3D") && FRAG.includes("u_hasLut"),
  "抠到的 FRAG 含 LUT 采样");

console.log("\n② 真机 WebGL2（chromium headless）");

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent("<!doctype html><html><body></body></html>");
// tsx 用 esbuild 转译本文件，会给具名箭头函数套一层 `__name` 这个 keepNames 辅助；
// 而 page.evaluate 只把函数**源码**丢进浏览器，辅助函数不会跟着过去，
// 于是页面里 `__name is not defined` 直接炸。先用**字符串形式**的 evaluate
// （字符串不经 esbuild 转译）在页面里补一个同名恒等函数。必须排在 setContent
// 之后：document.write 会重建文档，之前挂上去的全局会被冲掉。
await page.evaluate("globalThis.__name = (f) => f;");

type Res = { name: string; pass: boolean; detail: string };
const results: Res[] = await page.evaluate(
  ({ VERT, FRAG }) => {
    const out: Res[] = [];
    const add = (name: string, pass: boolean, detail = "") =>
      out.push({ name, pass, detail });

    const N = 64;                       // 纹理与视口边长
    const cv = document.createElement("canvas");
    cv.width = N; cv.height = N;
    // 与 gradePreview.create 完全一致的上下文参数
    const gl = cv.getContext("webgl2", {
      alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: false,
    });
    if (!gl) { add("拿到 WebGL2 上下文", false, "getContext 返回 null"); return out; }
    add("拿到 WebGL2 上下文", true);

    const mk = (type: number, s: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, s); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(sh) || "compile failed");
      }
      return sh;
    };
    let prog: WebGLProgram;
    try {
      prog = gl.createProgram()!;
      gl.attachShader(prog, mk(gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, mk(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(prog) || "link failed");
      }
      add("shader 编译 + link", true);
    } catch (e) {
      add("shader 编译 + link", false, String(e).slice(0, 200));
      return out;
    }
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]),
                  gl.STATIC_DRAW);
    const posLoc = gl.getAttribLocation(prog, "a_pos");
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    const U: Record<string, WebGLUniformLocation | null> = {};
    for (const n of ["u_frame", "u_lut", "u_hasLut", "u_lutSize", "u_bright",
                     "u_contrast", "u_satur", "u_gamma", "u_temp", "u_tint",
                     "u_shadowGamma", "u_vignette", "u_blurLod", "u_blurStep"]) {
      U[n] = gl.getUniformLocation(prog, n);
    }

    // ---- 帧纹理 ----
    const frameTex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, frameTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);

    // ---- 无 LUT 时的 1x1x1 占位（gradePreview.dummyLut 的等价物）----
    const dummy = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, dummy);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, 1, 1, 1, 0, gl.RGB, gl.FLOAT,
                  new Float32Array([0, 0, 0]));

    const upload = (px: Uint8Array) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, frameTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, N, N, 0, gl.RGB,
                    gl.UNSIGNED_BYTE, px);
    };
    const solid = (r: number, g: number, b: number) => {
      const a = new Uint8Array(N * N * 3);
      for (let i = 0; i < N * N; i++) { a[i * 3] = r; a[i * 3 + 1] = g; a[i * 3 + 2] = b; }
      return a;
    };

    interface P {
      bright?: number; contrast?: number; satur?: number; gamma?: number;
      temp?: number; tint?: number; shadowGamma?: number; vignette?: number;
      blurSigma?: number; lut?: { size: number; data: Float32Array };
    }
    let lutTex: WebGLTexture | null = null;
    const draw = (p: P = {}) => {
      gl.viewport(0, 0, N, N);
      gl.useProgram(prog);
      gl.uniform1i(U.u_frame, 0);
      gl.uniform1i(U.u_lut, 1);          // 必须始终指向 1 号单元，见 gradePreview 注释
      gl.activeTexture(gl.TEXTURE1);
      if (p.lut) {
        if (!lutTex) lutTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_3D, lutTex);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        for (const q of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) {
          gl.texParameteri(gl.TEXTURE_3D, q, gl.CLAMP_TO_EDGE);
        }
        gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, p.lut.size, p.lut.size,
                      p.lut.size, 0, gl.RGB, gl.FLOAT, p.lut.data);
        gl.uniform1i(U.u_hasLut, 1);
        gl.uniform1f(U.u_lutSize, p.lut.size);
      } else {
        gl.bindTexture(gl.TEXTURE_3D, dummy);
        gl.uniform1i(U.u_hasLut, 0);
        gl.uniform1f(U.u_lutSize, 2);
      }
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, frameTex);
      if (p.blurSigma) {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER,
                         gl.LINEAR_MIPMAP_LINEAR);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.uniform1f(U.u_blurLod,
          Math.max(0, Math.min(12, Math.log2(p.blurSigma) + 0.79)));
        gl.uniform2f(U.u_blurStep, 1.06 * p.blurSigma / N, 1.06 * p.blurSigma / N);
      } else {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.uniform1f(U.u_blurLod, -1);
        gl.uniform2f(U.u_blurStep, 0, 0);
      }
      gl.uniform1f(U.u_bright, p.bright ?? 0);
      gl.uniform1f(U.u_contrast, p.contrast ?? 1);
      gl.uniform1f(U.u_satur, p.satur ?? 1);
      gl.uniform1f(U.u_gamma, p.gamma ?? 1);
      gl.uniform1f(U.u_temp, p.temp ?? 0);
      gl.uniform1f(U.u_tint, p.tint ?? 0);
      gl.uniform1f(U.u_shadowGamma, p.shadowGamma ?? 1);
      gl.uniform1f(U.u_vignette, p.vignette ?? 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const px = new Uint8Array(N * N * 4);
      gl.readPixels(0, 0, N, N, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    };
    /** 取 (x,y) 处的 RGB（y 自下而上，与 readPixels 一致） */
    const at = (px: Uint8Array, x: number, y: number) =>
      [px[(y * N + x) * 4], px[(y * N + x) * 4 + 1], px[(y * N + x) * 4 + 2]];

    // ---- 1. 恒等：不调任何参数，画面必须原样出来（而不是全黑）----
    // 全黑正是「u_lut 没指到 1 号单元」那个陷阱的症状，且 link 阶段测不出来。
    upload(solid(100, 150, 200));
    let px = draw();
    let c = at(px, 32, 32);
    const near = (a: number[], b: number[], tol = 3) =>
      a.every((v, i) => Math.abs(v - b[i]) <= tol);
    add("恒等绘制 = 原画面（不是全黑）", near(c, [100, 150, 200]),
        `读回 rgb(${c.join(",")})`);
    add("绘制后 glGetError = 0", gl.getError() === 0);

    // ---- 2. 曝光 +50（media.py 换算：bright = 50/200 = 0.25 → +63.75）----
    px = draw({ bright: 0.25 });
    c = at(px, 32, 32);
    add("曝光 +50 提亮约 64/255", near(c, [164, 214, 255], 4),
        `读回 rgb(${c.join(",")})`);

    // ---- 3. LUT 可见（本次修复的验收点：LUT 在预览里必须真的生效）----
    // 构造一个 2^3 的"反色" LUT：out = 1 - in
    const size = 2;
    const lutData = new Float32Array(size * size * size * 3);
    for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
      const i = ((b * size + g) * size + r) * 3;
      lutData[i] = 1 - r / (size - 1);
      lutData[i + 1] = 1 - g / (size - 1);
      lutData[i + 2] = 1 - b / (size - 1);
    }
    px = draw({ lut: { size, data: lutData } });
    c = at(px, 32, 32);
    // 半像素内缩会把两端稍稍拉回，容差放宽到 8
    add("LUT 生效（反色 LUT 下 rgb(100,150,200) → 约 (155,105,55)）",
        near(c, [155, 105, 55], 10), `读回 rgb(${c.join(",")})`);

    // ---- 3b. 对照组：证明上一条不是白测的 ----
    // 用 RGB32F + LINEAR 且不请求 OES_texture_float_linear（= 修复前的写法），
    // 同一份 LUT 必须变成全黑。没有这条，"改用 16F"就只是一句断言。
    {
      const c2 = document.createElement("canvas");
      c2.width = c2.height = 8;
      const g = c2.getContext("webgl2")!;
      const vs = g.createShader(g.VERTEX_SHADER)!;
      g.shaderSource(vs, "#version 300 es\nin vec2 a;void main(){gl_Position=vec4(a,0,1);}");
      g.compileShader(vs);
      const fs = g.createShader(g.FRAGMENT_SHADER)!;
      g.shaderSource(fs, "#version 300 es\nprecision highp float;precision highp sampler3D;"
        + "out vec4 o;uniform sampler3D t;void main(){o=vec4(texture(t,vec3(0.5)).rgb,1.);}");
      g.compileShader(fs);
      const pr = g.createProgram()!;
      g.attachShader(pr, vs); g.attachShader(pr, fs); g.linkProgram(pr); g.useProgram(pr);
      const bb = g.createBuffer();
      g.bindBuffer(g.ARRAY_BUFFER, bb);
      g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), g.STATIC_DRAW);
      const al = g.getAttribLocation(pr, "a");
      g.enableVertexAttribArray(al);
      g.vertexAttribPointer(al, 2, g.FLOAT, false, 0, 0);
      const mid = new Float32Array(2 * 2 * 2 * 3).fill(0.5);
      const shot = (internal: number, filter: number) => {
        const t = g.createTexture();
        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_3D, t);
        g.texParameteri(g.TEXTURE_3D, g.TEXTURE_MIN_FILTER, filter);
        g.texParameteri(g.TEXTURE_3D, g.TEXTURE_MAG_FILTER, filter);
        g.texImage3D(g.TEXTURE_3D, 0, internal, 2, 2, 2, 0, g.RGB, g.FLOAT, mid);
        g.uniform1i(g.getUniformLocation(pr, "t"), 0);
        g.viewport(0, 0, 8, 8);
        g.drawArrays(g.TRIANGLES, 0, 3);
        const q = new Uint8Array(8 * 8 * 4);
        g.readPixels(0, 0, 8, 8, g.RGBA, g.UNSIGNED_BYTE, q);
        return { v: q[0], err: g.getError() };
      };
      const bad = shot(g.RGB32F, g.LINEAR);
      const good = shot(g.RGB16F, g.LINEAR);
      add("对照组：RGB32F+LINEAR（未开 float_linear 扩展）确实全黑且不报错",
          bad.v === 0 && bad.err === 0, `读回 ${bad.v}，getError=${bad.err}`);
      add("对照组：同条件下 RGB16F+LINEAR 正常（半浮点线性过滤是 WebGL2 核心能力）",
          Math.abs(good.v - 128) <= 2, `读回 ${good.v}`);
    }

    // ---- 4. 暗角：中心不变、角落变暗 ----
    upload(solid(200, 200, 200));
    px = draw({ vignette: 1 });
    const center = at(px, 32, 32), corner = at(px, 1, 1);
    add("暗角：中心≈原值、角落显著变暗",
        near(center, [200, 200, 200], 4) && corner[0] < 120,
        `中心 ${center[0]} / 角落 ${corner[0]}`);

    // ---- 5. 模糊（mipmap 路径）：黑白阶跃必须被抹成过渡，且不能变全黑 ----
    // 这一条专盯"开了 MIPMAP 过滤却没 generateMipmap → 纹理不完整 → 采样全黑"。
    const step = new Uint8Array(N * N * 3);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const v = x < N / 2 ? 0 : 255;
      const i = (y * N + x) * 3;
      step[i] = step[i + 1] = step[i + 2] = v;
    }
    upload(step);
    const sharp = draw();
    const blurred = draw({ blurSigma: 6 });
    const edgeSharp = at(sharp, 33, 32)[0];
    const edgeBlur = at(blurred, 33, 32)[0];
    const farBlur = at(blurred, 60, 32)[0];
    add("模糊：边界被抹成中间调（不是二值）",
        edgeSharp > 200 && edgeBlur > 40 && edgeBlur < 215,
        `锐利 ${edgeSharp} → 模糊 ${edgeBlur}`);
    add("模糊：远离边界处仍是亮的（没有因 mip 不完整而全黑）",
        farBlur > 150, `读回 ${farBlur}`);

    // ---- 6. loseContext 不可逆 —— 这就是 destroy() 只能在卸载时调的实证 ----
    const cv2 = document.createElement("canvas");
    const g2 = cv2.getContext("webgl2")!;
    g2.getExtension("WEBGL_lose_context")?.loseContext();
    const g2b = cv2.getContext("webgl2");
    add("loseContext 后同一 canvas 拿不回可用上下文",
        !g2b || g2b.isContextLost(),
        "→ 所以 destroy() 绝不能挂在「关掉调色」的 cleanup 上");

    // ---- 7. 连续切 5 个镜头：上下文保持存活、每次都画得出来 ----
    // 模型化本次的设计：canvas 常驻 → 上下文只建一次 → active 反复开关只是"画/不画"。
    let allOk = true;
    for (let k = 0; k < 5; k++) {
      upload(solid(20 + k * 40, 20 + k * 40, 20 + k * 40));
      const q = draw({ bright: 0.1 });
      const v = at(q, 32, 32)[0];
      if (gl.isContextLost() || Math.abs(v - (20 + k * 40 + 25.5)) > 4) allOk = false;
    }
    add("连续切 5 个镜头后 WebGL 仍在工作", allOk && !gl.isContextLost());

    return out;
  },
  { VERT, FRAG },
);

for (const r of results) ok(r.pass, r.name, r.detail);
await browser.close();

console.log(fails === 0
  ? "\n✅ 调色预览验证通过"
  : `\n❌ ${fails} 项未通过`);
process.exit(fails === 0 ? 0 : 1);
