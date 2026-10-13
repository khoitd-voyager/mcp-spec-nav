/**
 * Where a function's name written as a string or symbol is a call.
 *
 * A name in a string is usually not one: `describe('onConfigUpdate', …)`,
 * `@Controller('search')`, `Search = 'search'`. Listing every such string as
 * a possible dynamic call buries the few that are. So a string counts as a
 * dynamic call only where the language's dynamic-dispatch APIs take one —
 * `obj["name"]()`, `getattr(obj, "name")`, `send(:name)`,
 * `call_user_func('name')`, `getMethod("name")`, `NSSelectorFromString("name")`,
 * `reflect.Value.MethodByName("Name")` — and every other exact-string mention
 * is only counted, with a few samples.
 */
export const DYNAMIC_FUNCTIONS = new Set([
  // Python
  "getattr", "hasattr", "setattr", "delattr", "methodcaller", "attrgetter", "__getattribute__", "__getattr__",
  // Ruby
  "send", "public_send", "__send__", "method", "public_method", "instance_method", "respond_to?", "try",
  // PHP
  "call_user_func", "call_user_func_array", "method_exists", "is_callable", "forward_static_call",
  // JVM, C#
  "getMethod", "getDeclaredMethod", "invokeMethod", "GetMethod", "InvokeMember", "callMethod", "findVirtual", "findStatic",
  // Go
  "MethodByName", "FieldByName",
  // Elixir, Erlang
  "apply", "function_exported?",
  // Swift / Objective-C
  "NSSelectorFromString", "Selector", "perform", "responds",
  // JS libraries
  "invoke", "invokeMap", "result", "bindKey",
]);

/** `Reflect.get(o, "x")`, `_.invoke(o, "x")`: the last segment of a callee text. */
export function isDynamicCallee(calleeText: string): boolean {
  const last = calleeText.replace(/\s+/g, "").split(/\.|::|->/).pop() ?? "";
  if (/^Reflect\.(get|apply|has)$/.test(calleeText.replace(/\s+/g, ""))) return true;
  return DYNAMIC_FUNCTIONS.has(last.replace(/^[$@]/, ""));
}

export interface NameAsString {
  count: number;
  samples: string[];
}
