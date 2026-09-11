/**
 * VoicePicker — 音色库选择器（角色音色的"挑选"入口）
 *
 * ## 为什么这个组件的重点是**空态**
 *
 * 音色库当前是空的，且会空很久：素材要后期才补（用户明确定过"音色库先留空，
 * 只做前端设计"）。所以打开这个弹层的人，**绝大多数看到的是空列表**。
 * 那么"空的时候说什么"就不是边角料，而是这个组件的主要产出：
 *   - 必须说清是**还没建**，不是加载失败、也不是他哪里没设置对；
 *   - 必须就地给出还能怎么办（自己传一段 / 干脆留空），而不是让人退出去再找。
 * 一句冷冰冰的"暂无数据"会让用户以为功能坏了，转头去别处翻——那正是要避免的。
 *
 * ## 两个宿主共用一份
 *
 * AudioPanel（真人剧·角色音色页签）和 AssetDialog（角色卡）都从这里进。
 * 两处各写一套必然漂移（空态文案、试听行为、选中后刷不刷新各改各的），
 * 所以做成一个受控弹层，宿主只给 onPick / onUploadInstead。
 */
import { useEffect, useState } from "react";
import { Loader2, Music, Play, Upload, X } from "lucide-react";
import { api } from "../../api";
import type { VoiceLibItem } from "../../api";
import "./VoicePicker.css";

interface Props {
  /** 弹层标题里显示的角色名（"给「秦淮」挑一个音色"） */
  charName: string;
  /** 当前已选中的音色 url（库里的那条会高亮） */
  currentUrl?: string | null;
  onPick: (v: VoiceLibItem) => void;
  onClose: () => void;
  /** 空态里的"自己上传一段"——宿主自己弹文件选择器 */
  onUploadInstead?: () => void;
  /** 宿主的全局试听器；缺省时组件自己 new Audio 播 */
  onPreview?: (url: string, label: string) => void;
}

export default function VoicePicker(p: Props) {
  const [voices, setVoices] = useState<VoiceLibItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await api.voiceLibrary();
        if (!alive) return;
        setVoices(r.voices);
        // 后端把"manifest 坏了"也降级成空库返回（面板不该因配置错误打不开），
        // 但它会带一条 error —— 那种空和"还没建"是两回事，必须分开说。
        setErr(r.error ?? null);
      } catch (e) {
        if (alive) { setVoices([]); setErr(`音色库没能加载：${String(e).slice(0, 120)}`); }
      }
    })();
    return () => { alive = false; };
  }, []);

  // Esc 关闭：这是个盖在别的弹窗上的层，没有 Esc 会很憋屈
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") p.onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [p.onClose]);

  const preview = (v: VoiceLibItem) => {
    const url = api.mediaUrl(v.url);
    if (p.onPreview) p.onPreview(url, `音色 · ${v.name}`);
    else void new Audio(url).play();
  };

  return (
    <div className="fw-vp-mask" onClick={p.onClose}>
      <div className="fw-vp" onClick={(e) => e.stopPropagation()}>
        <div className="fw-vp-head">
          <Music size={13} />
          <b>从音色库选 · {p.charName}</b>
          <button className="fw-vp-x" title="关闭" onClick={p.onClose}>
            <X size={13} />
          </button>
        </div>

        <div className="fw-vp-body">
          {voices === null ? (
            <div className="fw-vp-empty">
              <Loader2 size={16} className="fw-spin" /> 读取音色库…
            </div>
          ) : voices.length === 0 ? (
            <div className="fw-vp-empty">
              <div className="fw-vp-empty-icon">🎙</div>
              {err ? (
                <>
                  <b>音色库暂时读不出来</b>
                  <p>{err}</p>
                </>
              ) : (
                <>
                  <b>音色库还在建设中</b>
                  <p>
                    这里以后会放一批可直接选用的音色。现在还没有内容——
                    <b>不是你哪里没设置对</b>。
                  </p>
                </>
              )}
              <p className="fw-vp-empty-alt">
                在此之前，你可以<b>自己上传一段人声</b>作为该角色音色，
                或者<b>就这么留空</b>——留空时出片的声音由模型自由发挥，
                同一个角色在不同镜头里可能不是一个声音。
              </p>
              {p.onUploadInstead && (
                <button className="fw-vp-btn primary"
                  onClick={() => { p.onUploadInstead?.(); p.onClose(); }}>
                  <Upload size={13} /> 上传我自己的音色
                </button>
              )}
            </div>
          ) : (
            <div className="fw-vp-list">
              {voices.map((v) => {
                const on = !!p.currentUrl && p.currentUrl === v.url;
                const meta = [v.gender, v.age, v.style].filter(Boolean).join(" · ");
                return (
                  <div key={v.id} className={`fw-vp-row ${on ? "on" : ""}`}>
                    <div className="fw-vp-info">
                      <span className="fw-vp-name">
                        {v.name}{on && <em> · 当前</em>}
                      </span>
                      <span className="fw-vp-meta">
                        {meta || "—"}
                        {v.tags.length > 0 && ` · ${v.tags.join(" ")}`}
                      </span>
                    </div>
                    <button className="fw-vp-btn" title="试听"
                      onClick={() => preview(v)}>
                      <Play size={11} /> 试听
                    </button>
                    <button className="fw-vp-btn primary" disabled={on}
                      onClick={() => { p.onPick(v); p.onClose(); }}>
                      {on ? "已选" : "选用"}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
