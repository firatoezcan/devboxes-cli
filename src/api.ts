import { treaty } from "@elysiajs/eden";
import Type from "typebox";
import Value from "typebox/value";

// Type-only wiring against the private monorepo this CLI is developed in,
// resolved through tsconfig "paths" there and fully erased at runtime
// (`import type`). The registry package contains no source; in the public
// source mirror this specifier stays unresolved on purpose.
import type { ApiType } from "#monorepo/api";

import packageJson from "../package.json";

const cliCommandName = "devboxes";
export const cliVersion: string = packageJson.version;
export const cliUserAgent = `devboxes/${cliVersion} (${process.platform}/${process.arch})`;

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const ApiErrorStatusSchema = Type.Number();
const ApiErrorValueSchema = Type.Object(
  {
    code: Type.Optional(Type.String()),
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

// Eden validation errors echo request bodies; dispatch text must stay out of logs.
export const apiRequestError = (
  operation: string,
  error: { status: unknown; value: unknown },
  reauthenticateWith: "login" | "connect" = "login",
) => {
  const value = Value.Check(ApiErrorValueSchema, error.value) ? error.value : null;
  const code = value?.code ?? null;
  const detail = value?.error ?? "The API answered without an error description.";
  const status = Value.Check(ApiErrorStatusSchema, error.status) ? error.status : 0;
  const hint =
    status === 401 ? ` Run \`${cliCommandName} ${reauthenticateWith}\` and try again.` : "";
  return new ApiRequestError(
    `${operation} failed with HTTP ${String(error.status)}: ${detail}${hint}`,
    status,
    code,
  );
};

// loadContext guarantees the base URL ends in /api; Eden's typed routes re-add
// that segment (backend.api...), so the treaty origin is the URL without it.
export const bearerBackend = (apiBaseUrl: string, sessionToken: string) =>
  treaty<ApiType>(apiBaseUrl.replace(/\/api$/, ""), {
    onRequest(_path, requestOptions) {
      const headers = new Headers(requestOptions.headers);
      headers.set("Authorization", `Bearer ${sessionToken}`);
      headers.set("User-Agent", cliUserAgent);
      return { ...requestOptions, headers };
    },
  });
