import Type from "typebox";
import Value from "typebox/value";

import type { JsonValue } from "../protocol/json";

export const redactedSecret = "[redacted]";

const eitherCase = (hex: string) =>
  hex.replace(/[a-f]/gi, (letter) => `[${letter.toLowerCase()}${letter.toUpperCase()}]`);

/**
 * Matches `secret` as is, and with any of its characters escaped the way JSON printers, URL
 * encoders and form encoding write them: `\"`, `%2F` or `%2f` for any character an encoder may
 * escape, and `+` for a space.
 */
const textPattern = (secret: string) =>
  Array.from(new Intl.Segmenter().segment(secret), ({ segment }) => {
    const forms = new Set([
      RegExp.escape(segment),
      RegExp.escape(JSON.stringify(segment).slice(1, -1)),
      ...(/^[\w.-]$/.test(segment)
        ? []
        : [eitherCase(Buffer.from(segment).toString("hex").replace(/../g, "%$&"))]),
      ...(segment === " " ? ["\\+"] : []),
    ]);
    return forms.size > 1 ? `(?:${[...forms].join("|")})` : RegExp.escape(segment);
  }).join("");

/**
 * Matches the base64, base64url and hex encodings of `secret`, with any whitespace between their
 * characters, because `base64`, `openssl base64` and `xxd -p` wrap their lines. Inside longer
 * base64 a secret can start at any of three byte offsets, and the characters at either end of its
 * encoding also carry the neighbouring bytes, so each offset contributes only the characters that
 * the secret alone determines. Hex matches in either case. Encodings of a secret shorter than 8
 * characters would match ordinary text.
 */
const encodedPatterns = (secret: string) => {
  if (secret.length < 8) return [];
  const bytes = Buffer.from(secret);
  const base64 = [0, 1, 2].flatMap((offset) => {
    const core = Buffer.concat([Buffer.alloc(offset), bytes])
      .toString("base64")
      .slice(Math.ceil((offset * 8) / 6), Math.floor(((offset + bytes.length) * 8) / 6));
    return [core, core.replaceAll("+", "-").replaceAll("/", "_")];
  });
  return [
    ...base64.map((encoded) => encoded.split("").map((character) => RegExp.escape(character))),
    bytes.toString("hex").split("").map(eitherCase),
  ].map((characters) => characters.join("\\s*"));
};

/**
 * One pattern for every form of every secret. Longer secrets come first, so a secret that extends
 * another never leaves its suffix readable. An empty value is no secret, and matching it would
 * mark every position in the text, so without secrets the pattern matches nothing.
 */
const secretsPattern = (secretValues: readonly string[]) =>
  new RegExp(
    [...new Set(secretValues)]
      .filter((secret) => secret !== "")
      .sort((left, right) => right.length - left.length)
      .flatMap((secret) => [...encodedPatterns(secret), textPattern(secret)])
      .join("|") || "(?!)",
    "g",
  );

/** Redacts every form of each of `secretValues`, then every match of `tokenPatterns`. */
export const redactSecretText = (
  value: string,
  secretValues: readonly string[],
  tokenPatterns: readonly { pattern: RegExp }[] = [],
) =>
  redactPatternMatches(value.replace(secretsPattern(secretValues), redactedSecret), tokenPatterns);

/** A `JSON.parse` reviver that redacts every string value as `redactSecretText` does. */
export const secretRedactingReviver = (
  secretValues: readonly string[],
  tokenPatterns: readonly { pattern: RegExp }[] = [],
) => {
  const pattern = secretsPattern(secretValues);
  return (_key: string, value: JsonValue) =>
    Value.Check(Type.String(), value)
      ? redactPatternMatches(value.replace(pattern, redactedSecret), tokenPatterns)
      : value;
};

/** Replaces every match of each pattern, such as `prefixedTokenPatterns`. */
export const redactPatternMatches = (value: string, patterns: readonly { pattern: RegExp }[]) =>
  patterns.reduce(
    (text, { pattern }) =>
      text.replace(
        new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`),
        redactedSecret,
      ),
    value,
  );
