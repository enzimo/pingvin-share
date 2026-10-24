import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
  ValidationPipe,
} from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import { AuthenticatedGuard } from "src/auth/guard/authenticated.guard";
import { AdministratorGuard } from "src/auth/guard/isAdmin.guard";
import { AppendFileDTO } from "./dto/appendFile.dto";
import { ShareService } from "./share.service";

@Controller("admin/shares/:shareId/files")
@UseGuards(AuthenticatedGuard, AdministratorGuard)
export class AdminShareFilesController {
  constructor(private readonly shares: ShareService) {}

  @Get()
  getUploadContext(@Param("shareId") shareId: string) {
    return this.shares.getFileAdditionContext(shareId);
  }

  @Delete(":fileId")
  remove(
    @Param("shareId") shareId: string,
    @Param("fileId", new ParseUUIDPipe()) fileId: string,
  ) {
    return this.shares.removeFile(shareId, fileId);
  }

  @Post()
  @SkipThrottle()
  append(
    @Param("shareId") shareId: string,
    @Query(new ValidationPipe({ transform: true, whitelist: true }))
    query: AppendFileDTO,
    @Body() body: string,
  ) {
    return this.shares.appendFile(shareId, body, query);
  }
}
