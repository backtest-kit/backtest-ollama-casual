// Валидация промпта crypto_yoda на реальных постах канала.
// Запуск из content/crypto_yoda_channel/ (там session.txt и prompt.mustache):
//   node assets/validate.mjs
// Прогоняет точный пайплайн стратегии (схема + промпт + сборка messages)
// по обязательным кейсам: сигнальный пост и отчёт о результате.
// ВНИМАНИЕ: кейсы привязаны к id постов (август-сентябрь 2026) — если канал
// уехал далеко вперёд, обнови id на свежие через assets/read-posts.mjs.
import { scrapePage } from "telegram-reader";
import { generateObject, InferenceName } from "json-inference";
import { str, memoize } from "functools-kit";
import { readFile } from "fs/promises";
import Mustache from "mustache";

const CHANNEL_NAME = "crypto_yoda_channel";

const TradingPositionFormat = {
  type: "object",
  required: ["id", "symbol", "position", "entryRange", "targets", "stoploss", "reasoning"],
  properties: {
    id: { type: "number", description: str.newline("ID сообщения из которого был сформирован сигнал.", "Это число, пиши только его без строгового префикса ID, например, 2134.", "Если сигнала нет, верни -1") },
    symbol: { type: "string", description: str.newline("Тикер позиции строго в формате *USDT, Например", "Текст #BTC/USDT преобразуем в BTCUSDT без # и /") },
    position: { type: "string", enum: ["long", "short", "wait"], description: "Тип позиции, long или short. Если позиции нет, верни wait" },
    entryRange: {
      type: "object",
      description: str.newline("Диапазон входа в позицию, например для 'в диапазоне $78600 - $79400'", "верни from=78600, to=79400. Если сигнала нет, верни from=0 и to=0"),
      required: ["from", "to"],
      properties: {
        from: { type: "number", description: "Цена входа ОТ" },
        to: { type: "number", description: "Цена входа ДО" },
      },
    },
    targets: { type: "array", description: "Цели позиции, 5 уровней, числа. Если сигнала нет, верни []", items: { type: "number" } },
    stoploss: { type: "number", description: "СТОП ЛОСС, одна точка хард стоп. Если сигнала нет, верни 0" },
    reasoning: { type: "string", description: str.newline("Строковое описание почему ты сделал именно такое решение", "Будет использовано программистом для отладки") },
  },
};

const getPrompt = memoize(
  ([symbol]) => `${symbol}`,
  async (symbol) => Mustache.render(await readFile("./prompt.mustache", "utf-8"), { symbol }),
);

// собираем нужные посты постраничным поиском вглубь истории
const NEEDED = [5890, 5776, 5885];
const byId = new Map();
const when = new Date("2027-01-01T00:00:00Z");
for (let page = 0; page < 6 && byId.size < NEEDED.length; page++) {
  const batch = await scrapePage({ channel: CHANNEL_NAME, limit: 100, offset: page * 100, when });
  if (!batch.length) break;
  for (const m of batch) if (NEEDED.includes(m.id)) byId.set(m.id, m);
  if (Math.min(...batch.map((m) => m.id)) < Math.min(...NEEDED)) break;
}

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
await run("BTCUSDT", [5890], { position: "long", id: 5890, entryFrom: 78600, stoploss: 77400, targetsLen: 5, targetsNumeric: true });
// отчёт о тейк-профитах -> wait
await run("BTCUSDT", [5776], { position: "wait" });
// сигнал по чужой монете -> wait (PENGU-шорт при запросе BTCUSDT)
await run("BTCUSDT", [5885], { position: "wait" });
// тот же PENGU-шорт по своему символу -> short
await run("PENGUUSDT", [5885], { position: "short", id: 5885, targetsNumeric: true });

console.log(failed ? `\n${failed} FAIL` : "\nALL PASS");
process.exit(failed ? 1 : 0);
