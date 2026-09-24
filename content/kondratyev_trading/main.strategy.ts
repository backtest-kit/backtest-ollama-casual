import {
  Cache,
  Log,
  addStrategySchema,
  listenActivePing,
  listenIdlePing,
  commitCreateSignal,
  commitClosePending,
  Position,
  listenError,
} from "backtest-kit";
import { readFile } from "fs/promises";
import { errorData, getErrorMessage, memoize, str } from "functools-kit";
import { FormatModel, generateObject, InferenceName } from "json-inference";
import Mustache from "mustache";
import { omit } from "lodash";
import { scrapeLookback } from "telegram-reader";

const CHANNEL_NAME = "-1002199975612";
const FRESH_WINDOW_MINUTES = 15;
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
      limit: FRESH_WINDOW_MINUTES,
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
      Log.info("kondratyev open", `${symbol}: окно ${FRESH_WINDOW_MINUTES}м пустое, LLM не вызываю`);
      return { signal: null };
    }

    const withPhoto = messages.filter(({ photo }) => photo).length;
    Log.info("kondratyev open", `${symbol}: отправляю модели ${messages.length} постов (с фото: ${withPhoto}), окно до ${when.toISOString()}`);

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

    if (signal.position === "wait") {
      Log.info("kondratyev open", `${symbol}: модель входа не нашла — ${signal.reasoning}`);
    } else {
      Log.info("kondratyev open", `${symbol}: модель нашла вход ${signal.position} в посте ${signal.id} — ${signal.reasoning}`);
    }

    const message = messages.find((message) => message.id === signal.id)!;

    if (!message) {
      if (signal.position !== "wait") {
        Log.info("kondratyev open", `${symbol}: пост ${signal.id} не найден в окне, сигнал отброшен`);
      }
      return { signal: null };
    }

    const url = `https://t.me/c/${message.channel.slice(4)}/${message.id}`;

    return {
      signal,
      message,
      url,
    };
  },
  {
    interval: "5m",
    name: "kondratyev_trading_open_v2",
  },
);

const getCloseSignal = Cache.file(
  async (symbol: string, when: Date) => {
    let messages = await scrapeLookback({
      channel: CHANNEL_NAME,
      limit: FRESH_WINDOW_MINUTES,
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
      Log.info("kondratyev close", `${symbol}: окно ${FRESH_WINDOW_MINUTES}м пустое, LLM не вызываю`);
      return { signal: null };
    }

    const withPhoto = messages.filter(({ photo }) => photo).length;
    Log.info("kondratyev close", `${symbol}: позиция открыта, отправляю модели ${messages.length} постов (с фото: ${withPhoto}), окно до ${when.toISOString()}`);

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

    if (signal.action === "close") {
      Log.info("kondratyev close", `${symbol}: модель решила закрыть по посту ${signal.id} — ${signal.reasoning}`);
    } else {
      Log.info("kondratyev close", `${symbol}: модель решила держать — ${signal.reasoning}`);
    }

    const message = messages.find((message) => message.id === signal.id)!;

    if (!message) {
      if (signal.action === "close") {
        Log.info("kondratyev close", `${symbol}: пост ${signal.id} не найден в окне, решение о закрытии отброшено`);
      }
      return { signal: null };
    }

    const url = `https://t.me/c/${message.channel.slice(4)}/${message.id}`;

    return {
      signal,
      message,
      url,
    };
  },
  {
    interval: "5m",
    name: "kondratyev_trading_close_v2",
  },
);

listenIdlePing(async ({ symbol, when, currentPrice }) => {
  const { signal, message, url } = await getOpenSignal(symbol, when);
  if (!signal) {
    return;
  }
  if (signal.position !== "long" && signal.position !== "short") {
    return;
  }
  if (when.getTime() - new Date(message.date).getTime() > FRESH_WINDOW_MINUTES * 60_000) {
    return;
  }
  Log.info("kondratyev trade", `${symbol}: открываю ${signal.position} от цены ${currentPrice} по посту ${signal.id}, хард-стоп ${HARD_STOP_PERCENT}%`);
  await commitCreateSignal(symbol, {
    id: `${signal.id}-${signal.symbol.toLowerCase()}`,
    symbol: signal.symbol,
    ...Position.moonbag({
      position: signal.position,
      currentPrice,
      percentStopLoss: HARD_STOP_PERCENT,
    }),
    note: JSON.stringify({ signal, message: omit(message, "photo"), url }, null, 2),
  })
});

listenActivePing(async ({ symbol, when, data }) => {
  const { signal, message, url } = await getCloseSignal(symbol, when);
  if (!signal) {
    return;
  }
  if (signal.action !== "close") {
    return;
  }
  if (new Date(message.date).getTime() <= data.pendingAt) {
    Log.info("kondratyev close", `${symbol}: close-пост ${signal.id} опубликован ДО открытия позиции — относится к предыдущей позиции автора, игнорирую`);
    return;
  }
  Log.info("kondratyev trade", `${symbol}: закрываю позицию по посту ${signal.id} от ${new Date(message.date).toISOString()}`);
  await commitClosePending(symbol, {
    note: JSON.stringify({ signal, message: omit(message, "photo"), url }, null, 2),
  });
});

listenError((error) => {
  console.log(error);
  Log.debug("error", {
    error: errorData(error),
    message: getErrorMessage(error),
  });
});

