import { Level, Position, addStrategySchema, Cache, commitClosePending, commitSignalNotify, getPositionActiveMinutes, listenActivePing, listenError, Log, State } from "backtest-kit";
import { scrapeLookback } from "telegram-reader";
import { errorData, getErrorMessage, memoize, str } from "functools-kit";
import {
  generateObject,
  InferenceName,
  type FormatModel,
} from "json-inference";
import { omit } from "lodash";
import { readFile } from "fs/promises";
import Mustache from "mustache";

const CHANNEL_NAME = "crypto_yoda_channel" as const;

const HARD_STOP_PERCENT = 7.5;

const FRESH_WINDOW_MINUTES = 15;

// Профит-лок через Level (ключи — минуты возраста) со взведением по пику: порог считается взведённым,
// только если пик pnl реально доходил до него — закрытие при падении ниже взведённого
// порога. Без этого рост порога (1.0 -> 1.5 на 10ч) закрывал бы позицию с pnl 1.2,
// никогда не имевшую 1.5, на самом переходе ступени.
// До 3ч не армирован (ранняя болтанка режет середняков). Порог растёт с возрастом —
// плоский +1% после ~6-10ч перестаёт быть эффективным (пики лосей ранние, а зрелая
// позиция обязана удерживать больше). Симуляция по 18 сигналам августа: +9.6пп к сумме
// выборки, 3 из 7 лосей в плюс; гигантов (+17.9, +11.6) лок не трогает.
// До 3ч (минимальный ключ) Level.match возвращает null — лок не армирован.
const PROFIT_LOCK_LEVEL = new Level({
  [3 * 60]: 1.0,
  [10 * 60]: 1.5,
  [16 * 60]: 2.0,
});

const PROFIT_LOCK_STATE = new State({
  initialData: { peakPnl: -100 },
  name: "profit_lock_state",
});

// Трейлинг-тейк через Level. Задача — поймать статистически редкий большой плюс
// (уровня +20%), а НЕ дожимать середняков: их ведут профит-лок и временной стоп.
// Настройки из структуры откатов раннеров выборки (ETH#5815 пик 26.2%, SOL#5816 пик 19.2%):
// на высоте они дышат волнами до 4.7пп и продолжают расти, поэтому вооружение — только
// с пика 8% (туда доехали 2 из 18 сигналов), допустимый откат 5пп — глубже любой
// пережитой волны раннеров. На выборке августа не срабатывает ни разу (Δ=0.00 к стеку):
// чистая страховка от коллапса с большого пика, забирающая >= пик-5пп, если он случится.
const TRAILING_TAKE_ARM_LEVEL = new Level({
  [0]: 8.0,
});
const TRAILING_TAKE_RETRACE_LEVEL = new Level({
  [0]: 5.0,
});

const TRAILING_TAKE_STATE = new State({
  initialData: { peakPnl: 0 },
  name: "trailing_take_state",
});

// Динамический временной стоп: пол pnl (в %), сужается с возрастом позиции.
// Значения — БУКВАЛЬНО минимально допустимый pnl в этот час: упали ниже — закрываемся.
// Словарь выведен из траекторий 18 сигналов августа: полы глубже худших просадок,
// которые переживали ПОБЕДИТЕЛИ в соответствующий час (симуляция: 0 убитых победителей,
// +7пп к сумме pnl выборки). Семантика Level: значение наибольшего ключа <= возраста,
// после 24ч действует последний (-1%).
const PNL_FLOOR_LEVEL = new Level({
  [0]: -4.5,
  [6 * 60]: -3.0,
  [12 * 60]: -2.0,
  [18 * 60]: -1.5,
  [24 * 60]: -1.0,
});

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

    if (!entry.targets[2]) {
      return null;
    }

    const info = { symbol, entry, message: omit(message, "photo"), url };

    return {
      id: `${entry.id}-${entry.symbol.toLowerCase()}`,
      symbol: entry.symbol,
      ...Position.moonbag({
        position: entry.position,
        currentPrice,
        percentStopLoss: HARD_STOP_PERCENT,
      }),
      minuteEstimatedTime: 24 * 60,
      payload: {
        levels: entry.targets,
      },
      note: JSON.stringify(info, null, 2),
    };
  },
});

listenActivePing(async ({ symbol, data, currentPrice }) => {
  const minutesActive = await getPositionActiveMinutes(symbol);
  const hoursActive = minutesActive / 60;
  const floor = PNL_FLOOR_LEVEL.match(minutesActive);

  if (floor === null) {
    return;
  }

  const pnlPercent = data.pnl.pnlPercentage;

  if (pnlPercent > floor) {
    return;
  }

  await commitSignalNotify(symbol, {
    notificationNote: str.newline(
      `Динамический стоп: pnl ${pnlPercent.toFixed(2)}% ниже пола ${floor}% на ${Math.floor(hoursActive)}-м часу позиции`,
      `Позиция закрыта временным стопом`,
    ),
  });
  await commitClosePending(symbol);
});

listenActivePing(async ({ symbol, data, currentPrice }) => {
  const minutesActive = await getPositionActiveMinutes(symbol);
  const hoursActive = minutesActive / 60;
  const lockLevel = PROFIT_LOCK_LEVEL.match(minutesActive);

  if (lockLevel === null) {
    return;
  }

  const pnlPercent = data.pnl.pnlPercentage;

  const { peakPnl } = await PROFIT_LOCK_STATE.getState();
  const peak = Math.max(peakPnl, pnlPercent);

  if (peak >= lockLevel && pnlPercent < lockLevel) {
    await commitSignalNotify(symbol, {
      notificationNote: str.newline(
        `Профит-лок: pnl ${pnlPercent.toFixed(2)}% ниже порога ${lockLevel}% (пик ${peak.toFixed(2)}%, позиции ${Math.floor(hoursActive)}ч)`,
        `Прибыль зафиксирована`,
      ),
    });
    await commitClosePending(symbol);
    return;
  }

  if (pnlPercent > peakPnl) {
    await PROFIT_LOCK_STATE.setState({ peakPnl: pnlPercent });
  }
});

listenActivePing(async ({ symbol, data, currentPrice }) => {
  const minutesActive = await getPositionActiveMinutes(symbol);
  const pnlPercent = data.pnl.pnlPercentage;

  const { peakPnl } = await TRAILING_TAKE_STATE.getState();

  if (pnlPercent > peakPnl) {
    await TRAILING_TAKE_STATE.setState({ peakPnl: pnlPercent });
    return;
  }

  const arm = TRAILING_TAKE_ARM_LEVEL.match(minutesActive);
  const retrace = TRAILING_TAKE_RETRACE_LEVEL.match(minutesActive);

  if (arm === null || retrace === null) {
    return;
  }

  if (peakPnl < arm) {
    return;
  }

  if (pnlPercent > peakPnl - retrace) {
    return;
  }

  await commitSignalNotify(symbol, {
    notificationNote: str.newline(
      `Трейлинг-тейк: pnl ${pnlPercent.toFixed(2)}% откатился на ${(peakPnl - pnlPercent).toFixed(2)}пп от пика ${peakPnl.toFixed(2)}%`,
      `Прибыль зафиксирована трейлингом`,
    ),
  });
  await commitClosePending(symbol);
});

listenError((error) => {
  console.log(error);
  Log.debug("error", {
    error: errorData(error),
    message: getErrorMessage(error),
  });
});
