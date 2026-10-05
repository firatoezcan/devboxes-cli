export const githubTaskCredentialFailureCodes = {
  installationRepositoryMismatch: "github_app_installation_repository_mismatch",
  installationSuspended: "github_app_installation_suspended",
  reconsentRequired: "github_app_reconsent_required",
} as const;
export type GitHubTaskCredentialFailureCode =
  (typeof githubTaskCredentialFailureCodes)[keyof typeof githubTaskCredentialFailureCodes];
