# MiniCPM-test

本地 MiniCPM5-0.9B 模型 + 桌宠交互的实验项目。Apple Silicon (Metal/MPS)
上跑一个 Python sidecar,Electron 桌宠当 UI 层,Cursor / Claude Code /
Codex 等 coding agent 完成事件触发桌宠主动旁白。

## 仓库结构

```
MiniCPM-test/
├── clawd-on-desk/              ← Electron 桌宠 (fork from rullerzhou-afk/clawd-on-desk @ 5b1f003)
│                                  + MiniCPM 集成: settings tab、聊天气泡、narration、
│                                  气泡拖动定位、warmup、多窗口队列等
├── minicpm-pet-bridge/         ← Python sidecar (conda 路径,FastAPI + transformers + MPS)
├── minicpm-pet-bridge-uv/      ← 同源 sidecar 的 uv 版 (推荐分发)
├── adapters/                   ← LoRA 适配器 (含猫娘版)
├── skills/
│   └── deploy-minicpm-pet/     ← Cursor Agent Skill,帮助协作者部署
├── go.sh                       ← 一键启动脚本(uv 路径)
├── CHANGELOG.md
└── README.md                   ← 这个
```

**不在仓库里的**:
- `models/minicpm5-0.9b/` — base 模型权重 (~2GB,大家自己有)
- `node_modules/` — `npm install` 生成
- `.venv/` — `uv sync` 生成

## 给协作者的快速上手

### 第一次 clone

```bash
git clone git@github.com:EEEEEKKO/MiniCPM-test.git
cd MiniCPM-test

# 把模型放进来 (~2GB,任选一种)
mkdir -p models
ln -s /path/to/your/minicpm5-0.9b models/minicpm5-0.9b
# 或直接 cp -r

./go.sh           # 自动装依赖 + 启动
```

`go.sh doctor` 可以单独检查环境是否 OK。

### 想用原版 conda 而不是 uv?

```bash
cd minicpm-pet-bridge
pip install -r requirements.txt
python server.py --host 127.0.0.1 --port 8765
# 另开终端
cd ../clawd-on-desk
npm install && npm start
```

### 部署到协作者机器

如果不熟悉这个项目,可以问 Cursor:
> 帮我部署 MiniCPM-test

这会触发 `skills/deploy-minicpm-pet/SKILL.md`,Agent 会引导你完整流程。

## 主要功能

- 本地模型聊天 (⌘⇧M 弹气泡)
- LoRA 人格切换 ("用猫娘" / "切回原版")
- 桌宠主动旁白 (Cursor/Claude/Codex 完成事件)
- Settings → 🐾 MiniCPM:模型参数、气泡位置、旁白开关
- 跨 agent 事件 merge:Cursor + Claude Code 同时为一个会话触发时
  自动选 transcript 上下文最丰富的那条

完整变更见 [CHANGELOG.md](./CHANGELOG.md)。

## 维护说明

### clawd-on-desk 跟 upstream 的关系

是 `rullerzhou-afk/clawd-on-desk@5b1f003` 的 fork (vendored,不是 submodule)。
我们加的 MiniCPM 集成包括但不限于:
- `src/minicpm-chat.js` — sidecar 管理 + narration pipeline
- `src/minicpm-chat.html` — 气泡 UI + 命令分类
- `src/preload-minicpm-chat.js` — IPC bridge
- `src/settings-tab-minicpm.js` — 🐾 MiniCPM 设置标签页
- `hooks/cursor-hook.js`、`hooks/clawd-hook.js` — 加了 transcript 解析,
  把 `session_title` + `last_summary` 注入 state event

如果上游有重要改动想合并:
```bash
# 临时方法: clone 上游、做 git diff、手动 cherry-pick
git clone https://github.com/rullerzhou-afk/clawd-on-desk /tmp/upstream
diff -r --brief /tmp/upstream clawd-on-desk
```

### Python sidecar 的两份代码

- `minicpm-pet-bridge/server.py`(原版)
- `minicpm-pet-bridge-uv/server.py`(uv 版)

**这两个文件应该 byte-identical**。改了原版就同步:
```bash
cp minicpm-pet-bridge/server.py minicpm-pet-bridge-uv/server.py
cp minicpm-pet-bridge/updater.py minicpm-pet-bridge-uv/updater.py
```

或写个 pre-commit hook 强制同步。

### 分发包

`dist/*.tar.gz` 不进 git(太大),自己本地打:
```bash
# 重新打 v0.2-uv 包
# (具体步骤参考 SKILL.md 或上次的对话历史)
```

## 已知限制

- 0.9B 模型 narration 偶尔翻车(改关键词、出语病),换更大 base 才能根治
- LoRA 切换需要 ~2-4s,过程中桌宠的 thinking 动画会持续转
- Codex agent 还没接 last_summary 解析(只有 thread_name)
- macOS only — Windows / Linux 没测过,go.sh 会报 macOS 检查
