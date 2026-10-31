import { timingSafeEqual } from "node:crypto";
import { json, type Middleware } from "../http.js";

export function webhookAuth(
  expectedSecret: string,
  headerName: string,
  additionalSecrets: string[] = [],
): Middleware {
  const normalizedHeader = headerName.toLowerCase();
  const allSecrets = [expectedSecret, ...additionalSecrets];

  return (next) => async (req, socketIp) => {
    const provided = req.headers.get(normalizedHeader);
    if (!provided) {
      return json({ error: "missing_auth_header" }, 401);
    }

    const providedBuf = Buffer.from(provided, "utf8");
    const match = allSecrets.some((secret) => {
      const expectedBuf = Buffer.from(secret, "utf8");
      return (
        expectedBuf.length === providedBuf.length &&
        timingSafeEqual(expectedBuf, providedBuf)
      );
    });

    if (!match) {
      return json({ error: "invalid_auth" }, 401);
    }

    return next(req, socketIp);
  };
}
