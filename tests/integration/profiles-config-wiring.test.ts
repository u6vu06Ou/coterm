import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_AUTH_TOKEN,
  DEFAULT_PROXY_URL,
  loadProfilesConfig,
  type ClaudeProfile,
} from "../../src/main/providers/profiles-config";
import { ClaudeAdapter, buildClaudeArguments } from "../../src/main/providers/claude-adapter";
import type { ProviderRunContext } from "../../src/main/providers/types";

// 這支測試證明「使用者自訂 profiles.json 的內容會被 provider 層實際採用」，
// 取代人工開 Electron app 手動實跑。production 介面限制見 report：
//   .review/opensource/task-x2-report.md
//
// 可純測（不 spawn 真實 claude CLI）的接面：
//   A) loadProfilesConfig(userDataPath) 讀到自訂 profiles.json
//   B) buildClaudeArguments(context, model, sessionId) 把自訂 model 放進 --model
//   C) ClaudeAdapter 建構子第 3 參數 profileTable 接受自訂 profiles 並反映在 .profiles
//
// 無法不啟動 CLI 測的接面（runProfile 內部 spawn）：
//   - getProxyUrl() → env.ANTHROPIC_BASE_URL
//   - profile.env → 子程序 env（含 ANTHROPIC_AUTH_TOKEN）
//   - config.authToken（目前 production 從未消費，見 report）

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "coterm-profiles-wiring-"));
}

const CUSTOM_PROXY = "http://custom-proxy.test:9999";
const CUSTOM_TOKEN = "custom-token-xyz";
const CUSTOM_MODEL = "claude-local-main-custom-model-xyz";

function writeCustomProfiles(dir: string): void {
  const custom = {
    proxyUrl: CUSTOM_PROXY,
    authToken: CUSTOM_TOKEN,
    profiles: {
      "claude-local-main": {
        model: CUSTOM_MODEL,
        local: true,
        env: {
          ANTHROPIC_MODEL: CUSTOM_MODEL,
          ANTHROPIC_AUTH_TOKEN: CUSTOM_TOKEN,
        },
      },
    },
  };
  writeFileSync(join(dir, "profiles.json"), JSON.stringify(custom), "utf8");
}

function makeContext(profileId: ProviderRunContext["profileId"]): ProviderRunContext {
  return {
    profileId,
    workspacePath: "C:/tmp",
    prompt: "ping",
    nativeSessionId: null,
    attachmentPaths: [],
    mode: "agent",
    permissionPreset: "ask",
    signal: new AbortController().signal,
    emit: async () => {},
  };
}

describe("profiles.json → provider wiring", () => {
  it("loadProfilesConfig 讀到自訂 proxyUrl / authToken / model，不是內建預設", () => {
    const dir = makeTempDir();
    try {
      writeCustomProfiles(dir);
      const config = loadProfilesConfig(dir);

      expect(config.proxyUrl).toBe(CUSTOM_PROXY);
      expect(config.proxyUrl).not.toBe(DEFAULT_PROXY_URL);
      expect(config.authToken).toBe(CUSTOM_TOKEN);
      expect(config.authToken).not.toBe(DEFAULT_AUTH_TOKEN);
      expect(config.profiles["claude-local-main"]?.model).toBe(CUSTOM_MODEL);
      expect(config.profiles["claude-local-main"]?.env.ANTHROPIC_AUTH_TOKEN).toBe(CUSTOM_TOKEN);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("buildClaudeArguments 把自訂 profile 的 model 放進 --model flag", () => {
    // 模擬 ClaudeAdapter.runProfile 的 model 選擇：local profile 用 profile.model
    const profile: ClaudeProfile = {
      model: CUSTOM_MODEL,
      local: true,
      env: { ANTHROPIC_MODEL: CUSTOM_MODEL },
    };
    const context = makeContext("claude-local-main");
    const args = buildClaudeArguments(context, profile.model, "sess-1");

    const modelIdx = args.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(args[modelIdx + 1]).toBe(CUSTOM_MODEL);
    // 確認不是內建預設 model
    expect(args.join(" ")).not.toContain("claude-sonnet-4-6");
  });

  it("ClaudeAdapter 接受自訂 profileTable 並反映在 .profiles 列舉", () => {
    const customTable: Record<string, ClaudeProfile> = {
      "claude-local-main": {
        model: CUSTOM_MODEL,
        local: true,
        env: { ANTHROPIC_MODEL: CUSTOM_MODEL, ANTHROPIC_AUTH_TOKEN: CUSTOM_TOKEN },
      },
    };
    const adapter = new ClaudeAdapter(
      () => CUSTOM_PROXY,
      undefined,
      customTable,
    );

    // adapter.profiles 來自 Object.keys(profileTable) — 自訂 table 被採用
    expect(adapter.profiles).toContain("claude-local-main");
    // runProfile 會用 profileTable[profileId].model；這裡不 spawn，只驗 model 會流進 args
    const profile = customTable["claude-local-main"]!;
    const args = buildClaudeArguments(makeContext("claude-local-main"), profile.model, "sess-2");
    expect(args[args.indexOf("--model") + 1]).toBe(CUSTOM_MODEL);
  });

  it("ClaudeAdapter.getProxyUrl callback 持有自訂 proxyUrl（不啟動 CLI 的間接驗證）", () => {
    // runProfile 內 `env.ANTHROPIC_BASE_URL = this.getProxyUrl()` 會 spawn 真實 CLI，
    // 無法在無頭環境直接斷言 env。改驗 callback 本身回傳自訂值——這是 adapter 唯一
    // 取得 proxyUrl 的途徑，runProfile 必然用到它。
    let captured: string | undefined;
    const adapter = new ClaudeAdapter(
      () => {
        captured = CUSTOM_PROXY;
        return CUSTOM_PROXY;
      },
      undefined,
      {
        "claude-local-main": {
          model: CUSTOM_MODEL,
          local: true,
          env: { ANTHROPIC_MODEL: CUSTOM_MODEL },
        },
      },
    );
    // 觸發 callback（不經 runProfile / spawn）
    const proxy = (adapter as unknown as { getProxyUrl: () => string }).getProxyUrl();
    expect(proxy).toBe(CUSTOM_PROXY);
    expect(captured).toBe(CUSTOM_PROXY);
    expect(proxy).not.toBe(DEFAULT_PROXY_URL);
  });
});
