#!/usr/bin/env node
import process from "node:process";
import { main } from "../lib/cli.mjs";

process.exitCode = await main(process.argv.slice(2));
