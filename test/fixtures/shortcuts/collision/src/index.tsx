import { Action, ActionPanel, Keyboard, List } from "@raycast/api";

// A ⌘⇧C literal next to Common.Copy is the same keys; Common.CopyDeeplink too. ⌘S is Common.Save.
export default function Command({ remote }: { remote: boolean }) {
  return (
    <List>
      <List.Item
        title="Item"
        actions={
          <ActionPanel>
            <Action title="Open" onAction={() => {}} />
            {remote ? (
              <Action title="Copy as PNG" shortcut={{ modifiers: ["cmd", "shift"], key: "p" }} onAction={() => {}} />
            ) : (
              <Action.CopyToClipboard title="Copy as PNG" content="png" shortcut={{ modifiers: ["cmd", "shift"], key: "p" }} />
            )}
            <Action title="Details" shortcut={{ modifiers: ["cmd"], key: "return" }} onAction={() => {}} />
            <Action title="Copy as Markdown" shortcut={Keyboard.Shortcut.Common.Copy} onAction={() => {}} />
            <ActionPanel.Section title="More">
              <Action title="Copy URL" shortcut={{ modifiers: ["cmd", "shift"], key: "c" }} onAction={() => {}} />
              <Action title="Copy Link" shortcut={Keyboard.Shortcut.Common.CopyDeeplink} onAction={() => {}} />
            </ActionPanel.Section>
            <ActionPanel.Submenu title="Export" shortcut={{ modifiers: ["cmd", "shift"], key: "e" }}>
              <Action title="Save as Markdown" shortcut={Keyboard.Shortcut.Common.Save} onAction={() => {}} />
              <Action title="Summarize" shortcut={{ modifiers: ["cmd"], key: "s" }} onAction={() => {}} />
            </ActionPanel.Submenu>
          </ActionPanel>
        }
      />
    </List>
  );
}
