import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

export function webhookAuth(expectedSecret: string, headerName: string) {
  const normalizedHeader = headerName.toLowerCase();

  return (req: Request, res: Response, next: NextFunction) => {
    const provided = req.get(normalizedHeader);
    if (!provided) {
      res.status(401).json({ error: "missing_auth_header" });
      return;
    }

    const expected = Buffer.from(expectedSecret, "utf8");
    const actual = Buffer.from(provided, "utf8");

    if (
      expected.length !== actual.length ||
      !timingSafeEqual(expected, actual)
    ) {
      res.status(401).json({ error: "invalid_auth" });
      return;
    }

    next();
  };
}