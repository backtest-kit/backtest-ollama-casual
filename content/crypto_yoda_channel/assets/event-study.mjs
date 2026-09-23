// Event study по сигналам канала: направленный ход цены после поста
// (и пре-дрифт до поста) по минутным свечам из mongo.
// Так выяснялось, где живёт эдж (у crypto-yoda — 12–24ч) и постит ли автор по тренду.
// Требует: measure-items с прогона (сигналы) и candle-items с --cache (свечи).
// Запуск из любой папки проекта:
//   node assets/event-study.mjs crypto_yoda_entry_v3_5m_0
import mongoose from "mongoose";

const [bucket] = process.argv.slice(2);
if (!bucket) {
  console.log("Использование: node assets/event-study.mjs <bucket>");
  console.log("Список бакетов: node assets/read-cache.mjs");
  process.exit(1);
}

const conn = await mongoose.createConnection("mongodb://localhost:27017/backtest-kit").asPromise();
const db = conn.getClient().db("backtest-kit");
const measures = db.collection("measure-items");
const candles = db.collection("candle-items");

const docs = await measures
  .find({ bucket, "payload.data.entry.position": { $in: ["long", "short"] } })
  .toArray();
const signals = docs.map((d) => ({
  symbol: d.entryKey.split("_")[0],
  ts: parseInt(d.entryKey.split("_")[1]),
  dir: d.payload.data.entry.position,
  post: d.payload.data.entry.id,
}));
console.log(`Сигналов в ${bucket}: ${signals.length}`);

const price = async (symbol, ts) =>
  (await candles.findOne({ symbol, interval: "1m", timestamp: ts }))?.close ?? null;

const HORIZONS = [15, 60, 240, 720, 1440]; // минуты; отрицательные считаются как пре-дрифт
const stats = {};

console.log("\nсигнал\tнаправл.\t" + HORIZONS.map((h) => h + "м").join("\t") + "\t| пре-дрифт: " + HORIZONS.map((h) => "-" + h + "м").join("\t"));
for (const s of signals) {
  const p0 = await price(s.symbol, s.ts);
  if (!p0) { console.log(`${s.symbol}#${s.post}: нет свечи на тике (докачай --cache)`); continue; }
  const row = [];
  for (const sign of [1, -1]) {
    for (const h of HORIZONS) {
      const p1 = await price(s.symbol, s.ts + sign * h * 60_000);
      if (p1 === null) { row.push("-"); continue; }
      // ход в направлении сигнала: вперёд — (p1-p0)/p0, назад — (p0-p1)/p1
      const move = sign > 0 ? ((p1 - p0) / p0) * 100 : ((p0 - p1) / p1) * 100;
      const directional = move * (s.dir === "long" ? 1 : -1);
      row.push(directional.toFixed(2));
      const key = sign * h;
      (stats[key] ??= []).push(directional);
    }
  }
  console.log(`${s.symbol}#${s.post}\t${s.dir}\t` + row.slice(0, 5).join("\t") + "\t| " + row.slice(5).join("\t"));
}

console.log("\n=== сводка (направленный ход, % без плеча) ===");
for (const h of [...HORIZONS, ...HORIZONS.map((x) => -x)]) {
  const v = stats[h];
  if (!v?.length) continue;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const med = v.slice().sort((a, b) => a - b)[Math.floor(v.length / 2)];
  const hit = v.filter((x) => x > 0).length;
  const label = h > 0 ? `+${h}м после` : `${-h}м ДО поста`;
  console.log(`${label}:\tсредн=${mean.toFixed(3)}%\tмедиана=${med.toFixed(3)}%\thit=${hit}/${v.length}`);
}
console.log("\nЧтение: эдж есть там, где после поста hit-rate и среднее растут с горизонтом.");
console.log("Пре-дрифт ~50% hit = автор не просто постит по тренду; высокий пре-дрифт = моментум-эхо.");
process.exit(0);
