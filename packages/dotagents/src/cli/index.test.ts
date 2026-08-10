import { beforeEach, describe, expect, it, vi } from "vitest";

const sync = vi.fn();
const checkForUpdate = vi.fn(() => Promise.resolve(null));

vi.mock("./commands/sync.js", () => ({ default: sync }));
vi.mock("./update-notifier.js", () => ({ checkForUpdate }));

describe("CLI help dispatch", () => {
  beforeEach(() => {
    sync.mockReset();
    checkForUpdate.mockClear();
  });

  it("prints command help without running the command", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { main } = await import("./main.js");

    await main(["sync", "--help"]);

    expect(sync).not.toHaveBeenCalled();
    expect(checkForUpdate).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Reconcile local state"));
    log.mockRestore();
  });

  it.each(["--user", "--global"])("passes %s as user scope", async (scopeFlag) => {
    const { main } = await import("./main.js");

    await main([scopeFlag, "sync"]);

    expect(sync).toHaveBeenCalledWith([], { user: true });
  });

  it("accepts both user scope aliases together", async () => {
    const { main } = await import("./main.js");

    await main(["--user", "--global", "sync"]);

    expect(sync).toHaveBeenCalledWith([], { user: true });
  });
});
