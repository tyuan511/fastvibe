import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Hash the files that make up an Agent runtime without depending on mtimes or tar/gzip
 * metadata. `manifest.json` is deliberately excluded: it records this digest and would
 * otherwise make the digest self-referential.
 */
export function hashRuntimeDirectory(root, { target, node, ignore = () => false }) {
  const hash = createHash("sha256");
  hash.update(`fastvibe-agent-runtime-v1\0${target}\0${node}\0`);
  visit(root);
  return hash.digest("hex");

  function visit(directory) {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry);
      const name = relative(root, path).split("\\").join("/");
      if (name === "manifest.json" || ignore(name)) continue;
      const stat = lstatSync(path);
      const mode = stat.mode & 0o7777;
      if (stat.isDirectory()) {
        hash.update(`D\0${name}\0${mode.toString(8)}\0`);
        visit(path);
      } else if (stat.isSymbolicLink()) {
        hash.update(`L\0${name}\0${mode.toString(8)}\0${readlinkSync(path)}\0`);
      } else if (stat.isFile()) {
        const content = readFileSync(path);
        hash.update(`F\0${name}\0${mode.toString(8)}\0${content.byteLength}\0`);
        hash.update(content);
        hash.update("\0");
      } else {
        throw new Error(`无法计算 Agent runtime hash：不支持的文件类型 ${name}`);
      }
    }
  }
}
