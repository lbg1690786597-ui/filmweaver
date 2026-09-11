/**
 * SettingsDialog — 设置（PLAN §21，Phase 6）
 *
 * 三组：
 *   编辑设置 —— 时间轴默认行为、快捷键一览（从 commands 注册表读，不手写第二份）
 *   AI 设置  —— 普通用户只看质量策略；Provider/模型收进「高级」
 *   缓存     —— 本机渲染缓存（Tauri 才有）
 *
 * 除主题外的设置项目前存 localStorage，是纯前端偏好；
 * Provider / API Key 只读展示配置健康度（配没配、通道可不可用），
 * 不给输入框：密钥落到客户端就等于泄露，改 key 走服务端环境变量。
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import { Keyboard, Sparkles, HardDrive, Settings as Cog, AlertTriangle } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../../api";
import type { ProjectLook, ProjectLookOut, StyleOption } from "../../api";
import { listCommandKeys } from "../../commands";
import { ZOOM_DEFAULT } from "../../types/timeline";
import { IS_TAURI } from "../export/ExportDialog";
import { readPref, writePref, clearPrefs } from "../../lib/prefs";
import {
  FONT_SCALES, applyFontScale, getFontScale, setFontScale,
} from "../../lib/fontScale";
import { localCacheStats, clearLocalCache } from "../../lib/mediaCache";
import type { LocalCacheStats } from "../../lib/mediaCache";
import {
  forgetLocalRoot, getLocalRoots, grantLocalRoots, subscribeLocalRoots,
} from "../../lib/localRootStore";
import "./SettingsDialog.css";
import { productionModeLabel } from "../../lib/modelLabels";
import { checkRuntime, runtimeWarning, MIN_CHROMIUM } from "../../lib/runtime";

type Tab = "editor" | "ai" | "cache";



interface Props {
  theme: string;
  /** 维护操作（补缩略图）作用于当前项目；未打开项目时该组不显示 */
  projectId?: string | null;
  onToggleTheme: () => void;
  productionMode: string | null;
  onClose: () => void;
  onToast: (m: string) => void;
}

export default function SettingsDialog(p: Props) {
  const [tab, setTab] = useState<Tab>("editor");
  // 引擎能力是进程内的常量（同一个 WebView 不会中途换引擎），算一次就够。
  const [rt] = useState(checkRuntime);
  const rtWarn = runtimeWarning(rt);
  const [zoom, setZoom] = useState(() => readPref("tlZoom", ZOOM_DEFAULT));
  const [autoSave, setAutoSave] = useState(() => readPref("autoSave", true));
  const [snapping, setSnapping] = useState(() => readPref("snap", true));
  const [quality, setQuality] = useState(() => readPref("quality", "preview"));
  // 界面字号档位。真值在 <html> 的 --fs-scale 上（启动时由 main.tsx 应用），
  // 这个 state 只是"哪个按钮高亮"。
  const [fontScale, setFontScaleState] = useState(() => getFontScale());
  const [advOpen, setAdvOpen] = useState(false);
  // TB-06 缓存统计（进入「缓存」页签才拉）
  const [cache, setCache] = useState<
    { items: { key: string; label: string; files: number; bytes: number;
               clearable: boolean }[]; total_bytes: number } | null>(null);
  const [clearing, setClearing] = useState(false);
  // 4.5 本机（AppData）素材缓存。与上面那组**不是一回事**：上面统计的是服务端
  // 的成片/素材，这里是 Tauri 客户端自己下载的副本，只有桌面端才存在。
  const [local, setLocal] = useState<LocalCacheStats | null>(null);
  const [clearingLocal, setClearingLocal] = useState(false);
  const [filling, setFilling] = useState(false);
  const [health, setHealth] = useState<Awaited<
    ReturnType<typeof api.providersHealth>> | null>(null);
  // 6.6 本次启动已授权的素材根。**不持久化**（授权本身就不跨重启），
  // 所以这里读的是进程级登记簿而不是 localStorage —— 见 lib/localRootStore.ts。
  const roots = useSyncExternalStore(subscribeLocalRoots, getLocalRoots);
  const [picking, setPicking] = useState(false);

  /**
   * 选一个（或多个）素材目录。
   *
   * ⚠️ `recursive: true` 是**必需**的，不是顺手加的选项：不加的话插件只把选中的
   * 那一层加进 scope，子目录里的素材一律读不到 —— 而用户选的往往正是根目录，
   * 素材躺在 `第01集/` 之类的子目录里。表现是"明明选了却还是读不到"。
   * 这条也是本条目扩权面的**唯一**来源：授的是用户亲手选的这棵子树，
   * capabilities 里的静态 scope 一个字没动（仍只有 `$APPDATA/**`）。
   */
  const pickRoots = async () => {
    setPicking(true);
    try {
      const picked = await open({
        directory: true, multiple: true, recursive: true,
        title: "选择素材目录",
      });
      const list = Array.isArray(picked) ? picked : picked ? [picked] : [];
      if (!list.length) return;      // 用户点了取消
      const changed = grantLocalRoots(list, Date.now());
      p.onToast(changed
        ? `已授权 ${getLocalRoots().length} 个素材目录（关闭软件后需重新选择）`
        : "这些目录已经在授权列表里了");
    } catch (e) {
      p.onToast(`选择目录失败：${String(e)}`);
    } finally {
      setPicking(false);
    }
  };

  useEffect(() => {
    if (tab === "ai" && !health) {
      api.providersHealth().then(setHealth).catch(() => { /* 旧后端无此接口 */ });
    }
  }, [tab, health]);

  // ── 画风（项目级）。与影调同一时机拉：都只在「AI」页签用。
  //    画风换的是**整套**风格词（正向 + 反向 + 影调题面），不是只换前缀，
  //    所以它和影调是两件事——画风定"这是什么片种"，影调定"这一套怎么调色"。
  const [styles, setStyles] = useState<StyleOption[] | null>(null);
  const [artStyle, setArtStyle] = useState<string | null>(null);
  const [artEff, setArtEff] = useState<{ label: string; pending: boolean } | null>(null);
  const [artLoaded, setArtLoaded] = useState(false);
  const [artBusy, setArtBusy] = useState(false);
  useEffect(() => {
    if (tab !== "ai" || artLoaded || !p.projectId) return;
    api.projectArtStyle(p.projectId).then((r) => {
      setStyles(r.styles); setArtStyle(r.art_style);
      setArtEff({ label: r.effective_label, pending: r.pending });
      setArtLoaded(true);
    }).catch(() => { setArtLoaded(true); });   // 旧后端无此接口：整块不显示
  }, [tab, artLoaded, p.projectId]);

  const saveArtStyle = async (key: string) => {
    if (!p.projectId || key === artStyle) return;
    const prev = artStyle;
    setArtStyle(key);                  // 乐观更新
    setArtBusy(true);
    try {
      const r = await api.saveProjectArtStyle(p.projectId, key);
      setArtStyle(r.art_style);
      setArtEff({ label: r.effective_label, pending: r.pending });
      p.onToast(r.pending
        ? `已记下「${key}」，但该画风还在完善中，实际仍按「${r.effective_label}」生成`
        : "画风已切换（已生成的图与视频不会重画）");
    } catch (e) {
      setArtStyle(prev);               // 存失败回滚，别显示存不下来的值
      p.onToast(`画风切换失败：${String(e).slice(0, 160)}`);
    } finally { setArtBusy(false); }
  };

  // ── 全片影调档案（项目级）。进「AI」页签才拉：绝大多数打开设置的场景
  // 是改编辑偏好，不该为此多一次请求。
  const [lookOut, setLookOut] = useState<ProjectLookOut | null>(null);
  const [look, setLook] = useState<ProjectLook | null>(null);
  const [lookPhrase, setLookPhrase] = useState("");
  const [lookLoaded, setLookLoaded] = useState(false);
  const [lookBusy, setLookBusy] = useState(false);
  useEffect(() => {
    if (tab !== "ai" || lookLoaded || !p.projectId) return;
    api.projectLook(p.projectId).then((r) => {
      setLookOut(r); setLook(r.look); setLookPhrase(r.phrase); setLookLoaded(true);
    }).catch(() => {
      setLookLoaded(true);   // 旧后端无此接口：面板显示"暂不可用"，不弹错
    });
  }, [tab, lookLoaded, p.projectId]);

  /** 存一条轴。后端 PUT 是**整体覆盖**，所以必须把其余轴一起回传——
   *  只传改动的那一条会把别的轴全清掉。 */
  const saveLook = async (axes: Record<string, string>, extra: string,
                          prev: ProjectLook | null) => {
    if (!p.projectId) return;
    setLookBusy(true);
    try {
      const r = await api.saveProjectLook(p.projectId, axes, extra);
      setLook(r.look);
      setLookPhrase(r.phrase);
      p.onToast("影调已保存（已生成的图不会自动重画）");
    } catch (e) {
      setLook(prev);         // 存失败就回滚，别让界面显示存不下来的值
      p.onToast(`影调保存失败：${String(e).slice(0, 160)}`);
    } finally { setLookBusy(false); }
  };

  const setLookAxis = async (key: string, value: string) => {
    const base = look ?? { v: 1, axes: {}, extra: "", status: "draft" };
    const axes = { ...base.axes };
    if (value) axes[key] = value; else delete axes[key];
    setLook({ ...base, axes });   // 乐观更新：下拉不该等一趟网络才回弹
    await saveLook(axes, base.extra, look);
  };

  const saveLookExtra = async (v: string) => {
    const base = look ?? { v: 1, axes: {}, extra: "", status: "draft" };
    if (v === base.extra) return;
    await saveLook(base.axes, v, look);
  };

  /** 按剧本重判影调。与形象档案同理：审美判断，重判几乎必然给出不同结果，
   *  所以只由用户显式触发，自动流程永不重生成。 */
  const regenLook = async () => {
    if (!p.projectId) return;
    if (!window.confirm(
      "按剧本重新判定全片影调？\n\n" +
      "重判出来的调色配方几乎一定与现在不同（这是审美判断，不是事实提取）。" +
      "已生成的图与视频不会自动重画，只影响此后新生成的。")) return;
    setLookBusy(true);
    try {
      const r = await api.regenerateProjectLook(p.projectId);
      setLook(r.look);
      setLookPhrase(r.phrase);
      p.onToast("影调已重新判定");
    } catch (e) {
      p.onToast(`重新判定失败：${String(e).slice(0, 160)}`);
    } finally { setLookBusy(false); }
  };

  const loadCache = async () => {
    try { setCache(await api.cacheStats()); }
    catch (e) { p.onToast(String(e)); }
  };
  useEffect(() => { if (tab === "cache") void loadCache(); }, [tab]);
  useEffect(() => {
    // 只在桌面端拉：浏览器里没有 appDataDir，调了必抛。
    if (tab !== "cache" || !IS_TAURI) return;
    localCacheStats().then(setLocal).catch(() => setLocal(
      { projects: 0, files: 0, bytes: 0, parts: 0 }));
  }, [tab]);

  const fmtBytes = (b: number) =>
    b > 1e9 ? `${(b / 1e9).toFixed(2)} GB`
      : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB`
        : `${Math.max(0, Math.round(b / 1024))} KB`;

  const keys = listCommandKeys();

  return (
    <div className="fw-set-mask" onClick={p.onClose}>
      <div className="fw-set" onClick={(e) => e.stopPropagation()}>
        <header className="fw-set-head">
          <Cog size={15} /> <span>设置</span>
          <button className="fw-set-close" onClick={p.onClose}>×</button>
        </header>

        <div className="fw-set-main">
          <nav className="fw-set-nav">
            <button className={tab === "editor" ? "on" : ""} onClick={() => setTab("editor")}>
              <Keyboard size={13} /> 编辑
            </button>
            <button className={tab === "ai" ? "on" : ""} onClick={() => setTab("ai")}>
              <Sparkles size={13} /> AI
            </button>
            <button className={tab === "cache" ? "on" : ""} onClick={() => setTab("cache")}>
              <HardDrive size={13} /> 缓存
            </button>
          </nav>

          <div className="fw-set-body">
            {tab === "editor" && (
              <>
                <Group title="外观">
                  <Field label="主题">
                    <button className="fw-set-btn" onClick={p.onToggleTheme}>
                      {p.theme === "dark" ? "深色" : "浅色"}
                    </button>
                  </Field>
                  {/* 界面字号：改的是 CSS 乘子 --fs-scale，即刻生效、不需要刷新
                      （见 lib/fontScale.ts）。烧录字幕的字号不受影响，那是
                      「文字」面板里另一套参数——要烧进画面的尺寸不该跟界面联动。 */}
                  <Field label="界面字号">
                    <span className="fw-set-seg">
                      {FONT_SCALES.map((s) => (
                        <button key={s.v} className={fontScale === s.v ? "on" : ""}
                          title={s.hint}
                          onClick={() => { setFontScaleState(setFontScale(s.v)); }}>
                          {s.label}
                        </button>
                      ))}
                    </span>
                  </Field>
                  <div className="fw-set-note">
                    只影响软件界面文字（菜单、剧本、镜头卡等），
                    <b>不影响成片里的烧录字幕</b>。
                  </div>
                </Group>

                <Group title="时间轴">
                  <Field label="默认缩放">
                    <span className="fw-set-slider">
                      <input type="range" min={4} max={60} value={zoom}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          setZoom(v); writePref("tlZoom", v);
                        }} />
                      <span className="fw-set-val">{zoom} px/s</span>
                    </span>
                  </Field>
                  <Field label="磁吸对齐">
                    <Switch on={snapping} onClick={() => {
                      setSnapping(!snapping); writePref("snap", !snapping);
                    }} />
                  </Field>
                  <Field label="自动保存">
                    <Switch on={autoSave} onClick={() => {
                      setAutoSave(!autoSave); writePref("autoSave", !autoSave);
                    }} />
                  </Field>
                  <div className="fw-set-note">
                    改动会实时保存；关掉之后，切换镜头或点到别处时也会保存
                  </div>
                </Group>

                <Group title="快捷键">
                  <div className="fw-set-keys">
                    {keys.map((k) => (
                      <div key={k.label} className="fw-set-key">
                        <span>{k.label}</span>
                        <kbd>{k.keys}</kbd>
                      </div>
                    ))}
                  </div>
                  <div className="fw-set-note">
                    快捷键为固定映射（对齐剪映/Premiere 通用键位）。
                    单键指令仅在焦点不在输入框时生效，写字幕时不会误触发。
                  </div>
                </Group>
                <Group title="运行环境">
                  {/* 2026-09-10：有用户界面整个塌掉（弹窗没底色、边框消失），
                      根因是他机器上的 WebView2 运行时太旧、不认 oklch()/color-mix()。
                      当时我们在服务端查遍源码与安装包都正常，却完全看不到用户那侧
                      跑的是什么引擎——所以把它摆在这里：一张截图就能定位。 */}
                  <Field label="渲染引擎">
                    <span className="fw-set-val">
                      {rt.chromium === null ? "未知" : `Chromium ${rt.chromium}`}
                      {rt.degraded ? "（过旧）" : ""}
                    </span>
                  </Field>
                  <div className="fw-set-note">
                    {rtWarn ?? `配色特性完整可用（要求 Chromium ${MIN_CHROMIUM} 及以上）。`}
                  </div>
                </Group>
              </>
            )}

            {tab === "ai" && (

              <>
                <Group title="生产策略">
                  <Field label="默认质量">
                    <span className="fw-set-tiers">
                      <button className={quality === "preview" ? "on" : ""}
                        onClick={() => { setQuality("preview"); writePref("quality", "preview"); }}>
                        ⚡ 快速验证
                      </button>
                      <button className={quality === "final" ? "on" : ""}
                        onClick={() => { setQuality("final"); writePref("quality", "final"); }}>
                        ◆ 精品
                      </button>
                    </span>
                  </Field>
                  <div className="fw-set-note">
                    快速验证用低成本模型试构图，精品用于最终产出。
                    单个镜头可在检查器的「高级设置」里单独覆盖。
                  </div>
                </Group>

                <Group title="当前项目">
                  <Field label="生成模式">
                    <span className="fw-set-ro">{productionModeLabel(p.productionMode)}</span>
                  </Field>
                  {p.projectId && artLoaded && styles && styles.length > 0 && (
                    <>
                      <Field label="画风">
                        <select value={artStyle ?? ""} disabled={artBusy}
                          onChange={(e) => void saveArtStyle(e.target.value)}>
                          {!artStyle && <option value="">（按默认）</option>}
                          {styles.map((st) => (
                            <option key={st.key} value={st.key} disabled={!st.enabled}>
                              {st.label}{st.enabled ? "" : "（待完善）"}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <div className="fw-set-note">
                        画风决定资产图与视频提示词的<b>整套</b>风格词（风格描述 + 反向约束 +
                        影调题面）。⚠️ 只影响<b>此后新生成</b>的图与视频，
                        已生成的不会重画——中途换画风会让新旧素材风格不一致。
                        {artEff?.pending && (
                          <> 当前选的这档还在完善中，实际按「{artEff.label}」生成。</>
                        )}
                      </div>
                    </>
                  )}
                  <div className="fw-set-note">
                    项目级模型与生成模式在新建项目时选择，之后可在项目设置中调整
                  </div>
                </Group>

                {/* 全片影调：一套调色配方，拼进所有资产图/首帧图/视频提示词。
                    它是"不同图片色调不统一"的根治手段——此前提示词里对影调
                    零约束，每张图各自随机决定色温对比饱和，拼起来自然花。 */}
                {p.projectId && (
                  <Group title="全片影调">
                    {!lookLoaded ? <div className="fw-set-note">读取中…</div>
                      : !lookOut ? <div className="fw-set-note">后端暂不支持影调档案</div>
                        : (
                          <>
                            {lookOut.axes.map((ax) => {
                              const v = look?.axes[ax.key] ?? "";
                              // 词表外的值（AI 自己写的，或用户填的）也要能显示，
                              // 不能被下拉悄悄吞掉——所以并进候选列表
                              const opts = ax.values.includes(v) || !v
                                ? ax.values : [v, ...ax.values];
                              return (
                                <Field key={ax.key} label={ax.label}>
                                  <select value={v} disabled={lookBusy}
                                    onChange={(e) => { void setLookAxis(ax.key, e.target.value); }}>
                                    <option value="">（不设置）</option>
                                    {opts.map((o) => (
                                      <option key={o} value={o}>
                                        {ax.values.includes(o) ? o : `${o}（自定义）`}
                                      </option>
                                    ))}
                                  </select>
                                </Field>
                              );
                            })}
                            <Field label="自由补充">
                              <input key={look?.extra ?? ""} disabled={lookBusy}
                                maxLength={lookOut.extra_max}
                                placeholder="下拉放不下的整片质感（如：轻微暗角、局部漏光）"
                                defaultValue={look?.extra ?? ""}
                                onBlur={(e) => { void saveLookExtra(e.target.value.trim()); }} />
                            </Field>
                            <div className="fw-set-note">
                              {look
                                ? <>状态：{look.status === "confirmed" ? "已手动确认（自动流程不再覆盖）" : "AI 按剧本判定"}</>
                                : <>这个项目还没有影调档案，一键成片时会自动判一份。</>}
                            </div>
                            {/* 把"实际拼进提示词的那句话"摊开给用户看：影调是个抽象
                                概念，不给出这句原文，用户改了下拉也不知道到底改了什么 */}
                            {lookPhrase && (
                              <div className="fw-set-note" style={{ opacity: 0.85 }}>
                                拼进提示词的原文：{lookPhrase}
                              </div>
                            )}
                            <div className="fw-set-note">
                              ⚠️ 影调只影响<b>此后新生成</b>的图与视频，
                              不会自动重画已有的图。想让老图跟上，得删掉重画。
                              日/夜与明暗由剧本决定，不受这里影响。
                            </div>
                            <button className="fw-set-adv-head" disabled={lookBusy}
                              onClick={() => { void regenLook(); }}>
                              {lookBusy ? "⏳ 处理中…" : "🔄 按剧本重新判定影调"}
                            </button>
                          </>
                        )}
                  </Group>
                )}

                <button className="fw-set-adv-head" onClick={() => setAdvOpen((v) => !v)}>
                  {advOpen ? "▾" : "▸"} 高级（Provider / 模型 / API）
                </button>
                {advOpen && (
                  <Group title="外部通道状态">
                    {!health ? (
                      <div className="fw-set-note">读取中…</div>
                    ) : (
                      <>
                        {health.channels.map((c) => (
                          <Field key={c.key} label={c.label}>
                            <span className={`fw-set-chip ${c.configured ? "ok" : "off"}`}
                              title={c.base_url}>
                              {c.configured ? "已配置" : "未配置"}
                            </span>
                          </Field>
                        ))}
                        <Field label="语音合成（配音）">
                          <span className={`fw-set-chip ${health.features.tts ? "ok" : "off"}`}>
                            {health.features.tts ? "可用" : "不可用"}
                          </span>
                        </Field>
                        <Field label="语音识别（自动字幕）">
                          <span className={`fw-set-chip ${health.features.asr ? "ok" : "off"}`}>
                            {health.features.asr ? "可用" : "不可用"}
                          </span>
                        </Field>
                        <div className="fw-set-todo">
                          <AlertTriangle size={12} />
                          <div>{health.note}</div>
                        </div>
                      </>
                    )}
                  </Group>
                )}
              </>
            )}

            {tab === "cache" && (
              <>
                <Group title="服务器存储">
                  {!cache ? (
                    <div className="fw-set-note">读取中…</div>
                  ) : (
                    <>
                      {cache.items.map((it) => (
                        <Field key={it.key} label={it.label}>
                          <span className="fw-set-ro">
                            {it.files} 个 · {fmtBytes(it.bytes)}
                          </span>
                        </Field>
                      ))}
                      <Field label="合计">
                        <span className="fw-set-ro">{fmtBytes(cache.total_bytes)}</span>
                      </Field>
                      <Field label="清理导出成片">
                        <button className="fw-set-btn danger" disabled={clearing}
                          onClick={async () => {
                            setClearing(true);
                            try {
                              const r = await api.cacheClear("outputs", 0);
                              p.onToast(`已清理 ${r.removed} 个文件，释放 ${fmtBytes(r.freed_bytes)}`);
                              await loadCache();
                            } catch (e) { p.onToast(String(e)); }
                            finally { setClearing(false); }
                          }}>
                          {clearing ? "清理中…" : "清空"}
                        </button>
                      </Field>
                      <div className="fw-set-note">
                        只清导出成片（可重新导出再生成）。上传素材与 AI 生成结果
                        不可再生，不提供清理入口。
                      </div>
                    </>
                  )}
                </Group>

                {p.projectId && (
                  <Group title="数据维护">
                    <Field label="补齐镜头缩略图">
                      <button className="fw-set-btn" disabled={filling}
                        onClick={async () => {
                          setFilling(true);
                          try {
                            const r = await api.backfillThumbs(p.projectId!);
                            p.onToast(r.scanned === 0
                              ? "所有镜头都已有缩略图，无需补齐"
                              : `已补 ${r.filled}/${r.scanned} 张缩略图`
                                + (r.failed ? `，${r.failed} 个抽帧失败` : ""));
                          } catch (e) { p.onToast(String(e)); }
                          finally { setFilling(false); }
                        }}>
                        {filling ? "抽帧中…" : "开始补齐"}
                      </button>
                    </Field>
                    <div className="fw-set-note">
                      给缩略图功能上线前生成的老镜头补抽首帧。串行执行，
                      不会和正在跑的生成任务抢 CPU。
                    </div>
                  </Group>
                )}

                {IS_TAURI && (
                  <Group title="本地缓存">
                    {!local ? (
                      <div className="fw-set-note">读取中…</div>
                    ) : (
                      <>
                        <Field label="已缓存素材">
                          <span className="fw-set-ro">
                            {local.files} 个 · {local.projects} 个项目 · {fmtBytes(local.bytes)}
                          </span>
                        </Field>
                        {local.parts > 0 && (
                          <Field label="没下完的残留">
                            <span className="fw-set-ro">{local.parts} 个（下次导出时自动清理）</span>
                          </Field>
                        )}
                        <Field label="清空本地素材缓存">
                          <button className="fw-set-btn danger" disabled={clearingLocal}
                            onClick={async () => {
                              setClearingLocal(true);
                              try {
                                const r = await clearLocalCache();
                                p.onToast(r.removed === 0
                                  ? "本地缓存已经是空的"
                                  : `已删除 ${r.removed} 个文件，释放 ${fmtBytes(r.freed)}`);
                                setLocal(await localCacheStats());
                              } catch (e) { p.onToast(String(e)); }
                              finally { setClearingLocal(false); }
                            }}>
                            {clearingLocal ? "清理中…" : "清空"}
                          </button>
                        </Field>
                      </>
                    )}
                    <div className="fw-set-note">
                      导出时素材会先存一份到本地，再导同一个项目就不用重新下载。
                      清空只是让下次导出重新下载一遍，不会动到任何项目内容。
                    </div>
                  </Group>
                )}

                {IS_TAURI && (
                  <Group title="本地素材目录">
                    {roots.length === 0 ? (
                      <div className="fw-set-note">本次启动还没有授权任何素材目录</div>
                    ) : (
                      <ul className="fw-set-mats">
                        {roots.map((r) => (
                          <li key={r.path} className="fw-set-mat">
                            {/* title 里才给全路径：列表上摊开绝对路径既长，
                                又会把用户的目录结构（常含真名、公司名）带进截图 */}
                            <span className="fw-set-mat-name" title={r.path}>{r.label}</span>
                            <button className="fw-set-mat-x"
                              onClick={() => {
                                forgetLocalRoot(r.path);
                                p.onToast(`已把「${r.label}」移出列表`);
                              }}>移出列表</button>
                          </li>
                        ))}
                      </ul>
                    )}
                    <Field label="添加素材目录">
                      <button className="fw-set-btn" disabled={picking}
                        onClick={() => void pickRoots()}>
                        {picking ? "选择中…" : "选择…"}
                      </button>
                    </Field>
                    <div className="fw-set-note">
                      选中的目录（含子目录）在<b>本次启动内</b>可直接读取，用它们里的素材
                      编辑和导出都不会产生下载。授权由系统对话框当场授予，
                      <b>关闭软件时释放</b>——下次打开老项目若提示读不到素材，
                      重新选一次目录即可，不是项目损坏。
                    </div>
                    <div className="fw-set-note">
                      「移出列表」后本软件不再读取该目录；系统层面的授权仍要到
                      关闭软件时才真正释放，这里做不到当场收回。
                    </div>
                  </Group>
                )}

                <Group title="浏览器偏好">
                  <Field label="重置界面偏好">
                    <button className="fw-set-btn danger" onClick={() => {
                      clearPrefs();
                      // 面板尺寸走另一套 key（fw_sz_*），不在 prefs 前缀内
                      Object.keys(localStorage)
                        .filter((k) => k.startsWith("fw_sz_"))
                        .forEach((k) => localStorage.removeItem(k));
                      // 字号的偏好已被 clearPrefs 清掉，但 <html> 上那行 inline
                      // style 还挂着——不复位的话界面字号会一直是旧档，
                      // 用户会以为"重置没生效"。
                      setFontScaleState(applyFontScale());
                      p.onToast("已重置面板尺寸与偏好，刷新后生效");
                    }}>重置</button>
                  </Field>
                  <div className="fw-set-note">
                    清空面板尺寸、时间轴缩放等本地偏好，不影响项目数据
                  </div>
                </Group>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---- 小组件 ---- */
function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="fw-set-group">
      <div className="fw-set-group-title">{title}</div>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="fw-set-field">
      <span className="fw-set-label">{label}</span>
      <span className="fw-set-control">{children}</span>
    </div>
  );
}

function Switch({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button className={`fw-set-switch ${on ? "on" : ""}`} onClick={onClick}>
      {on ? "开" : "关"}
    </button>
  );
}
