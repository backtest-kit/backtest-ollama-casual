// Валидация промпта wallstreet_queen на реальных постах канала.
// Запуск из content/wallstreet_queen_channel/ (там session.txt и prompt.mustache):
//   node assets/validate.mjs
// Прогоняет точный пайплайн стратегии (схема + промпт + сборка messages)
// по обязательным кейсам: сигнальный пост, отчёт о результате, новость-аналитика.
// ВНИМАНИЕ: кейсы привязаны к id постов (сентябрь 2026) — если канал
// уехал далеко вперёд, обнови id на свежие через assets/read-posts.mjs.
import { scrapePage } from "telegram-reader";
import { generateObject, InferenceName } from "json-inference";
import { str, memoize } from "functools-kit";
import { readFile } from "fs/promises";
import Mustache from "mustache";

const CHANNEL_NAME = "WallstreetQueenOfficial";

const TradingPositionFormat = {
  type: "object",
  required: ["id", "symbol", "position", "entryRange", "targets", "stoploss", "reasoning"],
  properties: {
    id: { type: "number", description: str.newline("ID сообщения из которого был сформирован сигнал.", "Это число, пиши только его без строкового префикса ID, например, 2134.", "Если сигнала нет, верни -1") },
    symbol: { type: "string", description: str.newline("Тикер позиции строго в формате *USDT, Например", "Текст #CHZUSDT преобразуем в CHZUSDT без #") },
    position: { type: "string", enum: ["long", "short", "wait"], description: str.newline("Тип позиции из поля Direction, long или short.", "Если позиции нет, верни wait") },
    entryRange: {
      type: "object",
      description: str.newline("Диапазон входа в позицию, например для 'Entry: 0.01598$ - 0.01540$'", "верни from=0.01598, to=0.01540. Если сигнала нет, верни from=0 и to=0"),
      required: ["from", "to"],
      properties: {
        from: { type: "number", description: "Первая цена диапазона входа" },
        to: { type: "number", description: "Вторая цена диапазона входа" },
      },
    },
    targets: { type: "array", description: str.newline("Цели позиции из поля Targets, обычно 5 уровней (бывает от 2 до 7), числа.", "Если сигнала нет, верни []"), items: { type: "number" } },
    stoploss: { type: "number", description: "СТОП ЛОСС из поля Stoploss, одна точка хард стоп. Если сигнала нет, верни 0" },
    reasoning: { type: "string", description: str.newline("Строковое описание почему ты сделал именно такое решение", "Будет использовано программистом для отладки") },
  },
};

const getPrompt = memoize(
  ([symbol]) => `${symbol}`,
  async (symbol) => Mustache.render(await readFile("./prompt.mustache", "utf-8"), { symbol }),
);

// Вглубь истории ходим НЕ offset-пагинацией (внутри scrapePage итератор,
// offset даёт квадратичные чтения), а точечными вызовами с when у нужной даты.
const byId = new Map();
const put = (ms) => { for (const m of ms) byId.set(m.id, m); };
console.log(`[${new Date().toISOString()}] скрейп свежих постов (сентябрь 2026)...`);
put(await scrapePage({ channel: CHANNEL_NAME, limit: 120, offset: 0, when: new Date("2027-01-01T00:00:00Z") }));
console.log(`[${new Date().toISOString()}] скрейп шорт-поста (июль 2026)...`);
put(await scrapePage({ channel: CHANNEL_NAME, limit: 15, offset: 0, when: new Date("2026-07-29T00:00:00Z") }));
console.log(`[${new Date().toISOString()}] скрейп готов, постов в индексе: ${byId.size}`);

let failed = 0;

const run = async (symbol, ids, expect) => {
  const posts = ids.map((id) => byId.get(id)).filter(Boolean);
  if (posts.length !== ids.length) { console.log(`SKIP ${symbol} posts=[${ids}]: посты не найдены (обнови id)`); return; }
  const entry = await generateObject(
    InferenceName.OllamaInference,
    {
      format: TradingPositionFormat,
      messages: [
        { role: "user", content: await getPrompt(symbol) },
        ...posts.map(({ id, channel, date, content }) => ({
          role: "user",
          content: str.newline(`ID ${id}`, "", content, "", `[${date.toISOString()}]: https://t.me/${channel}/${id}`),
        })),
      ],
    },
    "gemma4:31b-cloud",
  );
  const checks = [
    ["position", entry.position === expect.position],
    ...(expect.id !== undefined ? [["id", entry.id === expect.id]] : []),
    ...(expect.entryFrom !== undefined ? [["entryRange.from", entry.entryRange.from === expect.entryFrom]] : []),
    ...(expect.stoploss !== undefined ? [["stoploss", entry.stoploss === expect.stoploss]] : []),
    ...(expect.targetsLen !== undefined ? [["targets.length", entry.targets.length === expect.targetsLen]] : []),
    ...(expect.targetsNumeric ? [["targets are numbers", entry.targets.every((t) => typeof t === "number")]] : []),
  ];
  const bad = checks.filter(([, ok]) => !ok);
  if (bad.length) failed++;
  console.log(`${bad.length ? "FAIL" : "PASS"} ${symbol} posts=[${ids}] -> ${entry.position} id=${entry.id}` +
    (bad.length ? ` (провалено: ${bad.map(([n]) => n).join(", ")})` : ""));
  if (bad.length) console.log("  получено:", JSON.stringify(entry));
};

// сигнальный пост: диапазон + 5 целей + стоп
await run("CHZUSDT", [10371], { position: "long", id: 10371, entryFrom: 0.01598, stoploss: 0.0152, targetsLen: 5, targetsNumeric: true });
// отчёт "Target done" -> wait
await run("CHZUSDT", [10372], { position: "wait" });
// новость-аналитика "#DOGEUSDT UPDATE" без входа -> wait
await run("DOGEUSDT", [10374], { position: "wait" });
// сигнал по чужой монете -> wait (CHZ-лонг при запросе ETHUSDT)
await run("ETHUSDT", [10371], { position: "wait" });
// сигнал с шестью целями по своему символу -> long
await run("ETHUSDT", [10347], { position: "long", id: 10347, entryFrom: 2640, stoploss: 2500, targetsLen: 6, targetsNumeric: true });
// шорт с 7 целями и аннотациями "(Enter partially)" / "(Short term)" -> short, аннотации не числа
await run("DASHUSDT", [10159], { position: "short", id: 10159, entryFrom: 32.7, stoploss: 34, targetsLen: 7, targetsNumeric: true });

console.log(failed ? `\n${failed} FAIL` : "\nALL PASS");
process.exit(failed ? 1 : 0);
