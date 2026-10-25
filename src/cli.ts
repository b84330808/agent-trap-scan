#!/usr/bin/env node
import { main } from "./main.ts";

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`agent-trap-scan: ${(err as Error).message}\n`);
    process.exitCode = 2;
  },
);
