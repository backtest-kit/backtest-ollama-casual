import { addStrategySchema, Cache, commitClosePending, commitSignalNotify, listenActivePing, State } from "backtest-kit";
import { scrapeLookback, lib } from "telegram-reader";
import { memoize, str } from "functools-kit";
import {
  generateObject,
  InferenceName,
  type FormatModel,
} from "json-inference";
import { readFile } from "fs/promises";
import Mustache from "mustache";

type Position = "short" | "long";

const CHANNEL_NAME = "crypto_yoda_channel" as const;

lib.loggerService.setLogger({
  debug: console.log,
  info: console.log,
  log: console.log,
  warn: console.warn,
})

const LEVEL_STATE = new State({
  initialData: { lastLevel: 0 },
  name: "level_state",
});

const LEVEL_DRIFT_RATIO = 0.3;
const FRESH_WINDOW_MINUTES = 15;

function getCurrentLevel(position: Position, levels: number[], currentPrice: number) {
  if (position === "long") {
    return levels.filter((level) => currentPrice >= level).length;
  }
  return levels.filter((level) => currentPrice <= level).length;
}

function getLevelStep(levels: number[], lastLevel: number) {
  const levelPrice = levels[lastLevel - 1];
  const neighborPrice = lastLevel > 1 ? levels[lastLevel - 2] : levels[lastLevel];
  return Math.abs(levelPrice - neighborPrice);
}

function getLevelDrift(position: Position, levels: number[], lastLevel: number, currentPrice: number) {
  const levelPrice = levels[lastLevel - 1];
  const drift = position === "long"
    ? levelPrice - currentPrice
    : currentPrice - levelPrice;
  return Math.max(drift, 0);
}

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
      console.log("Parsing: ", msg.content.slice(-64));
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

    return { entry, message };
  },
  {
    interval: "5m",
    name: "crypto_yoda_entry_v3"
  },
);

addStrategySchema({
  strategyName: "main_strategy",
  getSignal: async (symbol, when) => {

    const { entry, message } = await getSignal(symbol, when);

    if (!entry) {
      return null;
    }

    if (entry.position === "wait") {
      return null;
    }

    if (when.getTime() - new Date(message.date).getTime() > FRESH_WINDOW_MINUTES * 60_000) {
      return null;
    }

    if (!entry.targets[2]) {
      return null;
    }
  
    const priceTakeProfit = entry.position === "long"
      ? Math.max(...entry.targets)
      : Math.min(...entry.targets);

    const info = { symbol, entry, message };

    return {
      id: `${entry.id}`,
      symbol: entry.symbol,
      position: <Position> entry.position,
      priceStopLoss: entry.stoploss,
      priceTakeProfit,
      minuteEstimatedTime: Infinity,
      payload: {
        levels: entry.targets,
      },
      note: JSON.stringify(info, null, 2),
    };
  },
});

listenActivePing(async ({ data, currentPrice, backtest, when }) => {
  const levels = <number[]>data.payload.levels;

  if (!levels?.length) {
    return;
  }

  const currentLevel = getCurrentLevel(<Position>data.position, levels, currentPrice);
  const { lastLevel } = await LEVEL_STATE.getState();

  if (currentLevel > lastLevel) {
    await commitSignalNotify(data.symbol, {
      notificationNote: str.newline(
        `Достигнут уровень ${currentLevel} из ${levels.length} (цель ${levels[currentLevel - 1]})`,
        `Трейлинг уровней продолжает сопровождение`,
      ),
    });
    await LEVEL_STATE.setState({ lastLevel: currentLevel });
    return;
  }

  if (!lastLevel) {
    return;
  }

  const drift = getLevelDrift(<Position>data.position, levels, lastLevel, currentPrice);
  const step = getLevelStep(levels, lastLevel);
  const driftRatio = drift / step;

  if (drift > step * LEVEL_DRIFT_RATIO) {
    await commitSignalNotify(data.symbol, {
      notificationNote: str.newline(
        `Цена откатилась за уровень ${lastLevel} на ${(driftRatio * 100).toFixed(0)}% шага при люфте ${LEVEL_DRIFT_RATIO * 100}%`,
        `Позиция закрыта по трейлингу уровней`,
      ),
    });
    await commitClosePending(data.symbol);
  }
});
