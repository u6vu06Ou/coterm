import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";

const target = resolve(process.argv[2] ?? ".");
const reportPath = resolve(process.argv[3] ?? join("security-reports", "secret-scan.json"));
const allowedExtensions = new Set([
  ".bat",
  ".cmd",
  ".env",
  ".json",
  ".md",
  ".ps1",
  ".py",
  ".toml",
  ".txt",
  ".yaml",
  ".yml",
]);
const ignoredDirectories = new Set([".git", "node_modules", "__pycache__", ".venv", "venv"]);

const detectors: Array<{ kind: string; pattern: RegExp }> = [
  { kind: "OpenAI-style key", pattern: /\bsk-[A-Za-z0-9_-]{12,}\b/g },
  { kind: "GitHub token", pattern: /\b(?:ghp|github_pat)_[A-Za-z0-9_]{12,}\b/g },
  { kind: "Telegram token", pattern: /\b\d{8,12}:[A-Za-z0-9_-]{20,}\b/g },
  {
    kind: "Credential assignment",
    pattern: /\b(?:API_KEY|AUTH_TOKEN|SECRET|PASSWORD)\s*[=:]\s*["']?([^"'\s]{8,})/gi,
  },
];

interface Finding {
  file: string;
  line: number;
  kind: string;
  fingerprint: string;
}

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        return ignoredDirectories.has(entry.name) ? [] : walk(fullPath);
      }
      if (!entry.isFile()) return [];
      const info = await stat(fullPath);
      if (info.size > 2_000_000) return [];
      return allowedExtensions.has(extname(entry.name).toLowerCase()) || entry.name === ".env"
        ? [fullPath]
        : [];
    }),
  );
  return nested.flat();
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

const findings: Finding[] = [];
for (const file of await walk(target)) {
  const content = await readFile(file, "utf8").catch(() => "");
  const lines = content.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    for (const detector of detectors) {
      detector.pattern.lastIndex = 0;
      for (const match of line.matchAll(detector.pattern)) {
        findings.push({
          file: relative(target, file),
          line: index + 1,
          kind: detector.kind,
          fingerprint: fingerprint(match[0]),
        });
      }
    }
  }
}

await mkdir(resolve(reportPath, ".."), { recursive: true });
await writeFile(
  reportPath,
  `${JSON.stringify(
    {
      target,
      scannedAt: new Date().toISOString(),
      findingCount: findings.length,
      note: "Values are never included. Fingerprints are one-way SHA-256 prefixes for remediation tracking.",
      findings,
    },
    null,
    2,
  )}\n`,
  "utf8",
);
console.log(`Secret scan complete: ${findings.length} redacted findings.`);
console.log(`Report: ${reportPath}`);
