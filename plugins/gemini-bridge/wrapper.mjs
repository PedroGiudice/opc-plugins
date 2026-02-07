#!/usr/bin/env node
/**
 * Node.js wrapper for Python MCP server.
 *
 * Claude Code (Bun) has a known bug with stdio pipes to child processes
 * (oven-sh/bun#2423). This wrapper uses Node.js child_process which handles
 * stdio correctly, forwarding all data between Claude Code and the Python server.
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, "server.py");

const child = spawn("python3", ["-u", serverPath], {
  stdio: ["pipe", "pipe", "inherit"], // stdin/stdout piped, stderr inherited
  env: { ...process.env, PYTHONUNBUFFERED: "1" },
});

// Forward stdin from Claude Code to Python server
process.stdin.pipe(child.stdin);

// Forward stdout from Python server to Claude Code
child.stdout.pipe(process.stdout);

// Exit when Python process exits
child.on("exit", (code) => process.exit(code ?? 0));

// Handle parent process signals
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));
