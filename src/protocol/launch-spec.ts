import Type, { type Static } from "typebox";

export const opencodeWorkspaceLaunchProtocol = "devboxes-native-launch";

export const OpencodeAgentTaskEnvSchema = Type.Object({
  DEVBOX_WORKSPACE_CAPABILITY: Type.Literal("agent-task"),
  DEVBOX_WORKSPACE_CAPABILITY_ID: Type.String({ minLength: 1 }),
  DEVBOX_EXECUTOR_ID: Type.String({ minLength: 1 }),
  OPENCODE_WORKSPACE_ID: Type.String({ minLength: 1 }),
  TRACEPARENT: Type.String({ minLength: 1 }),
});

export type OpencodeAgentTaskEnv = Static<typeof OpencodeAgentTaskEnvSchema>;
