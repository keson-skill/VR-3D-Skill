import { spawn } from "node:child_process";

export function runTool(
  command,
  args,
  {
    cwd = process.cwd(),
    timeoutMs = 120000,
    maxOutputBytes = 4 * 1024 * 1024,
    stdio = "capture",
  } = {},
) {
  if (typeof command !== "string" || !command.trim()) {
    throw new Error("Tool command must be a non-empty string.");
  }
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string")) {
    throw new Error("Tool arguments must be an array of strings.");
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000).unref();
    }, timeoutMs);
    const collect = (target) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        child.kill("SIGTERM");
        reject(new Error(`${command} exceeded the ${maxOutputBytes}-byte output limit.`));
        return;
      }
      if (target === "stdout") stdout += chunk;
      else stderr += chunk;
    };
    if (stdio !== "inherit") {
      child.stdout.on("data", collect("stdout"));
      child.stderr.on("data", collect("stderr"));
    }
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${command} exceeded ${timeoutMs} ms.`));
      } else if (code === 0) {
        resolve({ stdout, stderr, code, signal });
      } else {
        reject(new Error(`${command} exited with ${code ?? signal}: ${stderr.trim()}`));
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
