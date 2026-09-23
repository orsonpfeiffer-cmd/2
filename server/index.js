import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createAiClassifier } from './classifier.js';
import { createPipeline } from './pipeline.js';
import { createApp } from './app.js';
import { createScheduler } from './scheduler.js';
import { createOverviewer } from './overview.js';

async function main() {
  const config = await loadConfig();
  const db = openDb();
  const ai = createAiClassifier(config);
  const pipeline = createPipeline({ db, config, ai });
  const minutes = Number(process.env.FETCH_INTERVAL_MINUTES) || config.settings.fetchIntervalMinutes;
  const scheduler = createScheduler(pipeline, minutes);
  const overviewer = createOverviewer(config, db);
  const app = createApp({ db, config, ai, overviewer, scheduler });

  const port = Number(process.env.PORT) || 3000;
  const server = app.listen(port, () => {
    console.log(`Car Radar on http://localhost:${port}`);
    console.log(`${config.sources.length} sources, refresh every ${minutes} min, labels by ${ai ? `Claude (${ai.model})` : 'keyword rules (no ANTHROPIC_API_KEY)'}`);
    scheduler.start();
  });

  const shutdown = () => {
    scheduler.stop();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
