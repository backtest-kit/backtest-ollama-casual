import {
  addStrategySchema,
  Cron,
  getDate,
  Interval,
  IPublicSignalRow,
  listenActivePing,
  listenSignal,
  listenSignalPerSignal,
} from "backtest-kit";

addStrategySchema({
  strategyName: "main_strategy",
  getSignal: async () => {
    return null;
  }
});

const handleClose = Interval.fn(
  async (symbol: string, signal: IPublicSignalRow, timestamp: number) => {
    
  },
  {
    interval: "15m",
  },
);

listenActivePing(async ({ symbol, data, timestamp }) => {
  handleClose(symbol, data, timestamp);
});

