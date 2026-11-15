import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { RuleTester } from "eslint";
import plugin from "../eslint-plugin/index.mjs";
import { REPO } from "./helpers.mjs";

// RuleTester drives node:test directly; cases are JSX (espree parses JSX, not TSX, so no types here).
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const TABLE = join(REPO, "test", "fixtures", "shortcuts", "table-2.10.1.0.json");
const CWD_BOTH = join(REPO, "test", "fixtures", "shortcuts", "cross-platform"); // package.json declares macOS and Windows
const CWD_MAC = join(REPO, "test", "fixtures", "shortcuts", "clean"); // no platforms field

const tester = new RuleTester({
  languageOptions: { ecmaVersion: 2024, sourceType: "module", parserOptions: { ecmaFeatures: { jsx: true } } },
});

test("the package exports the plugin at @chrismessina/raycast-harness/eslint-plugin with four rules and a recommended config", async () => {
  const mod = await import("@chrismessina/raycast-harness/eslint-plugin");
  assert.equal(mod.default, plugin);
  assert.deepEqual(Object.keys(plugin.rules).sort(), ["copy-error-pairing", "no-ambiguous-shortcut", "no-multiline-emptyview-description", "no-toast-hide-in-cleanup"]);
  assert.equal(plugin.meta.name, "eslint-plugin-raycast-harness");
  assert.deepEqual(Object.keys(plugin.configs.recommended.rules ?? {}).sort(), Object.keys(plugin.rules).map((r) => `raycast-harness/${r}`).sort());
  assert.ok(Object.values(plugin.configs.recommended.rules ?? {}).every((v) => v === "error"));
  assert.equal(plugin.configs.recommended.plugins?.["raycast-harness"], plugin);
});

tester.run("no-multiline-emptyview-description", plugin.rules["no-multiline-emptyview-description"], {
  valid: [
    '<List.EmptyView title="Nothing" description="One short line." />',
    '<Grid.EmptyView description={"Still one line"} />',
    "<List.EmptyView description={`one line ${x}`} />",
    '<Detail markdown="a\\nb" />',
    '<Other description="a\\nb" />',
  ],
  invalid: [
    { code: '<List.EmptyView description="Step 1\\nStep 2" />', errors: [{ messageId: "multiline" }] },
    { code: '<EmptyView description={"a\\nb"} />', errors: [{ messageId: "multiline" }] },
    { code: "<Grid.EmptyView description={`a\nb`} />", errors: [{ messageId: "multiline" }] },
    { code: '<ErrorEmptyView description="a\\nb" />', options: [{ additionalComponents: ["ErrorEmptyView"] }], errors: [{ messageId: "multiline" }] },
  ],
});

tester.run("no-ambiguous-shortcut", plugin.rules["no-ambiguous-shortcut"], {
  valid: [
    // macOS-only extension (no platforms field): a bare cmd is fine
    { code: '<Action shortcut={{ modifiers: ["cmd"], key: "l" }} />', ...cwd(CWD_MAC) },
    // cross-platform, but opt/shift only: unambiguous
    { code: '<Action shortcut={{ modifiers: ["opt", "shift"], key: "l" }} />', ...cwd(CWD_BOTH) },
    // cross-platform with both platforms named
    { code: '<Action shortcut={{ macOS: { modifiers: ["cmd"], key: "l" }, Windows: { modifiers: ["ctrl"], key: "l" } }} />', ...cwd(CWD_BOTH) },
    // Common constants are platform-aware
    { code: "<Action shortcut={Keyboard.Shortcut.Common.Copy} />", ...cwd(CWD_BOTH) },
    // a non-literal shortcut cannot be read
    { code: "<Action shortcut={props.shortcut} />", ...cwd(CWD_BOTH) },
    // the `platforms` option overrides package.json
    { code: '<Action shortcut={{ modifiers: ["cmd"], key: "l" }} />', options: [{ platforms: ["macOS"] }], ...cwd(CWD_BOTH) },
    // an object that is not a shortcut
    { code: 'showToast({ primaryAction: { title: "Open", onAction: () => {} } })', ...cwd(CWD_BOTH) },
  ],
  invalid: [
    {
      code: '<Action shortcut={{ modifiers: ["cmd"], key: "l" }} />',
      ...cwd(CWD_BOTH),
      errors: [{ messageId: "ambiguous", data: { modifiers: "`cmd`" } }],
    },
    {
      code: '<Action shortcut={{ modifiers: ["ctrl", "shift"], key: "c" }} />',
      ...cwd(CWD_BOTH),
      errors: [{ messageId: "ambiguous", data: { modifiers: "`ctrl`" } }],
    },
    // the toast primaryAction case: an object-literal shortcut outside JSX
    {
      code: 'await showToast({ style: Toast.Style.Success, title: "Done", primaryAction: { title: "Show in Finder", shortcut: { modifiers: ["cmd"], key: "o" }, onAction: () => {} } })',
      ...cwd(CWD_BOTH),
      errors: [{ messageId: "ambiguous" }],
    },
    // with a runtime table, the message names the constant the literal spells out
    {
      code: '<Action shortcut={{ modifiers: ["ctrl", "shift"], key: "c" }} />',
      options: [{ table: TABLE }],
      ...cwd(CWD_BOTH),
      errors: [{ messageId: "ambiguousMatchesCommon", data: { modifiers: "`ctrl`", match: "Keyboard.Shortcut.Common.Copy's Windows binding and Keyboard.Shortcut.Common.CopyDeeplink's Windows binding" } }],
    },
    // the `platforms` option turns the rule on for a package.json without the field
    {
      code: '<Action shortcut={{ modifiers: ["cmd"], key: "l" }} />',
      options: [{ platforms: ["macOS", "Windows"] }],
      ...cwd(CWD_MAC),
      errors: [{ messageId: "ambiguous" }],
    },
    // deprecated lowercase platform key, reported on any extension
    {
      code: '<Action shortcut={{ macOS: { modifiers: ["cmd"], key: "l" }, windows: { modifiers: ["ctrl"], key: "l" } }} />',
      ...cwd(CWD_MAC),
      errors: [{ messageId: "lowercaseWindows" }],
    },
  ],
});

tester.run("copy-error-pairing", plugin.rules["copy-error-pairing"], {
  valid: [
    'await showToast({ style: Toast.Style.Failure, title: "Failed", message, primaryAction: { title: "Copy Error", onAction: () => Clipboard.copy(message) } })',
    'await showToast({ style: Toast.Style.Success, title: "Done" })',
    'await showToast({ style: Toast.Style.Animated, title: "Working" })',
    'await showFailureToast(error, { title: "Failed", primaryAction: { title: "Copy Error", onAction: () => Clipboard.copy(String(error)) } })',
    // helper forms: kit helpers attach Copy Error themselves
    'await showError("Failed", error)',
    "failToast(toast, 'Could not save', error)",
    // a configured local helper
    { code: "showFailureToast(error)", options: [{ helpers: ["showFailureToast"] }] },
    // in-place mutation paired in the same block
    'toast.style = Toast.Style.Failure; toast.title = "Failed"; toast.primaryAction = { title: "Copy Error", onAction: () => Clipboard.copy(msg) };',
    // not literal: the rule reports only what it can read
    "await showToast({ style: Toast.Style.Failure, title, primaryAction })",
    "await showToast({ style: Toast.Style.Failure, title, ...rest })",
    "await showToast(buildFailure(error))",
    "await showFailureToast(error, options)",
    'await showToast({ style: Toast.Style.Failure, title, primaryAction: { title: copyErrorTitle, onAction } })',
    // a spread AFTER the explicit properties may override them: defer
    'await showToast({ style: Toast.Style.Failure, title: "F", primaryAction: { title: "Retry", onAction }, ...overrides })',
    'await showToast({ primaryAction: { title: "Retry", onAction }, ...rest, style: Toast.Style.Failure, ...more })',
    // a spread before an explicit style that is not Failure
    'await showToast({ ...base, style: Toast.Style.Success })',
    // string-literal keys are the same properties
    'await showToast({ "style": Toast.Style.Failure, "title": "F", "primaryAction": { "title": "Copy Error", onAction } })',
  ],
  invalid: [
    { code: 'await showToast({ style: Toast.Style.Failure, title: "Failed", message })', errors: [{ messageId: "missing" }] },
    { code: 'await showToast({ style: Toast.Style.Failure, title: "Failed", primaryAction: { title: "Retry", onAction } })', errors: [{ messageId: "missing" }] },
    { code: 'await showToast({ style: Toast.Style.Failure, title: "Failed", secondaryAction: { title: "Copy Error", onAction } })', errors: [{ messageId: "missing" }] },
    { code: 'const t = new Toast({ style: Toast.Style.Failure, title: "Failed" })', errors: [{ messageId: "missing" }] },
    { code: 'await showFailureToast(error, { title: "Failed" })', errors: [{ messageId: "missingOptions" }] },
    { code: "await showFailureToast(error)", errors: [{ messageId: "missingOptions" }] },
    { code: 'toast.style = Toast.Style.Failure; toast.title = "Failed";', errors: [{ messageId: "missingAssignment", data: { object: "toast", title: "Copy Error" } }] },
    { code: 'toast.style = Toast.Style.Failure; toast.primaryAction = { title: "Retry", onAction };', errors: [{ messageId: "missingAssignment" }] },
    // one compliant toast does not excuse the next one
    {
      code: 'await showToast({ style: Toast.Style.Failure, title: "A", primaryAction: { title: "Copy Error", onAction } }); await showToast({ style: Toast.Style.Failure, title: "B" })',
      errors: [{ messageId: "missing" }],
    },
    { code: 'await showToast({ style: Toast.Style.Failure, title: "F" })', options: [{ title: "Copy Details" }], errors: [{ messageId: "missing", data: { title: "Copy Details" } }] },
    // property order: an explicit property after the spread is known, and wrong
    { code: 'await showToast({ ...opts, style: Toast.Style.Failure, primaryAction: { title: "Retry", onAction } })', errors: [{ messageId: "missing" }] },
    { code: 'await showToast({ ...opts, style: Toast.Style.Failure, primaryAction: { ...act, title: "Retry" } })', errors: [{ messageId: "missing" }] },
    { code: 'await showFailureToast(error, { ...opts, primaryAction: { title: "Retry", onAction } })', errors: [{ messageId: "missingOptions" }] },
    // a string-literal style key does not escape inspection
    { code: 'await showToast({ "style": Toast.Style.Failure, title: "F" })', errors: [{ messageId: "missing" }] },
    { code: 'await showToast({ style: Toast.Style.Failure, title: "F", primaryAction: { "title": "Retry", onAction } })', errors: [{ messageId: "missing" }] },
  ],
});

tester.run("no-toast-hide-in-cleanup", plugin.rules["no-toast-hide-in-cleanup"], {
  valid: [
    // hide inside the promise, guarded
    "usePromise(async () => { const t = await showToast({ title: 'w' }); try { await work(); t.hide().catch(() => {}); } finally {} }, [])",
    // an effect with a cleanup that does not hide
    "useEffect(() => { const id = setInterval(tick, 1000); return () => clearInterval(id); }, [])",
    // hide in the effect body itself, not the cleanup
    "useEffect(() => { if (!isLoading) toast?.hide(); }, [isLoading])",
    // a returned function that is not an effect cleanup
    "function make() { return () => toast.hide(); }",
    "const f = () => () => toast.hide();",
    // a non-effect hook
    "useCallback(() => { return () => toast.hide(); }, [])",
    // a bound function that is not the one returned
    "useEffect(() => { const hideIt = () => toast.hide(); const cleanup = () => clearInterval(id); hideIt(); return cleanup; }, [])",
    // bound in a nested function, not the effect body
    "useEffect(() => { function inner() { const c = () => toast.hide(); return c; } inner(); }, [])",
    // same spelling, different binding: the block-local cleanup hides and is called now; the outer cleanup is returned
    "useEffect(() => { { const cleanup = () => toast.hide(); cleanup(); } const cleanup = () => clearInterval(id); return cleanup; }, [])",
    "useEffect(() => { const cleanup = () => clearInterval(id); if (x) { const cleanup = () => toast.hide(); cleanup(); } return cleanup; }, [])",
  ],
  invalid: [
    { code: "useEffect(() => { return () => { toast.hide(); }; }, [isLoading])", errors: [{ messageId: "hideInCleanup", data: { text: "toast.hide()" } }] },
    { code: "useEffect(() => () => toast.hide(), [])", errors: [{ messageId: "hideInCleanup" }] },
    { code: "useEffect(() => { return () => { if (toastRef.current) toastRef.current.hide(); }; }, [])", errors: [{ messageId: "hideInCleanup" }] },
    { code: "React.useEffect(function () { return function cleanup() { void progress.hide(); }; }, [])", errors: [{ messageId: "hideInCleanup" }] },
    { code: "useLayoutEffect(() => { show(); return () => toast?.hide().catch(() => {}); }, [])", errors: [{ messageId: "hideInCleanup" }] },
    // a cleanup bound by name in the effect body and returned
    { code: "useEffect(() => { const cleanup = () => toast.hide(); return cleanup; }, [])", errors: [{ messageId: "hideInCleanup" }] },
    { code: "useEffect(() => { function cleanup() { toast.hide(); } if (x) { return cleanup; } }, [])", errors: [{ messageId: "hideInCleanup" }] },
    { code: "useEffect(() => { let done = function () { void t.hide(); }; return done; }, [])", errors: [{ messageId: "hideInCleanup" }] },
    // the returned identifier is this binding even though a shadowing one exists in an inner block
    { code: "useEffect(() => { const cleanup = () => toast.hide(); if (x) { const cleanup = () => 0; cleanup(); } return cleanup; }, [])", errors: [{ messageId: "hideInCleanup" }] },
  ],
});

/** RuleTester case fragment placing the linted file under an extension root (whose package.json `platforms` the rule reads). @param {string} dir */
function cwd(dir) {
  return { filename: join(dir, "src", "index.jsx") };
}
