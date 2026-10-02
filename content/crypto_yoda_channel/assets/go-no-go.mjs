// assets/go-no-go.mjs — по-механизменная разделимость популяций по дампу (PLAN_3, раздел 1/F).
// Потоковый проход, KS по MAE(t)/MFE(t)/pnl(t) + критическое значение (α=0.05).
//   node assets/go-no-go.mjs [dump/report/backtest.jsonl]
// Диагностика: разметка по closed.pnl БЕЗ ликвидационного кэпа (полная — у компилятора);
// truncated = closeReason === "stop_loss" (обрезка стопом сборщика); полноту duration
// (= количество тиков, §3) проверяет компилятор. На дампе управляемой стратегии
// результат индикативен: её механизмы цензурируют траектории.
import { createReadStream } from "fs";
import { createInterface } from "readline";

const path = process.argv[2] ?? "dump/report/backtest.jsonl";
const CONTROL = [30, 60, 120, 240, 480, 720, 1080, 1439];
const ALPHA_C = 1.358;
const K_CONSECUTIVE = 2; // демо-k; прод-значение 3 (раздел 1)

const traj = new Map();
const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  const { data } = JSON.parse(line);
  if (data.action === "opened") {
    traj.set(data.signalId, { openTime: data.openTime ?? data.timestamp, pnl: [], mfe: [], mae: [] });
  } else if (data.action === "active") {
    const tr = traj.get(data.signalId);
    if (!tr) continue;
    const t = Math.round((data.timestamp - tr.openTime) / 60_000);
    tr.pnl[t] = data.pnl; tr.mfe[t] = data.peakProfitPercentage; tr.mae[t] = data.maxDrawdownPercentage;
  } else if (data.action === "closed") {
    const tr = traj.get(data.signalId);
    if (!tr) continue;
    tr.finalPnl = data.pnl;
    tr.truncated = data.closeReason === "stop_loss";
    tr.winner = !tr.truncated && data.pnl > 0;
  }
}

const labeled = [...traj.entries()].filter(([, t]) => t.finalPnl !== undefined && !t.truncated);
const truncated = [...traj.values()].filter((t) => t.truncated).length;
const winners = labeled.filter(([, t]) => t.winner);
const losers = labeled.filter(([, t]) => !t.winner);
console.log(`траекторий: ${traj.size} (размечено ${labeled.length}: ${winners.length} WIN / ${losers.length} LOSS; truncated: ${truncated})`);
if (!winners.length || !losers.length) {
  console.log("NO-GO тривиально: одна из популяций пуста.");
  process.exit(1);
}

const ks = (xs, ys) => {
  let d = 0;
  for (const p of [...xs, ...ys].sort((a, b) => a - b)) {
    const fx = xs.filter((v) => v <= p).length / xs.length;
    const fy = ys.filter((v) => v <= p).length / ys.length;
    d = Math.max(d, Math.abs(fx - fy));
  }
  return d;
};
const at = (rows, key, t) => rows.map(([, tr]) => tr[key][t]).filter((v) => v !== undefined);

console.log(`\nминута | nW/nL | KS(mae) | KS(mfe) | KS(pnl) | критич.`);
const maeRun = [], mfeRun = [];
for (const t of CONTROL) {
  const w = { mae: at(winners, "mae", t), mfe: at(winners, "mfe", t), pnl: at(winners, "pnl", t) };
  const l = { mae: at(losers, "mae", t), mfe: at(losers, "mfe", t), pnl: at(losers, "pnl", t) };
  if (w.mae.length < 2 || l.mae.length < 2) {
    console.log(`${String(t).padStart(6)} | ${w.mae.length}/${l.mae.length} | — живых слишком мало`);
    maeRun.push({ t, ok: false }); mfeRun.push({ t, ok: false });
    continue;
  }
  const crit = ALPHA_C * Math.sqrt((w.mae.length + l.mae.length) / (w.mae.length * l.mae.length));
  const kMae = ks(w.mae, l.mae), kMfe = ks(w.mfe, l.mfe), kPnl = ks(w.pnl, l.pnl);
  console.log(`${String(t).padStart(6)} | ${w.mae.length}/${l.mae.length} | ${kMae.toFixed(3)}   | ${kMfe.toFixed(3)}   | ${kPnl.toFixed(3)}   | ${crit.toFixed(3)}`);
  maeRun.push({ t, ok: kMae >= crit }); mfeRun.push({ t, ok: kMfe >= crit });
}

const runOf = (arr) => {
  for (let i = 0; i + K_CONSECUTIVE <= arr.length; i++)
    if (arr.slice(i, i + K_CONSECUTIVE).every((r) => r.ok)) return arr[i].t;
  return null;
};
const floorGo = runOf(maeRun), lockArm = runOf(mfeRun);
console.log(`\nпол (MAE):  ${floorGo !== null ? `GO, разделение с минуты ${floorGo}` : "NO-GO формально"}`);
console.log(`лок (MFE):  ${lockArm !== null ? `GO, минута армирования ${lockArm}` : "NO-GO: не армируется"}`);
console.log(floorGo === null && lockArm === null
  ? "КАНАЛ: no-go — ни один механизм не видит разделения (на малых n критический порог высок)."
  : "КАНАЛ: go по механизмам выше; выключенные — вердикт механизму, не каналу.");
process.exit(0);
