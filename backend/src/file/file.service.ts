import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { LocalFileService } from "./local.service";
import { S3FileService } from "./s3.service";
import { ConfigService } from "src/config/config.service";
import { Readable } from "stream";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class FileService {
  constructor(
    private prisma: PrismaService,
    private localFileService: LocalFileService,
    private s3FileService: S3FileService,
    private configService: ConfigService,
  ) {}

  private getStorageService(
    storageProvider: string,
  ): S3FileService | LocalFileService {
    return storageProvider === "S3"
      ? this.s3FileService
      : this.localFileService;
  }

  async create(
    data: string,
    chunk: { index: number; total: number },
    file: {
      id?: string;
      name: string;
    },
    shareId: string,
    allowCompleted = false,
  ) {
    const share = await this.prisma.share.findUnique({
      where: { id: shareId },
      include: { files: true, reverseShare: true },
    });
    if (!share) throw new NotFoundException("Share not found");
    if (share.uploadLocked && !allowCompleted)
      throw new BadRequestException("Share is already completed");
    if (
      file.id &&
      (await this.prisma.file.findUnique({ where: { id: file.id } }))
    )
      throw new ConflictException("File already exists");

    const storageService = this.getStorageService(share.storageProvider);
    const expectedChunkIndex = file.id
      ? await storageService.getExpectedChunkIndex(shareId, file.id)
      : 0;
    if (chunk.index !== expectedChunkIndex)
      throw new BadRequestException({
        message: "Unexpected chunk received",
        error: "unexpected_chunk_index",
        expectedChunkIndex,
      });
    const size =
      share.files.reduce((sum, file) => sum + Number(file.size), 0) +
      (await storageService.getPendingSize(shareId)) +
      Buffer.from(data, "base64").byteLength;
    if (
      size > Number(this.configService.get("share.maxSize")) ||
      (share.reverseShare && size > Number(share.reverseShare.maxShareSize))
    )
      throw new HttpException(
        "Max share size exceeded",
        HttpStatus.PAYLOAD_TOO_LARGE,
      );

    return storageService.create(data, chunk, file, shareId, allowCompleted);
  }

  async get(shareId: string, fileId: string): Promise<File> {
    const share = await this.prisma.share.findFirst({
      where: { id: shareId },
    });
    if (!share) throw new NotFoundException("Share not found");
    const storageService = this.getStorageService(share.storageProvider);
    return storageService.get(shareId, fileId);
  }

  async remove(shareId: string, fileId: string) {
    const storageService = await this.getShareStorageService(shareId);
    return storageService.remove(shareId, fileId);
  }

  async deleteAllFiles(shareId: string) {
    const storageService = await this.getShareStorageService(shareId);
    return storageService.deleteAllFiles(shareId);
  }

  async getZip(shareId: string): Promise<Readable> {
    const share = await this.prisma.share.findUnique({
      where: { id: shareId },
    });
    if (!share) throw new NotFoundException("Share not found");
    if (!share.isZipReady) throw new ConflictException("ZIP is being prepared");
    const storageService = this.getStorageService(share.storageProvider);
    return await storageService.getZip(shareId);
  }

  private async getShareStorageService(shareId: string) {
    const share = await this.prisma.share.findUnique({
      where: { id: shareId },
    });
    if (!share) throw new NotFoundException("Share not found");
    return this.getStorageService(share.storageProvider);
  }

  private async streamToUint8Array(stream: Readable): Promise<Uint8Array> {
    const chunks: Buffer[] = [];

    return new Promise((resolve, reject) => {
      stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      stream.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
      stream.on("error", reject);
    });
  }
}

export interface File {
  metaData: {
    id: string;
    size: string;
    createdAt: Date;
    mimeType: string | false;
    name: string;
    shareId: string;
  };
  file: Readable;
}
