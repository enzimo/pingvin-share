import {
  Alert,
  ActionIcon,
  Button,
  Group,
  Loader,
  Modal,
  Stack,
  Text,
} from "@mantine/core";
import { AxiosError } from "axios";
import { useEffect, useState } from "react";
import { TbTrash } from "react-icons/tb";
import { FormattedMessage, useIntl } from "react-intl";
import useConfig from "../../../hooks/config.hook";
import useConfirmLeave from "../../../hooks/confirm-leave.hook";
import useTranslate from "../../../hooks/useTranslate.hook";
import shareService, {
  FileAdditionContext,
} from "../../../services/share.service";
import { FileMetaData, FileUpload } from "../../../types/File.type";
import { byteToHumanSizeString } from "../../../utils/fileSize.util";
import toast from "../../../utils/toast.util";
import Dropzone from "../../upload/Dropzone";
import FileList from "../../upload/FileList";

type PendingFile = FileUpload & { uploadId: string; nextChunk: number };

// getRandomValues also works on installations served over plain HTTP.
const newFileId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const ManageShareFilesModal = ({
  shareId,
  onClose,
  onSaved,
}: {
  shareId: string;
  onClose: () => void;
  onSaved: () => void;
}) => {
  const intl = useIntl();
  const t = useTranslate();
  const config = useConfig();
  const [context, setContext] = useState<FileAdditionContext>();
  const [error, setError] = useState<string>();
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [fileToDelete, setFileToDelete] = useState<FileMetaData>();
  const [isDeleting, setIsDeleting] = useState(false);
  const isBusy = isUploading || isDeleting;
  const label = intl.formatMessage({
    id: "admin.shares.add-files",
    defaultMessage: "Add files",
  });
  useConfirmLeave({
    message: t("upload.notify.confirm-leave"),
    enabled: isBusy,
  });

  useEffect(() => {
    shareService
      .getFileAdditionContext(shareId)
      .then(setContext)
      .catch((error) => {
        setError(error.response?.data?.message || t("common.error.unknown"));
      });
  }, [shareId]);

  const removeFile = async () => {
    if (!fileToDelete || isBusy) return;
    setIsDeleting(true);
    try {
      setContext(await shareService.removeAdminFile(shareId, fileToDelete.id));
      setFileToDelete(undefined);
      toast.success(t("share.edit.notify.save-success"));
      onSaved();
    } catch (error) {
      toast.axiosError(error);
      // Another administrator may already have changed the file list.
      try {
        const refreshed = await shareService.getFileAdditionContext(shareId);
        setContext(refreshed);
        setFileToDelete(undefined);
        onSaved();
      } catch {
        setError(t("common.error.unknown"));
      }
    } finally {
      setIsDeleting(false);
    }
  };

  const selectFiles = (selected: FileUpload[]) => {
    const names = new Set([
      ...(context?.fileNames || []),
      ...files.map((file) => file.name),
    ]);
    for (const file of selected) {
      if (names.has(file.name)) {
        toast.error(
          intl.formatMessage(
            {
              id: "admin.shares.add-files.duplicate",
              defaultMessage:
                "A file named {name} already exists or is selected.",
            },
            { name: file.name },
          ),
        );
        return;
      }
      names.add(file.name);
    }
    setFiles([
      ...files,
      ...selected.map((file) =>
        Object.assign(file, {
          uploadId: newFileId(),
          nextChunk: 0,
        }),
      ),
    ]);
  };

  const upload = async () => {
    setIsUploading(true);
    setError(undefined);
    try {
      const chunkSize = Number(config.get("share.chunkSize"));
      for (const file of files) {
        const chunks = Math.max(1, Math.ceil(file.size / chunkSize));
        for (let index = file.nextChunk; index < chunks; index++) {
          file.uploadingProgress = Math.max(1, (index / chunks) * 100);
          setFiles([...files]);
          try {
            await shareService.appendFile(
              shareId,
              file.slice(index * chunkSize, (index + 1) * chunkSize),
              { id: file.uploadId, name: file.name },
              index,
              chunks,
            );
          } catch (error) {
            if (
              error instanceof AxiosError &&
              error.response?.data.error === "unexpected_chunk_index"
            ) {
              const expected = error.response.data.expectedChunkIndex;
              if (
                Number.isInteger(expected) &&
                expected !== index &&
                expected >= 0 &&
                expected < chunks
              ) {
                index = expected - 1;
                continue;
              }
            }
            throw error;
          }
          file.nextChunk = index + 1;
          file.uploadingProgress = ((index + 1) / chunks) * 100;
          setFiles([...files]);
        }
      }
      toast.success(t("share.edit.notify.save-success"));
      onSaved();
      onClose();
    } catch (error) {
      toast.axiosError(error);
      try {
        const refreshed = await shareService.getFileAdditionContext(shareId);
        setContext(refreshed);
        setFiles(
          files
            .filter((file) => !refreshed.fileNames.includes(file.name))
            .map((file) => {
              file.uploadingProgress = 0;
              return file;
            }),
        );
        onSaved();
      } catch {
        setError(t("common.error.unknown"));
      }
    } finally {
      setIsUploading(false);
    }
  };

  const remaining = Math.max(0, (context?.maxSize || 0) - (context?.size || 0));
  const selectedSize = files.reduce((size, file) => size + file.size, 0);
  return (
    <Modal
      opened
      onClose={() => {
        if (!isBusy) onClose();
      }}
      title={intl.formatMessage(
        {
          id: "admin.shares.manage-files.title",
          defaultMessage: "Manage files in {id}",
        },
        { id: shareId },
      )}
      size="lg"
      closeOnClickOutside={!isBusy}
      closeOnEscape={!isBusy}
      withCloseButton={!isBusy}
    >
      <Stack>
        <Text size="sm" color="dimmed">
          <FormattedMessage
            id="admin.shares.manage-files.description"
            defaultMessage="Add or delete files here. Changes take effect immediately. The share link and access settings stay the same."
          />
        </Text>
        {error && <Alert color="red">{error}</Alert>}
        {!context && !error && <Loader />}
        {context && (
          <>
            <Stack spacing="xs">
              {context.files.map((file) => (
                <Group key={file.id} position="apart" noWrap>
                  <Text size="sm" sx={{ overflowWrap: "anywhere" }}>
                    {file.name}
                    <Text component="span" color="dimmed" ml="xs">
                      {byteToHumanSizeString(Number(file.size))}
                    </Text>
                  </Text>
                  <ActionIcon
                    color="red"
                    variant="light"
                    disabled={isBusy || context.files.length <= 1}
                    aria-label={intl.formatMessage(
                      {
                        id: "admin.shares.manage-files.delete-file",
                        defaultMessage: "Delete {name}",
                      },
                      { name: file.name },
                    )}
                    onClick={() => setFileToDelete(file)}
                  >
                    <TbTrash />
                  </ActionIcon>
                </Group>
              ))}
            </Stack>
            {context.files.length <= 1 && (
              <Text size="xs" color="dimmed">
                <FormattedMessage
                  id="admin.shares.manage-files.last-file"
                  defaultMessage="A share must contain at least one file. Add a replacement first or delete the share."
                />
              </Text>
            )}
            {fileToDelete && (
              <Alert color="red">
                <Text size="sm">
                  <FormattedMessage
                    id="admin.shares.manage-files.confirm-delete"
                    defaultMessage="Permanently delete {name} from this share?"
                    values={{ name: fileToDelete.name }}
                  />
                </Text>
                <Group position="right" mt="sm">
                  <Button
                    variant="default"
                    disabled={isBusy}
                    onClick={() => setFileToDelete(undefined)}
                  >
                    <FormattedMessage id="common.button.cancel" />
                  </Button>
                  <Button color="red" loading={isDeleting} onClick={removeFile}>
                    <FormattedMessage id="common.button.delete" />
                  </Button>
                </Group>
              </Alert>
            )}
            <Text size="sm">
              <FormattedMessage
                id="admin.shares.add-files.current-size"
                defaultMessage="Current share size: {size}"
                values={{ size: byteToHumanSizeString(context.size) }}
              />
            </Text>
            <Dropzone
              title={label}
              chooseFilesLabel={intl.formatMessage({
                id: "admin.shares.add-files.choose-files",
                defaultMessage: "Choose files",
              })}
              description={intl.formatMessage(
                {
                  id: "admin.shares.add-files.dropzone-description",
                  defaultMessage:
                    "Drop files here or choose files. Up to {size} available.",
                },
                {
                  size: byteToHumanSizeString(
                    Math.max(0, remaining - selectedSize),
                  ),
                },
              )}
              isUploading={isBusy}
              maxShareSize={Math.max(0, remaining - selectedSize)}
              onFilesChanged={selectFiles}
            />
            {files.length > 0 && (
              <FileList
                files={files}
                setFiles={(next) => {
                  if (!isBusy) setFiles(next);
                }}
              />
            )}
          </>
        )}
        <Group position="right">
          <Button variant="default" disabled={isBusy} onClick={onClose}>
            <FormattedMessage id="common.button.cancel" />
          </Button>
          <Button
            loading={isUploading}
            disabled={
              !context ||
              !files.length ||
              selectedSize > remaining ||
              !!error ||
              !!fileToDelete ||
              isDeleting
            }
            onClick={upload}
          >
            {label}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
};

export default ManageShareFilesModal;
