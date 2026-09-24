// Инспекция LLM-кеша канала в MongoDB (measure-items) — проверка вердиктов модели
// после прогона и диагностика загрязнения бакета чужими прогонами.
// Схема payload этого канала: { signal: { id, symbol, position|action, reasoning }, message, url }.
// Запуск из любой папки проекта (нужна только mongo):
//   node assets/read-cache.mjs                                  # список бакетов и количество записей
//   node assets/read-cache.mjs kondratyev_trading_open_v2_5m_0  # все не-null вердикты бакета
// В выводе есть createDate (реальное время записи): если в одном бакете видны сильно
// разные createDate или чужие символы/id постов — бакет загрязнён другим прогоном
// под тем же именем кеша. Лечение: deleteMany по createDate или новое имя кеша.
import mongoose from "mongoose";

const conn = await mongoose.createConnection("mongodb://localhost:27017/backtest-kit").asPromise();
const col = conn.getClient().db("backtest-kit").collection("measure-items");

const [bucket] = process.argv.slice(2);

if (!bucket) {
  const buckets = await col.aggregate([
    { $group: { _id: "$bucket", n: { $sum: 1 }, minCreate: { $min: "$createDate" }, maxCreate: { $max: "$createDate" } } },
    { $sort: { _id: 1 } },
  ]).toArray();
  console.log("Бакеты в measure-items (createDate min..max — прогоны, писавшие в бакет):");
  for (const b of buckets) {
    console.log(`  ${b._id}: ${b.n} записей, createDate ${b.minCreate?.toISOString().slice(0, 16)} .. ${b.maxCreate?.toISOString().slice(0, 16)}`);
  }
  process.exit(0);
}

const docs = await col
  .find({ bucket, "payload.data.signal": { $ne: null } })
  .sort({ entryKey: 1 })
  .toArray();

console.log(`Бакет ${bucket}: всего ${await col.countDocuments({ bucket })} записей, из них не-null вердиктов: ${docs.length}\n`);
for (const d of docs) {
  const s = d.payload.data.signal;
  const [symbol, ts] = d.entryKey.split("_");
  const when = new Date(parseInt(ts)).toISOString().slice(0, 16);
  const verdict = s.position ?? s.action;
  console.log([symbol, `тик=${when}`, verdict, `post=${s.id}`, `createDate=${d.createDate.toISOString().slice(0, 16)}`].join("\t"));
  console.log(`  ${s.reasoning}\n`);
}
process.exit(0);
