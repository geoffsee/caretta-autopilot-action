import { rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const [entryArg = "src/index.ts", outdirArg = "dist"] = process.argv.slice(2);
const cwd = process.cwd();
const entry = resolve(cwd, entryArg);
const outdir = resolve(cwd, outdirArg);

await rm(outdir, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [entry],
  outdir,
  target: "node",
  sourcemap: "external",
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

await writeFile(
  resolve(outdir, "package.json"),
  `${JSON.stringify({ type: "module" }, null, 2)}\n`,
);

console.log(`Built ${entryArg} -> ${outdirArg}`);
