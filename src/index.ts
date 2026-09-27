import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { startFloatJobScheduler } from "./modules/float/services/float-jobs.service.js";

const app = createApp();

app.listen(env.PORT, () => {
  console.log(`fulus-api listening on http://localhost:${env.PORT}`);
  console.log(`health: http://localhost:${env.PORT}/api/v1/health`);
  startFloatJobScheduler();
});
