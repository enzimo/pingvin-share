import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import * as crypto from "crypto";
import { createReadStream } from "fs";
import * as fs from "fs/promises";
import * as mime from "mime-types";
import { ConfigService } from "src/config/config.service";
import { PrismaService } from "src/prisma/prisma.service";
import { validate as isValidUUID } from "uuid";
import { SHARE_DIRECTORY } from "../constants";
import { Readable } from "stream";

@Injectable()
export class LocalFileService {
  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {}

  async create(
    data: string,
    chunk: { index: number; total: number },
    file: { id?: string; name: string },
    shareId: string,
    allowCompleted = false,
  ) {
    if (!file.id) {
      file.id = crypto.randomUUID();
    } else if (!isValidUUID(file.id)) {
      throw new BadRequestException("Invalid file ID format");
    }

    const share = await this.prisma.share.findUnique({
      where: { id: shareId },
      include: { files: true, reverseShare: true },
    });

    if (share.uploadLocked && !allowCompleted)
      throw new BadRequestException("Share is already completed");

    // If the sent chunk index and the expected chunk index doesn't match throw an error
    const expectedChunkIndex = await this.getExpectedChunkIndex(
      shareId,
      file.id,
    );

    if (expectedChunkIndex != chunk.index)
      throw new BadRequestException({
        message: "Unexpected chunk received",
        error: "unexpected_chunk_index",
        expectedChunkIndex,
      });

    const buffer = Buffer.from(data, "base64");

    // Check if there is enough space on the server
    const space = await fs.statfs(SHARE_DIRECTORY);
    const availableSpace = space.bavail * space.bsize;
    if (availableSpace < buffer.byteLength) {
      throw new InternalServerErrorException("Not enough space on the server");
    }

    await fs.appendFile(
      `${SHARE_DIRECTORY}/${shareId}/${file.id}.tmp-chunk`,
      buffer,
    );

    const isLastChunk = chunk.index == chunk.total - 1;
    if (isLastChunk) {
      await fs.rename(
        `${SHARE_DIRECTORY}/${shareId}/${file.id}.tmp-chunk`,
        `${SHARE_DIRECTORY}/${shareId}/${file.id}`,
      );
      const fileSize = (
        await fs.stat(`${SHARE_DIRECTORY}/${shareId}/${file.id}`)
      ).size;
      await this.prisma.$transaction([
        this.prisma.file.create({
          data: {
            id: file.id,
            name: file.name,
            size: fileSize.toString(),
            share: { connect: { id: shareId } },
          },
        }),
        this.prisma.share.update({
          where: { id: shareId },
          data: { isZipReady: false },
        }),
      ]);
    }

    return file;
  }

  async getPendingSize(shareId: string) {
    const directory = `${SHARE_DIRECTORY}/${shareId}`;
    const files = await fs.readdir(directory);
    const sizes = await Promise.all(
      files
        .filter((name) => name.endsWith(".tmp-chunk"))
        .map(async (name) => {
          try {
            return (await fs.stat(`${directory}/${name}`)).size;
          } catch (error) {
            if (error.code === "ENOENT") return 0;
            throw error;
          }
        }),
    );
    return sizes.reduce((total, size) => total + size, 0);
  }

  async getExpectedChunkIndex(shareId: string, fileId: string) {
    if (!isValidUUID(fileId))
      throw new BadRequestException("Invalid file ID format");
    try {
      const stat = await fs.stat(
        `${SHARE_DIRECTORY}/${shareId}/${fileId}.tmp-chunk`,
      );
      return Math.ceil(stat.size / Number(this.config.get("share.chunkSize")));
    } catch (error) {
      if (error.code === "ENOENT") return 0;
      throw error;
    }
  }

  async get(shareId: string, fileId: string) {
    const fileMetaData = await this.prisma.file.findFirst({
      where: { id: fileId, shareId },
    });

    if (!fileMetaData) throw new NotFoundException("File not found");

    const file = createReadStream(`${SHARE_DIRECTORY}/${shareId}/${fileId}`);

    return {
      metaData: {
        mimeType: mime.contentType(fileMetaData.name.split(".").pop()),
        ...fileMetaData,
        size: fileMetaData.size,
      },
      file,
    };
  }

  async remove(shareId: string, fileId: string) {
    const fileMetaData = await this.prisma.file.findFirst({
      where: { id: fileId, shareId },
    });

    if (!fileMetaData) throw new NotFoundException("File not found");

    await fs.unlink(`${SHARE_DIRECTORY}/${shareId}/${fileId}`);

    await this.prisma.$transaction([
      this.prisma.file.delete({ where: { id: fileId, shareId } }),
      this.prisma.share.update({
        where: { id: shareId },
        data: { isZipReady: false },
      }),
    ]);
  }

  async deleteAllFiles(shareId: string) {
    await fs.rm(`${SHARE_DIRECTORY}/${shareId}`, {
      recursive: true,
      force: true,
    });
  }

  async getZip(shareId: string): Promise<Readable> {
    return new Promise((resolve, reject) => {
      const zipStream = createReadStream(
        `${SHARE_DIRECTORY}/${shareId}/archive.zip`,
      );

      zipStream.on("error", (err) => {
        reject(new InternalServerErrorException(err));
      });

      zipStream.on("open", () => {
        resolve(zipStream);
      });
    });
  }
}
