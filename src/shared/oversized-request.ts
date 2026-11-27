// Parsing for provider "request too large" rejections that report a
// per-minute token limit (Groq TPM/ITPM/OTPM wording). Shared by the server
// advice path and the Pi provider's learned-quota preflight.

export const oversizedRequestPattern =
  /\brequest too large\b.{0,250}?\btokens per minute\s*\((?:I|O)?TPM\):\s*Limit\s+(\d{1,9}),\s*Requested\s+(\d{1,9})/is;

export function oversizedRequestLimit(
  text: string,
): { limit: number; requested: number } | undefined {
  const match = text.match(oversizedRequestPattern);
  if (!match) return undefined;
  const limit = Number(match[1]);
  const requested = Number(match[2]);
  if (!(limit > 0) || !(requested > limit)) return undefined;
  return { limit, requested };
}
