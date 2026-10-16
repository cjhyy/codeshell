#!/usr/bin/env node
import { runLegacyLinkCleanupCli } from "../links/legacy-cleanup-cli.js";

process.exitCode = await runLegacyLinkCleanupCli();
