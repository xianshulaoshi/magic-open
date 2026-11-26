#!/usr/bin/env node
/**
 * magic-open 猜测效果评测台
 *
 * 你出题 → 程序用当前代码猜目录 → 你判对错 → 记录 good/bad case → 统计正确率。
 * 积累的 case（eval/cases.json）用于回头修正 magic-open 的排序与提示词，持续提高命中率。
 *
 * 用法:
 *   node eval/eval.mjs            交互评测（输入描述，看猜测，按 y/n 判卷）
 *   node eval/eval.mjs --stats    只看统计与 bad case 清单
 *   npm run eval / npm run eval -- --stats
 *
 * 判卷规则:
 *   y = 猜对了（good case）
 *   n = 猜错了（bad case；会追问正确目标，可填候选序号或路径）
 *   回车 = 跳过，不计入
 *
 * 也支持管道喂题（自动化测试）: printf '描述\ny\nq\n' | node eval/eval.mjs
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { predictTarget, describeDir } from "../bin/magic-open.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CASES_PATH = path.join(HERE, "cases.json");
const HOME = os.homedir();

// 代码指纹：被测代码 bin/magic-open.mjs 的内容哈希（前 8 位）。
// 每条 case 记录判卷时的指纹，--stats 按指纹分组统计——
// 代码改动后新跑的评测自动与旧结果分开算命中率，不用人工对时间戳。
function codeRev() {
  try {
    return createHash("sha256").update(fs.readFileSync(path.join(HERE, "..", "bin", "magic-open.mjs"))).digest("hex").slice(0, 8);
  } catch { return "unknown"; }
}

const short = (p) => (p === HOME ? "~" : p.startsWith(HOME + "/") ? "~" + p.slice(HOME.length) : p);
const expand = (p) => (p.startsWith("~") ? path.join(HOME, p.slice(1)) : path.resolve(p));

function loadCases() {
  try { return JSON.parse(fs.readFileSync(CASES_PATH, "utf8")); } catch { return []; }
}
function saveCases(cases) {
  fs.writeFileSync(CASES_PATH, JSON.stringify(cases, null, 2));
}

function pct(a, b) { return b ? `${(100 * a / b).toFixed(1)}%` : "—"; }

function printStats(cases) {
  const judged = cases.filter((c) => c.judged);
  if (!judged.length) { console.log("还没有已评判的 case，先跑几题：npm run eval"); return; }
  const good = judged.filter((c) => c.correct);
  const bad = judged.filter((c) => !c.correct);
  const abstain = judged.filter((c) => c.status !== "hit");
  console.log(`\n📊 评测统计（${CASES_PATH}）`);
  console.log(`  已评判: ${judged.length}`);
  console.log(`  猜对:   ${good.length}`);
  console.log(`  猜错:   ${bad.length}`);
  console.log(`  其中「没敢猜/无候选」: ${abstain.length}`);
  console.log(`  命中率: ${good.length}/${judged.length} = ${pct(good.length, judged.length)}`);

  // 按代码指纹分组：旧结果（改动前）与新结果（改动后）分开算，互不稀释
  const rev = codeRev();
  const groups = new Map();
  for (const c of judged) {
    const k = c.code ?? "";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  const rows = [...groups.entries()].sort((a, b) =>
    String(b[1][b[1].length - 1]?.ts ?? "").localeCompare(String(a[1][a[1].length - 1]?.ts ?? "")));
  if (rows.length > 1 || rows[0]?.[0] !== rev) {
    console.log(`\n🧬 按代码版本分组（当前代码指纹: ${rev}）:`);
    for (const [k, list] of rows) {
      const g = list.filter((c) => c.correct).length;
      const label = k === rev ? `${k} ← 当前代码` : k || "（未标记：加代码指纹之前的旧评测）";
      console.log(`  ${label}: ${g}/${list.length} = ${pct(g, list.length)}`);
    }
  }
  if (bad.length) {
    console.log(`\n❌ Bad cases（修正线索）:`);
    bad.forEach((c, i) => {
      console.log(`  ${i + 1}. 「${c.query}」`);
      console.log(`     猜测: ${c.predicted ? short(c.predicted) : `（${c.status}: ${c.reason ?? ""}）`}`);
      console.log(`     正确: ${c.intended ? short(c.intended) : "（未提供）"}`);
      console.log(`     关键词: ${(c.kws ?? []).join("、")}${c.win ? ` | 时间线索: ${c.win}` : ""}`);
      console.log(`     top5: ${(c.candidates ?? []).map(short).join("  ")}`);
    });
  }
  if (good.length) {
    console.log(`\n✅ Good cases:`);
    good.forEach((c, i) => console.log(`  ${i + 1}. 「${c.query}」→ ${short(c.predicted)}`));
  }
}

function showCandidates(cands) {
  cands.slice(0, 5).forEach((p, i) => {
    let desc = "";
    try { desc = describeDir(p); } catch { /* 忽略 */ }
    console.log(`     ${i + 1}. 📁 ${short(p)}${desc ? `  (${desc})` : ""}`);
  });
  if (cands.length > 5) console.log(`     …共 ${cands.length} 个候选`);
}

// 带缓冲的行读取：预测等待大模型的几秒里提前到达的行先进队列，不会丢
function makeAsk() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const buffer = [];
  const waiters = [];
  let closed = false;
  rl.on("line", (line) => {
    const w = waiters.shift();
    if (w) w(line); else buffer.push(line);
  });
  rl.on("close", () => {
    closed = true;
    while (waiters.length) waiters.shift()(undefined);
  });
  return function ask(prompt) {
    process.stdout.write(prompt);
    if (buffer.length) return Promise.resolve(buffer.shift());
    if (closed) return Promise.resolve(undefined);
    return new Promise((resolve) => waiters.push(resolve));
  };
}

async function main() {
  if (process.argv.includes("--stats")) { printStats(loadCases()); return; }

  const ask = makeAsk();
  const cases = loadCases();
  const rev = codeRev();
  console.log("🎯 magic-open 评测台 — 输入一句描述，程序来猜目录，你来判卷");
  console.log(`   代码指纹: ${rev}（每条记录会带上它，--stats 按代码版本分组统计）`);
  console.log("   判卷: y=对  n=错  回车=跳过；输入 q 退出并看统计");
  console.log("   已开启低思考模式（reasoning_effort=low）加速模型；每题通常 5~15 秒\n");

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const rawQ = await ask("描述（q 退出）> ");
    if (rawQ === undefined) break; // 输入流结束
    const q = String(rawQ).trim();
    if (!q) continue;
    if (q === "q" || q === "Q" || q === "quit") break;

    let r;
    const t0 = Date.now();
    try {
      r = await predictTarget(q, { onStage: (m) => console.log(`   ${m}`) });
    } catch (e) {
      console.error(`⚠️ 预测失败: ${e.message}`);
      continue;
    }
    const dur = ((Date.now() - t0) / 1000).toFixed(1);

    console.log(`\n🔎 关键词: ${r.kws.join("、")}${r.win ? `  🗓 ${r.win.label}` : ""}  ⏱ ${dur}s`);
    if (r.status === "hit") {
      console.log(`\n🎯 猜测: ${short(r.path)}${r.confidence != null ? `（置信度 ${r.confidence}）` : ""}`);
      if (r.reason) console.log(`💡 ${r.reason}`);
    } else if (r.status === "fallback") {
      console.log(`\n⚡ 模型超时/未决，按本地排序给出: ${short(r.path)}（低置信，仍可判分）`);
      if (r.reason) console.log(`💡 ${r.reason}`);
    } else if (r.status === "abstain") {
      console.log(`\n🤔 没敢猜（${r.reason}），候选有：`);
      showCandidates(r.candidates.map((c) => c.path));
    } else {
      console.log("\n❌ 没有找到任何候选");
    }

    const rawAns = await ask("\n猜对了吗？(y/n，回车跳过) > ");
    if (rawAns === undefined) break; // 输入流结束
    const ans = String(rawAns).trim().toLowerCase();
    if (!ans || !["y", "n", "yes", "no"].includes(ans)) continue;
    const correct = ans.startsWith("y");

    let intended = null;
    if (!correct && r.candidates.length) {
      const w = String((await ask("正确目标是？（候选序号或路径，回车=不确定）> ")) ?? "").trim();
      if (w) {
        const byIdx = (r.candidates[Number(w) - 1] ?? {}).path;
        const p = byIdx ?? expand(w);
        try { fs.statSync(p); intended = p; } catch { console.log("   路径不存在，按「不确定」记录"); }
      }
    }

    cases.push({
      ts: new Date().toISOString(),
      code: rev, // 判卷时的代码指纹，--stats 按它区分改动前/后的评测
      query: q,
      status: r.status,
      predicted: r.path,
      reason: r.reason,
      confidence: r.confidence,
      kws: r.kws,
      win: r.win ? r.win.label : null,
      correct,
      judged: true,
      intended,
      candidates: r.candidates.slice(0, 5).map((c) => c.path),
    });
    saveCases(cases);

    const judged = cases.filter((c) => c.judged);
    const g = judged.filter((c) => c.correct).length;
    console.log(`   已记录（${correct ? "✅ good" : "❌ bad"}）｜当前命中率 ${g}/${judged.length} = ${pct(g, judged.length)}`);
  }
  printStats(cases);
  process.exit(0); // 关闭 readline，避免等待残留监听
}

main();
