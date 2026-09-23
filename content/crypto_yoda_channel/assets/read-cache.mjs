// Инспекция LLM-кеша в MongoDB (measure-items) — проверка качества парсинга
// после тестового прогона (Шаг 3 из CLAUDE.md).
// Запуск из любой папки проекта (нужна только mongo):
//   node assets/read-cache.mjs                          # список бакетов и количество записей
//   node assets/read-cache.mjs crypto_yoda_entry_v3_5m_0   # все не-null ответы модели по бакету
import mongoose from "mongoose";

const conn = await mongoose.createConnection("mongodb://localhost:27017/backtest-kit").asPromise();
const col = conn.getClient().db("backtest-kit").collection("measure-items");

const [bucket] = process.argv.slice(2);

if (!bucket) {
  const buckets = await col.aggregate([{ $group: { _id: "$bucket", count: { $sum: 1 } } }]).toArray();
  console.log("Бакеты в measure-items:");
  for (const b of buckets) console.log(`  ${b._id}: ${b.count} записей`);
  process.exit(0);
}

const docs = await col
  .find({ bucket, "payload.data.entry": { $ne: null } })
  .sort({ entryKey: 1 })
  .toArray();

console.log(`Бакет ${bucket}: ${await col.countDocuments({ bucket })} записей, из них не-null ответов модели: ${docs.length}\n`);
for (const d of docs) {
  const e = d.payload.data.entry;
  const [symbol, ts] = d.entryKey.split("_");
  const when = new Date(parseInt(ts)).toISOString().slice(0, 16);
  const from = e.entryRange?.from ?? e.entryFrom;
  const to = e.entryRange?.to ?? e.entryTo;
  console.log([symbol, when, e.position, `post=${e.id}`, `${from}-${to}`, `sl=${e.stoploss}`, `targets=[${e.targets}]`].join("\t"));
  console.log(`  ${e.reasoning}\n`);
}
process.exit(0);
