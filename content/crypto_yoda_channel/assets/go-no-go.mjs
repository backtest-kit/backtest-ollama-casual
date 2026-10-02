// Go/no-go из PLAN_2 раздел 1: разделимость популяций победителей/проигравших
// по дампу бэктеста. Потоковый проход, KS-дистанции по MAE(t)/MFE(t)/pnl(t)
// на контрольных минутах + критическое значение KS (α=0.05).
// Запуск из content/<channel>/:
//   node assets/go-no-go.mjs                                  # дамп по умолчанию
//   node assets/go-no-go.mjs dump/report/backtest.jsonl       # явный путь
// Выход: таблица KS по минутам (вход в паспорт калибровки), минута армирования
// по правилу "KS >= порога на k контрольных минутах подряд".
// ВНИМАНИЕ: на дампе управляемой стратегии (не 24h-сборщика) траектории обрезаны
// её же механизмами — результат индикативен, полноценный go/no-go требует дампа сборщика.
import { createReadStream } from "fs";
import { createInterface } from "readline";

const path = process.argv[2] ?? "dump/report/backtest.jsonl";
const CONTROL = [30, 60, 120, 240, 480, 720, 1080, 1439];
const ALPHA_C = 1.358; // критическое значение KS уровня 0.05: c * sqrt((n+m)/(n*m))
const K_CONSECUTIVE = 2; // демо-k малых выборок; прод-значение 3 (PLAN_2 раздел 1)

const traj = new Map();
const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  const { data } = JSON.parse(line);
  if (data.action === "opened") {
    traj.set(data.signalId, { openTime: data.timestamp, pnl: [], mfe: [], mae: [] });
  } else if (data.action === "active") {
    const tr = traj.get(data.signalId);
    if (!tr) continue;
    const t = Math.round((data.timestamp - tr.openTime) / 60_000);
    tr.pnl[t] = data.pnl;
    tr.mfe[t] = data.peakProfitPercentage;
    tr.mae[t] = data.maxDrawdownPercentage;
  } else if (data.action === "closed") {
    const tr = traj.get(data.signalId);
    if (!tr) continue;
    tr.finalPnl = data.pnl;
    tr.duration = data.duration;
    tr.winner = data.pnl > 0;
  }
}

const all = [...traj.entries()].filter(([, t]) => t.finalPnl !== undefined);
const winners = all.filter(([, t]) => t.winner);
const losers = all.filter(([, t]) => !t.winner);
console.log(`траекторий: ${all.length} (победителей ${winners.length}, проигравших ${losers.length})`);
for (const [id, t] of all) {
  console.log(`  ${id}\tfinal=${t.finalPnl.toFixed(2)}\tduration=${t.duration}м\t${t.winner ? "WIN" : "LOSS"}`);
}
if (!winners.length || !losers.length) {
  console.log("NO-GO тривиально: одна из популяций пуста — разделять нечего.");
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

// значение ряда на минуте t: только живые на t траектории (обрезка дампом честно сужает состав)
const at = (rows, key, t) => rows.map(([, tr]) => tr[key][t]).filter((v) => v !== undefined);

console.log(`\nминута | nW/nL | KS(mae) | KS(mfe) | KS(pnl) | критич.`);
const mfeRun = [];
for (const t of CONTROL) {
  const w = { mae: at(winners, "mae", t), mfe: at(winners, "mfe", t), pnl: at(winners, "pnl", t) };
  const l = { mae: at(losers, "mae", t), mfe: at(losers, "mfe", t), pnl: at(losers, "pnl", t) };
  if (w.mae.length < 2 || l.mae.length < 2) {
    console.log(`${String(t).padStart(6)} | ${w.mae.length}/${l.mae.length} | — живых слишком мало`);
    mfeRun.push({ t, ok: false });
    continue;
  }
  const crit = ALPHA_C * Math.sqrt((w.mae.length + l.mae.length) / (w.mae.length * l.mae.length));
  const kMae = ks(w.mae, l.mae), kMfe = ks(w.mfe, l.mfe), kPnl = ks(w.pnl, l.pnl);
  console.log(`${String(t).padStart(6)} | ${w.mae.length}/${l.mae.length} | ${kMae.toFixed(3)}   | ${kMfe.toFixed(3)}   | ${kPnl.toFixed(3)}   | ${crit.toFixed(3)}`);
  mfeRun.push({ t, ok: kMfe >= crit, kMfe, crit });
}

// минута армирования: KS(mfe) >= критич. на K_CONSECUTIVE контрольных минутах подряд
let arm = null;
for (let i = 0; i + K_CONSECUTIVE <= mfeRun.length; i++) {
  if (mfeRun.slice(i, i + K_CONSECUTIVE).every((r) => r.ok)) { arm = mfeRun[i].t; break; }
}
console.log(arm !== null
  ? `\nGO: устойчивое KS-разделение по MFE, минута армирования = ${arm} (k=${K_CONSECUTIVE})`
  : `\nNO-GO по формальному правилу: KS(mfe) не превышает критическое значение на ${K_CONSECUTIVE} контрольных минутах подряд (на этих n критический порог высок — см. таблицу).`);
process.exit(0);
