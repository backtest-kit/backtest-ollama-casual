<img src="https://github.com/tripolskypetr/backtest-kit/raw/refs/heads/master/assets/consciousness.svg" height="45px" align="right">

# 🧿 backtest-ollama-casual

> A measurement rig for the paid-signals industry, built on [backtest-kit](https://github.com/tripolskypetr/backtest-kit): an LLM (`gemma4:31b-cloud` via [json-inference](https://github.com/tripolskypetr/json-inference)) parses each Telegram signal-seller's own guidance — text **and chart screenshots** — the engine executes it within minutes of publication, and event studies over minute candles answer the question nobody in that industry wants asked: **where does the edge actually live, and does it survive the seller's own money management?**

![screenshot](https://raw.githubusercontent.com/tripolskypetr/backtest-kit/HEAD/assets/screenshots/screenshot16.png)

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/tripolskypetr/backtest-kit)
[![npm](https://img.shields.io/npm/v/backtest-kit.svg?style=flat-square)](https://npmjs.org/package/backtest-kit)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue)]()
[![Build](https://github.com/tripolskypetr/backtest-kit/actions/workflows/webpack.yml/badge.svg)](https://github.com/tripolskypetr/backtest-kit/actions/workflows/webpack.yml)

Signal channels are a murky industry everyone "knows" about and almost nobody has measured. Their reports show leveraged wins on partial take-profits; their losses go unposted; their methodology is unfalsifiable — until you replay a month of their posts against minute candles with no look-ahead bias. This repo does exactly that for two channels with completely different formats, and the answers turned out to be more interesting than "scam / not scam":

- **The direction has a real micro-edge — but not where the seller says.** 24 hours after a post, price moved the signalled way in **13/18 cases (72%)**, mean **+1.42%** unleveraged. In the first 15–60 minutes: nothing (slightly negative). The edge lives at the 12–24h horizon; pre-post drift is a coin flip (7–9/18), so it is not mere trend-echo.
- **The seller's own plan is mathematically ruinous.** Across 16 entries, price reached TP1 in 44%, TP2 in 19%, TP3 in 6%, **TP4/TP5: never**. Following the posts as written (five scale-out targets, ~4.5% stop) has an EV around **−3.5…−4% per trade unleveraged** — and the advertised X13–25 leverage turns a single stop into −60…−100% of margin. The marketing shows the 44%; subscribers eat the rest.
- **The entry zone is a wall of subscriber limit orders — bimodally.** The "from–to" range either holds price cleanly (breach ≤ 0.8%) or gets knifed straight through by **6.8–7.7%** — past the stop level every subscriber placed at the same price. The two strongest signals of the month never revisited the zone at all (**+11.2%, +6.6%**): a strict "price in zone" entry gate silently discards the best trades.
- **All realized profit came from our exit engineering, not theirs.** Level-ratchet trailing alone: **−0.31%** on the month. Adding a structural breakeven rule (stop to entry after 50% progress to TP1): **+3.37%** — 7 ratchet wins (+7.84%), 8 breakeven zeros, one honest −4.47% stop. The ratchet slack (0.3 of the grid step) is derived from the process distribution, not fitted to PnL: the noise ceiling of survived retraces was 0.186 (n=62).

One month, 16–18 events per question — hypothesis-grade, not proof, and the repo says so out loud. The point is the **method**: every claim above is reproducible from `measure-items` + `candle-items` with the scripts shipped in `content/*/assets/`.

📚 **[API Reference](https://backtest-kit.github.io/documents/example_02_first_backtest.html)** | 🌟 **[Quick Start](https://github.com/tripolskypetr/backtest-kit/tree/master/example)** | 📰 **[Article](https://backtest-kit.github.io/documents/article_08_ai_liquidity_harvesting.html)**


## 🚀 Quick Start

**1. Authorize Telegram** (userbot session via [telegram-reader](https://www.npmjs.com/package/telegram-reader); run from the channel folder — the session file is shared between channels):

```bash
cd content/crypto_yoda_channel
node -e 'require("telegram-reader").signIn()'   # QR code → Telegram → Settings → Devices
```

**2. Run a backtest** (frame lives in [modules/backtest.module.ts](modules/backtest.module.ts)):

```bash
npm start -- --backtest --ui --entry ./content/crypto_yoda_channel/main.strategy.ts

# same, pre-warming backtest candles into Mongo (faster replay)
npm start -- --backtest --ui --entry ./content/crypto_yoda_channel/main.strategy.ts --cache
```

Live mode: `--live` instead of `--backtest`. Symbols are hardcoded in [config/loader.config.ts](config/loader.config.ts); each symbol runs as its own `Backtest.background` context filtering the channel for its ticker.


## 📡 Two Channels, Two Formats

The core design lesson of this repo: **every channel has its own guidance format, and the schema, prompt, entry rules and position management must be derived from the author's actual posts — nothing invented.** [CLAUDE.md](CLAUDE.md) is the full playbook for onboarding the next channel; the two shipped ones are worked examples of opposite formats.

### [content/crypto_yoda_channel/](content/crypto_yoda_channel/) — "range + 5 targets + stop"

Classic signal format: `ЛОНГ в диапазоне $78600 - $79400`, five take-profit levels, hard stop. The strategy:

- parses `entryRange {from,to}`, `targets[5]` (strictly typed via `items: {type:"number"}`), `stoploss` into a nested schema;
- enters at market on any post ≤ 15 minutes old (5m cache interval — the edge lives near publication, and momentum signals never pull back into the zone);
- puts the exchange TP on the **farthest** target (direction-aware: `max` for long, `min` for short) and rides a **level ratchet**: every target crossed becomes a floor, a retrace beyond the last taken level by more than 30% of the local grid step closes the position. The slack is adaptive to grid density — PENGU steps are ~0.3–0.9%, BTC steps are hundreds of dollars.

### [content/vershinin_trader/](content/vershinin_trader/) — "I'm in, I'm out" with screenshots

No ranges, no targets, no stops. The author enters "at current levels", posts charts and exchange position cards, and announces closes in separate posts ("closing my shorts, taking the losses"). The strategy runs **two independent LLM pipelines**:

- **open** (`listenIdlePing` → `commitCreateSignal` + `Position.moonbag`, own 7.5% hard stop — the author publishes none): the model scans the whole 4h window (tickers come bare — `BTC`, `1000PEPE` — so nothing can be pre-filtered) and returns `long | short | wait`;
- **close** (`listenActivePing` → `commitClosePending`): `close` only when the author closes this symbol or everything at once; partial fixes, stop moves and breakevens are `hold`.

Both pipelines feed the model **images** — three kinds were found by actually looking at them (`assets/download-photos.mjs`): TradingView position-tool charts (direction = green TP zone above/below entry), BYDFi share cards and exchange position panels (direction written as *Лонг/Шорт*). The prompts explicitly warn about the classic trap: **a green P&L number on a short is profit, not "long"**.


## 🧠 LLM as a Parser, Not an Oracle

- **[json-inference](https://github.com/tripolskypetr/json-inference) is the fix for Ollama's broken structured output.** Cloud models ignore the `format` parameter and answer with markdown fences or arrays — `JSON.parse` dies. json-inference passes the schema through as `provide_answer` tool-call parameters: the tool grammar forces a valid object, responses are validated recursively and retried on mismatch. `ollama.chat` with `format` is never called directly.
- **The model is not deterministic, but the numbers are.** Comparing two cache generations over identical inputs: verdicts and every numeric field matched bit-for-bit; only the free-text `reasoning` (and its language) wandered. The tool grammar pins the structure; prices are copied from the post.
- **Prompt debugging is a regression suite, not vibes.** Each channel ships `assets/validate.mjs`: mandatory cases (every signal type, every non-signal type — ads, reports, analytics) run through the strategy's *exact* pipeline against the live model, exit code 1 on failure. A real FAIL caught this way: with multiple posts per window the model anchored on the last one — fixed with an explicit "scan ALL messages" prompt rule.


## 🔬 The Forensics Toolkit

Everything is measured from two Mongo collections written by the engine (`measure-items` — the persisted LLM cache; `candle-items` — 1m OHLCV warmed by `--cache`), with per-channel scripts in `content/*/assets/`:

| Script | Question it answers |
|---|---|
| `read-posts.mjs` | What does the author actually post? (formats, tickers, post types) |
| `download-photos.mjs` | What is actually on the images? (never write vision prompt rules from imagination) |
| `validate.mjs` | Does the prompt still parse every case after an edit? |
| `read-cache.mjs` | What did the model return across the whole month? (bucket listing + every non-null verdict with reasoning) |
| `event-study.mjs` | Directional move at +15m/+1h/+4h/+12h/+24h after each signal **and** pre-post drift — edge horizon vs trend-echo in one table |

The debugging doctrine (documented in [CLAUDE.md](CLAUDE.md)): never guess from code — reproduce the exact pipeline slice on real data with a throwaway inline script. The `JSON.parse` crash above was diagnosed by replaying the strategy's exact call on the exact post that produced it, byte for byte.

Thresholds follow one rule: **structural rules beat magic numbers, numbers come from process distributions (not trade outcomes), and any surviving constant must pass walk-forward** (`Sweep` + `Walker` over a 4–6 month frame) before it is trusted.


## 📜 Summary

| Aspect | This repo |
|---|---|
| **Subject** | Two real Telegram signal channels, opposite formats, replayed against 1m candles with no look-ahead bias |
| **Parser** | `gemma4:31b-cloud` through json-inference tool-grammar (text + images); numbers deterministic, reasoning free |
| **Execution** | Enter ≤ 15 min after the post (5m LLM cache); level-ratchet trailing / LLM-driven close; structural breakeven |
| **Key finding** | The edge is real but lives at 12–24h — not in the seller's targets (TP4/5 hit rate: 0/16) and not at their leverage (X15 stop = −67% margin) |
| **Attribution** | Month PnL −0.31% → **+3.37%** came entirely from exit engineering; naive "hold 24h" on the same posts ≈ +25.6% unleveraged with fat tails |
| **Honesty budget** | One month, 16–18 events per claim — hypothesis-grade; every number reproducible from `measure-items` + `candle-items` via shipped scripts |
| **Playbook** | [CLAUDE.md](CLAUDE.md): full onboarding guide for the next channel — session, post reading, prompt regression, 4h test run, 5m/15m production |
