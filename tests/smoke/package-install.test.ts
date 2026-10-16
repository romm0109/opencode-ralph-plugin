import { expect, test } from "bun:test";
import { verifyPackage } from "../helpers/package.js";

test("local tarball installs and loads its plugin, skills and dashboard in two consumers", async () => {
  const evidence = await verifyPackage(false);
  expect(evidence.repositories).toHaveLength(2);
  console.log(
    `Installed package smoke: ${evidence.platform}, Bun ${evidence.bun}`,
  );
}, 180_000);
