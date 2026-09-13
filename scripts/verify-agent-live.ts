/**
 * verify-agent-live.ts — Agent 的**真实模型**联调（会花钱，故不进 `verify:all`）
 *
 * ## 为什么要单独有一个
 *
 * `verify-agent.ts` 是纯本地断言：能力表、schema、解析器、确认门、撤销合并 ——
 * 全部用假模型跑。它跑得又快又稳，但它**一条模型回复都没见过**。
 * 于是下面这些失效方式它一个都拦不住：
 *
 *   - 提示词改了格式，模型开始回 `{"commands":[{"capability":"..."}]}`
 *     （字段名从 `id` 漂成 `capability`）→ 本地全绿，真机全废；
 *   - 模型对着快照**编镜头 id**（`s_1`、`s_aaa` 这种看着合理的假 id）→
 *     本地全绿，真机上是一条 dry-run 拦截；
 *   - 一次吐 30 条命令 / 回一句散文而完全不回 JSON；
 *   - 把 `duration_sec` 传成字符串、把 `at_sec` 传成"第 3 秒"这种中文。
 *
 * 这些只有**真的调一次模型**才看得见 —— 这就是本脚本存在的全部理由。
 * 提示词契约是 flash 档模型撑着的时候尤其重要（见 `config.llm_model` 那段注）。
 *
 * ## 它测什么（每条都有断言，不是"打印出来人眼看"）
 *
 *   ① 每一轮都必须**能解析**（后端 `_parse_json` + 客户端 `parseAgentReply`
 *      两层都要过）—— 解析不了就是 `AgentProtocolError` → 502 → 用户看到
 *      "AI 没接上"，这正是最难复现的那类故障；
 *   ② `dropped` 必须为空（后端整形层丢掉东西 = 模型没按能力表说话）；
 *   ③ 每条命令的 id 必须**在能力表里**（不许编造能力）；
 *   ④ 每条命令的 args 必须过 `validateIntent`（不许编造参数名 / 传错类型）；
 *   ⑤ 凡 args 里出现 `shot_id`，必须是快照里**真实存在**的那个 ——
 *      这一条是防"编 id"的核心断言；
 *   ⑥ 花钱能力（`costly`）在用户**没**明确授权时不许出现在 commands 里。
 *
 * ## 怎么跑
 *
 * ```
 * cd desktop && npm run verify:agent:live
 * ```
 *
 * ⚠️ **需要后端在跑**（dev 8002）。它直接 import 后端进程的 `agent_proxy`，
 *    在**进程内**调 `run_turn`，不走 HTTP —— 原因有二：
 *      1. `/v2/agent/*` 在会话鉴权门禁之后（`main._OPEN_TREES`），走 HTTP
 *         就得签发一个真实会话 token，而凭据不许出现在工具输出里；
 *      2. 进程内调用能用上当前**磁盘上**的代码（后端刚改完重启过即可）。
 *
 * ⚠️ 它**会真的调模型、真的花钱**（每轮一次补全，默认 10 轮）。所以：
 *    - 不进 `verify:all`；
 *    - 每轮之间不并发（并发会把模型侧限流打开，制造假的失败）。
 */

import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CAPABILITIES, exportCapabilities } from "../src/lib/agent/capability";
import { parseAgentReply } from "../src/lib/agent/protocol";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BACKEND = join(ROOT, "..", "backend");

let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (!cond) failed += 1;
  console.log(`  ${cond ? "✅" : "❌"} ${name}`);
  if (!cond && detail) console.log(`      ${detail}`);
}

/** 快照里的镜头 id —— 断言"模型有没有编 id"要靠它。 */
const SHOTS = [
  { id: "s_8f2a1c", order: 1, ep: 1, dur: 3.5, prompt: "林晚站在雨里回头" },
  { id: "s_1b7d4e", order: 2, ep: 1, dur: 2.0, prompt: "雨滴打在伞面上" },
  { id: "s_9c3f60", order: 3, ep: 2, dur: 4.0, prompt: "办公室内两人对峙" },
];
const SHOT_IDS = new Set(SHOTS.map((s) => s.id));

/** 与 `runAgent` 里 `renderTimelineForPrompt` 产出的形状保持同构：
 *  第一列是 id（那是模型唯一可靠的定位符），order 紧接着。
 *  ⚠️ 这里的文本是**给模型看的**，不是给断言看的 —— 所以 id 必须真的在里面。 */
const TIMELINE_TEXT = [
  `【镜头】 共 ${SHOTS.length} 个 (next_offset=${SHOTS.length})`,
  ...SHOTS.map((s) =>
    `${s.id}  #${s.order}  场${s.ep} 镜${s.order}  ${s.dur}s  ${
      s.id === "s_1b7d4e" ? "未生成" : "已出片"}  提示词：${s.prompt}`),
].join("\n");

interface Case {
  /** 用例名，打印用 */
  name: string;
  /** 用户这句话 */
  text: string;
  /** 用户是否在这一句里明确授权花钱（决定第 ⑥ 条断言往哪边判） */
  authorized?: boolean;
  /** 对这一轮的命令做的额外断言（返回错误描述，空数组 = 通过） */
  expect?: (cmds: { id: string; args: Record<string, unknown> }[]) => string[];
}

const CASES: Case[] = [
  {
    name: "改提示词（认 id，不认序号）",
    text: "把第 1 个镜头的提示词改成『暴雨中回眸』",
    expect: (cs) => cs.length === 0 ? ["一句明确的改提示词，模型没给命令"] : [],
  },
  {
    name: "改时长（整数秒）",
    text: "第 3 个镜头缩到 2.5 秒",
    expect: (cs) => cs.some((c) => c.id === "patch_shot_timeline") ? [] : ["没走 patch_shot_timeline"],
  },
  {
    name: "改顺序",
    text: "把最后那个镜头挪到最前面",
    expect: (cs) => cs.some((c) => c.id === "patch_shot_timeline" && c.args.to_order === 1)
      ? [] : ["没给出 to_order=1"],
  },
  {
    name: "指代靠内容而非序号（歧义要问、不许猜）",
    text: "把雨滴那个镜头改长一点",
    // 两个都算对：它要么指名问「改成几秒」，要么给一条针对 s_1b7d4e 的命令。
    // **唯独不许**给一条针对别的镜头、或者编个时长的命令。
    expect: (cs) => {
      const bad = cs.filter((c) => c.args.shot_id && c.args.shot_id !== "s_1b7d4e");
      return bad.length ? [`指代错了镜头：${JSON.stringify(bad)}`] : [];
    },
  },
  {
    name: "越界：不存在的镜头",
    text: "把第 99 个镜头删掉",
    expect: (cs) => cs.length === 0 ? [] : ["不存在的镜头居然给了命令"],
  },
  {
    // 这条是实跑时**意外发现模型做对了**才补上的：说「把 3 号镜头删掉」，
    // 它没给 destructive 的 `delete_shot`，而是给了可逆的 `disabled=true`。
    //
    // 起初我以为是模型跑偏、把断言写错了；读了能力表才发现它对：
    // `delete_shot` 的描述里写明**只删外部素材镜头，AI 生成的镜头删不掉**，
    // 而本用例的镜头是从 `describe_timeline` 快照来的普通镜头 —— 模型
    // 没有可依据的信息判定它是不是外部素材，于是选了唯一确定能成功、
    // 且随时能恢复的那条路。这正是能力表描述写清楚的收益，值得钉住：
    // 以后谁把 `delete_shot` 的描述改糊了，这条会红。
    name: "删一个普通镜头：优先可逆的停用，而不是不可撤销的删除",
    text: "把 3 号镜头删掉",
    expect: (cs) => {
      if (cs.some((c) => c.id === "delete_shot")) {
        return ["对普通镜头直接下了不可撤销的 delete_shot（能力表说它只删外部素材）"];
      }
      const ok2 = cs.some((c) => c.id === "patch_shot_timeline" && c.args.disabled === true);
      return ok2 ? [] : ["既没删除也没停用，用户的话没被落实"];
    },
  },
  {
    name: "超出能力表（导出不在表里）",
    text: "帮我把这一集导出成 mp4",
    expect: (cs) => cs.length === 0 ? [] : ["导出不在能力表里，模型却给了命令"],
  },
  {
    name: "错别字 + 序号混合",
    text: "把 弟 3 个镜头的提示词改称『夜晚街道』",
    expect: (cs) => cs.some((c) => c.args.shot_id === "s_9c3f60") ? [] : ["没定位到 s_9c3f60"],
  },
  {
    name: "花钱 · 未授权（必须只问不做）",
    text: "把没生成的镜头都生成一下",
    authorized: false,
    expect: (cs) => cs.filter((c) => c.id === "generate_shots").length === 0
      ? [] : ["用户没授权，模型却直接下了生成命令"],
  },
  {
    name: "花钱 · 已明确授权（可以给命令，客户端仍有确认门兜底）",
    text: "第 2 个镜头直接生成，我确认过了",
    authorized: true,
    expect: () => [],
  },
  {
    name: "纯闲聊（不许编排命令）",
    text: "你好",
    expect: (cs) => cs.length === 0 ? [] : ["打招呼却下了命令"],
  },
];

/** 把一轮的输入喂给**后端进程内**的 `run_turn`，拿回原始回复。
 *
 *  ⚠️ 用 `execFileSync` 起一个短命 Python 进程、而不是长驻服务：
 *     后端 `run_turn` 是 async 的，跨进程拿结果最省事的就是一次性脚本。
 *     它读的是**磁盘上的** `app/agent_proxy.py` —— 所以后端改完
 *     **必须重启过**（重启让新代码生效这件事对本脚本不适用，因为它每次
 *     都是新起的 Python；但重启是"验证的是线上那份代码"的保证）。 */
function callBackend(userText: string): {
  reply: string; done: boolean;
  commands: { id: string; args: Record<string, unknown> }[];
  dropped: string[]; error?: string;
} {
  const py = `
import asyncio, json, sys
from app.agent_proxy import run_turn
caps = json.loads(sys.argv[1])
out = asyncio.run(run_turn(
    capabilities=caps,
    timeline_text=sys.argv[2],
    user_text=sys.argv[3],
    project_id="p_test",
))
print("@@RESULT@@" + json.dumps(out, ensure_ascii=False))
`;
  const capsJson = JSON.stringify(exportCapabilities(CAPABILITIES));
  try {
    const raw = execFileSync("python3", ["-c", py, capsJson, TIMELINE_TEXT, userText], {
      cwd: BACKEND,
      encoding: "utf8",
      timeout: 180_000,
    });
    const line = raw.split("\n").find((l) => l.startsWith("@@RESULT@@"));
    if (!line) return { reply: "", done: true, commands: [], dropped: [], error: "后端没有回结果" };
    return JSON.parse(line.slice("@@RESULT@@".length));
  } catch (e) {
    return {
      reply: "", done: true, commands: [], dropped: [],
      error: (e as Error).message.slice(0, 300),
    };
  }
}

async function main() {
  console.log("\n⑪ 真实模型联调（会花钱：每轮一次补全）");
  console.log(`  模型：后端 settings.llm_model（当前 gemini-3.6-flash）`);
  console.log(`  通道：后端 llm_channel_order（zx1 → api4me → modelverse 回退）`);
  console.log(`  用例：${CASES.length} 条，串行\n`);

  let spentTurns = 0;
  for (const c of CASES) {
    const t0 = Date.now();
    const r = callBackend(c.text);
    spentTurns += 1;
    const ms = Date.now() - t0;

    if (r.error) {
      ok(`${c.name} —— 调用成功`, false, r.error);
      continue;
    }

    // ① 两层解析都必须过。后端那层已经在 Python 里过了（不过会抛，
    //    上面就 error 了）；这里过客户端那层 —— 它才是决定"用户看不看得懂"
    //    的那层，且它的容错范围与后端**不同**（历史上就漂过，见
    //    `verify-agent.ts` 的 ⑤bis）。
    const parsed = parseAgentReply(JSON.stringify({
      reply: r.reply, done: r.done, commands: r.commands ?? [],
    }));
    ok(`${c.name} —— 客户端能解析（${ms}ms）`,
      !parsed.hardError, parsed.hardError ?? "");
    // ② 后端整形层没丢东西
    ok(`${c.name} —— 后端没丢命令`,
      (r.dropped ?? []).length === 0, JSON.stringify(r.dropped));
    // ③④ 每条都在能力表里、且 args 合法
    ok(`${c.name} —— 每条命令都在能力表里且参数合法`,
      parsed.complaints.length === 0, parsed.complaints.join(" / "));
    // ⑤ 不许编造镜头 id
    const fabricated = (r.commands ?? [])
      .map((cmd) => cmd.args?.shot_id)
      .filter((sid): sid is string => typeof sid === "string" && !SHOT_IDS.has(sid));
    ok(`${c.name} —— 没有编造镜头 id`,
      fabricated.length === 0, fabricated.join(", "));
    // ⑥ 未授权时不许直接下花钱命令
    if (c.authorized === false) {
      const costlyDirect = (r.commands ?? []).filter((cmd) => {
        const cap = CAPABILITIES.find((x) => x.id === cmd.id);
        return cap?.costly === true;
      });
      ok(`${c.name} —— 未授权时没直接下花钱命令`,
        costlyDirect.length === 0, JSON.stringify(costlyDirect));
    }
    // 用例自己的额外断言
    if (c.expect) {
      const errs = c.expect(r.commands ?? []);
      ok(`${c.name} —— 行为符合预期`, errs.length === 0, errs.join("；"));
    }
    if (r.commands?.length) {
      console.log(`      ↳ ${JSON.stringify(r.commands, null, 0).slice(0, 200)}`);
    }
  }

  console.log(`\n  共 ${spentTurns} 轮真实补全`);
  console.log(failed === 0
    ? "\n✅ Agent 真实联调通过：模型能按能力表说话、认 id、不乱花钱"
    : `\n❌ Agent 真实联调有 ${failed} 条不通过`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
