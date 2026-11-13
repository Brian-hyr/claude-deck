import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveClaudeSettingsPath,
  readClaudeSettings,
  saveClaudeSettings,
} from "../../src/server/claude/settings";
import { LocalFs } from "../../src/server/fs/localfs";

const dirs: string[] = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "deck-settings-test-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {}
  }
});

describe("Claude Code settings.json: resolução de caminhos", () => {
  it("resolve caminho global na pasta pessoal no Windows e POSIX", () => {
    const pWin = resolveClaudeSettingsPath("win32", "C:\\Users\\teste", "local", "user");
    expect(pWin).toBe("C:\\Users\\teste\\.claude\\settings.json");

    const pPosix = resolveClaudeSettingsPath("posix", "/home/ubuntu", "srv-linux", "user");
    expect(pPosix).toBe("/home/ubuntu/.claude/settings.json");
  });

  it("respeita CLAUDE_CONFIG_DIR quando definido para host local", () => {
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = "C:\\CustomConfig";
    try {
      const p = resolveClaudeSettingsPath("win32", "C:\\Users\\teste", "local", "user");
      expect(p).toBe("C:\\CustomConfig\\settings.json");
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });

  it("resolve caminho de escopo de projeto na pasta cwd informada", () => {
    const p = resolveClaudeSettingsPath("posix", "/home/ubuntu", "srv-linux", "project", "/var/www/app");
    expect(p).toBe("/var/www/app/.claude/settings.json");
  });

  it("lança erro se cwd do projeto não for informado", () => {
    expect(() => resolveClaudeSettingsPath("posix", "/home/ubuntu", "srv-linux", "project", "")).toThrow();
  });
});

describe("Claude Code settings.json: leitura e gravação", () => {
  it("arquivo inexistente devolve exists: false sem falhar", async () => {
    const dir = tmp();
    const hostFs = new LocalFs();
    const host = { fs: hostFs, platform: "win32" as const };

    const res = await readClaudeSettings(host, dir, "local", "user");
    expect(res.exists).toBe(false);
    expect(res.settings).toEqual({});
    expect(JSON.parse(res.raw)).toEqual({});
  });

  it("grava novo arquivo com sucesso, criando pasta e formatando com indentação 2", async () => {
    const dir = tmp();
    const hostFs = new LocalFs();
    const host = { fs: hostFs, platform: "win32" as const };

    const saveRes = await saveClaudeSettings(host, dir, "local", {
      hostId: "local",
      scope: "user",
      settings: {
        model: "kpaopus55",
        env: { ANTHROPIC_BASE_URL: "http://10.150.160.21:4000" },
      },
    });

    expect(saveRes.ok).toBe(true);
    expect(fs.existsSync(saveRes.path)).toBe(true);

    const readRes = await readClaudeSettings(host, dir, "local", "user");
    expect(readRes.exists).toBe(true);
    expect(readRes.settings.model).toBe("kpaopus55");
    expect(readRes.settings.env?.ANTHROPIC_BASE_URL).toBe("http://10.150.160.21:4000");
  });

  it("gravação sobre arquivo existente gera backup automático (.bak-<timestamp>)", async () => {
    const dir = tmp();
    const hostFs = new LocalFs();
    const host = { fs: hostFs, platform: "win32" as const };

    // Grava versão inicial
    await saveClaudeSettings(host, dir, "local", {
      hostId: "local",
      scope: "user",
      settings: { model: "versao-1" },
    });

    // Grava versão 2
    const save2 = await saveClaudeSettings(host, dir, "local", {
      hostId: "local",
      scope: "user",
      settings: { model: "versao-2" },
    });

    expect(save2.backupPath).toBeDefined();
    expect(fs.existsSync(save2.backupPath!)).toBe(true);
    const backupContent = JSON.parse(fs.readFileSync(save2.backupPath!, "utf8"));
    expect(backupContent.model).toBe("versao-1");

    const currentRes = await readClaudeSettings(host, dir, "local", "user");
    expect(currentRes.settings.model).toBe("versao-2");
  });

  it("gravação de JSON cru inválido é rejeitada", async () => {
    const dir = tmp();
    const hostFs = new LocalFs();
    const host = { fs: hostFs, platform: "win32" as const };

    await expect(
      saveClaudeSettings(host, dir, "local", {
        hostId: "local",
        scope: "user",
        raw: "{ virgula: faltando, }",
      })
    ).rejects.toThrow("JSON inválido");
  });
});
