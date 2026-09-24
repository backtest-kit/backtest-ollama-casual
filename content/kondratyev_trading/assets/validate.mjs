// Валидация промптов kondratyev_trading на реальных постах канала.
// Запуск из content/kondratyev_trading/ (там session.txt и *.mustache):
//   node assets/validate.mjs
// Прогоняет точный пайплайн стратегии (схема + промпт + сборка messages с картинками)
// по обязательным кейсам open/close и печатает PASS/FAIL по каждому.
// Кейсы привязаны к id постов (сентябрь 2026) — при устаревании обновить
// через assets/read-posts.mjs.
import { scrapePage } from "telegram-reader";
import { generateObject, InferenceName } from "json-inference";
import { str, memoize } from "functools-kit";
import { readFile } from "fs/promises";
import Mustache from "mustache";

const CHANNEL_NAME = "-1002199975612";

const PositionOpenFormat = {
  type: "object",
  required: ["id", "symbol", "position", "reasoning"],
  properties: {
    id: { type: "number", description: str.newline("ID сообщения из которого был сформирован сигнал.", "Это число, пиши только его без строгового префикса ID, например, 2134.", "Если сигнала нет, верни -1") },
    symbol: { type: "string", description: str.newline("Тикер позиции строго в формате *USDT, Например", "Текст BTC преобразуем в BTCUSDT") },
    position: { type: "string", enum: ["long", "short", "wait"], description: "Тип позиции, long или short. Если позиции нет, верни wait" },
    reasoning: { type: "string", description: str.newline("Строковое описание почему ты сделал именно такое решение", "Будет использовано программистом для отладки") },
  },
};

const PositionCloseFormat = {
  type: "object",
  required: ["id", "symbol", "action", "reasoning"],
  properties: {
    id: { type: "number", description: str.newline("ID сообщения из которого был сформировано действие.", "Это число, пиши только его без строгового префикса ID, например, 2134.", "Если сигнала нет, верни -1") },
    symbol: { type: "string", description: str.newline("Тикер позиции строго в формате *USDT, Например", "Текст BTC преобразуем в BTCUSDT") },
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
  if (posts.length !== ids.length) { console.log(`SKIP ${kind}/${symbol}: посты ${ids} не все найдены (обнови id)`); return; }
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

// ===== open =====
// short текстом среди шума и чужого входа
await run("open", "ETHUSDT", [1833, 1822, 1813], { verdict: "short", id: 1822 });
// направление ТОЛЬКО на фото (панель «Лонг»)
await run("open", "BTCUSDT", [1835], { verdict: "long", id: 1835 });
// фото «Шорт» при цели в тексте
await run("open", "BTCUSDT", [1840], { verdict: "short", id: 1840 });
// тикер только на мульти-скрине (XRPUSDT Шорт + BTCUSDT Шорт)
await run("open", "XRPUSDT", [1810], { verdict: "short", id: 1810 });
// план «буду набирать SHORT» — не вход
await run("open", "BTCUSDT", [1834], { verdict: "wait" });
// лимитный ордер — не вход
await run("open", "ARBUSDT", [1821], { verdict: "wait" });
// реклама + приветствие — не вход
await run("open", "BTCUSDT", [1837, 1833], { verdict: "wait" });

// ===== close =====
await run("close", "BTCUSDT", [1838], { verdict: "close", id: 1838 });
await run("close", "ETHUSDT", [1830], { verdict: "close", id: 1830 });
await run("close", "ZECUSDT", [1811], { verdict: "close", id: 1811 });
// «стоп перевел к точке входа» — hold
await run("close", "BTCUSDT", [1814], { verdict: "hold" });
// «добавил маржи» (усреднение) — hold
await run("close", "BTCUSDT", [1816], { verdict: "hold" });
// «ушли по стопам … открыл ARB» — для ARB это ВХОД, не закрытие
await run("close", "ARBUSDT", [1818], { verdict: "hold" });
// «продолжаю держать» — hold
await run("close", "BTCUSDT", [1827], { verdict: "hold" });

console.log(failed ? `\n${failed} FAIL` : "\nALL PASS");
process.exit(failed ? 1 : 0);
