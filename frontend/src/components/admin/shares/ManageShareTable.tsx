import {
  ActionIcon,
  Box,
  Group,
  MediaQuery,
  Skeleton,
  Table,
  Text,
  Tooltip,
} from "@mantine/core";
import { useClipboard } from "@mantine/hooks";
import { useModals } from "@mantine/modals";
import moment from "moment";
import { TbFiles, TbLink, TbTrash } from "react-icons/tb";
import { FormattedMessage, useIntl } from "react-intl";
import useConfig from "../../../hooks/config.hook";
import useTranslate from "../../../hooks/useTranslate.hook";
import { MyShare } from "../../../types/share.type";
import { byteToHumanSizeString } from "../../../utils/fileSize.util";
import toast from "../../../utils/toast.util";
import showShareLinkModal from "../../account/showShareLinkModal";

const ManageShareTable = ({
  shares,
  deleteShare,
  isLoading,
  manageFiles,
}: {
  shares: MyShare[];
  deleteShare: (share: MyShare) => void;
  isLoading: boolean;
  manageFiles: (share: MyShare) => void;
}) => {
  const modals = useModals();
  const clipboard = useClipboard();
  const config = useConfig();
  const t = useTranslate();
  const intl = useIntl();
  const manageFilesLabel = intl.formatMessage({
    id: "admin.shares.manage-files",
    defaultMessage: "Manage files",
  });

  return (
    <Box sx={{ display: "block", overflowX: "auto" }}>
      <Table verticalSpacing="sm">
        <thead>
          <tr>
            <th>
              <FormattedMessage id="account.shares.table.id" />
            </th>
            <th>
              <FormattedMessage id="account.shares.table.name" />
            </th>
            <th>
              <FormattedMessage id="admin.shares.table.username" />
            </th>
            <th>
              <FormattedMessage id="account.shares.table.visitors" />
            </th>
            <th>
              <FormattedMessage id="account.shares.table.size" />
            </th>
            <th>
              <FormattedMessage id="account.shares.table.expiresAt" />
            </th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {isLoading
            ? skeletonRows
            : shares.map((share) => (
                <tr key={share.id}>
                  <td>{share.id}</td>
                  <td>{share.name}</td>
                  <td>
                    {share.creator ? (
                      share.creator.username
                    ) : (
                      <Text color="dimmed">Anonymous</Text>
                    )}
                  </td>
                  <td>{share.views}</td>
                  <td>{byteToHumanSizeString(share.size)}</td>
                  <td>
                    {moment(share.expiration).unix() === 0
                      ? "Never"
                      : moment(share.expiration).format("LLL")}
                  </td>
                  <td>
                    <Group position="right">
                      <Tooltip label={manageFilesLabel}>
                        <ActionIcon
                          color="orange"
                          variant="light"
                          size={25}
                          aria-label={manageFilesLabel}
                          onClick={() => manageFiles(share)}
                        >
                          <TbFiles />
                        </ActionIcon>
                      </Tooltip>
                      <ActionIcon
                        color="victoria"
                        variant="light"
                        size={25}
                        onClick={() => {
                          if (window.isSecureContext) {
                            clipboard.copy(
                              `${window.location.origin}/s/${share.id}`,
                            );
                            toast.success(t("common.notify.copied-link"));
                          } else {
                            showShareLinkModal(modals, share.id);
                          }
                        }}
                      >
                        <TbLink />
                      </ActionIcon>
                      <ActionIcon
                        variant="light"
                        color="red"
                        size="sm"
                        onClick={() => deleteShare(share)}
                      >
                        <TbTrash />
                      </ActionIcon>
                    </Group>
                  </td>
                </tr>
              ))}
        </tbody>
      </Table>
    </Box>
  );
};

const skeletonRows = [...Array(10)].map((v, i) => (
  <tr key={i}>
    <td>
      <Skeleton key={i} height={20} />
    </td>
    <MediaQuery smallerThan="md" styles={{ display: "none" }}>
      <td>
        <Skeleton key={i} height={20} />
      </td>
    </MediaQuery>
    <td>
      <Skeleton key={i} height={20} />
    </td>
    <td>
      <Skeleton key={i} height={20} />
    </td>
    <td>
      <Skeleton key={i} height={20} />
    </td>
    <td>
      <Skeleton key={i} height={20} />
    </td>
  </tr>
));

export default ManageShareTable;
