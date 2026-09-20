import { addStrategySchema, Cache, getClosePrice } from "backtest-kit";
import { scrapeLookback } from "telegram-reader";
import { memoize, str } from "functools-kit";
import ollama from "ollama";
import { z } from "zod";
import { readFile } from "fs/promises";
import Mustache from "mustache";
import { zodToJsonSchema } from "zod-to-json-schema";

const CHANNEL_NAME = "crypto_yoda_channel" as const;

const getPrompt = memoize(([symbol]) => `${symbol}`, async (symbol: string) => {
  const template = await readFile("./prompt.mustache", "utf-8");
  return Mustache.render(template, { symbol });
});

const TradingPosition = z.object({
  id: z.number({
    description: str.newline(
      "ID сообщения из которого был сформирован сигнал.",
      "Это число, пиши только его без строгового префикса ID, например, 2134",
    ),
  }),
  symbol: z.string({
    description: str.newline(
      "Тикер позиции строго в формате *USDT, Например",
      "Текст #BTC/USDT преобразуем в BTCUSDT без # и /",
    ),
  }),
  position: z.enum(["long", "short", "wait"], {
    description: "Тип позиции, long или short. Если позиции нет, верни wait",
  }),
  entryFrom: z.number({
    description: "Цена входа ОТ",
  }),
  entryTo: z.number({
    description: "Цена входа ДО",
  }),
  targets: z.array(
    z.number({
      description: "Цели позиции, 5 уровней",
    }),
  ),
  stoploss: z.number({
    description: "СТОП ЛОСС, одна точка хард стоп",
  }),
  reasoning: z.string({
    description: str.newline(
      "Строковое описание почему ты сделал именно такое решение",
      "Будет использовано программистом для отладки"
    )
  })
});

const getSignal = Cache.fn(
  async (symbol: string, when: Date) => {
    const coin = `#${symbol.replace("USDT", "")}`;

    let messages = await scrapeLookback({
      channel: CHANNEL_NAME,
      when,
      limit: 60 * 4,
      dimension: "minute",
    });

    messages = messages
      .filter(({ content }) => content.length > 0)
      .filter(({ content }) => content.includes(coin));

    if (!messages.length) {
      return { entry: null };
    }

    const response = await ollama.chat({
      model: "gemma4:31b-cloud",
      messages: [
        { role: "user", content: await getPrompt(symbol) },
        ...messages.map(({ id, channel, date, content }) => ({
          role: "user",
          content: str.newline(
            `ID ${id}`,
            "",
            content,
            "",
            `[${date.toISOString()}]: https://t.me/${channel}/${id}`,
          ),
        }))
      ],
      format: zodToJsonSchema(TradingPosition),
      think: false,
    });

    const entry = TradingPosition.parse(
      JSON.parse(response.message.content),
    );

    return { entry, messages };
  },
  {
    interval: "4h",
  },
);

addStrategySchema({
  strategyName: "main_strategy",
  getSignal: async (symbol, when) => {

    console.log(symbol, when);

    const { entry, messages } = await getSignal(symbol, when);

    if (!entry) {
      return null;
    }

    if (entry.position === "wait") {
      return null;
    }

    const closePrice = await getClosePrice(symbol, "1m");

    const minPrice = Math.min(entry.entryFrom, entry.entryTo);
    const maxPrice = Math.max(entry.entryFrom, entry.entryTo);

    if (closePrice < minPrice || closePrice > maxPrice) {
      return null;
    }

    if (!entry.targets[2]) {
      return null;
    }

    const info = { symbol, entry, messages };

    return {
      id: `${entry.id}`,
      symbol: entry.symbol,
      position: entry.position,
      priceStopLoss: entry.stoploss,
      priceTakeProfit: entry.targets[2],
      minuteEstimatedTime: Infinity,
      note: JSON.stringify(info, null, 2),
    };
  },
});
