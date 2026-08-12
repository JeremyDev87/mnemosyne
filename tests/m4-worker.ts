import { ActivationCoordinator } from "../src/wiki/activation-coordinator";

const [, , root, generation, attestationSha256, delayText] = process.argv;
if (!root || !generation || !attestationSha256) throw new Error("worker arguments missing");
const delayMs = Number(delayText ?? "0");
const coordinator = new ActivationCoordinator(root);
await new Promise((resolve) => setTimeout(resolve, delayMs));
try {
  await coordinator.activate({ expectedGeneration: null, nextGeneration: generation, attestationSha256 });
  process.stdout.write(`OK ${generation}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.name : "Error"}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
