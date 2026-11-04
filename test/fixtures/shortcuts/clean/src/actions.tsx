import { Action, Keyboard } from "@raycast/api";

// Rendered inside another file's panel: a loose group, never paired (documented scan limit).
export function ItemActions() {
  return <Action title="Copy Again" shortcut={Keyboard.Shortcut.Common.Copy} onAction={() => {}} />;
}
