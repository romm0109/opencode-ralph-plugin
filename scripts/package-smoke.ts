import { writeFile } from "node:fs/promises";
import { verifyPackage } from "../tests/helpers/package.js";

const evidence = await verifyPackage(true);
const report = {
  ...evidence,
  architecture: process.arch,
  opencode: "2.0.29",
  scope:
    "Installed command/native-question boundary/completion tools/same-session PRD/fresh issues/automatic execution and dual review/report",
  liveEvidence:
    "docs/live-opencode-trial.md (2026-10-15 trial is historical; new native flow needs a human-visible trial; this command uses deterministic fixtures)",
  releaseBlockers: [
    "Native Linux and Windows CI results required",
    "Human-visible new-protocol native forms, focus and progress trial required",
    "Pinned installed host persists opening request but exposes no native form (docs/live-opencode-evidence.json)",
  ],
};
if (process.env.PACKAGE_EVIDENCE_PATH) {
  await writeFile(
    process.env.PACKAGE_EVIDENCE_PATH,
    `${JSON.stringify(report, null, 2)}\n`,
  );
}
console.log(JSON.stringify(report, null, 2));
