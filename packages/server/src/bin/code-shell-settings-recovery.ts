#!/usr/bin/env node
// Offline administrator entry: no HTTP listener, worker or TUI bootstrap.
import { runSettingsRecoveryCli } from "../serve/settings-recovery-cli.js";

process.exitCode = await runSettingsRecoveryCli();
