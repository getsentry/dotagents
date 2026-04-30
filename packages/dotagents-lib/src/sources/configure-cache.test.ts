import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";
import { configureCache, getStateDir } from "./cache.js";

describe("configureCache / getStateDir", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env["DOTAGENTS_STATE_DIR"];
    delete process.env["DOTAGENTS_STATE_DIR"];
    configureCache({ stateDir: undefined });
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env["DOTAGENTS_STATE_DIR"];
    } else {
      process.env["DOTAGENTS_STATE_DIR"] = originalEnv;
    }
    configureCache({ stateDir: undefined });
  });

  it("falls back to ~/.local/dotagents/ when neither override nor env var is set", () => {
    expect(getStateDir()).toBe(join(homedir(), ".local", "dotagents"));
  });

  it("honors DOTAGENTS_STATE_DIR env var when configureCache has not been called", () => {
    process.env["DOTAGENTS_STATE_DIR"] = "/var/cache/dotagents";
    expect(getStateDir()).toBe("/var/cache/dotagents");
  });

  it("configureCache override wins over the env var", () => {
    process.env["DOTAGENTS_STATE_DIR"] = "/var/cache/dotagents";
    configureCache({ stateDir: "/tmp/my-cache" });
    expect(getStateDir()).toBe("/tmp/my-cache");
  });

  it("clearing the override (passing undefined) re-exposes the env var", () => {
    process.env["DOTAGENTS_STATE_DIR"] = "/var/cache/dotagents";
    configureCache({ stateDir: "/tmp/my-cache" });
    expect(getStateDir()).toBe("/tmp/my-cache");
    configureCache({ stateDir: undefined });
    expect(getStateDir()).toBe("/var/cache/dotagents");
  });
});
