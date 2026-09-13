/**
 * schema.ts — 给 LLM 看的**参数 schema**，以及不依赖任何库的校验器（批次 E1 / E5）
 *
 * ## 为什么不用 ajv / zod
 *
 * ① `EditCommand.params` 要能**从后端下发给模型**（`tools[].input_schema` 就是
 *    这个形状），所以它必须是**纯数据**，不能是 zod 对象那种带运行期方法的容器。
 * ② 校验器跑在客户端进程里，且**必须在 node 下能被 `verify-*.ts` 直接跑**——
 *    引 ajv 会让验证脚本多一个依赖，而我们要校的 schema 一共十来条、只用得上
 *    `type / properties / required / enum / items / minimum / maximum / description`。
 *    这点需求自己写 120 行比拉一个 200 KB 的库更可控，还能把"错误信息里带上
 *    参数路径"这件事做到和本项目其它地方一致。
 *
 * ⚠️ **方言是刻意的子集**。后端把它原样塞进 function calling 的 `input_schema`
 * 之前，不会再有第二道校验 —— 所以这里**只允许用下面这些关键字**，
 * 写了不认识的键（如 `oneOf` / `$ref`）不会报错，但**也不会生效**，
 * 那是"校验通过但模型看到的东西没人管"的经典坑。`verify-agent.ts` 会把
 * 每条能力的 schema 递归走一遍，发现未知关键字就报红。
 */

/** JSON Schema 的**受支持子集**。见文件头：多写的键不生效，别写。 */
export interface JsonSchema {
  type: "object" | "array" | "string" | "number" | "integer" | "boolean";
  /** `type: "object"` 时的字段表 */
  properties?: Record<string, JsonSchema>;
  /** `type: "object"` 时哪些字段必填 */
  required?: string[];
  /** `type: "array"` 时的元素 schema */
  items?: JsonSchema;
  /** 枚举（只对 string / number 有意义） */
  enum?: (string | number)[];
  minimum?: number;
  maximum?: number;
  /** **给模型看的说明**。这是本模块里最重要的一栏 ——
   *  模型选错工具、传错参数，九成是因为这里写得太短。 */
  description?: string;
  default?: unknown;
}

/** 校验失败的一条。`path` 用点号路径，与 `artifact.ts` 的 `ArtifactIssue.path` 同风格。 */
export interface SchemaError {
  path: string;
  msg: string;
}

/** 受支持的关键字白名单。多了不报错，但 `verify-agent.ts` 会把它揪出来。 */
export const SUPPORTED_KEYWORDS = [
  "type", "properties", "required", "items", "enum",
  "minimum", "maximum", "description", "default",
] as const;

/**
 * 按 schema 校验一个值。**只报错、不做类型转换**。
 *
 * 为什么不转换：`"3"` 与 `3` 在 LLM 的输出里都常见，但**擅自把字符串转成数字
 * 会让"模型传了个标题叫 3"变成"把镜头移到第 3 位"**。宁可报一条明确错误让
 * Agent 重试一次，也不要静默猜。数字字符串是**唯一**的例外（见 `coerceNumber`），
 * 且仅在 `type` 明确是 number / integer 时生效。
 */
export function validateArgs(
  schema: JsonSchema,
  value: unknown,
  path = "",
): SchemaError[] {
  const errs: SchemaError[] = [];
  const at = path || "(根)";
  const t = schema.type;

  if (value === undefined || value === null) {
    // 缺值由调用方的 `required` 判定；到这里说明是可空字段
    return errs;
  }

  if (t === "object") {
    if (typeof value !== "object" || Array.isArray(value)) {
      errs.push({ path: at, msg: `应当是对象，实际是 ${jsType(value)}` });
      return errs;
    }
    const obj = value as Record<string, unknown>;
    for (const k of schema.required ?? []) {
      if (obj[k] === undefined || obj[k] === null) {
        errs.push({ path: path ? `${path}.${k}` : k, msg: "缺少必填参数" });
      }
    }
    for (const [k, sub] of Object.entries(schema.properties ?? {})) {
      if (obj[k] === undefined) {
        // 没传就看有没有 default；schema 的 default **不在这里填充**，
        // 只提示调用方（填充是 `applyDefaults` 的事，因为它要产出新对象）
        continue;
      }
      errs.push(...validateArgs(sub, obj[k], path ? `${path}.${k}` : k));
    }
    // 多余的键：**不报错**。模型多带一个解释性字段是常态，
    // 为此让整条命令失败，代价远大于收益（真正危险的是少传与传错）
    return errs;
  }

  if (t === "array") {
    if (!Array.isArray(value)) {
      errs.push({ path: at, msg: `应当是数组，实际是 ${jsType(value)}` });
      return errs;
    }
    if (schema.items) {
      value.forEach((v, i) => {
        errs.push(...validateArgs(schema.items as JsonSchema, v, `${path}[${i}]`));
      });
    }
    return errs;
  }

  const num = schema.type === "number" || schema.type === "integer"
    ? coerceNumber(value) : undefined;

  if (t === "number" || t === "integer") {
    if (num === undefined) {
      errs.push({ path: at, msg: `应当是数字，实际是 ${jsType(value)}` });
      return errs;
    }
    if (t === "integer" && !Number.isInteger(num)) {
      errs.push({ path: at, msg: `应当是整数，实际是 ${num}` });
      return errs;
    }
    if (schema.minimum !== undefined && num < schema.minimum) {
      errs.push({ path: at, msg: `不得小于 ${schema.minimum}（实际 ${num}）` });
    }
    if (schema.maximum !== undefined && num > schema.maximum) {
      errs.push({ path: at, msg: `不得大于 ${schema.maximum}（实际 ${num}）` });
    }
    return errs;
  }

  if (t === "boolean") {
    if (typeof value !== "boolean") {
      errs.push({ path: at, msg: `应当是布尔值，实际是 ${jsType(value)}` });
    }
    return errs;
  }

  // string
  if (typeof value !== "string") {
    errs.push({ path: at, msg: `应当是字符串，实际是 ${jsType(value)}` });
    return errs;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errs.push({
      path: at,
      msg: `只能是 ${schema.enum.map((e) => JSON.stringify(e)).join(" / ")}，实际 ${JSON.stringify(value)}`,
    });
  }
  // ⚠️ 空串**不拦**：`patch_shot_prompt` 这类能力就是要能写空串（等于清空）。
  // 需要"不许空"的字段，在能力表里用 `enum` 把合法取值列全，别在这里加隐式规则 ——
  // 隐式规则会同时伤到"清空"这个正当用法，而且伤得没有提示。
  return errs;
}

/**
 * 数字字符串 → 数字。**只认纯数字**（含负号与小数点），不认 `"3 秒"`。
 *
 * ⚠️ 这不是"宽容"，是模型输出的现实：让它传 `order: 3`，十次里有一次是
 * `"3"`。为这一个字符让整轮对话失败并让用户重试，不划算。但**绝不能**
 * 连 `"3 秒"` / `"第三"` 也认 —— 那才是真的在猜。
 */
export function coerceNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** JS 值的类型名（`null` 单独说，因为 `typeof null === "object"` 是个陷阱） */
export function jsType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "数组";
  return typeof v;
}

/**
 * 把 schema 里声明的 `default` 填进参数对象（**产出新对象，不改入参**）。
 *
 * 用途：模型经常漏传可选参数，而"漏传"与"传了默认值"在下游必须区分得开 ——
 * 让下游自己写 `p.n ?? 默认` 就等于把默认值抄两遍，schema 里那份立刻变成谎话。
 */
export function applyDefaults(
  schema: JsonSchema,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  for (const [k, sub] of Object.entries(schema.properties ?? {})) {
    if (out[k] === undefined && sub.default !== undefined) out[k] = sub.default;
  }
  return out;
}

/** schema 里**不生效**的关键字（写了但校验器不认识）。用于自检。 */
export function unknownKeywords(schema: JsonSchema, path = "(根)"): string[] {
  const bad: string[] = [];
  for (const k of Object.keys(schema)) {
    if (!(SUPPORTED_KEYWORDS as readonly string[]).includes(k)) {
      bad.push(`${path}.${k}`);
    }
  }
  for (const [k, sub] of Object.entries(schema.properties ?? {})) {
    bad.push(...unknownKeywords(sub, `${path}.${k}`));
  }
  if (schema.items) bad.push(...unknownKeywords(schema.items, `${path}[]`));
  return bad;
}
