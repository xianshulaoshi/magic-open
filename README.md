# magic-open

一句中文描述，自动找到对应的文件夹并打开。命令缩写是 `mag`，与 `magic-open` 参数完全相同。

- 文件夹 → 用 Finder 打开
- 加 `--vscode` → 用 VSCode 打开
- 加 `--cd` → 打开的同时，把当前终端切到这个目录（需先装 shell 函数，见[切换终端目录](#切换终端目录cd)）
- 加 `--dry-run` → 只展示猜到的目标，不真正打开（验证猜测效果用）

内置国产大模型支持：**DeepSeek、通义千问、智谱 GLM、Kimi、豆包、SiliconFlow**，以及 OpenAI 兼容接口和 Anthropic。

## 安装

要求：macOS + Node.js >= 18。零 npm 依赖。

```bash
git clone https://github.com/xianshulaoshi/magic-open.git
cd magic-open
./install.sh    # 安装到 ~/.local/bin（或 /usr/local/bin），得到 magic-open 和 mag 两个命令
```

开发时想改完代码立即生效，可以用 `npm link` 代替 `./install.sh`（全局命令直接指向本目录）。

也可以手动建软链：`sudo ln -s "$PWD/bin/magic-open.mjs" /usr/local/bin/magic-open && sudo ln -s /usr/local/bin/magic-open /usr/local/bin/mag`

## 分享给别人

三种方式，按便捷程度排序：

### 方式一：直接发文件（最简单，零依赖单文件）

把 `bin/magic-open.mjs` 发给对方，或发整个目录（含 `install.sh`）：

```bash
./install.sh               # 一键安装到 ~/.local/bin（或 /usr/local/bin）
./install.sh --uninstall   # 卸载
```

只发单文件时对方手动放：

```bash
mkdir -p ~/.local/bin && cp magic-open.mjs ~/.local/bin/magic-open && chmod +x ~/.local/bin/magic-open && ln -sf ~/.local/bin/magic-open ~/.local/bin/mag
```

### 方式二：Git 仓库

把仓库地址发给别人：

```bash
git clone https://github.com/xianshulaoshi/magic-open.git && cd magic-open && ./install.sh
# 或不克隆直接装：
npm install -g git+https://github.com/xianshulaoshi/magic-open.git
```

### 方式三：发布 npm 包（magic-open 包名当前未被占用）

```bash
npm publish                                        # 公共 npm
# 之后任何人一行安装：
npm install -g magic-open
```

> 注意：API Key 存在本机 `~/.magic-open.json`，不随仓库分发；对方需按上节配置自己的 Key，或以 `--provider none` 本地模式使用。

## 配置大模型（推荐）

三种方式任选其一，优先级：命令行参数 > `MAGIC_OPEN_*` 环境变量 > 配置文件 > 各家专属环境变量。

完整的配置项说明、优先级规则、接入其他模型的方法和报错排查，见 **[配置说明书](docs/configuration.md)**。

### 方式一：提供商专属环境变量（最简单）

```bash
export DEEPSEEK_API_KEY=sk-xxx        # 即可，provider 自动识别为 deepseek
# 或
export DASHSCOPE_API_KEY=sk-xxx       # 通义千问
export GLM_API_KEY=xxx.xxx            # 智谱 GLM
export MOONSHOT_API_KEY=sk-xxx        # Kimi
export ARK_API_KEY=xxx                # 豆包（火山方舟）
export SILICONFLOW_API_KEY=sk-xxx     # 硅基流动
export OPENAI_API_KEY=sk-xxx          # OpenAI / 兼容网关
export ANTHROPIC_API_KEY=sk-xxx       # Claude
```

### 方式二：配置文件 `~/.magic-open.json`

```json
{
  "provider": "deepseek",
  "apiKey": "sk-xxx",
  "model": "deepseek-chat",
  "baseUrl": "https://api.deepseek.com",
  "timeoutMs": 10000
}
```

`baseUrl` 和 `model` 可省略（用各提供商默认值）。文件里的 `apiKey`、`baseUrl`、`model` 跟着文件里的 `provider` 走：用 `--provider` 临时切到别家时不会把这一家的密钥和地址带过去。

- `timeoutMs`：单次模型调用的硬性兜底上限毫秒数（默认 120000 即 2 分钟，正常不会触发），也可用环境变量 `MAGIC_OPEN_TIMEOUT_MS` 设置。
- `reasoningEffort`：恒思考模型（如 glm-5.x）的加速开关，`"low"` 可把思考压到最短（挑选场景实测 16s → 2s）。GLM 默认已开启；其他提供商模型不支持时自动忽略。

### 方式三：通用环境变量

```bash
export MAGIC_OPEN_PROVIDER=glm
export MAGIC_OPEN_API_KEY=xxx
export MAGIC_OPEN_MODEL=glm-4-flash      # 可选
export MAGIC_OPEN_BASE_URL=https://...   # 可选
```

### 提供商与默认模型

| provider | 服务 | 默认接口 | 默认模型 | 密钥环境变量 |
|---|---|---|---|---|
| `deepseek` | DeepSeek | api.deepseek.com | `deepseek-chat` | `DEEPSEEK_API_KEY` |
| `qwen` | 通义千问（百炼） | dashscope compatible-mode | `qwen-plus` | `DASHSCOPE_API_KEY` |
| `glm` | 智谱 GLM | open.bigmodel.cn | `glm-4-flash` | `GLM_API_KEY` / `ZHIPUAI_API_KEY` |
| `kimi` | Kimi（月之暗面） | api.moonshot.cn | `moonshot-v1-8k` | `MOONSHOT_API_KEY` |
| `doubao` | 豆包（火山方舟） | ark.cn-beijing.volces.com | 需填接入点 `ep-xxx` 或模型名 | `ARK_API_KEY` |
| `siliconflow` | 硅基流动 | api.siliconflow.cn | `Qwen/Qwen2.5-7B-Instruct` | `SILICONFLOW_API_KEY` |
| `openai` | OpenAI 及兼容接口 | api.openai.com | `gpt-4o-mini` | `OPENAI_API_KEY` |
| `anthropic` | Claude | api.anthropic.com | `claude-opus-5-5` | `ANTHROPIC_API_KEY` |
| `custom` | 任意 OpenAI 兼容接口（自己填地址和模型，可免密） | 必须自己填 | 必须自己填 | 无 |

临时切换：`magic-open "..." --provider glm --model glm-4-plus`

### 接入其他模型（任意 OpenAI 兼容接口）

公司内网网关、中转站、本地模型（Ollama、LM Studio 等）和 Gemini 的 OpenAI 兼容接口，都用 `custom`，需要给出接口地址（填到 `/v1` 为止）和模型名：

```bash
magic-open "上周写的周报" --provider custom --base-url https://网关地址/v1 --model 模型名 --api-key sk-xxx
magic-open "上周写的周报" --provider custom --base-url http://127.0.0.1:11434/v1 --model qwen3   # 本地模型，免密
```

也可以写进 `~/.magic-open.json`：`{ "provider": "custom", "baseUrl": "…", "model": "…", "apiKey": "…" }`。

`--api-key` 会留在 shell 历史里，临时换密钥更建议用环境变量 `MAGIC_OPEN_API_KEY`。

**不配置大模型也能用**：自动退化为本地关键词搜索 + 交互式选择（`magic-open --provider none "..."` 可强制）。

## 用法

```bash
magic-open "上周写的周报"                # Finder 打开匹配的文件夹
mag "上周写的周报"                       # 同上，mag 是 magic-open 的缩写
magic-open "我那个 react 练手项目" --vscode
magic-open "众筹相关的项目" --list      # 只看候选不打开
magic-open "报表" --pick                # 强制手动选
magic-open "周报" --yes                 # 跳过 3 选列表，直接打开 top1（脚本中使用）
magic-open "magic 项目" --dry-run       # 只看猜到哪个目录，不打开
magic-open "magic 项目" --cd            # 打开它，并把当前终端切到这个目录
magic-open ~/Documents/工作              # 直接给目录路径也行（文件会被拒绝）
```

## 切换终端目录（--cd）

`magic-open "描述" --cd` 在打开目录的同时，把当前终端切到选中的目录：交互选中、`--yes` 直接开 top1、沿用上次的选择、直接给路径，这几种方式都会切换。`--dry-run` 只展示不切换。

子进程改不了父 shell 的工作目录，所以 `--cd` 要经由一个与命令同名的 shell 函数运行。一次性安装（写进 `~/.zshrc` 永久生效）：

```bash
eval "$(magic-open --init zsh)"     # bash 用户换成 bash
```

装好后在当前终端立即生效，之后的用法与平时完全一样（`mag` 也经由同一个函数，所以 `mag --cd` 同样生效）：

```
$ mag "我那个 react 练手项目" --cd
📂 终端已切换到: ~/Projects/react-demo
✅ 已用 Finder 打开: ~/Projects/react-demo
~/Projects/react-demo $ _
```

没装函数直接用 `--cd` 也能跑：目录照常打开，并打印一条可以手动执行的 `cd` 命令。目前支持 zsh 和 bash。

## 选择记忆

当大模型选中、由你从 3 个候选选项里选出并打开、或由你手动列出选择时，这次选择会记到 `~/.magic-open.history.json`。
下次给出高度相似的描述时，先问你要不要沿用上次的选择——回车即开，跳过搜索和大模型调用；被选中过的目录也会在候选排序中加权（越选越顺手）：

```
$ magic-open "帮我打开我写的那个命令行工具项目"
⏮ 上次找「帮我打开我写的命令行工具项目」时你选择了: ~/Projects/magic-open（2 小时前）
直接用它吗？(回车/Y = 打开, n = 重新挑选):
```

- 相似度：描述文本的字符二元组 Dice 系数 ≥ 0.6，或当前描述直接点名了上次选中的文件/目录名
- 回答 n 则正常走完整流程；`--list` / `--pick` / `--dry-run` 不触发询问
- 最多保留 200 条；目标已删除的记录自动失效；不想留痕删掉该文件即可

## 工作原理

1. **多策略关键词**：大模型把中文描述转成 6~10 个搜索关键词，覆盖多种命名习惯——中文核心词（长词+短词）、英文对应（周报→weekly）、**拼音全拼**（众筹→zhongchou）、同义词/上下位词；
2. **多通道召回**（并行）：
   - Spotlight（`mdfind`）按名称搜索；
   - **文件命中 → 父目录**：描述说「周报/简历」时，目标常是装这些文件的文件夹——名称命中关键词的文件会把它所在的目录带进候选（「project.config.json」这类结构性文件名的命中不算线索）；
   - **常用位置直扫**：桌面与描述点名位置（桌面/下载等）向下 3 层的目录全部入池，Spotlight 未索引某些目录、名称搜索被截断、目录命名与关键词语言对不上时靠排序与大模型语义辨认兜底；扫描到的目录清单还会提供给补搜轮，让大模型能「按名指认」真实存在的目录；
   - 结果太少时自动内容搜索 + `find` 扫描常用目录兜底；
3. **时间线索**：描述里的「今天/昨天/上周/最近3天/上个月」被解析成具体日期区间，修改或创建时间吻合的候选加分，区间也会告知大模型；
4. **候选净化与排序**：只保留目录；同一项目根（.git / package.json / go.mod 等）与其内部子目录并存时只留项目根（子目录本身也是项目根的除外——monorepo 里的子项目/楼层与容器都保留），仓库内部子目录降权；`~/go/pkg/mod`、`node_modules`、`Library` 等噪音路径剔除；历史选中次数加权；
5. **大模型挑选**：候选连同内容概测、主要子目录名、检索来历（目录名含X / 内含文件X）、修改时间一起交给大模型选出最匹配项；置信度低或第一轮没搜到时，**换角度补搜一轮**（大模型看着已试关键词、现有候选和一份按最近修改排序的本机目录清单重新生成关键词，可直接指认真实目录名），仍不确定就转手动选择，不硬猜；
6. **猜测以 3 个选项呈现**：大模型选中的排第一（回车即开，和原来确认一次回车的速度一样），它的备选紧随其后、不足时按本地排序补足——数字键 2/3 直接选备选；都不对按 **Esc** 排除这 3 个，让大模型在剩余候选里继续找（连续两轮全否定则列出剩余候选直接选；非交互终端与 `--yes` 跳过列表直接开 top1）；
7. 用 `open` 以 Finder 打开目录（`--vscode` 则用 VSCode 打开）；置信度低时进入**光标式选择列表**——候选按匹配可能性从高到低排序，最多显示 5 项：↑/↓（或 j/k）移动光标、回车打开，数字键 1-5 直接快选，Esc 取消；第 6 行是输入行，直接输入更多汉字描述可缩小范围（先在候选内筛选，没有命中就带着补充描述重新搜索；唯一命中时直接选定）。

列表括号内是**目录内容简述**（≤10 字，概括这大概是个什么内容的目录/代码库）：先即时显示本地启发式摘要（package.json 描述 → 依赖识别的代码库类型如「React 前端项目」「Taro 小程序」「Go 项目」→ README 标题 → 文件类别计数如「图片×40」→「空目录」）；配置了大模型时，几秒后自动原地刷新为大模型根据目录内文件列表生成的总结（如「Node 命令行工具」「爬虫代码库」「设计素材」）。

## 开发

```bash
npm test          # node --test 运行 test/ 下的单元测试（不联网、不打开目录）
npm run eval      # 猜测效果评测台：输入描述 → 程序猜 → 你按 y/n 判卷 → 记录 case
npm run eval -- --stats   # 查看正确率统计与 bad case 清单
```

评测台把每道题记入 `eval/cases.json`（描述、猜测、你的判定、正确目标、关键词、top5 候选），bad case 用于回头修正排序与提示词，持续提高命中率。每条记录还带**代码指纹**（判卷时 `bin/magic-open.mjs` 的内容哈希）——多次评测虽然累积在同一个文件里，但 `--stats` 会按指纹分组统计，代码改动前后的结果自动分开算命中率，不会互相稀释。也支持管道自动喂题：`printf '描述\ny\nq\n' | npm run eval`。

只会搜索你的家目录且只匹配文件夹（自动排除 Library、node_modules、.git、*.app 应用包、~/go/pkg/mod 等噪音路径；直接给文件路径会被拒绝并提示）。

## 常见问题

- **找不到文件？** Spotlight 索引可能未覆盖（系统设置 → Siri 与聚焦 → 重新索引）；工具会自动用 `find` 兜底扫描 Desktop/Documents/Downloads 等目录。
- **`--vscode` 提示失败？** 确认已安装 Visual Studio Code；装了 `code` 命令会优先使用，否则走 `open -a "Visual Studio Code"`。
- **公司内网网关？** `--provider custom --base-url https://内网地址/v1 --model 模型名`，或写进 `~/.magic-open.json`。
- **想确认模型接没接通？** 跑 `magic-open "描述" --yes --dry-run`，出现 `⚠️` 就是没接通，原因见配置说明书的第 8 节。
- **想省 token？** 每次调用约消耗几百 token；用 `--provider none` 可完全离线（纯本地搜索）。
- **提示「magic-open 需要 Node.js >= 18」？** `magic-open` 用的是**当前终端**里的 `node`（`node -v` 可确认），和当初安装在哪个 Node 下无关。多半是该终端切过旧版本（nvm 默认别名不会被项目自动改），执行 `nvm use 22` 切回新版即可；不想切换就用新版 Node 的完整路径运行本文件。
