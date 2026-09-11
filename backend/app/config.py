"""FilmWeaver 后端配置。所有密钥从环境变量读取，绝不硬编码入库。"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

#: .env 必须按**模块位置**定位，不能写相对路径（B36）。
#: `env_file=".env"` 是相对**进程 CWD** 解析的：systemd 单元里有
#: WorkingDirectory=…/backend 所以线上没事，但任何从别处启动的进程
#: （在仓库根跑脚本、cron、`python -m app.xxx`、pytest）都读不到这个文件，
#: 而 pydantic 缺文件不报错 —— 于是静默退回**全部默认值**：
#: API KEY 变空串（provider 显示"未配置"）、gateway 指向默认网关。
#: 表现是"同一份代码在服务里正常、我手动跑就说没配密钥"，极难定位。
_ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="FW_", env_file=str(_ENV_FILE),
                                      extra="ignore")

    env: str = "dev"
    host: str = "127.0.0.1"
    port: int = 8002  # dev 专属端口，与 drama-dev(8001)/prod(8000) 隔离

    # 本服务的公网可达前缀（不含 /fw 或 /fwp，仅 host:port）。
    # ⚠️ 勿为此新开对外端口——复用既有 9080 即可（端口暴露规则）。
    public_base_url: str = "http://118.196.33.51:9080"

    # 媒体的公网可达前缀（**含** nginx 的环境前缀）。留空则按 env 推导：
    #   dev  → {public_base_url}/fw   （nginx location /fw/  → 8002）
    #   prod → {public_base_url}/fwp  （nginx location /fwp/ → 8003）
    # 用途：把库里存的相对地址 /fw/media/... 拼成**远端 API 能拉到**的绝对地址。
    # 仅"出网那一刻"拼接，DB 仍存相对地址（换域名/迁服务器不失效）。
    #
    # ⚠️ 为什么不能直接用 public_base_url 拼：库里的相对地址前缀恒为 `/fw`
    # （media.py 里写死，与环境无关），prod 进程照原样拼出来就是
    # http://…:9080/fw/media/… —— 那条路由指向 **dev 后端 8002**，
    # 而文件在 prod 的数据目录里，远端拉取必 404。
    # 2026-09-02 现网事故即此：火山私域素材入库报 DownloadFailed、
    # 视频生成报 `content[1].image_url … resource not found`。
    # 故默认值必须能从 env 自动推出，不能依赖 .env 里多写一行（漏写=静默复发）。
    media_public_base: str = ""

    @property
    def media_base(self) -> str:
        """媒体出网基址（含环境前缀，无尾斜杠）。"""
        if self.media_public_base:
            return self.media_public_base.rstrip("/")
        prefix = "/fwp" if self.env == "prod" else "/fw"
        return f"{self.public_base_url.rstrip('/')}{prefix}"

    # 飞书登录回调的**对外**基址（含 nginx 的 /fw 前缀）。
    # 必须与飞书后台【安全设置 → 重定向 URL】登记的地址完全一致，否则授权被拒。
    # ⚠️ 不能复用 public_base_url：那个不带 /fw，而 nginx 的
    # `location /fw/ { proxy_pass http://127.0.0.1:8002/; }` 带尾斜杠会剥掉前缀，
    # 于是"对外要带 /fw、后端收到的是不带 /fw 的路径"——两者天然不同。
    # 用户已登记：http://118.196.33.51:9080/fw/v2/auth/feishu/callback
    feishu_callback_base: str = "http://118.196.33.51:9080/fw"

    # OpenAI 兼容网关（LLM/图像/视频 Provider 共用）。
    # 2026-08 起默认 zx1.deepwl.net：原 ai.kegeai.top 网关已失联（TLS reset + key 401），
    # zx1 为 drama 系列生产在用网关，文本(grok-4)/图像(gpt-image-2)/视频(veo-3-1-fast)均实测可用。
    gateway_base_url: str = "https://zx1.deepwl.net/v1"
    gateway_api_key: str = ""  # 文本/视频通道 KEY，从环境注入，勿写死
    # 图像通道独立 KEY（gpt-image-2 渠道）；留空则回退 gateway_api_key
    image_api_key: str = ""

    # ---- 兼容旧变量名（FW_KEGEAI_*）：仍可注入，作为回退 ----
    kegeai_base_url: str = ""
    kegeai_api_key: str = ""

    @property
    def llm_base_url(self) -> str:
        return (self.gateway_base_url or self.kegeai_base_url).rstrip("/")

    @property
    def llm_api_key(self) -> str:
        return self.gateway_api_key or self.kegeai_api_key

    @property
    def img_api_key(self) -> str:
        return self.image_api_key or self.llm_api_key

    # ---- 火山方舟（Seedance 2.0 视频生成）----
    # ep = 方舟推理接入点 id；留空则对应模型不注册（同 RunningHub 模式）
    ark_base_url: str = "https://ark.cn-beijing.volces.com/api/v3"
    ark_api_key: str = ""                # 从环境注入，勿写死

    # ---- 私域虚拟人像素材库（解决 Seedance 人脸审核拦截）----
    # AI 生成的定妆图直传会被判"疑似真人"拒绝（实测 40 镜里 39 镜栽在这），
    # 入库成可信资产后用 asset://<id> 引用即可过审。
    # 走火山原生 v4 签名（AK/SK），与 ark_api_key 的 Bearer 鉴权是两套。
    volc_access_key: str = ""            # 从环境注入，勿写死
    volc_secret_key: str = ""            # 从环境注入，勿写死
    #: 资源项目名。素材与推理接入点**必须同项目**，否则生成时取不到素材。
    volc_project_name: str = "juying"
    seedance_ep: str = ""                # Seedance 2.0 接入点
    seedance_mini_ep: str = ""           # Seedance 2.0 mini 接入点
    # ---- 数据目录（prod 与 dev 必须隔离）----
    # dev 默认 filmweaver-data，prod 由 FW_DATA_DIR 设为 filmweaver-prod-data。
    #
    # ⚠️ 这一项**只能**通过 `media.DATA_DIR` / `media.GENERATED_DIR` 使用，
    # 任何模块都不许再写 `Path(".../filmweaver-data/...")` 字面量：
    # 该设置 2026-08-28 拆 prod 时只在 prod 仓改了 media.py/main.py，
    # providers/image.py 与 providers/video.py 的硬编码被漏掉，结果生产用户
    # 生成的每一张图都写进了 **dev** 的数据目录，而库里存的 URL 由 prod 的
    # StaticFiles/_resolve_local 按 prod 目录解析 → 图全 404、出片时报
    # 「参考素材不可用」。见 2026-09-01 的修复说明。
    data_dir: str = "/root/filmweaver-data"

    #: Seedance 2.5 接入点。最大差异是**单镜可出 30s**（2.0 只有 15s），
    #: 解说剧拆镜会自动按这个上限放长（见 base.max_seconds → shot_seconds_cap）。
    seedance25_ep: str = "ep-20260831181525-qvct4"

    # ---- RunningHub（ComfyUI 工作流平台）：MiniMax H3 参考图生视频通道 ----
    # 该通道能力与 veo 互补：可吃最多 9 张参考图 + 参考音频 + 参考视频，
    # 分辨率/比例/时长/seed 均可精确控制（实测见 docs/RUNNINGHUB-MINIMAX-H3.md）。
    runninghub_base_url: str = "https://www.runninghub.cn"
    runninghub_api_key: str = ""              # 从环境注入，勿写死
    # MiniMax H3 Reference-to-Video 工作流 id
    runninghub_h3_workflow_id: str = "2084464684937342977"
    # ---- H3 其余生成模式的工作流 id（留空=该模式不可用，UI 置灰并提示）----
    # i2va(首帧生视频)：2026-08 接入，工作流与全参考那条**节点号完全不同**
    # （提示词 #55.text / 时长 #58 / seed #235 / 分辨率 #59 / 单图槽 #61、无音频节点），
    # 映射见 providers/video_runninghub.py::I2VA_NODES。
    runninghub_h3_i2va_workflow_id: str = "2086982586613714946"
    # fl2va(首尾帧生视频)：2026-08 接入，节点号又与上面两条都不同
    # （提示词直接写在 #332 MiniMaxH3ImageToVideo 的 **prompt** 输入上 /
    #  时长 #346 / seed #338 / 分辨率 #349 / 首帧槽 #61 + 尾帧槽 #73、无音频节点），
    # 映射见 providers/video_runninghub.py::FL2VA_NODES。
    runninghub_h3_fl2va_workflow_id: str = "2086993488448675842"
    # 尾帧(l2va)当前账号尚无对应工作流，用户提供后填环境变量即开通（代码零改动）：
    runninghub_h3_l2va_workflow_id: str = ""    # FW_RUNNINGHUB_H3_L2VA_WORKFLOW_ID
    # 机型档位：plus=48G(¥6/h，默认) / default=24G(¥4/h) / ultra=84G(¥9/h)
    # 默认走 plus：24G 只有 15 MP·s 预算（0.5MP 下单镜 30s），48G 有 20
    # （同档 40s）。多 ¥2/h 换来少 1/3 的镜头数，综合更省。ultra 与 plus
    # 实测逐点同能力（见 video_runninghub.py::_VRAM_BUDGET_MPS），别选。
    # ⚠️ 改这里会同时改变拆镜的单镜时长上限——两者刻意同源。
    runninghub_instance_type: str = "plus"
    # ---- TTS（IndexTTS-1.5 语音克隆）工作流：与主平台 audio_studio 同一工作流 ----
    # 2026-08 实测：upload→create(带 workflowJson 临时运行)→status→outputs 全链路 OK，
    # 单段约 60-70s、¥0.074/段。留空=音频轨 TTS 不可用（前端置灰提示）。
    runninghub_tts_workflow_id: str = "2065316868176564226"

    # 默认模型（可用环境变量覆盖；与 zx1 网关实测可用渠道对齐）
    llm_model: str = "gemini-3.6-flash"      # 文本：剧本优化/拆解
    # LLM 输出上限：>0 显式随请求带 max_tokens（顶掉网关可能偏小的默认值，
    # 应设为模型输出硬上限附近）；=0 省略该字段走网关默认。
    # 注：协议上无"无限"取值——每个模型都有输出硬上限，防截断的根本手段是输入分块。
    llm_max_tokens: int = 16384
    image_model: str = "gpt-image-2"          # 图像：资产生图
    video_model: str = "veo-3-1-fast"         # 视频：镜头生成

    # ---- api4me 中转站（与 zx1 互为兜底，图像 + 文本共用）----
    # 两把 key 分组不同不可混用：API4ME_API_KEY=gpt-image-2/z-image/非 gemini 文本分组，
    # API4ME_GEMINI_API_KEY=优质 gemini 分组（仅 gemini 系模型）。
    # 选哪把由模型名自动判定，见 providers/llm.py::_api4me_key。
    api4me_base_url: str = "https://ai.api4me.xyz"
    api4me_api_key: str = ""              # FW_API4ME_API_KEY
    api4me_gemini_api_key: str = ""       # FW_API4ME_GEMINI_API_KEY

    # ---- modelverse(UCloud) 中转站：第三条渠道，**终极兜底**（2026-09 与主平台对齐）----
    # 单 key 覆盖全部模型，没有 api4me 那种 gemini/非 gemini 分组之分。
    # ⚠️ 排在最后是**成本考量**：单价明显高于前两家，定位是"前两条都挂了才用"。
    # 留空 key = 该渠道不注册，行为与加它之前完全一致。
    modelverse_base_url: str = "https://api.modelverse.cn"
    modelverse_api_key: str = ""          # FW_MODELVERSE_API_KEY

    @property
    def modelverse_v1_base(self) -> str:
        """modelverse 的 OpenAI 兼容基址（补足 /v1，无尾斜杠）。

        文本(providers/llm.py)与图像(providers/image.py)共用同一份拼接逻辑，
        免得两处各写一遍、日后改基址时漏改一处。
        未配 key 时调用方应整条渠道跳过——本属性不负责判空。
        """
        b = (self.modelverse_base_url or "").rstrip("/")
        if b and not b.endswith("/v1"):
            b += "/v1"
        return b

    # ---- 文本渠道兜底（2026-08：zx1 欠费导致拆解全失败的直接对策）----
    # 三个中转站承载同一批文本模型、能力等价，任一欠费/无可用渠道/5xx/网络故障
    # 自动切到下一条。顺序可调，逗号分隔；写在前面的优先。
    llm_channel_order: str = "zx1,api4me,modelverse"   # FW_LLM_CHANNEL_ORDER
    # 某渠道被判定不可用后的冷却秒数：冷却期内直接跳过，不再逐个请求都去撞一次。
    # ⚠️ 这是"跳过已知坏渠道"，不是降并发——并发数不受影响（遵并发铁律）。
    llm_channel_cooldown: int = 120           # FW_LLM_CHANNEL_COOLDOWN
    # RunningHub 人像专用文生图工作流（z-image 通道；与主平台同工作流）
    runninghub_portrait_workflow_id: str = "2033845190879879169"

    # ---- 可选 API Token（数据安全）：设置即启用，不设置保持 dev 开放 ----
    # 启用后所有 /v2 写操作需带 Header: X-FW-Token。为未来登录体系前的轻量门锁。
    api_token: str = ""

    # ---- 登录体系（复用主平台用户数据）：设置即启用登录 ----
    # dev 指向 drama-dev orchestrator；未来上线 prod 改为 prod 地址即可（用户数据自动对应）。
    # 启用后 /v2 全部接口（除 auth/app.latest/health/媒体静态）需带会话 token。
    auth_upstream: str = ""  # 如 http://127.0.0.1:8001

    # ---- 视频生成并发与重试（全局池；所有 job/用户共用，满了自动排队）----
    # 并发数由用户统一掌控（遵铁律不擅自降）；seedance/海螺均支持 ≥300 并发
    video_concurrency: int = 300
    # 单镜失败自动重试次数（不含首次）；重试会释放并发槽、退避后重新排队
    video_retries: int = 2
    video_retry_backoff: float = 5.0  # 首次重试退避秒数（指数递增，封顶 60s）

    # 生成任务默认并发（由用户统一掌控，不擅自降；此处仅为初始值）
    default_concurrency: int = 8

    # ---- 图像生成并发与重试（2026-08：取消并发上限，改用渠道冷却 + 抖动退避）----
    # 0=无上限（真并发数取决于 KEY 自身承载 + 渠道冷却机制自动调节）；>0=信号量上限
    image_concurrency: int = 0
    # 单次生成失败后每个渠道的重试次数（不含首次）；429/超时等瞬态错误会抖动退避重试，
    # 全部重试仍失败→标记该渠道冷却、切下一渠道（与文本渠道同逻辑）
    image_retries: int = 3
    # 渠道被判定不可用后的冷却秒数（欠费/持续限流/5xx）；冷却期内自动跳过该渠道
    image_channel_cooldown: int = 120

    # ---- TTS 并发（解说剧一集就是几十段，串行要跑一小时）----
    # 每段 60-70s，串行是纯粹的浪费——RunningHub 侧各段互不相干，并发不影响音质。
    # 0 = **不设上限**（默认）：RunningHub 并发上限 800，实际生产很难打到，
    # 设人为上限只会白白拖慢。与 image_concurrency 同语义。
    # 需要临时限流时设 FW_TTS_CONCURRENCY=N（>0 即启用信号量）。
    tts_concurrency: int = 0

    request_timeout: int = 120


@lru_cache
def get_settings() -> Settings:
    return Settings()