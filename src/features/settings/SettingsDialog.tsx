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

import { useEffect, useState } from "react";
import { Keyboard, Sparkles, HardDrive, Settings as Cog, AlertTriangle } from "lucide-react";
import { api } from "../../api";
import { listCommandKeys } from "../../commands";
import { ZOOM_DEFAULT } from "../../types/timeline";
import { IS_TAURI } from "../export/ExportDialog";
import { readPref, writePref, clearPrefs } from "../../lib/prefs";
import "./SettingsDialog.css";
import { productionModeLabel } from "../../lib/modelLabels";

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
  const [zoom, setZoom] = useState(() => readPref("tlZoom", ZOOM_DEFAULT));
  const [autoSave, setAutoSave] = useState(() => readPref("autoSave", true));
  const [snapping, setSnapping] = useState(() => readPref("snap", true));
  const [quality, setQuality] = useState(() => readPref("quality", "preview"));
  const [advOpen, setAdvOpen] = useState(false);
  // TB-06 缓存统计（进入「缓存」页签才拉）
  const [cache, setCache] = useState<
    { items: { key: string; label: string; files: number; bytes: number;
               clearable: boolean }[]; total_bytes: number } | null>(null);
  const [clearing, setClearing] = useState(false);
  const [filling, setFilling] = useState(false);
  const [health, setHealth] = useState<Awaited<
    ReturnType<typeof api.providersHealth>> | null>(null);

  useEffect(() => {
    if (tab === "ai" && !health) {
      api.providersHealth().then(setHealth).catch(() => { /* 旧后端无此接口 */ });
    }
  }, [tab, health]);

  const loadCache = async () => {
    try { setCache(await api.cacheStats()); }
    catch (e) { p.onToast(String(e)); }
  };
  useEffect(() => { if (tab === "cache") void loadCache(); }, [tab]);

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
                    改动实时保存到服务端；关闭后仍会在切换镜头/失焦时保存
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
                  <div className="fw-set-note">
                    项目级模型与生成模式在新建项目时选择，之后可在项目设置中调整
                  </div>
                </Group>

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
                        <Field label="语音合成 TTS">
                          <span className={`fw-set-chip ${health.features.tts ? "ok" : "off"}`}>
                            {health.features.tts ? "可用" : "不可用"}
                          </span>
                        </Field>
                        <Field label="语音识别 ASR">
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
                  <Group title="本机缓存">
                    <div className="fw-set-note">
                      本机渲染会把素材缓存到应用数据目录，重复导出时可跳过下载
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
