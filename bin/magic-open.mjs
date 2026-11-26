#!/usr/bin/env node
/**
 * magic-open — 一句中文描述，自动找到文件夹并打开（仅支持文件夹）
 *
 *   magic-open "上周写的周报"               # 用 Finder 打开匹配的文件夹
 *   magic-open "react 练手项目" --vscode    # 用 VSCode 打开该文件夹
 *   magic-open "react 练手项目" --cd        # 打开该文件夹，并把当前终端切到这个目录（需 shell 函数，见 --init）
 *   mag "上周写的周报"                    # mag 是 magic-open 的缩写，参数完全相同
 *
 * 依赖: macOS + Node.js >= 18（零 npm 依赖）
 * 大模型: ~/.magic-open.json 或环境变量配置，支持 DeepSeek/通义/GLM/Kimi/豆包/
 *        SiliconFlow/OpenAI 兼容接口/Anthropic。未配置时退化为本地关键词搜索。
 */

import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emitKeypressEvents } from "node:readline";
import { pathToFileURL } from "node:url";

// ---------- Node 版本检查（必须是 import 之后的第一段逻辑）----------
// 注意：本文件不能静态 import Node 18 才有的模块（如 node:readline/promises），否则旧版 Node
// 会在执行到这里之前就抛出难以理解的内部错误。需要新模块时在函数内 await import(...)。
if (Number(process.versions.node.split(".")[0]) < 18) {
  console.error([
    `❌ magic-open 需要 Node.js >= 18，当前为 ${process.version}（${process.execPath}）`,
    "",
    "请切换到新版 Node 后重试：",
    nodeUpgradeHint(),
  ].join("\n"));
  process.exit(1);
}

// 给出本机可用的升级/切换方式（nvm 用户优先提示切换到已安装的新版本）
function nodeUpgradeHint() {
  const generic = "  brew install node@22   # 或从 https://nodejs.org 安装后重开终端";
  try {
    const root = path.join(process.env.NVM_DIR || path.join(os.homedir(), ".nvm"), "versions", "node");
    if (!fs.existsSync(root)) return generic;
    const majors = fs.readdirSync(root)
      .filter((v) => /^v\d+\./.test(v))
      .map((v) => Number(v.slice(1).split(".")[0]))
      .filter((v) => v >= 18);
    return majors.length
      ? `  nvm use ${Math.max(...majors)}   # 本机已安装的可用版本（nvm ls 可查看全部）`
      : "  nvm install 22   # 本机 nvm 里还没有 >= 18 的版本";
  } catch {
    return generic;
  }
}

const VERSION = "0.3.0";
const HOME = os.homedir();
const CONFIG_PATH = path.join(HOME, ".magic-open.json");
const MAX_CANDIDATES = 20; // 送进大模型挑选/交互列表的候选上限：提示词更短，挑选更快更稳
const HISTORY_PATH = path.join(HOME, ".magic-open.history.json");
const HISTORY_LIMIT = 200;
const SIM_THRESHOLD = 0.6;

// 单次运行内的共享状态（由 main 初始化）
let activeWin = null; // 当前查询解析出的时间窗口（「上周写的」→ 具体日期区间）
let HIST_COUNT = new Map(); // 路径 → 历史被用户选中的次数
let DRY_RUN = false; // --dry-run：只展示猜到的目标，不真正打开、不写历史

// ---------- 时间线索解析 ----------
const DAY_MS = 86400000;
function cnNum(x) {
  if (/^\d+$/.test(x)) return parseInt(x, 10);
  return { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }[x] ?? NaN;
}
function startOfDay(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d; }
function addDays(t, n) { const d = new Date(t); d.setDate(d.getDate() + n); return d; }
function mondayOf(t) { const d = startOfDay(t); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; }
function fmtDate(ms) { const d = new Date(ms); const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
// 把描述里的相对时间词解析为具体日期区间；识别不到返回 null
function parseTimeWindow(q) {
  const s = String(q);
  const now = Date.now();
  const mk = (label, from, to) => ({ label, from: from.getTime(), to: Math.max(from.getTime() + 3600000, Math.min(now, to.getTime())) });
  let m;
  if ((m = s.match(/([0-9一二两三四五六七八九十]+)\s*天前/)) || (m = s.match(/(?:最近|近|前)([0-9一二两三四五六七八九十]+)\s*(?:天|日)/))) {
    const n = cnNum(m[1]); if (n) return mk(m[0], addDays(startOfDay(now), -n), new Date(now));
  }
  if ((m = s.match(/(?:最近|近)([0-9一二两三四五六七八九十]+)\s*个?(?:周|星期)/))) {
    const n = cnNum(m[1]); if (n) return mk(m[0], addDays(startOfDay(now), -7 * n), new Date(now));
  }
  if ((m = s.match(/(?:最近|近)([0-9一二两三四五六七八九十]+)\s*个?月/))) {
    const n = cnNum(m[1]); if (n) return mk(m[0], addDays(startOfDay(now), -30 * n), new Date(now));
  }
  if (/今天|今早|今晚|刚刚/.test(s)) return mk("今天", startOfDay(now), new Date(now));
  if (/昨天/.test(s)) return mk("昨天", addDays(startOfDay(now), -1), startOfDay(now));
  if (/前天/.test(s)) return mk("前天", addDays(startOfDay(now), -2), addDays(startOfDay(now), -1));
  if (/上上周/.test(s)) { const mon = mondayOf(addDays(mondayOf(now), -7)); return mk("上上周", mon, addDays(mon, 8)); }
  if (/上周|上星期|上一周/.test(s)) { const mon = mondayOf(addDays(mondayOf(now), -7)); return mk("上周", mon, addDays(mon, 8)); }
  if (/本周|这周|这一周|这星期/.test(s)) { const mon = mondayOf(now); return mk("本周", mon, addDays(mon, 8)); }
  if (/上个月|上月/.test(s)) { const d = new Date(); return mk("上个月", new Date(d.getFullYear(), d.getMonth() - 1, 1), new Date(d.getFullYear(), d.getMonth(), 0, 23, 59, 59)); }
  if (/这个月|本月/.test(s)) { const d = new Date(); return mk("本月", new Date(d.getFullYear(), d.getMonth(), 1), new Date(now)); }
  if (/今年/.test(s)) { const d = new Date(); return mk("今年", new Date(d.getFullYear(), 0, 1), new Date(now)); }
  if (/最近|近期|这阵子|前阵子/.test(s)) return mk("最近", addDays(startOfDay(now), -14), new Date(now));
  return null;
}

// ---------- 输出工具 ----------
const info = (msg) => console.log(msg);
const warn = (msg) => console.error(`⚠️  ${msg}`);
const err = (msg) => console.error(`❌ ${msg}`);

// ---------- 大模型提供商预设 ----------
// style: "openai" = OpenAI 兼容 /chat/completions；"anthropic" = /v1/messages
const PROVIDERS = {
  deepseek:     { label: "DeepSeek（深度求索）", baseUrl: "https://api.deepseek.com", model: "deepseek-chat", style: "openai", keyEnv: "DEEPSEEK_API_KEY" },
  qwen:         { label: "通义千问（阿里云百炼）", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", style: "openai", keyEnv: "DASHSCOPE_API_KEY" },
  glm:          { label: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash", style: "openai", keyEnv: ["GLM_API_KEY", "ZHIPUAI_API_KEY"], reasoningEffort: "low" },
  kimi:         { label: "Kimi（月之暗面）", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k", style: "openai", keyEnv: "MOONSHOT_API_KEY" },
  doubao:       { label: "豆包（火山方舟，model 填接入点 ep-xxx 或模型名）", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", model: "", style: "openai", keyEnv: "ARK_API_KEY" },
  siliconflow:  { label: "SiliconFlow 硅基流动", baseUrl: "https://api.siliconflow.cn/v1", model: "Qwen/Qwen2.5-7B-Instruct", style: "openai", keyEnv: "SILICONFLOW_API_KEY" },
  openai:       { label: "OpenAI 及任意兼容接口", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", style: "openai", keyEnv: "OPENAI_API_KEY" },
  anthropic:    { label: "Anthropic Claude", baseUrl: "https://api.anthropic.com", model: "claude-opus-5-5", style: "anthropic", keyEnv: "ANTHROPIC_API_KEY" },
  // 任意 OpenAI 兼容接口（公司内网网关、中转站、Ollama / LM Studio 等本地模型）：baseUrl / model 自己填，可以不带 key
  custom:       { label: "任意 OpenAI 兼容接口（自填 baseUrl / model，可免密）", baseUrl: "", model: "", style: "openai", optionalKey: true },
};

// ---------- CLI 参数 ----------
function usage() {
  const providerRows = Object.entries(PROVIDERS)
    .map(([k, v]) => `    ${k.padEnd(12)} ${v.label}`)
    .join("\n");
  return `magic-open v${VERSION} — 一句中文描述，自动找到文件夹并打开（仅支持文件夹）

用法:
  magic-open "描述"               找到匹配的文件夹，用 Finder 打开
  magic-open "描述" --vscode      用 VSCode 打开该文件夹
  mag "描述"                      同上（mag 是 magic-open 的缩写，参数完全相同）
  magic-open "描述" --cd          打开该文件夹，并把当前终端切到这个目录（需 shell 函数，见下方）

选项:
  -c, --vscode            用 VSCode 打开
      --cd                选中目录后，把当前终端也切到该目录（Finder 照常打开；需 shell 函数）
  -l, --list              只列出候选，不打开
  -p, --pick              强制手动选择
  -y, --yes               跳过 3 选列表，直接打开猜到的 top1（脚本/管道中使用）
      --dry-run           只展示猜到的目标，不真正打开（测试猜测效果用）
      --provider <name>   本次调用使用的大模型提供商（见下表）
      --model <name>      覆盖模型名
      --base-url <url>    覆盖接口地址（OpenAI 兼容网关填到 /v1 为止）
      --api-key <key>     本次调用使用的 API Key（会留在 shell 历史里，日常建议用环境变量或配置文件）
      --init <shell>      输出 shell 函数源码（zsh / bash，含 mag 缩写），供 eval "$(…)" 加载；--cd 依赖它
  -h, --help              帮助
  -v, --version           版本

示例:
  magic-open "上周写的周报"
  magic-open "我那个 react 练手项目" --vscode
  magic-open "众筹相关的项目" --list
  magic-open "magic 项目" --cd
  magic-open ~/Documents/工作
  magic-open "报表" --provider deepseek
  magic-open "报表" --provider custom --base-url http://127.0.0.1:11434/v1 --model qwen3   # 任意 OpenAI 兼容接口

支持的提供商（--provider / ~/.magic-open.json / MAGIC_OPEN_PROVIDER）:
${providerRows}

密钥配置（任选）:
  1. 环境变量: 各提供商专属变量（如 DEEPSEEK_API_KEY、DASHSCOPE_API_KEY、GLM_API_KEY、
     MOONSHOT_API_KEY、ARK_API_KEY、OPENAI_API_KEY、ANTHROPIC_API_KEY）
  2. 通用变量: MAGIC_OPEN_API_KEY（+ MAGIC_OPEN_PROVIDER / MAGIC_OPEN_MODEL / MAGIC_OPEN_BASE_URL）
  3. 配置文件: ~/.magic-open.json  { "provider": "deepseek", "apiKey": "sk-xxx" }
优先级: --api-key > MAGIC_OPEN_API_KEY > 配置文件的 apiKey（仅当它与本次使用的提供商一致）> 各家专属变量
详细配置说明见仓库里的 docs/configuration.md（配置说明书）。
未配置大模型时，自动退化为本地关键词搜索 + 手动选择。

切换终端目录（--cd）:
  子进程改不了父 shell 的 cwd，所以 --cd 要经由一个同名 shell 函数运行。一次性安装（写进 ~/.zshrc 永久生效）:
    eval "$(magic-open --init zsh)"     # bash 用户换成 bash
  装好后 magic-open "描述" --cd（或 mag "描述" --cd）在打开目录的同时，把当前终端切到选中的目录。`;
}

function parseArgs(argv) {
  const o = { vscode: false, cd: false, list: false, pick: false, yes: false, dryRun: false, help: false, version: false, provider: null, model: null, baseUrl: null, apiKey: null, init: null, unknown: null, words: [] };
  const valueFlags = new Set(["--provider", "--model", "--base-url", "--api-key", "--init"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (valueFlags.has(a)) {
      const v = argv[i + 1];
      if (!v) { o.unknown = a; break; }
      if (a === "--provider") o.provider = v;
      else if (a === "--model") o.model = v;
      else if (a === "--init") o.init = v;
      else if (a === "--api-key") o.apiKey = v;
      else o.baseUrl = v;
      i++;
      continue;
    }
    if (a === "--") { o.words.push(...argv.slice(i + 1)); break; }
    else if (a === "--vscode" || a === "-c") o.vscode = true;
    else if (a === "--yes" || a === "-y") o.yes = true;
    else if (a === "--list" || a === "-l") o.list = true;
    else if (a === "--pick" || a === "-p") o.pick = true;
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--cd") o.cd = true;
    else if (a === "--help" || a === "-h") o.help = true;
    else if (a === "--version" || a === "-v" || a === "-V") o.version = true;
    else if (a.startsWith("-") && a.length > 1) o.unknown = a;
    else o.words.push(a);
  }
  o.query = o.words.join(" ").trim();
  return o;
}

// ---------- 大模型配置解析 ----------
function firstEnv(v, env = process.env) {
  if (!v) return undefined;
  for (const name of Array.isArray(v) ? v : [v]) {
    if (env[name]) return env[name];
  }
  return undefined;
}

// 读取 ~/.magic-open.json；不存在或不是 JSON 对象时视为空配置
function readConfigFile() {
  try {
    const j = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    if (j && typeof j === "object" && !Array.isArray(j)) return j;
  } catch (e) {
    if (e.code !== "ENOENT") warn(`配置文件 ${displayPath(CONFIG_PATH)} 不是合法 JSON，已忽略（${e.message}）`);
  }
  return {};
}

// cli: 命令行参数；file / env 可注入，供测试使用（默认读 ~/.magic-open.json 和 process.env）
function loadConfig(cli, { file = readConfigFile(), env = process.env } = {}) {
  const providerName =
    cli.provider || env.MAGIC_OPEN_PROVIDER || file.provider ||
    (env.OPENAI_API_KEY ? "openai" : undefined) ||
    (env.ANTHROPIC_API_KEY ? "anthropic" : undefined);

  // 找一个有密钥的提供商：显式指定的优先，否则扫描各家专属环境变量（custom 没有专属变量，不参与自动识别）
  let name = providerName;
  if (!name) {
    for (const [k, v] of Object.entries(PROVIDERS)) {
      if (v.optionalKey) continue;
      if (firstEnv(v.keyEnv, env)) { name = k; break; }
    }
  }
  if (!name) return null;

  const preset = PROVIDERS[name];
  if (!preset) {
    err(`未知提供商: ${name}（内置: ${Object.keys(PROVIDERS).filter((k) => !PROVIDERS[k].optionalKey).join(" / ")} / custom）`);
    info("其他 OpenAI 兼容接口用: --provider custom --base-url <http://…/v1> --model <模型名>");
    process.exit(1);
  }

  // 配置文件里的 apiKey / baseUrl / model / reasoningEffort 属于文件里写的那个提供商：
  // 用 --provider 临时切到别家时不能带上，否则会把 A 家的 key 发给 B 家、把 A 家的模型名发给 B 家。
  // 文件里没写 provider 时，这些字段视为通用配置，对任何提供商都生效。
  const fileIsSame = !file.provider || file.provider === name;

  const apiKey =
    cli.apiKey || env.MAGIC_OPEN_API_KEY || (fileIsSame ? file.apiKey : undefined) ||
    firstEnv(preset.keyEnv, env) ||
    (name !== "openai" && name !== "custom" ? env.OPENAI_API_KEY : undefined); // custom 不复用 OpenAI 的 key

  if (!apiKey && !preset.optionalKey) {
    err(`已选择提供商「${name}」但没有找到 API Key。`);
    const keyEnv = preset.keyEnv ? (Array.isArray(preset.keyEnv) ? preset.keyEnv.join(" 或 ") : preset.keyEnv) : null;
    if (keyEnv) info(`请设置 ${keyEnv}，或写入 ~/.magic-open.json：`);
    else info("请写入 ~/.magic-open.json：");
    info(`  { "provider": "${name}", "apiKey": "sk-xxx" }`);
    info(`也可以暂时不配置大模型：MAGIC_OPEN_PROVIDER=none magic-open "描述" 走本地搜索。`);
    process.exit(1);
  }

  const rawBaseUrl = String(cli.baseUrl || env.MAGIC_OPEN_BASE_URL || (fileIsSame ? file.baseUrl : undefined) || preset.baseUrl || "").trim();
  const baseUrl = rawBaseUrl.replace(/\/+$/, "");
  if (!baseUrl) {
    err(`提供商「${name}」需要指定接口地址: --base-url <http://…/v1>（或 ~/.magic-open.json 的 "baseUrl"，填到 /v1 为止）`);
    process.exit(1);
  }
  if (!/^https?:\/\/\S+$/.test(baseUrl)) {
    err(`接口地址无效: "${rawBaseUrl}"（需要以 http:// 或 https:// 开头）`);
    process.exit(1);
  }

  const model = cli.model || env.MAGIC_OPEN_MODEL || (fileIsSame ? file.model : undefined) || preset.model;
  if (!model && name === "custom") {
    err('提供商 custom 需要指定模型名: --model <模型名>（本地模型可填服务端要求的名字，或随意填一个如 local）');
    process.exit(1);
  }

  const t = Number(env.MAGIC_OPEN_TIMEOUT_MS ?? file.timeoutMs ?? 120000);
  return {
    provider: name,
    style: preset.style,
    baseUrl,
    model,
    apiKey, // custom 可以没有 key：请求时不带 authorization 头
    // glm-5.x 等模型「始终思考、不可关闭」，但 reasoning_effort=low 可把思考压到最短
    // （实测挑选场景 16s → 2s，答案质量不变）；可被配置文件的 reasoningEffort 覆盖
    reasoningEffort: (fileIsSame ? file.reasoningEffort : undefined) || preset.reasoningEffort || null,
    // 单次模型调用的硬性兜底上限（默认 2 分钟，一般不会触发；不等同于期望响应时间）
    timeoutMs: Number.isFinite(t) && t >= 1000 ? t : 120000,
  };
}

// ---------- 大模型调用 ----------
const KW_SYSTEM = `你是 macOS 文件搜索助手。用户给出对目标「文件夹/目录」的中文描述，你要生成用于 Spotlight(mdfind) 按名称子串匹配的搜索关键词。
目录命名习惯多样，请覆盖多种可能的写法：
1. 中文核心词：给完整词，也给更短的核心词（如「命令行工具」→「命令行」「工具」）；
2. 英文对应词：开发者目录常用英文命名，给单词形式（如 周报→weekly、report；项目→project、demo、repo）；
3. 拼音全拼连写：如 周报→zhoubao、简历→jianli；
4. 同义词/上下位词：设计稿→design、sketch、figma；笔记→notes；
5. 若随附「本机目录清单」，其中与描述语义相符的目录，把目录名原样（完整名字）放进 keywords——这是最直接的命中方式。
要求：
- 去掉「打开/找/我的/那个/一下」这类动词、语气词和日期表述（如「上周」）；
- 关键词要适合做目录名/路径的子串匹配；目标是文件夹，不要给文件扩展名类关键词（如 package.json、xlsx、png）；
- 总数 6~10 个，按命中可能性从高到低。
只输出 JSON，格式：{"keywords":["周报","weekly","report","zhoubao"]}`;

const SEL_SYSTEM = `你是 macOS 文件夹匹配助手。用户给出对目标文件夹的中文描述，你要从候选目录列表里选出最符合的一项。
每行候选格式：序号. [目录] 路径 — 内容: <目录内容概测> — 子目录: <主要子目录名> — 匹配: <它为何出现在候选里> — 修改于 <相对时间>
判断要点：
1. 目录名/路径/子目录/内容概测与描述的语义相关性（中文、英文、拼音均算相关）；
2. 「匹配」字段是客观检索线索：「目录名含X」= 名称命中关键词；「内含文件X」= 该目录下有名称命中关键词的文件——当描述像在说某个文档（周报/简历/合同）时，装着它的目录往往是目标；
3. 若提供了时间线索行，目录修改时间（有时是创建时间）应与该日期区间吻合；
4. 描述说「项目/工程/仓库」时，优先选独立的代码项目根目录（含 package.json、.git 的那一层），而不是它的内部子目录或上级容器目录；
5. 两个候选的目录名互为前后缀（如 x_coupon 与 x_coupon_tab_content）时：描述明确提到附加含义（tab、内容、列表等）才选带后缀的，否则选基础版；
6. 两个候选的目录名都与描述语义对应，但一个是代码项目根目录、另一个是图片/素材文件夹：描述没提「图片/素材/壁纸」类词时优先代码项目根；
7. 都不合适就返回 null，不要硬猜。
只输出 JSON：{"choice": <最匹配的序号，整数；都不合适则为 null>, "confidence": <0~1 的置信度>, "reason": "<不超过30字的中文理由>", "alternatives": [<其他可能候选的序号，最多3个>]}`;

const KW_RETRY_SYSTEM = `你是 macOS 文件搜索助手。用户在找一个文件夹，但之前的关键词没有命中理想结果。请根据用户描述、已试过的关键词和现有候选（可能都不对），从全新角度再生成一批用于 Spotlight 按名称子串搜索的关键词：
- 换同义词、上下位词、相关业务词；
- 英文单词命名（如 weekly、invoice、crawler）与拼音全拼连写（如 zhoubao）；
- 直接猜测具体的目录名写法（kebab-case 或无分隔连写，如 magic-open、zhoubao2024）；
- 随附的「本机目录清单」是磁盘上真实存在的目录：语义相符的就把它原样（完整目录名）放进 keywords，这是最直接的命中方式；
- 不要与已试关键词重复；总数 5~8 个。
只输出 JSON：{"keywords":["..."]}`;

async function llmText(cfg, system, user, maxTokens = 500) {
  if (typeof fetch === "undefined") throw new Error("当前 Node 没有 fetch，请升级到 Node.js >= 18");
  if (!cfg.model) throw new Error(`提供商「${cfg.provider}」需要指定模型名（--model 或 ~/.magic-open.json 的 "model"）`);

  const controller = new AbortController();
  const timeoutMs = cfg.timeoutMs ?? 120000; // 硬性兜底（默认 2 分钟），正常不该触发；提速靠 reasoning_effort=low
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let url, headers, body;
    if (cfg.style === "anthropic") {
      url = cfg.baseUrl + "/v1/messages";
      headers = {
        "content-type": "application/json",
        "x-api-key": cfg.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "server-side-fallback-2026-07-01",
      };
      body = {
        model: cfg.model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
        fallbacks: "default",
      };
    } else {
      url = cfg.baseUrl + "/chat/completions";
      headers = { "content-type": "application/json" };
      if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`; // 免密接口（如本地模型）不带
      body = {
        model: cfg.model,
        temperature: 0,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      };
      if (cfg.reasoningEffort) body.reasoning_effort = cfg.reasoningEffort; // 恒思考模型的加速开关
    }

    let res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
    if (!res.ok && body.reasoning_effort) {
      // 个别网关不认识 reasoning_effort 字段：去掉后原样重试一次
      delete body.reasoning_effort;
      res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
    const data = await res.json();

    let text;
    if (cfg.style === "anthropic") {
      if (data.stop_reason === "refusal") throw new Error("模型拒绝了该请求");
      text = (data.content ?? []).map((b) => b.text ?? "").join("");
    } else {
      text = data.choices?.[0]?.message?.content ?? "";
      if (!text && typeof data.choices?.[0]?.message?.reasoning_content === "string") text = data.choices[0].message.reasoning_content;
    }
    return text;
  } catch (e) {
    if (e?.name === "AbortError") {
      // 超时中断：保留 AbortError 名字，让上层知道这不是可重试的解析错误
      throw Object.assign(new Error(`模型 ${timeoutMs / 1000}s 内未响应，已中断`), { name: "AbortError" });
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function llmJSON(cfg, system, user, maxTokens) {
  return extractJSON(await llmText(cfg, system, user, maxTokens));
}

// 带一次重试的 JSON 调用：
// - 超时 → 立即放弃（服务慢时重试大概率也超时，不浪费时间）
// - 输出不是合法 JSON → 附提醒 + 加倍 max_tokens 重试一次（推理截断的典型解法），仍失败则抛出
async function llmJSONRetry(cfg, system, user, maxTokens) {
  try {
    return await llmJSON(cfg, system, user, maxTokens);
  } catch (e1) {
    if (e1?.name === "AbortError") throw e1;
    const reminder = `\n\n（注意：上一次输出【${String(e1.message).slice(0, 80)}】不是合法 JSON。请严格只输出一行 JSON，不要任何解释、思考或多余文字。）`;
    cfg?.onEvent?.(`⚠️ 输出不合法（${String(e1.message).slice(0, 50)}），重试一次…`);
    return await llmJSON(cfg, system, user + reminder, Math.min(8192, maxTokens * 2));
  }
}

function extractJSON(text) {
  if (!text) throw new Error("模型返回为空");
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const s = t.indexOf("{");
  const e = t.lastIndexOf("}");
  if (s === -1 || e <= s) throw new Error(`无法解析模型输出: ${text.slice(0, 120)}`);
  try {
    return JSON.parse(t.slice(s, e + 1));
  } catch {
    throw new Error(`JSON 解析失败: ${text.slice(0, 120)}`);
  }
}

// ---------- 本地关键词（无大模型/大模型超时时的兜底） ----------
function localKeywords(q) {
  const kws = [];
  const seen = new Set();
  const add = (w) => {
    const t = w.trim();
    if (t && !seen.has(t) && t.length >= 2) { seen.add(t); kws.push(t); }
  };
  for (const w of q.match(/[A-Za-z0-9_+.-]{2,}/g) ?? []) add(w);
  for (const run of q.match(/[一-龥]{2,}/g) ?? []) {
    add(run);
    if (run.length > 4) { add(run.slice(0, 2)); add(run.slice(0, 3)); add(run.slice(0, 4)); }
    // 短语级中文串（≤6 字）加滑窗二元组：「优惠券弹窗」也能切出「弹窗」「优惠」
    if (run.length <= 6) for (let i = 0; i + 2 <= run.length; i++) add(run.slice(i, i + 2));
  }
  return kws.slice(0, 8);
}

// ---------- 文件搜索（并行） ----------
async function runAsync(cmd, args, timeout = 15000) {
  try {
    const { stdout } = await execFileP(cmd, args, { encoding: "utf8", timeout, maxBuffer: 32 * 1024 * 1024 });
    return stdout || "";
  } catch {
    return "";
  }
}

async function mdfind(term, byName, onlyIn = HOME) {
  const args = ["-onlyin", onlyIn];
  if (byName) args.push("-name");
  args.push(term);
  return (await runAsync("mdfind", args, 12000)).split("\n").filter(Boolean);
}

async function findFallback(kws) {
  const dirs = ["Desktop", "Documents", "Downloads", "Pictures", "Movies", "Music", "Projects", "work", "code", "Code", "dev", "workspace", "repos", "study", "学习", "工作", "归档"]
    .map((d) => path.join(HOME, d))
    .filter((d) => fs.existsSync(d));
  if (!dirs.length) return [];
  const tasks = [];
  for (const kw of kws.slice(0, 4)) {
    for (const d of dirs) {
      tasks.push(
        runAsync(
          "find",
          [d, "-maxdepth", "5", "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*", "-not", "-path", "*/Library/*", "-iname", `*${kw}*`],
          20000,
        ).then((out) => out.split("\n").filter(Boolean)),
      );
    }
  }
  const results = await Promise.all(tasks);
  return [...new Set(results.flat())];
}

// ---------- 候选检索 ----------
// path -> Set("name:kw" / "file:文件名" / "content:kw" / "scan")：记录每个候选的检索来历，供打分与 LLM 判断使用
const MATCH_TAGS = new Map();
// 本轮直扫到的目录清单（collectPaths 每轮重建）：给补搜轮的大模型看，让它能按名指认真实存在的目录
let SCAN_INVENTORY = [];
// 直扫时跳过的目录名（体积大且永不可能是用户目标）；总量上限防御异常大的目录树
const SCAN_SKIP = new Set(["node_modules", ".git", ".Trash", "__pycache__", ".venv", "venv", "dist", "build", "Library", "Caches", "Coverage"]);
const SCAN_MAX_DIRS = 600;
// 常用位置直扫：桌面与描述点名位置向下 3 层的目录全部入池
// （Spotlight 常有目录未被索引、名称搜索结果被截断（如 list/tab 这类常见词），
//   本地扫描保证这些目录仍能参选，靠关键词排序 + 大模型语义辨认兜底）
// 每题只扫一次：清单在关键词生成之前就要用（让大模型「按名指认」），后续检索轮复用
let SCAN_DONE = false;
function scanCommonRoots(hints = []) {
  if (SCAN_DONE) return;
  SCAN_DONE = true;
  SCAN_INVENTORY = [];
  for (const root of [...new Set([...hints, path.join(HOME, "Desktop")])]) {
    const queue = [{ d: root, depth: 0 }];
    let n = 0;
    while (queue.length) {
      const { d, depth } = queue.shift();
      let es;
      try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of es) {
        if (!e.isDirectory() || e.name.startsWith(".") || e.name.endsWith(".app")) continue;
        if (SCAN_SKIP.has(e.name) || /cache/i.test(e.name)) continue;
        const cp = path.join(d, e.name);
        SCAN_INVENTORY.push(cp);
        if (++n >= SCAN_MAX_DIRS) break;
        if (depth < 2) queue.push({ d: cp, depth: depth + 1 }); // 目录加到第 3 层，第 3 层不再下钻
      }
      if (n >= SCAN_MAX_DIRS) break;
    }
  }
}
function tagPath(p, tag) {
  let s = MATCH_TAGS.get(p);
  if (!s) MATCH_TAGS.set(p, (s = new Set()));
  s.add(tag);
}
// 粗过滤：家目录内且不在明显噪音路径里（细过滤仍由 keepCandidate 做）
function plausiblyHome(p) {
  return p.startsWith(HOME + "/") && !/\/(?:node_modules|\.git|Library|\.Trash|__pycache__|\.venv|venv|dist|build|Coverage)\/|\/go\/pkg\/mod\//.test(p);
}
// 泛词黑名单：只命中这类「类别词」的文件不做 父目录 映射（如「重点项目xx.jpg」之于关键词「项目」）
const GENERIC_FILE_KW = new Set([
  "项目", "工程", "文件", "文件夹", "目录", "代码", "素材", "工具", "笔记", "图片", "视频", "文档",
  // 英文结构词：作为文件名太常见（project.config.json、demo.vue），命中不算线索
  "project", "demo", "app", "test", "src", "index", "main", "utils", "config", "readme", "package", "build", "dist", "notes",
]);
// 关键词命中的文件 → 父目录入池：描述说「周报/简历/合同」时，目标常是装这些文件的文件夹
function mapFileHitsToParents(out, kws = []) {
  for (const p of [...out].slice(0, 800)) {
    if (!plausiblyHome(p)) continue;
    let st;
    try { st = fs.lstatSync(p); } catch { continue; }
    if (!st.isFile()) continue;
    const base = path.basename(p).toLowerCase();
    const matched = kws.filter((k) => k && base.includes(k.toLowerCase()));
    if (matched.length && matched.every((k) => GENERIC_FILE_KW.has(k))) continue; // 只命中泛词，不算线索
    const parent = path.dirname(p);
    if (!plausiblyHome(parent) || parent === HOME) continue;
    tagPath(parent, "file:" + [...path.basename(p)].slice(0, 40).join(""));
    out.add(parent);
  }
}

async function collectPaths(kws, rawQuery, hints = []) {
  const out = new Set();
  // 1) Spotlight 名称搜索（并行；描述点名了位置目录的再加一轮限定范围搜索）
  const nameTasks = kws.slice(0, 8).map((kw) =>
    mdfind(kw, true).then((hits) => {
      const capped = hits.slice(0, 500);
      for (const p of capped) tagPath(p, "name:" + kw);
      return capped;
    }),
  );
  for (const h of hints.slice(0, 2)) {
    for (const kw of kws.slice(0, 4)) nameTasks.push(mdfind(kw, true, h));
  }
  for (const list of await Promise.all(nameTasks)) for (const p of list) out.add(p);
  // 2) 命中的文件 → 父目录作为候选
  mapFileHitsToParents(out, kws);
  // 3) 常用位置直扫：桌面与描述点名位置向下 3 层的目录全部入池
  //    （扫描已提前到关键词生成之前完成——目录清单要给大模型「按名指认」用）
  scanCommonRoots(hints);
  for (const p of SCAN_INVENTORY) {
    tagPath(p, "scan");
    out.add(p);
  }
  // 4) 结果仍少时：内容搜索 + find 兜底（新命中同样做文件→父目录映射）
  if (out.size < 8) {
    const contentLists = await Promise.all(
      kws.slice(0, 3).map((kw) =>
        mdfind(kw, false).then((hits) => {
          const capped = hits.slice(0, 200);
          for (const p of capped) tagPath(p, "content:" + kw);
          return capped;
        }),
      ),
    );
    for (const list of contentLists) for (const p of list) out.add(p);
    mapFileHitsToParents(out, kws);
  }
  if (out.size < 8) {
    for (const p of await findFallback(kws.length ? kws : [rawQuery])) out.add(p);
    mapFileHitsToParents(out, kws);
  }
  return [...out];
}

// 一轮完整检索：搜索 → 过滤 → 去掉仓库内部子目录 → 打分排序
async function searchRound(kws, rawQuery, hints = []) {
  const uniq = [...new Set(await collectPaths(kws, rawQuery, hints))];
  const cands = uniq.filter(keepCandidate).map(statCandidate).filter(Boolean).filter((c) => c.isDir);
  return pruneNested(cands).sort(
    (a, b) => localScore(b, kws, hints, activeWin) - localScore(a, kws, hints, activeWin) || b.mtimeMs - a.mtimeMs,
  );
}

// ---------- 候选整理 ----------
// 描述里的位置词 → 家目录下的范围目录（用于限定搜索与加权排序）
const LOCATION_HINTS = [
  { words: ["桌面", "desktop"], dir: "Desktop" },
  { words: ["下载", "download"], dir: "Downloads" },
  { words: ["文档目录", "文档文件夹", "documents"], dir: "Documents" },
  { words: ["电影", "影片", "movie", "video"], dir: "Movies" },
  { words: ["音乐", "music"], dir: "Music" },
  { words: ["图片库", "照片库", "相册"], dir: "Pictures" },
];
function detectLocationHints(text) {
  const t = String(text).toLowerCase();
  const out = [];
  for (const h of LOCATION_HINTS) {
    if (h.words.some((w) => t.includes(w.toLowerCase()))) {
      const d = path.join(HOME, h.dir);
      if (fs.existsSync(d)) out.push(d);
    }
  }
  return out;
}

const BAD_SEG = new Set(["Library", ".Trash", "node_modules", ".git", "__pycache__", "Caches", "Containers"]);

function keepCandidate(p) {
  if (!p.startsWith(HOME + "/") && p !== HOME) return false;
  const segs = p === HOME ? [] : p.slice(HOME.length + 1).split("/");
  // ~/go/pkg/mod 是 Go 模块缓存，永远不是用户目标
  if (segs[0] === "go" && segs[1] === "pkg") return false;
  const base = segs[segs.length - 1] ?? "";
  if (base.startsWith("._") || base === ".DS_Store") return false;
  if (base.endsWith(".app")) return false; // .app 是应用包，open 它=启动 App，不作为目录候选
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i];
    if (s.startsWith(".") || BAD_SEG.has(s) || s.endsWith(".app")) return false;
    if (i > 0 && /cache/i.test(s)) return false; // 路径中间段带 cache 的是缓存目录（project_cache 等）
  }
  if (BAD_SEG.has(base)) return false;
  return true;
}

function statCandidate(p) {
  let st;
  try { st = fs.statSync(p); } catch { return null; }
  return { path: p, name: path.basename(p), isDir: st.isDirectory(), mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs ?? st.mtimeMs, size: st.size };
}

// ---------- 代码仓库/项目感知 ----------
const gitRootCache = new Map();
function isGitRoot(p) {
  let v = gitRootCache.get(p);
  if (v === undefined) { v = fs.existsSync(path.join(p, ".git")); gitRootCache.set(p, v); }
  return v;
}
// 项目根不一定是 git 仓库（很多个人项目没初始化 git），package.json / go.mod 等也算
const projRootCache = new Map();
function isProjectRoot(p) {
  let v = projRootCache.get(p);
  if (v === undefined) {
    v = isGitRoot(p)
      || fs.existsSync(path.join(p, "package.json"))
      || fs.existsSync(path.join(p, "go.mod"))
      || fs.existsSync(path.join(p, "Cargo.toml"))
      || fs.existsSync(path.join(p, "pyproject.toml"))
      || fs.existsSync(path.join(p, "pom.xml"))
      || fs.existsSync(path.join(p, ".hg"));
    projRootCache.set(p, v);
  }
  return v;
}
function hasProjectAncestor(p) {
  let d = path.dirname(p);
  for (let i = 0; i < 5 && d.length > HOME.length; i++) {
    if (isProjectRoot(d)) return true;
    d = path.dirname(d);
  }
  return false;
}
// 同一项目根与其内部子目录都在候选中时，只保留项目根——用户说「打开某项目」几乎总是指项目根
// （例外：子目录本身也是项目根——monorepo 里的子项目/楼层目录（各自带 package.json/.git），
//   它们与容器目录并存时都保留，交给排序与大模型按描述里的限定词分辨）
function pruneNested(cands) {
  const pool = new Set(cands.map((c) => c.path));
  return cands.filter((c) => {
    if (isProjectRoot(c.path)) return true;
    let d = path.dirname(c.path);
    while (d.length > HOME.length) {
      if (pool.has(d) && isProjectRoot(d)) return false;
      d = path.dirname(d);
    }
    return true;
  });
}

// 目录内容简述（≤10 字）：package.json 描述 > README 首行 > 扩展名构成归纳
const dirDescCache = new Map();
function cut10(str) {
  const t = String(str).replace(/\s+/g, " ").trim();
  return [...t].slice(0, 10).join("");
}
const EXT_KIND = {
  jpg: "图片", jpeg: "图片", png: "图片", gif: "图片", webp: "图片", heic: "图片", svg: "图片", bmp: "图片", ico: "图片",
  mp4: "视频", mov: "视频", mkv: "视频", avi: "视频", flv: "视频",
  mp3: "音频", wav: "音频", flac: "音频", m4a: "音频", aac: "音频",
  pdf: "文档", doc: "文档", docx: "文档", txt: "文本", md: "笔记", rtf: "文档", pages: "文档",
  xls: "表格", xlsx: "表格", csv: "表格", numbers: "表格",
  ppt: "演示", pptx: "演示", key: "演示",
  zip: "压缩包", rar: "压缩包", "7z": "压缩包", tar: "压缩包", gz: "压缩包", dmg: "镜像",
  js: "代码", ts: "代码", jsx: "代码", tsx: "代码", vue: "代码", py: "代码", java: "代码",
  go: "代码", rb: "代码", rs: "代码", c: "代码", cpp: "代码", h: "代码", swift: "代码", kt: "代码",
  php: "代码", sh: "代码", html: "网页", css: "样式", scss: "样式", json: "配置", yml: "配置", yaml: "配置",
  sketch: "设计稿", fig: "设计稿", psd: "设计稿", ai: "设计稿",
  ttf: "字体", otf: "字体", woff: "字体",
};
// 常见依赖 → 代码库类型
const DEP_KIND = [
  ["taro", "Taro 小程序"], ["@dcloudio/uni-app", "uni-app 小程序"],
  ["react", "React 前端项目"], ["vue", "Vue 前端项目"], ["svelte", "Svelte 项目"], ["angular", "Angular 项目"],
  ["next", "Next.js 项目"], ["nuxt", "Nuxt 项目"], ["electron", "Electron 应用"],
  ["express", "Node 服务"], ["koa", "Node 服务"], ["@nestjs/core", "Nest 服务"], ["egg", "Egg 服务"],
  ["vitepress", "文档站"], ["docusaurus", "文档站"], ["hexo", "博客站点"],
];
function buildDirDesc(p) {
  let entries;
  try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch { return ""; }
  if (!entries.length) return "空目录";
  const visible = entries.filter((e) => !e.name.startsWith("."));
  if (!visible.length) return "隐藏文件";
  const names = new Set(visible.map((e) => e.name));
  if (names.has("package.json")) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(p, "package.json"), "utf8"));
      const desc = String(pkg.description || "").trim();
      if (desc) return cut10(desc);
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      for (const [dep, kind] of DEP_KIND) {
        if (deps[dep]) return kind; // 识别代码库类型
      }
      const nm = String(pkg.name || "").trim();
      if (nm) return cut10(nm);
    } catch { /* 落到下面的推断 */ }
    return "Node 项目";
  }
  for (const rn of ["README.md", "readme.md", "Readme.md", "README.txt", "README", "readme"]) {
    if (names.has(rn)) {
      try {
        const lines = fs.readFileSync(path.join(p, rn), "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
        const heading = lines.find((l) => /^#{1,3}\s+\S/.test(l));
        const body = lines.find((l) => !l.startsWith("#") && !l.startsWith("![") && !l.startsWith("<"));
        const pickLine = heading ?? body;
        if (pickLine) return cut10(pickLine.replace(/^#{1,3}\s*/, "").replace(/[`*_>]/g, ""));
      } catch { /* 落到下面的推断 */ }
    }
  }
  // 其他代码仓库类型标记
  const has = (suffix) => visible.some((e) => e.name.endsWith(suffix));
  if (names.has("go.mod")) return "Go 项目";
  if (names.has("Cargo.toml")) return "Rust 项目";
  if (names.has("pom.xml") || names.has("build.gradle") || names.has("build.gradle.kts")) return "Java 项目";
  if (names.has("requirements.txt") || names.has("setup.py") || names.has("pyproject.toml")) return "Python 项目";
  if (names.has("Podfile") || has(".xcodeproj") || has(".xcworkspace")) return "iOS 项目";
  if (names.has("Gemfile")) return "Ruby 项目";
  if (names.has("composer.json")) return "PHP 项目";
  const kindCount = new Map();
  let subDirs = 0;
  let otherFiles = 0;
  for (const e of visible) {
    if (e.isDirectory()) { subDirs++; continue; }
    const kind = EXT_KIND[path.extname(e.name).toLowerCase().replace(".", "")];
    if (kind) kindCount.set(kind, (kindCount.get(kind) ?? 0) + 1);
    else otherFiles++;
  }
  const [topKind, topN] = [...kindCount.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  if (topKind) return cut10(topN > 1 ? `${topKind}×${topN}` : topKind);
  if (subDirs) return cut10(subDirs > 1 ? `${subDirs} 个子目录` : "子目录");
  if (otherFiles) return cut10(otherFiles > 1 ? `文件×${otherFiles}` : "文件");
  return cut10(`${visible.length} 个文件`);
}
const dirDescLLM = new Map(); // 大模型异步总结的摘要，优先级最高
function describeDir(p) {
  if (dirDescLLM.has(p)) return dirDescLLM.get(p);
  if (!dirDescCache.has(p)) {
    let d = "";
    try { d = buildDirDesc(p); } catch { /* 忽略 */ }
    dirDescCache.set(p, d);
  }
  return dirDescCache.get(p);
}

// 大模型总结单个目录内容（≤10 字）：并发请求，各自完成即刷新，不等待凑齐
const SUM_ONE_SYSTEM = `你负责为一个 macOS 目录生成超短摘要。根据目录的路径和它包含的文件列表，用不超过 10 个字概括它大概是什么内容（例如「React 前端项目」「爬虫代码库」「设计素材」「周报文档」「Go 命令行工具」）。优先说明这是什么类型/主题的内容，而不是罗列文件。
严格只输出一行 JSON：{"summary":"……"}，禁止解释。`;
// 模型输出容错解析：优先 JSON，失败则按编号/项目符号列表解析
function parseSummaries(text, n) {
  if (!text) return [];
  try {
    const j = extractJSON(text);
    if (Array.isArray(j.summaries)) return j.summaries.map((x) => String(x));
  } catch { /* 继续按列表解析 */ }
  const out = [];
  for (const raw of text.split("\n")) {
    const l = raw.trim();
    const m = l.match(/^(?:\d+[.、)]|[-*•])\s*(.+)$/);
    if (!m) continue;
    let t = m[1];
    const sep = t.search(/[：:]/);
    if (sep >= 0) t = t.slice(sep + 1); // 去掉「目录名：」前缀
    t = t.replace(/["'`]/g, "").trim();
    if (t) out.push(t);
  }
  return out.slice(0, n);
}
async function summarizeOneDir(p, cfg) {
  let listing = "";
  try {
    listing = fs.readdirSync(p)
      .filter((x) => !x.startsWith("."))
      .slice(0, 20)
      .map((x) => (x.length > 24 ? x.slice(0, 24) + "…" : x))
      .join(", ");
    if (listing.length > 240) listing = listing.slice(0, 240) + "…";
  } catch { /* 忽略 */ }
  const user = `${displayPath(p)} | 内含: ${listing || "（无法读取）"}`;
  try {
    // 推理模型的思考也消耗 max_tokens，给足余量避免 content 被截空
    const out = await llmJSON(cfg, SUM_ONE_SYSTEM, user, 1024);
    const t = String(out?.summary ?? "").trim();
    return t ? [...t].slice(0, 10).join("") : "";
  } catch { return ""; }
}

function relTime(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  const d = s / 86400;
  if (d < 31) return `${Math.floor(d)} 天前`;
  if (d < 366) return `${Math.floor(d / 30)} 个月前`;
  return `${Math.floor(d / 365)} 年前`;
}

function fmtSize(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)}KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)}MB`;
  return `${(n / 1024 ** 3).toFixed(1)}GB`;
}

// 终端显示列宽（保守计算）：ASCII 按 1 列，其余一律按 2 列，变体选择符按 0 列。
// 保守的目的是宁可提前换行，也绝不能让真实宽度超过预算——否则终端自动折行会多占
// 物理行，破坏「按行数回退重绘」的几何（表现为标题行越叠越多）。
function charCols(ch) {
  const cp = ch.codePointAt(0);
  if (cp === 0xfe0f || cp === 0x200d) return 0; // emoji 变体选择符/零宽连接符
  if (cp < 0x80) return 1;
  return 2;
}

function dispCols(str) {
  let n = 0;
  for (const ch of str) n += charCols(ch);
  return n;
}

// 把一行按 maxCols 断成多行（不截断内容）；续行加 indent 前缀
function hardWrap(str, maxCols, indent = "") {
  const cols = Math.max(8, maxCols);
  const indCols = dispCols(indent);
  const contCap = Math.max(1, cols - indCols); // 续行内容预算：总额减去缩进宽度
  const rows = [];
  let cur = "";
  let curCols = 0;
  let cap = cols; // 首行全额预算
  for (const ch of str) {
    const w = charCols(ch);
    if (curCols + w > cap) {
      rows.push(cur);
      cur = indent + ch;
      curCols = indCols + w;
      cap = contCap;
    } else {
      cur += ch;
      curCols += w;
    }
  }
  rows.push(cur);
  return rows.length ? rows : [""];
}

function displayPath(p) {
  if (p === HOME) return "~";
  return p.startsWith(HOME + "/") ? "~" + p.slice(HOME.length) : p;
}

// 文档类扩展名：这类文件命中关键词时，所在目录是目标的可能性的确高（周报.docx ↔ 「周报」描述）
const DOC_FILE_EXT = new Set(["doc", "docx", "pdf", "xls", "xlsx", "csv", "numbers", "txt", "md", "rtf", "pages", "ppt", "pptx", "key", "sketch", "fig", "psd", "zip", "dmg", "mp4", "mov", "mp3", "wav"]);

function localScore(c, kws, hints = [], win = activeWin) {
  let s = 0;
  const name = c.name.toLowerCase();
  const p = displayPath(c.path).toLowerCase();
  // 名称/路径命中；名称命中的重叠关键词只计最长的（crowd ⊂ crowdfunding 不重复计分）
  const nameHits = [];
  for (const kw of kws) {
    const k = kw.toLowerCase();
    if (!k) continue;
    const nk = k.length > 3 && k.endsWith("s") ? k.slice(0, -1) : k; // 复数归一：images/image 互认
    if (name === k || name === nk) nameHits.push({ k, sc: 12 });
    else if (name.includes(k)) nameHits.push({ k, sc: 6 });
    else if (name.includes(nk)) nameHits.push({ k: nk, sc: 6 });
    else if (p.includes(k) || p.includes(nk)) s += 2;
  }
  for (const h of nameHits) {
    if (nameHits.some((o) => o.k.length > h.k.length && o.k.includes(h.k))) continue; // 被更长的命中覆盖
    s += h.sc;
  }
  // 位置提示：点名了桌面/下载等目录时，其下候选加分，越浅加得越多
  for (const h of hints) {
    if (c.path === h) s += 4;
    else if (c.path.startsWith(h + "/")) s += 6 - Math.min(4, c.path.slice(h.length + 1).split("/").length);
  }
  // 检索来历加权：目录里有关键词命中的文件（「周报」描述 ↔ 内含 周报.docx 的目录）是强信号
  // 每类来历只计一次分；项目内部子目录里命中的代码文件（xxx.vue/.ts）不算——那是名称通道的回声
  const tags = MATCH_TAGS.get(c.path);
  if (tags) {
    let fileHit = false;
    let contentHit = false;
    let fileIsDoc = false;
    for (const t of tags) {
      if (t.startsWith("file:")) {
        fileHit = true;
        const ext = t.slice(t.lastIndexOf(".") + 1).toLowerCase();
        if (DOC_FILE_EXT.has(ext)) fileIsDoc = true;
      } else if (t.startsWith("content:")) contentHit = true;
    }
    if (fileHit && (!hasProjectAncestor(c.path) || fileIsDoc)) s += 7;
    if (contentHit) s += 3;
  }
  // 时间窗口：描述里的「昨天/上周/最近」与修改或创建时间吻合则加分
  if (win) {
    const inWin = (t) => t >= win.from && t <= win.to;
    if (inWin(c.mtimeMs) || (c.birthtimeMs && inWin(c.birthtimeMs))) s += 3;
  }
  // 项目根目录略加分；项目内部子目录（src/views/ 等）重降权——用户说「项目」几乎不会指内部模块
  if (isProjectRoot(c.path)) s += 1.5;
  else if (hasProjectAncestor(c.path)) s -= 6;
  // 历史上被选中过的路径加权（越选越顺手）
  s += Math.min(6, 2 * (HIST_COUNT.get(c.path) ?? 0));
  const days = Math.max(0, (Date.now() - c.mtimeMs) / 86400000);
  s += Math.max(0, 3 - Math.log10(days + 1) * 1.2);
  if (c.name.startsWith(".")) s -= 1;
  return s;
}

// 候选的主要子目录名（≤3 个，短名才有辨识度）
function subdirsBrief(p) {
  let es;
  try { es = fs.readdirSync(p, { withFileTypes: true }); } catch { return ""; }
  const names = [];
  for (const e of es) {
    if (!e.isDirectory() || e.name.startsWith(".") || BAD_SEG.has(e.name)) continue;
    if (e.name.length > 16) continue;
    names.push(e.name);
    if (names.length >= 3) break;
  }
  return names.join(", ");
}

// 候选的检索来历，转成给大模型看的中文说明
function matchBrief(c) {
  const tags = MATCH_TAGS.get(c.path);
  if (!tags) return "";
  const parts = [];
  for (const t of tags) {
    if (t.startsWith("name:")) parts.push(`目录名含「${t.slice(5)}」`);
    else if (t.startsWith("file:")) parts.push(`内含文件「${t.slice(5)}」`);
    else if (t.startsWith("content:")) parts.push(`内容含「${t.slice(8)}」`);
    else if (t === "scan") parts.push("常用位置直扫");
  }
  return [...new Set(parts)].slice(0, 2).join("；");
}

function formatForLLM(cands, win = activeWin) {
  return cands
    .map((c, i) => {
      const segs = [`${i + 1}. [目录] ${displayPath(c.path)}`];
      const d = describeDir(c.path);
      if (d) segs.push(`内容: ${d}`);
      const sd = subdirsBrief(c.path);
      if (sd) segs.push(`子目录: ${sd}`);
      const mb = matchBrief(c);
      if (mb) segs.push(`匹配: ${mb}`);
      let t = `修改于 ${relTime(c.mtimeMs)}`;
      if (win && c.birthtimeMs && Math.abs(c.birthtimeMs - c.mtimeMs) > DAY_MS) t += `，约建于 ${relTime(c.birthtimeMs)}`;
      segs.push(t);
      return segs.join(" — ");
    })
    .join("\n");
}

// 换角度再生成一批关键词（低置信/空结果时的补搜轮）
// 附上直扫目录清单：Spotlight 查不到/词形对不上时，让大模型直接按名指认真实存在的目录
function inventoryBrief() {
  const rows = [];
  for (const p of SCAN_INVENTORY) {
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    rows.push({ p, m: st.mtimeMs });
  }
  rows.sort((a, b) => b.m - a.m); // 最近的排前面，更可能是当前目标
  return rows.slice(0, 200).map((r) => displayPath(r.p)).join("\n") || "（无）";
}
async function regenKeywords(cfg, query, triedKws, candPool) {
  const brief = (candPool ?? []).slice(0, 15).map((c) => displayPath(c.path)).join("\n") || "（暂无候选）";
  const out = await llmJSONRetry(cfg, KW_RETRY_SYSTEM, `用户描述：${query}\n已试关键词：${[...new Set(triedKws)].join("、")}\n当前候选（可能都不对）：\n${brief}\n\n本机真实存在的目录清单（按最近修改排序，供参考）：\n${inventoryBrief()}`, 1024);
  const tried = new Set(triedKws.map((k) => String(k).toLowerCase()));
  const fresh = (Array.isArray(out.keywords) ? out.keywords : [])
    .map((k) => String(k).trim())
    .filter(Boolean)
    .filter((k) => !tried.has(k.toLowerCase()));
  return [...new Set(fresh)].slice(0, 8);
}

function printTable(cands) {
  if (!cands.length) { err("没有候选"); return; }
  console.log(`\n共 ${cands.length} 个候选:\n`);
  cands.slice(0, 20).forEach((c, i) =>
    console.log(`  ${String(i + 1).padStart(2)}. 📁 ${displayPath(c.path)}   ${[matchBrief(c), describeDir(c.path) || relTime(c.mtimeMs)].filter(Boolean).join(" · ")}`),
  );
  if (cands.length > 20) console.log(`  … 以及另外 ${cands.length - 20} 个（可用更精确的描述缩小范围）`);
}

// ---------- 选择记忆 ----------
function bigrams(str) {
  const s = String(str).toLowerCase().replace(/\s+/g, "");
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  if (!set.size && s) set.add(s);
  return set;
}

function diceSimilarity(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}

function loadHistory() {
  try {
    const j = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8"));
    if (Array.isArray(j?.records)) return j.records.filter((r) => r && r.query && r.path);
  } catch { /* 无历史文件 */ }
  return [];
}

// 路径 → 被选中次数（跨描述累计），供排序加权
function buildHistCount() {
  const m = new Map();
  for (const r of loadHistory()) m.set(r.path, (m.get(r.path) ?? 0) + 1);
  return m;
}

function recordChoice(query, p) {
  if (DRY_RUN) return; // dry-run 不写历史，避免污染记忆
  try {
    const q = query.trim();
    const records = loadHistory().filter((r) => fs.existsSync(r.path));
    const i = records.findIndex((r) => r.query === q && r.path === p);
    let count = 1;
    if (i >= 0) { count = (Number(records[i].count) || 1) + 1; records.splice(i, 1); }
    records.unshift({ query: q, path: p, ts: Date.now(), count });
    fs.writeFileSync(HISTORY_PATH, JSON.stringify({ version: 1, records: records.slice(0, HISTORY_LIMIT) }, null, 2));
  } catch { /* 历史写失败不影响主流程 */ }
}

function recallChoice(query) {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  let best = null;
  let bestSim = 0;
  for (const r of loadHistory()) {
    const pq = r.query.trim().toLowerCase();
    let sim = diceSimilarity(q, pq);
    const base = path.basename(r.path).toLowerCase();
    // 描述里直接点名了上次选中的文件/目录名，视为强信号
    if (base.length >= 3 && q.includes(base)) sim = Math.max(sim, 0.75); // 当前描述直接点名了上次的目标名
    if (sim > bestSim) { bestSim = sim; best = r; }
  }
  if (!best || bestSim < SIM_THRESHOLD) return null;
  try { if (!fs.statSync(best.path).isDirectory()) return null; } catch { return null; }
  return { ...best, sim: bestSim };
}

async function askUseRemembered(rec) {
  console.log(`\n⏮ 上次找「${rec.query}」时你选择了: ${displayPath(rec.path)}（${relTime(rec.ts)}）`);
  const readline = await import("node:readline/promises"); // Node 17+ 才有，不能静态 import（见文件顶部说明）
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = (await rl.question("直接用它吗？(回车/Y = 打开, n = 重新挑选): ")).trim().toLowerCase();
    return ans === "" || ans === "y" || ans === "yes";
  } finally {
    rl.close();
  }
}

// ---------- 交互选择 ----------
const PICKER_MAX_SHOW = 5; // 列表最多显示 5 项，第 6 行是输入行

// 光标式交互选择：↑/↓（或 j/k）移动、回车选择、数字键快选、输入行支持描述筛选、Esc 取消
async function pickInteractively(cands, title, refine = null) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  let items = cands.slice(0, PICKER_MAX_SHOW);
  if (!items.length) return null;
  let input = "";
  let cursor = 0;
  let prevRows = 0;
  let busy = false;
  let active = true;
  // 大模型异步升级摘要：先显示本地启发式摘要，总结回来后原地刷新
  const upgradeSummaries = () => {
    if (!refine?.cfg) return;
    const targets = [...new Set(items.map((c) => c.path))].filter((x) => !dirDescLLM.has(x));
    if (!targets.length) return;
    // 每个目录一个并发请求：谁先回来先刷新谁，不等待凑齐
    for (const p of targets) {
      summarizeOneDir(p, refine.cfg)
        .then((t) => {
          if (!active || !t) return;
          dirDescLLM.set(p, t);
          if (!busy) render();
        })
        .catch(() => { /* 忽略：该目录保留本地摘要 */ });
    }
  };
  const inputRow = () => items.length;
  const W = () => process.stdout.columns || 80;

  // 整帧拼好一次性 write：逐行 [2K 原位覆盖后回到块首，不存在"清空→重画"的空白瞬间
  const clearBlock = () => {
    if (prevRows <= 0) return;
    process.stdout.write("\x1b[2K\r\n".repeat(prevRows) + `\r\x1b[${prevRows}A`);
    prevRows = 0;
  };
  const render = () => {
    // 完整显示路径不截断：超宽的行按显示列宽手动断行（续行缩进对齐）
    // 当前选中项整条反显高亮并补齐到整行宽；样式在断行之后叠加，避免影响宽度计算
    const padRow = (r) => r + " ".repeat(Math.max(0, W() - 2 - dispCols(r)));
    const hl = (rows) => rows.map((r) => "\x1b[7m" + padRow(r) + "\x1b[0m");
    const itemRows = items.map((c, i) => {
      const mark = i === cursor ? "❯" : " ";
      const rows = hardWrap(`${mark} ${i + 1}. 📁 ${displayPath(c.path)}  (${describeDir(c.path) || relTime(c.mtimeMs)})`, W() - 2, "        ");
      return i === cursor ? hl(rows) : rows;
    });
    const mark = cursor === inputRow() ? "❯" : " ";
    const inputPlain = hardWrap(`${mark} ✏️  输入更多汉字描述筛选: ${input}${cursor === inputRow() ? "▏" : ""}`, W() - 2, "        ");
    const inputRows = cursor === inputRow() ? hl(inputPlain) : inputPlain;
    const rows = [...hardWrap(title, W() - 2), ...itemRows.flat(), ...inputRows];
    while (rows.length < prevRows) rows.push(""); // 行数变少时清掉旧行
    let out = "";
    rows.forEach((r, i) => { if (i > 0) out += "\r\n"; out += "\x1b[2K" + r; });
    prevRows = rows.length;
    process.stdout.write(out + `\r\x1b[${rows.length - 1}A`);
  };

  process.stdout.write(`\n（↑/↓ 或 j/k 移动光标，回车打开，数字键 1-${items.length} 直接选；↓ 到第 ${items.length + 1} 行可输入更多描述；Esc 取消）\n`);
  process.stdout.write("\x1b[?25l"); // 选择期间隐藏终端光标，减少闪烁
  process.stdin.setRawMode(true);
  process.stdin.resume();
  emitKeypressEvents(process.stdin);

  return new Promise((resolve) => {
    const cleanup = () => {
      active = false;
      process.stdin.removeListener("keypress", onKey);
      try { process.stdin.setRawMode(false); } catch { /* 忽略 */ }
      process.stdout.write("\x1b[?25h"); // 恢复终端光标
    };
    const finish = (value) => {
      cleanup();
      clearBlock();
      if (value) info(`✔ 已选择: ${displayPath(value.path)}`);
      resolve(value);
    };
    const onKey = async (str, key) => {
      if (busy) return;
      if (key.ctrl && (key.name === "c" || key.name === "d")) { cleanup(); process.exit(130); }
      if (key.name === "escape") { finish(null); return; }
      const goUp = key.name === "up" || (str === "k" && cursor < inputRow());
      const goDown = key.name === "down" || (str === "j" && cursor < inputRow());
      if (goUp) { if (cursor > 0) { cursor--; render(); } return; }
      if (goDown) { if (cursor < inputRow()) { cursor++; render(); } return; }
      if (key.name === "return" || key.name === "enter") {
        if (cursor < items.length) { finish(items[cursor]); return; }
        const text = input.trim();
        if (!text) { finish(null); return; }
        if (!refine) return;
        busy = true;
        try {
          clearBlock();
          info(`🔎 用补充描述「${text}」缩小范围…`);
          const next = await refineCandidates(text, refine);
          if (!next.length) {
            warn(`没有匹配「${text}」的候选，仍显示原列表，换个说法再试`);
            input = ""; cursor = 0;
          } else if (next.length === 1) {
            info(`🎯 补充描述唯一命中: ${displayPath(next[0].path)}`);
            finish(next[0]);
            return;
          } else {
            items = next.slice(0, PICKER_MAX_SHOW);
            input = ""; cursor = 0;
          }
          render();
          upgradeSummaries();
        } finally { busy = false; }
        return;
      }
      if (key.name === "backspace" || key.name === "delete") {
        if (cursor === inputRow() && input) { input = input.slice(0, -1); render(); }
        return;
      }
      if (str && !key.ctrl && !key.meta) {
        if (cursor < items.length && /^[1-9]$/.test(str) && Number(str) <= items.length) {
          finish(items[Number(str) - 1]); // 数字键快选
          return;
        }
        cursor = inputRow(); // 其他字符进入输入行
        input += str;
        render();
      }
    };
    process.stdin.on("keypress", onKey);
    render();
    upgradeSummaries();
  });
}

// 补充描述筛选：先在完整候选池里按名称/路径匹配；没有命中就带着补充描述重新搜索
async function refineCandidates(text, { pool, cfg, query }) {
  // 只用补充描述本身的关键词做池内筛选——若并入原查询关键词，旧候选会继续命中，起不到缩小作用
  const kws = localKeywords(text);
  const hints = detectLocationHints(`${query} ${text}`);
  const kwVariants = (kw) => {
    const k = kw.toLowerCase();
    const nk = k.length > 3 && k.endsWith("s") ? k.slice(0, -1) : k; // 复数归一
    return k === nk ? [k] : [k, nk];
  };
  const kwScore = (c) => {
    const name = c.name.toLowerCase();
    const p = displayPath(c.path).toLowerCase();
    let sc = 0;
    for (const kw of kws) {
      if (!kw) continue;
      const vs = kwVariants(kw);
      if (vs.some((k) => name === k)) sc += 12;
      else if (vs.some((k) => name.includes(k))) sc += 6;
      else if (vs.some((k) => p.includes(k))) sc += 2;
    }
    return sc;
  };
  const hintBonus = (c) => {
    let sc = 0;
    for (const h of hints) {
      if (c.path === h) sc += 4;
      else if (c.path.startsWith(h + "/")) sc += 6 - Math.min(4, c.path.slice(h.length + 1).split("/").length);
    }
    return sc;
  };
  // 位置目录的直接子目录也参与匹配——Spotlight 没搜到（如单复数差异/索引滞后）也能进来
  const full = [...(pool ?? [])];
  const seen = new Set(full.map((c) => c.path));
  for (const h of hints.slice(0, 2)) {
    try {
      for (const e of fs.readdirSync(h, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name.startsWith(".") || e.name.endsWith(".app")) continue;
        const cp = path.join(h, e.name);
        if (seen.has(cp)) continue;
        const c = statCandidate(cp);
        if (c) { seen.add(cp); full.push(c); }
      }
    } catch { /* 忽略 */ }
  }
  const filtered = full
    .filter((c) => kwScore(c) > 0) // 必须关键词命中，位置只是加权
    .sort((a, b) => kwScore(b) + hintBonus(b) - (kwScore(a) + hintBonus(a)) || b.mtimeMs - a.mtimeMs);
  if (filtered.length) return filtered.slice(0, 10);

  // 重新搜索：有大模型就先用它生成新关键词
  let rkws = kws;
  if (cfg) {
    try {
      const out = await llmJSONRetry(cfg, KW_SYSTEM, `用户描述：${query}\n（用户补充：${text}）`, 1024);
      if (Array.isArray(out.keywords) && out.keywords.length) {
        rkws = [...new Set([...out.keywords.map((k) => String(k).trim()).filter(Boolean), ...kws])].slice(0, 8);
      }
    } catch { /* 用本地关键词继续 */ }
  }
  if (!rkws.length) rkws = [text];
  const rHints = detectLocationHints(`${query} ${text}`);
  return (await searchRound(rkws, `${query} ${text}`, rHints)).slice(0, 10);
}

// ---------- 猜测核心（评测/复用）：跑完 关键词→搜索→挑选 全流程，不打开、不确认、不写历史 ----------
// 返回 { status: "hit"|"abstain"|"empty", path, reason, confidence, kws, win, candidates }
async function predictTarget(query, opts = {}) {
  const onStage = typeof opts.onStage === "function" ? opts.onStage : null;
  const cfg = opts.cfg !== undefined
    ? opts.cfg
    : loadConfig({ provider: opts.provider ?? null, model: opts.model ?? null, baseUrl: opts.baseUrl ?? null });
  if (cfg && onStage) cfg.onEvent = onStage; // 让底层把重试/异常上报到进度回调

  MATCH_TAGS.clear(); // 评测循环里多次调用时，清掉上一题的检索来历标记
  SCAN_DONE = false;  // 每题重新扫描一遍目录清单
  const t0 = Date.now(); // 全题时间预算：补搜轮只在预算内进行，不让总时长失控
  const hints = detectLocationHints(query);
  scanCommonRoots(hints); // 先扫描：目录清单同时供关键词生成「按名指认」
  let kws = localKeywords(query);
  if (cfg) {
    onStage?.("🧠 大模型生成搜索关键词…");
    try {
      const out = await llmJSONRetry(cfg, KW_SYSTEM, `用户描述：${query}\n\n本机真实存在的目录清单（按最近修改排序，供参考）：\n${inventoryBrief()}`, 1024);
      if (Array.isArray(out.keywords) && out.keywords.length) {
        const ascii = kws.filter((k) => /^[A-Za-z0-9_+.-]+$/.test(k)); // 只补 ASCII 词，避免本地中文虚词污染搜索词
        kws = [...new Set([...out.keywords.map((k) => String(k).trim()).filter(Boolean), ...ascii])].slice(0, 8);
      }
    } catch { /* 用本地关键词继续 */ }
  }
  if (!kws.length) kws = [query];

  activeWin = parseTimeWindow(query);
  HIST_COUNT = buildHistCount();
  onStage?.("🔎 搜索候选目录…");
  let cands = await searchRound(kws, query, hints);
  if (!cands.length && cfg) {
    onStage?.("🔄 没搜到，换角度补搜一轮…");
    try {
      const nkws = await regenKeywords(cfg, query, kws, []);
      if (nkws.length) {
        kws = [...new Set([...nkws, ...kws])].slice(0, 14);
        cands = await searchRound(kws, query, hints);
      }
    } catch { /* 保持为空 */ }
  }
  if (!cands.length) return { status: "empty", path: null, reason: "没有找到任何候选", confidence: null, kws, win: activeWin, candidates: [] };
  if (!cfg) {
    // 无大模型：按本地排序给 top1
    return { status: "hit", path: cands[0].path, reason: "本地排序 top1（未配置大模型）", confidence: null, kws, win: activeWin, candidates: cands.slice(0, 10) };
  }

  const select = async (pool) => {
    const ctx = [];
    if (hints.length) ctx.push(`位置线索：用户点名的位置目录：${hints.map(displayPath).join("、")}`);
    if (activeWin) ctx.push(`时间线索：「${activeWin.label}」≈ ${fmtDate(activeWin.from)} ~ ${fmtDate(activeWin.to)}（目录的修改或创建时间在此区间更可能）`);
    const sel = await llmJSONRetry(cfg, SEL_SYSTEM, `用户描述：${query}\n\n${ctx.length ? ctx.join("\n") + "\n\n" : ""}候选列表：\n${formatForLLM(pool)}`, 2048);
    const idx = Number(sel.choice) - 1;
    const chosen = Number.isInteger(idx) && idx >= 0 && idx < pool.length ? pool[idx] : null;
    return { chosen, conf: Number(sel.confidence ?? 0), reason: String(sel.reason ?? "") };
  };

  let pool = cands.slice(0, MAX_CANDIDATES);
  let r;
  let selAborted = false; // 挑选调用是否因超时被中断（服务慢时补搜重挑只会同样超时，直接降级）
  onStage?.(`🤖 大模型在 ${pool.length} 个候选里挑选…`);
  try {
    r = await select(pool);
  } catch (e) {
    selAborted = e?.name === "AbortError";
    r = { chosen: null, conf: 0, reason: `模型不可用：${String(e.message).slice(0, 60)}` };
  }
  if (!(r.chosen && r.conf >= 0.5) && !selAborted && Date.now() - t0 < 20000) {
    // 模型 answered 但不确定：还有时间预算就换角度补搜一轮再选一次
    onStage?.("🔄 置信度不足，换角度补搜一轮…");
    try {
      const nkws = await regenKeywords(cfg, query, kws, pool);
      if (nkws.length) {
        kws = [...new Set([...kws, ...nkws])].slice(0, 14);
        const seen = new Set(pool.map((c) => c.path));
        const fresh = (await searchRound([...nkws, ...kws.filter((k) => !nkws.includes(k))], query, hints)).filter((c) => !seen.has(c.path));
        if (fresh.length) {
          const merged = [...pool, ...fresh];
          merged.sort((a, b) => localScore(b, kws, hints, activeWin) - localScore(a, kws, hints, activeWin) || b.mtimeMs - a.mtimeMs);
          pool = merged.slice(0, MAX_CANDIDATES);
          onStage?.(`🤖 重新在 ${pool.length} 个候选里挑选…`);
          r = await select(pool);
        }
      }
    } catch { /* 维持第一次结果 */ }
  }
  if (r.chosen && r.conf >= 0.5) {
    return { status: "hit", path: r.chosen.path, reason: r.reason, confidence: r.conf, kws, win: activeWin, candidates: pool.slice(0, 10) };
  }
  // 模型明确说「候选里没有」→ 弃猜；只是超时/低置信/解析失败 → 本地排序 top1 兜底（低置信，交给用户判断）
  if (!r.chosen && r.conf >= 0.7) {
    return { status: "abstain", path: null, reason: r.reason || "候选里没有匹配项", confidence: r.conf, kws, win: activeWin, candidates: pool.slice(0, 10) };
  }
  return {
    status: "fallback",
    path: pool[0].path,
    reason: `${r.reason ? `${r.reason}；` : ""}按本地排序给出 top1（低置信）`,
    confidence: 0.4,
    kws,
    win: activeWin,
    candidates: pool.slice(0, 10),
  };
}

// ---------- 打开 ----------
function openTarget(p, useVscode) {
  if (DRY_RUN) { info(`🎯 [dry-run] 猜到的目标: ${displayPath(p)}（未真正打开）`); return; }
  if (useVscode) {
    const probe = spawnSync("code", ["--version"], { encoding: "utf8" });
    const hasCodeCli = !probe.error && probe.status === 0;
    const r = hasCodeCli
      ? spawnSync("code", [p], { stdio: "inherit" })
      : spawnSync("open", ["-a", "Visual Studio Code", p], { stdio: "inherit" });
    if (r.error || r.status !== 0) {
      err("用 VSCode 打开失败，请确认已安装 Visual Studio Code");
      process.exit(1);
    }
    info(`✅ 已用 VSCode 打开: ${displayPath(p)}`);
  } else {
    const r = spawnSync("open", [p], { stdio: "inherit" });
    if (r.error || r.status !== 0) {
      err(`打开失败: ${displayPath(p)}`);
      process.exit(1);
    }
    info(`✅ 已用 Finder 打开: ${displayPath(p)}`);
  }
}

// ---------- 切换终端目录（--cd）----------
// 子进程改不了父 shell 的 cwd：--init 输出一个与命令同名的 shell 函数，它把临时文件开在 fd 3 上调用本程序，
// 程序把选中的目录写到 fd 3，函数读出来后 cd 过去。没有经由函数运行时（fd 3 未打开）退化为打印 cd 命令。
const INIT_SHELLS = ["zsh", "bash"];
function shellIntegration(shell) {
  // zsh 与 bash 在这段函数上语法完全一致
  return `# magic-open shell 集成：让 \`magic-open "描述" --cd\`（缩写 \`mag\`）能把当前终端切到选中的目录。
# 目标目录经 fd 3（临时文件）传回，其余输出与退出码保持原样。
magic-open() {
  local __mo_tmp __mo_dir __mo_ret=0
  __mo_tmp="$(mktemp "\${TMPDIR:-/tmp}/magic-open.XXXXXX")" || return
  command magic-open "$@" 3>"$__mo_tmp" || __mo_ret=$?
  if [[ -s "$__mo_tmp" ]]; then
    IFS= read -r __mo_dir < "$__mo_tmp"
    [[ -d "$__mo_dir" ]] && builtin cd -- "$__mo_dir"
  fi
  command rm -f "$__mo_tmp"
  return $__mo_ret
}

# 缩写：mag = magic-open（经由上面的函数，所以 mag --cd 同样生效）
mag() { magic-open "$@"; }`;
}

function emitCd(p) {
  const abs = path.resolve(p);
  if (DRY_RUN) { info(`📂 [dry-run] 终端将切换到: ${displayPath(abs)}（未真正切换）`); return; }
  let delivered = false;
  try { fs.writeSync(3, abs + "\n"); delivered = true; } catch { /* fd 3 未打开：不是经由 shell 函数运行的 */ }
  if (delivered) { info(`📂 终端已切换到: ${displayPath(abs)}`); return; }
  warn("--cd 需要经由 shell 函数运行才能切换终端目录（子进程改不了父 shell 的 cwd）。");
  info(`   本次请手动执行: cd '${abs.replace(/'/g, `'\\''`)}'`);
  info(`   一劳永逸: eval "$(magic-open --init zsh)" 写进 ~/.zshrc（bash 用户换成 bash）`);
}

// 选中目录后的统一收尾：--cd 时切换终端目录，再打开
function finish(p, args) {
  if (args.cd) emitCd(p);
  openTarget(p, args.vscode);
}

// 用户直接给了路径时跳过搜索
function tryDirectPath(words) {
  const tries = [words.join(" "), ...words];
  for (const w of tries) {
    if (!w) continue;
    const p = w.startsWith("~") ? path.join(HOME, w.slice(1).replace(/^\/?/, "")) : path.resolve(w);
    try { fs.statSync(p); return p; } catch { /* 不存在则继续 */ }
  }
  return null;
}

// ---------- 主流程 ----------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(usage()); return; }
  if (args.version) { console.log(VERSION); return; }
  if (args.unknown) { err(`未知参数: ${args.unknown}`); console.error(usage()); process.exit(1); }
  if (args.init !== null) {
    if (!INIT_SHELLS.includes(args.init)) { err(`--init 不支持「${args.init}」，目前支持: ${INIT_SHELLS.join(" / ")}`); process.exit(1); }
    console.log(shellIntegration(args.init));
    return;
  }
  if (!args.query) { console.error(usage()); process.exit(1); }

  const useLocal = args.provider === "none" || process.env.MAGIC_OPEN_PROVIDER === "none";
  DRY_RUN = Boolean(args.dryRun);

  // 1) 直接给路径
  const direct = tryDirectPath(args.words);
  if (direct) {
    {
      let isDir = false;
      try { isDir = fs.statSync(direct).isDirectory(); } catch { /* 忽略 */ }
      if (!isDir) { err(`magic-open 仅支持打开文件夹，而该路径是文件: ${displayPath(direct)}`); process.exit(1); }
    }
    if (args.list) { const c = statCandidate(direct); printTable(c ? [c] : []); return; }
    info(`🎯 直接匹配到路径: ${displayPath(direct)}`);
    finish(direct, args);
    return;
  }

  const cfg = useLocal ? null : loadConfig(args);
  // 没有大模型可用时说一声，免得用户以为模型在工作（--list / --pick 保持输出干净，不提示）
  if (!cfg && !args.list && !args.pick) {
    warn(useLocal
      ? "未使用大模型（provider=none），退化为本地关键词搜索"
      : "未找到大模型配置，退化为本地关键词搜索（配置方法见 magic-open --help）");
  }

  // 1.5) 选择记忆：高度相似的描述，先问要不要沿用上次的选择
  if (!args.pick && !args.list && !args.dryRun) {
    const rec = recallChoice(args.query);
    if (rec && process.stdin.isTTY && process.stdout.isTTY) {
      if (await askUseRemembered(rec)) {
        recordChoice(args.query, rec.path); // 刷新时间，方便下次继续命中
        finish(rec.path, args);
        return;
      }
      info("好的，重新挑选：");
    }
  }

  // 2) 生成搜索关键词（先扫一遍常用位置：目录清单供大模型「按名指认」）
  const hints = detectLocationHints(args.query);
  scanCommonRoots(hints);
  let kws = localKeywords(args.query);
  if (cfg) {
    info("🧠 大模型正在理解你的描述…");
    try {
      const out = await llmJSONRetry(cfg, KW_SYSTEM, `用户描述：${args.query}\n\n本机真实存在的目录清单（按最近修改排序，供参考）：\n${inventoryBrief()}`, 1024);
      if (Array.isArray(out.keywords) && out.keywords.length) {
        // LLM 模式只补充 ASCII 词兜底，避免本地中文虚词污染搜索词
        const ascii = kws.filter((k) => /^[A-Za-z0-9_+.-]+$/.test(k));
        kws = [...new Set([...out.keywords.map((k) => String(k).trim()).filter(Boolean), ...ascii])].slice(0, 8);
      }
    } catch (e) {
      warn(`生成搜索关键词失败（${e.message}），改用本地关键词`);
    }
  }
  if (!kws.length) kws = [args.query];

  // 3) 搜索 + 排序（解析时间线索；空结果时换角度补搜一轮）
  info(`🔎 搜索关键词: ${kws.join("、")}`);
  activeWin = parseTimeWindow(args.query);
  if (activeWin) info(`🗓 时间线索: 「${activeWin.label}」≈ ${fmtDate(activeWin.from)} ~ ${fmtDate(activeWin.to)}`);
  HIST_COUNT = buildHistCount();
  let cands = await searchRound(kws, args.query, hints);
  if (!cands.length && cfg) {
    info("🔍 没搜到，让大模型换个角度再生成一批关键词…");
    try {
      const nkws = await regenKeywords(cfg, args.query, kws, []);
      if (nkws.length) {
        kws = [...new Set([...nkws, ...kws])].slice(0, 14);
        info(`🔎 新关键词: ${nkws.join("、")}`);
        cands = await searchRound(kws, args.query, hints);
      }
    } catch { /* 保持为空 */ }
  }
  if (!cands.length) { err("没有找到相关文件夹，换个更具体的描述试试"); process.exit(1); }
  // 展示排序：按匹配可能性从高到低（名称精确 > 名称包含 > 路径包含；内含命中文件、
  // 时间窗口吻合、代码仓库根、历史选中次数均加权）
  let top = cands.slice(0, MAX_CANDIDATES);

  if (args.list) { printTable(top); return; }

  // 4) 大模型挑选（猜测以 3 个选项呈现：回车开 top1，Esc 全否定后排除继续找；拿不准先换角度补搜一轮）
  if (cfg && !args.pick) {
    info("🤖 大模型正在挑选最匹配的目标…");
    try {
      let all = cands;
      let pool = [...top];
      const rejected = [];
      let searchedAgain = false;
      while (pool.length) {
        const ctx = [];
        if (hints.length) ctx.push(`位置线索：用户点名的位置目录：${hints.map(displayPath).join("、")}`);
        if (activeWin) ctx.push(`时间线索：「${activeWin.label}」≈ ${fmtDate(activeWin.from)} ~ ${fmtDate(activeWin.to)}（目录的修改或创建时间在此区间更可能）`);
        const note = rejected.length ? "\n（注意：之前给出的候选都已被用户否定，请在剩余候选中重新选择）" : "";
        const sel = await llmJSONRetry(cfg, SEL_SYSTEM, `用户描述：${args.query}${note}\n${ctx.length ? ctx.join("\n") + "\n\n" : ""}候选列表：\n${formatForLLM(pool)}`, 2048);
        const idx = Number(sel.choice) - 1;
        const chosen = Number.isInteger(idx) && idx >= 0 && idx < pool.length ? pool[idx] : null;
        const conf = Number(sel.confidence ?? 1);
        if (chosen && conf >= 0.5) {
          if (sel.reason) info(`💡 ${sel.reason}`);
          // 猜测结果以 3 个选项呈现：大模型的选择排第一（回车即开），其备选紧随其后，不足 3 个按本地排序补足
          const seenPaths = new Set([chosen.path]);
          const options = [chosen];
          for (const i of (Array.isArray(sel.alternatives) ? sel.alternatives : [])) {
            const c = pool[Number(i) - 1];
            if (c && !seenPaths.has(c.path)) { seenPaths.add(c.path); options.push(c); }
          }
          for (const c of pool) {
            if (options.length >= 3) break;
            if (!seenPaths.has(c.path)) { seenPaths.add(c.path); options.push(c); }
          }
          if (args.yes || !process.stdin.isTTY || !process.stdout.isTTY) {
            // --yes / 非交互终端：跳过选项列表，直接开大模型的 top1
            if (!args.dryRun) recordChoice(args.query, chosen.path); // 脚本场景也算正样本，下次相似描述直接命中
            finish(chosen.path, args);
            return;
          }
          const pick = await pickInteractively(options, `猜是这 ${options.length} 个，选一个（Esc = 都不对，继续找）：`, { pool, cfg, query: args.query });
          if (pick) {
            if (!args.dryRun) recordChoice(args.query, pick.path); // 用户从选项里选出 = 正样本，下次相似描述直接命中
            finish(pick.path, args);
            return;
          }
          // Esc：本轮选项全部否定，排除后让大模型在剩余候选里继续找
          rejected.push(...options.map((c) => c.path));
          pool = pool.filter((c) => !rejected.includes(c.path));
          if (!pool.length) break;
          info(`🔄 这 ${options.length} 个都不对，继续在剩余 ${pool.length} 个候选里找…`);
          if (rejected.length >= 6) { // 两轮 3 选都被否定：不再让大模型挑，直接列出剩余候选
            const pick2 = await pickInteractively(pool, "否定的有点多，剩下的都在这里：", { pool, cfg, query: args.query });
            if (pick2) { recordChoice(args.query, pick2.path); finish(pick2.path, args); return; }
            printTable(pool.slice(0, 10));
            info("已取消");
            return;
          }
          continue;
        }
        // 低置信 / 未选中：先让大模型看着现有候选换角度补搜一轮，有新候选就重新挑
        if (!searchedAgain) {
          searchedAgain = true;
          info("🔍 大模型不太确定，换个角度补搜一轮…");
          let nkws = [];
          try { nkws = await regenKeywords(cfg, args.query, kws, all); } catch { /* 用现有候选 */ }
          if (nkws.length) {
            kws = [...new Set([...kws, ...nkws])].slice(0, 14);
            info(`🔎 新关键词: ${nkws.join("、")}`);
            const fresh = (await searchRound([...nkws, ...kws.filter((k) => !nkws.includes(k))], args.query, hints))
              .filter((c) => !rejected.includes(c.path) && !all.some((o) => o.path === c.path));
            if (fresh.length) {
              all = [...all, ...fresh];
              all.sort((a, b) => localScore(b, kws, hints, activeWin) - localScore(a, kws, hints, activeWin) || b.mtimeMs - a.mtimeMs);
              top = all.slice(0, MAX_CANDIDATES);
              pool = top.filter((c) => !rejected.includes(c.path));
              info(`🔎 补搜新增 ${fresh.length} 个候选，重新挑选…`);
              continue;
            }
          }
          info("没有更多新候选了");
        }
        // 光标式手动选择（按可能性排序：大模型提到的备选优先，最多显示 5 项，第 6 行可输入描述筛选）
        const alts = (Array.isArray(sel.alternatives) ? sel.alternatives : [])
          .map((i) => pool[Number(i) - 1])
          .filter(Boolean);
        const ordered = [...alts, ...pool.filter((c) => !alts.includes(c))];
        const pick = await pickInteractively(ordered, "大模型不太确定，请选择：", { pool: top, cfg, query: args.query });
        if (pick) { recordChoice(args.query, pick.path); finish(pick.path, args); return; }
        printTable(pool);
        info("已取消（可先用 --list 查看全部候选）");
        return;
      }
      err("所有候选都被否定了，换个更具体的描述试试");
      process.exit(1);
    } catch (e) {
      warn(`大模型挑选失败（${e.message}），转为手动选择`);
    }
  }

  // 5) 无大模型 / --pick / 大模型失败 → 手动选择
  const pick = await pickInteractively(top, "请选择要打开的目标：", { pool: top, cfg, query: args.query });
  if (pick) { recordChoice(args.query, pick.path); finish(pick.path, args); return; }
  printTable(top.slice(0, 10));
  if (!process.stdin.isTTY) { err("当前不是交互终端，无法手动选择；可用 --list 查看候选"); process.exit(1); }
  info("已取消");
}

const isEntry = (() => {
  try {
    if (!process.argv[1]) return false;
    // npm link 场景下 argv[1] 是符号链接，需 realpath 后再比较
    return pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url;
  } catch { return false; }
})();
if (isEntry) {
  main().catch((e) => { err(e?.message || String(e)); process.exit(1); });
}

// 供测试导入
export { parseArgs, shellIntegration, INIT_SHELLS, PROVIDERS, loadConfig, localKeywords, collectPaths, keepCandidate, statCandidate, localScore, detectLocationHints, llmJSON, llmJSONRetry, llmText, extractJSON, parseSummaries, relTime, fmtSize, fmtDate, parseTimeWindow, pruneNested, buildHistCount, recordChoice, recallChoice, diceSimilarity, usage, MATCH_TAGS, describeDir, predictTarget };
