/**
 * transformLabel — 给撤销栈里的「画面调整」起个人话名字（3.7）
 *
 * ## 为什么标签值得单独一个模块
 *
 * `transform_meta` 是个 30 多个可选字段的大口袋：缩放、旋转、位移、镜像、变速、
 * 音量、淡入淡出、八项调色、LUT、八项逐帧特效、马赛克数组、裁切、混合模式。
 * 一次 PATCH 是**整体替换**这个对象，所以从"提交了什么"看不出用户到底动了什么。
 *
 * 而撤销栈的标签是用户唯一能看到的线索 —— Ctrl+Z 之前顶栏会显示
 * 「↩ 已撤销：X」。如果 X 一律是「画面调整」，那么连按三下就完全不知道
 * 自己退到了哪一步；栈深 50，退过头再想回来只能靠肉眼比对画面。
 *
 * ## 为什么不放在 App.tsx 里
 *
 * 它是纯函数，且分组规则（哪些字段算"调色"、哪些算"特效"）会随着面板增删
 * 而变。放在这里 `verify-undo.ts` 才能在 node 下直接跑分组断言，
 * 而不是靠 grep 字符串猜它还在不在。
 */

/** 字段 → 面向用户的分组名。顺序即展示优先级。 */
const GROUPS: Array<{ name: string; keys: string[] }> = [
  { name: "画面", keys: ["scale", "scaleX", "scaleY", "x", "y", "rotate", "mirrorH", "mirrorV", "crop"] },
  { name: "调色", keys: ["exposure", "contrast", "saturation", "temperature", "tint", "highlights", "shadows", "sharpen", "lut"] },
  { name: "特效", keys: ["blur", "vignette", "grain", "glitch", "shake", "zoomPulse", "flash", "glow"] },
  { name: "马赛克", keys: ["mosaics"] },
  { name: "音频", keys: ["volume", "muted", "fadeIn", "fadeOut"] },
  { name: "变速", keys: ["speed"] },
  { name: "不透明度", keys: ["opacity"] },
  { name: "混合模式", keys: ["blendMode"] },
  // P2-7：留黑单列一组而不是并进「画面」。它是这一组里唯一**改变成片能不能看**
  // 的开关，撤销时用户最需要一眼认出的就是它；混在「画面」里等于把
  // 「我刚才把这镜遮黑了」和「我调了一下缩放」显示成同一句话。
  { name: "留黑", keys: ["blackout"] },
];

/**
 * 用 `tm` 里出现的字段推出一个短描述，如「调色」「画面+特效」。
 *
 * ⚠️ 判据是**字段出现与否**，不是"与旧值不同"。PATCH 是整体替换，面板每次
 * 都会把当前全部非默认字段一起发上来，逐字段 diff 出来的往往是一整串，
 * 反而更看不出重点。这里给的是"这一镜现在有哪几类调整"，够用户认出是哪一步。
 *
 * 认不出任何分组时返回「其他」而不是空串 —— 标签里出现一对空括号，
 * 看起来像是程序出错了。
 */
export function describeTransform(tm: object): string {
  const rec = tm as Record<string, unknown>;
  const hit = GROUPS.filter((g) => g.keys.some((k) => rec[k] !== undefined && rec[k] !== null));
  if (!hit.length) return "其他";
  // 最多列两组：三组以上时标签会长过顶栏，被 CSS 截断成「调整镜头 #3 的画面（画…」
  const names = hit.map((g) => g.name);
  return names.length <= 2 ? names.join("+") : `${names[0]}+${names[1]} 等 ${names.length} 项`;
}
