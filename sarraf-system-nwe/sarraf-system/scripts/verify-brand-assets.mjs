import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

const roots = ["public", "app-files/public"];
const expected = new Map([
  ["apple-touch-icon.png", [180, 180]],
  ["icon-192.png", [192, 192]],
  ["icon-512.png", [512, 512]],
  ["icon-maskable-512.png", [512, 512]],
]);

function pngDimensions(buffer) {
  assert.deepEqual(buffer.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), "invalid PNG signature");
  assert.equal(buffer.subarray(12, 16).toString("ascii"), "IHDR", "PNG has no IHDR header");
  return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
}

for (const root of roots) {
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.name, "ZEMAN — Exchange Intelligence");
  assert.equal(manifest.short_name, "ZEMAN");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.lang, "ckb");
  assert.equal(manifest.dir, "rtl");
  assert.ok(!("share_target" in manifest), "Phase E share_target must not be present");

  const declared = new Map(manifest.icons.map((icon) => [icon.src.replace(/^\//, ""), icon]));
  for (const [path, dimensions] of expected) {
    const buffer = await readFile(join(root, path));
    assert.deepEqual(pngDimensions(buffer), dimensions, `${root}/${path} dimensions`);
    if (path !== "apple-touch-icon.png") {
      const icon = declared.get(path);
      assert.ok(icon, `${path} is not declared in the manifest`);
      assert.equal(icon.type, "image/png");
      assert.equal(icon.sizes, dimensions.join("x"));
    }
  }
  assert.equal(declared.get("icon-maskable-512.png")?.purpose, "maskable");

  for (const path of ["brand/zeman-symbol.svg", "brand/zeman-horizontal-light.svg", "brand/zeman-horizontal-dark.svg", "brand/zeman-monochrome.svg"]) {
    assert.equal(extname(path), ".svg");
    const svg = await readFile(join(root, path), "utf8");
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.doesNotMatch(svg, /<script|\son\w+=|<foreignObject|(?:href|src)=["']https?:/i, `${path} contains unsafe active or remote content`);
  }
}

for (const htmlPath of ["index.html", "app-files/index.html"]) {
  const html = await readFile(htmlPath, "utf8");
  assert.match(html, /href="\/brand\/zeman-symbol\.svg"/);
  assert.match(html, /href="\/icon-192\.png"/);
  assert.match(html, /rel="apple-touch-icon" href="\/apple-touch-icon\.png"/);
}

console.log("ZEMAN brand assets, manifest declarations, and HTML consumers are valid.");
