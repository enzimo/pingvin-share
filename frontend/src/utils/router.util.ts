export function safeRedirectPath(path: unknown): string {
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    /[\\\u0000-\u0020\u007f]/.test(path)
  )
    return "/";
  try {
    const url = new URL(path, "https://redirect.invalid");
    return url.origin === "https://redirect.invalid"
      ? `${url.pathname}${url.search}${url.hash}`
      : "/";
  } catch {
    return "/";
  }
}
