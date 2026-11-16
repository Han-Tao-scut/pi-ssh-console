export type AnsiStyle = "bold" | "dim" | "red" | "green" | "yellow" | "cyan";

const CODES: Record<AnsiStyle, number> = {
  bold: 1,
  dim: 2,
  red: 31,
  green: 32,
  yellow: 33,
  cyan: 36,
};

const ESC = "\u001b[";

export function styled(text: string, ...styles: AnsiStyle[]): string {
  if (!text || styles.length === 0) return text;
  return `${styles.map((style) => `${ESC}${CODES[style]}m`).join("")}${text}\u001b[0m`;
}

export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}