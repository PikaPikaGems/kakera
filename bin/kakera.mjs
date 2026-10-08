#!/usr/bin/env node
// kakera command line.
//
//   kakera split --out <dir> --name <name> [--version <v>] [--part-size <MB>] [--gzip auto|yes|no] <file>...
//
// Writes each file as parts of at most --part-size MB (default 20) before compression into <dir>, plus a
// manifest.json for kakera's loader. --version defaults to a hash of the files' contents.
import fs from "node:fs";
import path from "node:path";
import { contentVersion, splitFile, writeManifest } from "../src/split.js";

const USAGE = "usage: kakera split --out <dir> --name <name> [--version <v>] [--part-size <MB>] [--gzip auto|yes|no] <file>...";
const die = (msg) => { console.error(`kakera: ${msg}`); process.exit(1); };
const mb = (n) => (n / 1048576).toFixed(1);

const [cmd, ...args] = process.argv.slice(2);
if (cmd !== "split") die(USAGE);
const opts = {}, files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) {
    if (args[i + 1] === undefined) die(`${args[i]} needs a value`);
    opts[args[i].slice(2)] = args[++i];
  } else files.push(args[i]);
}
if (!opts.out || !opts.name || !files.length) die(USAGE);
const partMB = Number(opts["part-size"] ?? 20);
if (!(partMB > 0 && partMB <= 24)) die("--part-size must be between 0 and 24 (MB, before compression)");
const gzip = { auto: "auto", yes: true, no: false }[opts.gzip ?? "auto"];
if (gzip === undefined) die("--gzip must be auto, yes or no");

const buffers = files.map((f) => fs.readFileSync(f));
const entries = files.map((f, i) => splitFile(buffers[i], {
  name: path.basename(f), outDir: opts.out, partBytes: Math.floor(partMB * 1048576), gzip,
}));
const manifest = writeManifest(opts.out, { name: opts.name, version: opts.version ?? contentVersion(...buffers), files: entries });

console.log(`Wrote ${opts.out}/manifest.json (${manifest.name}@${manifest.version})`);
for (const e of entries) console.log(`  ${e.name}: ${mb(e.size)} MB -> ${e.parts.length} part(s), ${e.gzip ? "gzip" : "stored as is"}`);
console.log(`  download total: ${mb(manifest.downloadSize)} MB`);
