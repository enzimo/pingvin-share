import { Injectable } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { User } from "@prisma/client";
import { Request } from "express";
import { Strategy } from "passport-jwt";
import { ConfigService } from "src/config/config.service";
import { PrismaService } from "src/prisma/prisma.service";

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private prisma: PrismaService,
  ) {
    config.get("internal.jwtSecret");
    super({
      jwtFromRequest: JwtStrategy.extractJWT,
      secretOrKey: config.get("internal.jwtSecret"),
    });
  }

  private static extractJWT(req: Request) {
    if (!req.cookies.access_token) return null;
    return req.cookies.access_token;
  }

  async validate(payload: { sub: string; refreshTokenId?: string }) {
    if (!payload.sub || !payload.refreshTokenId) return null;
    const session = await this.prisma.refreshToken.findFirst({
      where: {
        id: payload.refreshTokenId,
        userId: payload.sub,
        expiresAt: { gt: new Date() },
      },
    });
    if (!session) return null;
    const user: User = await this.prisma.user.findUnique({
      where: { id: payload.sub },
    });
    return user;
  }
}
