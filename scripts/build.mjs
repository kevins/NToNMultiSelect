// Builds the control and both solution packages.
//
//   node scripts/build.mjs
//
// Output:
//   dist/NToNMultiSelect_unmanaged.zip   unmanaged solution (development environments)
//   dist/NToNMultiSelect_managed.zip     managed solution (test and production)
//
// The solution version is taken from the control version in ControlManifest.Input.xml (1.0.0 -> 1.0.0.0), so there
// is only one place to change it.
import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = readFileSync(join(root, "control/NToNMultiSelect/ControlManifest.Input.xml"), "utf8");
const version = /<control[^>]*\sversion="([^"]+)"/.exec(manifest)[1];
console.log(`Building N:N Multi-Select ${version} (solution version ${version}.0)`);

// Dataverse rejects apostrophes in manifest display and description keys on import (noAposStringType), but the PCF
// build tools don't check for it. Fail here instead of halfway through an import.
for (const m of manifest.matchAll(/(display-name-key|description-key)="([^"]*)"/g)) {
    if (m[2].includes("'")) throw new Error(`Manifest ${m[1]} contains an apostrophe, which Dataverse rejects on import: ${m[2]}`);
}

// 1. Form loader web resource. SolutionPackager expects a flat file named <name without punctuation><GUID>.
//    The control version is stamped in so the bundle URL changes with every release.
const loader = readFileSync(join(root, "formloader/formloader.js"), "utf8").replace("__VERSION__", version);
writeFileSync(join(root, "solution/src/WebResources/kv_NToNMultiSelectformloaderjs078EAC10-CCC9-489A-8EEB-8FA3FEECD8F8"), loader);

// 2. Solution version = control version + ".0".
const solutionXmlPath = join(root, "solution/src/Other/Solution.xml");
const solutionXml = readFileSync(solutionXmlPath, "utf8").replace(/<Version>[^<]*<\/Version>/, `<Version>${version}.0</Version>`);
writeFileSync(solutionXmlPath, solutionXml);

// 3. Release build: production webpack bundle, then the managed and unmanaged solution zips. The bundle is built here
//    because dotnet build skips the control when control/out is newer than the sources, and after a plain
//    `npm run build` that is the development bundle.
execSync("npm run build -- --noColor --buildMode production", { cwd: join(root, "control"), stdio: "inherit" });
// Packages left over from an earlier build would otherwise be copied to dist/ if packaging were skipped.
rmSync(join(root, "solution/bin/Release"), { recursive: true, force: true });
execSync("dotnet build -c Release -nologo -v:minimal", { cwd: join(root, "solution"), stdio: "inherit" });

// 3b. Make sure what went into the package is what's in the source: every manifest property made it into the built
//     manifest, and the packaged form loader is this version with the handler name the documentation gives.
const builtManifest = readFileSync(join(root, "control/out/controls/NToNMultiSelect/ControlManifest.xml"), "utf8");
for (const [, name] of manifest.matchAll(/<property name="([^"]+)"/g)) {
    if (!builtManifest.includes(`name="${name}"`)) throw new Error(`Built manifest is missing property ${name}; the package is stale.`);
}
if (!builtManifest.includes(`version="${version}"`)) throw new Error("Built manifest has a different version; the package is stale.");
const packagedLoader = readFileSync(join(root, "solution/src/WebResources/kv_NToNMultiSelectformloaderjs078EAC10-CCC9-489A-8EEB-8FA3FEECD8F8"), "utf8");
if (!packagedLoader.includes("KVNToNMultiSelectLoader") || !packagedLoader.includes(`VERSION = "${version}"`)) {
    throw new Error("Packaged form loader is not the current one.");
}

// 4. Copy the packages to dist/. The file names carry no version number; the version lives inside the solution.
const out = join(root, "solution/bin/Release");
const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });
const packages = readdirSync(out).filter((f) => f.endsWith(".zip"));
if (packages.length !== 2) throw new Error(`Expected a managed and an unmanaged package in solution/bin/Release, found: ${packages.join(", ") || "none"}.`);
for (const file of packages) {
    const target = file.includes("_managed") ? "NToNMultiSelect_managed.zip" : "NToNMultiSelect_unmanaged.zip";
    copyFileSync(join(out, file), join(dist, target));
    console.log(`Wrote dist/${target}`);
}
