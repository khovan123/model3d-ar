import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { access, copyFile, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { inspectGlbAnimations } from "./glb-inspector.mjs";

const args = new Set(process.argv.slice(2));
const once = args.has("--once");
const checkOnly = args.has("--check");
let stopping = false;

function log(level, message, details) {
  const suffix = details === undefined ? "" : ` ${JSON.stringify(details)}`;
  console[level](`${new Date().toISOString()} [USDZ WORKER] ${message}${suffix}`);
}

async function loadLocalEnv() {
  try {
    const value = await readFile(path.join(process.cwd(), ".env.local"), "utf8");
    for (const rawLine of value.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const separator = line.indexOf("=");
      if (separator <= 0) continue;
      const key = line.slice(0, separator).trim();
      let envValue = line.slice(separator + 1).trim();
      if ((envValue.startsWith('"') && envValue.endsWith('"')) || (envValue.startsWith("'") && envValue.endsWith("'"))) {
        envValue = envValue.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = envValue;
    }
  } catch {
    // Production normally injects environment variables through PM2/systemd.
  }
}

await loadLocalEnv();

const supabaseUrl = process.env.SUPABASE_URL
  ?.replace(/\/(?:rest|storage)\/v1\/?$/, "")
  .replace(/\/$/, "");
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? "models";
const blenderBin = process.env.BLENDER_BIN ?? "blender";
const unzipBin = process.env.UNZIP_BIN ?? "unzip";
const usdzipBin = process.env.USDZIP_BIN ?? "usdzip";
const usdcatBin = process.env.USDCAT_BIN ?? "usdcat";
const pollIntervalMs = positiveNumber(process.env.USDZ_POLL_INTERVAL_MS, 15000);
const staleAfterMinutes = positiveNumber(process.env.USDZ_STALE_AFTER_MINUTES, 30);
const maxAttempts = positiveNumber(process.env.USDZ_MAX_ATTEMPTS, 3);
const maxFileSize = positiveNumber(process.env.USDZ_MAX_FILE_SIZE_MB, 200) * 1024 * 1024;
const maxAssetFileSize = positiveNumber(process.env.MODEL_ASSET_MAX_FILE_SIZE_MB, 250) * 1024 * 1024;
const maxPackageUncompressedSize = positiveNumber(process.env.MODEL_PACKAGE_MAX_UNCOMPRESSED_MB, 500) * 1024 * 1024;
const targetSizeMeters = positiveNumber(process.env.USDZ_TARGET_SIZE_METERS, 0.8);
const keepFailedWorkDir = process.env.USDZ_KEEP_FAILED_WORK_DIR === "true";
const workRoot = process.env.USDZ_WORK_DIR ?? os.tmpdir();
const blenderScript = path.join(process.cwd(), "scripts", "blender", "glb_to_usd.py");
const sourceToGlbScript = path.join(process.cwd(), "scripts", "blender", "source_to_glb.py");
const packageModelPriority = ["glb", "gltf", "fbx", "blend", "dae", "obj", "3mf", "stl", "ply", "usdz"];

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getModelExtension(fileNameOrPath) {
  const clean = String(fileNameOrPath).split(/[?#]/)[0] ?? "";
  const name = clean.slice(clean.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

function validatePackageEntry(entry) {
  const normalized = entry.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:\//.test(normalized) ||
    segments.includes("..")
  ) {
    throw new Error(`ZIP contains an unsafe path: ${entry}`);
  }
  return normalized;
}

function requireConfig() {
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  }
}

function encodedObjectPath(value) {
  return value.split("/").map(encodeURIComponent).join("/");
}

function serviceHeaders(extra = {}) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    ...extra
  };
}

async function databaseRequest(query, init = {}) {
  requireConfig();
  const response = await fetch(`${supabaseUrl}/rest/v1/${query}`, {
    ...init,
    headers: serviceHeaders(init.headers),
    cache: "no-store"
  });
  if (!response.ok) {
    throw new Error(`Supabase Database ${response.status}: ${await response.text()}`);
  }
  return response;
}

async function downloadStorageObject(storagePath, destination) {
  const response = await fetch(
    `${supabaseUrl}/storage/v1/object/authenticated/${encodeURIComponent(bucket)}/${encodedObjectPath(storagePath)}`,
    { headers: serviceHeaders() }
  );
  if (!response.ok) {
    throw new Error(`Supabase download ${response.status}: ${await response.text()}`);
  }
  if (!response.body) throw new Error("Supabase download returned an empty response body.");
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}

async function uploadStorageObject(storagePath, source, contentType) {
  const response = await fetch(
    `${supabaseUrl}/storage/v1/object/${encodeURIComponent(bucket)}/${encodedObjectPath(storagePath)}`,
    {
      method: "POST",
      headers: serviceHeaders({
        "Content-Type": contentType,
        "x-upsert": "true"
      }),
      body: createReadStream(source),
      duplex: "half"
    }
  );
  if (!response.ok) {
    throw new Error(`Supabase upload ${response.status}: ${await response.text()}`);
  }
}

async function recoverStaleJobs() {
  const cutoff = new Date(Date.now() - staleAfterMinutes * 60 * 1000).toISOString();
  for (const phase of ["asset", "usdz"]) {
    const retryQuery = new URLSearchParams({
      [`${phase}_status`]: "eq.processing",
      [`${phase}_updated_at`]: `lt.${cutoff}`,
      [`${phase}_attempts`]: `lt.${maxAttempts}`
    });
    await databaseRequest(`models?${retryQuery}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        [`${phase}_status`]: "pending",
        [`${phase}_error`]: "Recovered stale processing job.",
        [`${phase}_updated_at`]: new Date().toISOString()
      })
    });

    const failedQuery = new URLSearchParams({
      [`${phase}_status`]: "eq.processing",
      [`${phase}_updated_at`]: `lt.${cutoff}`,
      [`${phase}_attempts`]: `gte.${maxAttempts}`
    });
    await databaseRequest(`models?${failedQuery}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        [`${phase}_status`]: "failed",
        [`${phase}_error`]: "Worker stopped during the final conversion attempt.",
        [`${phase}_updated_at`]: new Date().toISOString()
      })
    });
  }
}

async function nextPendingAssetJob() {
  const query = new URLSearchParams({
    select: "id,name,storage_path,asset_attempts,usdz_status",
    storage_provider: "eq.supabase",
    asset_status: "eq.pending",
    asset_attempts: `lt.${maxAttempts}`,
    order: "created_at.asc",
    limit: "1"
  });
  const response = await databaseRequest(`models?${query}`);
  const rows = await response.json();
  return rows[0] ?? null;
}

async function nextPendingUsdzJob() {
  const query = new URLSearchParams({
    select: "id,name,asset_storage_path,usdz_attempts",
    storage_provider: "eq.supabase",
    asset_status: "eq.ready",
    usdz_status: "eq.pending",
    usdz_attempts: `lt.${maxAttempts}`,
    order: "created_at.asc",
    limit: "1"
  });
  const response = await databaseRequest(`models?${query}`);
  const rows = await response.json();
  return rows[0] ?? null;
}

async function claimJob(job, phase) {
  const query = new URLSearchParams({ id: `eq.${job.id}`, [`${phase}_status`]: "eq.pending" });
  const response = await databaseRequest(`models?${query}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({
      [`${phase}_status`]: "processing",
      [`${phase}_error`]: null,
      [`${phase}_attempts`]: Number(job[`${phase}_attempts`] ?? 0) + 1,
      [`${phase}_updated_at`]: new Date().toISOString()
    })
  });
  const rows = await response.json();
  return rows[0] ?? null;
}

async function updateJob(id, values) {
  const query = new URLSearchParams({ id: `eq.${id}` });
  await databaseRequest(`models?${query}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(values)
  });
}

async function updatePhaseJob(id, phase, values) {
  await updateJob(id, { ...values, [`${phase}_updated_at`]: new Date().toISOString() });
}

async function commandExists(command, commandArgs = ["--version"]) {
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, { stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}

async function inspectBlenderImporters() {
  const expression = [
    "import bpy,json",
    "ops=bpy.ops",
    "result={'glb':hasattr(ops.import_scene,'gltf'),'gltf':hasattr(ops.import_scene,'gltf'),'fbx':hasattr(ops.import_scene,'fbx'),'dae':hasattr(ops.wm,'collada_import'),'obj':hasattr(ops.wm,'obj_import') or hasattr(ops.import_scene,'obj'),'stl':hasattr(ops.wm,'stl_import') or hasattr(ops.import_mesh,'stl'),'ply':hasattr(ops.wm,'ply_import') or hasattr(ops.import_mesh,'ply'),'3mf':hasattr(ops.wm,'threemf_import') or hasattr(ops.import_mesh,'threemf') or hasattr(ops.import_scene,'threemf'),'blend':True,'usdz':hasattr(ops.wm,'usd_import')}",
    "print('MODELSPACE_IMPORTERS='+json.dumps(result))"
  ].join(";");
  const output = await runCommand(blenderBin, [
    "--background",
    "--factory-startup",
    "--python-expr",
    expression
  ]);
  const line = output.stdout.split(/\r?\n/).find((item) => item.startsWith("MODELSPACE_IMPORTERS="));
  return line ? JSON.parse(line.slice("MODELSPACE_IMPORTERS=".length)) : undefined;
}

async function runCommand(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd ?? process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    const maxOutputLength = options.maxOutputLength ?? 40000;
    const append = (current, chunk, markTruncated) => {
      const next = `${current}${chunk}`;
      if (maxOutputLength === 0) return next;
      if (next.length > maxOutputLength) markTruncated();
      return options.keepOutputStart
        ? next.slice(0, maxOutputLength)
        : next.slice(-maxOutputLength);
    };
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk, () => { stdoutTruncated = true; });
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk, () => { stderrTruncated = true; });
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr, stdoutTruncated, stderrTruncated });
      else reject(new Error(`${command} exited with ${code}.\n${stderr || stdout}`));
    });
  });
}

async function extractModelPackage(archivePath, destination) {
  const [entryListing, detailedListing] = await Promise.all([
    runCommand(unzipBin, ["-Z1", archivePath], { keepOutputStart: true, maxOutputLength: 2 * 1024 * 1024 }),
    runCommand(unzipBin, ["-Z", "-l", archivePath], { keepOutputStart: true, maxOutputLength: 2 * 1024 * 1024 })
  ]);
  if (entryListing.stdoutTruncated || detailedListing.stdoutTruncated) {
    throw new Error("ZIP package listing is too large to validate safely.");
  }
  const entries = entryListing.stdout.split(/\r?\n/).filter(Boolean).map(validatePackageEntry);
  if (entries.length === 0) throw new Error("ZIP package is empty.");
  if (entries.length > 10000) throw new Error("ZIP package contains too many entries.");
  if (/^l[-rwx]{9}\s/m.test(detailedListing.stdout)) {
    throw new Error("ZIP package contains symbolic links, which are not allowed.");
  }

  const sizeMatch = detailedListing.stdout.match(/([\d,]+)\s+bytes uncompressed/i);
  const uncompressedBytes = sizeMatch ? Number(sizeMatch[1].replaceAll(",", "")) : undefined;
  if (uncompressedBytes !== undefined && uncompressedBytes > maxPackageUncompressedSize) {
    throw new Error(
      `ZIP package exceeds ${Math.round(maxPackageUncompressedSize / 1024 / 1024)} MB after extraction.`
    );
  }

  await runCommand(unzipBin, ["-q", archivePath, "-d", destination]);
  return { entries: entries.length, uncompressedBytes };
}

async function collectPackageModels(directory, root = directory) {
  const items = await readdir(directory, { withFileTypes: true });
  const models = [];
  for (const item of items) {
    if (item.name === "__MACOSX" || item.name.startsWith(".")) continue;
    const itemPath = path.join(directory, item.name);
    if (item.isSymbolicLink()) throw new Error(`ZIP package contains a symbolic link: ${item.name}`);
    if (item.isDirectory()) {
      models.push(...await collectPackageModels(itemPath, root));
      continue;
    }
    if (!item.isFile()) continue;
    const extension = getModelExtension(item.name);
    const priority = extension ? packageModelPriority.indexOf(extension) : -1;
    if (priority < 0) continue;
    const fileStat = await stat(itemPath);
    const relativePath = path.relative(root, itemPath);
    models.push({
      path: itemPath,
      relativePath,
      extension,
      priority,
      depth: relativePath.split(path.sep).length,
      size: fileStat.size
    });
  }
  return models;
}

async function selectPackageModel(directory) {
  const models = await collectPackageModels(directory);
  if (models.length === 0) {
    throw new Error(`ZIP package does not contain a supported model file: ${packageModelPriority.map((item) => `.${item}`).join(", ")}.`);
  }
  models.sort((left, right) =>
    left.priority - right.priority ||
    left.depth - right.depth ||
    right.size - left.size ||
    left.relativePath.localeCompare(right.relativePath)
  );
  return { selected: models[0], candidates: models.length };
}

function blenderReport(stdout) {
  const line = stdout.split(/\r?\n/).find((item) => item.startsWith("MODELSPACE_RESULT="));
  if (!line) return undefined;
  try {
    return JSON.parse(line.slice("MODELSPACE_RESULT=".length));
  } catch {
    return { raw: line.slice("MODELSPACE_RESULT=".length) };
  }
}

async function auditUsdz(usdzPath, rootLayerPath, glb) {
  const listing = await runCommand(usdzipBin, [usdzPath, "--list", "-"]);
  if (!listing.stdout.includes(path.basename(rootLayerPath))) {
    throw new Error("USDZ archive does not contain the exported root layer.");
  }

  if (!(await commandExists(usdcatBin, ["--help"]))) {
    return { animationAudit: "skipped", archiveFiles: listing.stdout.trim().split(/\r?\n/).length };
  }

  const output = await runCommand(usdcatBin, [rootLayerPath], {
    keepOutputStart: true,
    maxOutputLength: 2 * 1024 * 1024
  });
  const text = output.stdout;
  const markers = {
    skelRoot: text.includes("SkelRoot"),
    skeleton: text.includes("Skeleton"),
    skelAnimation: text.includes("SkelAnimation"),
    skelBindingApi: text.includes("SkelBindingAPI"),
    timeSamples: /timeSamples\s*=/.test(text)
  };
  const hasSkeletonAnimation = (markers.skelRoot || markers.skeleton) && markers.skelAnimation;
  const requiresSkeletonAnimation = Number(glb?.skins ?? 0) > 0;
  const hasSupportedAnimation = requiresSkeletonAnimation
    ? hasSkeletonAnimation
    : hasSkeletonAnimation || markers.timeSamples;

  return {
    animationAudit: hasSupportedAnimation ? "found" : "missing",
    requiredAnimation: requiresSkeletonAnimation ? "skeleton" : "timesamples-or-skeleton",
    markers,
    archiveFiles: listing.stdout.trim().split(/\r?\n/).length
  };
}

async function convertAssetJob(job) {
  if (!job.storage_path) throw new Error("Model has no Supabase source storage path.");

  const extension = getModelExtension(job.storage_path);
  if (!extension) throw new Error("Model source path has no file extension.");

  if (extension === "glb") {
    await updatePhaseJob(job.id, "asset", {
      asset_status: "ready",
      asset_storage_path: job.storage_path,
      asset_error: null
    });
    return;
  }

  const tempDir = await mkdtemp(path.join(workRoot, "modelspace-asset-"));
  const inputPath = path.join(tempDir, `source.${extension}`);
  const packageDir = path.join(tempDir, "package");
  const outputPath = path.join(tempDir, "model.glb");
  const storagePath = `converted/${job.id}.glb`;
  let completed = false;

  try {
    await downloadStorageObject(job.storage_path, inputPath);
    let sourcePath = inputPath;
    let sourceExtension = extension;
    let packageInfo;
    if (extension === "zip") {
      const archive = await extractModelPackage(inputPath, packageDir);
      const selection = await selectPackageModel(packageDir);
      sourcePath = selection.selected.path;
      sourceExtension = selection.selected.extension;
      packageInfo = {
        ...archive,
        candidates: selection.candidates,
        selected: selection.selected.relativePath,
        selectedExtension: sourceExtension
      };
    }

    let blenderResult;
    let sourceGlb;
    if (sourceExtension === "glb") {
      sourceGlb = await inspectGlbAnimations(sourcePath);
    }
    const shouldRepackGlb = sourceExtension === "glb" && Number(sourceGlb?.externalResources ?? 0) > 0;
    if (sourceExtension === "glb" && !shouldRepackGlb) {
      await copyFile(sourcePath, outputPath);
    } else {
      blenderResult = await runCommand(blenderBin, [
        "--background",
        "--factory-startup",
        "--python",
        sourceToGlbScript,
        "--",
        sourcePath,
        outputPath
      ]);
    }
    await access(outputPath);
    const outputStat = await stat(outputPath);
    if (outputStat.size < 1024) throw new Error("Generated GLB is unexpectedly empty.");
    if (outputStat.size > maxAssetFileSize) {
      throw new Error(`Generated GLB exceeds ${Math.round(maxAssetFileSize / 1024 / 1024)} MB.`);
    }

    const glb = await inspectGlbAnimations(outputPath);
    if (glb.externalResources > 0) {
      throw new Error(
        `Generated GLB still references external resources: ${JSON.stringify(glb.externalResourceUris)}`
      );
    }
    const blender = blenderResult ? blenderReport(blenderResult.stdout) : undefined;
    await uploadStorageObject(storagePath, outputPath, "model/gltf-binary");
    await updatePhaseJob(job.id, "asset", {
      asset_status: "ready",
      asset_storage_path: storagePath,
      asset_error: null
    });
    log("info", "Source model converted to viewer GLB.", {
      modelId: job.id,
      name: job.name,
      sourceExtension,
      sourceGlb,
      repackedExternalResources: shouldRepackGlb,
      package: packageInfo,
      bytes: outputStat.size,
      storagePath,
      glb,
      blender,
      blenderWarnings: blenderResult?.stderr.trim() || undefined
    });
    completed = true;
  } finally {
    if (completed || !keepFailedWorkDir) {
      await rm(tempDir, { recursive: true, force: true });
    } else {
      log("warn", "Retained failed source conversion workspace for diagnostics.", {
        modelId: job.id,
        tempDir,
        inputPath,
        outputPath
      });
    }
  }
}

async function convertUsdzJob(job) {
  if (!job.asset_storage_path) throw new Error("Model has no ready viewer GLB storage path.");

  const tempDir = await mkdtemp(path.join(workRoot, "modelspace-usdz-"));
  const inputPath = path.join(tempDir, "source.glb");
  const outputDir = path.join(tempDir, "usd");
  const rootLayerPath = path.join(outputDir, "model.usdc");
  const usdzPath = path.join(tempDir, `${job.id}.usdz`);
  const storagePath = `usdz/${job.id}.usdz`;
  let completed = false;

  try {
    await downloadStorageObject(job.asset_storage_path, inputPath);
    const glb = await inspectGlbAnimations(inputPath);
    if (!glb.hasAnimations) {
      await updatePhaseJob(job.id, "usdz", {
        usdz_status: "skipped",
        usdz_storage_path: null,
        usdz_error: null
      });
      log("info", "Skipped USDZ conversion because the GLB has no animation channels.", {
        modelId: job.id,
        name: job.name,
        glb
      });
      completed = true;
      return;
    }

    const blenderResult = await runCommand(blenderBin, [
      "--background",
      "--factory-startup",
      "--python",
      blenderScript,
      "--",
      inputPath,
      rootLayerPath,
      String(targetSizeMeters)
    ]);
    await access(rootLayerPath);
    const blender = blenderReport(blenderResult.stdout);
    log("info", "Blender USD export completed.", {
      modelId: job.id,
      name: job.name,
      glb,
      blender,
      blenderWarnings: blenderResult.stderr.trim() || undefined
    });

    await runCommand(usdzipBin, [usdzPath, "--arkitAsset", rootLayerPath], { cwd: outputDir });
    const outputStat = await stat(usdzPath);
    if (outputStat.size < 1024) throw new Error("Generated USDZ is unexpectedly empty.");
    if (outputStat.size > maxFileSize) {
      throw new Error(`Generated USDZ exceeds ${Math.round(maxFileSize / 1024 / 1024)} MB.`);
    }

    const audit = await auditUsdz(usdzPath, rootLayerPath, glb);
    if (audit.animationAudit === "missing") {
      throw new Error(
        `USD output is missing supported animation data: ${JSON.stringify(audit)}`
      );
    }

    await uploadStorageObject(storagePath, usdzPath, "model/vnd.usdz+zip");
    await updatePhaseJob(job.id, "usdz", {
      usdz_status: "ready",
      usdz_storage_path: storagePath,
      usdz_error: null
    });
    log("info", "Conversion completed.", {
      modelId: job.id,
      name: job.name,
      bytes: outputStat.size,
      storagePath,
      glb,
      audit,
      blender
    });
    completed = true;
  } finally {
    if (completed || !keepFailedWorkDir) {
      await rm(tempDir, { recursive: true, force: true });
    } else {
      log("warn", "Retained failed conversion workspace for diagnostics.", {
        modelId: job.id,
        tempDir,
        rootLayerPath,
        usdzPath
      });
    }
  }
}

async function processPhaseJob(phase, candidate, converter) {
  if (!candidate) return false;
  const job = await claimJob(candidate, phase);
  if (!job) return true;

  log("info", `Claimed ${phase} conversion job.`, {
    modelId: job.id,
    name: job.name,
    attempt: job[`${phase}_attempts`]
  });

  try {
    await converter(job);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const attempts = Number(job[`${phase}_attempts`] ?? 0);
    const exhausted = attempts >= maxAttempts;
    const failureValues = {
      [`${phase}_status`]: exhausted ? "failed" : "pending",
      [`${phase}_error`]: message.slice(0, 4000)
    };
    if (phase === "asset" && exhausted && job.usdz_status !== "ready") {
      Object.assign(failureValues, {
        usdz_status: "unsupported",
        usdz_error: "USDZ was not generated because source-to-GLB conversion failed.",
        usdz_updated_at: new Date().toISOString()
      });
    }
    await updatePhaseJob(job.id, phase, failureValues);
    log("error", exhausted ? `${phase} conversion failed permanently.` : `${phase} conversion failed; queued for retry.`, {
      modelId: job.id,
      attempt: attempts,
      maxAttempts,
      error: message
    });
    if (!exhausted && !once) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
  return true;
}

async function processOneJob() {
  const assetCandidate = await nextPendingAssetJob();
  if (assetCandidate) return processPhaseJob("asset", assetCandidate, convertAssetJob);
  const usdzCandidate = await nextPendingUsdzJob();
  return processPhaseJob("usdz", usdzCandidate, convertUsdzJob);
}

async function checkEnvironment() {
  requireConfig();
  await Promise.all([access(blenderScript), access(sourceToGlbScript)]);
  const [hasBlender, hasUnzip, hasUsdzip] = await Promise.all([
    commandExists(blenderBin),
    commandExists(unzipBin, ["-v"]),
    commandExists(usdzipBin, ["--help"])
  ]);
  const importers = hasBlender ? await inspectBlenderImporters().catch(() => undefined) : undefined;
  const result = {
    blender: hasBlender ? "ok" : "missing",
    importers,
    unzip: hasUnzip ? "ok" : "missing",
    usdzip: hasUsdzip ? "ok" : "missing",
    usdcat: await commandExists(usdcatBin, ["--help"]) ? "ok" : "optional-missing",
    bucket,
    workRoot,
    maxAssetFileSizeMb: Math.round(maxAssetFileSize / 1024 / 1024),
    maxPackageUncompressedSizeMb: Math.round(maxPackageUncompressedSize / 1024 / 1024),
    targetSizeMeters,
    keepFailedWorkDir
  };
  log(hasBlender && hasUnzip && hasUsdzip ? "info" : "error", "Environment check.", result);
  if (!hasBlender || !hasUnzip || !hasUsdzip) process.exitCode = 1;
}

async function main() {
  if (checkOnly) {
    await checkEnvironment();
    return;
  }

  requireConfig();
  await recoverStaleJobs();
  do {
    const processed = await processOneJob();
    if (once) break;
    if (!processed) await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  } while (!stopping);
  log("info", "Worker stopped.");
}

process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

try {
  await main();
} catch (error) {
  log("error", "Worker stopped unexpectedly.", {
    error: error instanceof Error ? error.stack ?? error.message : String(error)
  });
  process.exitCode = 1;
}
