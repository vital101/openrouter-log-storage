import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

export function webhookAuth(
  expectedSecret: string,
  headerName: string,
  additionalSecrets: string[] = [],
) {
  const normalizedHeader = headerName.toLowerCase();
  const allSecrets = [expectedSecret, ...additionalSecrets];

  return (req: Request, res: Response, next: NextFunction) => {
    const provided = req.get(normalizedHeader);
    if (!provided) {
      res.status(401).json({ error: "missing_auth_header" });
      return;
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
      res.status(401).json({ error: "invalid_auth" });
      return;
    }

    next();
  };
}