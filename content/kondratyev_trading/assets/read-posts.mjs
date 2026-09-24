// Читает текст постов канала — для изучения формата руководства автора
// и подбора реальных примеров в промпты.
// Запуск из content/kondratyev_trading/ (там session.txt):
//   node assets/read-posts.mjs                       # последние 40 постов
//   node assets/read-posts.mjs 100                   # последние 100 постов
//   node assets/read-posts.mjs 40 40                 # следующая страница (limit 40, offset 40)
//   node assets/read-posts.mjs 3573 3564             # конкретные посты по id (число > 1000 считается id)
// Шум телеграм-клиента фильтровать так: node assets/read-posts.mjs | grep -v "resize begin"
import { scrapePage } from "telegram-reader";

const CHANNEL_NAME = "-1002199975612";

const args = process.argv.slice(2).map(Number).filter(Number.isFinite);
const isIdList = args.length > 0 && args.every((n) => n > 1000);
const [limit = 40, offset = 0] = isIdList ? [] : args;

const messages = await scrapePage({
  channel: CHANNEL_NAME,
  limit: isIdList ? Math.max(...args.map(() => 200), 200) : limit,
  offset: isIdList ? 0 : offset,
  when: new Date("2027-01-01T00:00:00Z"),
});

const wanted = isIdList
  ? args.map((id) => messages.find((m) => m.id === id) ?? { id, missing: true })
  : messages;

for (const m of wanted) {
  if (m.missing) {
    console.log(`\n=== id=${m.id} НЕ НАЙДЕН в последних 200 постах`);
    continue;
  }
  console.log(`\n=== id=${m.id} date=${m.date.toISOString()} photo=${m.photo ? "YES" : "no"} len=${m.content.length}`);
  console.log(m.content || "(без текста — вероятно, продолжение альбома)");
}
process.exit(0);
