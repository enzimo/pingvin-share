import { getCookie } from "cookies-next";
import { createIntl, createIntlCache, useIntl } from "react-intl";
import i18nUtil from "../utils/i18n.util";

const useTranslate = () => {
  const intl = useIntl();
  return (
    id: string,
    values?: Record<
      string,
      string | number | boolean | Date | null | undefined
    >,
    opts?: Parameters<typeof intl.formatMessage>[2],
  ) => {
    return intl.formatMessage({ id }, values, opts);
  };
};

const cache = createIntlCache();

export const translateOutsideContext = () => {
  const locale =
    getCookie("language")?.toString() ?? navigator.language.split("-")[0];

  const intl = createIntl(
    {
      locale,
      messages: i18nUtil.getLocaleByCode(locale)?.messages,
      defaultLocale: "en",
    },
    cache,
  );
  return (
    id: string,
    values?: Record<
      string,
      string | number | boolean | Date | null | undefined
    >,
    opts?: Parameters<typeof intl.formatMessage>[2],
  ) => {
    return intl.formatMessage({ id }, values, opts);
  };
};

export default useTranslate;
