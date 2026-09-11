# FilmWeaver（剧本成片桌面应用）· 开发仓

> 🚀 **新人/维护先看**：`docs/PROJECT-项目速览.md`（一页纸：环境、预览、重启、发版全流程）

配套规划见 `drama-dev/docs/PLAN-新需求讨论.md`（产品）与 `drama-dev/docs/PLAN-剧本成片-技术方案.md`（技术）。

## 组成
- `backend/`  云端隐形生成后端（FastAPI，OpenAI 兼容 zx1.deepwl.net 网关 + Provider 插件框架）
- `infra/`    dev 环境编排（docker-compose）
- `desktop/`  Tauri + Rust + Web UI 桌面客户端（v0.4.x）

## 端口约定（dev，全部 127.0.0.1 绑定，与 drama 系列完全隔离）
| 服务 | FilmWeaver dev | 说明 |
|---|---|---|
| backend | 8002 | 与 drama-dev(8001)/drama-prod(8000) 隔离 |
| postgres | 5434 | 与 5433/5432 隔离 |
| redis | 6381 | 与 6380/6379 隔离 |

## dev/prod 双通道
遵 `.clinerules`：一切先在本 dev 环境完成并验证 → 取得明确"上线"授权 → 才同步 prod。
本仓当前仅含 dev；prod 环境（含独立端口段、Stable 构建通道）待 dev 验证成熟后单独建立。

## 本地起后端（不走 Docker，快速验证）
```bash
cd backend
pip install -r requirements.txt
cp .env.example .env   # 填入 FW_GATEWAY_API_KEY（zx1 网关；旧 FW_KEGEAI_* 已废弃）
FW_ENV=dev uvicorn app.main:app --host 127.0.0.1 --port 8002
```
验证：
```bash
curl http://127.0.0.1:8002/health
curl http://127.0.0.1:8002/v2/providers/video
```

## Docker 起 dev 全栈
```bash
cd infra
docker compose up -d --build
docker compose logs -f backend
```

## 已就绪
- 后端：`/health`、`/v2/providers/video`、`/v2/projects`（SQLite 落库）、`/v2/projects/{id}/detail`
- Provider 插件框架（`app/providers/`）：新增模型 = 一个 VideoProvider 子类 + registry 注册一行，上层零改
- **视频 Provider 已接入并实测出片**（两条互补通道）：
  - `veo-3-1-fast`（默认）/ `veo-3-1`：zx1 网关 chat/completions 同步通道，音画一体、8s、16:9 / 9:16，1-3 分钟出片
  - `minimax-h3-ref2v`：RunningHub MiniMax H3 异步 ComfyUI 工作流，最多 9 张参考图 + 参考音频 + 参考视频，8 档画面比例、分辨率(megapixels)/时长/seed 精确可控、seed 默认随机化；适合多角色一致性镜头，详见 `docs/RUNNINGHUB-MINIMAX-H3.md`（需配 `FW_RUNNINGHUB_API_KEY`，未配则该通道自动隐藏）
- 编排全链路：剧本优化 → 镜头拆解 → 单镜生成 → 批量补齐 → 一键成片 Saga
- 时间轴拼接：ffmpeg 归一化 + concat + 可选烧字幕，支持图片入片、无音轨自动补静音
- 桌面端：Tauri + React 剪映式工作台（素材库/预览器/时间轴），AI 抽屉含逐镜「🎬 生成」按钮

### API 一览
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查（含已注册视频模型数） |
| GET | `/v2/providers/video` | 视频模型能力档位 |
| POST | `/v2/projects` · GET `/v2/projects` | 项目增/列 |
| GET | `/v2/projects/{id}/detail` | 剧本+镜头+资产一次拉全 |
| POST | `/v2/script/optimize` | 剧本优化（传 project_id 落库） |
| POST | `/v2/script/breakdown` | 镜头拆解 + 资产盘点（落库） |
| POST | `/v2/assets/generate` | 单张资产生图 |
| POST | `/v2/shots/generate` | 单镜视频生成（同步；veo 1-3 分钟，h3 更慢），支持参考图/音/视频 + 比例/分辨率/时长/seed，回传生效参数 `meta` |
| POST | `/v2/jobs` | 异步任务：`asset_batch` / `shot_videos` / `one_click_film` / `compose` |
| GET | `/v2/jobs/{id}` | 任务进度/结果 |
| POST | `/v2/media/upload` | 素材上传 |

一键成片进度分段：拆解 0-10 → 逐镜生成 10-80 → 拼接 80-100。

## 待办
- prod 环境：独立端口段 + Stable 构建通道（需明示"上线"授权后再建）
- 尾帧接力（承接镜头连贯性）：veo 渠道未回传尾帧，`supports_last_frame=False`，待有支持的渠道再启用
- 首帧图路线：`/v2/shots/generate` 已支持 `first_frame_url`，桌面端 UI 尚未接（当前走纯文生视频）
- 账本/成本统计（每次调用的 token/时长计费落库）
- Postgres 迁移：当前 SQLite 单机够用；多客户端并发写入前再迁

## 已知限制
- 视频生成单镜约 1-3 分钟，`/v2/shots/generate` 为同步等待；批量务必走 `/v2/jobs`（`shot_videos`）
- nginx `/fw/` 反代在 prod `:80` server 块内，`proxy_read_timeout 300s`；一键成片等长任务请用 job 轮询而非长连接
- 异步任务用 FastAPI BackgroundTasks + SQLite，进程重启后 running 任务不会自动恢复

## 安全
- 密钥只放 `.env`（已在 .gitignore），代码从环境读取，绝不硬编码入库
- systemd unit 通过 `EnvironmentFile` 读 `.env`，不在 unit 里写 KEY
- 后端仅绑 `127.0.0.1:8002`，对外经 nginx `/fw/` 反代
- ⚠️ 后端当前无鉴权：任何能访问 `http://<公网>/fw/` 的人都能调用生成接口消耗网关额度。上线前应加 API Token 或 IP 白名单。