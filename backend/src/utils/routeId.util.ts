import { BadRequestException } from "@nestjs/common";
import { Request } from "express";

export function routeId(request: Request, name: string): string {
  const value = request.params[name];
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(value))
    throw new BadRequestException("Invalid resource ID");
  return value;
}
