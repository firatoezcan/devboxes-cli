/** The regions where devboxes can place a managed Task. A deployment offers some of them. */
export const managedRegions = ["de"] as const;

/** Where each managed region's machines are, as a person reads it. */
export const managedRegionNames = { de: "Germany" } as const satisfies Record<
  (typeof managedRegions)[number],
  string
>;

/** The machine size of a Project's Tasks, on managed capacity and on a Runner alike. */
export const machineSizes = ["medium", "large", "xl"] as const;

/**
 * The CPUs and memory of each machine size. A Runner limits a Task's container to its size, and runs
 * another Task only while the sizes of its live Tasks fit what its owner lets devboxes use.
 */
export const machineSizeResources = {
  medium: { cpus: 4, memoryBytes: 8 * 1024 ** 3 },
  large: { cpus: 8, memoryBytes: 16 * 1024 ** 3 },
  xl: { cpus: 16, memoryBytes: 32 * 1024 ** 3 },
} as const satisfies Record<(typeof machineSizes)[number], { cpus: number; memoryBytes: number }>;

/** The bounds of how many fix Runs a Project's automatic Review may start for one piece of work. */
export const reviewFixRounds = { minimum: 0, maximum: 10 } as const;

/** The bounds of the output, in tokens, that a Project's model selection lets one call write. */
export const projectOutputTokens = { minimum: 1, maximum: 1_000_000 } as const;

/** The bounds of how many models a Project's model selection lists. */
export const projectModelCandidates = { minItems: 1, maxItems: 10 } as const;
