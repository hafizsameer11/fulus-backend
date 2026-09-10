import { createApp } from "./app.js";
import { env } from "./config/env.js";

const app = createApp();

app.listen(env.PORT, () => {
  console.log(`fulus-api listening on http://localhost:${env.PORT}`);
  console.log(`health: http://localhost:${env.PORT}/api/v1/health`);
});
