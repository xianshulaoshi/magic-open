# magic-open 配置说明书

本文说明 magic-open（缩写 `mag`）如何接入大模型：内置的 8 家怎么配，其他模型（公司内网网关、中转站、本地模型）怎么接，每个配置项的含义、优先级，以及出错时怎么排查。

不需要大模型也能用：`mag "描述" --provider none` 走本地关键词搜索加手动选择。

## 1. 三种配置方式

| 方式 | 适合场景 | 怎么写 |
|---|---|---|
| 命令行参数 | 临时试另一个模型或接口 | `mag "描述" --provider custom --base-url http://…/v1 --model m` |
| 环境变量 | 写在 `~/.zshrc` 里，一直生效 | `export DEEPSEEK_API_KEY=sk-xxx` |
| 配置文件 `~/.magic-open.json` | 一次写好，一直生效 | 见第 4 节 |

同一个配置项在多处都写了时，按第 5 节的优先级取值。

## 2. 最快上手

按你要用的模型，选一行照做（下文 `mag` 都可以换成 `magic-open`）。

| 你要用的模型 | 做法 |
|---|---|
| DeepSeek | `export DEEPSEEK_API_KEY=sk-xxx` |
| 通义千问 | `export DASHSCOPE_API_KEY=sk-xxx` |
| 智谱 GLM | `export GLM_API_KEY=xxx` |
| Kimi | `export MOONSHOT_API_KEY=sk-xxx` |
| 豆包 | `export ARK_API_KEY=xxx`，并在配置文件里写 `"model": "你的接入点或模型名"`（豆包没有默认模型） |
| 硅基流动 | `export SILICONFLOW_API_KEY=sk-xxx` |
| OpenAI | `export OPENAI_API_KEY=sk-xxx` |
| Claude | `export ANTHROPIC_API_KEY=sk-xxx` |
| 其他 OpenAI 兼容接口 | `mag "描述" --provider custom --base-url <地址> --model <模型名> --api-key <key>` |
| 本地模型（Ollama 等，免密） | `mag "描述" --provider custom --base-url http://127.0.0.1:11434/v1 --model <模型名>` |

想确认接没接通，用下面这条命令。它会把模型完整调用一遍，但只显示猜到的目录，不真正打开：

```bash
mag "随便描述一个你电脑上有的文件夹" --yes --dry-run
```

- 输出里出现 `💡`（模型给出的选择理由）和 `🎯 [dry-run] 猜到的目标`，没有 `⚠️`：接通了。
- 出现 `⚠️` 开头的行：没接通，原因见第 8 节。

本说明书里的示例在 magic-open 上实测过的部分：内置规则、`custom` 接任意 OpenAI 兼容接口、免密、各类报错文字。各服务商的地址和模型名来自它们的公开文档，Ollama 等本地服务和 Gemini 没有逐一实测。

## 3. 内置提供商

| provider | 服务 | 默认接口地址 | 默认模型 | 密钥环境变量 |
|---|---|---|---|---|
| `deepseek` | DeepSeek | `https://api.deepseek.com` | `deepseek-chat` | `DEEPSEEK_API_KEY` |
| `qwen` | 通义千问（百炼） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` | `DASHSCOPE_API_KEY` |
| `glm` | 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` | `GLM_API_KEY` 或 `ZHIPUAI_API_KEY` |
| `kimi` | Kimi（月之暗面） | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` | `MOONSHOT_API_KEY` |
| `doubao` | 豆包（火山方舟） | `https://ark.cn-beijing.volces.com/api/v3` | 无，必须自己填 | `ARK_API_KEY` |
| `siliconflow` | 硅基流动 | `https://api.siliconflow.cn/v1` | `Qwen/Qwen2.5-7B-Instruct` | `SILICONFLOW_API_KEY` |
| `openai` | OpenAI 及兼容接口 | `https://api.openai.com/v1` | `gpt-4o-mini` | `OPENAI_API_KEY` |
| `anthropic` | Claude | `https://api.anthropic.com` | `claude-opus-5-5` | `ANTHROPIC_API_KEY` |
| `custom` | 任意 OpenAI 兼容接口 | 无，必须自己填 | 无，必须自己填 | 无，可不填 |

### 没指定 provider 时用哪家

按下面的顺序找，找到第一个就停：

1. `--provider` 参数，或环境变量 `MAGIC_OPEN_PROVIDER`，或配置文件里的 `provider`。
2. 设了 `OPENAI_API_KEY` 就用 `openai`。
3. 设了 `ANTHROPIC_API_KEY` 就用 `anthropic`。
4. 按上表从上到下扫描各家专属环境变量，第一个有值的那家。
5. 都没有：不使用大模型，走本地搜索。

`custom` 没有专属环境变量，不会被自动选中，必须显式指定。

## 4. 配置文件 `~/.magic-open.json`

```json
{
  "provider": "custom",
  "baseUrl": "http://10.0.0.8:8000/v1",
  "model": "qwen3-32b",
  "apiKey": "sk-xxx",
  "timeoutMs": 120000,
  "reasoningEffort": "low"
}
```

所有字段都可以省略，省略的按第 5 节的规则从别处取。

| 字段 | 含义 | 默认 |
|---|---|---|
| `provider` | 用哪家，取值见第 3 节 | 不写则按上面的顺序自动找 |
| `baseUrl` | 接口地址。OpenAI 兼容接口填到 `/v1` 为止；`anthropic` 填到域名即可 | 各家默认地址 |
| `model` | 模型名 | 各家默认模型；`doubao` 和 `custom` 必须填 |
| `apiKey` | 密钥。`custom` 可以不填（免密接口） | 取环境变量 |
| `timeoutMs` | 单次模型调用的最长等待时间（毫秒），小于 1000 的值按默认处理 | `120000`（2 分钟） |
| `reasoningEffort` | 推理模型的思考强度，原样作为 OpenAI 兼容接口的 `reasoning_effort` 字段发出；填 `"low"` 能把「一直思考」的模型明显提速。对 `anthropic` 风格不生效 | `glm` 默认 `low`，其他不发送 |

`reasoningEffort` 只能在配置文件里设置。个别网关不认这个字段，magic-open 会自动去掉它重试一次。

### 配置文件里的配置属于哪家

`apiKey`、`baseUrl`、`model`、`reasoningEffort` 跟着文件里的 `provider` 走。

- 文件里写的是 `"provider": "glm"`，你用 `--provider deepseek` 临时切到 DeepSeek：文件里 GLM 的 key、地址、模型都不会被带上，DeepSeek 用它自己的默认地址、默认模型和 `DEEPSEEK_API_KEY`。
- 文件里没写 `provider`：这些字段对任何提供商都生效，视为通用配置。

这样设计是为了不把一家的密钥发给另一家的服务器。

`timeoutMs` 不跟提供商走，对任何一家都生效。

## 5. 优先级

从高到低，前一项有值就不看后面的。

| 配置项 | 1 | 2 | 3 | 4 |
|---|---|---|---|---|
| 用哪家 | `--provider` | `MAGIC_OPEN_PROVIDER` | 文件的 `provider` | 自动查找（第 3 节） |
| 密钥 | `--api-key` | `MAGIC_OPEN_API_KEY` | 文件的 `apiKey`（须与本次提供商一致） | 该家的专属环境变量 |
| 接口地址 | `--base-url` | `MAGIC_OPEN_BASE_URL` | 文件的 `baseUrl`（须一致） | 该家默认地址 |
| 模型 | `--model` | `MAGIC_OPEN_MODEL` | 文件的 `model`（须一致） | 该家默认模型 |
| 超时 | — | `MAGIC_OPEN_TIMEOUT_MS` | 文件的 `timeoutMs` | 120000 |

「须一致」指配置文件里的 `provider` 与本次使用的提供商相同，或者文件里没写 `provider`。

密钥还有两条补充规则：

- 除 `openai` 和 `custom` 外，如果该家的专属环境变量没设，会退而使用 `OPENAI_API_KEY`。
- `custom` 只认 `--api-key`、`MAGIC_OPEN_API_KEY` 和配置文件里的 `apiKey`，三者都没有就按免密处理。

## 6. 接入其他模型

### 任意 OpenAI 兼容接口：`custom`

适用于公司内网网关、各种中转站，以及提供 OpenAI 兼容接口的服务。需要两样东西：接口地址和模型名。

临时用一次：

```bash
mag "上周写的周报" --provider custom --base-url https://网关地址/v1 --model 模型名 --api-key sk-xxx
```

长期使用，写进 `~/.magic-open.json`（见第 4 节的示例）。

接口地址的规则：magic-open 实际请求的是「接口地址 + `/chat/completions`」。所以地址一般填到 `/v1` 为止，例如 `http://10.0.0.8:8000/v1`。

### 本地模型：免密

Ollama、LM Studio、vLLM 这类本地服务通常不需要密钥，`custom` 不填密钥即可：

```bash
mag "上周写的周报" --provider custom --base-url http://127.0.0.1:11434/v1 --model qwen3
```

上面的地址和模型名是 Ollama 的格式，其他服务按它们各自的文档填写。模型名照本地服务要求的名字填。

内置的 8 家仍然必须提供密钥，不提供会直接报错，不会发起请求。

### Gemini

Gemini 提供 OpenAI 兼容接口，用 `custom` 接：

```bash
mag "上周写的周报" --provider custom --base-url https://generativelanguage.googleapis.com/v1beta/openai --model <Gemini 文档里的模型名> --api-key 你的key
```

### Anthropic 兼容接口

用 `--provider anthropic` 加 `--base-url`。这里的地址填到域名即可，不带 `/v1`，因为 magic-open 会自己拼上 `/v1/messages`。

注意：这类请求会固定带上 Anthropic 的版本标识和一个 beta 请求头，非 Anthropic 官方的兼容网关可能不认。这条路没有实测过。

### 目前提供商列表以外的服务

Azure OpenAI 需要另一种认证请求头和地址格式，目前接不了。Bedrock、Vertex AI 这类需要经由网关转成 OpenAI 兼容接口。

## 7. 密钥安全

- **`--api-key` 会留在 shell 历史里。** 临时换密钥时，更建议用环境变量：`MAGIC_OPEN_API_KEY=sk-xxx mag "描述"`。
- **配置文件建议只让自己可读**：`chmod 600 ~/.magic-open.json`。
- **密钥只会发给接口地址所在的服务器。** 用 `custom` 时请确认 `baseUrl` 是你信任的地址。
- **仓库和安装包里不含任何密钥**，密钥只存在你本机的环境变量或配置文件里。

## 8. 出错了怎么看

分两类。

### 启动时直接报错退出

提示文字以 `❌` 开头，按提示补配置即可。

| 提示 | 原因与处理 |
|---|---|
| `已选择提供商「x」但没有找到 API Key` | 缺密钥。提示里会点名该设哪个环境变量，或写进配置文件 |
| `未知提供商: x` | `--provider` 写错了。提示里列出了内置的名称；其他接口用 `custom` |
| `提供商「custom」需要指定接口地址` | 没给 `--base-url`，或配置文件里没有 `baseUrl` |
| `接口地址无效` | 地址不是以 `http://` 或 `https://` 开头 |
| `提供商 custom 需要指定模型名` | 没给 `--model`。本地模型可以填服务端要求的名字，或随意填一个 |
| `配置文件 … 不是合法 JSON，已忽略` | 配置文件语法有误，被当作不存在。按提示的行列检查逗号和引号 |

### 没报错，但提示「改用本地关键词」

模型调用失败时 magic-open 不会中断，而是打印一行 `⚠️ 生成搜索关键词失败（原因），改用本地关键词`，然后继续用本地搜索。括号里的原因说明了失败在哪一步。

| 括号里的原因 | 原因与处理 |
|---|---|
| `HTTP 401: …` 或 `HTTP 403: …` | 密钥不对，或者发错了密钥。见下方「怀疑发错了密钥」 |
| `HTTP 404: …` | 地址不对。检查 `baseUrl` 是否填到 `/v1` 为止，以及是否填错了 `provider` 导致套用了别家的默认地址 |
| `HTTP 400: …` | 多半是模型名不对，或网关不认某个字段。看返回的文字 |
| `模型 Ns 内未响应，已中断` | 超时。调大 `timeoutMs`；如果模型会长时间思考，试试在配置文件里写 `"reasoningEffort": "low"` |
| `无法解析模型输出: …` | 模型没有按要求输出 JSON。常见于参数很小的模型，换一个对话模型 |
| `模型返回为空` | 模型返回了空内容。检查模型名，或该服务是否要求特殊参数 |
| `fetch failed` | 连不上服务器。检查网络、VPN，以及地址和端口 |
| `提供商「x」需要指定模型名` | `doubao` 没有默认模型，需要在配置文件里写 `model` |

### 怀疑发错了密钥

典型情况是配置文件里存着 A 家的密钥，却临时用 `--provider` 切到了 B 家。按第 4 节的规则，切换时不会带上文件里 A 家的密钥，B 家改用它自己的环境变量；环境变量也没设时会直接报「没有找到 API Key」，不会发请求。

遇到 401 时，按这个顺序查：

1. 这次用的是哪家：对照第 3 节「没指定 provider 时用哪家」。
2. 密钥取自哪里：对照第 5 节密钥那一行，从左到右找到第一个有值的来源。
3. 请求发到了哪个地址：同样按第 5 节接口地址那一行。

magic-open 目前不会显示本次实际生效的配置，只能这样手动核对。

## 9. 不使用大模型

```bash
mag "描述" --provider none                         # 本次不用
MAGIC_OPEN_PROVIDER=none mag "描述"                # 通过环境变量
```

不配置任何提供商时也会自动走这条路。完全离线，按本地关键词搜索加手动选择，不消耗 token。
