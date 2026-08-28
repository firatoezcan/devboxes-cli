export const opencodeReviewCaptureFailureReasons = [
  "capture-deadline-exceeded",
  "capture-start-failed",
  "diff-read-failed",
  "snapshot-delivery-failed",
  "snapshot-rejected",
] as const;

export type OpencodeReviewCaptureFailureReason =
  (typeof opencodeReviewCaptureFailureReasons)[number];

export const opencodeReviewCaptureAttemptStates = ["pending", "completed", "failed"] as const;

export type OpencodeReviewCaptureAttemptState = (typeof opencodeReviewCaptureAttemptStates)[number];
