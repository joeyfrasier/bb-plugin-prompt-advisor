import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
export const machineContract = defineRpcContract({
  facts: {
    input: z.null(),
    output: z.object({
      platform: z.enum(["darwin", "linux", "win32", "other"]),
    }),
  },
});
