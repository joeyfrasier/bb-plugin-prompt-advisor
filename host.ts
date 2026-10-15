import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { machineContract } from "./lib/machine-contract";
// Fixed projection: no environments, process arguments, files, logs, or credentials.
export default experimental_defineHostEntry({
  contract: machineContract,
  handlers: {
    facts: () => ({
      platform:
        process.platform === "darwin"
          ? "darwin"
          : process.platform === "linux"
            ? "linux"
            : process.platform === "win32"
              ? "win32"
              : "other",
    }),
  },
});
