// Читает текст постов канала — для изучения формата руководства автора
// и подбора реальных примеров в промпт.
// Запуск из content/crypto_yoda_channel/ (там session.txt):
//   node assets/read-posts.mjs                       # последние 40 постов
//   node assets/read-posts.mjs 100                   # последние 100 постов
//   node assets/read-posts.mjs 40 40                 # следующая страница (limit 40, offset 40)
//   node assets/read-posts.mjs 5890 5776             # конкретные посты по id (число > 1000 считается id)
// Шум телеграм-клиента фильтровать так: node assets/read-posts.mjs | grep -v "resize begin"
import { scrapePage } from "telegram-reader";

const CHANNEL_NAME = "crypto_yoda_channel";

const args = process.argv.slice(2).map(Number).filter(Number.isFinite);
const isIdList = args.length > 0 && args.every((n) => n > 1000);
const [limit = 40, offset = 0] = isIdList ? [] : args;

const found = new Map();
if (isIdList) {
  // листаем страницами вглубь, пока не найдём все id (или не упрёмся в лимит)
  const when = new Date("2027-01-01T00:00:00Z");
  for (let page = 0; page < 6 && found.size < args.length; page++) {
    const batch = await scrapePage({ channel: CHANNEL_NAME, limit: 100, offset: page * 100, when });
    if (!batch.length) break;
    for (const m of batch) if (args.includes(m.id)) found.set(m.id, m);
    if (Math.min(...batch.map((m) => m.id)) < Math.min(...args)) break;
  }
}

const wanted = isIdList
  ? args.map((id) => found.get(id) ?? { id, missing: true })
  : await scrapePage({ channel: CHANNEL_NAME, limit, offset, when: new Date("2027-01-01T00:00:00Z") });

for (const m of wanted) {
  if (m.missing) {
    console.log(`\n=== id=${m.id} НЕ НАЙДЕН в последних 600 постах`);
    continue;
  }
  console.log(`\n=== id=${m.id} date=${m.date.toISOString()} photo=${m.photo ? "YES" : "no"} len=${m.content.length}`);
  console.log(m.content || "(без текста)");
}
process.exit(0);
