import { routeId } from "src/utils/routeId.util";
import {
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Request } from "express";
import moment from "moment";
import { PrismaService } from "src/prisma/prisma.service";
import { ShareSecurityGuard } from "src/share/guard/shareSecurity.guard";
import { ShareService } from "src/share/share.service";
import { ConfigService } from "src/config/config.service";
import { AuthService } from "src/auth/auth.service";

@Injectable()
export class FileSecurityGuard extends ShareSecurityGuard {
  constructor(
    private _shareService: ShareService,
    private _prisma: PrismaService,
    _config: ConfigService,
    private readonly auth: AuthService,
  ) {
    super(_shareService, _prisma, _config);
  }

  async canActivate(context: ExecutionContext) {
    const request: Request = context.switchToHttp().getRequest();

    const shareId = routeId(
      request,
      "shareId" in request.params ? "shareId" : "id",
    );

    const shareToken = request.cookies[`share_${shareId}_token`];

    const share = await this._prisma.share.findUnique({
      where: { id: shareId },
      include: { security: true, reverseShare: true },
    });

    // If there is no share token the user requests a file directly
    if (!shareToken) {
      if (
        !share ||
        (moment().isAfter(share.expiration) &&
          !moment(share.expiration).isSame(0))
      ) {
        throw new NotFoundException("File not found");
      }

      if (share.reverseShare && !share.reverseShare.publicAccess) {
        const userId = await this.auth.getIdOfCurrentUser(request);
        if (
          !userId ||
          (userId !== share.creatorId &&
            userId !== share.reverseShare.creatorId)
        )
          throw new ForbiddenException("This reverse share is private");
      }

      if (share.security?.password)
        throw new ForbiddenException("This share is password protected");

      if (share.security?.maxViews && share.security.maxViews <= share.views) {
        throw new ForbiddenException(
          "Maximum views exceeded",
          "share_max_views_exceeded",
        );
      }

      await this._shareService.increaseViewCount(share);
      return true;
    } else {
      return super.canActivate(context);
    }
  }
}
