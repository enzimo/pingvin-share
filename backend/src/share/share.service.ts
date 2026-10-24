import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { JwtService, JwtSignOptions } from "@nestjs/jwt";
import { Share, User } from "@prisma/client";
import archiver from "archiver";
import * as argon from "argon2";
import * as fs from "fs";
import { randomUUID } from "crypto";
import moment from "moment";
import { ClamScanService } from "src/clamscan/clamscan.service";
import { ConfigService } from "src/config/config.service";
import { EmailService } from "src/email/email.service";
import { FileService } from "src/file/file.service";
import { PrismaService } from "src/prisma/prisma.service";
import { ReverseShareService } from "src/reverseShare/reverseShare.service";
import { parseRelativeDateToAbsolute } from "src/utils/date.util";
import { SHARE_DIRECTORY } from "../constants";
import { CreateShareDTO } from "./dto/createShare.dto";
import { AppendFileDTO } from "./dto/appendFile.dto";

@Injectable()
export class ShareService {
  private readonly fileMutations = new Map<string, Promise<void>>();
  private readonly zipCreations = new Map<string, Promise<void>>();
  private readonly logger = new Logger(ShareService.name);
  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
    private fileService: FileService,
    private emailService: EmailService,
    private config: ConfigService,
    private jwtService: JwtService,
    private reverseShareService: ReverseShareService,
    private clamScanService: ClamScanService,
  ) {}

  async create(share: CreateShareDTO, user?: User, reverseShareToken?: string) {
    if (!(await this.isShareIdAvailable(share.id)).isAvailable)
      throw new BadRequestException("Share id already in use");

    if (!share.security || Object.keys(share.security).length == 0)
      share.security = undefined;

    if (share.security?.password) {
      share.security.password = await argon.hash(share.security.password);
    }

    let expirationDate: Date;

    // If share is created by a reverse share token override the expiration date
    const reverseShare =
      await this.reverseShareService.getByToken(reverseShareToken);
    if (reverseShare) {
      expirationDate = reverseShare.shareExpiration;
    } else {
      const parsedExpiration = parseRelativeDateToAbsolute(share.expiration);

      const expiresNever = moment(0).toDate() == parsedExpiration;

      const maxExpiration = this.config.get("share.maxExpiration");
      if (
        maxExpiration.value !== 0 &&
        (expiresNever ||
          parsedExpiration >
            moment().add(maxExpiration.value, maxExpiration.unit).toDate())
      ) {
        throw new BadRequestException(
          "Expiration date exceeds maximum expiration date",
        );
      }

      expirationDate = parsedExpiration;
    }

    fs.mkdirSync(`${SHARE_DIRECTORY}/${share.id}`, {
      recursive: true,
    });

    const shareTuple = await this.prisma.share.create({
      data: {
        ...share,
        expiration: expirationDate,
        creator: { connect: user ? { id: user.id } : undefined },
        security: { create: share.security },
        recipients: {
          create: share.recipients
            ? share.recipients.map((email) => ({ email }))
            : [],
        },
        storageProvider: this.configService.get("s3.enabled") ? "S3" : "LOCAL",
      },
    });

    if (reverseShare) {
      // Assign share to reverse share token
      await this.prisma.reverseShare.update({
        where: { token: reverseShareToken },
        data: {
          shares: {
            connect: { id: shareTuple.id },
          },
        },
      });
    }

    return shareTuple;
  }

  async createZip(shareId: string): Promise<void> {
    const existing = this.zipCreations.get(shareId);
    if (existing !== undefined) {
      await existing.catch(() => undefined);
      const share = await this.prisma.share.findUnique({
        where: { id: shareId },
      });
      if (share && !share.isZipReady) return this.createZip(shareId);
      return;
    }
    const operation = Promise.resolve().then(async () => {
      let ready = false;
      while (!ready) {
        const fileIds = await this.writeZip(shareId);
        ready = await this.prisma.$transaction(async (transaction) => {
          const current = await transaction.file.findMany({
            where: { shareId },
            select: { id: true },
            orderBy: { id: "asc" },
          });
          if (
            current.length !== fileIds.length ||
            current.some((file, index) => file.id !== fileIds[index])
          )
            return false;
          await transaction.share.update({
            where: { id: shareId },
            data: { isZipReady: true },
          });
          return true;
        });
      }
    });
    this.zipCreations.set(shareId, operation);
    try {
      await operation;
    } finally {
      if (this.zipCreations.get(shareId) === operation)
        this.zipCreations.delete(shareId);
    }
  }

  private async writeZip(shareId: string) {
    const share = await this.prisma.share.findUnique({
      where: { id: shareId },
    });
    if (!share) throw new NotFoundException("Share not found");

    const path = `${SHARE_DIRECTORY}/${shareId}`;

    const files = await this.prisma.file.findMany({
      where: { shareId },
      orderBy: { id: "asc" },
    });
    const fileIds = files.map((file) => file.id);
    if (share.storageProvider === "S3") return fileIds;
    const archive = archiver("zip", {
      zlib: { level: this.config.get("share.zipCompressionLevel") },
    });
    const temporaryPath = `${path}/archive-${randomUUID()}.tmp`;
    const writeStream = fs.createWriteStream(temporaryPath);
    try {
      await new Promise<void>((resolve, reject) => {
        archive.on("error", reject);
        writeStream.on("error", reject);
        writeStream.on("close", resolve);
        archive.pipe(writeStream);
        for (const file of files) {
          const stream = fs.createReadStream(`${path}/${file.id}`);
          stream.on("error", reject);
          archive.append(stream, { name: file.name });
        }
        void archive.finalize().catch(reject);
      });
      await fs.promises.rename(temporaryPath, `${path}/archive.zip`);
      return fileIds;
    } catch (error) {
      archive.abort();
      writeStream.destroy();
      await fs.promises.rm(temporaryPath, { force: true });
      throw error;
    }
  }

  private async getShareForFileManagement(id: string) {
    const share = await this.prisma.share.findUnique({
      where: { id },
      include: { files: true, reverseShare: true },
    });
    if (
      !share ||
      share.removedReason ||
      (share.expiration.getTime() !== 0 && share.expiration <= new Date())
    )
      throw new NotFoundException("Share not found");
    if (!share.uploadLocked)
      throw new ConflictException("Complete the share before managing files");
    return share;
  }

  async getFileAdditionContext(id: string) {
    const share = await this.getShareForFileManagement(id);
    return {
      id: share.id,
      name: share.name,
      fileNames: share.files.map((file) => file.name),
      files: share.files.map(({ id, name, size }) => ({ id, name, size })),
      size: share.files.reduce((size, file) => size + Number(file.size), 0),
      maxSize: Math.min(
        Number(this.config.get("share.maxSize")),
        share.reverseShare ? Number(share.reverseShare.maxShareSize) : Infinity,
      ),
    };
  }

  async appendFile(id: string, data: string, file: AppendFileDTO) {
    return this.mutateFiles(id, async () => {
      const share = await this.getShareForFileManagement(id);
      if (share.files.some((existing) => existing.name === file.name))
        throw new ConflictException("A file with this name already exists");
      if (
        file.chunkIndex >= file.totalChunks ||
        (file.chunkIndex < file.totalChunks - 1 &&
          Buffer.from(data, "base64").byteLength !==
            Number(this.config.get("share.chunkSize")))
      )
        throw new BadRequestException("Invalid file chunks");
      const result = await this.fileService.create(
        data,
        { index: file.chunkIndex, total: file.totalChunks },
        { id: file.id, name: file.name },
        id,
        true,
      );
      if (file.chunkIndex === file.totalChunks - 1) {
        void this.clamScanService
          .checkAndRemove(id, [result.id])
          .catch((error) =>
            this.logger.error("Could not scan added file", error),
          );
        void this.createZip(id).catch((error) =>
          this.logger.error("Could not prepare share ZIP", error),
        );
      }
      return result;
    });
  }

  async removeFile(id: string, fileId: string) {
    return this.mutateFiles(id, async () => {
      const share = await this.getShareForFileManagement(id);
      if (!share.files.some((file) => file.id === fileId))
        throw new NotFoundException("File not found");
      if (share.files.length <= 1)
        throw new ConflictException(
          "A share must contain at least one file. Add a replacement first or delete the share.",
        );

      // Let any archive using this file finish before removing its contents.
      // The storage service atomically removes metadata and invalidates the ZIP.
      await this.zipCreations.get(id)?.catch(() => undefined);
      await this.fileService.remove(id, fileId);
      void this.createZip(id).catch((error) =>
        this.logger.error("Could not prepare share ZIP", error),
      );
      return this.getFileAdditionContext(id);
    });
  }

  private async mutateFiles<T>(id: string, mutate: () => Promise<T>) {
    // Share one queue for additions and deletions so quotas, last-file checks
    // and background archives observe each preceding change.
    const previous = this.fileMutations.get(id) ?? Promise.resolve();
    const operation = previous.then(mutate);
    const settled = operation.then(
      () => undefined,
      () => undefined,
    );
    this.fileMutations.set(id, settled);
    try {
      return await operation;
    } finally {
      if (this.fileMutations.get(id) === settled) this.fileMutations.delete(id);
    }
  }

  async complete(id: string, reverseShareToken?: string) {
    const share = await this.prisma.share.findUnique({
      where: { id },
      include: {
        files: true,
        recipients: true,
        creator: true,
        reverseShare: { include: { creator: true } },
      },
    });

    if (await this.isShareCompleted(id))
      throw new BadRequestException("Share already completed");

    if (share.files.length == 0)
      throw new BadRequestException(
        "You need at least on file in your share to complete it.",
      );

    // Asynchronously create a zip of all files
    if (share.files.length > 1)
      void this.createZip(id).catch((error) =>
        this.logger.error("Could not prepare share ZIP", error),
      );

    // Send email for each recipient
    for (const recipient of share.recipients) {
      await this.emailService.sendMailToShareRecipients(
        recipient.email,
        share.id,
        share.creator,
        share.description,
        share.expiration,
      );
    }

    const notifyReverseShareCreator = share.reverseShare
      ? this.config.get("smtp.enabled") &&
        share.reverseShare.sendEmailNotification
      : undefined;

    if (notifyReverseShareCreator) {
      await this.emailService.sendMailToReverseShareCreator(
        share.reverseShare.creator.email,
        share.id,
      );
    }

    // Check if any file is malicious with ClamAV
    void this.clamScanService.checkAndRemove(share.id);

    if (share.reverseShare) {
      await this.prisma.reverseShare.update({
        where: { token: reverseShareToken },
        data: { remainingUses: { decrement: 1 } },
      });
    }

    const updatedShare = await this.prisma.share.update({
      where: { id },
      data: { uploadLocked: true },
    });

    return {
      ...updatedShare,
      notifyReverseShareCreator,
    };
  }

  async revertComplete(id: string) {
    if (this.fileMutations.has(id) || this.zipCreations.has(id))
      throw new ConflictException("Files are being updated");
    return this.prisma.share.update({
      where: { id },
      data: { uploadLocked: false, isZipReady: false },
    });
  }

  async getShares() {
    const shares = await this.prisma.share.findMany({
      orderBy: {
        expiration: "desc",
      },
      include: { files: true, creator: true },
    });

    return shares.map((share) => {
      return {
        ...share,
        size: share.files.reduce((acc, file) => acc + parseInt(file.size), 0),
      };
    });
  }

  async getSharesByUser(userId: string) {
    const shares = await this.prisma.share.findMany({
      where: {
        creator: { id: userId },
        uploadLocked: true,
        // We want to grab any shares that are not expired or have their expiration date set to "never" (unix 0)
        OR: [
          { expiration: { gt: new Date() } },
          { expiration: { equals: moment(0).toDate() } },
        ],
      },
      orderBy: {
        expiration: "desc",
      },
      include: { recipients: true, files: true, security: true },
    });

    return shares.map((share) => {
      return {
        ...share,
        size: share.files.reduce((acc, file) => acc + parseInt(file.size), 0),
        recipients: share.recipients.map((recipients) => recipients.email),
        security: {
          maxViews: share.security?.maxViews,
          passwordProtected: !!share.security?.password,
        },
      };
    });
  }

  async get(id: string): Promise<any> {
    const share = await this.prisma.share.findUnique({
      where: { id },
      include: {
        files: {
          orderBy: {
            name: "asc",
          },
        },
        creator: true,
        security: true,
      },
    });

    if (!share) throw new NotFoundException("Share not found");
    if (share.removedReason)
      throw new NotFoundException(share.removedReason, "share_removed");

    if (!share || !share.uploadLocked)
      throw new NotFoundException("Share not found");
    return {
      ...share,
      hasPassword: !!share.security?.password,
    };
  }

  async getMetaData(id: string) {
    const share = await this.prisma.share.findUnique({
      where: { id },
    });

    if (!share || !share.uploadLocked)
      throw new NotFoundException("Share not found");

    return share;
  }

  async remove(shareId: string, isDeleterAdmin = false) {
    const share = await this.prisma.share.findUnique({
      where: { id: shareId },
    });

    if (!share) throw new NotFoundException("Share not found");

    if (!share.creatorId && !isDeleterAdmin)
      throw new ForbiddenException("Anonymous shares can't be deleted");

    await this.fileService.deleteAllFiles(shareId);
    await this.prisma.share.delete({ where: { id: shareId } });
  }

  async isShareCompleted(id: string) {
    return (await this.prisma.share.findUnique({ where: { id } })).uploadLocked;
  }

  async isShareIdAvailable(id: string) {
    const share = await this.prisma.share.findUnique({ where: { id } });
    return { isAvailable: !share };
  }

  async increaseViewCount(share: Share) {
    await this.prisma.share.update({
      where: { id: share.id },
      data: { views: share.views + 1 },
    });
  }

  async getShareToken(shareId: string, password: string) {
    const share = await this.prisma.share.findFirst({
      where: { id: shareId },
      include: {
        security: true,
      },
    });

    if (share?.security?.password) {
      if (!password) {
        throw new ForbiddenException(
          "This share is password protected",
          "share_password_required",
        );
      }

      const isPasswordValid = await argon.verify(
        share.security.password,
        password,
      );
      if (!isPasswordValid) {
        throw new ForbiddenException("Wrong password", "wrong_password");
      }
    }

    if (share.security?.maxViews && share.security.maxViews <= share.views) {
      throw new ForbiddenException(
        "Maximum views exceeded",
        "share_max_views_exceeded",
      );
    }

    const token = await this.generateShareToken(shareId);
    await this.increaseViewCount(share);
    return token;
  }

  async generateShareToken(shareId: string) {
    const { expiration, createdAt } = await this.prisma.share.findUnique({
      where: { id: shareId },
    });

    const tokenPayload = {
      shareId,
      shareCreatedAt: moment(createdAt).unix(),
      iat: moment().unix(),
    };

    const tokenOptions: JwtSignOptions = {
      secret: this.config.get("internal.jwtSecret"),
    };

    if (!moment(expiration).isSame(0)) {
      tokenOptions.expiresIn = moment(expiration).diff(new Date(), "seconds");
    }

    return this.jwtService.sign(tokenPayload, tokenOptions);
  }

  async verifyShareToken(shareId: string, token: string) {
    const { expiration, createdAt } = await this.prisma.share.findUnique({
      where: { id: shareId },
    });

    try {
      const claims = this.jwtService.verify(token, {
        secret: this.config.get("internal.jwtSecret"),
        // Ignore expiration if expiration is 0
        ignoreExpiration: moment(expiration).isSame(0),
      });

      return (
        claims.shareId == shareId &&
        claims.shareCreatedAt == moment(createdAt).unix()
      );
    } catch {
      return false;
    }
  }
}
