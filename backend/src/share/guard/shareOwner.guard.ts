import { routeId } from "src/utils/routeId.util";
import {
  ExecutionContext,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { User } from "@prisma/client";
import { Request } from "express";
import { ConfigService } from "src/config/config.service";
import { PrismaService } from "src/prisma/prisma.service";
import { JwtGuard } from "../../auth/guard/jwt.guard";
import { JwtService } from "@nestjs/jwt";

@Injectable()
export class ShareOwnerGuard extends JwtGuard {
  constructor(
    private readonly shareConfig: ConfigService,
    private prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {
    super(shareConfig);
  }

  async canActivate(context: ExecutionContext) {
    const request: Request = context.switchToHttp().getRequest();
    const shareId = routeId(
      request,
      "shareId" in request.params ? "shareId" : "id",
    );

    const share = await this.prisma.share.findUnique({
      where: { id: shareId },
      include: { security: true, reverseShare: true },
    });

    if (!share) throw new NotFoundException("Share not found");

    // Run the JWTGuard to set the user
    await super.canActivate(context);
    const user = request.user as User;

    // If the user is an admin, allow access
    if (user?.isAdmin) return true;

    if (user && share.reverseShare?.creatorId === user.id) return true;

    // Anonymous upload ownership is a capability issued only at creation.
    if (!share.creatorId && !share.uploadLocked) {
      try {
        const claims = this.jwt.verify(
          request.cookies[`share_${shareId}_owner`],
          {
            secret: this.shareConfig.get("internal.jwtSecret"),
            algorithms: ["HS256"],
          },
        );
        return (
          claims.purpose === "upload-owner" &&
          claims.shareId === shareId &&
          claims.createdAt === share.createdAt.toISOString()
        );
      } catch {
        return false;
      }
    }

    // If not signed in, deny access
    if (!user) return false;

    // If the user is the creator of the share, allow access
    return share.creatorId == user.id;
  }
}
