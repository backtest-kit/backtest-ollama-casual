process.chdir(new URL(".", import.meta.url).pathname);
import { scrapePage } from "telegram-reader";
const when = new Date("2027-01-01T00:00:00Z");
for (const offset of [50, 150, 300, 500]) {
  const batch = await scrapePage({ channel: "-1002199975612", limit: 5, offset, when });
  if (!batch.length) { console.log(`offset=${offset}: пусто (история кончилась)`); break; }
  const m = batch[batch.length - 1];
  console.log(`offset=${offset}: id=${m.id} date=${m.date.toISOString()}`);
}
process.exit(0);
