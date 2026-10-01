# Стратегия wallstreet_queen_channel

LLM-стратегия для [backtest-kit](https://github.com/tripolskypetr/backtest-kit): читает англоязычный Telegram-канал [WallstreetQueenOfficial](https://t.me/WallstreetQueenOfficial) через `telegram-reader`, извлекает торговые сигналы моделью `gemma4:31b-cloud` (structured output через [json-inference](https://github.com/tripolskypetr/json-inference)), входит только по свежим постам (не старше 15 минут) и сопровождает открытую позицию трейлингом по уровням тейк-профитов.

Формат канала совпадает с crypto-yoda («диапазон входа + сетка целей + стоп»), поэтому схема LLM, правила входа и сопровождение скопированы оттуда. Канал найден и проверен скрейпом в октябре 2026: сигналы публикуются в бесплатной ленте, стабильным шаблоном.

## Файлы

| Файл | Назначение |
|---|---|
| `main.strategy.ts` | Прод: кеш 5 минут, вход по посту не старше 15 минут, трейлинг уровней |
| `main.test.ts` | Тестовый вариант (4h) + сниппеты (безубыток, Log-телеметрия) |
| `prompt.mustache` | Промпт для LLM: правила преобразования поста в JSON |
| `session.txt` | MTProto-сессия Telegram (общая, скопирована из crypto_yoda_channel) |
| `assets/` | read-posts / download-photos / validate / read-cache |
| `dump/` | Отчёты бэктеста |

## Формат постов канала (проверено на реальных постах, сентябрь 2026)

### Сигнал (вход в позицию), пост id=10371

```
Coin: #CHZUSDT

Direction: Long

Leverage: 10x

Entry: 0.01598$ - 0.01540$

Targets: 0.01640 - 0.01680 - 0.01720 - 0.01760 - 0.01860$

Stoploss: 0.01520$
```

### Шорт (редкий), пост id=10159

```
Coin: #DASHUSDT

Direction: Short

Leverage: 5-10x

Entry: 32.70 - 33.50$(Enter partially)

Targets: 32 - 31.2 - 30.4 - 29.8 - 28.2 - 27 - 26$(Short term)

Stoploss: 34.00$
```

Особенности относительно crypto-yoda (всё проверено сканом 300 постов, 14 июня – 30 сен 2026: 26 сигналов — 24 Long, 2 Short):

- тег монеты — полный тикер без слэша: `#CHZUSDT` (у yoda `#BTC/USDT`), поэтому фильтр постов до LLM — `content.includes("#" + symbol)`;
- целей обычно 5, бывает от 2 до 7 (TRX id=10306 — две, DASH id=10159 — семь); гейт `!entry.targets[2]` (как у yoda) отбрасывает сигналы с менее чем тремя целями;
- первая цена в `Entry` — ближняя к рынку, вторая — дальняя (у лонга ниже, у шорта выше);
- после цен бывают аннотации в скобках — `(Enter partially)`, `(Short term)` — промпт явно требует их игнорировать;
- `Leverage: 10x` (или диапазон `5-10x`) автора игнорируем (как X13–25 у yoda) — берём направление/зону/цели/стоп;
- к сигнальным постам приложен график (photo), но весь сигнал есть в тексте — vision не нужен;
- частота: ~26 сигналов за 3.5 месяца, в сентябре плотнее (13 за месяц); монеты в основном мелкие альты (CHZ, CGPT, PIXEL, SPELL, GTC, SHELL, GRT, RSR, NOT, SUSHI, ANKR, KSM, ALT, MEW, HFT, MORPHO...), из крупных — ETH, BNB, XRP, TRX, DASH.

### Отчёт о результате (фильтруется, вход не создаёт), пост id=10372

```
COIN: #CHZUSDT

1st,2nd,3rd Target done🔥

Target 1: 0.01640$✅
Target 2: 0.01680$✅
Target 3: 0.01720$✅

100% Profit with 10x🤑
...
VIP ONLY (WALLSTREET QUEEN OFFICIAL)
```

Проходит фильтр по `#COIN`, модель обязана вернуть `position: "wait"`.

### Аналитика/новости (фильтруется), пост id=10374

```
#DOGEUSDT UPDATE:

It has already broken out of the symmetrical triangle on hourly timeframe...
```

Тоже проходит фильтр по тегу — промпт явно требует фильтровать посты без входа. Рекламу VIP и макро-новости без тикера отсекает фильтр содержимого ещё до LLM.

## Как работает

Пайплайн идентичен crypto_yoda_channel (см. его README): `Cache.file` (бакет `wallstreet_queen_entry_v2`, 5 минут) → `scrapeLookback` за 15 минут → фильтр по `#SYMBOL` → `generateObject` → гейт свежести/целей → вход по рынку, тейк на дальнюю цель, стоп из поста, цели в `payload.levels` → трейлинг уровней (`LEVEL_DRIFT_RATIO = 0.3`).

Тестовый вариант — бакет `wallstreet_queen_entry_v1`, интервал 4h.

Внимание: пороги (люфт 0.3, безубыток 0.5 до TP1 в тесте) перенесены с crypto-yoda как стартовые. Их валидность для этого канала не проверена — подбирать заново по Log-телеметрии после тестового прогона, кандидаты обязаны пережить walk-forward.

## Запуск

```bash
# тест (4h, отладка промпта на месяце постов)
npm start -- --backtest --ui --entry ./content/wallstreet_queen_channel/main.test.ts

# прод-бэктест
npm start -- --backtest --ui --entry ./content/wallstreet_queen_channel/main.strategy.ts --cache
```

Команду запускает сам пользователь. Перед прогоном: в `config/loader.config.ts` в `SYMBOL_LIST` должны стоять монеты этого канала.

Перед бэктестом прогнать регрессию промпта (живая модель, exit 1 при FAIL):

```bash
node assets/validate.mjs
```

Смена схемы LLM или логики отбора постов = новое имя кеша (`wallstreet_queen_entry_v3`, ...). Перед занятием имени проверить `node assets/read-cache.mjs`, что бакет не существует или пуст.
