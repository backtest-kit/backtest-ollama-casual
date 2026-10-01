import { addStrategySchema, Cache, Position, setConfig } from "backtest-kit";
import { scrapeLookback } from "telegram-reader";
import { memoize, str } from "functools-kit";
import {
  generateObject,
  InferenceName,
  type FormatModel,
} from "json-inference";
import { omit } from "lodash";
import { readFile } from "fs/promises";
import Mustache from "mustache";

setConfig({
  CC_MAX_STOPLOSS_DISTANCE_PERCENT: 100,
});

const CHANNEL_NAME = "crypto_yoda_channel" as const;

const FRESH_WINDOW_MINUTES = 15;
const NEVER_STOP_PERCENT = 50;

const getPrompt = memoize(
  ([symbol]) => `${symbol}`,
  async (symbol: string) => {
    const template = await readFile("./prompt.mustache", "utf-8");
    return Mustache.render(template, { symbol });
  },
);

const TradingPositionFormat = {
  type: "object",
  required: [
    "id",
    "symbol",
    "position",
    "entryRange",
    "targets",
    "stoploss",
    "reasoning",
  ],
  properties: {
    id: {
      type: "number",
      description: str.newline(
        "ID сообщения из которого был сформирован сигнал.",
        "Это число, пиши только его без строкового префикса ID, например, 2134.",
        "Если сигнала нет, верни -1",
      ),
    },
    symbol: {
      type: "string",
      description: str.newline(
        "Тикер позиции строго в формате *USDT, Например",
        "Текст #BTC/USDT преобразуем в BTCUSDT без # и /",
      ),
    },
    position: {
      type: "string",
      enum: ["long", "short", "wait"],
      description: "Тип позиции, long или short. Если позиции нет, верни wait",
    },
    entryRange: {
      type: "object",
      description: str.newline(
        "Диапазон входа в позицию, например для 'в диапазоне $78600 - $79400'",
        "верни from=78600, to=79400. Если сигнала нет, верни from=0 и to=0",
      ),
      required: ["from", "to"],
      properties: {
        from: {
          type: "number",
          description: "Цена входа ОТ",
        },
        to: {
          type: "number",
          description: "Цена входа ДО",
        },
      },
    },
    targets: {
      type: "array",
      description: "Цели позиции, 5 уровней, числа. Если сигнала нет, верни []",
      items: { type: "number" },
    },
    stoploss: {
      type: "number",
      description: "СТОП ЛОСС, одна точка хард стоп. Если сигнала нет, верни 0",
    },
    reasoning: {
      type: "string",
      description: str.newline(
        "Строковое описание почему ты сделал именно такое решение",
        "Будет использовано программистом для отладки",
      ),
    },
  },
} satisfies FormatModel;

const getSignal = Cache.file(
  async (symbol: string, when: Date) => {
    const coin = `#${symbol.replace("USDT", "")}`;

    let messages = await scrapeLookback({
      channel: CHANNEL_NAME,
      limit: FRESH_WINDOW_MINUTES,
      dimension: "minute",
      when,
    });

    messages = messages
      .filter(({ content }) => content.length > 0)
      .filter(({ content }) => content.includes(coin));

    if (!messages.length) {
      return { entry: null };
    }
    
    {
      const [msg] = messages;
      console.log("Parsing: ", msg.content.slice(0, 64));
    }

    const entry = await generateObject(
      InferenceName.OllamaInference,
      {
        format: TradingPositionFormat,
        messages: [
          { role: "user", content: await getPrompt(symbol) },
          ...messages.map(({ id, channel, date, content }) => ({
            role: "user" as const,
            content: str.newline(
              `ID ${id}`,
              "",
              content,
              "",
              `[${date.toISOString()}]: https://t.me/${channel}/${id}`,
            ),
          })),
        ],
      },
      "gemma4:31b-cloud",
    );

    const message = messages.find((message) => message.id === entry.id)!;

    if (!message) {
      return { entry: null };
    }

    const url = `https://t.me/${message.channel}/${message.id}`;

    return { entry, message, url };
  },
  {
    interval: "5m",
    name: "crypto_yoda_entry_v3"
  },
);

addStrategySchema({
  strategyName: "main_strategy",
  getSignal: async (symbol, when, currentPrice) => {

    const { entry, message, url } = await getSignal(symbol, when);

    if (!entry) {
      return null;
    }

    if (entry.position !== "long" && entry.position !== "short") {
      return null;
    }

    if (when.getTime() - new Date(message.date).getTime() > FRESH_WINDOW_MINUTES * 60_000) {
      return null;
    }

    const info = { symbol, entry, message: omit(message, "photo"), url };

    return {
      id: `${entry.id}-${entry.symbol.toLowerCase()}`,
      symbol: entry.symbol,
      ...Position.moonbag({
        position: entry.position,
        currentPrice,
        percentStopLoss: NEVER_STOP_PERCENT,
      }),
      note: JSON.stringify(info, null, 2),
      minuteEstimatedTime: 24 * 60,
    };
  },
});
