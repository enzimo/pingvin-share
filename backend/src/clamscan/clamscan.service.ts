import { Injectable, Logger } from "@nestjs/common";
import NodeClam from "clamscan";
import { FileService } from "src/file/file.service";
import { PrismaService } from "src/prisma/prisma.service";
import { CLAMAV_HOST, CLAMAV_PORT } from "../constants";

const clamscanConfig = {
  clamdscan: {
    host: CLAMAV_HOST,
    port: CLAMAV_PORT,
    localFallback: false,
  },
  preference: "clamdscan",
};
@Injectable()
export class ClamScanService {
  private readonly logger = new Logger(ClamScanService.name);

  constructor(
    private fileService: FileService,
    private prisma: PrismaService,
  ) {}

  private ClamScan: Promise<NodeClam | null> = new NodeClam()
    .init(clamscanConfig)
    .then((res) => {
      this.logger.log("ClamAV is active");
      return res;
    })
    .catch(() => {
      this.logger.log("ClamAV is not active");
      return null;
    });

  async check(shareId: string, fileIds?: string[]) {
    const clamScan = await this.ClamScan;

    if (!clamScan) return [];

    const infectedFiles = [];

    const files = await this.prisma.file.findMany({
      where: { shareId, ...(fileIds && { id: { in: fileIds } }) },
    });

    for (const file of files) {
      const stored = await this.fileService.get(shareId, file.id);
      try {
        const { isInfected } = await clamScan
          .scanStream(stored.file)
          .catch(() => {
            this.logger.log("ClamAV is not active");
            return { isInfected: false };
          });
        if (isInfected) infectedFiles.push({ id: file.id, name: file.name });
      } finally {
        stored.file.destroy();
      }
    }

    return infectedFiles;
  }

  async checkAndRemove(shareId: string, fileIds?: string[]) {
    const infectedFiles = await this.check(shareId, fileIds);

    if (infectedFiles.length > 0) {
      await this.fileService.deleteAllFiles(shareId);
      await this.prisma.file.deleteMany({ where: { shareId } });

      const fileNames = infectedFiles.map((file) => file.name).join(", ");

      await this.prisma.share.update({
        where: { id: shareId },
        data: {
          removedReason: `Your share got removed because the file(s) ${fileNames} are malicious.`,
        },
      });

      this.logger.warn(
        `Share ${shareId} deleted because it contained ${infectedFiles.length} malicious file(s)`,
      );
    }
  }
}
