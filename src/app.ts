import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { apiRouter } from "./routes/index.js";
import { errorHandler } from "./middleware/error-handler.js";

declare module "express-serve-static-core" {
  interface Request {
    rawBody?: string;
  }
}

export function createApp() {
  const app = express();

  app.use(helmet({
    // Allow mobile / web clients on other origins to call the API
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }));
  app.use(cors({ origin: true, credentials: true }));
  app.use(morgan("dev"));
  // Selfie / KYC payloads are base64 — allow a few MB.
  // Capture rawBody for eSIM Go HMAC webhook verification (V3 uses raw bytes).
  app.use(
    express.json({
      limit: "8mb",
      verify: (req, _res, buf) => {
        (req as express.Request).rawBody = buf.toString("utf8");
      },
    }),
  );
  app.use(express.urlencoded({ extended: true, limit: "8mb" }));

  app.use("/api/v1", apiRouter);

  app.use(errorHandler);
  return app;
}
