import { spawn } from "node:child_process";
import { sanitizeError } from "../runtime/redaction.mjs";

function safeToolError(error) {
  const sanitized = new Error(sanitizeError(error).message);
  if (error?.code) sanitized.code = error.code;
  return sanitized;
}

export function runTool(
  command,
  args,
  {
    cwd = process.cwd(),
    timeoutMs = 120000,
    maxOutputBytes = 4 * 1024 * 1024,
    stdio = "capture",
    env = process.env,
  } = {},
) {
  if (typeof command !== "string" || !command.trim()) {
    throw new Error("Tool command must be a non-empty string.");
  }
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string")) {
    throw new Error("Tool arguments must be an array of strings.");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 24 * 60 * 60 * 1000) {
    throw new Error("Tool timeout must be from 1 ms to 24 hours.");
  }
  if (
    !Number.isSafeInteger(maxOutputBytes)
    || maxOutputBytes < 1024
    || maxOutputBytes > 256 * 1024 * 1024
  ) {
    throw new Error("Tool output limit must be from 1 KiB to 256 MiB.");
  }
  if (!["capture", "inherit"].includes(stdio)) {
    throw new Error("Tool stdio must be capture or inherit.");
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let timedOut = false;
    let outputExceeded = false;
    let escalationTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      escalationTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
      escalationTimer.unref();
    }, timeoutMs);
    const collect = (target) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes && !outputExceeded) {
        outputExceeded = true;
        child.kill("SIGTERM");
        escalationTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
        escalationTimer.unref();
        return;
      }
      if (outputExceeded) return;
      if (target === "stdout") stdout += chunk;
      else stderr += chunk;
    };
    if (stdio !== "inherit") {
      child.stdout.on("data", collect("stdout"));
      child.stderr.on("data", collect("stderr"));
    }
    child.on("error", (error) => {
      clearTimeout(timer);
      if (escalationTimer) clearTimeout(escalationTimer);
      reject(safeToolError(error));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (escalationTimer) clearTimeout(escalationTimer);
      if (timedOut) {
        const error = new Error(`${command} exceeded ${timeoutMs} ms.`);
        error.code = "TOOL_TIMEOUT";
        reject(safeToolError(error));
      } else if (outputExceeded) {
        const error = new Error(
          `${command} exceeded the ${maxOutputBytes}-byte output limit.`,
        );
        error.code = "TOOL_OUTPUT_LIMIT";
        reject(safeToolError(error));
      } else if (code === 0) {
        resolve({ stdout, stderr, code, signal });
      } else {
        const error = new Error(
          `${command} exited with ${code ?? signal}: ${stderr.trim()}`,
        );
        error.code = "TOOL_EXIT_NONZERO";
        reject(safeToolError(error));
      }
    });
  });
}

export async function inspectTool(
  command,
  versionArgs = ["--version"],
  { run = runTool } = {},
) {
  try {
    const result = await run(command, versionArgs, { timeoutMs: 10000 });
    return {
      available: true,
      version: (result.stdout || result.stderr)
        .split(/\r?\n/u)
        .find((line) => line.trim())
        ?.trim() || "unknown",
    };
  } catch (error) {
    return {
      available: false,
      error: error.code === "ENOENT" ? "not installed" : error.message,
    };
  }
}
