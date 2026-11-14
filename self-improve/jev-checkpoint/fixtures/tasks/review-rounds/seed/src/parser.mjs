export function parseItems(text) {
  if (typeof text !== "string") throw new TypeError("text must be a string");
  const items = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (items.length === 0) return undefined;
  return items;
}
