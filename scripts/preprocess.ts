#!/usr/bin/env -S deno run --allow-read --allow-write

/**
 * Knappogue preprocessor — resolves $include directives and $vars substitution.
 *
 * $include
 * --------
 * Any YAML mapping containing a "$include" key is replaced by the content of
 * the referenced file, deep-merged with the sibling keys (siblings win).
 * Included files are NOT themselves scanned for $include (no recursion).
 *
 * $vars
 * -----
 * Variables are substituted as ${name} in string values of included templates
 * and in sibling override values. Three scopes, each overriding the previous:
 *
 *   1. Fleet level:    vars.yaml at repo root
 *   2. Instance level: instances/<name>/vars.yaml
 *   3. Inline:         $vars: { key: value } sibling of $include
 *
 * Reads from:  instances/
 * Writes to:   build/preprocessed/instances/
 *              build/preprocessed/edge-project.yaml  (output path adjusted)
 *
 * Run from repo root:
 *   deno run --allow-read --allow-write scripts/preprocess.ts
 */

import { parse, stringify } from "jsr:@std/yaml";
import { dirname, join, relative } from "jsr:@std/path";
import { ensureDir, walk } from "jsr:@std/fs";

const ROOT = Deno.cwd();
const OUT = join(ROOT, "build", "preprocessed");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Node = unknown;
type Vars = Record<string, string>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, Node> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Deep-merge two plain objects. Arrays and scalars in patch replace base. */
function deepMerge(
  base: Record<string, Node>,
  patch: Record<string, Node>,
): Record<string, Node> {
  const result: Record<string, Node> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    result[k] = isObject(v) && isObject(result[k])
      ? deepMerge(result[k] as Record<string, Node>, v)
      : v;
  }
  return result;
}

/** Substitute ${name} placeholders in all string values of a node tree. */
function substituteVars(node: Node, vars: Vars): Node {
  if (typeof node === "string") {
    return node.replace(/\$\{(\w+)\}/g, (match, key) => vars[key] ?? match);
  }
  if (Array.isArray(node)) {
    return node.map((item) => substituteVars(item, vars));
  }
  if (isObject(node)) {
    const result: Record<string, Node> = {};
    for (const [k, v] of Object.entries(node)) {
      result[k] = substituteVars(v, vars);
    }
    return result;
  }
  return node;
}

/**
 * Load a vars.yaml file. Returns {} if the file does not exist or is empty.
 * Only top-level string values are used; nested objects are ignored.
 */
async function loadVars(path: string): Promise<Vars> {
  try {
    const content = parse(await Deno.readTextFile(path));
    if (!isObject(content)) return {};
    const vars: Vars = {};
    for (const [k, v] of Object.entries(content)) {
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        vars[k] = String(v);
      }
    }
    return vars;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Walk a parsed YAML node, resolving any $include mappings found.
 * Included files are taken as literal YAML (not further resolved).
 * vars: the active variable scope (fleet + instance + any parent inline vars).
 */
async function resolve(node: Node, vars: Vars = {}): Promise<Node> {
  if (Array.isArray(node)) {
    return Promise.all(node.map((item) => resolve(item, vars)));
  }
  if (isObject(node)) {
    if ("$include" in node) {
      const includePath = join(ROOT, node["$include"] as string);
      const included = parse(await Deno.readTextFile(includePath));
      const { $include: _dropInclude, $vars: localVars, ...overrides } = node;

      // Merge vars: parent scope < inline $vars
      const mergedVars: Vars = {
        ...vars,
        ...(isObject(localVars) ? localVars as Vars : {}),
      };

      // Substitute vars in the template, then resolve overrides with merged vars
      const substituted = substituteVars(included ?? {}, mergedVars) as Record<string, Node>;
      const resolvedOverrides = await resolve(
        substituteVars(overrides, mergedVars),
        mergedVars,
      ) as Record<string, Node>;

      return deepMerge(substituted, resolvedOverrides);
    }
    const result: Record<string, Node> = {};
    for (const [k, v] of Object.entries(node)) {
      result[k] = await resolve(v, vars);
    }
    return result;
  }
  return node;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log("Preprocessing instances/ → build/preprocessed/instances/\n");

// Load fleet-level vars (vars.yaml at repo root)
const fleetVars = await loadVars(join(ROOT, "vars.yaml"));
if (Object.keys(fleetVars).length > 0) {
  console.log(`  Fleet vars: ${Object.keys(fleetVars).join(", ")}`);
}

let count = 0;

// Iterate instance directories so we can load per-instance vars
for await (const instanceEntry of Deno.readDir(join(ROOT, "instances"))) {
  if (!instanceEntry.isDirectory) continue;
  const instanceName = instanceEntry.name;
  const instanceDir = join(ROOT, "instances", instanceName);

  // Load instance-level vars (instances/<name>/vars.yaml), override fleet vars
  const instanceVars = await loadVars(join(instanceDir, "vars.yaml"));
  const baseVars: Vars = { ...fleetVars, ...instanceVars };
  if (Object.keys(instanceVars).length > 0) {
    console.log(`  [${instanceName}] vars: ${Object.keys(instanceVars).join(", ")}`);
  }

  for await (const entry of walk(instanceDir, { exts: [".yaml"] })) {
    const src = await Deno.readTextFile(entry.path);
    const resolved = await resolve(parse(src), baseVars);
    const rel = relative(ROOT, entry.path);
    const out = join(OUT, rel);
    await ensureDir(dirname(out));
    await Deno.writeTextFile(out, stringify(resolved as Record<string, unknown>));
    console.log(`  ${rel}`);
    count++;
  }
}

// Copy edge-project.yaml, adjusting output path for the preprocessed tree.
// The compiler will be invoked with -p build/preprocessed, so "output: ../"
// resolves to build/ — preserving the original compiled-config.json location.
const projectYaml = parse(
  await Deno.readTextFile(join(ROOT, "edge-project.yaml")),
) as Record<string, unknown>;
// Keep output: build/ — the compiler resolves this relative to its working
// directory, which the Gradle task sets to build/preprocessed/, so compiled
// output lands at build/preprocessed/build/<instance>/compiled-config.json.
await Deno.writeTextFile(join(OUT, "edge-project.yaml"), stringify(projectYaml));

console.log(`\nDone. ${count} files → build/preprocessed/`);
