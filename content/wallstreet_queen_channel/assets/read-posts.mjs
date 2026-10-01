// Читает текст постов канала — для изучения формата руководства автора
// и подбора реальных примеров в промпт.
// Запуск из content/wallstreet_queen_channel/ (там session.txt):
//   node assets/read-posts.mjs                       # последние 40 постов
//   node assets/read-posts.mjs 100                   # последние 100 постов
//   node assets/read-posts.mjs 10371 10372           # конкретные посты по id (число > 1000 считается id)
// ВАЖНО: батчинг внутри scrapePage — зовём его ОДИН раз с нужным limit.
// Offset-пагинация снаружи заставляет либу повторно проходить историю и
// заново качать фото каждого пройденного поста (у этого канала фото почти везде).
// Шум телеграм-клиента фильтровать так: node assets/read-posts.mjs | grep -v "resize begin"
import { scrapePage } from "telegram-reader";

const CHANNEL_NAME = "WallstreetQueenOfficial";

const args = process.argv.slice(2).map(Number).filter(Number.isFinite);
const isIdList = args.length > 0 && args.every((n) => n > 1000);
const [limit = 40] = isIdList ? [] : args;

// режим id: один глубокий проход, из него выбираем нужные посты
const wanted = isIdList
  ? await (async () => {
      const batch = await scrapePage({ channel: CHANNEL_NAME, limit: 400, offset: 0, when: new Date("2027-01-01T00:00:00Z") });
      return args.map((id) => batch.find((m) => m.id === id) ?? { id, missing: true });
    })()
  : await scrapePage({ channel: CHANNEL_NAME, limit, offset: 0, when: new Date("2027-01-01T00:00:00Z") });

for (const m of wanted) {
  if (m.missing) {
    console.log(`\n=== id=${m.id} НЕ НАЙДЕН в последних 400 постах`);
    continue;
  }
  console.log(`\n=== id=${m.id} date=${m.date.toISOString()} photo=${m.photo ? "YES" : "no"} len=${m.content.length}`);
  console.log(m.content || "(без текста)");
}
process.exit(0);
