import { Clipboard, showToast, Toast, showInFinder } from "@raycast/api";

export default async function Command() {
  const path = "/tmp/export.md";
  await showToast({
    style: Toast.Style.Success,
    title: "Export Complete",
    primaryAction: { title: "Show in Finder", shortcut: { modifiers: ["cmd"], key: "o" }, onAction: () => showInFinder(path) },
    secondaryAction: { title: "Copy Path", shortcut: { modifiers: ["cmd"], key: "o" }, onAction: () => Clipboard.copy(path) },
  });
  await showToast({
    style: Toast.Style.Failure,
    title: "Export Failed",
    primaryAction: { title: "Copy Error", shortcut: { modifiers: [], key: "return" }, onAction: () => Clipboard.copy("x") },
  });
}
