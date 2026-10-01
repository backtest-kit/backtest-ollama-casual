// Скачивает фото постов канала в jpg-файлы, чтобы посмотреть их глазами
// перед написанием правил промпта (не выдумываем, что на картинках).
// Запуск из content/wallstreet_queen_channel/ (там session.txt):
//   node assets/download-photos.mjs 10371 10369      # конкретные id постов
//   node assets/download-photos.mjs                  # все фото из последних 40 постов
// Файлы сохраняются как photo_<id>.tmp.jpg рядом — посмотреть и удалить.
import { scrapePage } from "telegram-reader";
import { writeFile } from "fs/promises";

const CHANNEL_NAME = "WallstreetQueenOfficial";

const ids = process.argv.slice(2).map(Number).filter(Number.isFinite);

const messages = await scrapePage({
  channel: CHANNEL_NAME,
  limit: 40,
  offset: 0,
  when: new Date("2027-01-01T00:00:00Z"),
});

const wanted = ids.length
  ? ids.map((id) => messages.find((m) => m.id === id) ?? { id, photo: null })
  : messages.filter((m) => m.photo);

for (const m of wanted) {
  if (!m.photo) {
    console.log(m.id, "нет фото (или пост не найден в последних 40)");
    continue;
  }
  await writeFile(`photo_${m.id}.tmp.jpg`, Buffer.from(m.photo, "base64"));
  console.log(m.id, `сохранён photo_${m.id}.tmp.jpg`, `(${m.content ? "текст: " + m.content.slice(0, 60) : "без текста"})`);
}
process.exit(0);
