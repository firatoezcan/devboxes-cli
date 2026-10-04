import packageJson from "../package.json";

export const cliVersion: string = packageJson.version;
export const cliUserAgent = `devboxes/${cliVersion} (${process.platform}/${process.arch})`;
