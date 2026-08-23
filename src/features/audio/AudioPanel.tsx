/**
 * AudioPanel — 音频面板（PLAN §7.3，Phase 3）
 *
 * 三个区域：
 *   1. 已有旁白/配乐列表（来自后端 AudioClip）
 *   2. AI 配音（TTS：按角色生成旁白，参考音色可选）
 *   3. BGM / 音效：项目自有音频素材（用户上传后打 bgm/sfx 标签分类）。
 *      ⚠️ 不是平台内置曲库——本项目没有可分发的版权音乐，
 *      给假曲目不如如实呈现"你自己传了什么"（见文档 D-01 偏离登记）。
 */

import { useEffect, useRef, useState } from "react";
import {
  Volume2, Mic, Music, Play, Trash2, Loader2, RefreshCw, Upload, Tag,
} from "lucide-react";
import type { AudioClipInfo, AssetInfo } from "../../api";
import { api } from "../../api";
import { fmtTime } from "../../types";
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
  onSynthTts: (clipIds?: string[]) => void;
  onPreview: (url: string, label: string) => void;
  onAudioChanged: () => void;
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

  const loadLib = async () => {
    try { setLib(await api.audioLibrary(p.projectId)); }
    catch { setLib({ items: [], counts: { bgm: 0, sfx: 0, unsorted: 0, total: 0 } }); }
  };
  useEffect(() => { if (tab === "bgm") void loadLib(); }, [tab, p.projectId]);

  const voiceClips = p.audioClips.filter((c) => c.kind === "tts");
  const musicClips = p.audioClips.filter((c) => c.kind === "music");
  const chars = p.assets.filter((a) => a.kind === "character");

  const doDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await api.deleteAudioClip(id);
      p.onAudioChanged();
    } catch (e) { p.onToast(String(e)); }
    finally { setDeletingId(null); }
  };

  return (
    <div className="fw-audio">
      <div className="fw-audio-tabs">
        <button className={tab === "clips" ? "on" : ""} onClick={() => setTab("clips")}>
          <Volume2 size={12} /> 已有 {p.audioClips.length > 0 && `(${p.audioClips.length})`}
        </button>
        <button className={tab === "tts" ? "on" : ""} onClick={() => setTab("tts")}>
          <Mic size={12} /> AI 配音
        </button>
        <button className={tab === "bgm" ? "on" : ""} onClick={() => setTab("bgm")}>
          <Music size={12} /> BGM
        </button>
      </div>

      <div className="fw-audio-body">
        {/* ---- 已有音频列表 ---- */}
        {tab === "clips" && (
          p.audioClips.length === 0 ? (
            <div className="fw-audio-empty">
              还没有音频片段。<br />在「AI 配音」页签生成 TTS 旁白，或上传音频素材。
            </div>
          ) : (
            <div className="fw-audio-list">
              {voiceClips.length > 0 && <div className="fw-audio-sec">旁白 · TTS</div>}
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
          )
        )}

        {/* ---- AI 配音（TTS）---- */}
        {tab === "tts" && (
          <div className="fw-audio-tts">
            {!p.ttsAvailable ? (
              <div className="fw-audio-warn">
                ⚠️ 当前项目未配置 TTS 服务。请在设置页填写 TTS API Key（MiniMax 或兼容接口）。
              </div>
            ) : (
              <>
                <p className="fw-audio-hint">
                  为剧本中的旁白文字生成 AI 配音。每个段落约 1 分钟，可继续其他操作。
                </p>
                {chars.length > 0 && (
                  <div className="fw-audio-voices">
                    <div className="fw-audio-sec">角色音色（拖拽参考音频到角色卡）</div>
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

            {!lib ? (
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
  onRegen: () => void;
  onDelete: () => void;
}) {
  const label = clip.kind === "tts"
    ? (clip.text?.slice(0, 30) || "旁白")
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
        <button disabled={deleting} title="重新合成" onClick={onRegen}>
          <RefreshCw size={11} />
        </button>
        <button className="danger" disabled={deleting} title="删除" onClick={onDelete}>
          {deleting ? <Loader2 size={11} className="fw-spin" /> : <Trash2 size={11} />}
        </button>
      </div>
    </div>
  );
}
