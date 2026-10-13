// Builds the solution with the names copy plug-in: the control and the form library (as in the solution without the
// plug-in), plus the plug-in assembly, its Associate and Disassociate steps, and the steps page.
//
//   node scripts/build.mjs               (the control and the solution without the plug-in)
//   node scripts/build-with-plugin.mjs
//
// Output:
//   dist/NToNMultiSelectWithPlugin_unmanaged.zip   for development environments
//   dist/NToNMultiSelectWithPlugin_managed.zip     the same, managed, for test and production
//
// The plug-in registration (assembly, plug-in type and the Associate and Disassociate steps, with their ids) is in
// plugin/registration. The solution has no Delete or Update step: the steps page (plugin/steps-page, an HTML web
// resource for administrators) creates them in the environment, for the linked tables only. The assembly is built from
// plugin/NamesCopy and signed with the strong name key plugin/NamesCopy/NamesCopy.snk. The repository has no key (it is
// not committed): the first build creates one, and every later build uses it. Keep that file: an environment that has
// the plug-in only takes an update signed with the same key. The key gives the assembly its public key token; it is
// read from the key file and written into the registration, so any key works without further changes.
import { execSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pluginProject = join(root, "plugin/NamesCopy");
const registration = join(root, "plugin/registration");
const dll = join(pluginProject, "bin/Release/net462/NToNMultiSelect.NamesCopy.dll");
// The steps page (an HTML web resource for administrators, see the page itself) and its web resource id.
const stepsPage = join(root, "plugin/steps-page/namescopysteps.html");
const STEPS_PAGE_ID = "2920d18e-7d4e-4e8d-94c7-f51018faea0e";

/** The messages of the steps in the solution, by message id: Associate and Disassociate only. */
const MESSAGES = {
    "16e7c888-3b24-448b-b7da-ebfe9b681762": "Associate",
    "bdfc191d-fc56-493a-a6b1-cb0c47a22ecc": "Disassociate",
};

const SOLUTION = {
    uniqueName: "NToNMultiSelectWithPlugin",
    description:
        "Many-to-many multi-select field control, with the plug-in that keeps the names in the host column up to date when records are linked or unlinked. Its steps page creates the Delete and Update steps for the linked tables.",
};

/**
 * The public key token of the strong name key pair in `snkPath` (a file made by `sn -k` or Visual Studio): the last 8
 * bytes, reversed, of the SHA-1 hash of the public key as assemblies store it.
 */
function publicKeyToken(snkPath) {
    const snk = readFileSync(snkPath);
    // A key pair file: BLOBHEADER (8 bytes), RSAPUBKEY ("RSA2", bit length, exponent), modulus, private parts.
    if (snk[0] !== 0x07 || snk.toString("ascii", 8, 12) !== "RSA2") throw new Error(`${snkPath} is not a strong name key pair file.`);
    const bitLength = snk.readUInt32LE(12);
    const modulus = snk.subarray(20, 20 + bitLength / 8);
    // The same key as a PUBLICKEYBLOB, after the signature algorithm, hash algorithm and length.
    const blob = Buffer.alloc(20);
    blob.writeUInt8(0x06, 0);
    blob.writeUInt8(0x02, 1);
    blob.writeUInt32LE(0x2400, 4);
    blob.write("RSA1", 8, "ascii");
    blob.writeUInt32LE(bitLength, 12);
    snk.copy(blob, 16, 16, 20);
    const head = Buffer.alloc(12);
    head.writeUInt32LE(0x2400, 0);
    head.writeUInt32LE(0x8004, 4);
    head.writeUInt32LE(blob.length + modulus.length, 8);
    const sha = createHash("sha1").update(Buffer.concat([head, blob, modulus])).digest();
    return Buffer.from(sha.subarray(sha.length - 8)).reverse().toString("hex");
}

/**
 * Writes a new strong name key pair to `snkPath`, in the format `sn -k` writes (a PRIVATEKEYBLOB): BLOBHEADER,
 * RSAPUBKEY ("RSA2", bit length, public exponent), then the modulus, the two primes, the two exponents, the
 * coefficient and the private exponent, each little-endian and of its fixed size.
 */
function createKey(snkPath, bits = 2048) {
    const jwk = generateKeyPairSync("rsa", { modulusLength: bits, publicExponent: 0x10001 }).privateKey.export({ format: "jwk" });
    // A JWK number is big-endian without leading zeros: little-endian, padded to `size` bytes.
    const le = (value, size) => {
        const bytes = Buffer.from(value, "base64url").reverse();
        if (bytes.length > size) throw new Error("Unexpected key part length.");
        return Buffer.concat([bytes, Buffer.alloc(size - bytes.length)]);
    };
    const header = Buffer.alloc(20);
    header.writeUInt8(0x07, 0); // PRIVATEKEYBLOB
    header.writeUInt8(0x02, 1); // version
    header.writeUInt32LE(0x2400, 4); // CALG_RSA_SIGN
    header.write("RSA2", 8, "ascii");
    header.writeUInt32LE(bits, 12);
    header.writeUInt32LE(Buffer.from(jwk.e, "base64url").readUIntBE(0, Buffer.from(jwk.e, "base64url").length), 16);
    const whole = bits / 8;
    const half = bits / 16;
    writeFileSync(snkPath, Buffer.concat([header, le(jwk.n, whole), le(jwk.p, half), le(jwk.q, half), le(jwk.dp, half), le(jwk.dq, half), le(jwk.qi, half), le(jwk.d, whole)]));
}

/**
 * Writes the steps page into `folder` (the WebResources folder of a solution project) as the web resource
 * <prefix>_/NToNMultiSelect/namescopysteps.html, and returns that name.
 */
function addStepsPage(folder, prefix) {
    const name = `${prefix}_/NToNMultiSelect/namescopysteps.html`;
    const file = `${prefix}_NToNMultiSelectnamescopystepshtml${STEPS_PAGE_ID.toUpperCase()}`;
    mkdirSync(folder, { recursive: true });
    // The page says its own address when it is opened elsewhere (see the page): its name is written into it.
    const page = readFileSync(stepsPage, "utf8");
    if (!page.includes("__STEPS_PAGE_NAME__")) throw new Error("The steps page has no __STEPS_PAGE_NAME__ to fill in.");
    writeFileSync(join(folder, file), page.split("__STEPS_PAGE_NAME__").join(name));
    writeFileSync(
        join(folder, `${file}.data.xml`),
        `<?xml version="1.0" encoding="utf-8"?>
<WebResource xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <WebResourceId>{${STEPS_PAGE_ID}}</WebResourceId>
  <Name>${name}</Name>
  <DisplayName>N:N Multi-Select names copy: steps for your tables</DisplayName>
  <Description>Page for administrators: creates the Delete and Update steps of the names copy plug-in for the linked tables only. Open it at the environment URL followed by /WebResources/${name}</Description>
  <LanguageCode>0</LanguageCode>
  <WebResourceType>1</WebResourceType>
  <IntroducedVersion>1.0.0.0</IntroducedVersion>
  <IsEnabledForMobileClient>0</IsEnabledForMobileClient>
  <IsAvailableForMobileOffline>0</IsAvailableForMobileOffline>
  <FileName>/WebResources/${file}</FileName>
</WebResource>
`,
    );
    return name;
}

// 1. The control's production bundle, as scripts/build.mjs builds it. The solution project takes the bundle from
// control/out, and dotnet build skips the control when control/out is newer than the sources: after a plain
// `npm run build` or `npm start watch`, that would be the development bundle.
execSync("npm run build -- --noColor --buildMode production", { cwd: join(root, "control"), stdio: "inherit" });

// 2. The plug-in assembly (.NET Framework 4.6.2, as the Dataverse sandbox requires), signed with the key of this copy
// of the repository, created at the first build.
const keyFile = join(pluginProject, "NamesCopy.snk");
if (!existsSync(keyFile)) {
    createKey(keyFile);
    console.log("Created the strong name key plugin/NamesCopy/NamesCopy.snk. Keep it (it is not committed): every later build of the plug-in must be signed with it.");
}
execSync("dotnet build -c Release -nologo -v:minimal", { cwd: pluginProject, stdio: "inherit" });
const token = publicKeyToken(keyFile);

const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });

// 3. The solution project: the solution without the plug-in under another unique name, plus the plug-in registration.
const project = join(root, "solution-with-plugin");
rmSync(project, { recursive: true, force: true });
mkdirSync(project, { recursive: true });
writeFileSync(
    join(project, "solution.cdsproj"),
    readFileSync(join(root, "solution/solution.cdsproj"), "utf8").replace(/<ProjectGuid>[^<]*<\/ProjectGuid>/, `<ProjectGuid>${randomUUID()}</ProjectGuid>`),
);
cpSync(join(root, "solution/src"), join(project, "src"), { recursive: true });
cpSync(registration, join(project, "src"), { recursive: true });

// The assembly and the public key token of this build.
const asmFolder = readdirSync(join(project, "src/PluginAssemblies"))[0];
copyFileSync(dll, join(project, "src/PluginAssemblies", asmFolder, "NToNMultiSelectNamesCopy.dll"));
const withToken = (path) => writeFileSync(path, readFileSync(path, "utf8").replace(/PublicKeyToken=[0-9a-f]{16}/g, `PublicKeyToken=${token}`));
withToken(join(project, "src/PluginAssemblies", asmFolder, "NToNMultiSelectNamesCopy.dll.data.xml"));

// The steps: one Associate and one Disassociate step, nothing else.
const stepsFolder = join(project, "src/SdkMessageProcessingSteps");
const steps = [];
const messages = [];
for (const file of readdirSync(stepsFolder)) {
    const path = join(stepsFolder, file);
    const messageId = /<SdkMessageId>([^<]+)<\/SdkMessageId>/.exec(readFileSync(path, "utf8"))?.[1];
    if (!MESSAGES[messageId]) throw new Error(`${file}: a step of message ${messageId}; the solution only has Associate and Disassociate steps.`);
    withToken(path);
    steps.push(file.replace(/\.xml$/, ""));
    messages.push(MESSAGES[messageId]);
}
if (messages.sort().join(", ") !== "Associate, Disassociate") {
    throw new Error(`Expected one Associate and one Disassociate step in plugin/registration, found: ${messages.join(", ") || "none"}.`);
}

// Solution.xml: another unique name and description, and the assembly, the steps and the steps page as root
// components. The steps page is named with the prefix of the solution's publisher.
const asmXml = readFileSync(join(project, "src/PluginAssemblies", asmFolder, "NToNMultiSelectNamesCopy.dll.data.xml"), "utf8");
const asmId = /PluginAssemblyId="([^"]+)"/.exec(asmXml)[1];
const asmName = /FullName="([^"]+)"/.exec(asmXml)[1];
const solutionXmlPath = join(project, "src/Other/Solution.xml");
const plainSolutionXml = readFileSync(solutionXmlPath, "utf8");
const prefix = /<CustomizationPrefix>([^<]+)<\/CustomizationPrefix>/.exec(plainSolutionXml)[1];
const pageName = addStepsPage(join(project, "src/WebResources"), prefix);
const solutionXml = plainSolutionXml
    .replace("<UniqueName>NToNMultiSelect</UniqueName>", `<UniqueName>${SOLUTION.uniqueName}</UniqueName>`)
    // Same display name as the solution without the plug-in; the unique name and the description tell them apart.
    .replace(/(<Descriptions>\s*<Description description=")[^"]*(" languagecode="1033" \/>)/, `$1${SOLUTION.description}$2`)
    .replace(
        "</RootComponents>",
        `  <RootComponent type="91" id="{${asmId}}" schemaName="${asmName}" behavior="0" />\n` +
            steps.map((id) => `      <RootComponent type="92" id="${id}" behavior="0" />\n`).join("") +
            `      <RootComponent type="61" schemaName="${pageName}" behavior="0" />\n` +
            "    </RootComponents>",
    );
if (!solutionXml.includes(`<UniqueName>${SOLUTION.uniqueName}</UniqueName>`)) throw new Error("Solution.xml: the unique name was not replaced.");
writeFileSync(solutionXmlPath, solutionXml);
const customizationsPath = join(project, "src/Other/Customizations.xml");
const customizations = readFileSync(customizationsPath, "utf8");
if (!customizations.includes("<SdkMessageProcessingSteps />")) {
    writeFileSync(customizationsPath, customizations.replace("<SolutionPluginAssemblies />", "<SolutionPluginAssemblies />\n  <SdkMessageProcessingSteps />"));
}

// 4. Package (the control's bundle is taken from control/out, built in step 1) and copy to dist/.
execSync("dotnet build -c Release -nologo -v:minimal", { cwd: project, stdio: "inherit" });
const out = join(project, "bin/Release");
const packages = readdirSync(out).filter((f) => f.endsWith(".zip"));
if (packages.length !== 2) throw new Error(`Expected a managed and an unmanaged package in ${out}, found: ${packages.join(", ") || "none"}.`);
for (const file of packages) {
    const target = `${SOLUTION.uniqueName}_${file.includes("_managed") ? "managed" : "unmanaged"}.zip`;
    copyFileSync(join(out, file), join(dist, target));
    console.log(`Wrote dist/${target} (${steps.length} steps, plug-in public key token ${token})`);
}
