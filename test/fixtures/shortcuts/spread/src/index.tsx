import { Action, ActionPanel, List } from "@raycast/api";
import { copyProps } from "./props";

// Every shortcut arrives by spread: nothing literal to read, but the panel does declare shortcuts.
export default function Command() {
  return (
    <List>
      <List.Item title="Item" actions={<ActionPanel><Action.CopyToClipboard {...copyProps} /></ActionPanel>} />
    </List>
  );
}
