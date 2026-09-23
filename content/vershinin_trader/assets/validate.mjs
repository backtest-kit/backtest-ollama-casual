// Валидация промптов vershinin_trader на реальных постах канала.
// Запуск из content/vershinin_trader/ (там session.txt и *.mustache):
//   node assets/validate.mjs
// Прогоняет точный пайплайн стратегии (схема + промпт + сборка messages с картинками)
// по обязательным кейсам open/close и печатает PASS/FAIL по каждому.
import { scrapePage } from "telegram-reader";
import { generateObject, InferenceName } from "json-inference";
import { str, memoize } from "functools-kit";
import { readFile } from "fs/promises";
import Mustache from "mustache";

const CHANNEL_NAME = "-1002833393903";

const PositionOpenFormat = {
  type: "object",
  required: ["id", "symbol", "position", "reasoning"],
  properties: {
    id: { type: "number", description: str.newline("ID сообщения из которого был сформирован сигнал.", "Это число, пиши только его без строгового префикса ID, например, 2134.", "Если сигнала нет, верни -1") },
    symbol: { type: "string", description: str.newline("Тикер позиции строго в формате *USDT, Например", "Текст #BTC/USDT преобразуем в BTCUSDT без # и /") },
    position: { type: "string", enum: ["long", "short", "wait"], description: "Тип позиции, long или short. Если позиции нет, верни wait" },
    reasoning: { type: "string", description: str.newline("Строковое описание почему ты сделал именно такое решение", "Будет использовано программистом для отладки") },
  },
};

const PositionCloseFormat = {
  type: "object",
  required: ["id", "symbol", "action", "reasoning"],
  properties: {
    id: { type: "number", description: str.newline("ID сообщения из которого был сформировано действие.", "Это число, пиши только его без строгового префикса ID, например, 2134.", "Если сигнала нет, верни -1") },
    symbol: { type: "string", description: str.newline("Тикер позиции строго в формате *USDT, Например", "Текст #BTC/USDT преобразуем в BTCUSDT без # и /") },
    action: { type: "string", enum: ["hold", "close"], description: str.newline("Тип действия, hold или close. Если трейдер", "закрыл позицию, в том числе все позиции разом", "то выбери close. Иначе hold") },
    reasoning: { type: "string", description: str.newline("Строковое описание почему ты сделал именно такое решение", "Будет использовано программистом для отладки") },
  },
};

const getPrompt = memoize(
  ([symbol, name]) => `${symbol}-${name}`,
  async (symbol, name) => Mustache.render(await readFile(`./${name}.mustache`, "utf-8"), { symbol }),
);

const all = await scrapePage({
  channel: CHANNEL_NAME,
  limit: 60,
  offset: 0,
  when: new Date("2027-01-01T00:00:00Z"),
});
const byId = Object.fromEntries(all.map((m) => [m.id, m]));

const toLlmMessages = (posts) =>
  posts.map(({ id, channel, date, content, photo }) => ({
    role: "user",
    content: str.newline(`ID ${id}`, "", content, "", `[${date.toISOString()}]: https://t.me/c/${channel.slice(4)}/${id}`),
    ...(photo && { images: [photo] }),
  }));

let failed = 0;

const run = async (kind, symbol, ids, expect) => {
  const posts = ids.map((id) => byId[id]).filter(Boolean);
  if (posts.length !== ids.length) { console.log(`SKIP ${kind}/${symbol}: посты ${ids} не все найдены (канал уехал вперёд — подбери свежие id)`); return; }
  const format = kind === "open" ? PositionOpenFormat : PositionCloseFormat;
  const prompt = await getPrompt(symbol, kind === "open" ? "prompt_open" : "prompt_close");
  const result = await generateObject(
    InferenceName.OllamaInference,
    { format, messages: [{ role: "user", content: prompt }, ...toLlmMessages(posts)] },
    "gemma4:31b-cloud",
  );
  const got = kind === "open" ? result.position : result.action;
  const ok = got === expect.verdict && (expect.id === undefined || result.id === expect.id);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${kind}/${symbol} posts=[${ids}] -> ${got} id=${result.id} (ожидалось ${expect.verdict}${expect.id !== undefined ? " id=" + expect.id : ""})`);
  if (!ok) console.log("  reasoning:", result.reasoning);
};

// open: полный текстовый сигнал ETH среди рекламы и чужой монеты
await run("open", "ETHUSDT", [3576, 3548, 3550], { verdict: "long", id: 3548 });
// open: сигналов по BTC в выборке нет -> wait
await run("open", "BTCUSDT", [3576, 3548, 3550], { verdict: "wait" });
// open: SOL лонг с текущих
await run("open", "SOLUSDT", [3576, 3548, 3550], { verdict: "long", id: 3550 });
// open (vision): направление только из графика TradingView
await run("open", "ETHUSDT", [3572], { verdict: "long", id: 3572 });
await run("open", "BTCUSDT", [3573], { verdict: "long", id: 3573 });
// open (vision): карточка BYDFi лонг VIRTUAL, спрашиваем чужой символ -> wait
await run("open", "BTCUSDT", [3558], { verdict: "wait" });
// close: перенос стопа -> hold
await run("close", "ETHUSDT", [3557], { verdict: "hold" });
// close: частичная фиксация -> hold
await run("close", "ETHUSDT", [3569], { verdict: "hold" });
// close: "мои шорты принимаю решение закрыть" -> close
await run("close", "BTCUSDT", [3564], { verdict: "close", id: 3564 });
// close: аналитика -> hold
await run("close", "BTCUSDT", [3537], { verdict: "hold" });

console.log(failed ? `\n${failed} FAIL` : "\nALL PASS");
process.exit(failed ? 1 : 0);
