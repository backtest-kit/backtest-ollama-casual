import {
  Cache,
  addStrategySchema,
  listenActivePing,
  listenIdlePing,
  commitCreateSignal,
  commitClosePending,
  Position,
} from "backtest-kit";
import { readFile } from "fs/promises";
import { memoize, str } from "functools-kit";
import { FormatModel, generateObject, InferenceName } from "json-inference";
import Mustache from "mustache";
import { scrapeLookback } from "telegram-reader";

const CHANNEL_NAME = "-1002833393903";
const WINDOW_MINUTES = 4 * 60;
const HARD_STOP_PERCENT = 7.5;

const PositionOpenFormat = {
  type: "object",
  required: ["id", "symbol", "position", "reasoning"],
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
    reasoning: {
      type: "string",
      description: str.newline(
        "Строковое описание почему ты сделал именно такое решение",
        "Будет использовано программистом для отладки",
      ),
    },
  },
} satisfies FormatModel;

const PositionCloseFormat = {
  type: "object",
  required: ["id", "symbol", "action", "reasoning"],
  properties: {
    id: {
      type: "number",
      description: str.newline(
        "ID сообщения из которого был сформировано действие.",
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
    action: {
      type: "string",
      enum: ["hold", "close"],
      description: str.newline(
        "Тип действия, hold или close. Если трейдер",
        "закрыл позицию, в том числе все позиции разом",
        "то выбери close. Иначе hold",
      ),
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

addStrategySchema({
  strategyName: "main_strategy",
});

const getPrompt = memoize(
  ([symbol, name]) => `${symbol}-${name}`,
  async (symbol: string, name: string) => {
    const template = await readFile(`./${name}.mustache`, "utf-8");
    return Mustache.render(template, { symbol });
  },
);

const getOpenSignal = Cache.file(
  async (symbol: string, when: Date) => {
    let messages = await scrapeLookback({
      channel: CHANNEL_NAME,
      limit: WINDOW_MINUTES,
      dimension: "minute",
      when,
    });

    messages = messages.filter(({ content, photo }) => {
      let isOk = false;
      if (content) {
        isOk = true;
      }
      if (photo) {
        isOk = true;
      }
      return isOk;
    });

    if (!messages.length) {
      return { signal: null };
    }

    const signal = await generateObject(
      InferenceName.OllamaInference,
      {
        format: PositionOpenFormat,
        messages: [
          { role: "user", content: await getPrompt(symbol, "prompt_open") },
          ...messages.map(({ id, channel, date, content, photo }) => ({
            role: "user" as const,
            content: str.newline(
              `ID ${id}`,
              "",
              content,
              "",
              `[${date.toISOString()}]: https://t.me/c/${channel.slice(4)}/${id}`,
            ),
            ...(photo && { images: [photo] }),
          })),
        ],
      },
      "gemma4:31b-cloud",
    );

    const message = messages.find((message) => message.id === signal.id)!;

    if (!message) {
      return { signal: null };
    }

    return {
      signal,
      message,
    };
  },
  {
    interval: "4h",
    name: "vershinin_trader_open_v2",
  },
);

const getCloseSignal = Cache.file(
  async (symbol: string, when: Date) => {
    let messages = await scrapeLookback({
      channel: CHANNEL_NAME,
      limit: WINDOW_MINUTES,
      dimension: "minute",
      when,
    });

    messages = messages.filter(({ content, photo }) => {
      let isOk = false;
      if (content) {
        isOk = true;
      }
      if (photo) {
        isOk = true;
      }
      return isOk;
    });

    if (!messages.length) {
      return { signal: null };
    }

    const signal = await generateObject(
      InferenceName.OllamaInference,
      {
        format: PositionCloseFormat,
        messages: [
          { role: "user", content: await getPrompt(symbol, "prompt_close") },
          ...messages.map(({ id, channel, date, content, photo }) => ({
            role: "user" as const,
            content: str.newline(
              `ID ${id}`,
              "",
              content,
              "",
              `[${date.toISOString()}]: https://t.me/c/${channel.slice(4)}/${id}`,
            ),
            ...(photo && { images: [photo] }),
          })),
        ],
      },
      "gemma4:31b-cloud",
    );

    const message = messages.find((message) => message.id === signal.id)!;

    if (!message) {
      return { signal: null };
    }

    return {
      signal,
      message,
    };
  },
  {
    interval: "4h",
    name: "vershinin_trader_close_v2",
  },
);

listenIdlePing(async ({ symbol, when, currentPrice }) => {
  const { signal, message } = await getOpenSignal(symbol, when);
  if (!signal) {
    return;
  }
  if (signal.position !== "long" && signal.position !== "short") {
    return;
  }
  await commitCreateSignal(symbol, {
    id: String(signal.id),
    symbol: signal.symbol,
    ...Position.moonbag({
      position: signal.position,
      currentPrice,
      percentStopLoss: HARD_STOP_PERCENT,
    }),
    note: JSON.stringify({ signal, message }, null, 2),
  })
});

listenActivePing(async ({ symbol, when }) => {
  const { signal, message } = await getCloseSignal(symbol, when);
  if (!signal) {
    return;
  }
  if (signal.action !== "close") {
    return;
  }
  await commitClosePending(symbol, {
    note: JSON.stringify({ signal, message }, null, 2),
  });
});
