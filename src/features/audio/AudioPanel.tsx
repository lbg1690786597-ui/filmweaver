/**
 * AudioPanel — 音频面板（PLAN §7.3，Phase 3）
 *
 * 三个区域：
 *   1. 已有旁白/配乐列表（来自后端 AudioClip）
 *   2. 第二页签**按生产模式分叉**（见下）
 *   3. BGM / 音效：项目自有音频素材（用户上传后打 bgm/sfx 标签分类）。
 *      ⚠️ 不是平台内置曲库——本项目没有可分发的版权音乐，
 *      给假曲目不如如实呈现"你自己传了什么"（见文档 D-01 偏离登记）。
 *
 * ## 第二页签为什么要分叉（2026-09-10）
 *
 * 它原本无条件是「AI 配音」+「一键生成全部旁白」，而那个按钮只对**已存在的**
 * AudioClip(kind=tts/narration) 做 TTS 批量合成——它不创建音色、也不创建旁白段。
 * 真人剧全库根本不存在 tts 段（旁白段只由解说剧的「按剧本生成解说旁白」产出），
 * 于是真人剧用户点它：任务提交、任务完成、什么都没发生。
 * 后端其实在结果里写了 `note:"没有待合成的旁白"`，但前端不看，照报"✅ 完成"。
 *
 * 根因是**把解说剧功能摆给了真人剧**。真人剧音画一体，声音由视频生成时自带，
 * 本就不该走 TTS；它在这里真正需要的是给每个角色**指定音色**
 * （Asset.voice_url → jobs._auto_inject_voice_ref → 出片时作为参考音频）。
 * 所以真人剧下整页换成「角色音色」管理，解说剧完全维持原样。
 */

import { useEffect, useRef, useState } from "react";
import {
  Volume2, Mic, Music, Play, Trash2, Loader2, RefreshCw, Upload, Tag, Scissors,
  BookOpen, X,
} from "lucide-react";
import type { AudioClipInfo, AssetInfo, VoiceLibItem } from "../../api";
import { api } from "../../api";
import { fmtTime } from "../../types";
import {
  useLoadState, describeLoadError, LOAD_LABELS,
} from "../../stores/loadStateStore";
import VoicePicker from "./VoicePicker";
import "./AudioPanel.css";

const STATUS_LABEL: Record<string, string> = {
  done: "已就绪", generating: "合成中…", pending: "排队中", failed: "合成失败",
};

interface Props {
  projectId: string;
  audioClips: AudioClipInfo[];
  assets: AssetInfo[];        // 角色资产（音色候选）
  ttsAvailable: boolean;
  synthBusy: boolean;
  /** 项目生产模式（drama/narration）。解说剧才显示"按剧本生成旁白"入口。 */
  productionMode?: string | null;
  /** 解说音色（参考音频 URL）。解说剧整片共用一个声音。 */
  narrationVoiceUrl?: string | null;
  onSynthTts: (clipIds?: string[]) => void;
  onPreview: (url: string, label: string) => void;
  onAudioChanged: () => void;
  /** 解说音色改动后要刷的是**项目详情**（narration_voice_url 在 detail 上，
   *  不在 audio-clips 里）。只调 onAudioChanged 的话上传成功了界面也不更新。 */
  onProjectChanged?: () => void;
  onToast: (m: string) => void;
}

export default function AudioPanel(p: Props) {
  const [tab, setTab] = useState<"clips" | "tts" | "bgm">("clips");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // ---- BGM / 音效素材库（TB-07）----
  const [lib, setLib] = useState<{
    items: { id: string; name: string; url: string; duration: number;
             size: number; tag: string }[];
    counts: { bgm: number; sfx: number; unsorted: number; total: number };
  } | null>(null);
  const [libFilter, setLibFilter] = useState<"all" | "bgm" | "sfx" | "unsorted">("all");
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [libError, setLibError] = useState<string | null>(null);

  const loadLib = async () => {
    try {
      setLib(await api.audioLibrary(p.projectId));
      setLibError(null);
      useLoadState.getState().noteLoaded("audioLib");
    } catch (e) {
      // 2.4：以前这里 catch 之后把 lib 设成**空库**，界面于是显示"音效库里什么都
      // 没有"，与真的空库一模一样 —— 用户据此再上传一遍已经有的音效。
      // 现在既不伪造空库、也不停在"读取中…"（那是第二个谎话），而是就地说明失败，
      // 同时挂到顶栏（顶栏那条是持久的，面板关了再打开也还在）。
      setLibError(describeLoadError(e, LOAD_LABELS.audioLib).message);
      if (useLoadState.getState().noteFailed("audioLib", e)) {
        p.onToast(`⚠️ ${useLoadState.getState().failures.audioLib?.message ?? "音效素材库没能加载"}`);
      }
    }
  };
  useEffect(() => { if (tab === "bgm") void loadLib(); }, [tab, p.projectId]);

  // 顶栏「重试」只在面板还开着时有意义；关掉面板即注销并清掉该条提示
  // （留着一个按了没反应的重试按钮，比不显示更糟）
  useEffect(() => useLoadState.getState().registerRetry(
    "audioLib", () => { void loadLib(); }), [p.projectId]);

  const voiceClips = p.audioClips.filter((c) => c.kind === "tts");
  const musicClips = p.audioClips.filter((c) => c.kind === "music");
  const shotClips = p.audioClips.filter((c) => c.kind === "shot");
  const narrClips = p.audioClips.filter((c) => c.kind === "narration");
  const chars = p.assets.filter((a) => a.kind === "character");
  const isNarration = p.productionMode === "narration";

  // ---- 解说剧：按剧本生成旁白 ----
  const [genNarr, setGenNarr] = useState(false);
  const [upVoice, setUpVoice] = useState(false);
  const voiceRef = useRef<HTMLInputElement | null>(null);

  const doUploadVoice = async (f: File) => {
    setUpVoice(true);
    try {
      const up = await api.uploadMedia(f, p.projectId);
      await api.setNarrationVoice(p.projectId, up.url);
      p.onToast("解说音色已设置");
      // 必须刷项目详情：narration_voice_url 挂在 detail 上，
      // 只刷 audio-clips 的话上传成功了界面仍显示"未设置"
      p.onProjectChanged?.();
      p.onAudioChanged();
    } catch (e) { p.onToast(`上传失败: ${String(e).slice(0, 120)}`); }
    finally { setUpVoice(false); }
  };

  const doGenNarration = async (replace: boolean) => {
    setGenNarr(true);
    try {
      const r = await api.generateNarration(p.projectId, { replace });
      const bits = [];
      if (r.created) bits.push(`生成 ${r.created} 段旁白`);
      if (r.skipped_existing) bits.push(`已有 ${r.skipped_existing} 段跳过`);
      if (r.shots_without_text) bits.push(`${r.shots_without_text} 镜无对应文字`);
      p.onToast(bits.length ? bits.join("，") : "没有可生成的旁白");
      p.onAudioChanged();
    } catch (e) { p.onToast(`生成失败: ${String(e).slice(0, 140)}`); }
    finally { setGenNarr(false); }
  };

  // ---- 提取镜头原声 ----
  const [detaching, setDetaching] = useState(false);
  const doDetach = async () => {
    setDetaching(true);
    try {
      const r = await api.detachShotAudio(p.projectId);
      const bits = [];
      if (r.created_count) bits.push(`提取 ${r.created_count} 段`);
      if (r.skipped_existing) bits.push(`已提取过 ${r.skipped_existing} 段`);
      if (r.no_audio) bits.push(`${r.no_audio} 镜无声音`);
      p.onToast(bits.length ? bits.join("，") : "没有可提取的镜头");
      p.onAudioChanged();
    } catch (e) { p.onToast(`提取失败: ${String(e).slice(0, 120)}`); }
    finally { setDetaching(false); }
  };

  const doDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await api.deleteAudioClip(id);
      p.onAudioChanged();
    } catch (e) { p.onToast(String(e)); }
    finally { setDeletingId(null); }
  };

  // ---- 真人剧：角色音色 ----
  // 写入口与 AssetDialog 的「🎙 上传音色」是同一条：api.patchAsset({voiceUrl})。
  // 改完必须 onProjectChanged()——assets 挂在项目 detail 上（App.tsx: assets=detail.assets），
  // 只调 onAudioChanged 的话设置成功了界面仍显示"未设置"（解说音色栽过同一个坑）。
  const [voiceBusyId, setVoiceBusyId] = useState<string | null>(null);
  const [pickFor, setPickFor] = useState<AssetInfo | null>(null);
  const [upFor, setUpFor] = useState<AssetInfo | null>(null);
  const charVoiceRef = useRef<HTMLInputElement | null>(null);

  const setCharVoice = async (a: AssetInfo, url: string | null, okMsg: string) => {
    setVoiceBusyId(a.id);
    try {
      await api.patchAsset(a.id, { voiceUrl: url });
      p.onToast(okMsg);
      p.onProjectChanged?.();
    } catch (e) { p.onToast(`设置失败：${String(e).slice(0, 140)}`); }
    finally { setVoiceBusyId(null); }
  };

  const doUploadCharVoice = async (a: AssetInfo, f: File) => {
    setVoiceBusyId(a.id);
    try {
      const r = await api.uploadMedia(f, p.projectId);
      await api.patchAsset(a.id, { voiceUrl: r.url });
      p.onToast(`🎙 「${a.name}」音色已设置`);
      p.onProjectChanged?.();
    } catch (e) { p.onToast(`上传失败：${String(e).slice(0, 140)}`); }
    finally { setVoiceBusyId(null); }
  };

  const withVoice = chars.filter((a) => a.voice_url).length;

  return (
    <div className="fw-audio">
      <div className="fw-audio-tabs">
        <button className={tab === "clips" ? "on" : ""} onClick={() => setTab("clips")}>
          <Volume2 size={12} /> 已有 {p.audioClips.length > 0 && `(${p.audioClips.length})`}
        </button>
        <button className={tab === "tts" ? "on" : ""} onClick={() => setTab("tts")}>
          <Mic size={12} /> {isNarration ? "AI 配音" : "角色音色"}
        </button>
        <button className={tab === "bgm" ? "on" : ""} onClick={() => setTab("bgm")}>
          <Music size={12} /> BGM
        </button>
      </div>

      <div className="fw-audio-body">
        {/* ---- 已有音频列表 ---- */}
        {tab === "clips" && (
          <>
            {/* 解说剧：整段剧本就是解说词，按句子边界切到各镜头 */}
            {isNarration && (
              <div className="fw-audio-detach">
                {/* 解说音色：整片一个声音，必须先设好才能合成。
                    做成醒目卡片而不是一行小字——没设它整条解说链路都跑不通，
                    此前的低对比度提示实测会被直接忽略。 */}
                <div className={`fw-voice-card ${p.narrationVoiceUrl ? "ok" : "missing"}`}>
                  <div className="fw-voice-head">
                    <Volume2 size={14} />
                    <b>解说音色</b>
                    {p.narrationVoiceUrl
                      ? <span className="fw-voice-state ok">已设置</span>
                      : <span className="fw-voice-state missing">必填</span>}
                  </div>
                  <div className="fw-voice-desc">
                    {p.narrationVoiceUrl
                      ? "整片解说共用这个声音。可随时更换，换后需重新合成旁白。"
                      : "上传一段人声（音频或视频均可），用来克隆解说员音色。不设置无法合成旁白。"}
                  </div>
                  <div className="fw-voice-acts">
                    <button className="fw-audio-btn primary" disabled={upVoice}
                      onClick={() => voiceRef.current?.click()}>
                      {upVoice ? <><Loader2 size={13} className="fw-spin" /> 上传中…</>
                        : <><Upload size={13} /> {p.narrationVoiceUrl ? "更换音色" : "上传解说音色"}</>}
                    </button>
                    {p.narrationVoiceUrl && (
                      <div className="fw-voice-sub">
                        <button className="fw-audio-link"
                          onClick={() => p.onPreview(api.mediaUrl(p.narrationVoiceUrl!), "解说音色")}>
                          ▶ 试听
                        </button>
                        <button className="fw-audio-link" onClick={async () => {
                          await api.setNarrationVoice(p.projectId, null);
                          p.onToast("已清除解说音色");
                          p.onProjectChanged?.();
                          p.onAudioChanged();
                        }}>清除</button>
                      </div>
                    )}
                  </div>
                </div>
                <input ref={voiceRef} type="file" accept="audio/*,video/*" hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (f) void doUploadVoice(f);
                  }} />

                <button className="fw-audio-btn primary" disabled={genNarr}
                  style={{ marginTop: 8 }}
                  onClick={() => doGenNarration(false)}>
                  {genNarr ? "正在切分…" : <><BookOpen size={13} /> 按剧本生成解说旁白</>}
                </button>
                {narrClips.length > 0 && (
                  <button className="fw-audio-btn" disabled={genNarr}
                    style={{ marginTop: 6 }}
                    onClick={() => doGenNarration(true)}>
                    ↻ 重新切分（清空现有 {narrClips.length} 段）
                  </button>
                )}
                <div className="fw-audio-hint" style={{ marginTop: 6 }}>
                  剧本原文按句子边界切分到各镜头，不做改写。
                  合成后镜头时长会跟着旁白走，声画自动对齐。
                  上传的参考音频只取前 15 秒用于克隆音色。
                </div>
              </div>
            )}

            {/* 提取镜头原声：AI 生成的视频通常自带声音，但它长在视频里，
                不提取就没法在音频轨上单独调整/挪位置。 */}
            <div className="fw-audio-detach">
              <button className="fw-audio-btn" disabled={detaching} onClick={doDetach}>
                {detaching ? "正在提取…" : <><Scissors size={13} /> 提取镜头原声到音频轨</>}
              </button>
              <div className="fw-audio-hint" style={{ marginTop: 6 }}>
                把 AI 视频自带的声音剥成独立音频段，可单独调音量、挪位置、删除。
                提取后视频原音轨会自动静音，声音不会重复。
              </div>
            </div>

            {p.audioClips.length === 0 ? (
              <div className="fw-audio-empty">
                还没有音频片段。<br />
                {isNarration
                  ? "可先「提取镜头原声」，或在「AI 配音」页签生成解说旁白。"
                  : "可先「提取镜头原声」把 AI 视频自带的声音剥到音频轨上。"}
              </div>
            ) : (
              <div className="fw-audio-list">
                {narrClips.length > 0 && <div className="fw-audio-sec">解说旁白</div>}
                {narrClips.map((c) => <AudioRow key={c.id} clip={c}
                  deleting={deletingId === c.id}
                  onPlay={() => c.url && p.onPreview(api.mediaUrl(c.url), `解说 · ${(c.text ?? "").slice(0, 20)}`)}
                  onRegen={() => p.onSynthTts([c.id])}
                  onDelete={() => doDelete(c.id)} />)}
                {shotClips.length > 0 && <div className="fw-audio-sec">镜头原声</div>}
                {shotClips.map((c) => <AudioRow key={c.id} clip={c}
                  deleting={deletingId === c.id}
                  onPlay={() => c.url && p.onPreview(api.mediaUrl(c.url), `镜头原声`)}
                  onDelete={() => doDelete(c.id)} />)}
                {voiceClips.length > 0 && <div className="fw-audio-sec">旁白 · AI 配音</div>}
                {voiceClips.map((c) => <AudioRow key={c.id} clip={c}
                  deleting={deletingId === c.id}
                  onPlay={() => c.url && p.onPreview(api.mediaUrl(c.url), `旁白 · ${(c.text ?? "").slice(0, 20)}`)}
                  onRegen={() => p.onSynthTts([c.id])}
                  onDelete={() => doDelete(c.id)} />)}
                {musicClips.length > 0 && <div className="fw-audio-sec">配乐</div>}
                {musicClips.map((c) => <AudioRow key={c.id} clip={c}
                  deleting={deletingId === c.id}
                  onPlay={() => c.url && p.onPreview(api.mediaUrl(c.url), `配乐`)}
                  onRegen={() => p.onSynthTts([c.id])}
                  onDelete={() => doDelete(c.id)} />)}
              </div>
            )}
          </>
        )}

        {/* ---- 第二页签：解说剧 = AI 配音(TTS)；真人剧 = 角色音色 ---- */}
        {tab === "tts" && !isNarration && (
          <div className="fw-audio-tts">
            <div className="fw-audio-hint">
              这里设定的是<b>出片时该角色的说话声</b>：生成视频时会把这段音频作为
              音色参考发给模型，让角色按这个声音说话。
            </div>
            <div className="fw-audio-hint">
              留空也能出片——只是声音由模型自由发挥，<b>同一个角色在不同镜头里
              可能不是一个声音</b>。设音色就是为了让它前后一致。
              上传的音频只取前 15 秒。
            </div>

            {chars.length === 0 ? (
              <div className="fw-audio-empty">
                还没有角色资产。<br />
                先在「AI 图片 / 资产」页生成或添加角色，再回来给他们指定音色。
              </div>
            ) : (
              <>
                <div className="fw-audio-sec">
                  角色音色（{withVoice}/{chars.length} 已设置）
                </div>
                <div className="fw-audio-voicelist">
                  {chars.map((a) => {
                    const busy = voiceBusyId === a.id;
                    return (
                      <div key={a.id} className="fw-audio-voicerow">
                        {a.image_url
                          ? <img src={api.mediaUrl(a.image_url)} alt=""
                              className="fw-audio-avatar" />
                          : <span className="fw-audio-avatar ph">👤</span>}
                        <div className="fw-audio-voiceinfo">
                          <span className="fw-audio-char-name">{a.name}</span>
                          {a.voice_url
                            ? <span className="fw-audio-chip ok">
                                <Volume2 size={9} /> 已设置
                              </span>
                            : <span className="fw-audio-chip dim">未设置 · 模型自由发挥</span>}
                        </div>
                        {/* 常显控件：藏在 hover 里等于用户眼里没这功能 */}
                        <div className="fw-audio-voiceacts">
                          <button title="试听" disabled={!a.voice_url || busy}
                            onClick={() => a.voice_url &&
                              p.onPreview(api.mediaUrl(a.voice_url), `音色 · ${a.name}`)}>
                            <Play size={11} />
                          </button>
                          <button title="上传音色（音频或视频均可）" disabled={busy}
                            onClick={() => { setUpFor(a); charVoiceRef.current?.click(); }}>
                            {busy ? <Loader2 size={11} className="fw-spin" /> : <Upload size={11} />}
                          </button>
                          <button title="从音色库选" disabled={busy}
                            onClick={() => setPickFor(a)}>
                            <Music size={11} />
                          </button>
                          <button className="danger" title="清除音色"
                            disabled={!a.voice_url || busy}
                            onClick={() => void setCharVoice(a, null, `已清除「${a.name}」的音色`)}>
                            <X size={11} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {/* 单个 input 复用给所有角色：upFor 记住这次是给谁传的。
                每个角色各挂一个 input 会在角色多时凭空多出几十个 DOM 节点。 */}
            <input ref={charVoiceRef} type="file" accept="audio/*,video/*" hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                const a = upFor;
                setUpFor(null);
                if (f && a) void doUploadCharVoice(a, f);
              }} />

            {pickFor && (
              <VoicePicker
                charName={pickFor.name}
                currentUrl={pickFor.voice_url}
                onPreview={p.onPreview}
                onClose={() => setPickFor(null)}
                onUploadInstead={() => {
                  setUpFor(pickFor);
                  // 等弹层卸载后再开文件选择器，否则 Esc/点遮罩会连带把它关掉
                  setTimeout(() => charVoiceRef.current?.click(), 0);
                }}
                onPick={(v: VoiceLibItem) => void setCharVoice(
                  pickFor, v.url, `🎙 「${pickFor.name}」音色设为「${v.name}」`)}
              />
            )}
          </div>
        )}

        {/* ---- AI 配音（TTS）：解说剧专属 ---- */}
        {tab === "tts" && isNarration && (
          <div className="fw-audio-tts">
            {!p.ttsAvailable ? (
              <div className="fw-audio-warn">
                ⚠️ AI 配音暂时用不了：服务器还没接通配音服务。
                这不是你的设置问题，软件里也没有可填的地方，需要在服务器上开通。
              </div>
            ) : (
              <>
                <p className="fw-audio-hint">
                  为剧本中的旁白文字生成 AI 配音。每个段落约 1 分钟，可继续其他操作。
                </p>
                {chars.length > 0 && (
                  <div className="fw-audio-voices">
                    {/* 原文案是「拖拽参考音频到角色卡」——**这里从来就没有 onDrop**，
                        怎么拖都不会有反应。改成指向真正的入口：资产页角色弹窗的
                        「🎙 上传音色」。（音色的消费方见 jobs._auto_inject_voice_ref） */}
                    <div className="fw-audio-sec">
                      角色音色（在「AI 图片/资产」页打开角色卡上传）
                    </div>
                    {chars.map((a) => (
                      <div key={a.id} className="fw-audio-char">
                        {a.image_url
                          ? <img src={api.mediaUrl(a.image_url)} alt="" className="fw-audio-avatar" />
                          : <span className="fw-audio-avatar ph">👤</span>}
                        <span className="fw-audio-char-name">{a.name}</span>
                        {a.voice_url
                          ? <span className="fw-audio-chip ok">
                              <Volume2 size={9} /> 有音色
                            </span>
                          : <span className="fw-audio-chip dim">无音色</span>}
                      </div>
                    ))}
                  </div>
                )}
                <button className="fw-audio-btn primary" disabled={p.synthBusy}
                  onClick={() => p.onSynthTts()}>
                  {p.synthBusy
                    ? <><Loader2 size={13} className="fw-spin" /> 合成中…</>
                    : <><Mic size={13} /> 一键生成全部旁白</>}
                </button>
                {voiceClips.length > 0 && (
                  <div className="fw-audio-list" style={{ marginTop: 8 }}>
                    {voiceClips.map((c) => <AudioRow key={c.id} clip={c}
                      deleting={deletingId === c.id}
                      onPlay={() => c.url && p.onPreview(api.mediaUrl(c.url), (c.text ?? "").slice(0, 20))}
                      onRegen={() => p.onSynthTts([c.id])}
                      onDelete={() => doDelete(c.id)} />)}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ---- BGM / 音效素材库（项目自有音频）---- */}
        {tab === "bgm" && (
          <div className="fw-audio-lib">
            <button className="fw-audio-btn primary" disabled={uploading}
              onClick={() => fileRef.current?.click()}>
              {uploading ? <><Loader2 size={13} className="fw-spin" /> 上传中…</>
                : <><Upload size={13} /> 上传音频素材</>}
            </button>
            <input ref={fileRef} type="file" accept="audio/*" multiple hidden
              onChange={async (e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = "";
                if (!files.length) return;
                setUploading(true);
                try {
                  for (const f of files) await api.uploadMedia(f, p.projectId);
                  await loadLib();
                  p.onToast(`已上传 ${files.length} 个音频，可打标签后取用`);
                } catch (err) { p.onToast(String(err)); }
                finally { setUploading(false); }
              }} />

            <div className="fw-audio-libfilters">
              {([
                ["all", "全部", lib?.counts.total ?? 0],
                ["bgm", "BGM", lib?.counts.bgm ?? 0],
                ["sfx", "音效", lib?.counts.sfx ?? 0],
                ["unsorted", "未分类", lib?.counts.unsorted ?? 0],
              ] as const).map(([k, label, n]) => (
                <button key={k}
                  className={`fw-audio-libfilter ${libFilter === k ? "on" : ""}`}
                  onClick={() => setLibFilter(k)}>
                  {label}<span>{n}</span>
                </button>
              ))}
            </div>

            {libError ? (
              /* 2.4：失败时既不装成空库、也不停在"读取中…"。就地说明 + 就地重试。 */
              <div className="fw-audio-loadfail">
                <span>⚠️ {libError}</span>
                <button className="fw-audio-btn" onClick={() => void loadLib()}>
                  <RefreshCw size={12} /> 重试
                </button>
              </div>
            ) : !lib ? (
              <div className="fw-audio-empty">读取中…</div>
            ) : lib.items.length === 0 ? (
              <div className="fw-audio-empty">
                还没有音频素材。<br />
                上传你自己的 BGM / 音效文件后，可在此按用途分类取用。
              </div>
            ) : (
              <div className="fw-audio-list">
                {lib.items
                  .filter((it) => libFilter === "all" || it.tag === libFilter)
                  .map((it) => (
                    <div key={it.id} className="fw-audio-row done">
                      <div className="fw-audio-row-info">
                        <span className="fw-audio-row-label">{it.name}</span>
                        <span className="fw-audio-row-meta">
                          {it.duration > 0 ? fmtTime(it.duration) : "—"}
                          {` · ${(it.size / 1e6).toFixed(1)}MB`}
                        </span>
                      </div>
                      <select className="fw-audio-tag" value={it.tag}
                        title="用途分类"
                        onChange={async (e) => {
                          try {
                            await api.setAudioTag(it.id,
                              e.target.value as "bgm" | "sfx" | "unsorted");
                            await loadLib();
                          } catch (err) { p.onToast(String(err)); }
                        }}>
                        <option value="unsorted">未分类</option>
                        <option value="bgm">BGM</option>
                        <option value="sfx">音效</option>
                      </select>
                      <div className="fw-audio-row-acts">
                        <button title="试听"
                          onClick={() => p.onPreview(api.mediaUrl(it.url), it.name)}>
                          <Play size={11} />
                        </button>
                      </div>
                    </div>
                  ))}
              </div>
            )}
            <div className="fw-audio-libnote">
              <Tag size={10} /> 项目自有素材（非平台曲库）
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---- 音频行 ---- */
function AudioRow({ clip, deleting, onPlay, onRegen, onDelete }: {
  clip: AudioClipInfo;
  deleting: boolean;
  onPlay: () => void;
  /** 缺省 = 该类型不支持重新合成（镜头原声是从视频剥的，没有"重合成"这回事） */
  onRegen?: () => void;
  onDelete: () => void;
}) {
  const label = clip.kind === "tts"
    ? (clip.text?.slice(0, 30) || "旁白")
    : clip.kind === "narration" ? (clip.text?.slice(0, 30) || "解说")
      : clip.kind === "shot" ? "镜头原声"
        : "配乐";
  return (
    <div className={`fw-audio-row ${clip.status}`}>
      <div className="fw-audio-row-info">
        <span className="fw-audio-row-label">{label}</span>
        <span className="fw-audio-row-meta">
          {STATUS_LABEL[clip.status] ?? clip.status}
          {clip.duration > 0 && ` · ${fmtTime(clip.duration)}`}
        </span>
      </div>
      <div className="fw-audio-row-acts">
        <button disabled={!clip.url || deleting} title="试听" onClick={onPlay}>
          <Play size={11} />
        </button>
        <button disabled={deleting} title="重新合成" onClick={onRegen}
          style={onRegen ? undefined : { display: "none" }}>
          <RefreshCw size={11} />
        </button>
        <button className="danger" disabled={deleting} title="删除" onClick={onDelete}>
          {deleting ? <Loader2 size={11} className="fw-spin" /> : <Trash2 size={11} />}
        </button>
      </div>
    </div>
  );
}
