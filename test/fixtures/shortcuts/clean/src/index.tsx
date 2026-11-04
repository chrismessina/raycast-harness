import { Action, ActionPanel, Keyboard, List } from "@raycast/api";
import { ItemActions } from "./actions";

const docs = "https://developers.raycast.com/api-reference/keyboard"; // a URL comment, not a shortcut

export default function Command({ fav }: { fav: Keyboard.Shortcut }) {
  return (
    <List>
      <List.Item
        title="One"
        actions={
          <ActionPanel>
            <Action title="Copy" shortcut={Keyboard.Shortcut.Common.Copy} onAction={() => {}} />
            <Action title="Copy Name" shortcut={Keyboard.Shortcut.Common.CopyName} onAction={() => {}} />
            {/* shortcut={{ modifiers: ["cmd", "shift"], key: "c" }} commented out, must not count */}
            <Action title="Favorite" shortcut={fav} onAction={() => {}} />
            <Action title="Refresh" shortcut={{ modifiers: ["cmd"], key: "r" }} onAction={() => {}} />
          </ActionPanel>
        }
      />
      <List.Item
        title="Two"
        actions={
          <ActionPanel>
            {/* a second panel may reuse the first panel's bindings */}
            <Action title="Copy" shortcut={Keyboard.Shortcut.Common.Copy} onAction={() => {}} />
            <ItemActions />
          </ActionPanel>
        }
      />
    </List>
  );
}
