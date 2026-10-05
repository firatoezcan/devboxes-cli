import packageJson from "../package.json";

export const cliVersion: string = packageJson.version;
export const cliUserAgent = `devboxes/${cliVersion} (${process.platform}/${process.arch})`;

declare global {
  var DEVBOXES_DEFAULT_API_ORIGIN: string | undefined;
}
export const defaultApiOrigin = globalThis.DEVBOXES_DEFAULT_API_ORIGIN;
