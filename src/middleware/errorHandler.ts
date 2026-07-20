import type { Request, Response, NextFunction } from "express";

interface HttpError extends Error {
  status?: number;
  type?: string;
}

export function errorHandler(
  err: HttpError,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err.type === "entity.parse.failed") {
    res.status(400).json({ error: "invalid_json" });
    return;
  }
  if (err.status === 413 || err.type === "entity.too.large") {
    res.status(413).json({ error: "payload_too_large" });
    return;
  }
  const statusCode = err.status ?? 500;
  res.status(statusCode).json({ error: "internal_error" });
}