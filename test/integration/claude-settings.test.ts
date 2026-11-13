import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { startServer } from "./helpers";

const originalConfig = process.env.CLAUDE_CONFIG_DIR;
let configDir: string;
let cwd: string;
let env: Awaited<ReturnType<typeof startServer>>;

beforeAll(async () => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-settings-claude-"));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "deck-settings-cwd-"));
  process.env.CLAUDE_CONFIG_DIR = configDir;
  env = await startServer();
  await env.client.call("window.attach", { wid: `w-${crypto.randomUUID()}` });
});

afterAll(async () => {
  env?.client.close();
  await env?.server.stop();
  if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalConfig;
  try {
    fs.rmSync(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {}
});

describe("RPC claudeSettings (get e save)", () => {
  it("claudeSettings.get em arquivo ainda inexistente devolve exists: false", async () => {
    const res = await env.client.call("claudeSettings.get", { hostId: "local", scope: "user" });
    expect(res.exists).toBe(false);
    expect(res.settings).toEqual({});
    expect(res.path).toContain("settings.json");
  });

  it("claudeSettings.save grava configurações globais e claudeSettings.get relê", async () => {
    const saveRes = await env.client.call("claudeSettings.save", {
      hostId: "local",
      scope: "user",
      settings: {
        model: "flash38[1m]",
        env: {
          ANTHROPIC_BASE_URL: "http://10.150.160.21:4000",
          ANTHROPIC_AUTH_TOKEN: "sk-teste-token",
        },
        modelPicker: {
          options: [
            { model: "flash38[1m]", label: "Gemini 3.8 Flash", behavesAs: "claude-opus-5" },
          ],
        },
        permissions: {
          allow: ["Bash(git status)", "PowerShell(Get-Date)"],
        },
      },
    });

    expect(saveRes.ok).toBe(true);
    expect(fs.existsSync(saveRes.path)).toBe(true);

    const getRes = await env.client.call("claudeSettings.get", { hostId: "local", scope: "user" });
    expect(getRes.exists).toBe(true);
    expect(getRes.settings.model).toBe("flash38[1m]");
    expect(getRes.settings.env?.ANTHROPIC_BASE_URL).toBe("http://10.150.160.21:4000");
    expect(getRes.settings.modelPicker?.options).toHaveLength(1);
    expect(getRes.settings.permissions?.allow).toContain("Bash(git status)");
  });

  it("claudeSettings.save em escopo de projeto grava na pasta do projeto", async () => {
    const saveProj = await env.client.call("claudeSettings.save", {
      hostId: "local",
      scope: "project",
      cwd,
      settings: {
        permissions: {
          allow: ["Bash(npm test)"],
        },
      },
    });

    expect(saveProj.ok).toBe(true);
    const expectedFile = path.join(cwd, ".claude", "settings.json");
    expect(fs.existsSync(expectedFile)).toBe(true);

    const getProj = await env.client.call("claudeSettings.get", {
      hostId: "local",
      scope: "project",
      cwd,
    });
    expect(getProj.exists).toBe(true);
    expect(getProj.settings.permissions?.allow).toEqual(["Bash(npm test)"]);
  });

  it("claudeSettings.save cria arquivo de backup ao sobrescrever", async () => {
    const save2 = await env.client.call("claudeSettings.save", {
      hostId: "local",
      scope: "user",
      settings: {
        model: "kpaopus55",
      },
    });

    expect(save2.ok).toBe(true);
    expect(save2.backupPath).toBeDefined();
    expect(fs.existsSync(save2.backupPath)).toBe(true);

    const backupData = JSON.parse(fs.readFileSync(save2.backupPath, "utf8"));
    expect(backupData.model).toBe("flash38[1m]");
  });
});
