import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
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
const usdzipBin = process.env.USDZIP_BIN ?? "usdzip";
const usdcatBin = process.env.USDCAT_BIN ?? "usdcat";
const pollIntervalMs = positiveNumber(process.env.USDZ_POLL_INTERVAL_MS, 15000);
const staleAfterMinutes = positiveNumber(process.env.USDZ_STALE_AFTER_MINUTES, 30);
const maxAttempts = positiveNumber(process.env.USDZ_MAX_ATTEMPTS, 3);
const maxFileSize = positiveNumber(process.env.USDZ_MAX_FILE_SIZE_MB, 200) * 1024 * 1024;
const targetSizeMeters = positiveNumber(process.env.USDZ_TARGET_SIZE_METERS, 0.32);
const keepFailedWorkDir = process.env.USDZ_KEEP_FAILED_WORK_DIR === "true";
const workRoot = process.env.USDZ_WORK_DIR ?? os.tmpdir();
const blenderScript = path.join(process.cwd(), "scripts", "blender", "glb_to_usd.py");

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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

async function uploadStorageObject(storagePath, source) {
  const response = await fetch(
    `${supabaseUrl}/storage/v1/object/${encodeURIComponent(bucket)}/${encodedObjectPath(storagePath)}`,
    {
      method: "POST",
      headers: serviceHeaders({
        "Content-Type": "model/vnd.usdz+zip",
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
  const retryQuery = new URLSearchParams({
    usdz_status: "eq.processing",
    usdz_updated_at: `lt.${cutoff}`,
    usdz_attempts: `lt.${maxAttempts}`
  });
  await databaseRequest(`models?${retryQuery}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({
      usdz_status: "pending",
      usdz_error: "Recovered stale processing job.",
      usdz_updated_at: new Date().toISOString()
    })
  });

  const failedQuery = new URLSearchParams({
    usdz_status: "eq.processing",
    usdz_updated_at: `lt.${cutoff}`,
    usdz_attempts: `gte.${maxAttempts}`
  });
  await databaseRequest(`models?${failedQuery}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({
      usdz_status: "failed",
      usdz_error: "Worker stopped during the final conversion attempt.",
      usdz_updated_at: new Date().toISOString()
    })
  });
}

async function nextPendingJob() {
  const query = new URLSearchParams({
    select: "id,name,storage_path,usdz_attempts",
    storage_provider: "eq.supabase",
    usdz_status: "eq.pending",
    usdz_attempts: `lt.${maxAttempts}`,
    order: "created_at.asc",
    limit: "1"
  });
  const response = await databaseRequest(`models?${query}`);
  const rows = await response.json();
  return rows[0] ?? null;
}

async function claimJob(job) {
  const query = new URLSearchParams({ id: `eq.${job.id}`, usdz_status: "eq.pending" });
  const response = await databaseRequest(`models?${query}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({
      usdz_status: "processing",
      usdz_error: null,
      usdz_attempts: Number(job.usdz_attempts ?? 0) + 1,
      usdz_updated_at: new Date().toISOString()
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
    body: JSON.stringify({ ...values, usdz_updated_at: new Date().toISOString() })
  });
}

async function commandExists(command, commandArgs = ["--version"]) {
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, { stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
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
    const append = (current, chunk) => `${current}${chunk}`.slice(-40000);
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with ${code}.\n${stderr || stdout}`));
    });
  });
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

async function auditUsdz(usdzPath, rootLayerPath) {
  const listing = await runCommand(usdzipBin, [usdzPath, "--list", "-"]);
  if (!listing.stdout.includes(path.basename(rootLayerPath))) {
    throw new Error("USDZ archive does not contain the exported root layer.");
  }

  if (!(await commandExists(usdcatBin, ["--help"]))) {
    return { skeletonAudit: "skipped", archiveFiles: listing.stdout.trim().split(/\r?\n/).length };
  }

  const output = await runCommand(usdcatBin, [rootLayerPath]);
  const text = output.stdout;
  const markers = {
    skelRoot: text.includes("SkelRoot"),
    skeleton: text.includes("Skeleton"),
    skelAnimation: text.includes("SkelAnimation"),
    skelBindingApi: text.includes("SkelBindingAPI")
  };
  return {
    skeletonAudit: (markers.skelRoot || markers.skeleton) && markers.skelAnimation
      ? "found"
      : "missing",
    markers,
    archiveFiles: listing.stdout.trim().split(/\r?\n/).length
  };
}

async function convertJob(job) {
  if (!job.storage_path) throw new Error("Model has no Supabase GLB storage path.");

  const tempDir = await mkdtemp(path.join(workRoot, "modelspace-usdz-"));
  const inputPath = path.join(tempDir, "source.glb");
  const outputDir = path.join(tempDir, "usd");
  const rootLayerPath = path.join(outputDir, "model.usdc");
  const usdzPath = path.join(tempDir, `${job.id}.usdz`);
  const storagePath = `usdz/${job.id}.usdz`;
  let completed = false;

  try {
    await downloadStorageObject(job.storage_path, inputPath);
    const glb = await inspectGlbAnimations(inputPath);
    if (!glb.hasAnimations) {
      await updateJob(job.id, {
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

    const audit = await auditUsdz(usdzPath, rootLayerPath);
    if (audit.skeletonAudit === "missing") {
      throw new Error(
        `USD output is missing a complete Skeleton/SkelAnimation binding: ${JSON.stringify(audit)}`
      );
    }

    await uploadStorageObject(storagePath, usdzPath);
    await updateJob(job.id, {
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

async function processOneJob() {
  const candidate = await nextPendingJob();
  if (!candidate) return false;
  const job = await claimJob(candidate);
  if (!job) return true;

  log("info", "Claimed conversion job.", {
    modelId: job.id,
    name: job.name,
    attempt: job.usdz_attempts
  });

  try {
    await convertJob(job);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const exhausted = Number(job.usdz_attempts ?? 0) >= maxAttempts;
    await updateJob(job.id, {
      usdz_status: exhausted ? "failed" : "pending",
      usdz_error: message.slice(0, 4000)
    });
    log("error", exhausted ? "Conversion failed permanently." : "Conversion failed; queued for retry.", {
      modelId: job.id,
      attempt: job.usdz_attempts,
      maxAttempts,
      error: message
    });
    if (!exhausted && !once) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
  return true;
}

async function checkEnvironment() {
  requireConfig();
  await access(blenderScript);
  const [hasBlender, hasUsdzip] = await Promise.all([
    commandExists(blenderBin),
    commandExists(usdzipBin, ["--help"])
  ]);
  const result = {
    blender: hasBlender ? "ok" : "missing",
    usdzip: hasUsdzip ? "ok" : "missing",
    usdcat: await commandExists(usdcatBin, ["--help"]) ? "ok" : "optional-missing",
    bucket,
    workRoot,
    targetSizeMeters,
    keepFailedWorkDir
  };
  log(hasBlender && hasUsdzip ? "info" : "error", "Environment check.", result);
  if (!hasBlender || !hasUsdzip) process.exitCode = 1;
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
