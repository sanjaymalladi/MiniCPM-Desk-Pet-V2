# MiniCPM 桌宠桥接 (minicpm-pet-bridge)

把本地的 **MiniCPM5 0.9B** 接到桌面上的 **clawd-on-desk** 桌宠：你在网页里跟模型聊天，桌宠会跟着同步做反应动画。

```
 你 ─▶ 浏览器聊天页 ─▶ FastAPI ─▶ MiniCPM (MPS)
                          │
                          └─▶ POST /state ─▶ clawd-on-desk (桌宠) ─▶ 思考/工作/注意 动画
```

## 仓库结构

```
Minicpm/
├── models/minicpm5-0.9b/         # 已解压的 HuggingFace 格式权重（pytorch_model.bin）
├── clawd-on-desk/                # Electron 桌宠（独立进程，无需改源码）
└── minicpm-pet-bridge/           # 本目录
    ├── server.py                 # FastAPI 推理服务 + 静态页托管
    ├── clawd_state.py            # 状态推送桥（best-effort，不可达自动跳过）
    ├── static/index.html         # 聊天前端（流式、思考折叠、深色主题）
    ├── smoke_test.py             # 冷启动 + 一次推理的本地自检
    ├── start.sh                  # 一键启动（含 conda activate）
    └── requirements.txt
```

## 一次性环境准备

```bash
# 1) conda 环境（Python 3.11）
conda create -n minicpm-pet python=3.11 -y
conda activate minicpm-pet

# 2) 装依赖（torch 会自动选 Apple Silicon 的 MPS 版本）
pip install -r requirements.txt

# 3) 模型已经在 ../models/minicpm5-0.9b/ 解压好。
#    如果重新解压：
#    tar -xzf ../MiniCPM5-0.9B-0512_*.tar.gz -C ../models
#    mv ../models/MiniCPM5-0.9B-0512_* ../models/minicpm5-0.9b
```

冒烟自检（确认能加载 + 出回复）：

```bash
conda activate minicpm-pet
python smoke_test.py
```

预期：M4 16GB 上加载约 3 秒，首次生成约 8 秒、之后稳定在 ~10 token/s。

## 日常使用

**最简流程（两个终端，全程命令行）：**

终端 A — 启动桌宠（macOS 没有 Dock 图标，只在菜单栏右上角有托盘图标，桌宠本体是屏幕上的浮窗）：

```bash
cd ../clawd-on-desk
npm install        # 仅首次
npm start
```

终端 B — **直接在终端里聊天**（无需浏览器、无需先开服务）：

```bash
cd minicpm-pet-bridge
conda activate minicpm-pet
python chat.py                 # 直连模式，进程内加载模型
python chat.py --thinking      # 默认显示模型的 <think> 推理
python chat.py --no-pet        # 关闭桌宠状态推送
```

每输入一句，桌宠会经历 `thinking → working → attention` 反应动画。

REPL 命令（在 `你 ▶ ` 提示后输入）：

| 命令 | 作用 |
|------|------|
| `/help` | 帮助 |
| `/reset` | 清空多轮历史 |
| `/think on\|off` | 切换"显示思考" |
| `/system <prompt>` | 重新设置 system prompt |
| `/save <file>` | 保存当前对话 JSON |
| `/quit`、`Ctrl+D` | 退出 |

**可选：服务模式（如果想多端共享同一个加载好的模型）**

```bash
# 终端 B：起 HTTP 服务（等价于以前的 server.py + 浏览器访问 http://127.0.0.1:8765）
./start.sh
# 终端 C：用 chat.py 连这个服务
python chat.py --server http://127.0.0.1:8765
```

> 没启动桌宠也能正常聊天，桥接会静默丢弃推送事件。

## 常用参数

```bash
python server.py \
  --model ../models/minicpm5-0.9b \
  --host 127.0.0.1 \
  --port 8765 \
  --dtype auto         # auto | bfloat16 | float16 | float32
  --device mps         # mps | cuda | cpu，默认自动
  --no-pet             # 关闭桌宠状态推送
  --debug-pet          # 打印桥接调试日志
```

## API（如果想自己接前端）

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/health` | GET | 设备 / dtype / 模型路径 |
| `/api/chat`   | POST | OpenAI 风格 messages，SSE 流式 |
| `/api/state`  | POST | 手动触发桌宠状态：`{"state":"attention"}` |

`/api/chat` 请求体：

```json
{
  "messages": [{"role":"user","content":"你好"}],
  "stream": true,
  "max_new_tokens": 768,
  "temperature": 0.6,
  "top_p": 0.95,
  "thinking": false,
  "system": "可选的自定义 system prompt"
}
```

SSE 事件：

- `data: {"event":"start"}`
- `data: {"event":"think","content":"..."}`（仅当 `thinking: true`）
- `data: {"event":"delta","content":"..."}`
- `data: {"event":"end"}`
- `data: {"event":"error","message":"..."}`

## 桌宠状态映射

桥接借用 `agent_id="claude-code"` 直接复用桌宠现成的动画映射，不需要改桌宠源码：

| 阶段 | 推送 state | 桌宠动画 |
|------|-----------|----------|
| 收到用户消息 | `thinking` | 思考 |
| 流式生成中 | `working`（每 6s 续命一次）| 工作 |
| 一轮结束 | `attention` | 注意/完成 |
| 出错 | `error` | 错误反应 |
| 服务关闭 | `sleeping` | 睡眠 |

## 排错

- **`mps avail False`**：在 sandbox / 严格 Python 限制下出现；命令行直接跑就会变 True。
- **桌宠没反应**：确认 `clawd-on-desk` 已经 `npm start`，`~/.clawd/runtime.json` 存在；端口范围 23333-23337 有没有被占用。可以 `python clawd_state.py` 单独发一组测试事件验证。
- **回复里夹着 `<think>` 文本**：默认 `thinking=false` 会把它过滤掉；如果你看到，说明前端勾上了"显示思考"。
- **第一次很慢**：是冷加载权重 + MPS kernel 编译；之后会稳定。
- **改了 system prompt 模型偶尔回英文**：MiniCPM5 0.9B 这个 ckpt 中英都行，加一句"请用中文回答"通常能稳住。
