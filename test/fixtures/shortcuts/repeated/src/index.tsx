import { Action, ActionPanel, Keyboard, List } from "@raycast/api";

// A ternary inside items.map(...) inside the panel runs once per item: both branches can land in
// the same panel, so Common.Copy twice is a real collision. The second panel's ternary is evaluated
// once per panel and its two sides never co-render.
export default function Command({ items }: { items: { a: boolean; name: string }[] }) {
  return (
    <List>
      <List.Item
        title="All"
        actions={
          <ActionPanel>
            {items.map((item) =>
              item.a ? (
                <Action title={"Copy " + item.name} shortcut={Keyboard.Shortcut.Common.Copy} onAction={() => {}} />
              ) : (
                <Action.CopyToClipboard title="Copy Name" content={item.name} shortcut={Keyboard.Shortcut.Common.Copy} />
              ),
            )}
            {Array.from(items, (item) =>
              item.a ? (
                <Action title="Open A" shortcut={Keyboard.Shortcut.Common.Open} onAction={() => {}} />
              ) : (
                <Action title="Open B" shortcut={Keyboard.Shortcut.Common.Open} onAction={() => {}} />
              ),
            )}
          </ActionPanel>
        }
      />
      {items.map((item) => (
        <List.Item
          key={item.name}
          title={item.name}
          actions={
            <ActionPanel>
              {item.a ? (
                <Action title="Copy A" shortcut={Keyboard.Shortcut.Common.Copy} onAction={() => {}} />
              ) : (
                <Action title="Copy B" shortcut={Keyboard.Shortcut.Common.Copy} onAction={() => {}} />
              )}
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
