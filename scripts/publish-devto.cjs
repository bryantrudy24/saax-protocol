#!/usr/bin/env node
// Publish a Dev.to article from a markdown file with canonical URL. Usage:
//   DEVTO_API_KEY=... node publish-devto.cjs <title> <md-file> <canonical> <desc> <tag1,tag2,...>
const fs = require("fs");
const path = require("path");

async function main() {
  const [title, mdFile, canonical, desc, tagsCsv] = process.argv.slice(2);
  if (!title || !mdFile || !canonical || !desc || !tagsCsv) {
    console.error("usage: node publish-devto.cjs <title> <md-file> <canonical> <desc> <tags>");
    process.exit(1);
  }
  const apiKey = process.env.DEVTO_API_KEY;
  if (!apiKey) { console.error("DEVTO_API_KEY missing"); process.exit(1); }
  const body = fs.readFileSync(mdFile, "utf8");
  const payload = {
    article: {
      title,
      published: true,
      canonical_url: canonical,
      description: desc,
      body_markdown: body,
      tags: tagsCsv.split(",").map((t) => t.trim()).filter(Boolean),
    },
  };
  const res = await fetch("https://dev.to/api/articles", {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error("HTTP " + res.status + ": " + text.slice(0, 2000));
    process.exit(1);
  }
  const data = JSON.parse(text);
  console.log("PUBLISHED id=" + data.id);
  console.log("URL=" + data.url);
  console.log("CANONICAL=" + data.canonical_url);
  console.log("TITLE=" + data.title);
}
main().catch((e) => { console.error(e); process.exit(1); });