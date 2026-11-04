import { Action, ActionPanel, Keyboard, List } from "@raycast/api";

// Collision-free on macOS, colliding on Windows: Common.Remove is ⌃X / ctrl+D, and the literal
// names ctrl+D for Windows only. The ⌘⇧D / ctrl+shift+D sidebar toggle collides with nothing.
export default function Command() {
  return (
    <List>
      <List.Item
        title="Item"
        actions={
          <ActionPanel>
            <Action title="Remove" shortcut={Keyboard.Shortcut.Common.Remove} onAction={() => {}} />
            <Action
              title="Delete Draft"
              shortcut={{ macOS: { modifiers: ["cmd", "opt"], key: "d" }, Windows: { modifiers: ["ctrl"], key: "d" } }}
              onAction={() => {}}
            />
            <Action
              title="Hide Sidebar"
              shortcut={{ macOS: { modifiers: ["cmd", "shift"], key: "d" }, Windows: { modifiers: ["ctrl", "shift"], key: "d" } }}
              onAction={() => {}}
            />
          </ActionPanel>
        }
      />
    </List>
  );
}
