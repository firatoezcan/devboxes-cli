/** A CLI device code as the API stores it: no spaces or dashes, upper case. */
export const normalizeDeviceCode = (typed: string) => typed.replace(/[\s-]/g, "").toUpperCase();

/**
 * A CLI device code split in two halves for reading aloud, e.g. WDJB-MJHT. The terminal and the
 * device approval page both show it this way, so a person compares the same text.
 */
export const displayDeviceCode = (code: string) =>
  code.length > 4
    ? `${code.slice(0, Math.ceil(code.length / 2))}-${code.slice(Math.ceil(code.length / 2))}`
    : code;
