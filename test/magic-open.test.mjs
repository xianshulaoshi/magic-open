import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  parseArgs,
  loadConfig,
  llmJSON,
  parseTimeWindow,
  fmtDate,
  localKeywords,
  extractJSON,
  parseSummaries,
  keepCandidate,
  pruneNested,
  collectPaths,
  localScore,
  statCandidate,
  diceSimilarity,
  llmJSONRetry,
  predictTarget,
  shellIntegration,
  INIT_SHELLS,
  usage,
  PROVIDERS,
  MATCH_TAGS,
} from "../bin/magic-open.mjs";

const HOME = os.homedir();
const now = Date.now();

// ---------- 时间线索解析 ----------
test("parseTimeWindow: 今天/昨天/前天", () => {
  const d0 = new Date(now); d0.setHours(0, 0, 0, 0);
  const t = parseTimeWindow("打开我今天写的笔记");
  assert.equal(t.label, "今天");
  assert.equal(fmtDate(t.from), fmtDate(d0.getTime()));

  const y = parseTimeWindow("昨天下载的那个文件夹");
  assert.equal(y.label, "昨天");
  assert.equal(fmtDate(y.from), fmtDate(d0.getTime() - 86400000));

  const b = parseTimeWindow("前天整理的素材");
  assert.equal(b.label, "前天");
});

test("parseTimeWindow: 上周/本周/上个月", () => {
  const w = parseTimeWindow("上周写的周报放在哪个目录");
  assert.equal(w.label, "上周");
  assert.ok(w.to > w.from);
  assert.ok(now - w.from <= 21 * 86400000); // 上周一距现在不超过 3 周

  const tw = parseTimeWindow("这周在做的项目");
  assert.equal(tw.label, "本周");

  const lm = parseTimeWindow("上个月做的图");
  assert.equal(lm.label, "上个月");
});

test("parseTimeWindow: 最近N天 / 3天前 / 无时间词", () => {
  const r3 = parseTimeWindow("最近3天做的demo");
  assert.ok(r3.label.includes("3"));
  assert.ok(now - r3.from <= 4 * 86400000);

  const d3 = parseTimeWindow("3天前写的脚本");
  assert.ok(d3.label.includes("3"));

  assert.equal(parseTimeWindow("帮我找个画图工具"), null);
  assert.equal(parseTimeWindow("crowdfunding demo"), null);
});

// ---------- 关键词与 JSON 解析 ----------
test("localKeywords: 中英文与短词切分", () => {
  const kws = localKeywords("打开我的命令行工具 magic tool");
  assert.ok(kws.includes("magic"));
  assert.ok(kws.includes("tool"));
  assert.ok(kws.some((k) => k.includes("命令行")));
});

test("localKeywords: 短语级中文串滑窗切出子词", () => {
  // 大模型超时退回本地分词时，「优惠券弹窗」也要能切出「弹窗」
  const kws = localKeywords("优惠券弹窗");
  assert.ok(kws.includes("弹窗"));
  assert.ok(kws.includes("优惠"));
});

test("extractJSON: 容忍代码围栏与前后杂文", () => {
  assert.deepEqual(extractJSON('```json\n{"keywords":["a"]}\n```'), { keywords: ["a"] });
  assert.deepEqual(extractJSON('好的，结果：{"choice": 3} 以上。'), { choice: 3 });
  assert.throws(() => extractJSON("完全没有 JSON"));
});

test("parseSummaries: 列表形式兜底解析", () => {
  const out = parseSummaries("1. magic-open：Node 命令行工具\n2. photos：照片素材\n\n备注", 2);
  assert.deepEqual(out, ["Node 命令行工具", "照片素材"]);
});

// ---------- 候选过滤与仓库感知 ----------
test("keepCandidate: 排除噪音路径", () => {
  assert.ok(keepCandidate(path.join(HOME, "Desktop", "工作")));
  assert.ok(!keepCandidate(path.join(HOME, "Library", "Caches", "x")));
  assert.ok(!keepCandidate(path.join(HOME, "a", "node_modules", "b")));
  assert.ok(!keepCandidate(path.join(HOME, "apps", "Foo.app", "Contents")));
  assert.ok(!keepCandidate("/tmp/elsewhere"));
});

test("pruneNested: 仓库根与内部子目录并存时只留仓库根", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "magic-open-test-"));
  try {
    const proj = path.join(tmp, "proj");
    const src = path.join(proj, "src");
    fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
    fs.mkdirSync(src, { recursive: true });
    const mk = (p) => ({ path: p, name: path.basename(p) });
    const out = pruneNested([mk(proj), mk(src)]);
    assert.equal(out.length, 1);
    assert.equal(out[0].path, proj);
    // 仓库根不在候选中时，子目录保留（可能是唯一线索）
    const out2 = pruneNested([mk(src)]);
    assert.equal(out2.length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("pruneNested: package.json 项目根（非 git 仓库）同样生效", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "magic-open-test-"));
  try {
    const proj = path.join(tmp, "proj");
    const bin = path.join(proj, "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(proj, "package.json"), "{}");
    const mk = (p) => ({ path: p, name: path.basename(p) });
    const out = pruneNested([mk(bin), mk(proj)]);
    assert.equal(out.length, 1);
    assert.equal(out[0].path, proj);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("pruneNested: 子目录本身是项目根（monorepo 子项目/楼层）时不被合并进容器", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "magic-open-test-"));
  try {
    const outer = path.join(tmp, "outer");
    const inner = path.join(outer, "inner-floor");
    const src = path.join(inner, "src");
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(outer, "package.json"), "{}"); // 容器是项目根
    fs.writeFileSync(path.join(inner, "package.json"), "{}"); // 子项目也是项目根
    const mk = (p) => ({ path: p, name: path.basename(p) });
    const paths = pruneNested([mk(outer), mk(inner), mk(src)]).map((c) => c.path);
    assert.ok(paths.includes(outer)); // 容器保留
    assert.ok(paths.includes(inner)); // 子项目根也保留
    assert.ok(!paths.includes(src)); // 普通内部子目录仍被合并
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("statCandidate: 带 birthtimeMs", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "magic-open-stat-"));
  try {
    const c = statCandidate(tmp);
    assert.ok(c && c.isDir);
    assert.equal(typeof c.birthtimeMs, "number");
    assert.ok(c.birthtimeMs > 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- 打分 ----------
test("localScore: 内含命中文件 > 普通候选；时间窗口吻合加分", () => {
  const a = { path: path.join(HOME, "Documents", "工作"), name: "工作", mtimeMs: now - 200 * 86400000, birthtimeMs: now - 200 * 86400000 };
  const b = { path: path.join(HOME, "Documents", "misc"), name: "misc", mtimeMs: now - 200 * 86400000, birthtimeMs: now - 200 * 86400000 };
  MATCH_TAGS.set(a.path, new Set(["file:周报.docx"]));
  try {
    const kws = ["周报"];
    const win = { label: "上周", from: now - 10 * 86400000, to: now };
    assert.ok(localScore(a, kws) > localScore(b, kws)); // file: 标记加权
    const aFresh = { ...a, mtimeMs: now - 2 * 86400000 };
    assert.ok(localScore(aFresh, kws, [], win) > localScore(a, kws, [], win)); // 时间吻合加分
  } finally {
    MATCH_TAGS.delete(a.path);
  }
});

test("diceSimilarity: 相同文本为 1，无关为 0", () => {
  assert.equal(diceSimilarity("周报", "周报"), 1);
  assert.equal(diceSimilarity("周报", "zzz"), 0);
});

test("localScore: 重叠关键词不重复计分", () => {
  const a = { path: path.join(HOME, "x", "CrowdFundingProjectList"), name: "crowdfundingprojectlist", mtimeMs: now, birthtimeMs: now };
  const sBoth = localScore(a, ["crowdfunding", "crowd"]);
  const sOne = localScore(a, ["crowdfunding"]);
  assert.equal(sBoth, sOne); // crowd ⊂ crowdfunding，只计一次
});

// ---------- CLI 参数 ----------
test("parseArgs: --dry-run 与常规旗标", () => {
  const a = parseArgs(["桌面上那个项目", "--dry-run"]);
  assert.equal(a.query, "桌面上那个项目");
  assert.equal(a.dryRun, true);
  const b = parseArgs(["周报", "--yes", "--vscode"]);
  assert.equal(b.yes, true);
  assert.equal(b.vscode, true);
  assert.equal(b.dryRun, false);
});

// ---------- 猜测核心（本地模式，不联网） ----------
test("predictTarget: 本地模式下对可命名匹配的描述给出存在的目录", async () => {
  const r = await predictTarget("桌面上那个 magic 项目", { cfg: null });
  assert.equal(r.status, "hit");
  assert.ok(r.path && fs.existsSync(r.path) && fs.statSync(r.path).isDirectory());
  // 关键词能命中 magic-open（本仓库所在目录）
  assert.ok(r.candidates.some((c) => c.path.endsWith("magic-open")));
});

test("collectPaths: 桌面直扫覆盖到第 3 层目录（Spotlight 未索引也能入池）", async () => {
  const repoDir = fs.realpathSync(fileURLToPath(new URL("..", import.meta.url)));
  const binDir = path.join(repoDir, "bin");
  // 直扫只覆盖桌面下 3 层：本仓库克隆在 ~/Desktop/<x>/ 下（bin/ 位于第 3 层以内）时才能验证，否则跳过
  const rel = path.relative(path.join(HOME, "Desktop"), repoDir);
  const depth = rel === "" ? 0 : rel.split(path.sep).length;
  if (rel.startsWith("..") || path.isAbsolute(rel) || depth < 1 || depth + 1 > 3) return;
  MATCH_TAGS.clear();
  const paths = await collectPaths(["magic"], "magic", []);
  // bin/ 不靠 Spotlight，仅靠桌面直扫就应该入池
  assert.ok(paths.some((p) => p === binDir));
});

test("predictTarget: 完全无命中时仍返回结构化结果", async () => {
  const r = await predictTarget("zzz-不存在的目录-qqqxyz", { cfg: null });
  assert.ok(["hit", "abstain", "empty"].includes(r.status));
  assert.ok(Array.isArray(r.kws) && r.kws.length > 0);
});

// ---------- LLM 调用容错（mock fetch，不联网） ----------
test("llmJSONRetry: 坏输出后带提醒+加倍 token 重试一次成功", async () => {
  const realFetch = globalThis.fetch;
  const bodies = [];
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const b = JSON.parse(init.body);
    bodies.push(b);
    const ok = calls >= 2; // 第 1 次输出解释文字（模拟推理截断），第 2 次给 JSON
    const content = ok ? '{"keywords":["x"]}' : "Let me think about the candidates...";
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  try {
    const cfg = { provider: "t", style: "openai", baseUrl: "http://x", model: "m", apiKey: "k" };
    const out = await llmJSONRetry(cfg, "s", "u", 512);
    assert.deepEqual(out, { keywords: ["x"] });
    assert.equal(calls, 2);
    assert.ok(bodies[1].messages[1].content.includes("不是合法 JSON")); // 重试带提醒
    assert.equal(bodies[1].max_tokens, 1024); // 重试加倍 token（治推理截断）
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("llmJSONRetry: 超时立即放弃，不重试", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  // 模拟真实 fetch：监听 abort signal，超时被中断时以 AbortError 拒绝
  globalThis.fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      calls++;
      init.signal.addEventListener("abort", () =>
        reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })),
      );
    });
  try {
    const cfg = { provider: "t", style: "openai", baseUrl: "http://x", model: "m", apiKey: "k", timeoutMs: 1100 };
    const t0 = Date.now();
    await assert.rejects(
      () => llmJSONRetry(cfg, "s", "u", 512),
      (e) => e.name === "AbortError",
    );
    assert.equal(calls, 1); // 只调了一次，没有浪费第二次
    assert.ok(Date.now() - t0 < 3000); // ~1.1s 超时后立刻返回
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("llmJSONRetry: reasoning_effort 参数在网关报错时自动去掉重试", async () => {
  const realFetch = globalThis.fetch;
  const bodies = [];
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const b = JSON.parse(init.body);
    bodies.push(b);
    if (b.reasoning_effort) return { ok: false, status: 400, text: async () => "unknown field reasoning_effort" };
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"keywords":["y"]}' } }] }) };
  };
  try {
    const cfg = { provider: "t", style: "openai", baseUrl: "http://x", model: "m", apiKey: "k", reasoningEffort: "low" };
    const out = await llmJSONRetry(cfg, "s", "u", 512);
    assert.deepEqual(out, { keywords: ["y"] });
    assert.equal(bodies[0].reasoning_effort, "low"); // 首次带加速参数
    assert.ok(!bodies[1].reasoning_effort); // 400 后去掉
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------- --cd：选中目录后切换终端目录 ----------
test("parseArgs: --cd 与 --init", () => {
  const a = parseArgs(["magic 项目", "--cd"]);
  assert.equal(a.query, "magic 项目");
  assert.equal(a.cd, true);
  assert.equal(parseArgs(["magic 项目"]).cd, false);
  const b = parseArgs(["--init", "zsh"]);
  assert.equal(b.init, "zsh");
  assert.equal(b.query, ""); // zsh 被当作 --init 的值吃掉，不会误当成描述
  assert.equal(parseArgs(["x"]).init, null);
});

test("usage: 提到 --cd 与 --init", () => {
  assert.ok(usage().includes("--cd"));
  assert.ok(usage().includes("--init"));
});

test("shellIntegration: zsh / bash 语法检查通过", () => {
  for (const sh of INIT_SHELLS) {
    const src = shellIntegration(sh);
    assert.ok(src.includes("magic-open() {"));
    assert.ok(src.includes('mag() { magic-open "$@"; }')); // 缩写经由同一函数
    const r = spawnSync(sh, ["-n"], { input: src, encoding: "utf8" });
    assert.equal(r.status, 0, `${sh} -n: ${r.stderr}`);
  }
});

// 在真实 shell 里 eval 出 magic-open 函数后调用（command = 实际敲的命令，默认 magic-open）；
// 用桩 open 顶替，不真正打开 Finder
function runWithWrapper(shell, targetDir, extraArgs = [], withWrapper = true, command = "magic-open") {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "magic-open-cd-"));
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "open"), "#!/bin/sh\necho \"[stub open] $*\"\n", { mode: 0o755 });
  const script = fileURLToPath(new URL("../bin/magic-open.mjs", import.meta.url));
  fs.symlinkSync(script, path.join(bin, "magic-open")); // 函数内部用 command magic-open 调用：指向本仓库，不依赖全局是否安装
  const q = (s) => "'" + s.replace(/'/g, `'\\''`) + "'";
  // withWrapper：eval 出 shell 函数后像平时一样调用；否则直接用 node 跑脚本（模拟没装函数的用户）
  const call = withWrapper
    ? `${command} ${q(targetDir)} ${extraArgs.join(" ")}`
    : `${q(process.execPath)} ${q(script)} ${q(targetDir)} ${extraArgs.join(" ")}`;
  const lines = [
    withWrapper ? `eval "$(${q(process.execPath)} ${q(script)} --init ${shell})"` : "",
    `cd /tmp`,
    call,
    `echo "exit=$? pwd=$PWD"`,
  ].filter(Boolean);
  try {
    return spawnSync(shell, ["-c", lines.join("\n")], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

for (const shell of INIT_SHELLS) {
  test(`--cd: 经 shell 函数运行时终端切到选中目录（${shell}）`, { skip: !whichShell(shell) }, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "magic-open-cd-"));
    const target = path.join(tmp, "target dir's"); // 带空格和单引号
    fs.mkdirSync(target);
    try {
      const r = runWithWrapper(shell, target, ["--cd"]);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(r.stdout.includes(`[stub open] ${target}`)); // Finder 照常打开
      assert.ok(r.stdout.endsWith(`exit=0 pwd=${target}\n`), r.stdout); // 终端 cwd 已切换
      // 不带 --cd：行为不变，不切换
      const r2 = runWithWrapper(shell, target);
      assert.equal(r2.status, 0, r2.stderr);
      assert.ok(r2.stdout.endsWith("exit=0 pwd=/tmp\n"), r2.stdout);
      // --dry-run：只展示，不切换
      const r3 = runWithWrapper(shell, target, ["--cd", "--dry-run"]);
      assert.ok(r3.stdout.includes("[dry-run]"), r3.stdout);
      assert.ok(r3.stdout.endsWith("exit=0 pwd=/tmp\n"), r3.stdout);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
}

for (const shell of INIT_SHELLS) {
  test(`mag: 缩写经由 shell 函数同样能切换终端目录（${shell}）`, { skip: !whichShell(shell) }, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "magic-open-cd-"));
    const target = path.join(tmp, "target");
    fs.mkdirSync(target);
    try {
      const r = runWithWrapper(shell, target, ["--cd"], true, "mag");
      assert.equal(r.status, 0, r.stderr);
      assert.ok(r.stdout.includes(`[stub open] ${target}`), r.stdout);
      assert.ok(r.stdout.endsWith(`exit=0 pwd=${target}\n`), r.stdout);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
}

test("mag: 直接作为命令运行（不经 shell 函数）与 magic-open 等价", () => {
  const script = fileURLToPath(new URL("../bin/magic-open.mjs", import.meta.url));
  const a = spawnSync(process.execPath, [script, "--version"], { encoding: "utf8" });
  const b = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8" });
  assert.equal(a.status, 0);
  assert.ok(b.stdout.includes("mag \"描述\""));
});

function whichShell(sh) {
  return spawnSync("which", [sh], { encoding: "utf8" }).status === 0;
}

test("--cd: 未经 shell 函数运行时提示并给出可执行的 cd 命令", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "magic-open-cd-"));
  try {
    const r = runWithWrapper("zsh", tmp, ["--cd"], false);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stderr.includes("需要经由 shell 函数运行"), r.stderr);
    assert.ok(r.stdout.includes(`cd '${tmp}'`), r.stdout);
    assert.ok(r.stdout.endsWith(`exit=0 pwd=/tmp\n`), r.stdout);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- 提供商与密钥配置 ----------
// 临时接管 process.exit 与输出，拿到 loadConfig 的退出码和提示文字而不结束测试进程
function captureExit(fn) {
  const exit = process.exit, log = console.log, error = console.error;
  const out = { code: 0, stdout: "", stderr: "" };
  process.exit = (code) => { throw Object.assign(new Error("process.exit"), { exitCode: code }); };
  console.log = (m) => { out.stdout += `${m}\n`; };
  console.error = (m) => { out.stderr += `${m}\n`; };
  try { fn(); } catch (e) {
    if (e.exitCode === undefined) throw e;
    out.code = e.exitCode;
  } finally { process.exit = exit; console.log = log; console.error = error; }
  return out;
}
const EMPTY_ENV = {}; // 隔离本机的环境变量与 ~/.magic-open.json
const customBase = { file: {}, env: EMPTY_ENV };

test("parseArgs: --api-key 吃掉后面的值", () => {
  const a = parseArgs(["报表", "--api-key", "sk-test", "--provider", "custom"]);
  assert.equal(a.apiKey, "sk-test");
  assert.equal(a.provider, "custom");
  assert.equal(a.query, "报表"); // key 不会被当成描述
  assert.equal(parseArgs(["报表"]).apiKey, null);
});

test("loadConfig: custom 接任意 OpenAI 兼容接口，可免密", () => {
  const c = loadConfig(
    { provider: "custom", baseUrl: "http://127.0.0.1:11434/v1/", model: "qwen3", apiKey: "sk-test" },
    customBase,
  );
  assert.equal(c.provider, "custom");
  assert.equal(c.style, "openai");
  assert.equal(c.baseUrl, "http://127.0.0.1:11434/v1"); // 去掉结尾斜杠
  assert.equal(c.model, "qwen3");
  assert.equal(c.apiKey, "sk-test");
  const noKey = loadConfig({ provider: "custom", baseUrl: "http://127.0.0.1:11434/v1", model: "local" }, customBase);
  assert.equal(noKey.apiKey, undefined); // 不给 key 也放行
});

test("loadConfig: custom 也能写进配置文件", () => {
  const c = loadConfig({}, {
    file: { provider: "custom", baseUrl: "http://gw.example.com/v1", model: "gw-model", apiKey: "k" },
    env: EMPTY_ENV,
  });
  assert.deepEqual([c.provider, c.baseUrl, c.model, c.apiKey], ["custom", "http://gw.example.com/v1", "gw-model", "k"]);
});

test("loadConfig: custom 配置不全时给出明确提示并退出", () => {
  const noUrl = captureExit(() => loadConfig({ provider: "custom", model: "m" }, customBase));
  assert.equal(noUrl.code, 1);
  assert.ok(noUrl.stderr.includes("--base-url"), noUrl.stderr);

  const badUrl = captureExit(() => loadConfig({ provider: "custom", baseUrl: "127.0.0.1:11434/v1", model: "m" }, customBase));
  assert.equal(badUrl.code, 1);
  assert.ok(badUrl.stderr.includes("接口地址无效"), badUrl.stderr);

  const noModel = captureExit(() => loadConfig({ provider: "custom", baseUrl: "http://127.0.0.1:11434/v1" }, customBase));
  assert.equal(noModel.code, 1);
  assert.ok(noModel.stderr.includes("--model"), noModel.stderr);
});

test("loadConfig: 切换提供商时不带走配置文件里另一家的 key / baseUrl / model", () => {
  // 配置文件属于 glm；命令行临时切到 deepseek（密钥在 deepseek 自己的环境变量里）
  const file = { provider: "glm", apiKey: "glm-key", baseUrl: "http://glm-gw/v1", model: "glm-x", reasoningEffort: "low" };
  const switched = loadConfig({ provider: "deepseek" }, { file, env: { DEEPSEEK_API_KEY: "ds-key" } });
  assert.equal(switched.apiKey, "ds-key");
  assert.equal(switched.baseUrl, PROVIDERS.deepseek.baseUrl); // 不会发到 glm 的网关地址
  assert.equal(switched.model, PROVIDERS.deepseek.model);
  assert.equal(switched.reasoningEffort, null);

  // 用的是配置文件里那个提供商：文件里的配置照常生效
  const same = loadConfig({ provider: "glm" }, { file, env: EMPTY_ENV });
  assert.equal(same.apiKey, "glm-key");
  assert.equal(same.baseUrl, "http://glm-gw/v1");
  assert.equal(same.model, "glm-x");
  assert.equal(same.reasoningEffort, "low");

  // 文件里没写 provider：字段视为通用配置，对任何提供商生效
  const generic = loadConfig({ provider: "deepseek" }, { file: { apiKey: "shared-key" }, env: { DEEPSEEK_API_KEY: "ds-key" } });
  assert.equal(generic.apiKey, "shared-key");
});

test("loadConfig: key 的优先级 --api-key > MAGIC_OPEN_API_KEY > 配置文件 > 各家专属变量", () => {
  const file = { provider: "deepseek", apiKey: "file-key" };
  const env = { DEEPSEEK_API_KEY: "env-key", MAGIC_OPEN_API_KEY: "generic-key" };
  assert.equal(loadConfig({ provider: "deepseek", apiKey: "cli-key" }, { file, env }).apiKey, "cli-key");
  assert.equal(loadConfig({ provider: "deepseek" }, { file, env }).apiKey, "generic-key");
  assert.equal(loadConfig({ provider: "deepseek" }, { file, env: { DEEPSEEK_API_KEY: "env-key" } }).apiKey, "file-key");
  assert.equal(loadConfig({ provider: "deepseek" }, { file: {}, env: { DEEPSEEK_API_KEY: "env-key" } }).apiKey, "env-key");
});

test("loadConfig: 内置提供商缺 key 仍然报错退出；未知提供商提示 custom", () => {
  const noKey = captureExit(() => loadConfig({ provider: "deepseek" }, customBase));
  assert.equal(noKey.code, 1);
  assert.ok((noKey.stderr + noKey.stdout).includes("DEEPSEEK_API_KEY"), noKey.stderr + noKey.stdout); // 提示里点名该设哪个变量

  const unknown = captureExit(() => loadConfig({ provider: "my-gateway" }, customBase));
  assert.equal(unknown.code, 1);
  assert.ok(unknown.stderr.includes("未知提供商") && unknown.stdout.includes("--provider custom"), unknown.stdout + unknown.stderr);

  const auto = loadConfig({}, { file: {}, env: { MAGIC_OPEN_API_KEY: "k" } }); // 没有任何可自动识别的提供商
  assert.equal(auto, null);
});

test("loadConfig: custom 没有专属环境变量，不会被自动识别选中", () => {
  const c = loadConfig({}, { file: {}, env: { GLM_API_KEY: "g" } });
  assert.equal(c.provider, "glm");
  assert.equal(c.baseUrl, PROVIDERS.glm.baseUrl);
  assert.equal(c.apiKey, "g");
});

test("loadConfig: custom 不复用 OPENAI_API_KEY；timeoutMs 环境变量优先于配置文件", () => {
  const c = loadConfig(
    { provider: "custom", baseUrl: "http://127.0.0.1:11434/v1", model: "m" },
    { file: {}, env: { OPENAI_API_KEY: "openai-key" } },
  );
  assert.equal(c.apiKey, undefined); // 不把 OpenAI 的 key 发给自填的网关

  const tm = (file, env) => loadConfig({ provider: "custom", baseUrl: "http://x/v1", model: "m" }, { file, env }).timeoutMs;
  assert.equal(tm({ timeoutMs: 5000 }, {}), 5000);
  assert.equal(tm({ timeoutMs: 5000 }, { MAGIC_OPEN_TIMEOUT_MS: 9000 }), 9000);
  assert.equal(tm({}, { MAGIC_OPEN_TIMEOUT_MS: "abc" }), 120000); // 非法值回落到默认
  assert.equal(tm({}, { MAGIC_OPEN_TIMEOUT_MS: "10" }), 120000); // 小于 1 秒视为非法
});

test("llmJSON: 免密请求不带 authorization 头，有 key 时带 Bearer", async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (_url, init) => {
    seen.push(init.headers.authorization);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"keywords":["a"]}' } }] }) };
  };
  try {
    const base = { provider: "custom", style: "openai", baseUrl: "http://x/v1", model: "m" };
    await llmJSON({ ...base }, "s", "u", 64);
    await llmJSON({ ...base, apiKey: "k" }, "s", "u", 64);
    assert.deepEqual(seen, [undefined, "Bearer k"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("usage: 提到 custom 与 --api-key", () => {
  assert.ok(usage().includes("--api-key"));
  assert.ok(usage().includes("custom"));
});
